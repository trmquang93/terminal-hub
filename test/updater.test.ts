import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aheadText,
  parseRepoState,
  parseUpdateConfig,
  readInstalledCommit,
  resolveUpdateConfig,
  shouldInstall,
  Updater,
  type GateInput,
  type RepoState,
  type RunResult,
  type Runner,
  type UpdaterOptions,
} from '../src/main/updater';

const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

describe('parseUpdateConfig', () => {
  it('applies defaults to an empty object', () => {
    expect(parseUpdateConfig('{}')).toEqual({ ok: true, value: { repo: undefined, branch: 'main', checkMinutes: 5, enabled: true } });
  });

  it('reads every field', () => {
    const text = '{"repo": "/work/terminal-hub", "branch": "release/1.x", "checkMinutes": 15, "enabled": false}';
    expect(parseUpdateConfig(text)).toEqual({ ok: true, value: { repo: '/work/terminal-hub', branch: 'release/1.x', checkMinutes: 15, enabled: false } });
  });

  it.each([
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a relative repo', '{"repo": "terminal-hub"}'],
    ['a non-string repo', '{"repo": 7}'],
    ['a branch that looks like an option', '{"branch": "--upload-pack=x"}'],
    ['a branch with ..', '{"branch": "a..b"}'],
    ['an empty branch', '{"branch": ""}'],
    ['zero minutes', '{"checkMinutes": 0}'],
    ['string minutes', '{"checkMinutes": "5"}'],
    ['non-boolean enabled', '{"enabled": "yes"}'],
  ])('rejects %s', (_name, text) => {
    expect(parseUpdateConfig(text).ok).toBe(false);
  });
});

describe('resolveUpdateConfig', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'thub-update-cfg-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function makeRepo(name: string): string {
    const repo = join(root, name);
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'terminal-hub', scripts: { 'package:app': 'x' } }));
    return repo;
  }
  const dataDir = (): string => {
    const dir = join(root, 'data');
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('prefers update.json repo, then build-info.json, then the working directory', () => {
    const fromFile = makeRepo('from-file');
    const fromInfo = makeRepo('from-info');
    const cwd = makeRepo('cwd');
    const resources = join(root, 'resources');
    mkdirSync(resources);
    writeFileSync(join(resources, 'build-info.json'), JSON.stringify({ repo: fromInfo, commit: SHA, branch: 'main' }));
    const dir = dataDir();

    expect(resolveUpdateConfig({ dataDir: dir, resourcesPath: resources, cwd }).config).toMatchObject({ repo: fromInfo, source: 'build-info.json', branch: 'main', checkMinutes: 5 });
    expect(resolveUpdateConfig({ dataDir: dir, cwd }).config).toMatchObject({ repo: cwd, source: 'cwd' });
    writeFileSync(join(dir, 'update.json'), JSON.stringify({ repo: fromFile, branch: 'dev', checkMinutes: 2 }));
    expect(resolveUpdateConfig({ dataDir: dir, resourcesPath: resources, cwd }).config).toEqual({ repo: fromFile, branch: 'dev', checkMinutes: 2, source: 'update.json' });
  });

  it('falls back to the working directory when build-info points at a repo that is gone', () => {
    const cwd = makeRepo('cwd');
    const resources = join(root, 'resources');
    mkdirSync(resources);
    writeFileSync(join(resources, 'build-info.json'), JSON.stringify({ repo: join(root, 'moved') }));
    expect(resolveUpdateConfig({ dataDir: dataDir(), resourcesPath: resources, cwd }).config?.source).toBe('cwd');
  });

  it('turns off with a warning (never throws) for a bad update.json, a bad explicit repo, or no source at all', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'update.json'), '{nope');
    expect(resolveUpdateConfig({ dataDir: dir, cwd: root })).toMatchObject({ config: null, warning: expect.stringContaining('update.json not valid JSON') as string });
    writeFileSync(join(dir, 'update.json'), JSON.stringify({ repo: join(root, 'missing') }));
    expect(resolveUpdateConfig({ dataDir: dir, cwd: makeRepo('cwd') })).toMatchObject({ config: null, warning: expect.stringContaining('is not a git checkout') as string });
    writeFileSync(join(dir, 'update.json'), JSON.stringify({ repo: root }));
    mkdirSync(join(root, '.git'));
    expect(resolveUpdateConfig({ dataDir: dir, cwd: root }).warning).toContain('has no package.json');
    rmSync(join(dir, 'update.json'));
    expect(resolveUpdateConfig({ dataDir: dir, cwd: join(root, 'nowhere') })).toMatchObject({ config: null, warning: expect.stringContaining('no update source') as string });
  });

  it('turns off quietly when disabled', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'update.json'), JSON.stringify({ enabled: false }));
    expect(resolveUpdateConfig({ dataDir: dir, cwd: makeRepo('cwd') })).toMatchObject({ config: null, info: expect.stringContaining('"enabled": false') as string });
  });
});

