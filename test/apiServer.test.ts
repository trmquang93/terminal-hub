import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiServer, listenOnLoopback } from '../src/main/apiServer';
import { resolveAnswer } from '../src/main/attention';
import { HubError } from '../src/main/errors';
import type { OutputChunk, SessionService } from '../src/main/service';
import type { SessionListeners } from '../src/main/sessionListeners';
import type { SessionInfo } from '../src/shared/types';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const RUNNING = '11111111-1111-4111-8111-111111111111';
const EXITED = '22222222-2222-4222-8222-222222222222';
const LOG = Buffer.from('\x1b[1;34mdir\x1b[0m\r\nfile\r\n');

function info(id: string, running: boolean): SessionInfo {
  return {
    id, title: id.slice(0, 4), cwd: '/tmp', command: 'ls', argv: [], env: {}, state: running ? 'running' : 'exited', claude: null, resumeCount: 0, autoAnswer: null, archived: false, titleSource: 'auto', attention: null, turn: null,
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: running ? null : '2026-01-01T00:00:01.000Z', exitCode: running ? null : 0, signal: null,
    cols: 80, rows: 24, bytesWritten: LOG.length, appVersion: 't', running, resumable: !running,
  };
}

const sessions = [info(RUNNING, true), info(EXITED, false)];
const written: string[] = [];
const hooks: unknown[] = [];
const removedMany: string[][] = [];
const resized: [string, number, number][] = [];
let removedAll = 0;
const attentionListeners = new Set<(session: SessionInfo) => void>();
const outputListeners = new Set<(chunk: OutputChunk) => void>();
const turnListeners = new Set<(session: SessionInfo) => void>();
const changedListeners = new Set<(session: SessionInfo) => void>();

/** Stands in for the manager's worktree guard: this cwd always has a running session. */
const BUSY_CWD = '/tmp/busy-worktree';
const CONFLICT = { id: RUNNING, title: 'run', cwd: BUSY_CWD };

function guard(cwd: string, force: boolean | undefined): typeof CONFLICT | undefined {
  if (cwd !== BUSY_CWD) return undefined;
  if (!force) throw new HubError(409, `another session is already running in this worktree — id: ${CONFLICT.id}, title: "${CONFLICT.title}", cwd: ${CONFLICT.cwd}. pass --force`, { conflict: CONFLICT });
  return CONFLICT;
}

const service: SessionService = {
  list: () => sessions,
  get: (id) => sessions.find((s) => s.id === id),
  start: (options) => {
    const forced = guard(options.cwd, options.force);
    return forced ? { ...info(RUNNING, true), forced } : info(RUNNING, true);
  },
  resume: (id, force) => {
    if (id === EXITED) {
      const forced = guard(BUSY_CWD, force);
      return forced ? { ...info(EXITED, true), forced } : info(EXITED, true);
    }
    throw new HubError(409, `cannot resume ${id}`);
  },
  write: (id, data) => {
    if (!sessions.find((s) => s.id === id)?.running) throw new HubError(409, 'session is not running');
    written.push(data);
  },
  answer: (id, request) => {
    if (!sessions.find((s) => s.id === id)?.running) throw new HubError(409, 'session is not running');
    const sent = resolveAnswer(request).join('');
    written.push(sent);
    return sent;
  },
  hookNotify: (notification) => {
    hooks.push(notification);
    return notification.hubSessionId === RUNNING;
  },
  onAttention: (listener) => {
    attentionListeners.add(listener);
    return () => attentionListeners.delete(listener);
  },
  stop: () => undefined,
  remove: () => Promise.resolve(),
  removeMany: (ids) => {
    for (const id of ids) if (!sessions.some((s) => s.id === id)) throw new HubError(404, `no such session: ${id}`);
    removedMany.push(ids);
    return Promise.resolve();
  },
  removeAll: () => {
    removedAll++;
    return Promise.resolve();
  },
  resize: (id, cols, rows) => void resized.push([id, cols, rows]),
  setArchived: (id, archived) => {
    const index = sessions.findIndex((s) => s.id === id);
    const current = sessions[index] as SessionInfo;
    if (archived && current.running) throw new HubError(400, 'cannot archive a running session; stop it first');
    return (sessions[index] = { ...current, archived });
  },
  setTitle: (id, title) => ({ ...info(id, true), title, titleSource: 'manual' }),
  releaseTitle: (id) => ({ ...info(id, true), titleSource: 'auto' }),
  size: () => LOG.length,
  readChunks: async function* (_id, start, end) {
    await Promise.resolve();
    yield LOG.subarray(start, end);
  },
  readHistory: (_id, offset, limit) => Promise.resolve({ data: LOG.subarray(offset, offset + limit), total: LOG.length }),
  onOutput: (listener) => {
    outputListeners.add(listener);
    return () => outputListeners.delete(listener);
  },
  onTurn: (listener) => {
    turnListeners.add(listener);
    return () => turnListeners.delete(listener);
  },
  onChanged: (listener) => {
    changedListeners.add(listener);
    return () => changedListeners.delete(listener);
  },
};

