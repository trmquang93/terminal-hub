import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import * as pty from 'node-pty';
import type { AnswerRequest, AttentionInfo, OutputSlice, SessionInfo, SessionMeta, StartSessionOptions } from '../shared/types';
import { AttentionTracker, resolveAnswer, SAFE_UNATTENDED_POLICY } from './attention';
import { discoverSessionId, fillTemplate, planClaudeLaunch, renderCommand, SESSION_PLACEHOLDER, transcriptExists } from './claude';
import { HubError } from './errors';
import { discoverOpencodeSessionId, opencodeSessionExists, planOpencodeLaunch } from './opencode';
import type { OutputChunk, SessionService } from './service';
import type { SessionStore } from './sessionStore';

const STOP_GRACE_MS = 3000;
const ANSWER_CHUNK_GAP_MS = 150;
const DISCOVERY_INTERVAL_MS = 2000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

type Signal = 'SIGHUP' | 'SIGTERM' | 'SIGKILL';

interface Events {
  output: [OutputChunk];
  changed: [SessionInfo];
  attention: [SessionInfo];
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

function clampDimension(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 1000 ? (value as number) : fallback;
}

export interface ManagerOptions {
  baseEnv?: () => NodeJS.ProcessEnv;
  attention?: { idleMs?: number; quietMs?: number };
}

export interface HookNotification {
  hubSessionId?: string;
  sessionId?: string;
  message: string;
}

export class SessionManager implements SessionService {
  private readonly emitter = new Emitter();
  private readonly sessions = new Map<string, SessionMeta>();
  private readonly live = new Map<string, pty.IPty>();
  private readonly killTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly discoveryTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly trackers = new Map<string, AttentionTracker>();
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
    return { ...meta, running, resumable, attention: this.trackers.get(meta.id)?.attention ?? null };
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

  size(id: string): number {
    this.require(id);
    return this.store.size(id);
  }

  readChunks(id: string, start: number, end: number): AsyncGenerator<Buffer> {
    this.require(id);
    return this.store.readChunks(id, start, end);
  }

  readOutput(id: string, offset: number, limit: number): Promise<Buffer> {
    this.require(id);
    return this.store.readOutput(id, offset, limit);
  }

  /** The last `tailBytes` of output.log, for rendering. The file keeps everything. */
  async readTail(id: string, tailBytes: number): Promise<OutputSlice> {
    const total = this.size(id);
    const start = Math.max(0, total - tailBytes);
    const data = await this.store.readOutput(id, start, total - start);
    return { data, start, total };
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

  onRemoved(listener: (id: string) => void): () => void {
    this.emitter.on('removed', listener);
    return () => this.emitter.off('removed', listener);
  }

  // --- lifecycle -----------------------------------------------------------

  start(options: StartSessionOptions): SessionInfo {
    const args = options.args ?? [];
    const env = options.env ?? {};
    const plan = planClaudeLaunch(options.command, args, env, this.baseEnv()) ?? planOpencodeLaunch(options.command, args, env, this.baseEnv());
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
    return this.info(meta);
  }

  /** Relaunches a finished session in place: `--resume <uuid>` for Claude Code, `--session <id>` for opencode, the original command otherwise. */
  resume(id: string): SessionInfo {
    const meta = this.require(id);
    if (this.live.has(id)) throw new HubError(409, 'session is already running');
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
        const template = transcriptExists(configDir, meta.cwd, sessionId) ? argvTemplate : argvTemplate.flatMap((token, i) => (token === '--resume' && argvTemplate[i + 1] === SESSION_PLACEHOLDER ? ['--session-id'] : [token]));
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
    return this.info(meta);
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
    const endOffset = this.store.appendOutput(meta.id, data);
    meta.bytesWritten = endOffset;
    this.emitter.emit('output', { id: meta.id, endOffset, data });
    this.trackers.get(meta.id)?.output(data);
  }

  private emitAttention(meta: SessionMeta): void {
    const info = this.info(meta);
    this.emitter.emit('changed', info);
    this.emitter.emit('attention', info);
  }

  private autoAnswer(meta: SessionMeta, keys: string, rule: string, promptText: string): void {
    this.store.appendAnswerLog(meta.id, { at: new Date().toISOString(), rule, keys, promptText });
    this.writeRaw(meta.id, keys);
  }

  private handleExit(meta: SessionMeta, child: pty.IPty, exitCode: number, signal: number | null): void {
    if (this.live.get(meta.id) !== child) return;
    this.live.delete(meta.id);
    clearTimeout(this.killTimers.get(meta.id));
    this.killTimers.delete(meta.id);
    clearInterval(this.discoveryTimers.get(meta.id));
    this.discoveryTimers.delete(meta.id);
    this.trackers.get(meta.id)?.stop();
    this.trackers.delete(meta.id);
    this.store.close(meta.id);
    Object.assign(meta, {
      state: this.shuttingDown ? 'interrupted' : 'exited',
      endedAt: new Date().toISOString(),
      exitCode,
      signal: signal || null,
      bytesWritten: this.store.size(meta.id),
    });
    this.discover(meta, false);
    this.store.writeMeta(meta);
    this.emitChanged(meta);
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
    this.store.appendInput(id, Buffer.from(data));
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
    this.trackers.get(meta.id)?.hook(notification.message);
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
