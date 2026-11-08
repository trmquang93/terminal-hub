import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { UpdaterStatus } from '../shared/types';

export const DEFAULT_BRANCH = 'main';
export const DEFAULT_CHECK_MINUTES = 5;
/** No session may have been running for this long before an update is applied. */
export const IDLE_MS = 30_000;
const IDLE_POLL_MS = 5_000;
const FIRST_CHECK_MS = 20_000;
const LOG_MAX_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const NPM_CI_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const WAIT_FOR_EXIT_SECONDS = 30;
const BUNDLE = join('release', 'mac-arm64', 'Terminal Hub.app');
const INSTALLED_APP = '/Applications/Terminal Hub.app';
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// ---------------------------------------------------------------- pure logic

export interface UpdateFile {
  repo?: string;
  branch: string;
  checkMinutes: number;
  enabled: boolean;
}

export type ParseResult = { ok: true; value: UpdateFile } | { ok: false; error: string };

/** Parses `update.json`; every field is optional (defaults: branch main, 5 min, enabled). Anything malformed is rejected whole. */
export function parseUpdateConfig(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'must be a JSON object' };
  const { repo, branch = DEFAULT_BRANCH, checkMinutes = DEFAULT_CHECK_MINUTES, enabled = true } = raw as Record<string, unknown>;
  if (repo !== undefined && (typeof repo !== 'string' || !isAbsolute(repo))) return { ok: false, error: '"repo" must be an absolute path' };
  if (typeof branch !== 'string' || !BRANCH_PATTERN.test(branch) || branch.includes('..')) return { ok: false, error: '"branch" is not a valid branch name' };
  if (typeof checkMinutes !== 'number' || !Number.isFinite(checkMinutes) || checkMinutes < 1) return { ok: false, error: '"checkMinutes" must be a number >= 1' };
  if (typeof enabled !== 'boolean') return { ok: false, error: '"enabled" must be true or false' };
  return { ok: true, value: { repo, branch, checkMinutes, enabled } };
}

export interface RepoState {
  head: string;
  branch: string;
  dirty: boolean;
  /** Commits on origin/<branch> that HEAD does not have. */
  ahead: number;
}

export interface GitOutputs {
  head: string;
  branch: string;
  porcelain: string;
  ahead: string;
}

/** Parses the raw stdout of `rev-parse HEAD`, `rev-parse --abbrev-ref HEAD`, `status --porcelain`, `rev-list --count`. Null if any is unusable. */
export function parseRepoState(out: GitOutputs): RepoState | null {
  const head = out.head.trim();
  const branch = out.branch.trim();
  const ahead = out.ahead.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head) || branch === '' || !/^\d+$/.test(ahead)) return null;
  return { head, branch, dirty: out.porcelain.trim() !== '', ahead: Number(ahead) };
}

export interface GateInput {
  isPackaged: boolean;
  running: number;
  state: RepoState;
  expectedBranch: string;
  /** A previous run already pulled and got part-way (a failed build, a session that started): proceed even though ahead is 0. */
  resume?: boolean;
}

export type Decision =
  | { kind: 'skip'; reason: string }
  /** An update is pending but this is not an installed app: log only. */
  | { kind: 'dev'; reason: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'install'; reason: string };

/** The only place that decides whether an update may be applied right now. */
export function shouldInstall(input: GateInput): Decision {
  const { state, expectedBranch } = input;
  if (state.dirty) return { kind: 'skip', reason: 'working tree has local changes' };
  if (state.branch !== expectedBranch) return { kind: 'skip', reason: `checkout is on "${state.branch}", updates track "${expectedBranch}"` };
  if (state.ahead === 0 && !input.resume) return { kind: 'skip', reason: 'up to date' };
  if (!input.isPackaged) return { kind: 'dev', reason: 'not a packaged app; log only' };
  if (input.running > 0) return { kind: 'wait', reason: `${input.running} session${input.running === 1 ? '' : 's'} running` };
  return { kind: 'install', reason: 'no session running' };
}

export function aheadText(ahead: number): string {
  return ahead > 0 ? `update available (${ahead}) - waits for idle` : 'update ready - waits for idle';
}

export function isDryRun(env: NodeJS.ProcessEnv): boolean {
  return env.TERMINAL_HUB_UPDATE_DRY_RUN === '1';
}

// ------------------------------------------------------------- config lookup

export interface UpdateConfig {
  repo: string;
  branch: string;
  checkMinutes: number;
  source: 'update.json' | 'build-info.json' | 'cwd';
}

