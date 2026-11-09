import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, listenOnLoopback } from '../src/main/apiServer';
import { SessionManager } from '../src/main/sessionManager';
import { SessionStore } from '../src/main/sessionStore';
import type { OutputChunk } from '../src/main/service';
import type { SessionMeta } from '../src/shared/types';
import { projectDirs } from '../src/main/claude';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

// A stand-in `claude`: prints, writes a real two-turn transcript, then waits for one line of input.
const FAKE_CLAUDE = `#!/bin/sh
echo "LIVE-OUTPUT"
sid=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then sid="$a"; fi
  prev="$a"
done
proj="$CLAUDE_CONFIG_DIR/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$proj"
echo '{"type":"user","message":{"role":"user","content":"what is 2+2"}}' >> "$proj/$sid.jsonl"
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"It is 4."}]}}' >> "$proj/$sid.jsonl"
if [ -n "$FAKE_BULK" ]; then head -c "$FAKE_BULK" /dev/zero | tr '\\0' x; fi
[ -n "$FAKE_WAIT" ] && read line && echo "got=$line"
`;
const FAKE_OPENCODE = `#!/bin/sh
echo "OPENCODE-SCREEN"
`;

let base: string;
let work: string;
let config: string;
let managers: SessionManager[];
let servers: Server[];
let events: OutputChunk[];

function manager(): SessionManager {
  const m = new SessionManager(new SessionStore(join(base, 'sessions')), 'test', { baseEnv: () => ({ PATH: `${join(base, 'bin')}:/usr/bin:/bin` }) });
  m.onOutput((chunk) => events.push(chunk));
  managers.push(m);
  return m;
}

const until = async (check: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(check(), what).toBe(true);
};
const exited = (m: SessionManager, id: string): Promise<void> => until(() => m.get(id)?.running === false, 'session exits');
const seen = (id: string): string => events.filter((event) => event.id === id).map((event) => event.data.toString()).join('');
const files = (id: string): string[] => readdirSync(join(base, 'sessions', id)).sort();
const readMeta = (id: string): SessionMeta => JSON.parse(readFileSync(join(base, 'sessions', id, 'meta.json'), 'utf8')) as SessionMeta;
const claude = (m: SessionManager, env: Record<string, string> = {}): string => m.start({ cwd: work, command: 'claude', env: { CLAUDE_CONFIG_DIR: config, ...env } }).id;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'thub-agent-')));
  work = join(base, 'work');
  config = join(base, 'cfg');
  mkdirSync(join(base, 'bin'));
  mkdirSync(work);
  for (const [name, script] of [['claude', FAKE_CLAUDE], ['opencode', FAKE_OPENCODE]] as const) {
    writeFileSync(join(base, 'bin', name), script);
    chmodSync(join(base, 'bin', name), 0o755);
  }
  managers = [];
  servers = [];
  events = [];
});
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe('agent sessions keep no raw PTY log', () => {
  it('a Claude session writes no output.log and no input.log, streams live output, and keeps only its last screen in tail.log on exit', async () => {
    const m = manager();
    const id = claude(m, { FAKE_WAIT: '1' });
    await until(() => seen(id).includes('LIVE-OUTPUT'), 'live output event');
    expect(files(id)).toEqual(['meta.json']);
    m.write(id, 'hello\n');
    await exited(m, id);
    expect(seen(id)).toContain('got=hello');
    expect(files(id)).toEqual(['meta.json', 'tail.log']);
    expect(readFileSync(join(base, 'sessions', id, 'tail.log'), 'utf8')).toContain('got=hello');
    expect(readMeta(id).bytesWritten).toBe(0);
    expect(m.get(id)?.bytesWritten).toBe(0);
  });

  it('an opencode session creates no output.log either', async () => {
    const m = manager();
    const { id, claude: agent } = m.start({ cwd: work, command: 'opencode' });
    expect(agent?.provider).toBe('opencode');
    await exited(m, id);
    expect(seen(id)).toContain('OPENCODE-SCREEN');
    expect(files(id)).toEqual(['meta.json', 'tail.log']);
    expect(readFileSync(join(base, 'sessions', id, 'tail.log'), 'utf8')).toContain('OPENCODE-SCREEN');
  });

  it('a shell session still appends to output.log and counts bytesWritten', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'echo shell-output'] });
    await exited(m, id);
    expect(files(id)).toEqual(['meta.json', 'output.log']);
    expect(readFileSync(join(base, 'sessions', id, 'output.log'), 'utf8')).toContain('shell-output');
    expect(readMeta(id).bytesWritten).toBeGreaterThan(0);
    expect((await m.readTail(id, 1 << 20)).source).toBe('log');
  });

  it('a shell session that receives input writes meta.json and output.log only, never input.log', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'sh', args: ['-c', 'read line; echo got=$line'] });
    m.write(id, 'typed\n');
    await exited(m, id);
    expect(seen(id)).toContain('got=typed');
    expect(files(id)).toEqual(['meta.json', 'output.log']);
  });

  it('leaves an output.log written by an older version alone, and remove deletes the whole folder', async () => {
    const m = manager();
    const id = claude(m);
    await exited(m, id);
    const legacy = join(base, 'sessions', id, 'output.log');
    writeFileSync(legacy, 'old raw bytes');
    const reopened = manager();
    expect(existsSync(legacy)).toBe(true);
    reopened.resume(id);
    await exited(reopened, id);
    expect(readFileSync(legacy, 'utf8')).toBe('old raw bytes');
    await reopened.remove(id);
    expect(existsSync(join(base, 'sessions', id))).toBe(false);
  });
});

