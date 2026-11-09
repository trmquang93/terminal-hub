import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCwd } from '../src/main/claude';
import { NO_ID_NOTE, NO_TRANSCRIPT_NOTE, renderClaudeTranscript, renderOpencodeTranscript, renderTranscript, transcriptHasAssistantText, UNAVAILABLE_NOTE } from '../src/main/transcript';
import type { AgentInfo } from '../src/shared/types';

const CLAUDE_ID = '9b2f6c1e-4d1a-4c55-9a0e-0d3f6b7a1c11';
const OPENCODE_ID = 'ses_2a1b3c4d5eAbCdEfGhIjKlMnOp';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'thub-transcript-')));
  dirs.push(base);
  return base;
}

describe('renderClaudeTranscript', () => {
  function transcript(lines: string[]): { configDir: string; cwd: string } {
    const base = scratch();
    const cwd = join(base, 'work');
    const configDir = join(base, 'cfg');
    mkdirSync(cwd);
    mkdirSync(join(configDir, 'projects', encodeCwd(cwd)), { recursive: true });
    writeFileSync(join(configDir, 'projects', encodeCwd(cwd), `${CLAUDE_ID}.jsonl`), `${lines.join('\n')}\n`);
    return { configDir, cwd };
  }
  const row = (value: unknown): string => JSON.stringify(value);

  it('renders user and assistant text in file order and leaves tool calls, tool results, thinking, sidechains, meta rows, bookkeeping rows and corrupt lines out', () => {
    const { configDir, cwd } = transcript([
      row({ type: 'permission-mode', permissionMode: 'default' }),
      row({ type: 'user', isSidechain: false, message: { role: 'user', content: 'fix the bug' } }),
      row({ type: 'user', isMeta: true, message: { role: 'user', content: '<caveat>ignore me</caveat>' } }),
      row({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret plan' }] } }),
      row({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at it.' }, { type: 'tool_use', name: 'Read', input: { file: 'a.ts' } }] } }),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"truncated by a crash',
      row({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] } }),
      row({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }),
      row({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] } }),
      row({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: 'raw request' }] } }),
      row({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'thanks' }, { type: 'image', source: {} }] } }),
    ]);
    expect(renderClaudeTranscript(configDir, cwd, CLAUDE_ID)).toBe(['── user ──', 'fix the bug', '', '── assistant ──', 'Looking at it.', '', 'Fixed it.', '', '── user ──', 'thanks', ''].join('\n'));
  });

  it('finds the file under the real path when the cwd is a symlink', () => {
    const { configDir, cwd } = transcript([row({ type: 'user', message: { content: 'hi' } })]);
    const link = join(cwd, '..', 'link');
    execFileSync('ln', ['-s', cwd, link]);
    expect(renderClaudeTranscript(configDir, link, CLAUDE_ID)).toContain('hi');
  });

  it('shows thinking and tool calls when a run has no text of its own, so a killed run is never blank', () => {
    const { configDir, cwd } = transcript([
      row({ type: 'user', isSidechain: false, message: { role: 'user', content: 'launch the repro app' } }),
      row({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'I will build the app first' }] } }),
      row({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run package:app', description: 'build' } }] } }),
      row({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.ts' } }] } }),
    ]);
    expect(renderClaudeTranscript(configDir, cwd, CLAUDE_ID)).toBe(
      ['── user ──', 'launch the repro app', '', '── assistant ──', '(thinking) I will build the app first', '[tool: Bash — npm run package:app]', '[tool: Read — /tmp/a.ts]', ''].join('\n'),
    );
  });

  it('leaves thinking and tool calls out of a run that has text, and truncates a long thinking block in one that has none', () => {
    const { configDir, cwd } = transcript([
      row({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden plan' }] } }),
      row({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Answered.' }] } }),
      row({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'sidechain plan' }] } }),
    ]);
    expect(renderClaudeTranscript(configDir, cwd, CLAUDE_ID)).toBe('── assistant ──\nAnswered.\n');
    const long = transcript([row({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x'.repeat(900) }] } })]);
    const line = renderClaudeTranscript(long.configDir, long.cwd, CLAUDE_ID).split('\n')[1] ?? '';
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBe('(thinking) '.length + 500);
  });

  it('reports whether the agent ever wrote assistant text, so a prompt-only transcript can fall back to its last screen', () => {
    const onlyTools = transcript([
      row({ type: 'user', message: { content: 'go' } }),
      row({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    ]);
    const agent = (dir: { configDir: string; cwd: string }): AgentInfo => ({ provider: 'claude', configDir: dir.configDir, sessionId: CLAUDE_ID, argvTemplate: [], resumeCommand: '' });
    expect(transcriptHasAssistantText(agent(onlyTools), onlyTools.cwd)).toBe(false);
    expect(transcriptHasAssistantText({ ...agent(onlyTools), sessionId: null }, onlyTools.cwd)).toBe(false);
    const withText = transcript([row({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })]);
    expect(transcriptHasAssistantText(agent(withText), withText.cwd)).toBe(true);
  });

  it('says there is no transcript yet when the file is missing or has no text', () => {
    const { configDir, cwd } = transcript([row({ type: 'permission-mode' }), 'garbage']);
    expect(renderClaudeTranscript(configDir, cwd, CLAUDE_ID)).toBe(NO_TRANSCRIPT_NOTE);
    expect(renderClaudeTranscript(configDir, cwd, '00000000-0000-4000-8000-000000000000')).toBe(NO_TRANSCRIPT_NOTE);
  });
});

const hasSqlite = spawnSync('sqlite3', ['-version']).status === 0;

describe.skipIf(!hasSqlite)('renderOpencodeTranscript', () => {
  const sql = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const message = (id: string, created: number, role: string, session = OPENCODE_ID): string => `INSERT INTO message VALUES (${sql(id)}, '${session}', ${created}, ${created}, ${sql(JSON.stringify({ role }))});`;
  const part = (id: string, messageId: string, created: number, data: unknown, session = OPENCODE_ID): string =>
    `INSERT INTO part VALUES (${sql(id)}, ${sql(messageId)}, '${session}', ${created}, ${created}, ${sql(JSON.stringify(data))});`;

  function database(rows: string[]): string {
    const dataDir = join(scratch(), 'opencode');
    mkdirSync(dataDir);
    const schema = [
      'CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);',
      'CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);',
    ];
    execFileSync('sqlite3', [join(dataDir, 'opencode.db')], { input: [...schema, ...rows].join('\n') });
    return dataDir;
  }

  it('renders text parts by message then part time, leaving out reasoning, tool, synthetic and other-session parts', () => {
    const dataDir = database([
      // inserted out of order on purpose
      message('msg_b', 2000, 'assistant'),
      message('msg_a', 1000, 'user'),
      part('prt_3', 'msg_b', 2200, { type: 'text', text: "It's done." }),
      part('prt_2', 'msg_b', 2100, { type: 'tool', tool: 'bash', state: { output: 'tool output' } }),
      part('prt_1', 'msg_b', 2000, { type: 'reasoning', text: 'private thoughts' }),
      part('prt_0', 'msg_a', 1000, { type: 'text', text: 'add a config file' }),
      part('prt_4', 'msg_b', 2300, { type: 'text', text: 'Continue if you have next steps', synthetic: true }),
      part('prt_5', 'msg_b', 2400, { type: 'step-finish' }),
      message('msg_x', 1500, 'user', 'ses_other'),
      part('prt_6', 'msg_x', 1500, { type: 'text', text: 'other session' }, 'ses_other'),
    ]);
    expect(renderOpencodeTranscript(dataDir, OPENCODE_ID)).toBe(['── user ──', 'add a config file', '', '── assistant ──', "It's done.", ''].join('\n'));
  });

  it('keeps several text parts of one message together and in part order', () => {
    const dataDir = database([message('msg_a', 1000, 'assistant'), part('prt_2', 'msg_a', 1200, { type: 'text', text: 'second' }), part('prt_1', 'msg_a', 1100, { type: 'text', text: 'first' })]);
    expect(renderOpencodeTranscript(dataDir, OPENCODE_ID)).toBe('── assistant ──\nfirst\n\nsecond\n');
  });

  it('says there is no transcript yet for a session without text', () => {
    expect(renderOpencodeTranscript(database([]), OPENCODE_ID)).toBe(NO_TRANSCRIPT_NOTE);
  });

  it('returns a friendly line, never throws, for a missing, corrupt or schema-less database', () => {
    expect(renderOpencodeTranscript('/nonexistent/opencode', OPENCODE_ID)).toBe(UNAVAILABLE_NOTE);
    const corrupt = database([]);
    writeFileSync(join(corrupt, 'opencode.db'), 'not a database');
    expect(renderOpencodeTranscript(corrupt, OPENCODE_ID)).toBe(UNAVAILABLE_NOTE);
    const empty = join(scratch(), 'opencode');
    mkdirSync(empty);
    execFileSync('sqlite3', [join(empty, 'opencode.db')], { input: 'CREATE TABLE other (x);' });
    expect(renderOpencodeTranscript(empty, OPENCODE_ID)).toBe(UNAVAILABLE_NOTE);
  });
});

describe('renderTranscript', () => {
  const agent = (overrides: Partial<AgentInfo>): AgentInfo => ({ provider: 'claude', configDir: '/nonexistent', sessionId: CLAUDE_ID, argvTemplate: [], resumeCommand: '', ...overrides });

  it('notes a missing session id instead of reading anything', () => {
    expect(renderTranscript(agent({ sessionId: null }), '/tmp')).toBe(NO_ID_NOTE);
    expect(renderTranscript(agent({ provider: 'opencode', sessionId: null }), '/tmp')).toBe(NO_ID_NOTE);
  });

  it('routes by provider', () => {
    expect(renderTranscript(agent({}), '/tmp')).toBe(NO_TRANSCRIPT_NOTE);
    expect(renderTranscript(agent({ provider: 'opencode', sessionId: OPENCODE_ID }), '/tmp')).toBe(UNAVAILABLE_NOTE);
  });
});
