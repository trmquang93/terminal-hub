import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiServer, listenOnLoopback } from '../src/main/apiServer';
import type { SessionService } from '../src/main/service';
import type { SessionListeners } from '../src/main/sessionListeners';
import type { SessionInfo } from '../src/shared/types';

const TOKEN = 'cli-test-token-0123456789abcdef0123456789abcdef';
const RUNNING = 'aaaaaaaa-1111-4111-8111-111111111111';
const EXITED = 'bbbbbbbb-2222-4222-8222-222222222222';
const WAITING = 'cccccccc-3333-4333-8333-333333333333';
const NEW = 'dddddddd-4444-4444-8444-444444444444';

function info(id: string, running: boolean, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, title: `t-${id.slice(0, 4)}`, cwd: '/tmp', command: 'sleep', argv: ['30'], env: {}, state: running ? 'running' : 'exited', claude: null, resumeCount: 0, autoAnswer: null, archived: false, titleSource: 'auto', attention: null, turn: null,
    startedAt: `2026-01-01T00:00:0${id.charCodeAt(0) % 10}.000Z`, endedAt: running ? null : '2026-01-01T00:00:01.000Z', exitCode: running ? null : 3, signal: null,
    cols: 80, rows: 24, bytesWritten: 0, appVersion: 't', running, resumable: !running, ...extra,
  };
}

const asking = { reason: 'prompt' as const, promptText: 'Proceed? [y/N]', since: '2026-01-01T00:00:05.000Z', source: 'heuristic' as const };
const sessions = [info(RUNNING, true), info(EXITED, false), info(WAITING, true, { attention: asking })];
const started: unknown[] = [];
const resized: [string, number, number][] = [];
let removedAll = 0;

// Only the methods the CLI paths under test reach; anything else would be a test bug.
const listenBodies: unknown[] = [];
const listenWaits: (boolean | undefined)[] = [];
const listenerService = {
  create: (options: unknown, listeners: unknown) => {
    started.push(options);
    listenBodies.push(listeners);
    return Promise.resolve({ status: 201, body: { id: NEW, listeners: [] } });
  },
  addListener: (_id: string, listener: unknown, wait?: boolean) => {
    listenBodies.push(listener);
    listenWaits.push(wait);
    return Promise.resolve({ status: 201, body: { listeners: [{ id: 'lst_1' }] } });
  },
  ack: (id: string) => ({ id, state: 'acked', expiresAt: '2026-01-01T00:00:30.000Z', sessionId: null }),
  list: () => [],
  remove: () => undefined,
  resumeListener: () => ({}),
  events: () => ({ events: [{ eventId: 'evt_1', seq: 1, event: 'attention' }], next: 1 }),
  deliveries: () => [],
} as unknown as SessionListeners;

const service = {
  list: () => sessions,
  get: (id: string) => sessions.find((s) => s.id === id),
  start: (options: unknown) => {
    started.push(options);
    return info(NEW, true);
  },
  resize: (id: string, cols: number, rows: number) => void resized.push([id, cols, rows]),
  removeAll: () => {
    removedAll += 1;
    return Promise.resolve();
  },
  onAttention: () => () => undefined,
  onTurn: () => () => undefined,
  onChanged: () => () => undefined,
} as unknown as SessionService;

