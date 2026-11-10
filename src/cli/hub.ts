import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AttentionInfo, SessionInfo, ListenerRequest } from '../shared/types';
import { loadNotifyConfig, notifyConfigPath } from '../main/notifyConfig';
import { buildEvent, deliver, NotifyLog } from '../main/notifyDelivery';
import { apiFilePath, dataDir } from '../main/paths';
import { formatWatchLine } from './watch';

/** Set to `true` by scripts/build-cli.mjs for the copy bundled inside Terminal Hub.app. */
declare const HUB_PACKAGED: boolean | undefined;
const startHint = typeof HUB_PACKAGED !== 'undefined' && HUB_PACKAGED ? "open -a 'Terminal Hub'" : `cd ${resolve(__dirname, '..', '..')} && npm start`;

const USAGE = `usage:
  hub run [--cwd DIR] [--title T] [--unattended] [--force] [-q] [--json] -- CMD ARGS…   start a session, follow it, exit with its exit code
                                                      (refused with 409 when another session is running in the same git worktree; --force starts anyway)
  hub run --detach [--json] -- CMD ARGS…              start the session, print its id, exit 0 (never follows the output)
  hub run --wait [--timeout S] [--json] -- CMD ARGS…  start detached, then block like hub wait
  hub run … --listen SPEC | --listen-file PATH        listeners are optional; every given one must ack before the session exists
  hub listen <session> --listen SPEC [--listen-file PATH] [--ack-timeout S] [--json] [--no-wait]
                                                      add a listener to a running session (same handshake)
  hub ack <handshake-id> <token> [--json]              acknowledge a pending listener handshake
  hub listeners <session> [--json]                     redacted listeners, state, pending/failed counters
  hub listeners rm <session> <listener-id>             remove a listener now
  hub listeners resume <session> <listener-id>         retry a degraded listener
  hub events <session> [--since SEQ] [--follow] [--json]
                                                      the session's event journal (survives restart)
  hub deliveries <session> [--listener ID] [--limit N] [--json]
                                                      delivery attempts per listener
  hub ls [--json]                                     list sessions (state, resumable, archived)
  hub show <id> [--json]                              one session: full id, state, running, exitCode, cwd, command, title, archived, resumable, attention, turn
  hub status [--json]                                 is the hub up: version, pid, startedAt, baseUrl, data dir, total / running / waiting counts
  hub text <id> [--follow]                            plain text: the agent's transcript (Claude Code, opencode) or the ANSI-stripped log (shell)
  hub send <id> "text" [--no-enter]                   type into a session (Enter appended by default)
  hub resize <id> --cols N --rows N [--json]          resize the terminal of a running session (1..1000)
  hub stop <id>                                       SIGTERM, SIGKILL after 3 s
  hub resume <id> [--follow] [--force]                resume (Claude Code) or restart (other commands); --force as for run
  hub archive <id>                                    move a finished session to the Archived list (refused while it runs)
  hub unarchive <id>                                  move it back
  hub rename <id> <title>                             set the title and pin it (the program's terminal-title escapes no longer change it)
  hub rename <id> --auto                              unpin: the program's terminal-title escapes set the title again
  hub rm <id>                                         delete the session and its files
  hub rm-all --yes [--json]                           delete EVERY session and its files (kills running ones); refuses without --yes
  hub watch                                           stream attention, turn (working|waiting|done) and exit events as JSON lines until Ctrl-C
  hub notify-test                                     send one synthetic "attention" event to the endpoint in notify.json and print the HTTP result
  hub wait <id> [--timeout S] [--json]                block until it needs attention (exit 10, prints the question) or exits (its code); 124 on timeout
  hub answer <id> <text|yes|no|enter|esc|tab|up|down|1-9> [--no-submit]
                                                      answer a prompt or type into the chat box (Enter is added for text, yes and no)
  hub answer <id> --keys '1\\r'                       write raw keys (\\r \\n \\t \\e escapes)
  hub --help                                          this text (also: hub with no arguments), exit 0

listener SPEC (repeatable; run may have none, listen needs one):
  omb:<botId>/<threadId>              deliver to an OpenMausBot bot thread (needs omb-bridge.json in the data dir)
  http:<url>                          POST each event as JSON
  cmd:<argv0>[,<arg>…]                one JSON line on stdin; exit 0 = delivered and acknowledges the create handshake
                                      (printing {"ack":"<token>"} on stdout is accepted too; a wrong token is refused)
  suffix #events=attention,turn,exit   event filter (default: all four)
  http extras: #header=Name:Value (repeatable), #bearer-env=VAR
  use --listen-file PATH for a JSON listener object when a secret must not land in shell history

--json (ls, show, status, run, wait, resize, rm-all, listen, ack, listeners, events, deliveries): stdout carries exactly one JSON value. A failure prints {"error":"…","code":N} to stderr and exits with the same code.

exit codes: 0 ok · 1 error · 2 hub not running · 10 attention needed (wait) · 124 timeout (wait) · otherwise the child's exit code (run, wait)

data dir: ${dataDir()}
  (TERMINAL_HUB_DATA_DIR, else ~/Library/Application Support/TerminalHub)

<id> may be any unique prefix of a session id.`;

