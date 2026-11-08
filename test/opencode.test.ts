import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fillTemplate } from '../src/main/claude';
import { discoverOpencodeSessionId, findOpencodeIndex, opencodeSessionExists, planOpencodeLaunch } from '../src/main/opencode';
import { SessionStore } from '../src/main/sessionStore';

const ID = 'ses_2a1b3c4d5eAbCdEfGhIjKlMnOp';
const OTHER = 'ses_9z8y7x6w5vUtSrQpOnMlKjIhGf';
const plan = (command: string, args: string[], env: Record<string, string> = {}, processEnv: Record<string, string> = {}) => planOpencodeLaunch(command, args, env, processEnv);

describe('findOpencodeIndex', () => {
  it.each([
    [['opencode'], 0],
    [['/Users/me/.opencode/bin/opencode', 'run', 'hi'], 0],
    [['env', 'FOO=1', 'opencode', '-m', 'x'], 2],
    [['npx', '-y', 'opencode-ai'], 2],
    [['npx', 'opencode-ai', '--help'], 1],
    [['npx', '-p', 'opencode-ai', 'opencode'], 3],
    [['echo', 'opencode'], -1],
    [['sh', '-c', 'opencode'], -1],
    [['claude'], -1],
  ])('%j → %i', (argv, expected) => expect(findOpencodeIndex(argv)).toBe(expected));
});

describe('planOpencodeLaunch', () => {
  it('injects nothing on a fresh launch and leaves the id for discovery', () => {
    const launch = plan('opencode', ['--model', 'x'], {}, { HOME: '/home/me' });
    expect(launch?.args).toEqual(['--model', 'x']);
    expect(launch?.claude).toMatchObject({
      provider: 'opencode',
      sessionId: null,
      configDir: '/home/me/.local/share/opencode',
      argvTemplate: ['opencode', '--session', '{{sessionId}}', '--model', 'x'],
      resumeCommand: '',
    });
  });

  it('returns null for commands that do not run opencode', () => {
    expect(plan('zsh', ['-l'])).toBeNull();
    expect(plan('echo', ['opencode'])).toBeNull();
  });

  it('inserts --session right after the opencode token, also behind wrappers and for `opencode run`', () => {
    expect(plan('env', ['A=1', 'opencode', 'run', 'hi'])?.claude.argvTemplate).toEqual(['env', 'A=1', 'opencode', '--session', '{{sessionId}}', 'run', 'hi']);
    expect(plan('/x/opencode', ['run', '--model', 'm', 'hi'])?.claude.argvTemplate).toEqual(['/x/opencode', '--session', '{{sessionId}}', 'run', '--model', 'm', 'hi']);
  });

  it('fills the template into a resume command', () => {
    const template = plan('opencode', ['run', 'hi'])?.claude.argvTemplate ?? [];
    expect(fillTemplate(template, ID)).toEqual(['opencode', '--session', ID, 'run', 'hi']);
  });

  it.each([
    [['-s', ID, '--model', 'x'], ID],
    [['--session', ID, '--model', 'x'], ID],
    [[`--session=${ID}`, '--model', 'x'], ID],
    [['--continue', '--model', 'x'], null],
    [['-c', '--model', 'x'], null],
    [['-s', 'not-an-id', '--model', 'x'], null],
    [['--session=', '--model', 'x'], null],
  ])('strips session flags from the template: %j → id %s', (args, id) => {
    const launch = plan('opencode', args);
    expect(launch?.claude.sessionId).toBe(id);
    expect(launch?.claude.argvTemplate).toEqual(['opencode', '--session', '{{sessionId}}', '--model', 'x']);
    expect(launch?.args).toEqual(args);
    expect(launch?.claude.resumeCommand).toBe(id === null ? '' : `opencode --session ${id} --model x`);
  });

  it('resolves the data dir from XDG_DATA_HOME: inline assignment, then env, then process env, then HOME', () => {
    expect(plan('env', ['XDG_DATA_HOME=/a', 'opencode'], { XDG_DATA_HOME: '/b' }, { XDG_DATA_HOME: '/c' })?.claude.configDir).toBe('/a/opencode');
    expect(plan('opencode', [], { XDG_DATA_HOME: '/b' }, { XDG_DATA_HOME: '/c' })?.claude.configDir).toBe('/b/opencode');
    expect(plan('opencode', [], {}, { XDG_DATA_HOME: '/c', HOME: '/h' })?.claude.configDir).toBe('/c/opencode');
    expect(plan('opencode', [], {}, { HOME: '/h' })?.claude.configDir).toBe('/h/.local/share/opencode');
  });

  it('pins an inherited XDG_DATA_HOME into the recorded env, but not when unset', () => {
    expect(plan('opencode', [], {}, { XDG_DATA_HOME: '/c' })?.env).toEqual({ XDG_DATA_HOME: '/c' });
    expect(plan('opencode', [], {}, {})?.env).toEqual({});
  });
});

const hasSqlite = spawnSync('sqlite3', ['-version']).status === 0;

