import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo } from '../shared/types';
import { projectDirs } from './claude';
import { query, quote } from './opencode';

interface Turn {
  role: string;
  text: string;
  /** Lines built from thinking and tool_use blocks; used only when the run has no text of its own. */
  extra?: string[];
}

const THINKING_MAX_CHARS = 500;
const TOOL_INPUT_MAX_CHARS = 120;

export const NO_ID_NOTE = '(no transcript yet: the agent has not recorded a session id)';
export const NO_TRANSCRIPT_NOTE = '(no transcript yet: the agent writes it after the first message)';
export const UNAVAILABLE_NOTE = '(history unavailable: the agent transcript could not be read)';

/** Plain text, one `── role ──` heading per run of turns by the same role. Tool calls, reasoning and sidechains are left out, except that a run with no text of its own shows its thinking and tool calls, so it is never blank. */
function render(turns: Turn[]): string {
  const merged: Turn[] = [];
  for (const { role, text, extra } of turns) {
    const body = text.trim();
    const extras = (extra ?? []).filter((line) => line.trim() !== '');
    if (body === '' && extras.length === 0) continue;
    const last = merged.at(-1);
    if (last?.role === role) {
      if (body !== '') last.text = last.text === '' ? body : `${last.text}\n\n${body}`;
      last.extra = [...(last.extra ?? []), ...extras];
    } else merged.push({ role, text: body, extra: extras });
  }
  const rendered = merged
    .map(({ role, text, extra }) => ({ role, text: text.trim() !== '' ? text : (extra ?? []).join('\n') }))
    .filter(({ text }) => text.trim() !== '');
  return rendered.length === 0 ? NO_TRANSCRIPT_NOTE : `${rendered.map(({ role, text }) => `── ${role} ──\n${text}`).join('\n\n')}\n`;
}

function truncate(value: string, max: number): string {
  const oneLine = value.replaceAll(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** One line naming a tool call and its main argument, so a run that only used tools still says what it did. */
function toolLine(block: { name?: unknown; input?: unknown }): string {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = block.input;
  let hint = '';
  if (typeof input === 'string') hint = input;
  else if (input !== null && typeof input === 'object') {
    const fields = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'query'] as const;
    const record = input as Record<string, unknown>;
    for (const field of fields) {
      const value = record[field];
      if (typeof value === 'string' && value.trim() !== '') {
        hint = value;
        break;
      }
    }
  }
  return hint === '' ? `[tool: ${name}]` : `[tool: ${name} — ${truncate(hint, TOOL_INPUT_MAX_CHARS)}]`;
}

function claudeBlocks(content: unknown): { text: string; extra: string[] } {
  if (typeof content === 'string') return { text: content, extra: [] };
  if (!Array.isArray(content)) return { text: '', extra: [] };
  const texts: string[] = [];
  const extra: string[] = [];
  for (const block of content as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown }[]) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') extra.push(`(thinking) ${truncate(block.thinking, THINKING_MAX_CHARS)}`);
    else if (block?.type === 'tool_use') extra.push(toolLine(block));
  }
  return { text: texts.join('\n'), extra };
}

/** User and assistant turns from the Claude transcript file in file order; null when the file is missing, 'unreadable' when it exists but cannot be read. Bad lines are ignored. */
function claudeTurns(configDir: string, cwd: string, sessionId: string): Turn[] | 'unreadable' | null {
  const file = projectDirs(configDir, cwd)
    .map((dir) => join(dir, `${sessionId}.jsonl`))
    .find((path) => existsSync(path));
  if (file === undefined) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return 'unreadable';
  }
  const turns: Turn[] = [];
  for (const line of raw.split('\n')) {
    let row: { type?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { content?: unknown } } | null;
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    if ((row?.type !== 'user' && row?.type !== 'assistant') || row.isSidechain === true || row.isMeta === true) continue;
    turns.push({ role: row.type, ...claudeBlocks(row.message?.content) });
  }
  return turns;
}

/** `<configDir>/projects/<encoded cwd>/<sessionId>.jsonl`: user and assistant text in file order; bad lines are ignored. */
export function renderClaudeTranscript(configDir: string, cwd: string, sessionId: string): string {
  const turns = claudeTurns(configDir, cwd, sessionId);
  if (turns === null) return NO_TRANSCRIPT_NOTE;
  if (turns === 'unreadable') return UNAVAILABLE_NOTE;
  return render(turns);
}

/** Text parts of an opencode session from its SQLite store, by message then part creation time. */
export function renderOpencodeTranscript(dataDir: string, sessionId: string): string {
  const rows = query(
    dataDir,
    `SELECT json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.text') AS text FROM part p JOIN message m ON m.id = p.message_id
     WHERE m.session_id = ${quote(sessionId)} AND json_extract(p.data, '$.type') = 'text' AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0 AND COALESCE(json_extract(p.data, '$.ignored'), 0) = 0
     ORDER BY m.time_created, m.id, p.time_created, p.id;`,
  );
  if (rows === null) return UNAVAILABLE_NOTE;
  return render(rows.map((row) => ({ role: typeof row.role === 'string' ? row.role : 'unknown', text: typeof row.text === 'string' ? row.text : '' })));
}

/**
 * The agent's native history as plain text, or null when there is none to show: no session id yet, no transcript
 * file or DB rows, no user/assistant text, or an unreadable store. Never throws.
 */
export function nativeTranscript(agent: AgentInfo, cwd: string): string | null {
  if (agent.sessionId === null) return null;
  try {
    const text = agent.provider === 'opencode' ? renderOpencodeTranscript(agent.configDir, agent.sessionId) : renderClaudeTranscript(agent.configDir, cwd, agent.sessionId);
    return text === NO_TRANSCRIPT_NOTE || text === UNAVAILABLE_NOTE ? null : text;
  } catch {
    return null;
  }
}

/** The agent's own history as plain text (`\n` line ends). Never throws: a missing or unreadable store yields a one-line note. */
export function renderTranscript(agent: AgentInfo, cwd: string): string {
  if (agent.sessionId === null) return NO_ID_NOTE;
  try {
    return agent.provider === 'opencode' ? renderOpencodeTranscript(agent.configDir, agent.sessionId) : renderClaudeTranscript(agent.configDir, cwd, agent.sessionId);
  } catch {
    return UNAVAILABLE_NOTE;
  }
}

/**
 * True when the agent recorded at least one assistant turn with text of its own (not only thinking and tool calls).
 * A killed run can leave such a transcript, and its last screen is then worth appending. Never throws.
 */
export function transcriptHasAssistantText(agent: AgentInfo, cwd: string): boolean {
  if (agent.sessionId === null) return false;
  try {
    if (agent.provider === 'opencode') return renderOpencodeTranscript(agent.configDir, agent.sessionId).includes('── assistant ──');
    const turns = claudeTurns(agent.configDir, cwd, agent.sessionId);
    if (turns === null || turns === 'unreadable') return false;
    return turns.some((turn) => turn.role === 'assistant' && turn.text.trim() !== '');
  } catch {
    return false;
  }
}
