import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { assignmentsBefore, findCommandIndex, fillTemplate, renderCommand, SESSION_PLACEHOLDER } from './claude';
import type { AgentInfo } from '../shared/types';

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;
const SESSION_FLAGS = new Set(['--session', '-s']);
const CONTINUE_FLAGS = new Set(['--continue', '-c']);
const SQLITE_TIMEOUT_MS = 3000;
const CANDIDATE_LIMIT = 10;

export function isOpencodeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

function isOpencodeName(token: string): boolean {
  const name = basename(token);
  return name === 'opencode' || name === 'opencode-ai';
}

export function findOpencodeIndex(argv: readonly string[]): number {
  return findCommandIndex(argv, isOpencodeName);
}

export function resolveDataDir(argv: readonly string[], opencodeIndex: number, env: Record<string, string | undefined>): string {
  const base = assignmentsBefore(argv, opencodeIndex).XDG_DATA_HOME ?? env.XDG_DATA_HOME;
  return join(base || join(env.HOME || homedir(), '.local', 'share'), 'opencode');
}

export interface OpencodeLaunch {
    args: string[];
    env: Record<string, string>;
  claude: AgentInfo;
}

export function planOpencodeLaunch(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): OpencodeLaunch | null {
  const argv = [command, ...args];
  const opencodeIndex = findOpencodeIndex(argv);
  if (opencodeIndex < 0) return null;

  const dataDir = resolveDataDir(argv, opencodeIndex, { ...processEnv, ...env });
  const pinned = { ...env };
  const inheritedDir = processEnv.XDG_DATA_HOME;
  if (inheritedDir && pinned.XDG_DATA_HOME === undefined && assignmentsBefore(argv, opencodeIndex).XDG_DATA_HOME === undefined) {
    pinned.XDG_DATA_HOME = inheritedDir;
  }

  const before = argv.slice(0, opencodeIndex + 1);
  const after = argv.slice(opencodeIndex + 1);
  const kept: string[] = [];
  let sessionId: string | null = null;
  for (let i = 0; i < after.length; i++) {
    const token = after[i] ?? '';
    const [flag, inline] = token.startsWith('--') ? (token.split(/=(.*)/s) as [string, string | undefined]) : [token, undefined];
    if (SESSION_FLAGS.has(flag)) {
      const value = inline ?? after[++i] ?? '';
      if (isOpencodeSessionId(value)) sessionId = value;
      continue;
    }
    if (CONTINUE_FLAGS.has(flag)) continue;
    kept.push(token);
  }

  const template = [...before, '--session', SESSION_PLACEHOLDER, ...kept];
  return {
    args: [...args],
    env: pinned,
    claude: { provider: 'opencode', configDir: dataDir, sessionId, argvTemplate: template, resumeCommand: sessionId === null ? '' : renderCommand(fillTemplate(template, sessionId)) },
  };
}

function query(dataDir: string, sql: string): Record<string, unknown>[] | null {
  const db = join(dataDir, 'opencode.db');
  if (!existsSync(db)) return null;
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', db], { input: sql, encoding: 'utf8', timeout: SQLITE_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    return out === '' ? [] : (JSON.parse(out) as Record<string, unknown>[]);
  } catch {
    return null;
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function discoverOpencodeSessionId(dataDir: string, cwd: string, sinceMs: number, exclude: ReadonlySet<string>): string | null {
  const dirs = [...new Set([cwd, realpathOrSelf(cwd)])].map(quote).join(', ');
  const rows = query(
    dataDir,
    `SELECT id FROM session WHERE parent_id IS NULL AND time_archived IS NULL AND directory IN (${dirs}) AND time_created >= ${Math.trunc(sinceMs)} ORDER BY time_created DESC LIMIT ${CANDIDATE_LIMIT};`,
  );
  for (const row of rows ?? []) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (isOpencodeSessionId(id) && !exclude.has(id)) return id;
  }
  return null;
}

export function opencodeSessionExists(dataDir: string, sessionId: string): boolean {
  if (!isOpencodeSessionId(sessionId)) return false;
  return (query(dataDir, `SELECT id FROM session WHERE id = ${quote(sessionId)} LIMIT 1;`)?.length ?? 0) > 0;
}
