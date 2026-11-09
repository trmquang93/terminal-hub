import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { DeliveryRecord, HandshakeInfo, HubEvent, ListenerInfo, ListenerRequest, SessionInfo, StartSessionOptions } from '../shared/types';
import type { spawn as spawnType } from 'node:child_process';
import type { NotifyEvent } from './notifyDelivery';
import { EventDispatcher, loadBridgeConfig, readDeliveries, runCommand, BACKOFF_MS, MAX_ATTEMPTS } from './eventDelivery';
import { EventJournal } from './eventJournal';
import { HubError } from './errors';
import { cleanupHandshakes, deleteHandshake, handshakeInfo, isExpired, newHandshake, readHandshake, tokenMatches, updateHandshake, type HandshakeRecord } from './handshake';
import { DEFAULT_EVENTS, readListeners, redactListener, removeListenerDir, validateListener, writeListeners, type StoredListener } from './listenerConfig';

export interface SessionListenersOptions {
  dataDir: string;
  sessionsRoot: string;
  startSession: (options: StartSessionOptions) => SessionInfo;
  getSession: (id: string) => SessionInfo | undefined;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawnType;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (level: 'INFO' | 'WARN', message: string) => void;
  /** The local API base URL, for the ack instruction in a test event. */
  apiBaseUrl?: () => string | null;
}

export interface CreateResult {
  status: 201 | 202;
  body: unknown;
}