const JSON_COMMANDS = new Set(['ls', 'show', 'status', 'run', 'wait', 'resize', 'rm-all', 'listen', 'ack', 'listeners', 'events', 'deliveries']);

/** `--json` counts for the commands that support it; for `run` only before the `--` that starts the command. */
function wantsJson(argv: string[]): boolean {
  const [command, ...args] = argv;
  if (!command || !JSON_COMMANDS.has(command)) return false;
  const separator = command === 'run' ? args.indexOf('--') : -1;
  return (separator < 0 ? args : args.slice(0, separator)).includes('--json');
}

const jsonMode = wantsJson(process.argv.slice(2));

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
    /** Extra fields of the API's error body worth keeping, e.g. `conflict` of a 409. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface Api {
  baseUrl: string;
  token: string;
  pid?: number;
}

function notRunning(): CliError {
  return new CliError(`Terminal Hub is not running.\nStart it with:\n  ${startHint}`, 2);
}

function loadApi(): Api {
  try {
    const parsed = JSON.parse(readFileSync(apiFilePath(), 'utf8')) as Partial<Api>; // api.json also carries the app's pid
    if (typeof parsed.baseUrl === 'string' && typeof parsed.token === 'string') return { baseUrl: parsed.baseUrl, token: parsed.token, pid: parsed.pid };
  } catch {
    // fall through
  }
  throw notRunning();
}

async function call(api: Api, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(api.baseUrl + path, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${api.token}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw notRunning();
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string; conflict?: unknown };
    throw new CliError(`error ${response.status}: ${payload.error ?? response.statusText}`, 1, payload.conflict === undefined ? undefined : { conflict: payload.conflict });
  }
  return response;
}

async function json<T>(api: Api, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return (await call(api, path, init)).json() as Promise<T>;
}

async function resolveId(api: Api, prefix: string | undefined): Promise<string> {
  if (!prefix) throw new CliError(`missing <id>\n\n${USAGE}`);
  const sessions = await json<SessionInfo[]>(api, '/sessions');
  const matches = sessions.filter((session) => session.id.startsWith(prefix));
  const [only] = matches;
  if (matches.length === 1 && only) return only.id;
  throw new CliError(matches.length === 0 ? `no session matches ${prefix}` : `${prefix} is ambiguous (${matches.length} matches)`);
}

interface ExitEvent {
  exitCode: number | null;
  signal: number | null;
}

/** Reads an SSE response, calling `onEvent` per event until it returns true or the stream ends. */
async function readEvents(response: Response, onEvent: (event: string | undefined, data: string) => boolean): Promise<boolean> {
  if (!response.body) throw new CliError('empty stream');
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data !== undefined && onEvent(/^event: (.*)$/m.exec(block)?.[1], data)) return true;
    }
  }
  return false;
}

/** Follows /stream, writing text to `out`, until the session exits. */
async function follow(api: Api, id: string, out: (text: string) => void): Promise<ExitEvent> {
  let exit: ExitEvent | null = null;
  await readEvents(await call(api, `/sessions/${id}/stream`), (event, data) => {
    if (event === 'exit') exit = JSON.parse(data) as ExitEvent;
    else out((JSON.parse(data) as { text: string }).text);
    return exit !== null;
  });
  if (!exit) throw new CliError('stream closed before the session exited');
  return exit;
}