let dir: string;
let cli: string;
let server: Server;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'thub-cli-json-'));
  cli = join(dir, 'hub.cjs');
  await build({ entryPoints: [join(__dirname, '..', 'src', 'cli', 'hub.ts')], outfile: cli, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  server = createApiServer({ service, listeners: listenerService, token: TOKEN, version: '9.9.9', startedAt: '2026-01-01T00:00:00.000Z' });
  const port = await listenOnLoopback(server);
  writeFileSync(join(dir, 'api.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, pid: 4242 }));
});
afterAll(async () => {
  await new Promise<void>((resolve) => void server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function hub(args: string[], dataDir: string = dir): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, PATH: process.env.PATH ?? '', TERMINAL_HUB_DATA_DIR: dataDir } }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('hub --json', () => {
  it('ls --json prints one JSON array, oldest first, and nothing else', async () => {
    const result = await hub(['ls', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as SessionInfo[];
    expect(parsed.map((s) => s.id).sort()).toEqual([RUNNING, EXITED, WAITING].sort());
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toBe('');
  });

  it('ls without --json keeps the table', async () => {
    const result = await hub(['ls']);
    expect(result.stdout.split('\n')[0]).toMatch(/^ID\s+STATE\s+RESUMABLE\s+ARCHIVED\s+EXIT/);
  });

  it('status --json reports version, pid (from /health, else api.json), startedAt, baseUrl, data dir and counts', async () => {
    const result = await hub(['status', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      running: true, version: '9.9.9', pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z', dataDir: dir, total: 3, sessionsRunning: 2, waiting: 1,
    });
    expect((JSON.parse(result.stdout) as { baseUrl: string }).baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('status human output names the pid and counts', async () => {
    const result = await hub(['status']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`pid:        ${process.pid}`);
    expect(result.stdout).toContain('3 total, 2 running, 1 waiting');
  });

  it('show accepts a unique id prefix; --json is the session, human mode lists the fields', async () => {
    const json = await hub(['show', 'bbbb', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ id: EXITED, running: false, exitCode: 3, resumable: true });
    const human = await hub(['show', 'cccc']);
    expect(human.stdout).toContain(`id         ${WAITING}`);
    expect(human.stdout).toMatch(/running\s+true/);
    expect(human.stdout).toMatch(/attention\s+prompt \(heuristic\)/);
  });

  it('run --detach --json starts the session, prints {"id"} and exits 0 without following', async () => {
    started.length = 0;
    const result = await hub(['run', '--detach', '--json', '--listen', 'cmd:/bin/echo', '--', 'sleep', '30', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: NEW });
    expect(started).toMatchObject([{ command: 'sleep', args: ['30', '--json'] }]);
    expect(listenBodies.at(-1)).toMatchObject([{ kind: 'command', command: { argv: ['/bin/echo'] } }]);
  });

  it('run --detach in human mode prints only the id', async () => {
    const result = await hub(['run', '--detach', '--listen', 'cmd:/bin/echo', '--', 'sleep', '30']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${NEW}\n`);
  });

  it('wait --json on a session that needs attention prints one value and exits 10; on an exited one, the exit code', async () => {
    const asked = await hub(['wait', 'cccc', '--json']);
    expect(asked.code).toBe(10);
    expect(JSON.parse(asked.stdout)).toMatchObject({ id: WAITING, status: 'attention', attention: { promptText: 'Proceed? [y/N]' }, code: 10 });
    const done = await hub(['wait', 'bbbb', '--json']);
    expect(done.code).toBe(3);
    expect(JSON.parse(done.stdout)).toMatchObject({ id: EXITED, status: 'exited', exitCode: 3, code: 3 });
  });

  it('a failure with --json prints {"error","code"} on stderr only, with the human exit code', async () => {
    const result = await hub(['show', 'ffff', '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error: 'no session matches ffff', code: 1 });
    const human = await hub(['show', 'ffff']);
    expect(human.code).toBe(1);
    expect(human.stderr.trim()).toBe('no session matches ffff');
  });

  it('exits 2 with {"error","code":2} when the hub is not running', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'thub-cli-empty-'));
    try {
      const result = await hub(['status', '--json'], empty);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ code: 2, error: expect.stringContaining('not running') as unknown });
      expect((await hub(['status'], empty)).stderr).toContain('Terminal Hub is not running.');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('hub --help and rm-all', () => {
  it('--help and no arguments print the same text and exit 0, with commands, exit codes and the data dir', async () => {
    const help = await hub(['--help']);
    const bare = await hub([]);
    expect(help.code).toBe(0);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toBe(help.stdout);
    for (const word of ['hub show', 'hub status', 'hub resize', 'hub rm-all --yes', '--detach', '--json', 'exit codes:', '124', 'TERMINAL_HUB_DATA_DIR', 'Application Support/TerminalHub']) expect(help.stdout).toContain(word);
  });

  it('rm-all refuses without --yes (exit 1) and never calls the hub', async () => {
    const result = await hub(['rm-all']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--yes');
  });
});

describe('hub resize and rm-all --json', () => {
  const noHub = async (args: string[]) => {
    const empty = mkdtempSync(join(tmpdir(), 'thub-cli-empty-'));
    try {
      return await hub(args, empty);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  };

  it('resize --json prints one {sessionId,cols,rows} with the full id, even when given a prefix', async () => {
    resized.length = 0;
    const result = await hub(['resize', 'aaaa', '--cols', '100', '--rows', '30', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['cols', 'rows', 'sessionId']);
    expect(parsed).toEqual({ sessionId: RUNNING, cols: 100, rows: 30 });
    expect(resized).toEqual([[RUNNING, 100, 30]]);
  });

  it.each([[['--rows', '30']], [['--cols', 'abc', '--rows', '30']], [['--cols', '0', '--rows', '30']], [['--cols', '80', '--rows', '1001']]])('resize %j --json fails with exit 1 and a JSON error on stderr only', async (flags) => {
    resized.length = 0;
    const result = await hub(['resize', 'aaaa', ...flags, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    const parsed = JSON.parse(result.stderr) as { error: unknown; code: unknown };
    expect(typeof parsed.error).toBe('string');
    expect(parsed.code).toBe(1);
    expect(resized).toEqual([]);
  });

  it('resize of an unknown session fails with exit 1 and a JSON error', async () => {
    const result = await hub(['resize', 'ffff', '--cols', '80', '--rows', '24', '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 1, error: expect.any(String) as unknown });
  });

  it('resize --json with the hub down exits 2 with {"error","code":2}', async () => {
    const result = await noHub(['resize', 'aaaa', '--cols', '80', '--rows', '24', '--json']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 2, error: expect.any(String) as unknown });
  });

  it('rm-all --yes --json prints {"deleted":N} from the API', async () => {
    removedAll = 0;
    const result = await hub(['rm-all', '--yes', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['deleted']);
    expect(parsed.deleted).toBe(sessions.length);
    expect(removedAll).toBe(1);
  });

  it('rm-all --json without --yes refuses (exit 1, JSON error) and never asks the hub to delete', async () => {
    removedAll = 0;
    const result = await hub(['rm-all', '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 1, error: expect.any(String) as unknown });
    expect(removedAll).toBe(0);
  });

  it('rm-all --yes --json with the hub down exits 2', async () => {
    const result = await noHub(['rm-all', '--yes', '--json']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 2 });
  });
});

describe('hub <command> --help', () => {
  it.each([
    ['ls', 'hub ls [--json]'],
    ['show', 'hub show <id> [--json]'],
    ['status', 'hub status [--json]'],
    ['run', 'hub run --detach [--json]'],
    ['wait', 'hub wait <id> [--timeout S] [--json]'],
    ['resize', 'hub resize <id> --cols N --rows N'],
    ['rm-all', 'hub rm-all --yes'],
  ])('%s --help exits 0 without a running hub and documents its flags, exit codes and data dir', async (command, line) => {
    const result = await hub([command, '--help'], join(dir, 'does-not-exist'));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(line);
    expect(result.stdout).toContain('--json');
    expect(result.stdout).toContain('exit codes:');
    expect(result.stdout).toContain('data dir:');
    expect(result.stdout).not.toContain('hub watch');
  });
});


describe('hub listeners, ack and events', () => {
  it('parses a listener spec into the request shape, including filter, header and bearer-env', async () => {
    process.env.HUB_TEST_BEARER = 'tok-123';
    listenBodies.length = 0;
    const result = await hub(['run', '--detach', '--listen', 'http:https://agent.example/hook#events=attention,turn#header=X-Run:42#bearer-env=HUB_TEST_BEARER', '--', 'sleep', '30']);
    expect(result.code).toBe(0);
    expect(listenBodies.at(-1)).toEqual([
      { kind: 'http', events: ['attention', 'turn'], http: { url: 'https://agent.example/hook', headers: { 'X-Run': '42' }, bearer: 'tok-123' } },
    ]);
    delete process.env.HUB_TEST_BEARER;
  });

  it('refuses a spec with an unknown event name before contacting the hub', async () => {
    const result = await hub(['run', '--detach', '--listen', 'cmd:/bin/echo#events=nope', '--', 'sleep', '30']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unknown event name/);
  });

  it('refuses run with no listener: a session must not exist before one acks', async () => {
    const result = await hub(['run', '--detach', '--', 'sleep', '30']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--listen/);
  });

  it('listen adds exactly one listener to a resolved session', async () => {
    listenBodies.length = 0;
    const result = await hub(['listen', 'aaaa', '--listen', 'cmd:/bin/echo']);
    expect(result.code).toBe(0);
    expect(listenBodies.at(-1)).toEqual({ kind: 'command', command: { argv: ['/bin/echo'] } });
    expect(listenWaits.at(-1)).toBe(true);
  });

  it('events --json prints the page as one JSON value', async () => {
    const result = await hub(['events', 'aaaa', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ next: 1, events: [{ seq: 1, event: 'attention' }] });
  });

  it('ack posts the token without a bearer and prints one JSON value', async () => {
    const result = await hub(['ack', 'hs_1', 'the-token', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'hs_1', state: 'acked' });
  });
});
