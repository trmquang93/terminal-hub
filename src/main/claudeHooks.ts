import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { renderCommand } from './claude';

/** Claude Code hook events hub listens to; the same set iTerm2's cc-status uses, plus the subagent and failure ones. */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SubagentStop', 'SubagentStart', 'Notification', 'PermissionRequest', 'SessionEnd'] as const;
const MATCHER_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);
const HOOK_TIMEOUT_SECONDS = 5;
export const HOMEBREW_HUB = '/opt/homebrew/bin/hub';

export function hooksFilePath(dir: string): string {
  return join(dir, 'claude-hooks.json');
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, searchPath: string | undefined): string | null {
  for (const dir of (searchPath ?? '').split(delimiter)) {
    if (dir.startsWith('/') && isExecutable(join(dir, name))) return join(dir, name);
  }
  return null;
}

export interface HookCommandOptions {
  /** Repo checkout root (holds build/hub and dist/cli). */
  repoRoot: string;
  /** Contents/Resources of the packaged app, when packaged. */
  resourcesPath?: string;
  /** PATH to find `node` on. */
  searchPath?: string;
  homebrewHub?: string;
}

/**
 * The argv that runs `hub hook-notify`, or null when no hub can be found: the Homebrew launcher, then the packaged app's
 * own copy, then the repo's bundled build/hub/hub.cjs, then dist/cli/hub.js (the last two need `node`; build/hub/hub itself
 * is a wrapper that only works inside the .app).
 */
export function resolveHookCommand(options: HookCommandOptions): string[] | null {
  const homebrew = options.homebrewHub ?? HOMEBREW_HUB;
  if (isExecutable(homebrew)) return [homebrew, 'hook-notify'];
  const packaged = options.resourcesPath ? join(options.resourcesPath, 'hub', 'hub') : null;
  if (packaged && isExecutable(packaged)) return [packaged, 'hook-notify'];
  const node = findOnPath('node', options.searchPath);
  if (!node) return null;
  for (const script of [join(options.repoRoot, 'build', 'hub', 'hub.cjs'), join(options.repoRoot, 'dist', 'cli', 'hub.js')]) {
    if (existsSync(script)) return [node, script, 'hook-notify'];
  }
  return null;
}

/** The `--settings` document: every event runs the hook command, which posts it to the app. */
export function buildHookSettings(argv: readonly string[] | null): { hooks: Record<string, unknown[]> } {
  if (argv === null) return { hooks: {} };
  const command = renderCommand(argv);
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ ...(MATCHER_EVENTS.has(event) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] }];
  }
  return { hooks };
}

/** Writes <dir>/claude-hooks.json (atomically, and only when it changed) and returns its path. Never touches Claude's own settings. */
export function writeHookSettings(dir: string, argv: readonly string[] | null): string {
  const file = hooksFilePath(dir);
  const content = `${JSON.stringify(buildHookSettings(argv), null, 2)}\n`;
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // first write
  }
  if (current !== content) {
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, content);
    renameSync(temp, file);
  }
  return file;
}

/**
 * Returns a function that re-resolves the hook command and rewrites the settings file each time it is called (at app start and
 * before every launch, so a newly installed hub is picked up), logging only when the command changes. Never throws.
 */
export function createHookRefresher(dir: string, options: () => HookCommandOptions, log: (level: 'INFO' | 'WARN', message: string) => void): () => string | null {
  let last: string | null = null;
  return () => {
    try {
      const argv = resolveHookCommand(options());
      const file = writeHookSettings(dir, argv);
      const rendered = argv === null ? '' : renderCommand(argv);
      if (rendered !== last) {
        last = rendered;
        log(argv === null ? 'WARN' : 'INFO', argv === null ? `claude hooks: no hub CLI found; wrote ${file} with no hooks (agent turn state stays empty)` : `claude hooks: ${file} runs ${rendered}`);
      }
      return file;
    } catch (error) {
      log('WARN', `claude hooks: could not write ${hooksFilePath(dir)}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
}
