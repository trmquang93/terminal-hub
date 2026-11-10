import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import * as pty from 'node-pty';
import type { AgentInfo, AnswerRequest, AttentionInfo, ListenerInfo, OutputSlice, SessionInfo, SessionMeta, StartSessionOptions } from '../shared/types';
import { TurnTracker } from './agentState';
import { stripAnsi } from './ansi';
import { AttentionTracker, resolveAnswer, SAFE_UNATTENDED_POLICY } from './attention';
import { discoverSessionId, fillTemplate, findClaudeIndex, hasSettingsFlag, planClaudeLaunch, renderCommand, SESSION_PLACEHOLDER, transcriptExists, withSettings } from './claude';
import { HubError } from './errors';
import { discoverOpencodeSessionId, opencodeSessionExists, planOpencodeLaunch } from './opencode';
import { OscTitleParser } from './oscTitle';
import type { OutputChunk, SessionService } from './service';
import type { SessionStore } from './sessionStore';
import { nativeTranscript, renderTranscript, transcriptHasAssistantText } from './transcript';
import { worktreeKey } from './worktree';

const STOP_GRACE_MS = 3000;
const ANSWER_CHUNK_GAP_MS = 150;
const DISCOVERY_INTERVAL_MS = 2000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
/** Most recent output kept in memory per running agent session, so a re-opened view can repaint. The last screen is also written to tail.log on exit. */
const LIVE_TAIL_BYTES = 2 * 1024 * 1024;
/** How much of the last screen is kept in tail.log when an agent session exits. */
const TAIL_LOG_BYTES = 200 * 1024;

/** macOS/Linux signal numbers node-pty reports inside exitCode (128+n) when it gives no separate signal. */
const SIGNAL_NAMES: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL', 15: 'SIGTERM', 18: 'SIGCONT', 19: 'SIGSTOP' };

type Signal = 'SIGHUP' | 'SIGTERM' | 'SIGKILL';

interface Events {
  output: [OutputChunk];
  changed: [SessionInfo];
  attention: [SessionInfo];
  turn: [SessionInfo];
  removed: [string];
}

class Emitter extends EventEmitter {
  override on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    return super.emit(event, ...args);
  }
}

