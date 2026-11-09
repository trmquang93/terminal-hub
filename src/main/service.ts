import type { AnswerRequest, SessionInfo, StartSessionOptions } from '../shared/types';

export interface OutputChunk {
  id: string;
  /** Byte offset just after this chunk: in output.log for a shell, in the live output for an agent session (nothing is on disk). */
  endOffset: number;
  data: Buffer;
}

/** What the HTTP API needs from the session manager. */
export interface SessionService {
  list(): SessionInfo[];
  get(id: string): SessionInfo | undefined;
  start(options: StartSessionOptions): SessionInfo;
  resume(id: string): SessionInfo;
  write(id: string, data: string): void;
  answer(id: string, request: AnswerRequest): string;
  hookNotify(notification: { hubSessionId?: string; sessionId?: string; message: string; hookEvent?: string }): boolean;
  stop(id: string): void;
  remove(id: string): Promise<void>;
  removeMany(ids: string[]): Promise<void>;
  setArchived(id: string, archived: boolean): SessionInfo;
  setTitle(id: string, title: string): SessionInfo;
  releaseTitle(id: string): SessionInfo;
  /** The offset live output runs to (output.log size for a shell). */
  size(id: string): number;
  /** output.log bytes; empty for an agent session. */
  readChunks(id: string, start: number, end: number): AsyncGenerator<Buffer>;
  /** output.log for a shell, the rendered native transcript (plain text) for an agent session; `plain` strips escape codes from an agent's old output.log. */
  readHistory(id: string, offset: number, limit: number, plain?: boolean): Promise<{ data: Buffer; total: number }>;
  onOutput(listener: (chunk: OutputChunk) => void): () => void;
  onAttention(listener: (session: SessionInfo) => void): () => void;
  onTurn(listener: (session: SessionInfo) => void): () => void;
  onChanged(listener: (session: SessionInfo) => void): () => void;
}
