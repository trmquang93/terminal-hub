import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '../src/shared/types';
import { KEEP_LINES, SessionStore, TRIM_AFTER_LINES } from '../src/main/sessionStore';

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
    archived: false,
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

  it('defaults archived to false for a meta.json written before the flag existed', () => {
    store.create(meta(A, { state: 'exited' }));
    const legacy = JSON.parse(readFileSync(join(root, A, 'meta.json'), 'utf8')) as Partial<SessionMeta>;
    delete legacy.archived;
    writeFileSync(join(root, A, 'meta.json'), JSON.stringify(legacy));
    expect(new SessionStore(root).loadAll()[0]?.archived).toBe(false);
  });

  it('keeps archived across a reload', () => {
    store.create(meta(A, { state: 'exited', archived: true }));
    store.create(meta(B, { state: 'exited' }));
    const loaded = new SessionStore(root).loadAll();
    expect(loaded.map((s) => [s.id, s.archived])).toEqual([[A, true], [B, false]]);
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

  describe('output.log cap', () => {
    const lines = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('');
    const onDisk = (): string => readFileSync(join(root, A, 'output.log'), 'utf8');

    it('keeps exactly the last KEEP_LINES complete lines once the file passes TRIM_AFTER_LINES', () => {
      store.create(meta(A));
      store.appendOutput(A, Buffer.from(lines(1, TRIM_AFTER_LINES + 50)));
      store.flush(A);
      expect(onDisk()).toBe(lines(TRIM_AFTER_LINES + 50 - KEEP_LINES + 1, TRIM_AFTER_LINES + 50));
    });

    it('does not rewrite at TRIM_AFTER_LINES, only past it', () => {
      store.create(meta(A));
      store.appendOutput(A, Buffer.from(lines(1, TRIM_AFTER_LINES)));
      store.flush(A);
      expect(onDisk()).toBe(lines(1, TRIM_AFTER_LINES));
      store.appendOutput(A, Buffer.from(lines(TRIM_AFTER_LINES + 1, TRIM_AFTER_LINES + 1)));
      store.flush(A);
      expect(onDisk()).toBe(lines(TRIM_AFTER_LINES + 2 - KEEP_LINES, TRIM_AFTER_LINES + 1));
    });

    it('leaves no partial first line and drops a partial tail fragment', () => {
      store.create(meta(A));
      store.appendOutput(A, Buffer.from(`${lines(1, TRIM_AFTER_LINES + 10)}par`));
      store.flush(A);
      expect(onDisk()).toBe(lines(TRIM_AFTER_LINES + 10 - KEEP_LINES + 1, TRIM_AFTER_LINES + 10));
    });

    it('counts lines across flushes and trims when the running total passes the limit', () => {
      store.create(meta(A));
      for (let i = 1; i <= TRIM_AFTER_LINES + 1; i++) {
        store.appendOutput(A, Buffer.from(lines(i, i)));
        store.flush(A);
      }
      expect(onDisk()).toBe(lines(TRIM_AFTER_LINES + 2 - KEEP_LINES, TRIM_AFTER_LINES + 1));
    });

    it('trims an oversized log left by an earlier version on the next flush, in bounded reads', () => {
      store.create(meta(A));
      writeFileSync(join(root, A, 'output.log'), lines(1, 50000));
      store.appendOutput(A, Buffer.from(lines(50001, 50001)));
      store.flush(A);
      expect(onDisk()).toBe(lines(50001 - KEEP_LINES + 1, 50001));
    });

    it('keeps live offsets increasing and correct across a trim: the next read is exactly the new output', async () => {
      store.create(meta(A));
      const first = lines(1, 300);
      let sent = store.appendOutput(A, Buffer.from(first));
      expect(sent).toBe(first.length);
      expect((await store.readOutput(A, 0, sent)).toString()).toBe(first);

      // This append crosses TRIM_AFTER_LINES, so the flush inside readChunks trims the file.
      const second = lines(301, 450);
      const end = store.appendOutput(A, Buffer.from(second));
      expect(end).toBe(sent + second.length);
      let got = '';
      for await (const data of store.readChunks(A, sent, store.size(A))) got += data.toString();
      expect(got).toBe(second);
      expect(onDisk()).toBe(lines(451 - KEEP_LINES, 450));
      expect(store.size(A)).toBe(end);
      expect(store.startOffset(A)).toBe(end - onDisk().length);
      sent = end;

      // Output after the trim continues from the same offset: nothing replayed, nothing skipped.
      const third = lines(451, 460);
      const after = store.appendOutput(A, Buffer.from(third));
      expect(after).toBe(sent + third.length);
      expect((await store.readOutput(A, sent)).toString()).toBe(third);
      expect(onDisk()).toBe(lines(451 - KEEP_LINES, 460));

      // An offset from before the trim only gets what survives of it.
      expect((await store.readOutput(A, 0)).toString()).toBe(onDisk());
      store.close(A);
      expect(store.size(A)).toBe(after);
      store.appendOutput(A, Buffer.from('x\n'));
      expect(store.size(A)).toBe(after + 2);
    });

    it('keeps a trimmed log readable after a restart', async () => {
      store.create(meta(A, { state: 'exited' }));
      store.appendOutput(A, Buffer.from(lines(1, 500)));
      store.close(A);
      const reopened = new SessionStore(root);
      expect(reopened.loadAll()[0]?.bytesWritten).toBe(lines(501 - KEEP_LINES, 500).length);
      expect((await reopened.readOutput(A)).toString()).toBe(lines(501 - KEEP_LINES, 500));
    });

    it('never writes input.log or any file but meta.json and output.log for a shell, and only meta.json for an agent', () => {
      store.create(meta(A));
      store.appendOutput(A, Buffer.from(lines(1, 500)));
      store.close(A);
      expect(readdirSync(join(root, A)).sort()).toEqual(['meta.json', 'output.log']);
      const agent = { provider: 'claude' as const, configDir: '/tmp', sessionId: null, argvTemplate: [], resumeCommand: '' };
      store.create(meta(B, { claude: agent }));
      store.writeMeta(meta(B, { claude: agent, title: 'renamed' }));
      expect(readdirSync(join(root, B))).toEqual(['meta.json']);
    });
  });
});
