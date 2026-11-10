import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** True when the `.git` entry in `dir` is a directory, or a file with a `gitdir:` line (a linked worktree or submodule). */
function hasGitEntry(dir: string): boolean {
  let info;
  try {
    info = statSync(join(dir, '.git'));
  } catch {
    return false;
  }
  if (info.isDirectory()) return true;
  if (!info.isFile()) return false;
  try {
    return readFileSync(join(dir, '.git'), 'utf8').split('\n').some((line) => line.startsWith('gitdir:'));
  } catch {
    return false;
  }
}

/**
 * Identity of the git worktree `cwd` sits in: `git:` plus the real path of the directory holding `.git`.
 * Paths that differ only in spelling or symlinks give the same key. Linked worktrees of one repo get different
 * keys on purpose (the commondir is never followed). Null outside a git repo or when `cwd` does not exist. Not cached.
 */
export function worktreeKey(cwd: string): string | null {
  let current: string;
  try {
    current = realpathSync(cwd);
  } catch {
    return null;
  }
  for (;;) {
    if (hasGitEntry(current)) return `git:${current}`;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
