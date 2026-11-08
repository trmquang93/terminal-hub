import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '../src/shared/types';
import { SessionStore } from '../src/main/sessionStore';

let root: string;
let store: SessionStore;

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
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
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
    signal: null,
    cols: 80,
    rows: 24,
    bytesWritten: 0,
    appVersion: '0.0.0',
    ...overrides,
  };
}

const readMeta = (id: string): SessionMeta => JSON.parse(readFileSync(join(root, id, 'meta.json'), 'utf8')) as SessionMeta;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'thub-store-'));
  store = new SessionStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('SessionStore', () => {
  it('creates a folder with meta.json and appends output', async () => {
    store.create(meta(A));
    store.appendOutput(A, Buffer.from('hello '));
    store.appendOutput(A, Buffer.from('world\n'));
    expect(store.size(A)).toBe(12);
    expect((await store.readOutput(A)).toString()).toBe('hello world\n');
    expect(readMeta(A).id).toBe(A);
  });

  it('writes buffered output to disk within 250 ms without an explicit flush', async () => {
    store.create(meta(A));
    store.appendOutput(A, Buffer.from('late'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(readFileSync(join(root, A, 'output.log'), 'utf8')).toBe('late');
  });

  it('creates an empty output.log up front so a session with no output yet is readable', async () => {
    store.create(meta(A));
    expect(existsSync(join(root, A, 'output.log'))).toBe(true);
    expect((await store.readOutput(A)).length).toBe(0);
    expect(store.size(A)).toBe(0);
  });

  it('reads ranges by offset and limit', async () => {
    store.create(meta(A));
    store.appendOutput(A, Buffer.from('0123456789'));
    expect((await store.readOutput(A, 3, 4)).toString()).toBe('3456');
    expect((await store.readOutput(A, 99)).length).toBe(0);
  });

  it('reloads every session, keeping output intact and appendable', async () => {
    store.create(meta(A, { state: 'exited', endedAt: '2026-01-01T00:01:00.000Z', exitCode: 0 }));
    store.appendOutput(A, Buffer.from('before'));
    store.close(A);
    const reopened = new SessionStore(root);
    const [loaded] = reopened.loadAll();
    expect(loaded).toMatchObject({ id: A, state: 'exited', exitCode: 0, bytesWritten: 6 });
    reopened.appendOutput(A, Buffer.from('+after'));
    expect((await reopened.readOutput(A)).toString()).toBe('before+after');
  });

  it('loads a session recorded as running as interrupted and persists that', () => {
    store.create(meta(A));
    store.appendOutput(A, Buffer.from('x'));
    store.close(A);
    const [loaded] = new SessionStore(root).loadAll();
    expect(loaded?.state).toBe('interrupted');
    expect(loaded?.endedAt).not.toBeNull();
    expect(readMeta(A).state).toBe('interrupted');
  });

  it('never prunes: all sessions come back no matter how old or large', () => {
    for (let i = 0; i < 30; i++) store.create(meta(`${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, { state: 'exited', startedAt: `2001-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }));
    expect(new SessionStore(root).loadAll()).toHaveLength(30);
  });

  it('deletes only the requested session folder', () => {
    store.create(meta(A));
    store.create(meta(B));
    store.delete(A);
    expect(existsSync(join(root, A))).toBe(false);
    expect(existsSync(join(root, B))).toBe(true);
  });

  it('rejects ids that could escape the sessions folder', () => {
    mkdirSync(join(root, '..', 'victim'), { recursive: true });
    writeFileSync(join(root, '..', 'victim', 'keep'), '1');
    expect(() => store.delete('../victim')).toThrow(/invalid session id/);
    expect(existsSync(join(root, '..', 'victim', 'keep'))).toBe(true);
    rmSync(join(root, '..', 'victim'), { recursive: true });
  });
});