function describeAttention(session: Pick<SessionInfo, 'attention'>): string {
  const { attention } = session;
  return attention ? `attention: ${attention.reason} (${attention.source}) since ${attention.since}\n${attention.promptText}` : '';
}

const ATTENTION_EXIT_CODE = 10;
const TIMEOUT_EXIT_CODE = 124;

type WaitOutcome = { kind: 'exited'; code: number; signal: number | null } | { kind: 'attention'; attention: AttentionInfo };

/** Resolves when the session exits or needs attention. Throws CliError(124) on timeout. */
async function wait(api: Api, id: string, timeoutSeconds: number | null): Promise<WaitOutcome> {
  const settled = (session: SessionInfo): WaitOutcome | null => {
    if (!session.running) return { kind: 'exited', code: exitCodeOf(session), signal: session.signal };
    return session.attention ? { kind: 'attention', attention: session.attention } : null;
  };
  const now = settled(await json<SessionInfo>(api, `/sessions/${id}`));
  if (now !== null) return now;

  const controller = new AbortController();
  const timer = timeoutSeconds === null ? null : setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let outcome: WaitOutcome | null = null;
  try {
    const response = await fetch(`${api.baseUrl}/events`, { headers: { Authorization: `Bearer ${api.token}` }, signal: controller.signal });
    await readEvents(response, (event, data) => {
      const payload = JSON.parse(data) as SessionInfo & ExitEvent;
      if (payload.id !== id) return false;
      if (event === 'exit') outcome = { kind: 'exited', code: exitCodeOf(payload), signal: payload.signal };
      else if (event === 'attention' && payload.attention) outcome = { kind: 'attention', attention: payload.attention };
      return outcome !== null;
    });
  } catch (error) {
    if (!controller.signal.aborted) throw error instanceof CliError ? error : notRunning();
    throw new CliError(`timed out after ${timeoutSeconds}s`, TIMEOUT_EXIT_CODE);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
  if (outcome === null) throw new CliError('event stream closed');
  return outcome;
}

/** Prints the outcome of `wait` (one JSON value with --json) and returns the exit code. */
function reportWait(id: string, outcome: WaitOutcome, forced?: { id: string; title: string; cwd: string }): number {
  const extra = forced ? { forced } : {};
  if (outcome.kind === 'attention') {
    if (jsonMode) printJson({ id, status: 'attention', attention: outcome.attention, code: ATTENTION_EXIT_CODE, ...extra });
    else console.log(describeAttention({ attention: outcome.attention }));
    return ATTENTION_EXIT_CODE;
  }
  if (jsonMode) printJson({ id, status: 'exited', exitCode: outcome.code, signal: outcome.signal, code: outcome.code, ...extra });
  return outcome.code;
}

function parseTimeout(flags: Map<string, string | true>): number | null {
  const timeout = flags.has('--timeout') ? Number(flags.get('--timeout')) : null;
  if (timeout !== null && !(timeout >= 0)) throw new CliError('--timeout needs a number of seconds');
  return timeout;
}

/** Prints every attention, turn and exit event as one JSON line, until Ctrl-C (exit 0) or the app goes away. */
async function watch(api: Api): Promise<number> {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
  let response: Response;
  try {
    response = await fetch(`${api.baseUrl}/events`, { headers: { Authorization: `Bearer ${api.token}` } });
  } catch {
    throw notRunning();
  }
  if (!response.ok) throw new CliError(`error ${response.status}: ${response.statusText}`);
  await readEvents(response, (event, data) => {
    const line = formatWatchLine(event, data);
    if (line !== null) process.stdout.write(`${line}\n`);
    return false;
  });
  throw new CliError('event stream closed');
}

/** Claude Code hook entry: forwards the hook event to the app. Never fails or blocks Claude. */
async function hookNotify(): Promise<void> {
  const hubSessionId = process.env.TERMINAL_HUB_SESSION_ID;
  if (!hubSessionId) return;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const api = loadApi();
    await fetch(`${api.baseUrl}/hooks/claude`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hubSessionId, sessionId: payload.session_id, cwd: payload.cwd, message: payload.message, hookEvent: payload.hook_event_name }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // a hook must never get in Claude Code's way
  }
}

