import { access, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const exists = (path: string) => access(path).then(() => true, () => false);
const readText = (path: string) => readFile(path, 'utf8').then((s) => s.trim(), () => null);

/** Common git dir of the repo whose `.git` entry sits in `root`; null when it cannot be read. */
async function commonGitDir(root: string): Promise<string | null> {
  const dotGit = join(root, '.git');
  const info = await stat(dotGit).catch(() => null);
  if (!info) return null;
  let gitDir = dotGit;
  if (info.isFile()) {
    const line = (await readText(dotGit))?.split('\n').find((l) => l.startsWith('gitdir:'));
    if (!line) return null;
    gitDir = resolve(root, line.slice('gitdir:'.length).trim());
  }
  const common = await readText(join(gitDir, 'commondir'));
  return common ? resolve(gitDir, common) : gitDir;
}

/**
 * Root of the repository `cwd` belongs to, null outside a repo. Linked worktrees resolve to the main
 * worktree (the parent of the common `.git` dir), so all worktrees of one repo share a key. Falls back
 * to the nearest ancestor holding a `.git` entry when the common dir is unreadable or not named `.git`
 * (submodules, bare or separate-git-dir repos). Pure fs reads; never spawns git.
 */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  if (!isAbsolute(cwd)) return null;
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if (await exists(join(current, '.git'))) {
      const common = await commonGitDir(current).catch(() => null);
      return common && basename(common) === '.git' ? dirname(common) : current;
    }
    if (dirname(current) === current) return null;
  }
}

const cache = new Map<string, string | null>();

/** `findRepoRoot` cached per cwd, nulls included. */
export async function cachedRepoRoot(cwd: string): Promise<string | null> {
  if (cache.has(cwd)) return cache.get(cwd) ?? null;
  const found = await findRepoRoot(cwd);
  cache.set(cwd, found);
  return found;
}