let server: Server;
let port: number;

beforeAll(async () => {
  server = createApiServer({ service, token: TOKEN, version: '9.9.9', startedAt: '2026-01-01T00:00:00.000Z' });
  port = await listenOnLoopback(server);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('API auth', () => {
  it('binds to loopback only', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('serves /health without a token', async () => {
    const res = await request('/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, version: '9.9.9', startedAt: '2026-01-01T00:00:00.000Z', pid: process.pid });
  });

  it.each([
    ['no Authorization header', {}],
    ['wrong token', { Authorization: 'Bearer nope' }],
    ['wrong scheme', { Authorization: `Basic ${TOKEN}` }],
    ['token without scheme', { Authorization: TOKEN }],
    ['empty bearer', { Authorization: 'Bearer ' }],
  ])('rejects /sessions with %s (401)', async (_name, headers) => {
    const res = await request('/sessions', { headers });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(RUNNING);
  });

  it('rejects every non-health route without a token', async () => {
    for (const [method, path] of [['POST', '/sessions'], ['GET', `/sessions/${RUNNING}/text`], ['POST', `/sessions/${RUNNING}/input`], ['DELETE', `/sessions/${RUNNING}`]] as const) {
      expect((await request(path, { method })).status, `${method} ${path}`).toBe(401);
    }
    expect(written).toEqual([]);
  });

  it('rejects a browser Origin even with a valid token (403)', async () => {
    expect((await request('/sessions', { headers: { ...auth, Origin: 'http://evil.example' } })).status).toBe(403);
    expect((await request('/health', { headers: { Origin: 'http://evil.example' } })).status).toBe(403);
  });

  it('rejects a foreign Host header, e.g. DNS rebinding (403)', async () => {
    expect((await request('/sessions', { headers: { ...auth, Host: 'evil.example' } })).status).toBe(403);
    expect((await request('/health', { headers: { Host: `evil.example:${port}` } })).status).toBe(403);
  });
});

describe('API attention', () => {
  const asking = (): SessionInfo => ({ ...info(RUNNING, true), attention: { reason: 'prompt', promptText: 'Do you want to proceed?', since: '2026-01-01T00:00:05.000Z', source: 'heuristic' } });

  it('rejects answer, events and hooks without a token', async () => {
    expect((await request(`/sessions/${RUNNING}/answer`, { method: 'POST', body: '{"text":"yes"}' })).status).toBe(401);
    expect((await request('/events')).status).toBe(401);
    expect((await request('/hooks/claude', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('puts attention in session objects and filters with ?attention=1', async () => {
    const original = sessions[0] as SessionInfo;
    sessions[0] = asking();
    try {
      const all = JSON.parse((await request('/sessions', { headers: auth })).body) as SessionInfo[];
      expect(all[0]?.attention?.promptText).toBe('Do you want to proceed?');
      expect(all[1]?.attention).toBeNull();
      const flagged = JSON.parse((await request('/sessions?attention=1', { headers: auth })).body) as SessionInfo[];
      expect(flagged.map((s) => s.id)).toEqual([RUNNING]);
    } finally {
      sessions[0] = original;
    }
  });

  it('answer maps friendly names, honours submit and raw keys, and echoes the bytes', async () => {
    written.length = 0;
    const post = (body: string) => request(`/sessions/${RUNNING}/answer`, { method: 'POST', headers: auth, body });
    expect(JSON.parse((await post('{"text":"yes"}')).body)).toEqual({ ok: true, sent: 'y\r' });
    expect(JSON.parse((await post('{"text":"1","submit":true}')).body)).toEqual({ ok: true, sent: '1\r' });
    expect(JSON.parse((await post('{"keys":"1\\r"}')).body)).toEqual({ ok: true, sent: '1\r' });
    expect((await post('{}')).status).toBe(400);
    expect(written).toEqual(['y\r', '1\r', '1\r']);
  });

  it('answer returns 409 for an exited session and 404 for an unknown one', async () => {
    expect((await request(`/sessions/${EXITED}/answer`, { method: 'POST', headers: auth, body: '{"text":"yes"}' })).status).toBe(409);
    expect((await request('/sessions/33333333-3333-4333-8333-333333333333/answer', { method: 'POST', headers: auth, body: '{"text":"yes"}' })).status).toBe(404);
  });

  it('forwards Claude Code hook notifications and reports whether a session matched', async () => {
    const post = (body: unknown) => request('/hooks/claude', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    expect(JSON.parse((await post({ hubSessionId: RUNNING, message: 'needs permission' })).body)).toEqual({ ok: true, matched: true });
    expect(JSON.parse((await post({ hubSessionId: EXITED, message: 'x' })).body)).toEqual({ ok: true, matched: false });
    expect(hooks[0]).toMatchObject({ hubSessionId: RUNNING, message: 'needs permission' });
  });

  it('passes the hook_event_name through as hookEvent', async () => {
    await request('/hooks/claude', { method: 'POST', headers: auth, body: JSON.stringify({ hubSessionId: RUNNING, hookEvent: 'PreToolUse', sessionId: 'abc' }) });
    expect(hooks.at(-1)).toEqual({ hubSessionId: RUNNING, sessionId: 'abc', message: '', hookEvent: 'PreToolUse' });
  });

  it('streams turn events from /events: the current turn first, then changes, and GET /sessions carries turn', async () => {
    const original = sessions[0] as SessionInfo;
    const turn = (state: 'working' | 'done', since: string): SessionInfo => ({ ...original, turn: { state, since } });
    sessions[0] = turn('working', 't1');
    expect((JSON.parse((await request('/sessions', { headers: auth })).body) as SessionInfo[])[0]?.turn).toEqual({ state: 'working', since: 't1' });
    const received = await new Promise<string>((resolve, reject) => {
      let body = '';
      const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: auth }, (res) => {
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.includes('"done"')) {
            req.destroy();
            resolve(body);
          }
        });
      });
      req.on('error', (error) => (body.includes('"done"') ? undefined : reject(error)));
      setTimeout(() => {
        for (const listener of turnListeners) listener(turn('done', 't2'));
      }, 150);
    });
    sessions[0] = original;
    const events = [...received.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2] ?? '{}') as Record<string, unknown> }));
    expect(events.map((e) => e.event)).toEqual(['turn', 'turn']);
    expect(events[0]?.data).toMatchObject({ id: RUNNING, turn: { state: 'working', since: 't1' } });
    expect(events[1]?.data).toMatchObject({ id: RUNNING, turn: { state: 'done', since: 't2' } });
  });

  it('streams attention events from /events: sessions already waiting first, then changes and exits', async () => {
    const original = sessions[0] as SessionInfo;
    sessions[0] = asking();
    const received = await new Promise<string>((resolve, reject) => {
      let body = '';
      const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: auth }, (res) => {
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.includes('event: exit')) {
            req.destroy();
            resolve(body);
          }
        });
      });
      req.on('error', (error) => (body.includes('event: exit') ? undefined : reject(error)));
      setTimeout(() => {
        for (const listener of attentionListeners) listener({ ...asking(), attention: null });
        for (const listener of changedListeners) listener({ ...info(RUNNING, false), exitCode: 3 });
      }, 150);
    });
    sessions[0] = original;
    const events = [...received.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2] ?? '{}') as Record<string, unknown> }));
    expect(events.map((e) => e.event)).toEqual(['attention', 'attention', 'exit']);
    expect(events[0]?.data).toMatchObject({ id: RUNNING, attention: { reason: 'prompt', promptText: 'Do you want to proceed?' } });
    expect(events[1]?.data).toMatchObject({ id: RUNNING, attention: null });
    expect(events[2]?.data).toMatchObject({ id: RUNNING, exitCode: 3 });
  });
});