export interface ResolveResult {
  config: UpdateConfig | null;
  /** Why auto-update is off because something is wrong. */
  warning?: string;
  /** Why it is off on purpose. */
  info?: string;
}

export function updateConfigPath(dir: string): string {
  return join(dir, 'update.json');
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** A terminal-hub checkout: a git working copy whose package.json has the `package:app` script. */
function repoProblem(repo: string): string | null {
  if (!existsSync(join(repo, '.git'))) return 'is not a git checkout';
  const pkg = readText(join(repo, 'package.json'));
  if (pkg === null) return 'has no package.json';
  try {
    const scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts;
    return typeof scripts?.['package:app'] === 'string' ? null : 'has no "package:app" script';
  } catch {
    return 'has an unreadable package.json';
  }
}

/**
 * `<dataDir>/update.json` (optional) -> packaged `resources/build-info.json` -> the current directory (dev).
 * An explicit repo in update.json is never second-guessed: if it is bad, auto-update is off. Never throws.
 */
export function resolveUpdateConfig(input: { dataDir: string; resourcesPath?: string; cwd: string }): ResolveResult {
  try {
    let file: UpdateFile = { branch: DEFAULT_BRANCH, checkMinutes: DEFAULT_CHECK_MINUTES, enabled: true };
    const fileText = readText(updateConfigPath(input.dataDir));
    if (fileText !== null) {
      const parsed = parseUpdateConfig(fileText);
      if (!parsed.ok) return { config: null, warning: `update.json ${parsed.error}; auto-update is off` };
      file = parsed.value;
    }
    if (!file.enabled) return { config: null, info: 'update.json has "enabled": false; auto-update is off' };
    const make = (repo: string, source: UpdateConfig['source']): UpdateConfig => ({ repo, branch: file.branch, checkMinutes: file.checkMinutes, source });
    if (file.repo !== undefined) {
      const problem = repoProblem(file.repo);
      return problem ? { config: null, warning: `update.json repo ${file.repo} ${problem}; auto-update is off` } : { config: make(file.repo, 'update.json') };
    }
    const infoText = input.resourcesPath ? readText(join(input.resourcesPath, 'build-info.json')) : null;
    if (infoText !== null) {
      try {
        const repo = (JSON.parse(infoText) as { repo?: unknown }).repo;
        if (typeof repo === 'string' && isAbsolute(repo) && repoProblem(repo) === null) return { config: make(repo, 'build-info.json') };
      } catch {
        // fall through to the dev checkout
      }
    }
    if (repoProblem(input.cwd) === null) return { config: make(input.cwd, 'cwd') };
    return { config: null, warning: 'no update source: no usable update.json "repo", build-info.json, or terminal-hub checkout in the working directory; auto-update is off' };
  } catch (error) {
    return { config: null, warning: `update config could not be read (${String(error)}); auto-update is off` };
  }
}

// ----------------------------------------------------------------------- I/O

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type Runner = (cmd: string, args: string[], options: RunOptions) => Promise<RunResult>;

export const execRunner: Runner = (cmd, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: error && stderr === '' ? error.message : stderr });
    });
  });

/** Append-only `update.log` with one rotation (`.1`) at 1 MB. Never throws. */
export class UpdateLog {
  private readonly path: string;

  constructor(
    dir: string,
    private readonly maxBytes: number = LOG_MAX_BYTES,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dir, 'update.log');
  }

  write(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
    try {
      try {
        if (statSync(this.path).size >= this.maxBytes) renameSync(this.path, `${this.path}.1`);
      } catch {
        // no log yet
      }
      appendFileSync(this.path, `${this.now().toISOString()} ${level} ${message}\n`);
    } catch {
      // logging must never break the app
    }
  }
}

/** Waits (at most 30 s) for the app to exit, installs, reopens. Runs detached, so it outlives the app. Args: pid, repo, log file. */
export const INSTALL_SCRIPT = `pid=$1; repo=$2; log=$3
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n+1))
  if [ "$n" -gt ${WAIT_FOR_EXIT_SECONDS} ]; then echo "$(stamp) ERROR app pid $pid still running after ${WAIT_FOR_EXIT_SECONDS}s; install aborted" >> "$log"; exit 1; fi
  sleep 1
done
cd "$repo" || exit 1
echo "$(stamp) INFO run: node scripts/install-app.mjs" >> "$log"
node scripts/install-app.mjs >> "$log" 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then echo "$(stamp) INFO install ok" >> "$log"; else echo "$(stamp) ERROR install-app.mjs exited $rc" >> "$log"; fi
echo "$(stamp) INFO run: open -a ${INSTALLED_APP}" >> "$log"
open -a "${INSTALLED_APP}" >> "$log" 2>&1 || echo "$(stamp) ERROR open failed" >> "$log"
`;

