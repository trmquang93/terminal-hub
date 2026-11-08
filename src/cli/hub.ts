import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionInfo } from '../shared/types';
import { loadNotifyConfig, notifyConfigPath } from '../main/notifyConfig';
import { buildEvent, deliver, NotifyLog } from '../main/notifyDelivery';
import { apiFilePath, dataDir } from '../main/paths';

/** Set to `true` by scripts/build-cli.mjs for the copy bundled inside Terminal Hub.app. */
declare const HUB_PACKAGED: boolean | undefined;
const startHint = typeof HUB_PACKAGED !== 'undefined' && HUB_PACKAGED ? "open -a 'Terminal Hub'" : `cd ${resolve(__dirname, '..', '..')} && npm start`;

const USAGE = `usage:
  hub run [--cwd DIR] [--title T] [--unattended] [-q] -- CMD ARGS…   start a session, follow it, exit with its exit code
  hub ls                                              list sessions (state, resumable, archived)
  hub text <id> [--follow]                            plain-text output (ANSI stripped)
  hub send <id> "text" [--no-enter]                   type into a session (Enter appended by default)
  hub stop <id>                                       SIGTERM, SIGKILL after 3 s
  hub resume <id> [--follow]                          resume (Claude Code) or restart (other commands)
  hub archive <id>                                    move a finished session to the Archived list (refused while it runs)
  hub unarchive <id>                                  move it back
  hub rm <id>                                         delete the session and its files
  hub notify-test                                     send one synthetic "attention" event to the endpoint in notify.json and print the HTTP result
  hub wait <id> [--timeout S]                         block until it needs attention (exit 10, prints the question) or exits (its code); 124 on timeout
  hub answer <id> <text|yes|no|enter|esc|tab|up|down|1-9> [--no-submit]
                                                      answer a prompt or type into the chat box (Enter is added for text, yes and no)
  hub answer <id> --keys '1\\r'                       write raw keys (\\r \\n \\t \\e escapes)

<id> may be any unique prefix of a session id.`;

class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

interface Api {
  baseUrl: string;
  token: string;
}

function notRunning(): CliError {
  return new CliError(`Terminal Hub is not running.\nStart it with:\n  ${startHint}`, 2);
}

function loadApi(): Api {
  try {
    const parsed = JSON.parse(readFileSync(apiFilePath(), 'utf8')) as Partial<Api>;
    if (typeof parsed.baseUrl === 'string' && typeof parsed.token === 'string') return { baseUrl: parsed.baseUrl, token: parsed.token };
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
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new CliError(`error ${response.status}: ${payload.error ?? response.statusText}`);
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

async function wait(api: Api, id: string, timeoutSeconds: number | null): Promise<number> {
  const settled = (session: SessionInfo): number | null => {
    if (!session.running) return exitCodeOf(session);
    if (!session.attention) return null;
    console.log(describeAttention(session));
    return ATTENTION_EXIT_CODE;
  };
  const now = settled(await json<SessionInfo>(api, `/sessions/${id}`));
  if (now !== null) return now;

  const controller = new AbortController();
  const timer = timeoutSeconds === null ? null : setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let code: number | null = null;
  try {
    const response = await fetch(`${api.baseUrl}/events`, { headers: { Authorization: `Bearer ${api.token}` }, signal: controller.signal });
    await readEvents(response, (event, data) => {
      const payload = JSON.parse(data) as SessionInfo & ExitEvent;
      if (payload.id !== id) return false;
      if (event === 'exit') code = exitCodeOf(payload);
      else if (payload.attention) {
        console.log(describeAttention(payload));
        code = ATTENTION_EXIT_CODE;
      }
      return code !== null;
    });
  } catch (error) {
    if (!controller.signal.aborted) throw error instanceof CliError ? error : notRunning();
    console.error(`timed out after ${timeoutSeconds}s`);
    return TIMEOUT_EXIT_CODE;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
  if (code === null) throw new CliError('event stream closed');
  return code;
}

/** Claude Code Notification hook entry: forwards the notification to the app. Never fails or blocks Claude. */
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

function parseFlags(args: string[], valueFlags: string[], boolFlags: string[]): { flags: Map<string, string | true>; rest: string[] } {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (valueFlags.includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new CliError(`${arg} needs a value`);
      flags.set(arg, value);
    } else if (boolFlags.includes(arg)) flags.set(arg, true);
    else if (arg.startsWith('-') && arg !== '-') throw new CliError(`unknown option ${arg}\n\n${USAGE}`);
    else rest.push(arg);
  }
  return { flags, rest };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

async function run(api: Api, args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1) throw new CliError(`hub run needs a command after --\n\n${USAGE}`);
  const { flags } = parseFlags(args.slice(0, separator), ['--cwd', '--title'], ['-q', '--quiet', '--unattended']);
  const [command = '', ...commandArgs] = args.slice(separator + 1);
  const { id } = await json<{ id: string }>(api, '/sessions', {
    method: 'POST',
    body: { cwd: resolve(String(flags.get('--cwd') ?? process.cwd())), command, args: commandArgs, title: flags.get('--title'), unattended: flags.has('--unattended') || undefined },
  });
  console.log(id);
  const quiet = flags.has('-q') || flags.has('--quiet');
  return exitCodeOf(await follow(api, id, (text) => (quiet ? undefined : void process.stdout.write(text))));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
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
    case 'ls': {
      const sessions = (await json<SessionInfo[]>(api, '/sessions')).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
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
      const { flags, rest } = parseFlags(args, ['--timeout'], []);
      const timeout = flags.has('--timeout') ? Number(flags.get('--timeout')) : null;
      if (timeout !== null && !(timeout >= 0)) throw new CliError('--timeout needs a number of seconds');
      return wait(api, await resolveId(api, rest[0]), timeout);
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
    case 'stop':
    case 'rm':
    case 'resume': {
      const { flags, rest } = parseFlags(args, [], command === 'resume' ? ['--follow', '-f'] : []);
      const id = await resolveId(api, rest[0]);
      if (command === 'stop') await call(api, `/sessions/${id}/stop`, { method: 'POST' });
      else if (command === 'rm') await call(api, `/sessions/${id}`, { method: 'DELETE' });
      else {
        await call(api, `/sessions/${id}/resume`, { method: 'POST' });
        console.log(id);
        if (flags.has('--follow') || flags.has('-f')) return exitCodeOf(await follow(api, id, (text) => void process.stdout.write(text)));
      }
      return 0;
    }
    default:
      throw new CliError(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof CliError ? error.message : error);
    process.exit(error instanceof CliError ? error.code : 1);
  },
);
