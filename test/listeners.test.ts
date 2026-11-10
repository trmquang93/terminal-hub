import { EventEmitter } from 'node:events';
import type { spawn as spawnType } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubError } from '../src/main/errors';
import { listenersPath } from '../src/main/listenerConfig';
import { SessionListeners } from '../src/main/sessionListeners';
import type { SessionService } from '../src/main/service';
import type { SessionInfo, StartSessionOptions } from '../src/shared/types';

const DATA = 'data';
let dataDir: string;
let sessionsRoot: string;
let sessions: Map<string, SessionInfo>;
let hub: SessionListeners;
let testEvents: Record<string, unknown>[];
let delivered: Record<string, unknown>[];
let starts: StartSessionOptions[];

function info(id: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: 't',
    cwd: '/tmp',
    command: 'sh',
    argv: [],
    env: {},
    state: 'running',
    claude: null,
    resumeCount: 0,
    autoAnswer: null,
    archived: false,
    titleSource: 'auto',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
    signal: null,
    cols: 80,
    rows: 24,
    bytesWritten: 0,
    appVersion: 't',
    running: true,
    resumable: false,
    attention: null,
    turn: null,
    ...patch,
  };
}

function seedSession(): SessionInfo {
  const session = info(`22222222-2222-4222-8222-${String(sessions.size + 1).padStart(12, '0')}`);
  sessions.set(session.id, session);
  mkdirSync(join(sessionsRoot, session.id), { recursive: true });
  return session;
}

function httpFetch(ack: boolean): typeof fetch {
  return ((_url: string, init: RequestInit) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    if (body.event === 'handshake') {
      testEvents.push(body);
      if (ack) hub.ack(body.handshakeId as string, body.token as string);
    } else delivered.push(body);
    return Promise.resolve({ status: 204, body: { cancel: () => Promise.resolve() } } as unknown as Response);
  }) as unknown as typeof fetch;
}

/** printed: what the fake hook writes to stdout; 'token' prints the real ack line. */
function commandSpawn(printed: 'token' | 'nothing' | 'wrong-token' = 'token', exitCode = 0): typeof spawnType {
  return ((_file: string, _args: string[]) => {
    const child = new EventEmitter() as unknown as {
      stdin: { end: (input: string) => void };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    child.stdin = {
      end: (input: string) => {
        const payload = JSON.parse(input) as { token?: string };
        setImmediate(() => {
          if (printed === 'token' && payload.token) child.stdout.emit('data', Buffer.from(`${JSON.stringify({ ack: payload.token })}\n`));
          if (printed === 'wrong-token') child.stdout.emit('data', Buffer.from(`${JSON.stringify({ ack: 'not-the-token' })}\n`));
          (child as unknown as EventEmitter).emit('close', exitCode, null);
        });
      },
    };
    return child;
  }) as unknown as typeof spawnType;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'thub-listeners-'));
  sessionsRoot = join(dataDir, DATA, 'sessions');
  sessions = new Map();
  testEvents = [];
  delivered = [];
  starts = [];
  hub = new SessionListeners({
    dataDir: join(dataDir, DATA),
    sessionsRoot,
    startSession: (options) => {
      starts.push(options);
      const session = info('33333333-3333-4333-8333-333333333333');
      sessions.set(session.id, session);
      mkdirSync(join(sessionsRoot, session.id), { recursive: true });
      return session;
    },
    getSession: (id) => sessions.get(id),
    fetchImpl: httpFetch(true),
    spawnImpl: commandSpawn(),
    sleep: () => Promise.resolve(),
    apiBaseUrl: () => 'http://127.0.0.1:9999',
  });
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const httpListener = { kind: 'http', events: ['attention'], http: { url: 'https://agent.example/hook' } };

