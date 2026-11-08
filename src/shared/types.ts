/** `restored` is reserved: a resumed session reports `running` while live. */
export type SessionState = 'running' | 'exited' | 'interrupted' | 'restored';

export interface AgentInfo {
  provider: 'claude' | 'opencode';
  configDir: string;
  /** Claude Code session uuid or opencode ses_ id; null until discovered. */
  sessionId: string | null;
  /** Full argv with `--resume {{sessionId}}` (claude) or `--session {{sessionId}}` (opencode) after the tool token. */
  argvTemplate: string[];
  resumeCommand: string;
}

export interface AttentionInfo {
  reason: 'prompt' | 'idle';
  /** Last ~10 plain-text lines, or the hook message when the screen text is not available. */
  promptText: string;
  since: string;
  source: 'hook' | 'heuristic' | 'idle';
}

export interface AutoAnswerRule {
  /** Exact, case-sensitive substring of the prompt text. */
  match: string;
  keys: string;
}

export interface AutoAnswerPolicy {
  enabled: boolean;
  rules: AutoAnswerRule[];
  /** Seconds to leave a matching prompt for a human before auto-answering; 0 answers at once. */
  timeoutSec: number;
}

export interface AnswerRequest {
  /** Raw bytes to write, e.g. "1\r". */
  keys?: string;
  /** A friendly name (yes, no, enter, esc, tab, up, down, 1-9) or literal text. */
  text?: string;
  /** Append Enter. */
  submit?: boolean;
}

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  command: string;
  argv: string[];
  env: Record<string, string>;
  state: SessionState;
  /** The agent slot for both providers (Claude Code and opencode); the name is kept for on-disk compatibility. */
  claude: AgentInfo | null;
  resumeCount: number;
  autoAnswer: AutoAnswerPolicy | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
  bytesWritten: number;
  appVersion: string;
}

export interface SessionInfo extends SessionMeta {
  running: boolean;
  attention: AttentionInfo | null;
  /** Not running and either a plain command (restart) or a Claude session with a known id. */
  resumable: boolean;
}

export interface StartSessionOptions {
  cwd: string;
  command: string;
  args?: string[];
  title?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Enables the default safe auto-answer policy (approve "Do you want to proceed?" with Enter). */
  unattended?: boolean;
  autoAnswer?: AutoAnswerPolicy;
}

export interface OutputSlice {
  data: Uint8Array;
  start: number;
  total: number;
}

export interface OutputEvent {
  id: string;
  endOffset: number;
  data: Uint8Array;
}

export type MenuAction = 'new' | 'clear';

export interface HubDefaults {
  shell: string;
  home: string;
  recentFolders: string[];
}

export interface HubApi {
  defaults(): Promise<HubDefaults>;
  listSessions(): Promise<SessionInfo[]>;
  createSession(options: StartSessionOptions): Promise<string>;
  sendInput(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  readOutput(id: string, tailBytes: number): Promise<OutputSlice>;
  stopSession(id: string): Promise<void>;
  resumeSession(id: string): Promise<void>;
  answer(id: string, request: AnswerRequest): Promise<string>;
  deleteSession(id: string): Promise<boolean>;
  deleteAllHistory(): Promise<boolean>;
  renameSession(id: string, title: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  onSessionChanged(callback: (session: SessionInfo) => void): () => void;
  onSessionRemoved(callback: (id: string) => void): () => void;
  onOutput(callback: (event: OutputEvent) => void): () => void;
  onMenu(callback: (action: MenuAction) => void): () => void;
  onSelect(callback: (id: string) => void): () => void;
}