describe.skipIf(!hasSqlite)('opencode session discovery', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function fixture(rows: string[]): { dataDir: string; cwd: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'thub-oc-')));
    dirs.push(base);
    const dataDir = join(base, 'opencode');
    mkdirSync(dataDir);
    const cwd = join(base, "it's work");
    mkdirSync(cwd);
    const sql = ['CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text, title text, time_created integer, time_archived integer);', ...rows.map((row) => row.replaceAll('$CWD', cwd.replaceAll("'", "''")))].join('\n');
    execFileSync('sqlite3', [join(dataDir, 'opencode.db')], { input: sql });
    return { dataDir, cwd };
  }

  const row = (id: string, fields: { parent?: string; dir?: string; created: number; archived?: number }): string =>
    `INSERT INTO session VALUES ('${id}', ${fields.parent ? `'${fields.parent}'` : 'NULL'}, '${fields.dir ?? '$CWD'}', 't', ${fields.created}, ${fields.archived ?? 'NULL'});`;

  it('returns null when the database is missing', () => {
    expect(discoverOpencodeSessionId('/nonexistent/opencode', '/tmp', 0, new Set())).toBeNull();
    expect(opencodeSessionExists('/nonexistent/opencode', ID)).toBe(false);
  });

  it('picks the newest top-level session in the cwd created since the start', () => {
    const { dataDir, cwd } = fixture([row(OTHER, { created: 1000 }), row(ID, { created: 5000 })]);
    expect(discoverOpencodeSessionId(dataDir, cwd, 2000, new Set())).toBe(ID);
    expect(discoverOpencodeSessionId(dataDir, cwd, 0, new Set())).toBe(ID);
  });

  it('ignores subagent, archived, other-directory and too-old sessions', () => {
    const { dataDir, cwd } = fixture([
      row('ses_sub', { parent: ID, created: 9000 }),
      row('ses_archived', { created: 9000, archived: 9500 }),
      row('ses_elsewhere', { dir: '/somewhere/else', created: 9000 }),
      row('ses_old', { created: 100 }),
      row(ID, { created: 5000 }),
    ]);
    expect(discoverOpencodeSessionId(dataDir, cwd, 2000, new Set())).toBe(ID);
  });

  it('skips excluded ids and returns null when nothing is left', () => {
    const { dataDir, cwd } = fixture([row(OTHER, { created: 4000 }), row(ID, { created: 5000 })]);
    expect(discoverOpencodeSessionId(dataDir, cwd, 0, new Set([ID]))).toBe(OTHER);
    expect(discoverOpencodeSessionId(dataDir, cwd, 0, new Set([ID, OTHER]))).toBeNull();
    expect(discoverOpencodeSessionId(dataDir, cwd, 6000, new Set())).toBeNull();
  });

  it('matches a session recorded under the real path when the cwd is a symlink', () => {
    const { dataDir, cwd } = fixture([row(ID, { created: 5000 })]);
    const link = join(cwd, '..', 'link');
    symlinkSync(cwd, link);
    expect(discoverOpencodeSessionId(dataDir, link, 0, new Set())).toBe(ID);
  });

  it('reports whether a session is stored', () => {
    const { dataDir } = fixture([row(ID, { created: 5000 })]);
    expect(opencodeSessionExists(dataDir, ID)).toBe(true);
    expect(opencodeSessionExists(dataDir, OTHER)).toBe(false);
    expect(opencodeSessionExists(dataDir, "ses_x'; DROP TABLE session; --")).toBe(false);
  });

  it('returns null instead of throwing on a corrupt database', () => {
    const { dataDir, cwd } = fixture([]);
    writeFileSync(join(dataDir, 'opencode.db'), 'not a database');
    expect(discoverOpencodeSessionId(dataDir, cwd, 0, new Set())).toBeNull();
    expect(opencodeSessionExists(dataDir, ID)).toBe(false);
  });
});

describe('SessionStore — provider on disk', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function load(claude: Record<string, unknown> | null): ReturnType<SessionStore['loadAll']>[number] | undefined {
    const root = mkdtempSync(join(tmpdir(), 'thub-oc-store-'));
    dirs.push(root);
    const id = '33333333-3333-4333-8333-333333333333';
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, 'meta.json'), JSON.stringify({ id, state: 'exited', endedAt: '2026-01-01T00:00:00.000Z', command: 'claude', claude }));
    return new SessionStore(root).loadAll()[0];
  }

  it('loads an old meta.json without a provider as claude', () => {
    const claude = { configDir: '/cfg', sessionId: '9b2f6c1e-4d1a-4c55-9a0e-0d3f6b7a1c11', argvTemplate: ['claude', '--resume', '{{sessionId}}'], resumeCommand: 'claude --resume x' };
    expect(load(claude)?.claude).toEqual({ ...claude, provider: 'claude' });
  });

  it('keeps an opencode provider and a null agent slot', () => {
    expect(load({ provider: 'opencode', configDir: '/d', sessionId: null, argvTemplate: [], resumeCommand: '' })?.claude?.provider).toBe('opencode');
    expect(load(null)?.claude).toBeNull();
  });
});