interface Pending {
  record: HandshakeRecord;
  token: string;
  listener: ListenerRequest & { id: string };
  created: string;
  done: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

function listenerId(): string {
  return `lst_${randomBytes(4).toString('hex')}`;
}

function sessionDirOf(root: string, id: string): string {
  return join(root, id);
}

/**
 * Owns the per-session listeners: the mandatory create/listen handshake, redacted persistence,
 * the event journal and the delivery dispatcher. Every event is delivered only to listeners
 * registered on that session; no listener means no event.
 */
export class SessionListeners {
  private readonly journal: EventJournal;
  private readonly dispatcher: EventDispatcher;
  private readonly pending = new Map<string, Pending>();
  private readonly ended = new Set<string>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SessionListenersOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.journal = new EventJournal(options.sessionsRoot);
    this.dispatcher = new EventDispatcher({
      dataDir: options.dataDir,
      sessionsRoot: options.sessionsRoot,
      journal: this.journal,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.log ? { log: options.log } : {}),
      onState: (sessionId, id, state, lastError) => this.updateState(sessionId, id, state, lastError),
    });
    cleanupHandshakes(options.dataDir);
    this.resumeAll();
  }

  // --- listeners on disk ---------------------------------------------------

  private sessionDir(sessionId: string): string {
    return sessionDirOf(this.options.sessionsRoot, sessionId);
  }

  /** Reloads every stored listener after an app restart and resumes its queue from the cursor. */
  resumeAll(): void {
    let names: string[];
    try {
      names = readdirSync(this.options.sessionsRoot);
    } catch {
      return;
    }
    for (const name of names) {
      const stored = readListeners(sessionDirOf(this.options.sessionsRoot, name));
      if (stored.length === 0) continue;
      const session = this.options.getSession(name);
      for (const listener of stored) {
        if (listener.state === 'disabled') continue;
        this.dispatcher.start(name, listener, session?.cwd ?? this.sessionDir(name), true);
      }
    }
  }

  private storedListeners(sessionId: string): StoredListener[] {
    return readListeners(this.sessionDir(sessionId));
  }

  private updateState(sessionId: string, listenerIdToUpdate: string, state: StoredListener['state'], lastError: string | null): void {
    const listeners = this.storedListeners(sessionId);
    const index = listeners.findIndex((item) => item.id === listenerIdToUpdate);
    if (index < 0) return;
    const current = listeners[index] as StoredListener;
    listeners[index] = { ...current, state };
    try {
      writeListeners(this.sessionDir(sessionId), listeners);
    } catch {
      // state persistence is best effort; the in-memory state still drives delivery
    }
    void lastError;
  }

  /** Redacted list with delivery counters. */
  list(sessionId: string): ListenerInfo[] {
    const live = new Map(this.dispatcher.list(sessionId).map((item) => [item.id, item]));
    return this.storedListeners(sessionId).map((stored) => live.get(stored.id) ?? { ...redactListener(stored), pending: 0, failed: 0, lastError: null, lastDeliveryAt: null });
  }

  remove(sessionId: string, listenerIdToRemove: string): void {
    const listeners = this.storedListeners(sessionId);
    if (!listeners.some((item) => item.id === listenerIdToRemove)) throw new HubError(404, `no such listener: ${listenerIdToRemove}`);
    this.dispatcher.stop(sessionId, listenerIdToRemove);
    removeListenerDir(this.sessionDir(sessionId), listenerIdToRemove);
    writeListeners(this.sessionDir(sessionId), listeners.filter((item) => item.id !== listenerIdToRemove));
  }

  /** Clears a degraded listener's state and resumes its queue. */
  resumeListener(sessionId: string, listenerIdToResume: string): ListenerInfo {
    const session = this.options.getSession(sessionId);
    if (!session) throw new HubError(404, `no such session: ${sessionId}`);
    const listeners = this.storedListeners(sessionId);
    const index = listeners.findIndex((item) => item.id === listenerIdToResume);
    if (index < 0) throw new HubError(404, `no such listener: ${listenerIdToResume}`);
    const resumed: StoredListener = { ...(listeners[index] as StoredListener), state: 'active' };
    listeners[index] = resumed;
    writeListeners(this.sessionDir(sessionId), listeners);
    this.dispatcher.stop(sessionId, listenerIdToResume);
    this.dispatcher.start(sessionId, resumed, session.cwd, true);
    return this.list(sessionId).find((item) => item.id === listenerIdToResume) ?? redactListener(resumed);
  }

  deliveries(sessionId: string, listenerIdToRead?: string): DeliveryRecord[] {
    const id = listenerIdToRead ?? this.storedListeners(sessionId)[0]?.id;
    return id === undefined ? [] : readDeliveries(this.sessionDir(sessionId), id);
  }

  events(sessionId: string, since = 0, limit?: number): { events: HubEvent[]; next: number } {
    if (!this.options.getSession(sessionId)) throw new HubError(404, `no such session: ${sessionId}`);
    return this.journal.read(sessionId, since, limit);
  }

  // --- event production ----------------------------------------------------

  /** Fans one notifier event out to this session's listeners, after one journal append. Never throws. */
  publish(event: NotifyEvent, session: SessionInfo): void {
    try {
      const base = {
        event: event.event,
        session: { id: session.id, title: session.title, cwd: session.cwd, command: session.command, state: session.state, exitCode: session.exitCode },
      };
      const payload: Omit<HubEvent, 'seq' | 'eventId' | 'at'> =
        event.event === 'turn'
          ? { ...base, turn: { state: event.turn, since: event.since } }
          : { ...base, attention: { reason: event.session.reason, promptText: event.session.promptText, source: event.session.source, since: event.session.since } };
      const stored = this.journal.append(session.id, payload);
      if (stored) this.dispatcher.dispatch(stored);
    } catch (error) {
      this.options.log?.('WARN', `could not journal event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Emits `exit` once per ended session. */
  publishExit(session: SessionInfo): void {
    if (session.running || session.endedAt === null) return;
    const key = `${session.id}:${session.endedAt}`;
    if (this.ended.has(key)) return;
    this.ended.add(key);
    try {
      const stored = this.journal.append(session.id, {
        event: 'exit',
        session: { id: session.id, title: session.title, cwd: session.cwd, command: session.command, state: session.state, exitCode: session.exitCode },
        exit: { exitCode: session.exitCode, signal: session.signal, cause: session.exitCause ?? null },
      });
      if (stored) this.dispatcher.dispatch(stored);
    } catch {
      // journal is best effort here; the session still ends
    }
  }

  forget(sessionId: string): void {
    this.dispatcher.stopSession(sessionId);
    this.journal.forget(sessionId);
  }

  drain(timeoutMs = 10000): Promise<void> {
    return this.dispatcher.drain(timeoutMs);
  }

  // --- create / listen handshakes -----------------------------------------

  private validateRequests(raw: unknown): (ListenerRequest & { id: string })[] {
    if (!Array.isArray(raw) || raw.length === 0) throw new HubError(400, 'listeners is required and must not be empty');
    const requests = raw.map((item) => validateListener(item));
    for (const request of requests) {
      if (request.kind === 'openmausbot' && !loadBridgeConfig(this.options.dataDir)) {
        throw new HubError(400, 'an openmausbot listener needs a bridge: write {"command":[...],"timeoutMs":5000} to omb-bridge.json in the data dir');
      }
    }
    return requests.map((request) => ({ ...request, id: listenerId() }));
  }

  /** POST /sessions and `hub run`: validates, handshakes every listener in parallel, then creates. */
  async create(options: StartSessionOptions & { wait?: boolean }, rawListeners: unknown): Promise<CreateResult> {
    const listeners = this.validateRequests(rawListeners);
    const sessionRequest = { cwd: options.cwd, command: options.command, ...(options.title === undefined ? {} : { title: options.title }) };
    const pending = listeners.map((listener) => this.begin(listener, sessionRequest));
    if (options.wait === false) {
      void this.settleAndCreate(pending, options).catch((error: unknown) => {
        this.options.log?.('WARN', `fast create failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      const expiresAt = pending.map((item) => item.record.expiresAt).sort().at(-1) ?? this.now().toISOString();
      return { status: 202, body: { handshakeId: pending[0]?.record.id ?? null, handshakeIds: pending.map((item) => item.record.id), expiresAt, state: 'pending' } };
    }
    const session = await this.settleAndCreate(pending, options);
    return { status: 201, body: { id: session.id, listeners: pending.map((item) => ({ id: item.listener.id, handshakeId: item.record.id })) } };
  }

  /** POST /sessions/:id/listeners and `hub listen`: the listener is appended only after it acks. */
  async addListener(sessionId: string, rawListener: unknown, wait = true): Promise<CreateResult> {
    const session = this.options.getSession(sessionId);
    if (!session) throw new HubError(404, `no such session: ${sessionId}`);
    const listeners = this.validateRequests([rawListener]);
    const pending = this.begin(listeners[0] as ListenerRequest & { id: string }, null, sessionId);
    if (!wait) {
      void this.settleAndAppend([pending], sessionId).catch((error: unknown) => {
        this.options.log?.('WARN', `fast listen failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { status: 202, body: { handshakeId: pending.record.id, expiresAt: pending.record.expiresAt, state: 'pending' } };
    }
    await this.awaitAcks([pending]);
    this.appendActive(session, [pending]);
    return { status: 201, body: { listeners: [{ id: pending.listener.id, handshakeId: pending.record.id }] } };
  }

  private appendActive(session: SessionInfo, pending: Pending[]): void {
    const stored = this.storedListeners(session.id);
    for (const item of pending) {
      const listener: StoredListener = { ...item.listener, state: 'active', createdAt: item.created, acknowledgedAt: this.now().toISOString() };
      stored.push(listener);
      this.dispatcher.start(session.id, listener, session.cwd, true);
      this.markCreated(item, session.id);
    }
    writeListeners(this.sessionDir(session.id), stored);
  }

  private async settleAndCreate(pending: Pending[], options: StartSessionOptions & { wait?: boolean }): Promise<SessionInfo> {
    await this.awaitAcks(pending);
    let session: SessionInfo;
    try {
      const { wait: _wait, listeners: _listeners, ...startOptions } = options;
      void _wait;
      void _listeners;
      session = this.options.startSession(startOptions);
    } catch (error) {
      this.cancelAll(pending);
      throw error;
    }
    const stored: StoredListener[] = [];
    for (const item of pending) {
      const listener: StoredListener = { ...item.listener, state: 'active', createdAt: item.created, acknowledgedAt: this.now().toISOString() };
      stored.push(listener);
      this.markCreated(item, session.id);
    }
    writeListeners(this.sessionDir(session.id), stored);
    for (const listener of stored) this.dispatcher.start(session.id, listener, session.cwd, false);
    return session;
  }

  private async settleAndAppend(pending: Pending[], sessionId: string): Promise<void> {
    await this.awaitAcks(pending);
    const session = this.options.getSession(sessionId);
    if (!session) {
      this.cancelAll(pending);
      throw new HubError(404, `no such session: ${sessionId}`);
    }
    this.appendActive(session, pending);
  }

  /** Waits for every ack under one deadline; any expiry or failure cancels the whole request. */
  private async awaitAcks(pending: Pending[]): Promise<void> {
    try {
      await Promise.all(pending.map((item) => item.done));
    } catch (error) {
      const handshakes = pending.map((item) => handshakeInfo(readHandshake(this.options.dataDir, item.record.id) ?? item.record));
      this.cancelAll(pending);
      if (error instanceof HubError && error.status === 504) throw new HubError(504, error.message, { handshakes });
      throw new HubError(504, 'listener did not acknowledge', { handshakes });
    }
  }

  private begin(listener: ListenerRequest & { id: string }, sessionRequest: HandshakeRecord['sessionRequest'], sessionId?: string): Pending {
    const { record, token } = newHandshake(this.options.dataDir, listener, sessionRequest, this.now());
    let resolve: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const item: Pending = { record, token, listener, created: record.createdAt, done, resolve, reject, timer: null };
    this.pending.set(record.id, item);
    item.timer = setTimeout(() => this.expire(item, 'expired', 'listener did not acknowledge'), record.ackTimeoutSec * 1000);
    void this.sendTest(item, sessionId).catch((error: unknown) => {
      this.expire(item, 'failed', `test event could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
    });
    return item;
  }

  private expire(item: Pending, state: 'expired' | 'failed', message: string): void {
    if (readHandshake(this.options.dataDir, item.record.id)?.state !== 'pending') return;
    if (item.timer) clearTimeout(item.timer);
    item.timer = null;
    updateHandshake(this.options.dataDir, item.record.id, { state });
    item.reject(new HubError(504, message));
  }

  private settle(handshakeId: string): void {
    const item = this.pending.get(handshakeId);
    if (!item) return;
    if (item.timer) clearTimeout(item.timer);
    item.timer = null;
    updateHandshake(this.options.dataDir, handshakeId, { state: 'acked' });
    item.record = { ...item.record, state: 'acked' };
    item.resolve();
  }

  private markCreated(item: Pending, sessionId: string): void {
    updateHandshake(this.options.dataDir, item.record.id, { state: 'created', sessionId });
    item.record = { ...item.record, state: 'created', sessionId };
    this.pending.delete(item.record.id);
    // The record is kept for GET /handshakes/:id (a wait:false caller polls it); cleanup deletes it after an hour.
  }

  private cancelAll(pending: Pending[]): void {
    for (const item of pending) {
      if (item.timer) clearTimeout(item.timer);
      item.timer = null;
      const record = readHandshake(this.options.dataDir, item.record.id);
      if (record && record.state !== 'created') {
        updateHandshake(this.options.dataDir, item.record.id, { state: 'cancelled' });
        deleteHandshake(this.options.dataDir, item.record.id);
      }
      this.pending.delete(item.record.id);
      item.reject(new HubError(504, 'handshake cancelled'));
    }
  }

  /** Acknowledge one handshake. The token is the only credential; single use, constant-time, 410 after expiry. */
  ack(handshakeId: string, token: string): HandshakeInfo {
    const item = this.pending.get(handshakeId);
    const record = item?.record ?? readHandshake(this.options.dataDir, handshakeId);
    if (!record) throw new HubError(404, `no such handshake: ${handshakeId}`);
    if (record.state === 'acked' || record.state === 'created') throw new HubError(410, 'handshake token already used');
    if (record.state === 'expired' || record.state === 'failed' || record.state === 'cancelled') throw new HubError(410, `handshake is ${record.state}`);
    if (isExpired(record, this.now())) {
      updateHandshake(this.options.dataDir, handshakeId, { state: 'expired' });
      throw new HubError(410, 'handshake expired');
    }
    if (!tokenMatches(record.tokenHash, token)) throw new HubError(401, 'invalid handshake token');
    if (item) this.settle(handshakeId);
    else updateHandshake(this.options.dataDir, handshakeId, { state: 'acked' });
    return handshakeInfo(readHandshake(this.options.dataDir, handshakeId) ?? record);
  }

  handshake(handshakeId: string): HandshakeInfo {
    const record = this.pending.get(handshakeId)?.record ?? readHandshake(this.options.dataDir, handshakeId);
    if (!record) throw new HubError(404, `no such handshake: ${handshakeId}`);
    return handshakeInfo(record);
  }

  // --- test event ----------------------------------------------------------

  private testPayload(item: Pending, sessionId?: string): Record<string, unknown> {
    const baseUrl = this.options.apiBaseUrl?.() ?? 'http://127.0.0.1:PORT';
    return {
      event: 'handshake',
      handshakeId: item.record.id,
      token: item.token,
      expiresAt: item.record.expiresAt,
      instructions: {
        cli: `hub ack ${item.record.id} ${item.token}`,
        http: `POST ${baseUrl}/handshakes/${item.record.id}/ack {"token":"${item.token}"}`,
      },
      listener: { kind: item.listener.kind, events: item.listener.events ?? DEFAULT_EVENTS },
      sessionRequest: sessionId === undefined ? item.record.sessionRequest : { sessionId },
      testEvent: true,
    };
  }

  /** Sends the test event with retries up to the ack deadline. Delivering it is not the ack. */
  private async sendTest(item: Pending, sessionId?: string): Promise<void> {
    const payload = JSON.stringify(this.testPayload(item, sessionId));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (!this.isPending(item)) return;
      const outcome = await this.sendTestOnce(item, payload, sessionId);
      if (outcome.ok || !outcome.retryable) {
        if (!outcome.ok) throw new Error(outcome.error ?? 'test event failed');
        return;
      }
      const wait = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1) ?? 0;
      await this.sleep(Math.min(wait, Math.max(0, Date.parse(item.record.expiresAt) - this.now().getTime())));
      if (!this.isPending(item)) return;
    }
    throw new Error('every attempt to deliver the test event failed');
  }

  private isPending(item: Pending): boolean {
    return readHandshake(this.options.dataDir, item.record.id)?.state === 'pending';
  }

  private async sendTestOnce(item: Pending, payload: string, sessionId?: string): Promise<{ ok: boolean; retryable: boolean; error?: string }> {
    const { listener } = item;
    if (listener.kind === 'http' && listener.http) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...listener.http.headers };
      if (listener.http.bearer) headers.Authorization = `Bearer ${listener.http.bearer}`;
      try {
        const response = await (this.options.fetchImpl ?? fetch)(listener.http.url, { method: 'POST', headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(5000) });
        await response.body?.cancel().catch(() => undefined);
        const ok = response.status >= 200 && response.status < 300;
        return { ok, retryable: !ok && (response.status >= 500 || response.status === 429), error: ok ? undefined : `HTTP ${response.status}` };
      } catch (error) {
        return { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (listener.kind === 'command' && listener.command) {
      let acked = false;
      const result = await runCommand(listener.command.argv, listener.command.cwd ?? (sessionId === undefined ? item.record.sessionRequest?.cwd : this.options.getSession(sessionId)?.cwd) ?? process.cwd(), `${payload}\n`, listener.command.timeoutMs ?? 5000, this.options.spawnImpl, (line) => {
        if (acked) return;
        try {
          const parsed = JSON.parse(line) as { ack?: unknown };
          if (parsed.ack === item.token) {
            acked = true;
            this.ack(item.record.id, item.token);
          }
        } catch {
          // not the ack line
        }
      });
      if (acked) return { ok: true, retryable: false };
      if (result.spawnError) return { ok: false, retryable: true, error: result.spawnError };
      if (result.timedOut) return { ok: false, retryable: true, error: 'timeout' };
      if (result.code === 0) return { ok: true, retryable: false };
      return { ok: false, retryable: true, error: `exit ${result.code ?? result.signal ?? '?'}` };
    }
    if (listener.kind === 'openmausbot' && listener.openmausbot) {
      const bridge = loadBridgeConfig(this.options.dataDir);
      if (!bridge) return { ok: false, retryable: false, error: 'no omb-bridge.json configured' };
      const dir = join(this.options.dataDir, 'outbox', 'openmausbot', listener.openmausbot.botId, listener.openmausbot.threadId);
      const eventPath = join(dir, `${item.record.id}.json`);
      try {
        mkdirSync(dir, { recursive: true });
        const tmp = `${eventPath}.tmp`;
        writeFileSync(tmp, `${payload}\n`, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, eventPath);
      } catch (error) {
        return { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
      }
      const result = await runCommand(bridge.command, dir, `${JSON.stringify({ botId: listener.openmausbot.botId, threadId: listener.openmausbot.threadId, eventPath })}\n`, bridge.timeoutMs, this.options.spawnImpl);
      if (result.spawnError) return { ok: false, retryable: true, error: result.spawnError };
      if (result.timedOut) return { ok: false, retryable: true, error: 'bridge timeout' };
      return result.code === 0 ? { ok: true, retryable: false } : { ok: false, retryable: true, error: `bridge exit ${result.code ?? result.signal ?? '?'}` };
    }
    return { ok: false, retryable: false, error: 'listener has no usable endpoint' };
  }
}
