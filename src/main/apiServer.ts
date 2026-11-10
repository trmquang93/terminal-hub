import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AnswerRequest, AutoAnswerPolicy, SessionInfo, StartSessionOptions } from '../shared/types';
import { AnsiStripper } from './ansi';
import { HubError } from './errors';
import type { OutputChunk, SessionService } from './service';
import type { SessionListeners } from './sessionListeners';

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_ROUTE = /^\/sessions\/([^/]+)(?:\/([a-z]+))?$/;
const LISTENERS_ROUTE = /^\/sessions\/([^/]+)\/listeners(?:\/([^/]+))?(?:\/(resume))?$/;
const EVENTS_ROUTE = /^\/sessions\/([^/]+)\/events$/;
const DELIVERIES_ROUTE = /^\/sessions\/([^/]+)\/deliveries$/;
const HANDSHAKE_ROUTE = /^\/handshakes\/([^/]+)(\/ack)?$/;

export interface ApiOptions {
  service: SessionService;
  token: string;
  version: string;
  startedAt: string;
  /** Per-session listeners and their handshakes. Without it POST /sessions can still create a session with no listeners. */
  listeners?: SessionListeners;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isAuthorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  return match?.[1] !== undefined && timingSafeEqual(digest(match[1]), digest(token));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HubError(400, 'request body too large');
    parts.push(chunk);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new HubError(400, 'body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HubError(400, 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function optionalInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) throw new HubError(400, `${name} must be an integer between 1 and 1000`);
  return value;
}

function requiredInt(value: unknown, name: string): number {
  if (value === undefined) throw new HubError(400, `${name} is required`);
  return optionalInt(value, name) as number;
}

function parseStartOptions(body: Record<string, unknown>): StartSessionOptions {
  const { cwd, command, args, title, env } = body;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new HubError(400, 'cwd must be an absolute path string');
  if (typeof command !== 'string' || command === '') throw new HubError(400, 'command must be a non-empty string');
  if (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))) throw new HubError(400, 'args must be an array of strings');
  if (title !== undefined && typeof title !== 'string') throw new HubError(400, 'title must be a string');
  if (env !== undefined && (typeof env !== 'object' || env === null || !Object.values(env).every((value) => typeof value === 'string'))) {
    throw new HubError(400, 'env must be an object of strings');
  }
  const unattended = body.unattended;
  if (unattended !== undefined && typeof unattended !== 'boolean') throw new HubError(400, 'unattended must be a boolean');
  if (body.force !== undefined && typeof body.force !== 'boolean') throw new HubError(400, 'force must be a boolean');
  return {
    cwd,
    command,
    unattended,
    force: body.force,
    autoAnswer: parseAutoAnswer(body.autoAnswer as Partial<AutoAnswerPolicy> | null | undefined),
    args,
    title,
    env: env as Record<string, string> | undefined,
    cols: optionalInt(body.cols, 'cols'),
    rows: optionalInt(body.rows, 'rows'),
  };
}

function isRule(rule: unknown): rule is AutoAnswerPolicy['rules'][number] {
  const candidate = rule as Partial<AutoAnswerPolicy['rules'][number]> | null;
  return typeof candidate?.match === 'string' && candidate.match !== '' && typeof candidate.keys === 'string' && candidate.keys !== '';
}

function parseAutoAnswer(policy: Partial<AutoAnswerPolicy> | null | undefined): AutoAnswerPolicy | undefined {
  if (policy === undefined) return undefined;
  if (typeof policy?.enabled === 'boolean' && Array.isArray(policy.rules) && policy.rules.every(isRule) && typeof policy.timeoutSec === 'number' && policy.timeoutSec >= 0) {
    return { enabled: policy.enabled, rules: policy.rules, timeoutSec: policy.timeoutSec };
  }
  throw new HubError(400, 'autoAnswer must be { enabled: boolean, rules: [{ match, keys }], timeoutSec: number >= 0 }');
}

function resolveSession(service: SessionService, id: string): string {
  const session = service.get(id);
  if (!session) throw new HubError(404, `no such session: ${id}`);
  return session.id;
}

function numberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new HubError(400, `${name} must be a non-negative integer`);
  return value;
}

