import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentInfo } from '../shared/types';

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
 * Index of the first token in [command, ...args] whose name `isName` accepts, or -1.
 * Only leading wrapper tokens (env, npx, VAR=value, flags) may precede it, so
 * `echo claude` is not a match.
 */
export function findCommandIndex(argv: readonly string[], isName: (token: string) => boolean): number {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    const previous = argv[i - 1] ?? '';
    if (isName(token) && !PACKAGE_FLAGS.has(previous)) return i;
    const skippable = i === 0 ? WRAPPERS.has(basename(token)) : token.startsWith('-') || ASSIGNMENT_RE.test(token) || WRAPPERS.has(token) || PACKAGE_FLAGS.has(previous);
    if (!skippable) return -1;
  }
  return -1;
}

/** Index of the Claude Code token in [command, ...args], or -1. */
export function findClaudeIndex(argv: readonly string[]): number {
  return findCommandIndex(argv, isClaudeName);
}

export function assignmentsBefore(argv: readonly string[], end: number): Record<string, string> {
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

/** Tokens after the claude token, up to a `--` terminator. */
function flagTokens(argv: readonly string[], claudeIndex: number): readonly string[] {
  const rest = argv.slice(claudeIndex + 1);
  const end = rest.indexOf('--');
  return end < 0 ? rest : rest.slice(0, end);
}

/** True when the person already passed `--settings` (or `--settings=…`) to Claude Code. */
export function hasSettingsFlag(argv: readonly string[], claudeIndex: number): boolean {
  return flagTokens(argv, claudeIndex).some((token) => token === '--settings' || token.startsWith('--settings='));
}

/** `argv` with `--settings <file>` added after Claude's other flags (before a `--` terminator, so it stays a flag). */
export function withSettings(argv: readonly string[], claudeIndex: number, file: string): string[] {
  const end = argv.indexOf('--', claudeIndex + 1);
  const at = end < 0 ? argv.length : end;
  return [...argv.slice(0, at), '--settings', file, ...argv.slice(at)];
}

export interface ClaudeLaunch {
  /** Args to spawn with (the original args, plus --session-id and --settings when injected). */
  args: string[];
  /** True when hub's hook settings were not added because the argv already has its own --settings. */
  settingsSkipped: boolean;
  /** Env overrides to record so a resume runs with the exact same config dir. */
  env: Record<string, string>;
  claude: AgentInfo;
}

/**
 * Plans a launch of Claude Code: injects `--session-id <uuid>` so the id is
 * known up front, and `--settings <settingsFile>` (hub's hooks) unless the argv has its own.
 * Returns null when the argv does not run Claude Code.
 */
export function planClaudeLaunch(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  processEnv: Record<string, string | undefined>,
  newId: () => string = randomUUID,
  settingsFile?: string,
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

  let template = [...before, '--resume', SESSION_PLACEHOLDER, ...kept];
  sessionId ??= continuing ? null : newId();
  let launchArgs = sessionId === null || userResumed ? [...args] : [...before.slice(1), '--session-id', sessionId, ...kept];
  const settingsSkipped = settingsFile !== undefined && hasSettingsFlag(argv, claudeIndex);
  if (settingsFile !== undefined && !settingsSkipped) {
    template = withSettings(template, claudeIndex, settingsFile);
    launchArgs = withSettings([command, ...launchArgs], claudeIndex, settingsFile).slice(1);
  }
  return {
    args: launchArgs,
    settingsSkipped,
    env: pinned,
    claude: { provider: 'claude', configDir, sessionId, argvTemplate: template, resumeCommand: sessionId === null ? '' : renderCommand(fillTemplate(template, sessionId)) },
  };
}

export function fillTemplate(template: readonly string[], sessionId: string): string[] {
  return template.map((token) => (token === SESSION_PLACEHOLDER ? sessionId : token));
}

/** Claude Code names project dirs after the real cwd with non-alphanumerics replaced by `-`. */
export function encodeCwd(cwd: string): string {
  return cwd.replaceAll(/[^A-Za-z0-9]/g, '-');
}

export function projectDirs(configDir: string, cwd: string): string[] {
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
