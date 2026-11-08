import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSessionId, encodeCwd, fillTemplate, findClaudeIndex, planClaudeLaunch } from '../src/main/claude';

const ID = '9b2f6c1e-4d1a-4c55-9a0e-0d3f6b7a1c11';
const OTHER = '0c4e7a2d-5b3f-4e66-8b1f-1e4a7c8b2d22';
const plan = (command: string, args: string[], env: Record<string, string> = {}, processEnv: Record<string, string> = {}) => planClaudeLaunch(command, args, env, processEnv, () => ID);

describe('findClaudeIndex', () => {
  it.each([
    [['claude'], 0],
    [['/Users/me/.local/bin/claude', '-p', 'hi'], 0],
    [['env', 'FOO=1', 'claude', '--model', 'x'], 2],
    [['env', 'CLAUDE_CONFIG_DIR=/x', 'claude'], 2],
    [['npx', '-y', 'claude'], 2],
    [['npx', '@anthropic-ai/claude-code', '--help'], 1],
    [['npx', '-p', '@anthropic-ai/claude-code', 'claude'], 3],
    [['echo', 'claude'], -1],
    [['sh', '-c', 'claude'], -1],
    [['zsh', '-l'], -1],
  ])('%j → %i', (argv, expected) => expect(findClaudeIndex(argv)).toBe(expected));
});

describe('planClaudeLaunch', () => {
  it('passes --session-id <uuid> and records session id and config dir', () => {
    const launch = plan('claude', ['--model', 'opus'], { CLAUDE_CONFIG_DIR: '/cfg' });
    expect(launch?.args).toEqual(['--session-id', ID, '--model', 'opus']);
    expect(launch?.claude).toMatchObject({ sessionId: ID, configDir: '/cfg', resumeCommand: `claude --resume ${ID} --model opus` });
    expect(launch?.claude.argvTemplate).toEqual(['claude', '--resume', '{{sessionId}}', '--model', 'opus']);
  });

  it('inserts the flag after the claude token when wrapped by env, taking CLAUDE_CONFIG_DIR from argv', () => {
    const launch = plan('env', ['CLAUDE_CONFIG_DIR=/from-argv', 'claude']);
    expect(launch?.args).toEqual(['CLAUDE_CONFIG_DIR=/from-argv', 'claude', '--session-id', ID]);
    expect(launch?.claude.configDir).toBe('/from-argv');
    expect(launch?.env).toEqual({});
  });

  it('pins an inherited CLAUDE_CONFIG_DIR into the recorded env, but not when unset', () => {
    expect(plan('claude', [], {}, { CLAUDE_CONFIG_DIR: '/inherited' })?.env).toEqual({ CLAUDE_CONFIG_DIR: '/inherited' });
    expect(plan('claude', [], {}, {})?.env).toEqual({});
  });

  it('returns null for commands that do not run Claude Code', () => {
    expect(plan('zsh', ['-l'])).toBeNull();
  });

  it('keeps a user-supplied --session-id and does not add a second one', () => {
    const launch = plan('claude', ['--session-id', OTHER]);
    expect(launch?.args).toEqual(['--session-id', OTHER]);
    expect(launch?.claude.sessionId).toBe(OTHER);
  });

  it('records the id of a user --resume without rewriting how it launches', () => {
    const launch = plan('claude', ['--resume', OTHER]);
    expect(launch?.args).toEqual(['--resume', OTHER]);
    expect(launch?.claude.sessionId).toBe(OTHER);
  });

  it('leaves the id unknown for --continue so it can be discovered later', () => {
    const launch = plan('claude', ['--continue']);
    expect(launch?.args).toEqual(['--continue']);
    expect(launch?.claude.sessionId).toBeNull();
    expect(launch?.claude.resumeCommand).toBe('');
  });
});

describe('fillTemplate', () => {
  it('builds the resume argv from the template', () => {
    expect(fillTemplate(['env', 'A=1', 'claude', '--resume', '{{sessionId}}'], ID)).toEqual(['env', 'A=1', 'claude', '--resume', ID]);
  });
});

describe('discoverSessionId', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function fixture(): { config: string; cwd: string; project: string } {
    const base = mkdtempSync(join(tmpdir(), 'thub-claude-'));
    dirs.push(base);
    const cwd = join(base, 'work');
    mkdirSync(cwd);
    const project = join(base, 'cfg', 'projects', encodeCwd(cwd));
    mkdirSync(project, { recursive: true });
    return { config: join(base, 'cfg'), cwd, project };
  }

  it('encodes cwd like Claude Code does', () => {
    expect(encodeCwd('/Users/a/.cursor/x_y')).toBe('-Users-a--cursor-x-y');
  });

  it('picks the newest transcript created after the session started', () => {
    const { config, cwd, project } = fixture();
    writeFileSync(join(project, `${OTHER}.jsonl`), '{}');
    utimesSync(join(project, `${OTHER}.jsonl`), 1000, 1000);
    writeFileSync(join(project, `${ID}.jsonl`), '{}');
    expect(discoverSessionId(config, cwd, Date.now() - 60_000, new Set())).toBe(ID);
  });

  it('returns null when nothing is new, and skips ids already owned by another session', () => {
    const { config, cwd, project } = fixture();
    writeFileSync(join(project, `${ID}.jsonl`), '{}');
    expect(discoverSessionId(config, cwd, Date.now() + 60_000, new Set())).toBeNull();
    expect(discoverSessionId(config, cwd, 0, new Set([ID]))).toBeNull();
  });
});