describe('the terminal view of an agent session', () => {
  it('shows the in-memory tail while running and offsets that line up with live events', async () => {
    const m = manager();
    const id = claude(m, { FAKE_WAIT: '1' });
    await until(() => seen(id).includes('LIVE-OUTPUT'), 'live output event');
    const slice = await m.readTail(id, 1 << 20);
    expect(slice.source).toBe('live');
    expect(slice.start).toBe(0);
    expect(Buffer.from(slice.data).toString()).toContain('LIVE-OUTPUT');
    expect(slice.total).toBe(m.size(id));
    expect(events.filter((event) => event.id === id).at(-1)?.endOffset).toBe(slice.total);
  });

  it('bounds the in-memory tail', async () => {
    const m = manager();
    const id = claude(m, { FAKE_WAIT: '1', FAKE_BULK: '3000000' });
    await until(() => m.size(id) >= 3_000_000, 'bulk output');
    const slice = await m.readTail(id, 64 * 1024 * 1024);
    expect(slice.data.length).toBeLessThan(2.5 * 1024 * 1024);
    expect(slice.start + slice.data.length).toBe(slice.total);
    expect(slice.source).toBe('live');
  });

  it('shows the native transcript, CRLF line ends, once the session has ended; live offsets keep rising across a resume', async () => {
    const m = manager();
    const id = claude(m);
    await exited(m, id);
    const slice = await m.readTail(id, 1 << 20);
    expect(slice.source).toBe('transcript');
    expect(slice.total).toBe(0);
    expect(Buffer.from(slice.data).toString()).toBe('── user ──\r\nwhat is 2+2\r\n\r\n── assistant ──\r\nIt is 4.\r\n');

    const firstRun = m.size(id);
    expect(firstRun).toBeGreaterThan(0);
    m.resume(id);
    await exited(m, id);
    const resumed = events.filter((event) => event.id === id && event.endOffset > firstRun);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed[0]?.endOffset).toBeGreaterThan(firstRun);
    expect(m.size(id)).toBeGreaterThan(firstRun);
  });

  it('shows the last screen when the agent wrote no transcript, and the one-line note once that screen is gone', async () => {
    const m = manager();
    const { id } = m.start({ cwd: work, command: 'opencode' });
    await exited(m, id);
    expect(Buffer.from((await m.readTail(id, 1 << 20)).data).toString()).toContain('OPENCODE-SCREEN');
    rmSync(join(base, 'sessions', id, 'tail.log'), { force: true });
    expect(Buffer.from((await m.readTail(id, 1 << 20)).data).toString()).toMatch(/^\(no transcript yet/);
  });
});

async function api(m: SessionManager): Promise<(path: string) => Promise<{ body: string; headers: http.IncomingHttpHeaders }>> {
  const server = createApiServer({ service: m, token: TOKEN, version: 't', startedAt: '2026-01-01T00:00:00.000Z' });
  servers.push(server);
  const port = await listenOnLoopback(server);
  expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  return (path) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk: Buffer) => parts.push(chunk));
          res.on('end', () => resolve({ body: Buffer.concat(parts).toString(), headers: res.headers }));
        })
        .on('error', reject);
    });
}

