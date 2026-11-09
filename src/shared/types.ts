/** `restored` is reserved: a resumed session reports `running` while live. */
export type SessionState = 'running' | 'exited' | 'interrupted' | 'restored';

export type TitleSource = 'auto' | 'manual';

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

export type TurnState = 'working' | 'waiting' | 'done';

/** Where a Claude Code session is in its turn, from its hook events; `since` is when it entered this state. */
export interface TurnInfo {
  state: TurnState;
  since: string;
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
  /** `manual`: the user pinned the title, terminal-title escapes from the program are ignored. Missing (older meta.json) means `auto`. */
  titleSource?: TitleSource;
  cwd: string;
  command: string;
  argv: string[];
  env: Record<string, string>;
  state: SessionState;
  /** The agent slot for both providers (Claude Code and opencode); the name is kept for on-disk compatibility. */
  claude: AgentInfo | null;
  resumeCount: number;
  autoAnswer: AutoAnswerPolicy | null;
  /** Hidden from the main list; only a session that is not running can be archived. Absent in older meta.json files. */
  archived: boolean;
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
  /** Null until the first hook event, after SessionEnd, and whenever the process is not running. */
  turn: TurnInfo | null;
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
  /** `log`: tail of output.log (shell); `live`: in-memory tail of a running agent; `transcript`: a finished agent's native transcript as plain text. */
  source: 'log' | 'live' | 'transcript';
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

export type UpdaterPhase = 'idle' | 'checking' | 'available' | 'building' | 'installing' | 'error';

export interface UpdaterStatus {
  phase: UpdaterPhase;
  /** Commits on origin that the checkout does not have yet. */
  ahead: number;
  /** Chip text for `available`, `building`, `installing` and `error`; free text otherwise. */
  message: string;
}

export interface HubApi {
  defaults(): Promise<HubDefaults>;
  /** Git top-level (nearest ancestor with a `.git` entry) per cwd; null when the cwd is outside a repo. */
  repoRoots(cwds: string[]): Promise<Record<string, string | null>>;
  listSessions(): Promise<SessionInfo[]>;
  createSession(options: StartSessionOptions): Promise<string>;
  sendInput(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  readOutput(id: string, tailBytes: number): Promise<OutputSlice>;
  stopSession(id: string): Promise<void>;
  resumeSession(id: string): Promise<void>;
  answer(id: string, request: AnswerRequest): Promise<string>;
  deleteSession(id: string): Promise<boolean>;
  deleteSessions(ids: string[]): Promise<number>;
  archiveSession(id: string, archived: boolean): Promise<void>;
  deleteAllHistory(): Promise<boolean>;
  renameSession(id: string, title: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  /** Opens an http(s) URL in the default browser; false when main refuses the URL. */
  openExternal(url: string): Promise<boolean>;
  onSessionChanged(callback: (session: SessionInfo) => void): () => void;
  onSessionRemoved(callback: (id: string) => void): () => void;
  onOutput(callback: (event: OutputEvent) => void): () => void;
  onMenu(callback: (action: MenuAction) => void): () => void;
  onSelect(callback: (id: string) => void): () => void;
  getUpdate(): Promise<UpdaterStatus>;
  onUpdate(callback: (status: UpdaterStatus) => void): () => void;
}