/** One attempt, no retries, so the result shown is the endpoint's own answer. Works without the app running. */
async function notifyTest(): Promise<number> {
  const dir = dataDir();
  const { config, warning } = loadNotifyConfig(dir);
  if (!config) {
    throw new CliError(`no notification endpoint configured${warning ? ` (${warning})` : ''}.\nWrite ${notifyConfigPath(dir)}:\n  {"url": "http://127.0.0.1:PORT/hooks/xxx", "bearer": "secret-or-empty"}\nor set TERMINAL_HUB_NOTIFY_URL (and TERMINAL_HUB_NOTIFY_BEARER).`);
  }
  const attention = { reason: 'prompt' as const, promptText: 'Continue? [y/N] (synthetic hub notify-test event)', source: 'heuristic' as const, since: new Date().toISOString() };
  const session = { id: 'notify-test', title: 'hub notify-test', cwd: process.cwd(), command: 'hub notify-test', state: 'running' as const };
  const result = await deliver(config, buildEvent('attention', session, attention), { maxAttempts: 1, log: new NotifyLog(dir) });
  const host = new URL(config.url).host;
  if (result.ok) {
    console.log(`attention event delivered to ${host} (config from ${config.source}): HTTP ${result.status}`);
    return 0;
  }
  throw new CliError(`delivery to ${host} failed: ${result.status === null ? result.error : `HTTP ${result.status}`}`);
}

function exitCodeOf(event: ExitEvent): number {
  return event.exitCode ?? (event.signal ? 128 + event.signal : 1);
}

function parseFlags(args: string[], valueFlags: string[], boolFlags: string[], repeatFlags: string[] = []): { flags: Map<string, string | true>; rest: string[]; repeated: Map<string, string[]> } {
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (repeatFlags.includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new CliError(`${arg} needs a value`);
      repeated.set(arg, [...(repeated.get(arg) ?? []), value]);
    } else if (valueFlags.includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new CliError(`${arg} needs a value`);
      flags.set(arg, value);
    } else if (boolFlags.includes(arg)) flags.set(arg, true);
    else if (arg.startsWith('-') && arg !== '-') throw new CliError(`unknown option ${arg}\n\n${USAGE}`);
    else rest.push(arg);
  }
  return { flags, rest, repeated };
}

const LISTENER_EVENTS = ['attention', 'resolved', 'turn', 'exit'];

