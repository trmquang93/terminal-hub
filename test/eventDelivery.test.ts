import { EventEmitter } from 'node:events';
import type { spawn as spawnType } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeConfigPath, EventDispatcher, readDeliveries } from '../src/main/eventDelivery';
import { EventJournal } from '../src/main/eventJournal';
import { listenersPath, writeListeners, type StoredListener } from '../src/main/listenerConfig';
import type { HubEvent, ListenerState } from '../src/shared/types';

const SID = '11111111-1111-4111-8111-111111111111';
let dataDir: string;
let sessionsRoot: string;
let journal: EventJournal;

function listener(patch: Partial<StoredListener> & Pick<StoredListener, 'kind'>): StoredListener {
  return {
    id: `lst_${patch.kind}`,
    events: ['attention'],
    state: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    acknowledgedAt: '2026-01-01T00:00:01.000Z',
    ...patch,
  };
}

function emit(dispatcher: EventDispatcher, event: HubEvent | null): void {
  if (event) dispatcher.dispatch(event);
}

function makeEvent(overrides: Partial<Omit<HubEvent, 'seq'>> = {}): HubEvent | null {
  return journal.append(SID, {
    event: 'attention',
    session: { id: SID, title: 't', cwd: '/tmp', command: 'sh', state: 'running', exitCode: null },
    attention: { reason: 'prompt', promptText: 'Continue?', source: 'heuristic', since: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  });
}

function dispatcherWith(fetchImpl: typeof fetch, onState?: (state: ListenerState) => void) {
  return new EventDispatcher({
    dataDir,
    sessionsRoot,
    journal,
    fetchImpl,
    spawnImpl: fakeSpawn(0).impl,
    sleep: () => Promise.resolve(),
    onState: (_session, _listener, state) => onState?.(state),
  });
}

function httpResponse(status: number): Response {
  return { status, body: { cancel: () => Promise.resolve() } } as unknown as Response;
}

function fakeSpawn(code: number | 'error', stdout = '') {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const impl = ((file: string, args: string[]) => {
    const child = new EventEmitter() as unknown as {
      stdin: { end: (input: string) => void };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    const call: { file: string; args: string[]; input?: string } = { file, args };
    calls.push(call);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    child.stdin = {
      end: (input: string) => {
        call.input = input;
        setImmediate(() => {
          if (stdout !== '') child.stdout.emit('data', Buffer.from(stdout));
          if (code === 'error') (child as unknown as EventEmitter).emit('error', new Error('boom'));
          else (child as unknown as EventEmitter).emit('close', code, null);
        });
      },
    };
    return child;
  }) as unknown as typeof spawnType;
  return { impl, calls };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'thub-delivery-'));
  sessionsRoot = join(dataDir, 'sessions');
  mkdirSync(join(sessionsRoot, SID), { recursive: true });
  journal = new EventJournal(sessionsRoot);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('EventDispatcher drivers', () => {
  it('delivers an http event once and records it in deliveries.jsonl', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (url: string, init: RequestInit) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
      return Promise.resolve(httpResponse(204));
    };
    const dispatcher = dispatcherWith(fetchImpl as unknown as typeof fetch);
    dispatcher.start(SID, listener({ kind: 'http', http: { url: 'https://agent.example/hook', bearer: 'secret' } }), '/tmp');
    emit(dispatcher, makeEvent());
    await dispatcher.drain();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body as string)).toMatchObject({ event: 'attention', seq: 1 });
    const records = readDeliveries(join(sessionsRoot, SID), 'lst_http');
    expect(records).toMatchObject([{ attempt: 1, outcome: 'delivered', status: 204 }]);
  });

  it('retries a 5xx with backoff and succeeds on a later attempt', async () => {
    const statuses = [500, 503, 200];
    let index = 0;
    const dispatcher = dispatcherWith(() => Promise.resolve(httpResponse(statuses[Math.min(index++, statuses.length - 1)] ?? 500)));
    dispatcher.start(SID, listener({ kind: 'http', http: { url: 'https://agent.example/hook' } }), '/tmp');
    emit(dispatcher, makeEvent());
    await dispatcher.drain();
    const records = readDeliveries(join(sessionsRoot, SID), 'lst_http');
    expect(records.map((record) => record.attempt)).toEqual([1, 2, 3]);
    expect(records.at(-1)).toMatchObject({ outcome: 'delivered', status: 200 });
  });

  it('marks a listener degraded after three consecutive failed events and keeps the failures', async () => {
    const states: ListenerState[] = [];
    const dispatcher = dispatcherWith(() => Promise.resolve(httpResponse(500)), (state) => states.push(state));
    dispatcher.start(SID, listener({ kind: 'http', http: { url: 'https://agent.example/hook' } }), '/tmp');
    for (let index = 0; index < 3; index++) emit(dispatcher, makeEvent());
    await dispatcher.drain();
    expect(states).toContain('degraded');
    const records = readDeliveries(join(sessionsRoot, SID), 'lst_http');
    expect(records.filter((record) => record.attempt === 6)).toHaveLength(3);
    expect(dispatcher.list(SID)[0]).toMatchObject({ state: 'degraded', failed: 3 });
  });

  it('runs a command listener with shell:false and one JSON line on stdin', async () => {
    const fake = fakeSpawn(0);
    const dispatcher = new EventDispatcher({
      dataDir,
      sessionsRoot,
      journal,
      fetchImpl: fetch,
      spawnImpl: fake.impl,
      sleep: () => Promise.resolve(),
    });
    dispatcher.start(SID, listener({ kind: 'command', command: { argv: ['/opt/agent/hook.mjs', '--flag'] } }), '/work/repo');
    emit(dispatcher, makeEvent());
    await dispatcher.drain();
    expect(fake.calls[0]).toMatchObject({ file: '/opt/agent/hook.mjs', args: ['--flag'] });
    expect(JSON.parse(fake.calls[0]?.input?.trim() as string)).toMatchObject({ event: 'attention' });
    expect(readDeliveries(join(sessionsRoot, SID), 'lst_command')[0]).toMatchObject({ outcome: 'delivered' });
  });

  it('spools an openmausbot event and runs the configured bridge; a missing bridge is a final bridge_error', async () => {
    const fake = fakeSpawn(0);
    writeFileSync(bridgeConfigPath(dataDir), JSON.stringify({ command: ['/usr/local/bin/omb-event-bridge'], timeoutMs: 1000 }));
    const dispatcher = new EventDispatcher({ dataDir, sessionsRoot, journal, fetchImpl: fetch, spawnImpl: fake.impl, sleep: () => Promise.resolve() });
    dispatcher.start(SID, listener({ kind: 'openmausbot', openmausbot: { botId: 'bot-1', threadId: 'thread-1' } }), '/tmp');
    emit(dispatcher, makeEvent());
    await dispatcher.drain();
    expect(fake.calls[0]?.file).toBe('/usr/local/bin/omb-event-bridge');
    const payload = JSON.parse(fake.calls[0]?.input?.trim() as string) as { botId: string; threadId: string; eventPath: string };
    expect(payload).toMatchObject({ botId: 'bot-1', threadId: 'thread-1' });
    expect(JSON.parse(readFileSync(payload.eventPath, 'utf8'))).toMatchObject({ event: 'attention' });

    rmSync(bridgeConfigPath(dataDir));
    const noBridge = new EventDispatcher({ dataDir, sessionsRoot, journal, fetchImpl: fetch, spawnImpl: fake.impl, sleep: () => Promise.resolve() });
    noBridge.start(SID, listener({ kind: 'openmausbot', openmausbot: { botId: 'bot-1', threadId: 'thread-2' } }), '/tmp');
    emit(noBridge, makeEvent());
    await noBridge.drain();
    const record = readDeliveries(join(sessionsRoot, SID), 'lst_openmausbot').at(-1);
    expect(record).toMatchObject({ outcome: 'bridge_error', attempt: 1 });
  });

  it('resumes from the persisted cursor after a restart and does not redeliver', async () => {
    writeListeners(join(sessionsRoot, SID), [listener({ kind: 'http', http: { url: 'https://agent.example/hook' } })]);
    let posts = 0;
    const fetchImpl = (() => {
      posts++;
      return Promise.resolve(httpResponse(204));
    }) as unknown as typeof fetch;
    const first = new EventDispatcher({ dataDir, sessionsRoot, journal, fetchImpl, spawnImpl: fakeSpawn(0).impl, sleep: () => Promise.resolve() });
    first.start(SID, listener({ kind: 'http', http: { url: 'https://agent.example/hook' } }), '/tmp');
    emit(first, makeEvent());
    await first.drain();
    expect(posts).toBe(1);

    const second = new EventDispatcher({ dataDir, sessionsRoot, journal, fetchImpl, spawnImpl: fakeSpawn(0).impl, sleep: () => Promise.resolve() });
    second.start(SID, listener({ kind: 'http', http: { url: 'https://agent.example/hook' } }), '/tmp');
    await second.drain();
    expect(posts).toBe(1);
    expect(JSON.parse(readFileSync(listenersPath(join(sessionsRoot, SID)), 'utf8'))).toHaveLength(1);
  });
});