function findExecutable(command: string, searchPath: string | undefined, cwd: string): string {
  if (command.includes('/')) return command;
  for (const dir of (searchPath ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir.startsWith('/') ? dir : join(cwd, dir), command);
    try {
      if (!statSync(candidate).isDirectory()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // not in this directory
    }
  }
  throw new HubError(400, `command not found in PATH: ${command}`);
}

async function* noChunks(): AsyncGenerator<Buffer> {}

function clampDimension(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 1000 ? (value as number) : fallback;
}

/** In-memory output of an agent session: `total` counts every byte since the app started, `chunks` hold the newest ones. */
interface LiveOutput {
  total: number;
  chunks: Buffer[];
  held: number;
}

export interface ManagerOptions {
  baseEnv?: () => NodeJS.ProcessEnv;
  attention?: { idleMs?: number; quietMs?: number };
  /** Refreshes hub's Claude hook settings file and returns its path (null: inject nothing). Called before every Claude launch; must not throw. */
  hooksFile?: () => string | null;
  /** Diagnostics that are not errors (e.g. hook injection skipped); `level` defaults to INFO. */
  log?: (message: string, level?: 'WARN') => void;
  /** The redacted listeners of a session, added to every SessionInfo the API returns. */
  listenerInfo?: (id: string) => ListenerInfo[];
}

export interface HookNotification {
  hubSessionId?: string;
  sessionId?: string;
  message: string;
  /** hook_event_name from Claude Code; absent from older callers, which only ever sent Notification. */
  hookEvent?: string;
}

export class SessionManager implements SessionService {
  private readonly emitter = new Emitter();
  private readonly sessions = new Map<string, SessionMeta>();
  private readonly live = new Map<string, pty.IPty>();
  private readonly killTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly discoveryTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly trackers = new Map<string, AttentionTracker>();
  private readonly turns = new Map<string, TurnTracker>();
  private readonly titleParsers = new Map<string, OscTitleParser>();
  private readonly liveOutputs = new Map<string, LiveOutput>();
  private readonly baseEnv: () => NodeJS.ProcessEnv;
  private shuttingDown = false;

  constructor(
    private readonly store: SessionStore,
    private readonly appVersion: string,
    private readonly options: ManagerOptions = {},
  ) {
    this.baseEnv = options.baseEnv ?? (() => process.env);
    this.emitter.setMaxListeners(0);
    for (const meta of store.loadAll()) {
      this.sessions.set(meta.id, meta);
      if (meta.claude && meta.claude.sessionId === null) this.discover(meta);
    }
  }

  // --- queries -------------------------------------------------------------

  private info(meta: SessionMeta): SessionInfo {
    const running = this.live.has(meta.id);
    const resumable = !running && (meta.claude === null || meta.claude.sessionId !== null);
    return {
      ...meta,
      titleSource: meta.titleSource ?? 'auto',
      running,
      resumable,
      attention: this.trackers.get(meta.id)?.attention ?? null,
      turn: running ? (this.turns.get(meta.id)?.turn ?? null) : null,
      // A human-created session (the window's New Session / IPC path) has no listener: [] is a valid state, not an error.
      listeners: this.options.listenerInfo?.(meta.id) ?? [],
    };
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((meta) => this.info(meta));
  }

  get(id: string): SessionInfo | undefined {
    const meta = this.sessions.get(id);
    return meta && this.info(meta);
  }

  private require(id: string): SessionMeta {
    const meta = this.sessions.get(id);
    if (!meta) throw new HubError(404, `no such session: ${id}`);
    return meta;
  }

  /** The offset live output runs to: bytes of output.log for a shell; for an agent session (nothing on disk) the bytes seen since the app started. */
  size(id: string): number {
    const meta = this.require(id);
    return meta.claude ? (this.liveOutputs.get(id)?.total ?? 0) : this.store.size(id);
  }

  /** output.log bytes; an agent session has none, so it yields nothing. */
  readChunks(id: string, start: number, end: number): AsyncGenerator<Buffer> {
    const meta = this.require(id);
    return meta.claude ? noChunks() : this.store.readChunks(id, start, end);
  }

  /**
   * The session's history from `offset`: output.log for a shell, the rendered native transcript (plain text) for Claude Code and
   * opencode. An agent with no native transcript falls back to its old output.log; `plain` strips that log's escape codes.
   * `total` is the size of that whole history.
   */
  async readHistory(id: string, offset: number, limit: number, plain = false): Promise<{ data: Buffer; total: number }> {
    const meta = this.require(id);
    if (!meta.claude) return { data: await this.store.readOutput(id, offset, limit), total: this.store.size(id) };
    const { data: raw, legacy } = await this.agentHistory(meta, meta.claude);
    const all = legacy && plain ? Buffer.from(stripAnsi(raw)) : raw;
    const start = Math.min(Math.max(offset, 0), all.length);
    return { data: all.subarray(start, start + limit), total: all.length };
  }

  /**
   * An agent's history: its native transcript; else, for a session from before agents kept their own transcript, its old
   * output.log (read-only); else the one-line note. `legacy` is true only for that log.
   */
  private async agentHistory(meta: SessionMeta, claude: AgentInfo): Promise<{ data: Buffer; legacy: boolean }> {
    const native = nativeTranscript(claude, meta.cwd);
    const tail = this.store.readTail(meta.id);
    if (native !== null) {
      // A run killed before its first reply leaves a transcript with the prompt only; the last screen then says what it did.
      if (tail !== null && !transcriptHasAssistantText(claude, meta.cwd)) return { data: Buffer.from(`${native}\n── last screen ──\n${tail}`), legacy: false };
      return { data: Buffer.from(native), legacy: false };
    }
    if (tail !== null) return { data: Buffer.from(tail), legacy: false };
    const total = this.store.size(meta.id);
    if (total > 0) return { data: await this.store.readOutput(meta.id, 0, total), legacy: true };
    return { data: Buffer.from(renderTranscript(claude, meta.cwd)), legacy: false };
  }

  /**
   * What the terminal view shows first. A shell: the last `tailBytes` of output.log (the file keeps everything).
   * A running agent: its in-memory tail. A finished agent: its native transcript, which sits outside the live
   * offsets (`total` 0), so output from a later resume still applies in full.
   */
  async readTail(id: string, tailBytes: number): Promise<OutputSlice> {
    const meta = this.require(id);
    if (!meta.claude) {
      const total = this.store.size(id);
      const start = Math.max(this.store.startOffset(id), total - tailBytes);
      return { data: await this.store.readOutput(id, start, total - start), start, total, source: 'log' };
    }
    if (!this.live.has(id)) {
      const { data, legacy } = await this.agentHistory(meta, meta.claude);
      // The old log is raw terminal output, shown like a shell's tail; it keeps no live offsets, so none are reported.
      if (legacy) return { data: data.subarray(Math.max(0, data.length - tailBytes)), start: 0, total: 0, source: 'log' };
      return { data: Buffer.from(data.toString().replaceAll('\n', '\r\n')), start: 0, total: 0, source: 'transcript' };
    }
    const out = this.liveOutputs.get(id);
    const data = Buffer.concat(out?.chunks ?? []);
    const kept = data.subarray(Math.max(0, data.length - tailBytes));
    return { data: kept, start: (out?.total ?? 0) - kept.length, total: out?.total ?? 0, source: 'live' };
  }

  onOutput(listener: (chunk: OutputChunk) => void): () => void {
    this.emitter.on('output', listener);
    return () => this.emitter.off('output', listener);
  }

  onChanged(listener: (session: SessionInfo) => void): () => void {
    this.emitter.on('changed', listener);
    return () => this.emitter.off('changed', listener);
  }

  /** Fires whenever a session's attention state changes (including back to null). */
  onAttention(listener: (session: SessionInfo) => void): () => void {
    this.emitter.on('attention', listener);
    return () => this.emitter.off('attention', listener);
  }

  /** Fires on every real change of a session's turn state (including back to null). */
  onTurn(listener: (session: SessionInfo) => void): () => void {
    this.emitter.on('turn', listener);
    return () => this.emitter.off('turn', listener);
  }

  onRemoved(listener: (id: string) => void): () => void {
    this.emitter.on('removed', listener);
    return () => this.emitter.off('removed', listener);
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * The running session in the same git worktree as `cwd`, other than `excludeId`. Only `this.live` counts: an exited,
   * interrupted or archived session holds nothing. Synchronous, so the check and the spawn share one tick.
   */
  private worktreeConflict(cwd: string, excludeId?: string): SessionMeta | null {
    const key = worktreeKey(cwd);
    if (key === null) return null;
    for (const id of this.live.keys()) {
      const other = this.sessions.get(id);
      if (other && id !== excludeId && worktreeKey(other.cwd) === key) return other;
    }
    return null;
  }

  /** Throws 409 when another session runs in this worktree; with `force` logs a WARN and returns the session it went past. */
  private guardWorktree(cwd: string, force: boolean | undefined, excludeId?: string): SessionInfo['forced'] {
    const other = this.worktreeConflict(cwd, excludeId);
    if (!other) return undefined;
    const conflict = { id: other.id, title: other.title, cwd: other.cwd };
    if (!force) {
      throw new HubError(409, `another session is already running in this worktree — id: ${other.id}, title: "${other.title}", cwd: ${other.cwd}. Send the next message to it (hub send ${other.id} …) or pass --force to start anyway.`, { conflict });
    }
    this.options.log?.(`forced a second session into a worktree already in use by ${other.id} "${other.title}" (${other.cwd}): ${cwd}`, 'WARN');
    return conflict;
  }

  start(options: StartSessionOptions): SessionInfo {
    const forced = this.guardWorktree(options.cwd, options.force);
    const args = options.args ?? [];
    const env = options.env ?? {};
    const runsClaude = findClaudeIndex([options.command, ...args]) >= 0;
    const claudePlan = planClaudeLaunch(options.command, args, env, this.baseEnv(), undefined, runsClaude ? (this.hooksFile() ?? undefined) : undefined);
    if (claudePlan?.settingsSkipped) this.options.log?.(`claude hooks not injected: ${options.command} already has its own --settings`);
    const plan = claudePlan ?? planOpencodeLaunch(options.command, args, env, this.baseEnv());
    const label = plan?.claude.provider ?? basename(options.command);
    const meta: SessionMeta = {
      id: randomUUID(),
      title: options.title?.trim() || `${label} — ${basename(options.cwd) || options.cwd}`,
      cwd: options.cwd,
      command: options.command,
      argv: plan?.args ?? args,
      env: plan?.env ?? env,
      state: 'running',
      claude: plan?.claude ?? null,
      resumeCount: 0,
      autoAnswer: options.autoAnswer ?? (options.unattended ? SAFE_UNATTENDED_POLICY : null),
      archived: false,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      signal: null,
      exitCause: null,
      cols: clampDimension(options.cols, DEFAULT_COLS),
      rows: clampDimension(options.rows, DEFAULT_ROWS),
      bytesWritten: 0,
      appVersion: this.appVersion,
    };
    // Persist before spawning so a crash or reboot still leaves an `interrupted` entry.
    this.store.create(meta);
    try {
      this.launch(meta, meta.argv);
    } catch (error) {
      this.store.delete(meta.id);
      throw error;
    }
    this.sessions.set(meta.id, meta);
    this.emitChanged(meta);
    return forced ? { ...this.info(meta), forced } : this.info(meta);
  }

  /** Relaunches a finished session in place: `--resume <uuid>` for Claude Code, `--session <id>` for opencode, the original command otherwise. */
  resume(id: string, force?: boolean): SessionInfo {
    const meta = this.require(id);
    if (this.live.has(id)) throw new HubError(409, 'session is already running');
    const forced = this.guardWorktree(meta.cwd, force, id);
    let args = meta.argv;
    if (meta.claude) {
      const { argvTemplate, sessionId, configDir, provider } = meta.claude;
      if (sessionId === null) throw new HubError(400, `no ${provider === 'opencode' ? 'opencode' : 'Claude'} session id recorded for this session; cannot resume`);
      if (provider === 'opencode') {
        const at = argvTemplate.indexOf(SESSION_PLACEHOLDER);
        const template = opencodeSessionExists(configDir, sessionId) ? argvTemplate : [...argvTemplate.slice(0, at - 1), ...argvTemplate.slice(at + 1)];
        args = fillTemplate(template, sessionId).slice(1);
      } else {
        // Claude writes the transcript after the first turn; before that there is nothing to resume, so reuse the id fresh.
        let template = transcriptExists(configDir, meta.cwd, sessionId) ? argvTemplate : argvTemplate.flatMap((token, i) => (token === '--resume' && argvTemplate[i + 1] === SESSION_PLACEHOLDER ? ['--session-id'] : [token]));
        // Sessions created before hooks were injected get them on their next resume.
        const claudeIndex = findClaudeIndex(template);
        const file = claudeIndex < 0 || hasSettingsFlag(template, claudeIndex) ? null : this.hooksFile();
        if (file !== null) template = withSettings(template, claudeIndex, file);
        args = fillTemplate(template, sessionId).slice(1);
      }
    }
    const previous = { ...meta };
    Object.assign(meta, { state: 'running', endedAt: null, exitCode: null, signal: null, archived: false, resumeCount: meta.resumeCount + 1 });
    try {
      this.launch(meta, args);
    } catch (error) {
      Object.assign(meta, previous);
      throw error;
    }
    this.appendOutput(meta, Buffer.from(`\r\n── resumed ${new Date().toISOString()} ──\r\n`));
    this.store.writeMeta(meta);
    this.emitChanged(meta);
    return forced ? { ...this.info(meta), forced } : this.info(meta);
  }

  private launch(meta: SessionMeta, args: string[]): void {
    try {
      if (!statSync(meta.cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new HubError(400, `cwd does not exist or is not a directory: ${meta.cwd}`);
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...this.baseEnv(), ...meta.env })) {
      if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
    }
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'TerminalHub', TERMINAL_HUB_SESSION_ID: meta.id });
    const file = findExecutable(meta.command, env.PATH, meta.cwd);
    let child: pty.IPty;
    try {
      child = pty.spawn(file, args, { name: 'xterm-256color', cols: meta.cols, rows: meta.rows, cwd: meta.cwd, env, encoding: null });
    } catch (error) {
      throw new HubError(400, `failed to start ${meta.command}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.live.set(meta.id, child);
    this.dropLiveTail(meta.id);
    this.turns.set(meta.id, new TurnTracker(() => this.live.has(meta.id) && this.emitTurn(meta)));
    this.titleParsers.set(meta.id, new OscTitleParser());
    this.trackers.set(
      meta.id,
      new AttentionTracker({
        ...this.options.attention,
        policy: () => meta.autoAnswer,
        onChange: () => this.live.has(meta.id) && this.emitAttention(meta),
        autoAnswer: (rule, promptText) => this.autoAnswer(meta, rule.keys, rule.match, promptText),
      }),
    );
    child.onData((data) => this.appendOutput(meta, typeof data === 'string' ? Buffer.from(data) : (data as Buffer)));
    child.onExit(({ exitCode, signal }) => this.handleExit(meta, child, exitCode, signal ?? null));
    if (meta.claude?.sessionId === null) {
      this.discoveryTimers.set(meta.id, setInterval(() => this.discover(meta), DISCOVERY_INTERVAL_MS));
    }
  }

  private appendOutput(meta: SessionMeta, data: Buffer): void {
    // Claude Code and opencode keep their own transcript; their repainting TUI output is never logged.
    const endOffset = meta.claude ? this.remember(meta.id, data) : this.store.appendOutput(meta.id, data);
    if (!meta.claude) meta.bytesWritten = endOffset;
    this.emitter.emit('output', { id: meta.id, endOffset, data });
    this.trackers.get(meta.id)?.output(data);
    const title = this.titleParsers.get(meta.id)?.push(data).at(-1);
    if (title !== undefined) this.applyEscapeTitle(meta, title);
  }

  private remember(id: string, data: Buffer): number {
    const out = this.liveOutputs.get(id) ?? { total: 0, chunks: [], held: 0 };
    this.liveOutputs.set(id, out);
    out.total += data.length;
    out.chunks.push(data);
    out.held += data.length;
    while (out.held > LIVE_TAIL_BYTES && out.chunks.length > 1) out.held -= out.chunks.shift()?.length ?? 0;
    return out.total;
  }

  /** Frees the in-memory tail but keeps the running total, so offsets stay increasing across a resume. */
  private dropLiveTail(id: string): void {
    const out = this.liveOutputs.get(id);
    if (out) Object.assign(out, { chunks: [], held: 0 });
  }

  /** The program set its terminal title (OSC 0/2), like a tab title in iTerm2. A manual rename wins. */
  private applyEscapeTitle(meta: SessionMeta, raw: string): void {
    if (meta.titleSource === 'manual') return;
    const title = raw.trim().slice(0, 200).trim();
    if (!title || title === meta.title) return;
    meta.title = title;
    meta.titleSource = 'auto';
    this.store.writeMeta(meta);
    this.emitChanged(meta);
  }

  private emitAttention(meta: SessionMeta): void {
    const info = this.info(meta);
    this.emitter.emit('changed', info);
    this.emitter.emit('attention', info);
  }

  private emitTurn(meta: SessionMeta): void {
    const info = this.info(meta);
    this.emitter.emit('changed', info);
    this.emitter.emit('turn', info);
  }

  private hooksFile(): string | null {
    try {
      return this.options.hooksFile?.() ?? null;
    } catch (error) {
      this.options.log?.(`claude hooks file failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private autoAnswer(meta: SessionMeta, keys: string, rule: string, promptText: string): void {
    this.store.appendAnswerLog(meta.id, { at: new Date().toISOString(), rule, keys, promptText });
    this.writeRaw(meta.id, keys);
  }

  private handleExit(meta: SessionMeta, child: pty.IPty, exitCode: number, signal: number | null): void {
    if (this.live.get(meta.id) !== child) return;
    const stoppedByHub = this.killTimers.has(meta.id);
    this.live.delete(meta.id);
    clearTimeout(this.killTimers.get(meta.id));
    this.killTimers.delete(meta.id);
    clearInterval(this.discoveryTimers.get(meta.id));
    this.discoveryTimers.delete(meta.id);
    this.trackers.get(meta.id)?.stop();
    this.trackers.delete(meta.id);
    this.turns.delete(meta.id);
    this.titleParsers.delete(meta.id);
    this.persistTail(meta);
    this.dropLiveTail(meta.id);
    this.store.close(meta.id);
    const endedSignal = signal && signal > 0 ? signal : exitCode > 128 && exitCode <= 192 ? exitCode - 128 : null;
    const exitCause = this.shuttingDown
      ? 'app-quit'
      : endedSignal === null
        ? `exit code ${exitCode}`
        : stoppedByHub
          ? `stopped by hub (${SIGNAL_NAMES[endedSignal] ?? `signal ${endedSignal}`})`
          : `${SIGNAL_NAMES[endedSignal] ?? `signal ${endedSignal}`} (sent from outside the app)`;
    Object.assign(meta, {
      state: this.shuttingDown ? 'interrupted' : 'exited',
      endedAt: new Date().toISOString(),
      exitCode,
      signal: endedSignal,
      exitCause,
      bytesWritten: this.store.size(meta.id),
    });
    this.options.log?.(`session ${meta.id.slice(0, 8)} exited: ${exitCause} (code ${exitCode})`);
    this.discover(meta, false);
    this.store.writeMeta(meta);
    this.emitChanged(meta);
  }

  /**
   * Writes the last screen of an agent session to tail.log before the in-memory tail is dropped: `hub text` can then show
   * what the program printed even when it was killed before writing any assistant output, or when the app itself quits.
   */
  private persistTail(meta: SessionMeta): void {
    if (!meta.claude) return;
    const out = this.liveOutputs.get(meta.id);
    if (!out || out.chunks.length === 0) return;
    const text = stripAnsi(Buffer.concat(out.chunks).toString('utf8')).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const kept = text.length > TAIL_LOG_BYTES ? text.slice(-TAIL_LOG_BYTES).replace(/^[^\n]*\n/, '') : text;
    this.store.writeTail(meta.id, kept);
  }

  /** Records the Claude session id from the newest transcript when none is known. Never overwrites. */
  private discover(meta: SessionMeta, emit = true): void {
    const claude = meta.claude;
    if (claude?.sessionId !== null || !claude) return;
    const taken = new Set([...this.sessions.values()].flatMap((other) => (other.claude?.sessionId ? [other.claude.sessionId] : [])));
    const since = Date.parse(meta.startedAt);
    const sessionId = claude.provider === 'opencode' ? discoverOpencodeSessionId(claude.configDir, meta.cwd, since, taken) : discoverSessionId(claude.configDir, meta.cwd, since, taken);
    if (sessionId === null) return;
    claude.sessionId = sessionId;
    claude.resumeCommand = renderCommand(fillTemplate(claude.argvTemplate, sessionId));
    clearInterval(this.discoveryTimers.get(meta.id));
    this.discoveryTimers.delete(meta.id);
    this.store.writeMeta(meta);
    if (emit) this.emitChanged(meta);
  }

  private emitChanged(meta: SessionMeta): void {
    this.emitter.emit('changed', this.info(meta));
  }

  // --- control -------------------------------------------------------------

  write(id: string, data: string): void {
    this.require(id);
    this.writeRaw(id, data);
  }

  private writeRaw(id: string, data: string): void {
    const child = this.live.get(id);
    if (!child) throw new HubError(409, 'session is not running');
    child.write(data);
    this.trackers.get(id)?.input();
  }

  /** Answers a prompt or types into the chat box. Returns the bytes written. */
  answer(id: string, request: AnswerRequest): string {
    this.require(id);
    const chunks = resolveAnswer(request);
    this.writeRaw(id, chunks[0] ?? '');
    chunks.slice(1).forEach((chunk, index) => {
      setTimeout(
        () => {
          try {
            this.writeRaw(id, chunk);
          } catch {
            // the session ended before the Enter was due
          }
        },
        ANSWER_CHUNK_GAP_MS * (index + 1),
      );
    });
    return chunks.join('');
  }

  /** A Claude Code Notification hook fired. Returns false when it maps to no running session. */
  hookNotify(notification: HookNotification): boolean {
    const candidates = [...this.sessions.values()].filter((meta) => this.live.has(meta.id));
    const meta =
      candidates.find((candidate) => candidate.id === notification.hubSessionId) ??
      candidates.find((candidate) => notification.sessionId !== undefined && candidate.claude?.sessionId === notification.sessionId);
    if (!meta) return false;
    // A Notification (or a caller that predates hookEvent) is a question for the person; every event also moves the turn state.
    if (notification.hookEvent === undefined || notification.hookEvent === 'Notification') this.trackers.get(meta.id)?.hook(notification.message);
    this.turns.get(meta.id)?.hook(notification.hookEvent ?? 'Notification', notification.message);
    return true;
  }

  attentionOf(id: string): AttentionInfo | null {
    return this.trackers.get(id)?.attention ?? null;
  }

  resize(id: string, cols: number, rows: number): void {
    const meta = this.sessions.get(id);
    const child = this.live.get(id);
    if (!meta || !child) return;
    meta.cols = clampDimension(cols, meta.cols);
    meta.rows = clampDimension(rows, meta.rows);
    child.resize(meta.cols, meta.rows);
  }

  private signal(id: string, signal: Signal): void {
    const child = this.live.get(id);
    if (!child) return;
    try {
      // The child leads its own process group; signal the whole group.
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  /** SIGTERM, then SIGKILL after 3 s. */
  stop(id: string, firstSignal: Signal = 'SIGTERM'): void {
    this.require(id);
    if (!this.live.has(id) || this.killTimers.has(id)) return;
    this.signal(id, firstSignal);
    this.killTimers.set(
      id,
      setTimeout(() => this.signal(id, 'SIGKILL'), STOP_GRACE_MS),
    );
  }

  setTitle(id: string, title: string): SessionInfo {
    const meta = this.require(id);
    const trimmed = title.trim();
    if (!trimmed) throw new HubError(400, 'title must not be empty');
    meta.title = trimmed.slice(0, 200);
    meta.titleSource = 'manual';
    this.store.writeMeta(meta);
    this.emitChanged(meta);
    return this.info(meta);
  }

  /** Releases a manual rename: the title stays until the program sets a new one. */
  releaseTitle(id: string): SessionInfo {
    const meta = this.require(id);
    meta.titleSource = 'auto';
    this.store.writeMeta(meta);
    this.emitChanged(meta);
    return this.info(meta);
  }

  setArchived(id: string, archived: boolean): SessionInfo {
    const meta = this.require(id);
    if (archived && this.live.has(id)) throw new HubError(400, 'cannot archive a running session; stop it first');
    meta.archived = archived;
    this.store.writeMeta(meta);
    this.emitChanged(meta);
    return this.info(meta);
  }

  private waitForExit(id: string, timeoutMs: number): Promise<void> {
    if (!this.live.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = this.onChanged((session) => {
        if (session.id === id && !session.running) done();
      });
      const timer = setTimeout(done, timeoutMs);
    });
  }

  async remove(id: string): Promise<void> {
    this.require(id);
    if (this.live.has(id)) {
      this.signal(id, 'SIGKILL');
      await this.waitForExit(id, 2000);
    }
    this.store.delete(id);
    this.sessions.delete(id);
    this.liveOutputs.delete(id);
    this.emitter.emit('removed', id);
  }

  /** Validates every id before deleting anything, then removes them together. */
  async removeMany(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    unique.forEach((id) => this.require(id));
    await Promise.all(unique.map((id) => this.remove(id)));
  }

  async removeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.remove(id);
  }

  /** Called on app quit: stops every live process, records the exits, keeps all files. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const ids = [...this.live.keys()];
    for (const id of ids) this.stop(id, 'SIGHUP');
    await Promise.all(ids.map((id) => this.waitForExit(id, STOP_GRACE_MS + 1500)));
    for (const id of this.sessions.keys()) this.store.close(id);
  }
}