describe('parseRepoState', () => {
  it('parses the four git outputs', () => {
    expect(parseRepoState({ head: `${SHA}\n`, branch: 'main\n', porcelain: '', ahead: '3\n' })).toEqual({ head: SHA, branch: 'main', dirty: false, ahead: 3 });
    expect(parseRepoState({ head: SHA, branch: 'main', porcelain: ' M src/a.ts\n?? new.txt\n', ahead: '0' })).toMatchObject({ dirty: true, ahead: 0 });
  });

  it.each([
    ['a short head', { head: 'abc', branch: 'main', porcelain: '', ahead: '1' }],
    ['an empty branch', { head: SHA, branch: '\n', porcelain: '', ahead: '1' }],
    ['a non-numeric ahead', { head: SHA, branch: 'main', porcelain: '', ahead: 'fatal: bad revision' }],
  ])('returns null for %s', (_name, out) => {
    expect(parseRepoState(out)).toBeNull();
  });
});

describe('shouldInstall gating', () => {
  const state: RepoState = { head: SHA, branch: 'main', dirty: false, ahead: 2 };
  const gate = (over: Partial<Omit<GateInput, 'state'>> & { state?: Partial<RepoState> } = {}): ReturnType<typeof shouldInstall> =>
    shouldInstall({ isPackaged: true, running: 0, expectedBranch: 'main', ...over, state: { ...state, ...over.state } });

  it('installs only when packaged, no session runs, clean, on the branch and behind', () => {
    expect(gate().kind).toBe('install');
  });

  it('waits while any session is running', () => {
    expect(gate({ running: 1 })).toEqual({ kind: 'wait', reason: '1 session running' });
    expect(gate({ running: 3 }).kind).toBe('wait');
  });

  it('only logs when the app is not packaged, running sessions or not', () => {
    expect(gate({ isPackaged: false }).kind).toBe('dev');
    expect(gate({ isPackaged: false, running: 2 }).kind).toBe('dev');
  });

  it('does nothing on a dirty tree, the wrong branch, or when up to date', () => {
    expect(gate({ state: { dirty: true } }).kind).toBe('skip');
    expect(gate({ state: { branch: 'feature' } }).kind).toBe('skip');
    expect(gate({ state: { ahead: 0 } })).toEqual({ kind: 'skip', reason: 'up to date' });
  });

  it('a half-finished update proceeds with ahead 0, but still respects every other gate', () => {
    expect(gate({ resume: true, state: { ahead: 0 } }).kind).toBe('install');
    expect(gate({ resume: true, state: { ahead: 0 }, running: 1 }).kind).toBe('wait');
    expect(gate({ resume: true, state: { ahead: 0, dirty: true } }).kind).toBe('skip');
  });
});

describe('shouldInstall installed-build gate', () => {
  const upToDate: RepoState = { head: SHA, branch: 'main', dirty: false, ahead: 0 };
  const gate = (over: Partial<Omit<GateInput, 'state'>> & { state?: Partial<RepoState> } = {}): ReturnType<typeof shouldInstall> =>
    shouldInstall({ isPackaged: true, running: 0, expectedBranch: 'main', ...over, state: { ...upToDate, ...over.state } });

  it('installs when the installed build is older than HEAD, even with nothing new on origin', () => {
    expect(gate({ installedCommit: OLD_SHA })).toEqual({ kind: 'install', reason: 'no session running', detail: 'installed build bbbbbbb != HEAD aaaaaaa' });
  });

  it('still waits for sessions and respects the other gates when the installed build is stale', () => {
    expect(gate({ installedCommit: OLD_SHA, running: 1 })).toMatchObject({ kind: 'wait', reason: '1 session running' });
    expect(gate({ installedCommit: OLD_SHA, state: { dirty: true } }).kind).toBe('skip');
    expect(gate({ installedCommit: OLD_SHA, state: { branch: 'feature' } }).kind).toBe('skip');
    expect(gate({ installedCommit: OLD_SHA, isPackaged: false }).kind).toBe('skip');
  });

  it('skips when the installed build is HEAD and origin has nothing new', () => {
    expect(gate({ installedCommit: SHA })).toEqual({ kind: 'skip', reason: 'up to date' });
  });

  it('skips with a reason when build-info.json is missing', () => {
    expect(gate({ installedCommit: null })).toEqual({ kind: 'skip', reason: expect.stringContaining('build-info.json is missing') as string });
  });

  it('ahead of origin still installs whatever the installed build says', () => {
    expect(gate({ state: { ahead: 2 }, installedCommit: SHA }).kind).toBe('install');
    expect(gate({ state: { ahead: 2 }, installedCommit: null }).kind).toBe('install');
  });
});

