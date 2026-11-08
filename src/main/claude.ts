import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ClaudeInfo } from '../shared/types';

export const SESSION_PLACEHOLDER = '{{sessionId}}';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const WRAPPERS = new Set(['env', 'npx', 'pnpx', 'bunx', 'pnpm', 'yarn', 'npm', 'dlx', 'exec', 'command']);
const PACKAGE_FLAGS = new Set(['-p', '--package']);
const SESSION_FLAGS = new Set(['--session-id', '--resume', '-r']);
const CONTINUE_FLAGS = new Set(['--continue', '-c']);

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isClaudeName(token: string): boolean {
  const name = basename(token);
  return name === 'claude' || name === 'claude-code';
}

/**
 * Index of the Claude Code token in [command, ...args], or -1. Only leading
 * wrapper tokens (env, npx, VAR=value, flags) may precede it, so
 * `echo claude` is not a match.
 */
export function findClaudeIndex(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    const previous = argv[i - 1] ?? '';
    if (isClaudeName(token) && !PACKAGE_FLAGS.has(previous)) return i;
    const skippable = i === 0 ? WRAPPERS.has(basename(token)) : token.startsWith('-') || ASSIGNMENT_RE.test(token) || WRAPPERS.has(token) || PACKAGE_FLAGS.has(previous);
    if (!skippable) return -1;
  }
  return -1;
}

function assignmentsBefore(argv: readonly string[], end: number): Record<string, string> {
  const found: Record<string, string> = {};
  for (const token of argv.slice(0, end)) {
    const match = ASSIGNMENT_RE.exec(token);
    if (match?.[1] !== undefined) found[match[1]] = match[2] ?? '';
  }
  return found;
}

export function resolveConfigDir(argv: readonly string[], claudeIndex: number, env: Record<string, string | undefined>): string {
  return assignmentsBefore(argv, claudeIndex).CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function shellQuote(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`;
}

export function renderCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

export interface ClaudeLaunch {
  /** Args to spawn with (the original args, plus --session-id when injected). */
  args: string[];
  /** Env overrides to record so a resume runs with the exact same config dir. */
  env: Record<string, string>;
  claude: ClaudeInfo;
}

/**
 * Plans a launch of Claude Code: injects `--session-id <uuid>` so the id is
 * known up front. Returns null when the argv does not run Claude Code.
 */
export function planClaudeLaunch(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  processEnv: Record<string, string | undefined>,
  newId: () => string = randomUUID,
): ClaudeLaunch | null {
  const argv = [command, ...args];
  const claudeIndex = findClaudeIndex(argv);
  if (claudeIndex < 0) return null;

  const mergedEnv = { ...processEnv, ...env };
  const configDir = resolveConfigDir(argv, claudeIndex, mergedEnv);
  const pinned = { ...env };
  const inheritedDir = processEnv.CLAUDE_CONFIG_DIR;
  if (inheritedDir && pinned.CLAUDE_CONFIG_DIR === undefined && assignmentsBefore(argv, claudeIndex).CLAUDE_CONFIG_DIR === undefined) {
    pinned.CLAUDE_CONFIG_DIR = inheritedDir;
  }

  // Strip session flags (and their values) from what follows the claude token.
  const before = argv.slice(0, claudeIndex + 1);
  const after = argv.slice(claudeIndex + 1);
  const kept: string[] = [];
  let sessionId: string | null = null;
  let continuing = false;
  let userResumed = false;
  for (let i = 0; i < after.length; i++) {
    const token = after[i] ?? '';
    const [flag, inline] = token.startsWith('--') ? (token.split(/=(.*)/s) as [string, string | undefined]) : [token, undefined];
    if (SESSION_FLAGS.has(flag)) {
      const value = inline ?? after[++i] ?? '';
      if (isUuid(value)) {
        sessionId = value;
        userResumed = flag !== '--session-id';
      } else if (flag !== '--session-id') continuing = true;
      continue;
    }
    if (CONTINUE_FLAGS.has(flag)) {
      continuing = true;
      continue;
    }
    kept.push(token);
  }

  const template = [...before, '--resume', SESSION_PLACEHOLDER, ...kept];
  sessionId ??= continuing ? null : newId();
  const launchArgs = sessionId === null || userResumed ? [...args] : [...before.slice(1), '--session-id', sessionId, ...kept];
  return {
    args: launchArgs,
    env: pinned,
    claude: { configDir, sessionId, argvTemplate: template, resumeCommand: sessionId === null ? '' : renderCommand(fillTemplate(template, sessionId)) },
  };
}

export function fillTemplate(template: readonly string[], sessionId: string): string[] {
  return template.map((token) => (token === SESSION_PLACEHOLDER ? sessionId : token));
}

/** Claude Code names project dirs after the real cwd with non-alphanumerics replaced by `-`. */
export function encodeCwd(cwd: string): string {
  return cwd.replaceAll(/[^A-Za-z0-9]/g, '-');
}

function projectDirs(configDir: string, cwd: string): string[] {
  const candidates = [cwd];
  try {
    candidates.push(realpathSync(cwd));
  } catch {
    // cwd gone: only the literal path is searched
  }
  return [...new Set(candidates.map((dir) => join(configDir, 'projects', encodeCwd(dir))))];
}

/** True once Claude Code has written a transcript for this session (it does so after the first turn). */
export function transcriptExists(configDir: string, cwd: string, sessionId: string): boolean {
  return projectDirs(configDir, cwd).some((dir) => existsSync(join(dir, `${sessionId}.jsonl`)));
}

/**
 * Newest transcript in the project dir touched since `since` (ms epoch),
 * preferring files created after it. Returns the uuid, or null.
 */
export function discoverSessionId(configDir: string, cwd: string, since: number, exclude: ReadonlySet<string>): string | null {
  const found: { id: string; birth: number; mtime: number }[] = [];
  for (const dir of projectDirs(configDir, cwd)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
      if (!isUuid(id) || exclude.has(id)) continue;
      const stat = statSync(join(dir, name));
      if (stat.mtimeMs >= since) found.push({ id, birth: stat.birthtimeMs, mtime: stat.mtimeMs });
    }
  }
  const created = found.filter((file) => file.birth >= since);
  const pool = created.length > 0 ? created : found;
  pool.sort((a, b) => b.mtime - a.mtime);
  return pool[0]?.id ?? null;
}