describe('API routes', () => {
  it('lists sessions with the running flag', async () => {
    const res = await request('/sessions', { headers: auth });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as SessionInfo[]).map((s) => s.running)).toEqual([true, false]);
  });

  it('returns stripped text and raw bytes with X-Total-Bytes', async () => {
    const text = await request(`/sessions/${EXITED}/text`, { headers: auth });
    expect(text.body).toBe('dir\nfile\n');
    expect(text.headers['x-total-bytes']).toBe(String(LOG.length));
    const raw = await request(`/sessions/${EXITED}/output?offset=0&limit=4`, { headers: auth });
    expect(raw.headers['content-type']).toBe('application/octet-stream');
    expect(raw.body).toBe(LOG.subarray(0, 4).toString());
  });

  it('streams finished sessions as SSE: replay then exit event, then closes', async () => {
    const res = await request(`/sessions/${EXITED}/stream`, { headers: auth });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('data: {"text":"dir\\nfile\\n"}');
    expect(res.body).toContain('event: exit\ndata: {"exitCode":0,"signal":null,"state":"exited"}');
  });

  it('keeps the stream open for a running session, delivers live output once, and ends with the exit event', async () => {
    const pending = request(`/sessions/${RUNNING}/stream`, { headers: auth });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changedListeners.size).toBe(1);
    const live = { id: RUNNING, endOffset: LOG.length + 5, data: Buffer.from('\x1b[32mlive\x1b[0m') };
    for (const listener of outputListeners) listener({ ...live, data: Buffer.from('live\n') });
    for (const listener of outputListeners) listener({ ...live, data: Buffer.from('live\n') });
    const original = sessions[0] as SessionInfo;
    sessions[0] = { ...info(RUNNING, false), exitCode: 7 };
    for (const listener of changedListeners) listener(sessions[0]);
    const res = await pending;
    sessions[0] = original;
    expect(res.body).toContain('data: {"text":"dir\\nfile\\n"}');
    expect(res.body.match(/"text":"live\\n"/g)).toHaveLength(1);
    expect(res.body).toContain('event: exit\ndata: {"exitCode":7');
    expect(changedListeners.size).toBe(0);
    expect(outputListeners.size).toBe(0);
  });

  it('answers 409 for input to an exited session and 400 for a bad body', async () => {
    written.length = 0;
    expect((await request(`/sessions/${EXITED}/input`, { method: 'POST', headers: auth, body: '{"data":"x"}' })).status).toBe(409);
    expect((await request(`/sessions/${RUNNING}/input`, { method: 'POST', headers: auth, body: '{"data":1}' })).status).toBe(400);
    expect((await request(`/sessions/${RUNNING}/input`, { method: 'POST', headers: auth, body: '{"data":"ls\\r"}' })).status).toBe(200);
    expect(written).toEqual(['ls\r']);
  });

  it('POST /sessions/:id/listeners strips the route-level wait flag before listener validation', async () => {
    const captured: { listener: unknown; wait: boolean }[] = [];
    const stub = {
      addListener: (_id: string, listener: unknown, wait: boolean) => {
        captured.push({ listener, wait });
        return Promise.resolve({ status: 201, body: { listeners: [{ id: 'lst_1' }] } });
      },
      list: () => [],
      remove: () => undefined,
      resumeListener: () => ({}),
      events: () => ({ events: [], next: 0 }),
      deliveries: () => [],
      ack: () => ({}),
      handshake: () => ({}),
      create: () => Promise.resolve({ status: 201, body: {} }),
    } as unknown as SessionListeners;
    const extra = createApiServer({ service, listeners: stub, token: TOKEN, version: '9.9.9', startedAt: '2026-01-01T00:00:00.000Z' });
    const extraPort = await listenOnLoopback(extra);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ kind: 'command', command: { argv: ['/bin/echo'] }, wait: false });
        const req = http.request(
          { host: '127.0.0.1', port: extraPort, path: `/sessions/${RUNNING}/listeners`, method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(status).toBe(201);
      expect(captured[0]).toEqual({ listener: { kind: 'command', command: { argv: ['/bin/echo'] } }, wait: false });
    } finally {
      await new Promise<void>((resolve) => void extra.close(() => resolve()));
    }
  });

  it('validates POST /sessions and maps unknown ids to 404', async () => {
    expect((await request('/sessions', { method: 'POST', headers: auth, body: '{"cwd":"rel","command":"ls"}' })).status).toBe(400);
    // No listeners is a valid create: the session starts at once with zero listeners, like the window path.
    expect(JSON.parse((await request('/sessions', { method: 'POST', headers: auth, body: '{"cwd":"/tmp","command":"ls"}' })).body)).toEqual({ id: RUNNING, listeners: [] });
    expect(JSON.parse((await request('/sessions', { method: 'POST', headers: auth, body: '{"cwd":"/tmp","command":"ls","listeners":[]}' })).body)).toEqual({ id: RUNNING, listeners: [] });
    expect((await request('/sessions', { method: 'POST', headers: auth, body: '{"cwd":"/tmp","command":"ls","listeners":"nope"}' })).status).toBe(400);
    expect((await request('/sessions/33333333-3333-4333-8333-333333333333', { headers: auth })).status).toBe(404);
  });

  it('surfaces resume conflicts as 409', async () => {
    expect((await request(`/sessions/${RUNNING}/resume`, { method: 'POST', headers: auth })).status).toBe(409);
  });

  it('POST /sessions into a worktree that is in use is 409 with the conflict; force starts and returns `forced`', async () => {
    const body = (extra: string) => `{"cwd":"${BUSY_CWD}","command":"ls"${extra}}`;
    const refused = await request('/sessions', { method: 'POST', headers: auth, body: body('') });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ conflict: CONFLICT, error: expect.stringContaining(`id: ${RUNNING}`) as string });
    const forced = await request('/sessions', { method: 'POST', headers: auth, body: body(',"force":true') });
    expect(forced.status).toBe(201);
    expect(JSON.parse(forced.body)).toEqual({ id: RUNNING, listeners: [], forced: CONFLICT });
    // another worktree is untouched, and `forced` is only on the answer, never on a later read
    expect(JSON.parse((await request('/sessions', { method: 'POST', headers: auth, body: '{"cwd":"/tmp","command":"ls","force":true}' })).body)).toEqual({ id: RUNNING, listeners: [] });
    expect((JSON.parse((await request(`/sessions/${RUNNING}`, { headers: auth })).body) as SessionInfo).forced).toBeUndefined();
    expect((await request('/sessions', { method: 'POST', headers: auth, body: body(',"force":"yes"') })).status).toBe(400);
  });

  it('POST /sessions/:id/resume into a worktree that is in use is 409 with the conflict; {"force":true} resumes and returns `forced`', async () => {
    const refused = await request(`/sessions/${EXITED}/resume`, { method: 'POST', headers: auth });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ conflict: CONFLICT });
    const forced = await request(`/sessions/${EXITED}/resume`, { method: 'POST', headers: auth, body: '{"force":true}' });
    expect(forced.status).toBe(200);
    expect(JSON.parse(forced.body)).toEqual({ id: EXITED, forced: CONFLICT });
    expect((await request(`/sessions/${EXITED}/resume`, { method: 'POST', headers: auth, body: '{"force":1}' })).status).toBe(400);
  });
});

