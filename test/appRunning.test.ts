import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// The package is CommonJS, so tsc rejects a static import of the ESM script (TS1479); load it dynamically.
const load = () => import('../scripts/app-running.mjs');
let isAppRunning: Awaited<ReturnType<typeof load>>['isAppRunning'];
let listProcesses: Awaited<ReturnType<typeof load>>['listProcesses'];

beforeAll(async () => {
  ({ isAppRunning, listProcesses } = await load());
});

const target = '/Applications/Terminal Hub.app';
const main = `${target}/Contents/MacOS/Terminal Hub`;

describe('isAppRunning', () => {
  it('detects the main binary', () => {
    expect(isAppRunning(target, ['/sbin/launchd', main])).toBe(true);
  });

  it('detects a helper process under Contents/Frameworks', () => {
    const helper = `${target}/Contents/Frameworks/Terminal Hub Helper (Renderer).app/Contents/MacOS/Terminal Hub Helper (Renderer)`;
    expect(isAppRunning(target, [helper])).toBe(true);
  });

  it('ignores a development instance (electron . from the repo)', () => {
    const dev = '/Volumes/T7/Projects/terminal-hub/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
    expect(isAppRunning(target, [dev])).toBe(false);
  });

  it('ignores the same app installed at a different location', () => {
    expect(isAppRunning(target, ['/Users/x/Applications/Terminal Hub.app/Contents/MacOS/Terminal Hub'])).toBe(false);
  });

  it('ignores unrelated processes with similar names', () => {
    expect(isAppRunning(target, ['/usr/bin/Terminal Hub', '/Applications/Terminal.app/Contents/MacOS/Terminal', '/Applications/Terminal Hub 2.app/Contents/MacOS/Terminal Hub'])).toBe(false);
  });

  it('does not treat a sibling path that merely starts with the target as running', () => {
    expect(isAppRunning(target, [`${target}.backup/Contents/MacOS/Terminal Hub`])).toBe(false);
  });

  it('matches paths with spaces, dots, dashes and parentheses literally, not as a regex', () => {
    const odd = '/tmp/My Apps (v1.2)/Terminal-Hub.app';
    expect(isAppRunning(odd, [`${odd}/Contents/MacOS/Terminal Hub`])).toBe(true);
    // "." and "(" would match arbitrary characters / groups if the path were used as a regex
    expect(isAppRunning(odd, ['/tmp/My Apps (v1x2)/Terminal-Hub.app/Contents/MacOS/Terminal Hub'])).toBe(false);
    expect(isAppRunning(odd, ['/tmp/My Apps v1.2/Terminal-Hub.app/Contents/MacOS/Terminal Hub'])).toBe(false);
  });

  it('detects a process launched via the real path when the target is reached through a symlink', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'thub-app-link-')));
    try {
      const realApps = join(dir, 'real');
      mkdirSync(join(realApps, 'Terminal Hub.app'), { recursive: true });
      symlinkSync(realApps, join(dir, 'link'));
      const exe = join(realApps, 'Terminal Hub.app', 'Contents', 'MacOS', 'Terminal Hub');
      expect(isAppRunning(join(dir, 'link', 'Terminal Hub.app'), [exe])).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a trailing slash on the target', () => {
    expect(isAppRunning(`${target}/`, [main])).toBe(true);
  });

  it('is false for an empty process list', () => {
    expect(isAppRunning(target, [])).toBe(false);
  });
});

describe('listProcesses (real ps)', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()?.();
  });

  it('reports a running process by its full path, spaces and symlinked temp dir included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thub-app-running-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const app = join(dir, 'Terminal Hub (test).app');
    const exe = join(app, 'Contents', 'MacOS', 'Terminal Hub');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    copyFileSync('/bin/sleep', exe); // a real Mach-O: a shell script would report /bin/sh as its executable
    execFileSync('codesign', ['--force', '--sign', '-', exe], { stdio: 'ignore' });

    expect(isAppRunning(app, listProcesses())).toBe(false);

    const child = spawn(exe, ['30'], { stdio: 'ignore' });
    cleanup.push(() => child.kill());
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });

    expect(isAppRunning(app, listProcesses())).toBe(true);
    expect(isAppRunning(`${app}.backup`, listProcesses())).toBe(false);

    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    expect(isAppRunning(app, listProcesses())).toBe(false);
  });
});
