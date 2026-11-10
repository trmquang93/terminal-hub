import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { worktreeKey } from '../src/main/worktree';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });

let base: string;
let main: string;
let linkedA: string;
let linkedB: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'th-worktree-')));
  main = join(base, 'Repo');
  mkdirSync(join(main, 'src', 'deep'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  linkedA = join(base, 'Repo-a');
  linkedB = join(base, 'Repo-b');
  git(main, 'worktree', 'add', '-q', '-b', 'a', linkedA);
  git(main, 'worktree', 'add', '-q', '-b', 'b', linkedB);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('worktreeKey', () => {
  it('gives one key to every spelling of the same worktree: subfolders, dot segments, trailing slash, symlinks', () => {
    const key = worktreeKey(main);
    expect(key).toBe(`git:${main}`);
    expect(worktreeKey(join(main, 'src', 'deep'))).toBe(key);
    expect(worktreeKey(`${main}/src/../src/deep/`)).toBe(key);
    const link = join(base, 'link-to-deep');
    symlinkSync(join(main, 'src', 'deep'), link);
    expect(worktreeKey(link)).toBe(key);
    const linkToRoot = join(base, 'link-to-repo');
    symlinkSync(main, linkToRoot);
    expect(worktreeKey(linkToRoot)).toBe(key);
  });

  it('keeps two linked worktrees of one repo apart, and apart from the main worktree (the commondir is never followed)', () => {
    // each linked worktree really has a commondir pointing at the shared repo; merging by it would block unrelated worktrees
    expect(existsSync(join(main, '.git', 'worktrees', 'Repo-a', 'commondir'))).toBe(true);
    expect(existsSync(join(main, '.git', 'worktrees', 'Repo-b', 'commondir'))).toBe(true);
    const keys = [worktreeKey(main), worktreeKey(linkedA), worktreeKey(linkedB)];
    expect(keys).toEqual([`git:${main}`, `git:${linkedA}`, `git:${linkedB}`]);
    expect(new Set(keys).size).toBe(3);
    mkdirSync(join(linkedA, 'sub'));
    expect(worktreeKey(join(linkedA, 'sub'))).toBe(`git:${linkedA}`);
  });

  it('is null outside a git repo and for a missing folder', () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(worktreeKey(plain)).toBeNull();
    expect(worktreeKey(join(base, 'does-not-exist'))).toBeNull();
  });

  it('ignores a .git file that has no gitdir line and keeps looking upward; reads state fresh every call', () => {
    const odd = join(main, 'odd');
    mkdirSync(odd);
    writeFileSync(join(odd, '.git'), 'not a pointer\n');
    expect(worktreeKey(odd)).toBe(`git:${main}`);
    writeFileSync(join(odd, '.git'), 'gitdir: /somewhere/else\n');
    expect(worktreeKey(odd)).toBe(`git:${odd}`);
  });
});