describe('API archive and batch delete', () => {
  const post = (path: string, body: string, headers: Record<string, string> = auth) => request(path, { method: 'POST', headers, body });

  it('archives and unarchives through POST /sessions/:id/archive, and GET /sessions keeps archived ones with the flag', async () => {
    const archived = await post(`/sessions/${EXITED}/archive`, '{"archived":true}');
    expect(archived.status).toBe(200);
    expect(JSON.parse(archived.body)).toMatchObject({ id: EXITED, archived: true });
    const list = JSON.parse((await request('/sessions', { headers: auth })).body) as SessionInfo[];
    expect(list.map((s) => [s.id, s.archived])).toEqual([[RUNNING, false], [EXITED, true]]);
    expect(JSON.parse((await post(`/sessions/${EXITED}/archive`, '{"archived":false}')).body)).toMatchObject({ id: EXITED, archived: false });
  });

  it('refuses to archive a running session (400), rejects a non-boolean body (400) and an unknown id (404)', async () => {
    expect((await post(`/sessions/${RUNNING}/archive`, '{"archived":true}')).status).toBe(400);
    expect((await post(`/sessions/${EXITED}/archive`, '{"archived":"yes"}')).status).toBe(400);
    expect((await post(`/sessions/${EXITED}/archive`, '{}')).status).toBe(400);
    expect((await post('/sessions/33333333-3333-4333-8333-333333333333/archive', '{"archived":true}')).status).toBe(404);
  });

  it('deletes several sessions with POST /sessions/delete and validates the body', async () => {
    removedMany.length = 0;
    expect(JSON.parse((await post('/sessions/delete', `{"ids":["${RUNNING}","${EXITED}"]}`)).body)).toEqual({ ok: true, deleted: 2 });
    expect(removedMany).toEqual([[RUNNING, EXITED]]);
    expect((await post('/sessions/delete', '{"ids":"x"}')).status).toBe(400);
    expect((await post('/sessions/delete', '{"ids":[1]}')).status).toBe(400);
    expect((await post('/sessions/delete', '{}')).status).toBe(400);
    expect((await post('/sessions/delete', '{"ids":["33333333-3333-4333-8333-333333333333"]}')).status).toBe(404);
    expect(removedMany).toHaveLength(1);
  });

  it('requires the token for archive and batch delete', async () => {
    expect((await post(`/sessions/${EXITED}/archive`, '{"archived":true}', {})).status).toBe(401);
    expect((await post('/sessions/delete', `{"ids":["${EXITED}"]}`, {})).status).toBe(401);
    expect(removedMany).toHaveLength(1);
  });
});

