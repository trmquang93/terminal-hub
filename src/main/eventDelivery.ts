import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeliveryOutcome, DeliveryRecord, HubEvent, ListenerInfo, ListenerState } from '../shared/types';
import type { EventJournal } from './eventJournal';
import { listenerDir, redactListener, type StoredListener } from './listenerConfig';

export const BACKOFF_MS = [500, 1500, 4000, 10000, 30000] as const;
export const MAX_ATTEMPTS = 6;
export const MAX_QUEUE = 1000;
export const DELIVERIES_MAX_LINES = 2000;
export const DEFAULT_HTTP_TIMEOUT_MS = 5000;
const OUTPUT_CAP_BYTES = 64 * 1024;

export interface BridgeConfig {
  command: string[];
  timeoutMs: number;
}

export function bridgeConfigPath(dataDir: string): string {
  return join(dataDir, 'omb-bridge.json');
}

/** `<data dir>/omb-bridge.json` (optional): the only OpenMausBot-specific piece, and it lives on the OMB side. */
export function loadBridgeConfig(dataDir: string): BridgeConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(bridgeConfigPath(dataDir), 'utf8')) as Record<string, unknown>;
    const command = Array.isArray(parsed.command) ? parsed.command : null;
    if (!command || command.length === 0 || !command.every((item) => typeof item === 'string' && item !== '')) return null;
    const timeoutMs = typeof parsed.timeoutMs === 'number' && parsed.timeoutMs > 0 ? Math.min(Math.round(parsed.timeoutMs), 60000) : 5000;
    return { command: command as string[], timeoutMs };
  } catch {
    return null;
  }
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

/** Runs one argv with shell:false, one JSON line on stdin, SIGTERM then SIGKILL on timeout. Output capped at 64 KB. */
export function runCommand(
  argv: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  spawnImpl: typeof spawn = spawn,
  onStdoutLine?: (line: string) => void,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawnImpl(argv[0] as string, argv.slice(1), { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ code: null, signal: null, stdout, stderr, timedOut: false, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += chunk.toString('utf8').slice(0, OUTPUT_CAP_BYTES - stdout.length);
      if (onStdoutLine) {
        pending += chunk.toString('utf8');
        for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          onStdoutLine(line);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += chunk.toString('utf8').slice(0, OUTPUT_CAP_BYTES - stderr.length);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (onStdoutLine && pending !== '') onStdoutLine(pending);
      finish({ code, signal, stdout, stderr, timedOut, spawnError: null });
    });
    try {
      child.stdin?.end(input);
    } catch {
      // the child may have exited already
    }
  });
}

interface Attempt {
  ok: boolean;
  retryable: boolean;
  outcome: DeliveryOutcome;
  status: number | null;
  error: string | null;
}

function failure(outcome: DeliveryOutcome, error: string, retryable: boolean, status: number | null = null): Attempt {
  return { ok: false, retryable, outcome, status, error: error.slice(0, 300) };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return String(typeof code === 'string' ? code : error.message);
  }
  return 'unknown error';
}

export interface EventDeliveryOptions {
  dataDir: string;
  sessionsRoot: string;
  journal: EventJournal;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (level: 'INFO' | 'WARN', message: string) => void;
  /** Persists a listener state change (active/degraded) back to listeners.json. */
  onState?: (sessionId: string, listenerId: string, state: ListenerState, lastError: string | null) => void;
}

interface Runtime {
  sessionId: string;
  listener: StoredListener;
  queue: HubEvent[];
  pumping: boolean;
  consecutive: number;
  failed: number;
  pendingFailures: number;
  lastError: string | null;
  lastDeliveryAt: string | null;
  cursor: number;
  cwd: string;
}

function cursorPath(sessionDir: string, listenerId: string): string {
  return join(listenerDir(sessionDir, listenerId), 'cursor.json');
}

function deliveriesPath(sessionDir: string, listenerId: string): string {
  return join(listenerDir(sessionDir, listenerId), 'deliveries.jsonl');
}

function readCursor(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { lastSeq?: unknown };
    return typeof parsed.lastSeq === 'number' ? parsed.lastSeq : null;
  } catch {
    return null;
  }
}

function writeCursor(path: string, lastSeq: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastSeq }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    // a lost cursor only means a duplicate delivery, never a lost event
  }
}

/** Fans each event out to that session's matching listeners, each through its own ordered queue. Delivery never blocks the PTY loop. */
export class EventDispatcher {
  private readonly runtimes = new Map<string, Map<string, Runtime>>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: EventDeliveryOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  private sessionDir(sessionId: string): string {
    return join(this.options.sessionsRoot, sessionId);
  }