/** `http:<url>`, `cmd:<argv0>[,<arg>…]`, `omb:<botId>/<threadId>` plus #events/#header/#bearer-env fragments. */
function parseListenSpec(spec: string, ackTimeoutSec?: number): ListenerRequest {
  const [head = '', ...fragments] = spec.split('#');
  let request: ListenerRequest;
  if (head.startsWith('omb:')) {
    const [botId, threadId] = head.slice(4).split('/');
    if (!botId || !threadId) throw new CliError(`bad omb listener spec (omb:<botId>/<threadId>): ${spec}`);
    request = { kind: 'openmausbot', openmausbot: { botId, threadId } };
  } else if (head.startsWith('http:')) {
    const url = head.slice(5);
    if (!/^https?:\/\//.test(url)) throw new CliError(`bad http listener spec (http:<url>): ${spec}`);
    request = { kind: 'http', http: { url } };
  } else if (head.startsWith('cmd:')) {
    const argv = head.slice(4).split(',');
    if (!argv[0]) throw new CliError(`bad command listener spec (cmd:<argv0>[,<arg>…]): ${spec}`);
    request = { kind: 'command', command: { argv } };
  } else {
    throw new CliError(`a listener spec starts with omb:, http: or cmd: — got ${spec}`);
  }
  const http = request.http;
  for (const fragment of fragments) {
    const at = fragment.indexOf('=');
    if (at < 0) throw new CliError(`bad listener fragment #${fragment}; expected key=value`);
    const key = fragment.slice(0, at);
    const value = fragment.slice(at + 1);
    if (key === 'events') {
      const events = value.split(',').filter((name) => name !== '');
      for (const name of events) if (!LISTENER_EVENTS.includes(name)) throw new CliError(`unknown event name in #events: ${name}`);
      request.events = events as ListenerRequest['events'];
    } else if (key === 'header' && http) {
      const colon = value.indexOf(':');
      if (colon < 1) throw new CliError('#header needs Name:Value');
      http.headers = { ...http.headers, [value.slice(0, colon)]: value.slice(colon + 1) };
    } else if (key === 'bearer-env' && http) {
      const bearer = process.env[value];
      if (!bearer) throw new CliError(`#bearer-env=${value} is set but $${value} is empty`);
      http.bearer = bearer;
    } else {
      throw new CliError(`unknown listener fragment: #${key}`);
    }
  }
  if (ackTimeoutSec !== undefined) request.ackTimeoutSec = ackTimeoutSec;
  return request;
}

function readListenFile(path: string): ListenerRequest {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ListenerRequest;
  } catch (error) {
    throw new CliError(`cannot read listener file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseAckTimeout(flags: Map<string, string | true>): number | undefined {
  if (!flags.has('--ack-timeout')) return undefined;
  const seconds = Number(flags.get('--ack-timeout'));
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new CliError('--ack-timeout needs an integer between 1 and 300 seconds');
  return seconds;
}

function collectListeners(flags: Map<string, string | true>, repeated: Map<string, string[]>): ListenerRequest[] {
  const ackTimeoutSec = parseAckTimeout(flags);
  const listeners = (repeated.get('--listen') ?? []).map((spec) => parseListenSpec(spec, ackTimeoutSec));
  for (const path of repeated.get('--listen-file') ?? []) {
    const fromFile = readListenFile(path);
    listeners.push(ackTimeoutSec === undefined ? fromFile : { ...fromFile, ackTimeoutSec });
  }
  return listeners;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

type Forced = { id: string; title: string; cwd: string };

/** stderr note that `--force` went past the worktree guard; stdout stays the id / JSON. */
function warnForced(forced: Forced | undefined): void {
  if (forced) console.error(`warning: started a second session in the same worktree (already running: ${forced.id} "${forced.title}")`);
}

async function run(api: Api, args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1) throw new CliError(`hub run needs a command after --\n\n${USAGE}`);
  const { flags, repeated } = parseFlags(args.slice(0, separator), ['--cwd', '--title', '--timeout'], ['-q', '--quiet', '--unattended', '--json', '--detach', '--wait', '--force'], ['--listen', '--listen-file']);
  const timeout = parseTimeout(flags);
  const listeners = collectListeners(flags, repeated);
  const [command = '', ...commandArgs] = args.slice(separator + 1);
  const { id, forced } = await json<{ id: string; forced?: Forced }>(api, '/sessions', {
    method: 'POST',
    body: { cwd: resolve(String(flags.get('--cwd') ?? process.cwd())), command, args: commandArgs, title: flags.get('--title'), unattended: flags.has('--unattended') || undefined, force: flags.has('--force') || undefined, listeners },
  });
  warnForced(forced);
  if (!jsonMode) console.log(id);
  if (flags.has('--wait')) return reportWait(id, await wait(api, id, timeout), forced);
  if (flags.has('--detach')) {
    if (jsonMode) printJson({ id, ...(forced ? { forced } : {}) });
    return 0;
  }
  const quiet = jsonMode || flags.has('-q') || flags.has('--quiet');
  const exit = await follow(api, id, (text) => (quiet ? undefined : void process.stdout.write(text)));
  if (jsonMode) printJson({ id, exitCode: exit.exitCode, signal: exit.signal, code: exitCodeOf(exit), ...(forced ? { forced } : {}) });
  return exitCodeOf(exit);
}

interface Health {
  version?: string;
  startedAt?: string;
  pid?: number;
}

async function status(api: Api): Promise<number> {
  let health: Health;
  try {
    const response = await fetch(`${api.baseUrl}/health`);
    if (!response.ok) throw new CliError(`error ${response.status}: ${response.statusText}`);
    health = (await response.json()) as Health;
  } catch (error) {
    throw error instanceof CliError ? error : notRunning();
  }
  const sessions = await json<SessionInfo[]>(api, '/sessions');
  const result = {
    running: true,
    version: health.version ?? null,
    pid: health.pid ?? api.pid ?? null,
    startedAt: health.startedAt ?? null,
    baseUrl: api.baseUrl,
    dataDir: dataDir(),
    total: sessions.length,
    sessionsRunning: sessions.filter((s) => s.running).length,
    // waiting: needs a decision from the caller, i.e. attention is set or the agent's turn is `waiting`
    waiting: sessions.filter((s) => s.running && (s.attention !== null || s.turn?.state === 'waiting')).length,
  };
  if (jsonMode) printJson(result);
  else {
    console.log(`Terminal Hub ${result.version ?? '?'} is running`);
    console.log(`pid:        ${result.pid ?? '?'}`);
    console.log(`started:    ${result.startedAt ?? '?'}`);
    console.log(`api:        ${result.baseUrl}`);
    console.log(`data dir:   ${result.dataDir}`);
    console.log(`sessions:   ${result.total} total, ${result.sessionsRunning} running, ${result.waiting} waiting`);
  }
  return 0;
}

function show(session: SessionInfo): number {
  if (jsonMode) {
    printJson(session);
    return 0;
  }
  const attention = session.attention ? `${session.attention.reason} (${session.attention.source}) since ${session.attention.since}` : '-';
  const rows: [string, string][] = [
    ['id', session.id],
    ['state', session.state],
    ['running', String(session.running)],
    ['exitCode', session.exitCode === null ? '-' : String(session.exitCode)],
    ['cwd', session.cwd],
    ['command', [session.command, ...session.argv].join(' ')],
    ['title', session.title],
    ['archived', String(session.archived)],
    ['resumable', String(session.resumable)],
    ['attention', attention],
    ['turn', session.turn ? `${session.turn.state} since ${session.turn.since}` : '-'],
  ];
  for (const [key, value] of rows) console.log(`${pad(key, 10)} ${value}`);
  return 0;
}

/** `hub <command> --help`: that command's usage lines plus the shared --json, exit code and data dir notes. */
function commandHelp(command: string): string | null {
  const [head = '', ...tail] = USAGE.split('\n\n');
  const lines: string[] = [];
  let inCommand = false;
  for (const line of head.split('\n')) {
    if (/^ {2}hub /.test(line)) inCommand = line.startsWith(`  hub ${command} `) || line === `  hub ${command}`;
    if (inCommand) lines.push(line);
  }
  return lines.length === 0 ? null : [['usage:', ...lines].join('\n'), ...tail].join('\n\n');
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const flagArgs = command === 'run' ? args.slice(0, Math.max(args.indexOf('--'), args.includes('--') ? 0 : args.length)) : args;
  const help = command && (flagArgs.includes('--help') || flagArgs.includes('-h')) ? commandHelp(command) : null;
  if (help) {
    console.log(help);
    return 0;
  }
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command === 'hook-notify') {
    await hookNotify();
    return 0;
  }
  if (command === 'notify-test') return notifyTest();
  const api = loadApi();
  switch (command) {
    case 'run':
      return run(api, args);
    case 'watch':
      return watch(api);
    case 'status':
      parseFlags(args, [], ['--json']);
      return status(api);
    case 'show': {
      const { rest } = parseFlags(args, [], ['--json']);
      return show(await json<SessionInfo>(api, `/sessions/${await resolveId(api, rest[0])}`));
    }
    case 'resize': {
      const { flags, rest } = parseFlags(args, ['--cols', '--rows'], ['--json']);
      const [cols, rows] = [Number(flags.get('--cols')), Number(flags.get('--rows'))];
      if (![cols, rows].every((n) => Number.isInteger(n) && n >= 1 && n <= 1000)) throw new CliError(`give --cols N and --rows N (integers 1..1000)\n\n${USAGE}`);
      const sessionId = await resolveId(api, rest[0]);
      await call(api, `/sessions/${sessionId}/resize`, { method: 'POST', body: { cols, rows } });
      if (jsonMode) printJson({ sessionId, cols, rows });
      return 0;
    }
    case 'rm-all': {
      const { flags } = parseFlags(args, [], ['--yes', '--json']);
      if (!flags.has('--yes')) throw new CliError('hub rm-all deletes every session and its files, running ones included. Re-run with --yes to confirm.');
      const { deleted } = await json<{ deleted: number }>(api, '/sessions/delete-all', { method: 'POST' });
      if (jsonMode) printJson({ deleted });
      else console.log(`deleted ${deleted}`);
      return 0;
    }
    case 'ls': {
      parseFlags(args, [], ['--json']);
      const sessions = (await json<SessionInfo[]>(api, '/sessions')).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      if (jsonMode) {
        printJson(sessions);
        return 0;
      }
      const widths = [36, 12, 10, 9, 5, 20, 30, 0];
      console.log(['ID', 'STATE', 'RESUMABLE', 'ARCHIVED', 'EXIT', 'STARTED', 'CWD', 'TITLE'].map((h, i) => pad(h, widths[i] ?? 0)).join(' '));
      for (const s of sessions) {
        const exit = s.running ? '-' : String(s.exitCode ?? (s.signal === null ? '?' : `sig${s.signal}`));
        const cells = [s.id, s.running ? 'running' : s.state, s.resumable ? (s.claude ? 'yes' : 'restart') : 'no', s.archived ? 'ARCHIVED' : '-', exit, s.startedAt.slice(0, 19), s.cwd, s.title];
        console.log(cells.map((cell, i) => pad(cell, widths[i] ?? 0)).join(' '));
      }
      return 0;
    }
    case 'text': {
      const { flags, rest } = parseFlags(args, [], ['--follow', '-f']);
      const id = await resolveId(api, rest[0]);
      if (flags.has('--follow') || flags.has('-f')) {
        await follow(api, id, (text) => void process.stdout.write(text));
      } else process.stdout.write(await (await call(api, `/sessions/${id}/text`)).text());
      return 0;
    }
    case 'send': {
      const { flags, rest } = parseFlags(args, [], ['--no-enter']);
      const id = await resolveId(api, rest[0]);
      const text = rest.slice(1).join(' ');
      await call(api, `/sessions/${id}/input`, { method: 'POST', body: { data: flags.has('--no-enter') ? text : `${text}\r` } });
      return 0;
    }
    case 'wait': {
      const { flags, rest } = parseFlags(args, ['--timeout'], ['--json']);
      const timeout = parseTimeout(flags);
      const id = await resolveId(api, rest[0]);
      return reportWait(id, await wait(api, id, timeout));
    }
    case 'answer': {
      const { flags, rest } = parseFlags(args, ['--keys'], ['--no-submit']);
      const id = await resolveId(api, rest[0]);
      const text = rest.slice(1).join(' ');
      const keys = flags.get('--keys');
      if ((keys === undefined) === (text === '')) throw new CliError(`give either <text> or --keys\n\n${USAGE}`);
      const bare = /^(enter|esc|escape|tab|up|down|left|right|[1-9])$/i.test(text);
      const body = typeof keys === 'string' ? { keys: keys.replaceAll('\\r', '\r').replaceAll('\\n', '\n').replaceAll('\\t', '\t').replaceAll('\\e', '\x1b') } : { text, submit: !bare && !flags.has('--no-submit') };
      const result = await json<{ sent: string }>(api, `/sessions/${id}/answer`, { method: 'POST', body });
      console.log(`sent ${JSON.stringify(result.sent)}`);
      return 0;
    }
    case 'archive':
    case 'unarchive': {
      const id = await resolveId(api, args[0]);
      await call(api, `/sessions/${id}/archive`, { method: 'POST', body: { archived: command === 'archive' } });
      return 0;
    }
    case 'rename': {
      const { flags, rest } = parseFlags(args, [], ['--auto']);
      const id = await resolveId(api, rest[0]);
      const title = rest.slice(1).join(' ');
      if (flags.has('--auto') === (title !== '')) throw new CliError(`give either <title> or --auto\n\n${USAGE}`);
      await call(api, `/sessions/${id}/title`, { method: 'POST', body: flags.has('--auto') ? { auto: true } : { title } });
      return 0;
    }
    case 'stop':
    case 'rm':
    case 'resume': {
      const { flags, rest } = parseFlags(args, [], command === 'resume' ? ['--follow', '-f', '--force'] : []);
      const id = await resolveId(api, rest[0]);
      if (command === 'stop') await call(api, `/sessions/${id}/stop`, { method: 'POST' });
      else if (command === 'rm') await call(api, `/sessions/${id}`, { method: 'DELETE' });
      else {
        const resumed = (await (await call(api, `/sessions/${id}/resume`, { method: 'POST', body: flags.has('--force') ? { force: true } : undefined })).json().catch(() => ({}))) as { forced?: Forced };
        warnForced(resumed.forced);
        console.log(id);
        if (flags.has('--follow') || flags.has('-f')) return exitCodeOf(await follow(api, id, (text) => void process.stdout.write(text)));
      }
      return 0;
    }
    case 'listen': {
      const { flags, rest, repeated } = parseFlags(args, ['--ack-timeout'], ['--json', '--no-wait'], ['--listen', '--listen-file']);
      const listeners = collectListeners(flags, repeated);
      if (listeners.length !== 1) throw new CliError('hub listen takes exactly one listener (one --listen or one --listen-file)');
      const id = await resolveId(api, rest[0]);
      const result = await call(api, `/sessions/${id}/listeners`, { method: 'POST', body: { ...(listeners[0] as object), wait: !flags.has('--no-wait') } });
      const body: unknown = await result.json();
      if (jsonMode) printJson(body);
      else console.log(`listener added to ${id}`);
      return 0;
    }
    case 'ack': {
      const { rest } = parseFlags(args, [], ['--json']);
      const [handshakeId, ackToken] = rest;
      if (handshakeId === undefined || ackToken === undefined) throw new CliError(`hub ack needs <handshake-id> <token>\n\n${USAGE}`);
      const api = loadApi();
      let response: Response;
      try {
        response = await fetch(`${api.baseUrl}/handshakes/${encodeURIComponent(handshakeId)}/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ackToken }),
        });
      } catch {
        throw notRunning();
      }
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) throw new CliError(`error ${response.status}: ${typeof payload.error === 'string' ? payload.error : response.statusText}`);
      if (jsonMode) printJson(payload);
      else console.log(`acknowledged ${handshakeId}`);
      return 0;
    }
    case 'listeners': {
      const sub = args[0];
      if (sub === 'rm' || sub === 'resume') {
        const id = await resolveId(api, args[1]);
        const listenerId = args[2];
        if (listenerId === undefined) throw new CliError(`hub listeners ${sub} needs <session> <listener-id>\n\n${USAGE}`);
        if (sub === 'rm') await call(api, `/sessions/${id}/listeners/${encodeURIComponent(listenerId)}`, { method: 'DELETE' });
        else printJson(await json<unknown>(api, `/sessions/${id}/listeners/${encodeURIComponent(listenerId)}/resume`, { method: 'POST' }));
        return 0;
      }
      const { rest } = parseFlags(args, [], ['--json']);
      const id = await resolveId(api, rest[0]);
      const listeners = await json<unknown[]>(api, `/sessions/${id}/listeners`);
      if (jsonMode) printJson(listeners);
      else for (const listener of listeners) console.log(JSON.stringify(listener));
      return 0;
    }
    case 'events': {
      const { flags, rest } = parseFlags(args, ['--since', '--limit'], ['--json', '--follow', '-f']);
      const id = await resolveId(api, rest[0]);
      let since = flags.has('--since') ? Number(flags.get('--since')) : 0;
      if (!Number.isInteger(since) || since < 0) throw new CliError('--since needs a non-negative integer seq');
      const limit = flags.has('--limit') ? Number(flags.get('--limit')) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new CliError('--limit needs a positive integer');
      const followMode = flags.has('--follow') || flags.has('-f');
      for (;;) {
        const page = await json<{ events: unknown[]; next: number }>(api, `/sessions/${id}/events?since=${since}${limit === undefined ? '' : `&limit=${limit}`}`);
        if (!followMode && jsonMode) {
          printJson(page);
          return 0;
        }
        for (const event of page.events) console.log(JSON.stringify(event));
        since = page.next;
        if (!followMode) return 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
    }
    case 'deliveries': {
      const { flags, rest } = parseFlags(args, ['--listener', '--limit'], ['--json']);
      const id = await resolveId(api, rest[0]);
      const listener = flags.get('--listener');
      const limit = flags.get('--limit');
      const query = `${listener === undefined || listener === true ? '' : `?listener=${encodeURIComponent(listener)}`}${limit === undefined || limit === true ? '' : `${listener === undefined || listener === true ? '?' : '&'}limit=${encodeURIComponent(limit)}`}`;
      const records = await json<unknown[]>(api, `/sessions/${id}/deliveries${query}`);
      if (jsonMode) printJson(records);
      else for (const record of records) console.log(JSON.stringify(record));
      return 0;
    }
    default:
      throw new CliError(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const code = error instanceof CliError ? error.code : 1;
    if (jsonMode) console.error(JSON.stringify({ error: (error instanceof Error ? error.message : String(error)).split('\n\nusage:')[0], code, ...(error instanceof CliError ? error.details : {}) }));
    else console.error(error instanceof CliError ? error.message : error);
    process.exit(code);
  },
);