export type SpawnHelper = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; onError: (error: Error) => void }) => void;

const spawnDetached: SpawnHelper = (args, { cwd, env, onError }) => {
  const child = spawn('/bin/sh', args, { cwd, env, detached: true, stdio: 'ignore' });
  child.on('error', onError);
  child.unref();
};

export interface UpdaterOptions {
  manager: { list(): { running: boolean }[] };
  isPackaged: boolean;
  dataDir: string;
  /** The app's existing shutdown path (stops sessions, then exits). */
  quit: () => Promise<void>;
  resourcesPath?: string;
  cwd?: string;
  pid?: number;
  /** Environment for git/npm/node (a packaged app needs the login-shell PATH). */
  env?: () => NodeJS.ProcessEnv;
  dryRun?: boolean;
  onStatus?: (status: UpdaterStatus) => void;
  runner?: Runner;
  spawnHelper?: SpawnHelper;
  idleMs?: number;
  idlePollMs?: number;
  firstCheckMs?: number;
  now?: () => number;
}

type Stage = 'pull' | 'ci' | 'build' | 'install';

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `"${word.replaceAll('"', '\\"')}"`;
}

export function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map(quote).join(' ');
}

/** Keeps the tail of a command's output and hides credentials embedded in URLs. */
function tail(text: string): string {
  return text.trim().replaceAll(/\/\/[^/@\s]+@/g, '//***@').slice(-2000);
}

export class Updater {
  private config: UpdateConfig | null = null;
  private status: UpdaterStatus = { phase: 'idle', ahead: 0, message: 'auto-update off' };
  private checkTimer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleSince: number | null = null;
  private busy = false;
  private stopped = false;
  private stage: Stage = 'pull';
  private lastNote = '';
  private readonly log: UpdateLog;
  private readonly dryRun: boolean;
  private readonly runner: Runner;
  private readonly spawnHelper: SpawnHelper;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(private readonly options: UpdaterOptions) {
    this.log = new UpdateLog(options.dataDir);
    this.dryRun = options.dryRun ?? false;
    this.runner = options.runner ?? execRunner;
    this.spawnHelper = options.spawnHelper ?? spawnDetached;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.now = options.now ?? Date.now;
  }

  getStatus(): UpdaterStatus {
    return this.status;
  }

  /** Resolves the source repo and starts the periodic check. Never throws; a bad setup is one WARN line and auto-update stays off. */
  start(): void {
    const resolved = resolveUpdateConfig({ dataDir: this.options.dataDir, resourcesPath: this.options.resourcesPath, cwd: this.options.cwd ?? process.cwd() });
    if (resolved.warning) this.write('WARN', resolved.warning);
    else if (resolved.info) this.write('INFO', resolved.info);
    if (!resolved.config) return;
    this.config = resolved.config;
    const { repo, branch, checkMinutes, source } = resolved.config;
    this.write('INFO', `auto-update on: repo=${repo} branch=${branch} every ${checkMinutes} min (source ${source}, packaged=${this.options.isPackaged}${this.dryRun ? ', DRY RUN: nothing is executed or quit' : ''})`);
    this.setStatus('idle', 0, 'up to date');
    this.firstTimer = setTimeout(() => void this.check(), this.options.firstCheckMs ?? FIRST_CHECK_MS);
    this.checkTimer = setInterval(() => void this.check(), checkMinutes * 60_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.stopIdlePolling();
    this.firstTimer = this.checkTimer = null;
  }

  /** One check: fetch, read the repo state, decide. Starts idle polling when an update is pending. */
  async check(): Promise<void> {
    if (!this.config || this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (this.status.phase === 'idle') this.setStatus('checking', 0, 'checking for updates');
      const state = await this.readState();
      if (!state) return;
      const decision = this.decide(state);
      if (decision.kind === 'wait' || decision.kind === 'install') {
        this.note('INFO', `update pending: ${state.ahead} commit${state.ahead === 1 ? '' : 's'} behind origin/${this.config.branch}; applies after ${this.idleMs / 1000}s with no running session`);
        this.setStatus('available', state.ahead, aheadText(state.ahead));
        this.startIdlePolling();
        return;
      }
      this.note('INFO', decision.kind === 'dev' ? `update available (${state.ahead}) but ${decision.reason}` : `no action: ${decision.reason}`);
      this.stopIdlePolling();
      this.setStatus('idle', state.ahead, decision.reason);
    } catch (error) {
      this.note('WARN', `check failed: ${String(error)}`);
    } finally {
      if (this.status.phase === 'checking') this.setStatus('idle', 0, 'up to date');
      this.busy = false;
    }
  }

  private decide(state: RepoState): Decision {
    return shouldInstall({ isPackaged: this.options.isPackaged, running: this.runningCount(), state, expectedBranch: this.config?.branch ?? DEFAULT_BRANCH, resume: this.stage !== 'pull' });
  }

  private runningCount(): number {
    return this.options.manager.list().filter((session) => session.running).length;
  }

  private startIdlePolling(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => void this.pollIdle(), this.options.idlePollMs ?? IDLE_POLL_MS);
  }