  /** Adds a listener's queue. The first attach starts at the journal high-water mark; a restart resumes from its cursor. */
  start(sessionId: string, listener: StoredListener, cwd: string, replay = true): void {
    let map = this.runtimes.get(sessionId);
    if (!map) {
      map = new Map();
      this.runtimes.set(sessionId, map);
    }
    if (map.has(listener.id)) return;
    const dir = this.sessionDir(sessionId);
    const stored = readCursor(cursorPath(dir, listener.id));
    // A listener added mid-session starts at the current high-water mark; only a stored cursor replays what it missed.
    const cursor = stored ?? this.options.journal.last(sessionId);
    const runtime: Runtime = {
      sessionId,
      listener,
      queue: [],
      pumping: false,
      consecutive: 0,
      failed: 0,
      pendingFailures: 0,
      lastError: null,
      lastDeliveryAt: null,
      cursor,
      cwd,
    };
    if (stored === null) writeCursor(cursorPath(dir, listener.id), cursor);
    map.set(listener.id, runtime);
    if (stored !== null && replay && listener.acknowledgedAt !== null) {
      for (const event of this.options.journal.read(sessionId, cursor, Number.MAX_SAFE_INTEGER).events) {
        if ((listener.events ?? []).includes(event.event)) this.enqueue(runtime, event);
      }
    }
  }

  stop(sessionId: string, listenerId: string): void {
    this.runtimes.get(sessionId)?.delete(listenerId);
  }

  stopSession(sessionId: string): void {
    this.runtimes.delete(sessionId);
  }

  /** One event for one session: written to the journal once, then fanned out to matching listeners. */
  dispatch(event: HubEvent): void {
    const map = this.runtimes.get(event.session.id);
    if (!map) return;
    for (const runtime of map.values()) {
      if (runtime.listener.state !== 'active' && runtime.listener.state !== 'degraded') continue;
      if (!(runtime.listener.events ?? []).includes(event.event)) continue;
      this.enqueue(runtime, event);
    }
  }

  /** Redacted listener list with live counters. */
  list(sessionId: string): ListenerInfo[] {
    const map = this.runtimes.get(sessionId);
    if (!map) return [];
    return [...map.values()].map((runtime) => ({
      ...redactListener({ ...runtime.listener, state: runtime.listener.state }),
      pending: runtime.queue.length,
      failed: runtime.failed,
      lastError: runtime.lastError,
      lastDeliveryAt: runtime.lastDeliveryAt,
    }));
  }