/** Loopback-only HTTP API. Call listen() on the returned server. */
export function createApiServer(options: ApiOptions): Server {
  const { service, token } = options;

  async function streamText(res: ServerResponse, id: string, url: URL): Promise<void> {
    service.size(id);
    const stripper = new AnsiStripper();
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event: string | null, payload: unknown): void => {
      res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`);
    };

    // Subscribe before replaying so no live bytes are missed; offsets dedupe the overlap.
    let sent = numberParam(url, 'offset', 0);
    let replaying = true;
    const queue: ({ kind: 'output'; chunk: OutputChunk } | { kind: 'exit' })[] = [];
    let finish: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => (finish = resolve));

    let ended = false;
    const deliver = (item: (typeof queue)[number]): void => {
      if (ended) return;
      if (item.kind === 'exit') {
        ended = true;
        const info = service.get(id);
        send('exit', { exitCode: info?.exitCode ?? null, signal: info?.signal ?? null, state: info?.state ?? null });
        finish();
        return;
      }
      const start = item.chunk.endOffset - item.chunk.data.length;
      if (item.chunk.endOffset <= sent) return;
      const fresh = item.chunk.data.subarray(Math.max(0, sent - start));
      sent = item.chunk.endOffset;
      const text = stripper.push(fresh);
      if (text) send(null, { text });
    };
    const handle = (item: (typeof queue)[number]): void => (replaying ? void queue.push(item) : deliver(item));

    const offOutput = service.onOutput((chunk) => chunk.id === id && handle({ kind: 'output', chunk }));
    const offChanged = service.onChanged((info) => info.id === id && !info.running && handle({ kind: 'exit' }));
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    res.on('close', finish);

    try {
      const end = service.size(id);
      for await (const data of service.readChunks(id, sent, end)) {
        sent += data.length;
        const text = stripper.push(data);
        if (text) send(null, { text });
      }
      replaying = false;
      for (const item of queue.splice(0)) deliver(item);
      if (!service.get(id)?.running) deliver({ kind: 'exit' });
      await closed;
    } finally {
      clearInterval(heartbeat);
      offOutput();
      offChanged();
      res.end();
    }
  }

  /** SSE of attention changes, turn changes and exits for every session. Sessions already needing attention or in a turn state are sent first. */
  function streamEvents(res: ServerResponse): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const summary = (session: SessionInfo): unknown => ({ id: session.id, title: session.title, running: session.running, state: session.state, attention: session.attention, turn: session.turn });
    const send = (event: string, payload: unknown): void => void res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const session of service.list()) {
      if (session.attention) send('attention', summary(session));
      if (session.turn) send('turn', summary(session));
    }
    const offAttention = service.onAttention((session) => send('attention', summary(session)));
    const offTurn = service.onTurn((session) => send('turn', summary(session)));
    const offChanged = service.onChanged((session) => {
      if (!session.running) send('exit', { ...(summary(session) as object), exitCode: session.exitCode, signal: session.signal });
    });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    return new Promise((resolve) => {
      res.on('close', () => {
        clearInterval(heartbeat);
        offAttention();
        offTurn();
        offChanged();
        resolve();
      });
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (url.pathname === '/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, version: options.version, startedAt: options.startedAt, pid: process.pid });
      return;
    }
    // The one route exempt from the API bearer: the one-time handshake token is the credential. Still loopback-only.
    const handshake = HANDSHAKE_ROUTE.exec(url.pathname);
    if (handshake && handshake[2] === '/ack' && method === 'POST') {
      const { token: ackToken } = await readJson(req);
      if (typeof ackToken !== 'string') throw new HubError(400, 'token must be a string');
      if (!options.listeners) throw new HubError(404, `no such handshake: ${handshake[1] ?? ''}`);
      return sendJson(res, 200, options.listeners.ack(handshake[1] as string, ackToken));
    }

    if (!isAuthorized(req.headers.authorization, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, { error: 'missing or invalid bearer token' });
      return;
    }

    if (url.pathname === '/events' && method === 'GET') return streamEvents(res);
    if (url.pathname === '/hooks/claude' && method === 'POST') {
      const body = await readJson(req);
      const text = (key: string): string | undefined => (typeof body[key] === 'string' ? (body[key]) : undefined);
      const matched = service.hookNotify({ hubSessionId: text('hubSessionId'), sessionId: text('sessionId'), message: text('message') ?? '', hookEvent: text('hookEvent') });
      return sendJson(res, 200, { ok: true, matched });
    }

    if (url.pathname === '/sessions/delete' && method === 'POST') {
      const { ids } = await readJson(req);
      if (!Array.isArray(ids) || !ids.every((item) => typeof item === 'string')) throw new HubError(400, 'ids must be an array of strings');
      await service.removeMany(ids);
      return sendJson(res, 200, { ok: true, deleted: new Set(ids).size });
    }

    if (url.pathname === '/sessions/delete-all' && method === 'POST') {
      const deleted = service.list().length;
      await service.removeAll();
      return sendJson(res, 200, { ok: true, deleted });
    }

    if (handshake && handshake[2] === undefined && method === 'GET') {
      if (!options.listeners) throw new HubError(404, `no such handshake: ${handshake[1] ?? ''}`);
      return sendJson(res, 200, options.listeners.handshake(handshake[1] as string));
    }

    if (url.pathname === '/sessions') {
      if (method === 'GET') return sendJson(res, 200, url.searchParams.get('attention') === '1' ? service.list().filter((item) => item.attention !== null) : service.list());
      if (method === 'POST') {
        const body = await readJson(req);
        const start = parseStartOptions(body);
        if (body.wait !== undefined && typeof body.wait !== 'boolean') throw new HubError(400, 'wait must be a boolean');
        if (body.listeners !== undefined && !Array.isArray(body.listeners)) throw new HubError(400, 'listeners must be an array');
        const listeners = body.listeners ?? [];
        if (listeners.length === 0) {
          const session = service.start(start);
          return sendJson(res, 201, { id: session.id, listeners: [], ...(session.forced ? { forced: session.forced } : {}) });
        }
        if (!options.listeners) throw new HubError(400, 'this hub has no listener service; a session with listeners cannot be created');
        const result = await options.listeners.create({ ...start, wait: body.wait !== false }, listeners);
        return sendJson(res, result.status, result.body);
      }
      throw new HubError(404, 'not found');
    }

    const listenerMatch = LISTENERS_ROUTE.exec(url.pathname);
    if (listenerMatch) {
      if (!options.listeners) throw new HubError(404, 'no listener service');
      const sessionId = resolveSession(service, listenerMatch[1] as string);
      const listenerId = listenerMatch[2];
      if (listenerId === undefined) {
        if (method === 'GET') return sendJson(res, 200, options.listeners.list(sessionId));
        if (method === 'POST') {
          const body = await readJson(req);
          if (body.wait !== undefined && typeof body.wait !== 'boolean') throw new HubError(400, 'wait must be a boolean');
          // `wait` is a route field, not part of the listener request (which rejects unknown keys).
          const { wait, ...listener } = body;
          const result = await options.listeners.addListener(sessionId, listener, wait !== false);
          return sendJson(res, result.status, result.body);
        }
      } else if (listenerMatch[3] === 'resume' && method === 'POST') {
        return sendJson(res, 200, options.listeners.resumeListener(sessionId, listenerId));
      } else if (method === 'DELETE') {
        options.listeners.remove(sessionId, listenerId);
        return sendJson(res, 200, { ok: true });
      }
      throw new HubError(404, 'not found');
    }

    const eventsMatch = EVENTS_ROUTE.exec(url.pathname);
    if (eventsMatch && method === 'GET') {
      if (!options.listeners) throw new HubError(404, 'no listener service');
      const sessionId = resolveSession(service, eventsMatch[1] as string);
      const since = numberParam(url, 'since', 0);
      const limit = url.searchParams.get('limit') === null ? undefined : Math.max(1, numberParam(url, 'limit', 200));
      return sendJson(res, 200, options.listeners.events(sessionId, since, limit));
    }

    const deliveriesMatch = DELIVERIES_ROUTE.exec(url.pathname);
    if (deliveriesMatch && method === 'GET') {
      if (!options.listeners) throw new HubError(404, 'no listener service');
      const sessionId = resolveSession(service, deliveriesMatch[1] as string);
      const listener = url.searchParams.get('listener') ?? undefined;
      return sendJson(res, 200, options.listeners.deliveries(sessionId, listener));
    }

    const match = SESSION_ROUTE.exec(url.pathname);
    const id = match?.[1];
    const action = match?.[2];
    if (id === undefined) throw new HubError(404, 'not found');
    const session = service.get(id);
    if (!session) throw new HubError(404, `no such session: ${id}`);

    if (action === undefined) {
      if (method === 'GET') return sendJson(res, 200, session);
      if (method === 'DELETE') {
        await service.remove(id);
        return sendJson(res, 200, { ok: true });
      }
    } else if (method === 'GET') {
      if (action === 'output') {
        const { data, total } = await service.readHistory(id, numberParam(url, 'offset', 0), numberParam(url, 'limit', Infinity));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'X-Total-Bytes': total });
        res.end(data);
        return;
      }
      if (action === 'text') {
        if (session.claude) {
          // The agent's transcript is already plain text; an old output.log is stripped of its escape codes.
          const { data, total } = await service.readHistory(id, numberParam(url, 'offset', 0), Infinity, true);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': data.length, 'X-Total-Bytes': total });
          res.end(data);
          return;
        }
        const total = service.size(id);
        const stripper = new AnsiStripper();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Total-Bytes': total });
        for await (const data of service.readChunks(id, Math.min(numberParam(url, 'offset', 0), total), total)) res.write(stripper.push(data));
        res.end();
        return;
      }
      if (action === 'stream') return streamText(res, id, url);
    } else if (method === 'POST') {
      if (action === 'input') {
        const { data } = await readJson(req);
        if (typeof data !== 'string') throw new HubError(400, 'data must be a string');
        service.write(id, data);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'stop') {
        service.stop(id);
        return sendJson(res, 200, { ok: true, running: session.running });
      }
      if (action === 'answer') {
        const body = await readJson(req);
        const request: AnswerRequest = { keys: body.keys as string | undefined, text: body.text as string | undefined, submit: body.submit as boolean | undefined };
        return sendJson(res, 200, { ok: true, sent: service.answer(id, request) });
      }
      if (action === 'resize') {
        const body = await readJson(req);
        const cols = requiredInt(body.cols, 'cols');
        const rows = requiredInt(body.rows, 'rows');
        if (!session.running) throw new HubError(409, 'session is not running');
        service.resize(id, cols, rows);
        return sendJson(res, 200, { ok: true, cols, rows });
      }
      if (action === 'resume') {
        const { force } = await readJson(req);
        if (force !== undefined && typeof force !== 'boolean') throw new HubError(400, 'force must be a boolean');
        const resumed = service.resume(id, force);
        return sendJson(res, 200, { id, ...(resumed.forced ? { forced: resumed.forced } : {}) });
      }
      if (action === 'archive') {
        const { archived } = await readJson(req);
        if (typeof archived !== 'boolean') throw new HubError(400, 'archived must be a boolean');
        return sendJson(res, 200, service.setArchived(id, archived));
      }
      if (action === 'title') {
        const { title, auto } = await readJson(req);
        if (auto !== undefined) {
          if (auto !== true) throw new HubError(400, 'auto must be true');
          if (title !== undefined) throw new HubError(400, 'give either title or auto, not both');
          return sendJson(res, 200, service.releaseTitle(id));
        }
        if (typeof title !== 'string') throw new HubError(400, 'title must be a string');
        return sendJson(res, 200, service.setTitle(id, title));
      }
    }
    throw new HubError(404, 'not found');
  }

  const server = createServer((req, res) => {
    // Reject anything that is not a plain loopback client: browsers (Origin) and DNS-rebinding (Host).
    const port = (server.address() as AddressInfo | null)?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (req.headers.origin !== undefined || !hosts.includes(req.headers.host ?? '')) {
      sendJson(res, 403, { error: 'forbidden host or origin' });
      return;
    }
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HubError) sendJson(res, error.status, { error: error.message, ...(error.details ?? {}) });
      else {
        console.error(error);
        sendJson(res, 500, { error: 'internal error' });
      }
    });
  });
  return server;
}

export function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}