describe('API resize and delete-all', () => {
  const post = (path: string, body: string, headers: Record<string, string> = auth) => request(path, { method: 'POST', headers, body });

  it('resizes a running session with POST /sessions/:id/resize', async () => {
    resized.length = 0;
    const result = await post(`/sessions/${RUNNING}/resize`, '{"cols":132,"rows":43}');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true, cols: 132, rows: 43 });
    expect(resized).toEqual([[RUNNING, 132, 43]]);
    expect((await post(`/sessions/${RUNNING}/resize`, '{"cols":1,"rows":1000}')).status).toBe(200);
  });

  it.each(['{}', '{"cols":80}', '{"rows":24}', '{"cols":0,"rows":24}', '{"cols":80,"rows":1001}', '{"cols":80.5,"rows":24}', '{"cols":"80","rows":24}', '{"cols":-5,"rows":24}', '{"cols":null,"rows":24}'])('rejects resize body %s (400)', async (body) => {
    resized.length = 0;
    expect((await post(`/sessions/${RUNNING}/resize`, body)).status).toBe(400);
    expect(resized).toEqual([]);
  });

  it('refuses to resize an exited session (409), an unknown one (404) and a call without a token (401)', async () => {
    resized.length = 0;
    expect((await post(`/sessions/${EXITED}/resize`, '{"cols":80,"rows":24}')).status).toBe(409);
    expect((await post('/sessions/33333333-3333-4333-8333-333333333333/resize', '{"cols":80,"rows":24}')).status).toBe(404);
    expect((await post(`/sessions/${RUNNING}/resize`, '{"cols":80,"rows":24}', {})).status).toBe(401);
    expect(resized).toEqual([]);
  });

  it('POST /sessions/delete-all removes everything and reports the count', async () => {
    removedAll = 0;
    const result = await post('/sessions/delete-all', '');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true, deleted: sessions.length });
    expect(removedAll).toBe(1);
  });

  it('delete-all requires the token and rejects other methods', async () => {
    removedAll = 0;
    expect((await post('/sessions/delete-all', '', {})).status).toBe(401);
    expect((await request('/sessions/delete-all', { headers: auth })).status).not.toBe(200);
    expect(removedAll).toBe(0);
  });
});

