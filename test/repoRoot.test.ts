import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/main/repoRoot';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });

let base: string;
let main: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'th-reporoot-')));
  main = join(base, 'Repo');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('findRepoRoot', () => {
  it('returns the repo folder for a normal repo and its subfolders', async () => {
    mkdirSync(join(main, 'src', 'deep'), { recursive: true });
    expect(await findRepoRoot(main)).toBe(main);
    expect(await findRepoRoot(join(main, 'src', 'deep'))).toBe(main);
  });

  it('maps a sibling linked worktree (.git is a file) to the main repo', async () => {
    const wt = join(base, 'Repo-feature');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
    expect(await findRepoRoot(wt)).toBe(main);
    mkdirSync(join(wt, 'sub'));
    expect(await findRepoRoot(join(wt, 'sub'))).toBe(main);
  });

  it('maps a worktree nested in <repo>/.claude/worktrees/<name> to the main repo', async () => {
    const wt = join(main, '.claude', 'worktrees', 'nested');
    git(main, 'worktree', 'add', '-q', '-b', 'nested', wt);
    expect(await findRepoRoot(wt)).toBe(main);
  });

  it('handles a relative gitdir: line in the .git file', async () => {
    const wt = join(base, 'Repo-relative');
    git(main, 'worktree', 'add', '-q', '-b', 'relative', wt);
    writeFileSync(join(wt, '.git'), 'gitdir: ../Repo/.git/worktrees/Repo-relative\n');
    expect(await findRepoRoot(wt)).toBe(main);
  });

  it('falls back to the nearest .git folder when the common dir is not named .git', async () => {
    const sub = join(base, 'Sub');
    mkdirSync(join(base, 'store.git'), { recursive: true });
    mkdirSync(sub);
    writeFileSync(join(sub, '.git'), `gitdir: ${join(base, 'store.git')}\n`);
    expect(await findRepoRoot(sub)).toBe(sub);
  });

  it('falls back to the nearest .git folder when the .git file is unreadable garbage', async () => {
    const bad = join(base, 'Bad');
    mkdirSync(bad);
    writeFileSync(join(bad, '.git'), 'nonsense');
    expect(await findRepoRoot(bad)).toBe(bad);
  });

  it('does not crash for a deleted worktree folder; resolves via an existing ancestor or null', async () => {
    expect(await findRepoRoot(join(main, 'gone', 'away'))).toBe(main);
    expect(await findRepoRoot(join(base, 'never', 'existed'))).toBeNull();
  });

  it('returns null for a cwd outside any repo and for a relative path', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(await findRepoRoot(plain)).toBeNull();
    expect(await findRepoRoot('relative/path')).toBeNull();
  });
});