  private stopIdlePolling(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.idleSince = null;
  }

  /** The session-idle clock: any running session resets it; `idleMs` of quiet starts the update. */
  async pollIdle(): Promise<void> {
    if (this.busy || this.stopped) return;
    const running = this.runningCount();
    if (running > 0) {
      this.idleSince = null;
      this.note('INFO', `update waiting: ${running} session${running === 1 ? '' : 's'} running`);
      return;
    }
    const now = this.now();
    this.idleSince ??= now;
    if (now - this.idleSince < this.idleMs) {
      this.note('INFO', `update waiting: no session running, ${this.idleMs / 1000}s idle window started`);
      return;
    }
    await this.apply();
  }

  /** pull -> (npm ci) -> package:app -> verify -> hand over to a detached installer and quit. Resumes at the failed step on the next window. */
  private async apply(): Promise<void> {
    const { config } = this;
    if (!config || this.busy || this.stopped) return;
    this.busy = true;
    const ahead = this.status.ahead;
    let stage = this.stage;
    const advance = (next: Stage): void => {
      stage = next;
      if (!this.dryRun) this.stage = next;
    };
    const fail = (message: string): void => {
      this.write('ERROR', `update failed at ${stage}: ${message}; will retry on the next check`);
      this.stopIdlePolling();
      this.setStatus('error', ahead, 'update failed');
    };
    try {
      this.setStatus('building', ahead, 'updating...');
      const state = await this.readState();
      if (!state) {
        this.setStatus('available', ahead, aheadText(ahead));
        this.stopIdlePolling();
        return;
      }
      const decision = this.decide(state);
      if (decision.kind !== 'install') {
        if (decision.kind === 'wait') {
          this.idleSince = null;
          this.note('INFO', `update waiting: ${decision.reason}`);
          this.setStatus('available', ahead, aheadText(ahead));
        } else {
          this.write('INFO', `update not applied: ${decision.reason}`);
          this.stopIdlePolling();
          this.setStatus('idle', state.ahead, decision.reason);
        }
        return;
      }
      this.write('INFO', `applying update (${state.ahead} commit${state.ahead === 1 ? '' : 's'}) from ${state.head.slice(0, 8)}${this.dryRun ? ' [DRY RUN]' : ''}`);

      if (stage === 'pull') {
        const pull = await this.run('git', ['pull', '--ff-only', 'origin', config.branch], { mutating: true, timeoutMs: GIT_TIMEOUT_MS });
        if (pull.code !== 0) return fail('git pull --ff-only');
        // After a real pull compare with the old HEAD; a dry run has not moved HEAD, so compare with what it would pull.
        const range = this.dryRun ? ['HEAD', `origin/${config.branch}`] : [state.head, 'HEAD'];
        const lock = await this.run('git', ['diff', '--name-only', ...range, '--', 'package-lock.json'], { timeoutMs: GIT_TIMEOUT_MS });
        advance(lock.code !== 0 || lock.stdout.trim() !== '' ? 'ci' : 'build');
      }
      if (stage === 'ci') {
        const ci = await this.run('npm', ['ci'], { mutating: true, timeoutMs: NPM_CI_TIMEOUT_MS });
        if (ci.code !== 0) return fail('npm ci');
        advance('build');
      }
      if (stage === 'build') {
        const build = await this.run('npm', ['run', 'package:app'], { mutating: true, timeoutMs: BUILD_TIMEOUT_MS });
        if (build.code !== 0) return fail('npm run package:app');
        const bundle = join(config.repo, BUNDLE);
        if (this.dryRun) this.write('INFO', `DRY-RUN would verify: ${bundle} exists`);
        else if (!existsSync(bundle)) return fail(`package:app finished but ${bundle} is missing`);
        advance('install');
      }

      if (this.runningCount() > 0) {
        this.idleSince = null;
        this.write('INFO', 'a session started during the update; not installing, retrying in the next idle window');
        this.setStatus('available', ahead, aheadText(ahead));
        return;
      }
      if (this.stopped) return;
      this.setStatus('installing', ahead, 'updating...');
      await this.install(config.repo);
    } catch (error) {
      fail(String(error));
    } finally {
      this.busy = false;
    }
  }