describe('API title', () => {
  const post = (path: string, body: string, headers: Record<string, string> = auth) => request(path, { method: 'POST', headers, body });

  it('a manual title pins it: POST /sessions/:id/title { title } returns titleSource manual', async () => {
    const result = await post(`/sessions/${RUNNING}/title`, '{"title":"My name"}');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ id: RUNNING, title: 'My name', titleSource: 'manual' });
  });

  it('{ "auto": true } releases the pin and returns titleSource auto', async () => {
    const result = await post(`/sessions/${RUNNING}/title`, '{"auto":true}');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ id: RUNNING, titleSource: 'auto' });
  });

  it('GET /sessions/:id exposes titleSource', async () => {
    expect(JSON.parse((await request(`/sessions/${RUNNING}`, { headers: auth })).body)).toMatchObject({ titleSource: 'auto' });
  });

  it('rejects a bad body (400): no title, non-string title, auto not true, auto together with title', async () => {
    for (const body of ['{}', '{"title":5}', '{"auto":false}', '{"auto":"yes"}', '{"auto":true,"title":"x"}']) {
      expect((await post(`/sessions/${RUNNING}/title`, body)).status, body).toBe(400);
    }
    expect((await post('/sessions/33333333-3333-4333-8333-333333333333/title', '{"auto":true}')).status).toBe(404);
    expect((await post(`/sessions/${RUNNING}/title`, '{"auto":true}', {})).status).toBe(401);
  });
});
