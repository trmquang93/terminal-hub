import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo } from '../shared/types';
import { projectDirs } from './claude';
import { query, quote } from './opencode';

interface Turn {
  role: string;
  text: string;
}

export const NO_ID_NOTE = '(no transcript yet: the agent has not recorded a session id)';
export const NO_TRANSCRIPT_NOTE = '(no transcript yet: the agent writes it after the first message)';
export const UNAVAILABLE_NOTE = '(history unavailable: the agent transcript could not be read)';

/** Plain text, one `── role ──` heading per run of turns by the same role. Tool calls, reasoning and sidechains are left out. */
function render(turns: Turn[]): string {
  const merged: Turn[] = [];
  for (const { role, text } of turns) {
    const body = text.trim();
    if (body === '') continue;
    const last = merged.at(-1);
    if (last?.role === role) last.text += `\n\n${body}`;
    else merged.push({ role, text: body });
  }
  return merged.length === 0 ? NO_TRANSCRIPT_NOTE : `${merged.map(({ role, text }) => `── ${role} ──\n${text}`).join('\n\n')}\n`;
}

function claudeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block: { type?: unknown; text?: unknown }) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n');
}

/** `<configDir>/projects/<encoded cwd>/<sessionId>.jsonl`: user and assistant text in file order; bad lines are ignored. */
export function renderClaudeTranscript(configDir: string, cwd: string, sessionId: string): string {
  const file = projectDirs(configDir, cwd)
    .map((dir) => join(dir, `${sessionId}.jsonl`))
    .find((path) => existsSync(path));
  if (file === undefined) return NO_TRANSCRIPT_NOTE;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return UNAVAILABLE_NOTE;
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
    turns.push({ role: row.type, text: claudeText(row.message?.content) });
  }
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