  /** Resolves when every queue is empty, or after `timeoutMs`. For tests and shutdown; nothing in production waits on it. */
  async drain(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.busy() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  busy(): boolean {
    for (const map of this.runtimes.values()) {
      for (const runtime of map.values()) if (runtime.pumping || runtime.queue.length > 0) return true;
    }
    return false;
  }

  private enqueue(runtime: Runtime, event: HubEvent): void {
    if (event.seq <= runtime.cursor) return;
    if (runtime.queue.length >= MAX_QUEUE) {
      runtime.failed++;
      runtime.pendingFailures++;
      runtime.lastError = 'delivery queue overflow';
      this.options.log?.('WARN', `listener ${runtime.listener.id} session=${runtime.sessionId.slice(0, 8)} queue overflow, event ${event.eventId} marked failed`);
      this.record(runtime, {
        deliveryId: randomUUID(),
        listenerId: runtime.listener.id,
        eventId: event.eventId,
        seq: event.seq,
        attempt: 0,
        startedAt: this.now().toISOString(),
        durationMs: 0,
        outcome: 'spawn_error',
        status: null,
        error: 'delivery queue overflow',
      });
      return;
    }
    runtime.queue.push(event);
    void this.pump(runtime);
  }

  private async pump(runtime: Runtime): Promise<void> {
    if (runtime.pumping) return;
    runtime.pumping = true;
    try {
      while (runtime.queue.length > 0) {
        const event = runtime.queue.shift() as HubEvent;
        await this.deliverOne(runtime, event);
      }
    } finally {
      runtime.pumping = false;
    }
  }

  private async deliverOne(runtime: Runtime, event: HubEvent): Promise<void> {
    const { listener } = runtime;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = this.now();
      const result = await this.attempt(runtime, event);
      const record: DeliveryRecord = {
        deliveryId: randomUUID(),
        listenerId: listener.id,
        eventId: event.eventId,
        seq: event.seq,
        attempt,
        startedAt: started.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        outcome: result.outcome,
        status: result.status,
        error: result.error,
      };
      this.record(runtime, record);
      if (result.ok) {
        runtime.consecutive = 0;
        runtime.lastDeliveryAt = this.now().toISOString();
        runtime.lastError = null;
        if (listener.state === 'degraded') this.setState(runtime, 'active', null);
        this.advance(runtime, event.seq);
        return;
      }
      runtime.lastError = result.error;
      if (!result.retryable || attempt >= MAX_ATTEMPTS) break;
      const wait = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1) ?? 0;
      this.options.log?.('WARN', `listener ${listener.id} attempt ${attempt}/${MAX_ATTEMPTS} ${result.outcome} (${result.error ?? ''}), retrying in ${wait} ms`);
      await this.sleep(wait);
    }
    runtime.failed++;
    runtime.consecutive++;
    if (runtime.consecutive >= 3 && listener.state !== 'degraded') this.setState(runtime, 'degraded', runtime.lastError);
    this.options.log?.('WARN', `listener ${listener.id} session=${runtime.sessionId.slice(0, 8)} failed event ${event.eventId} (${listener.kind}): ${runtime.lastError ?? 'unknown'}`);
    this.advance(runtime, event.seq);
  }

  private advance(runtime: Runtime, seq: number): void {
    runtime.cursor = seq;
    writeCursor(cursorPath(this.sessionDir(runtime.sessionId), runtime.listener.id), seq);
  }

  private setState(runtime: Runtime, state: ListenerState, lastError: string | null): void {
    runtime.listener = { ...runtime.listener, state };
    this.options.onState?.(runtime.sessionId, runtime.listener.id, state, lastError);
  }

  private record(runtime: Runtime, record: DeliveryRecord): void {
    try {
      const path = deliveriesPath(this.sessionDir(runtime.sessionId), runtime.listener.id);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      this.trimDeliveries(path);
    } catch {
      // the log is diagnostics; never break delivery over it
    }
  }

  private trimDeliveries(path: string): void {
    let lines: string[];
    try {
      lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
    } catch {
      return;
    }
    if (lines.length <= DELIVERIES_MAX_LINES) return;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${lines.slice(-DELIVERIES_MAX_LINES).join('\n')}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  private async attempt(runtime: Runtime, event: HubEvent): Promise<Attempt> {
    const { listener } = runtime;
    if (listener.kind === 'http') return this.attemptHttp(listener, event);
    if (listener.kind === 'command') return this.attemptCommand(runtime, event);
    return this.attemptOpenmausbot(listener, event);
  }

  private async attemptHttp(listener: StoredListener, event: HubEvent): Promise<Attempt> {
    const endpoint = listener.http;
    if (!endpoint) return failure('http_error', 'no http endpoint', false);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...endpoint.headers };
    if (endpoint.bearer) headers.Authorization = `Bearer ${endpoint.bearer}`;
    try {
      const response = await this.fetchImpl(endpoint.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        redirect: 'manual',
        signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      const status = response.status;
      if (status >= 200 && status < 300) return { ok: true, retryable: false, outcome: 'delivered', status, error: null };
      const retryable = status >= 500 || status === 429;
      return failure('http_error', `HTTP ${status}`, retryable, status);
    } catch (error) {
      const message = describeError(error);
      return failure(message === 'timeout' ? 'timeout' : 'http_error', message, true);
    }
  }

  private async attemptCommand(runtime: Runtime, event: HubEvent): Promise<Attempt> {
    const endpoint = runtime.listener.command;
    if (!endpoint) return failure('spawn_error', 'no command endpoint', false);
    const result = await runCommand(
      endpoint.argv,
      endpoint.cwd ?? runtime.cwd,
      `${JSON.stringify(event)}\n`,
      endpoint.timeoutMs ?? 5000,
      this.spawnImpl,
    );
    if (result.spawnError) return failure('spawn_error', result.spawnError, true);
    if (result.timedOut) return failure('timeout', 'timeout', true);
    if (result.code === 0) return { ok: true, retryable: false, outcome: 'delivered', status: null, error: null };
    return failure('nonzero_exit', `exit ${result.code ?? result.signal ?? '?'}`, true);
  }

  private async attemptOpenmausbot(listener: StoredListener, event: HubEvent): Promise<Attempt> {
    const endpoint = listener.openmausbot;
    if (!endpoint) return failure('bridge_error', 'no openmausbot endpoint', false);
    const bridge = loadBridgeConfig(this.options.dataDir);
    if (!bridge) return failure('bridge_error', 'no omb-bridge.json configured', false);
    const dir = join(this.options.dataDir, 'outbox', 'openmausbot', endpoint.botId, endpoint.threadId);
    const eventPath = join(dir, `${event.eventId}.json`);
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${eventPath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, eventPath);
    } catch (error) {
      return failure('bridge_error', `spool failed: ${describeError(error)}`, true);
    }
    const input = `${JSON.stringify({ botId: endpoint.botId, threadId: endpoint.threadId, eventPath })}\n`;
    const result = await runCommand(bridge.command, dir, input, bridge.timeoutMs, this.spawnImpl);
    if (result.spawnError) return failure('bridge_error', result.spawnError, true);
    if (result.timedOut) return failure('bridge_error', 'bridge timeout', true);
    if (result.code === 0) return { ok: true, retryable: false, outcome: 'delivered', status: null, error: null };
    return failure('bridge_error', `bridge exit ${result.code ?? result.signal ?? '?'}`, true);
  }
}

/** Reads one listener's attempt log, newest last. */
export function readDeliveries(sessionDir: string, listenerId: string, limit = 200): DeliveryRecord[] {
  let lines: string[];
  try {
    lines = readFileSync(deliveriesPath(sessionDir, listenerId), 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
  const kept = lines.slice(-Math.max(1, limit));
  const records: DeliveryRecord[] = [];
  for (const line of kept) {
    try {
      records.push(JSON.parse(line) as DeliveryRecord);
    } catch {
      // skip a torn line
    }
  }
  return records;
}

