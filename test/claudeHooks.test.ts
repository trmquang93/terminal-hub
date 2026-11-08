import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHookSettings, createHookRefresher, HOOK_EVENTS, hooksFilePath, resolveHookCommand, writeHookSettings } from '../src/main/claudeHooks';

let base: string;
beforeEach(() => void (base = mkdtempSync(join(tmpdir(), 'thub-hooks-'))));
afterEach(() => rmSync(base, { recursive: true, force: true }));

function executable(...parts: string[]): string {
  const path = join(base, ...parts);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

function plain(...parts: string[]): string {
  const path = join(base, ...parts);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  return path;
}

describe('resolveHookCommand', () => {
  it('prefers the Homebrew launcher when it is executable', () => {
    const hub = executable('brew', 'hub');
    plain('repo', 'build', 'hub', 'hub.cjs');
    expect(resolveHookCommand({ homebrewHub: hub, repoRoot: join(base, 'repo'), searchPath: join(base, 'bin') })).toEqual([hub, 'hook-notify']);
  });

  it('then the packaged app\'s own copy', () => {
    const packaged = executable('Resources', 'hub', 'hub');
    expect(resolveHookCommand({ homebrewHub: join(base, 'missing'), resourcesPath: join(base, 'Resources'), repoRoot: join(base, 'repo') })).toEqual([packaged, 'hook-notify']);
  });

  it('then node with the repo bundle build/hub/hub.cjs (build/hub/hub only works inside the .app), then dist/cli/hub.js', () => {
    const node = executable('bin', 'node');
    const options = { homebrewHub: join(base, 'missing'), repoRoot: join(base, 'repo'), searchPath: join(base, 'bin') };
    const dist = plain('repo', 'dist', 'cli', 'hub.js');
    expect(resolveHookCommand(options)).toEqual([node, dist, 'hook-notify']);
    const bundle = plain('repo', 'build', 'hub', 'hub.cjs');
    expect(resolveHookCommand(options)).toEqual([node, bundle, 'hook-notify']);
  });

  it('returns null when nothing usable exists, or node is missing', () => {
    plain('repo', 'dist', 'cli', 'hub.js');
    expect(resolveHookCommand({ homebrewHub: join(base, 'missing'), repoRoot: join(base, 'repo'), searchPath: join(base, 'bin') })).toBeNull();
    expect(resolveHookCommand({ homebrewHub: join(base, 'missing'), repoRoot: join(base, 'empty'), searchPath: join(base, 'bin') })).toBeNull();
  });

  it('does not accept a non-executable launcher', () => {
    const hub = plain('brew', 'hub');
    expect(resolveHookCommand({ homebrewHub: hub, repoRoot: join(base, 'repo') })).toBeNull();
  });
});

describe('buildHookSettings', () => {
  it('has every expected event, each running the hook command; tool events match "*"', () => {
    const settings = buildHookSettings(['/opt/homebrew/bin/hub', 'hook-notify']);
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
    expect(Object.keys(settings.hooks)).toEqual([...HOOK_EVENTS]);
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const [group] = groups as { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[];
      expect(groups).toHaveLength(1);
      expect(group?.hooks).toEqual([{ type: 'command', command: '/opt/homebrew/bin/hub hook-notify', timeout: 5 }]);
      expect(group?.matcher).toBe(event === 'PreToolUse' || event === 'PostToolUse' ? '*' : undefined);
    }
  });

  it('quotes a command path that has spaces', () => {
    const settings = buildHookSettings(['/Applications/My Apps/hub', 'hook-notify']);
    expect(JSON.stringify(settings)).toContain("'/Applications/My Apps/hub' hook-notify");
  });

  it('is an empty hooks object when no command was found', () => {
    expect(buildHookSettings(null)).toEqual({ hooks: {} });
  });
});

describe('writeHookSettings', () => {
  it('writes <dir>/claude-hooks.json as valid JSON, creating the dir, without leaving temp files', () => {
    const dir = join(base, 'data');
    const file = writeHookSettings(dir, ['/x/hub', 'hook-notify']);
    expect(file).toBe(hooksFilePath(dir));
    expect(file).toBe(join(dir, 'claude-hooks.json'));
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> };
    expect(Object.keys(parsed.hooks)).toEqual([...HOOK_EVENTS]);
  });

  it('does not rewrite an unchanged file, and does rewrite a changed one', () => {
    const file = writeHookSettings(base, ['/x/hub', 'hook-notify']);
    const first = statSync(file).mtimeMs;
    const past = new Date(first - 60_000);
    // an identical refresh must leave the file alone, even with an old mtime
    writeFileSync(file, readFileSync(file));
    mkdirSync(join(base, 'x'), { recursive: true });
    writeHookSettings(base, ['/x/hub', 'hook-notify']);
    expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(past.getTime());
    writeHookSettings(base, ['/y/hub', 'hook-notify']);
    expect(readFileSync(file, 'utf8')).toContain('/y/hub hook-notify');
  });
});

describe('createHookRefresher', () => {
  it('writes the file on every call and logs only when the command changes', () => {
    const hub = executable('brew', 'hub');
    const lines: string[] = [];
    const refresh = createHookRefresher(join(base, 'data'), () => ({ homebrewHub: hub, repoRoot: base }), (level, message) => lines.push(`${level} ${message}`));
    const file = refresh();
    refresh();
    expect((JSON.parse(readFileSync(file ?? '', 'utf8')) as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop[0]?.hooks[0]?.command).toBe(`${hub} hook-notify`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^INFO claude hooks: .*claude-hooks\.json runs .*hub hook-notify$/);
  });

  it('with no hub CLI still writes the file (empty hooks), logs a warning and returns the path', () => {
    const lines: string[] = [];
    const refresh = createHookRefresher(join(base, 'data'), () => ({ homebrewHub: join(base, 'missing'), repoRoot: join(base, 'empty'), searchPath: '' }), (level, message) => lines.push(`${level} ${message}`));
    const file = refresh();
    expect(file).toBe(join(base, 'data', 'claude-hooks.json'));
    expect(JSON.parse(readFileSync(file ?? '', 'utf8'))).toEqual({ hooks: {} });
    expect(lines).toEqual([expect.stringMatching(/^WARN claude hooks: no hub CLI found/)]);
  });

  it('never throws: an unwritable data dir is logged and returns null', () => {
    const blocker = plain('file');
    const lines: string[] = [];
    const refresh = createHookRefresher(join(blocker, 'data'), () => ({ homebrewHub: join(base, 'missing'), repoRoot: base }), (level, message) => lines.push(`${level} ${message}`));
    expect(refresh()).toBeNull();
    expect(lines[0]).toMatch(/^WARN claude hooks: could not write/);
  });
});