describe('an agent session from before native transcripts', () => {
  // Such a session has an output.log and no transcript file; its raw log is the only history there is.
  const OLD_LOG = '\x1b[1mold\x1b[0m line\r\nsecond\r\n';
  const dropTranscript = (id: string): void => {
    const sid = readMeta(id).claude?.sessionId ?? '';
    for (const dir of projectDirs(config, work)) rmSync(join(dir, `${sid}.jsonl`), { force: true });
  };

  it('shows the old output.log when there is no transcript, raw in the pane and stripped as text', async () => {
    const m = manager();
    const get = await api(m);
    const id = claude(m);
    await exited(m, id);
    dropTranscript(id);
    rmSync(join(base, 'sessions', id, 'tail.log'), { force: true });
    writeFileSync(join(base, 'sessions', id, 'output.log'), OLD_LOG);

    const tail = await m.readTail(id, 1 << 20);
    expect(tail.source).toBe('log');
    expect(Buffer.from(tail.data).toString()).toBe(OLD_LOG);
    expect((await get(`/sessions/${id}/text`)).body).toBe('old line\nsecond\n');
    expect((await get(`/sessions/${id}/output`)).body).toBe(OLD_LOG);
    expect(readFileSync(join(base, 'sessions', id, 'output.log'), 'utf8')).toBe(OLD_LOG);
    expect(files(id)).toEqual(['meta.json', 'output.log']);
  });

  it('keeps the one-line note when there is neither a transcript nor a log', async () => {
    const m = manager();
    const get = await api(m);
    const id = claude(m);
    await exited(m, id);
    dropTranscript(id);
    rmSync(join(base, 'sessions', id, 'tail.log'), { force: true });

    expect(Buffer.from((await m.readTail(id, 1 << 20)).data).toString()).toMatch(/^\(no transcript yet/);
    expect((await get(`/sessions/${id}/text`)).body).toMatch(/^\(no transcript yet/);
    expect(files(id)).toEqual(['meta.json']);
  });

  it('a shell session with an output.log is unchanged', async () => {
    const m = manager();
    const get = await api(m);
    const shell = m.start({ cwd: work, command: 'sh', args: ['-c', 'printf "\\033[1mhi\\033[0m\\r\\n"'] }).id;
    await exited(m, shell);
    expect((await get(`/sessions/${shell}/text`)).body).toBe('hi\n');
    expect((await m.readTail(shell, 1 << 20)).source).toBe('log');
  });
});

describe('/text and /output', () => {
  it('serves the transcript for an agent session and the ANSI-stripped log for a shell session', async () => {
    const m = manager();
    const get = await api(m);
    const agent = claude(m);
    const shell = m.start({ cwd: work, command: 'sh', args: ['-c', 'printf "\\033[1;34mdir\\033[0m\\r\\nfile\\r\\n"'] }).id;
    await exited(m, agent);
    await exited(m, shell);

    const transcript = '── user ──\nwhat is 2+2\n\n── assistant ──\nIt is 4.\n';
    const agentText = await get(`/sessions/${agent}/text`);
    expect(agentText.body).toBe(transcript);
    expect(agentText.headers['x-total-bytes']).toBe(String(Buffer.byteLength(transcript)));
    expect(agentText.headers['content-type']).toContain('text/plain');
    expect((await get(`/sessions/${agent}/text?offset=${Buffer.byteLength('── user ──\n')}`)).body).toBe(transcript.slice('── user ──\n'.length));

    const shellText = await get(`/sessions/${shell}/text`);
    expect(shellText.body).toBe('dir\nfile\n');
    expect(shellText.body).not.toContain('\x1b');
  });

  it('GET /output returns the rendered transcript bytes for an agent session and the raw log for a shell session', async () => {
    const m = manager();
    const get = await api(m);
    const agent = claude(m);
    const shell = m.start({ cwd: work, command: 'sh', args: ['-c', 'printf "\\033[1mraw\\033[0m"'] }).id;
    await exited(m, agent);
    await exited(m, shell);

    const transcript = '── user ──\nwhat is 2+2\n\n── assistant ──\nIt is 4.\n';
    const output = await get(`/sessions/${agent}/output`);
    expect(output.body).toBe(transcript);
    expect(output.headers['x-total-bytes']).toBe(String(Buffer.byteLength(transcript)));
    expect((await get(`/sessions/${agent}/output?offset=${Buffer.byteLength('── user ──\n')}&limit=11`)).body).toBe('what is 2+2');
    expect((await get(`/sessions/${shell}/output`)).body).toContain('\x1b[1mraw');
  });
});