describe('create handshake', () => {
  it('rejects a create with no listeners before any side effect', async () => {
    await expect(hub.create({ cwd: '/tmp', command: 'sh' }, [])).rejects.toThrow(/listeners is required/);
    expect(starts).toHaveLength(0);
    expect(existsSync(sessionsRoot)).toBe(false);
  });

  it('creates the session only after the listener acks, and persists an 0600 listeners.json', async () => {
    const result = await hub.create({ cwd: '/tmp', command: 'sh' }, [httpListener]);
    expect(result.status).toBe(201);
    expect(starts).toHaveLength(1);
    const id = (result.body as { id: string }).id;
    const path = listenersPath(join(sessionsRoot, id));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { state: string; kind: string }[];
    expect(stored).toMatchObject([{ state: 'active', kind: 'http' }]);
    expect(hub.list(id)[0]).toMatchObject({ kind: 'http', host: 'agent.example', pending: 0, failed: 0 });
    expect(JSON.stringify(hub.list(id))).not.toContain('agent.example/hook');
  });

  it('refuses a bad token, then accepts the real one once and refuses it on reuse', async () => {
    let manual: SessionListeners | null = null;
    const events: Record<string, unknown>[] = [];
    const noAck = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      if (body.event === 'handshake') events.push(body);
      else delivered.push(body);
      return Promise.resolve({ status: 204, body: { cancel: () => Promise.resolve() } } as unknown as Response);
    }) as unknown as typeof fetch;
    manual = new SessionListeners({
      dataDir: join(dataDir, DATA),
      sessionsRoot,
      startSession: (options) => {
        starts.push(options);
        return info('66666666-6666-4666-8666-666666666666');
      },
      getSession: (id) => sessions.get(id),
      fetchImpl: noAck,
      sleep: () => Promise.resolve(),
    });
    const fast = await manual.create({ cwd: '/tmp', command: 'sh', wait: false }, [httpListener]);
    const handshakeId = (fast.body as { handshakeId: string }).handshakeId;
    const token = events[0]?.token as string;
    expect(() => manual?.ack(handshakeId, 'wrong-token')).toThrow(expect.objectContaining({ status: 401 }));
    expect(manual.ack(handshakeId, token).state).toBe('acked');
    expect(() => manual?.ack(handshakeId, token)).toThrow(expect.objectContaining({ status: 410 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(starts).toHaveLength(1);
  });

  it('fails with 504 and leaves no session folder when the listener never acks', async () => {
    const silent = new SessionListeners({
      dataDir: join(dataDir, DATA),
      sessionsRoot,
      startSession: (options) => {
        starts.push(options);
        return info('44444444-4444-4444-8444-444444444444');
      },
      getSession: (id) => sessions.get(id),
      fetchImpl: httpFetch(false),
      sleep: () => Promise.resolve(),
    });
    await expect(silent.create({ cwd: '/tmp', command: 'sh' }, [{ ...httpListener, ackTimeoutSec: 1 }])).rejects.toMatchObject({ status: 504 });
    expect(starts).toHaveLength(0);
    expect(existsSync(sessionsRoot)).toBe(false);
  });

  it('refuses an openmausbot listener without the OMB bridge, before any handshake', async () => {
    await expect(hub.create({ cwd: '/tmp', command: 'sh' }, [{ kind: 'openmausbot', openmausbot: { botId: 'b', threadId: 't' } }])).rejects.toThrow(/bridge/);
    expect(testEvents).toHaveLength(0);
  });

  it('accepts a command listener that prints {"ack": token} on stdout', async () => {
    const result = await hub.create({ cwd: '/tmp', command: 'sh' }, [{ kind: 'command', command: { argv: ['/bin/fake-hook'] } }]);
    expect(result.status).toBe(201);
    expect(starts).toHaveLength(1);
  });

  function commandHub(spawnImpl: typeof spawnType): SessionListeners {
    return new SessionListeners({
      dataDir: join(dataDir, DATA),
      sessionsRoot,
      startSession: (options) => {
        starts.push(options);
        const session = info('33333333-3333-4333-8333-333333333333');
        sessions.set(session.id, session);
        mkdirSync(join(sessionsRoot, session.id), { recursive: true });
        return session;
      },
      getSession: (id) => sessions.get(id),
      fetchImpl: httpFetch(true),
      spawnImpl,
      sleep: () => Promise.resolve(),
      apiBaseUrl: () => 'http://127.0.0.1:9999',
    });
  }
  const commandListener = { kind: 'command', command: { argv: ['/usr/bin/true'] } };

  it('accepts a command listener that exits 0 without printing an ack', async () => {
    const result = await commandHub(commandSpawn('nothing', 0)).create({ cwd: '/tmp', command: 'sh' }, [{ ...commandListener, ackTimeoutSec: 1 }]);
    expect(result.status).toBe(201);
    expect(starts).toHaveLength(1);
  });

  it('refuses a command listener that exits non-zero and leaves no session folder', async () => {
    await expect(commandHub(commandSpawn('nothing', 1)).create({ cwd: '/tmp', command: 'sh' }, [{ ...commandListener, ackTimeoutSec: 1 }])).rejects.toMatchObject({ status: 504 });
    expect(starts).toHaveLength(0);
    expect(existsSync(sessionsRoot)).toBe(false);
  });

  it('does not let exit 0 rescue a wrong ack token', async () => {
    await expect(commandHub(commandSpawn('wrong-token', 0)).create({ cwd: '/tmp', command: 'sh' }, [{ ...commandListener, ackTimeoutSec: 1 }])).rejects.toMatchObject({ status: 504 });
    expect(starts).toHaveLength(0);
    expect(existsSync(sessionsRoot)).toBe(false);
  });

  it('adds a listener to a running session through the same handshake', async () => {
    const session = seedSession();
    const result = await hub.addListener(session.id, httpListener);
    expect(result.status).toBe(201);
    expect(hub.list(session.id)).toHaveLength(1);
    expect(JSON.parse(readFileSync(listenersPath(join(sessionsRoot, session.id)), 'utf8'))).toHaveLength(1);
  });

  it('does not attach an added listener when its handshake times out', async () => {
    const session = seedSession();
    const silent = new SessionListeners({
      dataDir: join(dataDir, DATA),
      sessionsRoot,
      startSession: () => info('55555555-5555-4555-8555-555555555555'),
      getSession: (id) => sessions.get(id),
      fetchImpl: httpFetch(false),
      sleep: () => Promise.resolve(),
    });
    await expect(silent.addListener(session.id, { ...httpListener, ackTimeoutSec: 1 })).rejects.toMatchObject({ status: 504 });
    expect(silent.list(session.id)).toHaveLength(0);
  });
});

describe('event journal and delivery from the hub', () => {
  it('journals one event with seq 1 and delivers it to the acked listener', async () => {
    const result = await hub.create({ cwd: '/tmp', command: 'sh' }, [httpListener]);
    const id = (result.body as { id: string }).id;
    const session = sessions.get(id) as SessionInfo;
    hub.publish(
      { event: 'attention', session: { id, title: 't', cwd: '/tmp', command: 'sh', state: 'running', reason: 'prompt', promptText: 'Continue?', source: 'heuristic', since: '2026-01-01T00:00:00.000Z' } },
      session,
    );
    await hub.drain();
    expect(delivered).toMatchObject([{ event: 'attention', seq: 1 }]);
    const journal = readFileSync(join(sessionsRoot, id, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(journal).toHaveLength(1);
    expect(JSON.parse(journal[0] as string)).toMatchObject({ event: 'attention', seq: 1 });
    expect(hub.events(id).events).toHaveLength(1);
  });

  it('emits exit once per ended session', async () => {
    const result = await hub.create({ cwd: '/tmp', command: 'sh' }, [httpListener]);
    const id = (result.body as { id: string }).id;
    const ended = { ...(sessions.get(id) as SessionInfo), running: false, state: 'exited' as const, endedAt: '2026-01-01T00:00:02.000Z', exitCode: 0 };
    hub.publishExit(ended);
    hub.publishExit(ended);
    expect(hub.events(id).events.filter((event) => event.event === 'exit')).toHaveLength(1);
  });
});

describe('HubError carries details for the API body', () => {
  it('keeps the handshake list on a 504', () => {
    const error = new HubError(504, 'listener did not acknowledge (a cmd: listener must exit 0 or print {"ack":"<token>"})', { handshakes: [{ id: 'hs_1', state: 'expired' }] });
    expect(error.status).toBe(504);
    expect(error.details).toEqual({ handshakes: [{ id: 'hs_1', state: 'expired' }] });
  });
});

describe('POST /handshakes/:id/ack on the HTTP route', () => {
  it('is bearer-exempt, refuses a bad token, accepts the real one once, then 410', async () => {
    const { createApiServer, listenOnLoopback } = await import('../src/main/apiServer.js');
    const events: Record<string, unknown>[] = [];
    const noAck = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      if (body.event === 'handshake') events.push(body);
      return Promise.resolve({ status: 204, body: { cancel: () => Promise.resolve() } } as unknown as Response);
    }) as unknown as typeof fetch;
    const manual = new SessionListeners({
      dataDir: join(dataDir, DATA),
      sessionsRoot,
      startSession: (options) => {
        starts.push(options);
        return info('77777777-7777-4777-8777-777777777777');
      },
      getSession: (id) => sessions.get(id),
      fetchImpl: noAck,
      sleep: () => Promise.resolve(),
    });
    const service = { list: () => [], get: () => undefined } as unknown as SessionService;
    const server = createApiServer({ service, listeners: manual, token: 'bearer-token-0123456789abcdef', version: 't', startedAt: '2026-01-01T00:00:00.000Z' });
    const port = await listenOnLoopback(server);
    const base = `http://127.0.0.1:${port}`;
    try {
      const created = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer bearer-token-0123456789abcdef', 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', command: 'sh', wait: false, listeners: [httpListener] }),
      });
      expect(created.status).toBe(202);
      const handshakeId = ((await created.json()) as { handshakeId: string }).handshakeId;
      const token = events[0]?.token as string;

      const ack = (value: string, headers: Record<string, string> = {}) =>
        fetch(`${base}/handshakes/${handshakeId}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ token: value }) });
      expect((await ack('bad')).status).toBe(401);
      expect((await ack(token)).status).toBe(200);
      expect((await ack(token)).status).toBe(410);
      // GET is not exempt: only the ack route is, and only for its own one-time token.
      expect((await fetch(`${base}/handshakes/${handshakeId}`)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => void server.close(() => resolve()));
    }
  });
});