describe('readInstalledCommit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'thub-buildinfo-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the commit, and returns null when it is missing, unreadable or not a sha', () => {
    expect(readInstalledCommit(undefined)).toBeNull();
    expect(readInstalledCommit(dir)).toBeNull();
    writeFileSync(join(dir, 'build-info.json'), '{nope');
    expect(readInstalledCommit(dir)).toBeNull();
    writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ commit: 'abc' }));
    expect(readInstalledCommit(dir)).toBeNull();
    writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ repo: '/x', commit: OLD_SHA, branch: 'main' }));
    expect(readInstalledCommit(dir)).toBe(OLD_SHA);
  });
});

describe('aheadText', () => {
  it('names the count', () => {
    expect(aheadText(3)).toBe('update available (3) - waits for idle');
  });
});

// ------------------------------------------------------------- the Updater

describe('Updater', () => {
  let root: string;
  let repo: string;
  let dataDir: string;
  let calls: string[];
  let running: boolean;
  let quit: ReturnType<typeof vi.fn>;
  let spawnHelper: ReturnType<typeof vi.fn>;
  let statuses: string[];
  let overrides: Record<string, Partial<RunResult>>;
  let ahead: string;
  let porcelain: string;

  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const runner: Runner = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    for (const [prefix, result] of Object.entries(overrides)) if (line.startsWith(prefix)) return Promise.resolve({ ...ok(), ...result });
    if (line === 'git rev-parse HEAD') return Promise.resolve(ok(`${SHA}\n`));
    if (line === 'git rev-parse --abbrev-ref HEAD') return Promise.resolve(ok('main\n'));
    if (line === 'git status --porcelain') return Promise.resolve(ok(porcelain));
    if (line.startsWith('git rev-list --count')) return Promise.resolve(ok(ahead));
    return Promise.resolve(ok());
  };

  const makeUpdater = (extra: Partial<UpdaterOptions> = {}): Updater =>
    new Updater({
      manager: { list: () => [{ running }] },
      isPackaged: true,
      dataDir,
      quit: quit as unknown as () => Promise<void>,
      cwd: repo,
      pid: 4242,
      runner,
      spawnHelper: spawnHelper as unknown as UpdaterOptions['spawnHelper'],
      idleMs: 0,
      onStatus: (status) => statuses.push(status.phase),
      ...extra,
    });
  const logText = (): string => readFileSync(join(dataDir, 'update.log'), 'utf8');
  /** Starts the updater, runs one check and one idle poll. */
  async function cycle(updater: Updater): Promise<void> {
    updater.start();
    await updater.check();
    await updater.pollIdle();
    updater.stop();
  }
  const mutating = (): string[] => calls.filter((line) => /^(git pull|npm )/.test(line));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'thub-updater-'));
    repo = join(root, 'repo');
    dataDir = join(root, 'data');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(dataDir);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { 'package:app': 'x' } }));
    mkdirSync(join(repo, 'release', 'mac-arm64', 'Terminal Hub.app'), { recursive: true });
    calls = [];
    statuses = [];
    overrides = {};
    running = false;
    ahead = '2\n';
    porcelain = '';
    quit = vi.fn(() => Promise.resolve());
    spawnHelper = vi.fn();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does not touch anything while a session is running, and logs that it waits', async () => {
    running = true;
    await cycle(makeUpdater());
    expect(mutating()).toEqual([]);
    expect(spawnHelper).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(logText()).toContain('update waiting: 1 session running');
  });

  it.each([
    ['dirty tree', () => (porcelain = ' M a.ts\n')],
    ['ahead 0', () => (ahead = '0\n')],
    ['wrong branch', () => (overrides['git rev-parse --abbrev-ref'] = { stdout: 'feature\n' })],
    ['fetch failure', () => (overrides['git fetch'] = { code: 128, stderr: 'fatal: unable to access https://user:tok3n@host/x.git' })],
  ])('takes no action on %s', async (_name, arrange) => {
    arrange();
    await cycle(makeUpdater());
    expect(mutating()).toEqual([]);
    expect(quit).not.toHaveBeenCalled();
    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it('logs a failed fetch without credentials', async () => {
    overrides['git fetch'] = { code: 128, stderr: 'fatal: unable to access https://user:tok3n@host/x.git' };
    await cycle(makeUpdater());
    expect(logText()).toContain('WARN git fetch origin main exited 128');
    expect(logText()).not.toContain('tok3n');
  });

  it('only logs when the app is not packaged', async () => {
    await cycle(makeUpdater({ isPackaged: false }));
    expect(mutating()).toEqual([]);
    expect(quit).not.toHaveBeenCalled();
    expect(logText()).toContain('update available (2) but not a packaged app; log only');
  });

  it('is off, with one WARN and no exception, when the repo is bad', async () => {
    writeFileSync(join(dataDir, 'update.json'), JSON.stringify({ repo: join(root, 'missing') }));
    const updater = makeUpdater();
    expect(() => updater.start()).not.toThrow();
    await updater.check();
    updater.stop();
    expect(calls).toEqual([]);
    expect(logText().match(/WARN/g)).toHaveLength(1);
    expect(updater.getStatus().phase).toBe('idle');
  });

  describe('installed build vs HEAD (origin has nothing new)', () => {
    let resourcesPath: string;
    const writeInfo = (commit: string): void => writeFileSync(join(resourcesPath, 'build-info.json'), JSON.stringify({ repo, commit, branch: 'main' }));
    beforeEach(() => {
      resourcesPath = join(root, 'resources');
      mkdirSync(resourcesPath);
      ahead = '0\n';
    });

    it('rebuilds and installs when the installed build is stale, and logs why', async () => {
      writeInfo(OLD_SHA);
      await cycle(makeUpdater({ resourcesPath }));
      expect(logText()).toContain('update pending: installed build bbbbbbb != HEAD aaaaaaa');
      expect(mutating()).toEqual(['git pull --ff-only origin main', 'npm run package:app']);
      expect(quit).toHaveBeenCalledTimes(1);
    });

    it('does not install while a session is running', async () => {
      writeInfo(OLD_SHA);
      running = true;
      await cycle(makeUpdater({ resourcesPath }));
      expect(mutating()).toEqual([]);
      expect(quit).not.toHaveBeenCalled();
    });

    it('takes no action when the installed build is HEAD', async () => {
      writeInfo(SHA);
      await cycle(makeUpdater({ resourcesPath }));
      expect(mutating()).toEqual([]);
      expect(quit).not.toHaveBeenCalled();
      expect(logText()).toContain('no action: up to date');
    });

    it('takes no action and logs the reason when build-info.json is missing', async () => {
      await cycle(makeUpdater({ resourcesPath }));
      expect(mutating()).toEqual([]);
      expect(quit).not.toHaveBeenCalled();
      expect(logText()).toContain('no action: installed build-info.json is missing or unreadable');
    });
  });

  describe('dry run', () => {
    it('logs every command in order and executes none of the mutating ones, nor quits', async () => {
      await cycle(makeUpdater({ dryRun: true }));
      expect(mutating()).toEqual([]);
      expect(spawnHelper).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
      const wouldRun = logText()
        .split('\n')
        .filter((line) => line.includes('DRY-RUN'))
        .map((line) => line.replace(/^\S+ INFO /, '').replace(/ \(cwd .*\)$/, ''));
      expect(wouldRun).toEqual([
        'DRY-RUN would run: git pull --ff-only origin main',
        'DRY-RUN would run: npm run package:app',
        'DRY-RUN would verify: ' + join(repo, 'release', 'mac-arm64', 'Terminal Hub.app') + ' exists',
        'DRY-RUN would quit the app (existing shutdown) and spawn one detached /bin/sh that waits up to 30s for pid 4242 to exit',
        'DRY-RUN would run: node scripts/install-app.mjs',
        'DRY-RUN would run: open -a "/Applications/Terminal Hub.app"',
        'DRY-RUN complete: nothing executed, app not quit',
      ]);
    });

    it('adds npm ci when the lockfile differs on origin', async () => {
      overrides['git diff --name-only'] = { stdout: 'package-lock.json\n' };
      await cycle(makeUpdater({ dryRun: true }));
      const lines = logText().split('\n').filter((line) => line.includes('DRY-RUN would run'));
      expect(lines.map((line) => line.replace(/^\S+ INFO DRY-RUN would run: /, '').replace(/ \(cwd .*\)$/, '')).slice(0, 3)).toEqual(['git pull --ff-only origin main', 'npm ci', 'npm run package:app']);
      expect(calls.some((line) => line.startsWith('git diff --name-only HEAD origin/main -- package-lock.json'))).toBe(true);
      expect(mutating()).toEqual([]);
    });
  });

  describe('real run', () => {
    it('pulls, builds, verifies, then hands over to the detached installer and quits', async () => {
      await cycle(makeUpdater());
      expect(mutating()).toEqual(['git pull --ff-only origin main', 'npm run package:app']);
      expect(spawnHelper).toHaveBeenCalledTimes(1);
      const [args] = spawnHelper.mock.calls[0] as [string[]];
      expect(args.slice(2)).toEqual(['terminal-hub-update', '4242', repo, join(dataDir, 'update.log')]);
      expect(args[1]).toContain('node scripts/install-app.mjs');
      expect(args[1]).toContain('open -a "/Applications/Terminal Hub.app"');
      expect(quit).toHaveBeenCalledTimes(1);
      expect(spawnHelper.mock.invocationCallOrder[0]).toBeLessThan(quit.mock.invocationCallOrder[0] ?? 0);
    });

    it('runs npm ci between pull and build when the lockfile changed', async () => {
      overrides['git diff --name-only'] = { stdout: 'package-lock.json\n' };
      await cycle(makeUpdater());
      expect(mutating()).toEqual(['git pull --ff-only origin main', 'npm ci', 'npm run package:app']);
    });

    it('logs command and stderr on a failed build, does not quit, and resumes at the build next time', async () => {
      overrides['npm run package:app'] = { code: 1, stderr: 'boom: tsc failed' };
      const updater = makeUpdater();
      updater.start();
      await updater.check();
      await updater.pollIdle();
      expect(quit).not.toHaveBeenCalled();
      expect(logText()).toContain('ERROR npm run package:app exited 1: boom: tsc failed');
      expect(updater.getStatus()).toMatchObject({ phase: 'error', message: 'update failed' });
      // the pull already happened (ahead is 0 now); the next window must not skip the build
      ahead = '0\n';
      overrides = {};
      calls = [];
      await updater.check();
      await updater.pollIdle();
      updater.stop();
      expect(mutating()).toEqual(['npm run package:app']);
      expect(quit).toHaveBeenCalledTimes(1);
    });

    it('does not install when a session starts during the build, and installs in the next idle window', async () => {
      overrides['npm run package:app'] = { code: 0 };
      const manager = { list: () => [{ running }] };
      const starting: Runner = (cmd, args, options) => {
        if (args[0] === 'run') running = true; // a session starts while package:app runs
        return runner(cmd, args, options);
      };
      const updater = makeUpdater({ manager, runner: starting });
      updater.start();
      await updater.check();
      await updater.pollIdle();
      expect(quit).not.toHaveBeenCalled();
      expect(logText()).toContain('a session started during the update');
      expect(updater.getStatus().phase).toBe('available');
      running = false;
      ahead = '0\n';
      calls = [];
      await updater.pollIdle();
      updater.stop();
      expect(mutating()).toEqual([]); // already built: only the install step is left
      expect(quit).toHaveBeenCalledTimes(1);
    });

    it('fails when package:app succeeds but the bundle is missing', async () => {
      rmSync(join(repo, 'release'), { recursive: true });
      await cycle(makeUpdater());
      expect(quit).not.toHaveBeenCalled();
      expect(logText()).toContain('is missing');
    });

    it('waits for the idle window before updating', async () => {
      let t = 0;
      const updater = makeUpdater({ idleMs: 30_000, now: () => t });
      updater.start();
      await updater.check();
      await updater.pollIdle();
      expect(mutating()).toEqual([]);
      t = 29_000;
      await updater.pollIdle();
      expect(mutating()).toEqual([]);
      running = true;
      t = 40_000;
      await updater.pollIdle(); // a session resets the clock
      running = false;
      t = 41_000;
      await updater.pollIdle();
      t = 70_000;
      await updater.pollIdle();
      expect(mutating()).toEqual([]);
      t = 71_000;
      await updater.pollIdle();
      updater.stop();
      expect(mutating()).toEqual(['git pull --ff-only origin main', 'npm run package:app']);
    });
  });
});