  private async install(repo: string): Promise<void> {
    const pid = this.options.pid ?? process.pid;
    const logPath = join(this.options.dataDir, 'update.log');
    const env = this.env();
    if (this.dryRun) {
      this.write('INFO', `DRY-RUN would quit the app (existing shutdown) and spawn one detached /bin/sh that waits up to ${WAIT_FOR_EXIT_SECONDS}s for pid ${pid} to exit`);
      this.write('INFO', `DRY-RUN would run: ${formatCommand('node', ['scripts/install-app.mjs'])} (cwd ${repo})`);
      this.write('INFO', `DRY-RUN would run: ${formatCommand('open', ['-a', INSTALLED_APP])}`);
      this.write('INFO', 'DRY-RUN complete: nothing executed, app not quit');
      this.stopIdlePolling();
      this.setStatus('available', this.status.ahead, aheadText(this.status.ahead));
      return;
    }
    this.write('INFO', `quitting to install: detached installer waits up to ${WAIT_FOR_EXIT_SECONDS}s for pid ${pid}`);
    this.spawnHelper(['-c', INSTALL_SCRIPT, 'terminal-hub-update', String(pid), repo, logPath], { cwd: repo, env, onError: (error) => this.write('ERROR', `installer failed to start: ${error.message}`) });
    this.stage = 'pull';
    await this.options.quit();
  }

  /** `git fetch`, then the four reads. Fetch problems are logged and skip this round. */
  private async readState(): Promise<RepoState | null> {
    const branch = this.config?.branch ?? DEFAULT_BRANCH;
    const fetch = await this.run('git', ['fetch', 'origin', branch], { timeoutMs: GIT_TIMEOUT_MS });
    if (fetch.code !== 0) return null;
    const read = async (args: string[]): Promise<string | null> => {
      const result = await this.run('git', args, { timeoutMs: GIT_TIMEOUT_MS });
      return result.code === 0 ? result.stdout : null;
    };
    const head = await read(['rev-parse', 'HEAD']);
    const current = await read(['rev-parse', '--abbrev-ref', 'HEAD']);
    const porcelain = await read(['status', '--porcelain']);
    const ahead = await read(['rev-list', '--count', `HEAD..origin/${branch}`]);
    if (head === null || current === null || porcelain === null || ahead === null) return null;
    const state = parseRepoState({ head, branch: current, porcelain, ahead });
    if (!state) this.note('WARN', 'unexpected git output; skipping this check');
    return state;
  }

  /** Runs a command in the repo. In dry-run mode a `mutating` command is only logged. Failures are logged with the command and its stderr. */
  private async run(cmd: string, args: string[], options: { mutating?: boolean; timeoutMs: number }): Promise<RunResult> {
    const line = formatCommand(cmd, args);
    if (options.mutating && this.dryRun) {
      this.write('INFO', `DRY-RUN would run: ${line} (cwd ${this.config?.repo})`);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (options.mutating) this.write('INFO', `run: ${line}`);
    const started = this.now();
    const result = await this.runner(cmd, args, { cwd: this.config?.repo ?? '', env: this.env(), timeoutMs: options.timeoutMs });
    if (result.code !== 0) this.write(cmd === 'git' && args[0] === 'fetch' ? 'WARN' : 'ERROR', `${line} exited ${result.code}: ${tail(result.stderr || result.stdout)}`);
    else if (options.mutating) this.write('INFO', `ok: ${line} (${((this.now() - started) / 1000).toFixed(1)}s)`);
    return result;
  }

  private env(): NodeJS.ProcessEnv {
    return { ...(this.options.env?.() ?? process.env), GIT_TERMINAL_PROMPT: '0' };
  }

  private setStatus(phase: UpdaterStatus['phase'], ahead: number, message: string): void {
    if (this.status.phase === phase && this.status.ahead === ahead && this.status.message === message) return;
    this.status = { phase, ahead, message };
    this.options.onStatus?.(this.status);
  }

  private write(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
    this.lastNote = '';
    this.log.write(level, message);
  }

  /** Like write, but skips a line identical to the previous one (periodic checks would otherwise repeat it). */
  private note(level: 'INFO' | 'WARN', message: string): void {
    if (message === this.lastNote) return;
    this.log.write(level, message);
    this.lastNote = message;
  }
}
