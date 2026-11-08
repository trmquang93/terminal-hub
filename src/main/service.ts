import type { AnswerRequest, SessionInfo, StartSessionOptions } from '../shared/types';

export interface OutputChunk {
  id: string;
  /** Byte offset in output.log just after this chunk. */
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
  hookNotify(notification: { hubSessionId?: string; sessionId?: string; message: string }): boolean;
  stop(id: string): void;
  remove(id: string): Promise<void>;
  setTitle(id: string, title: string): SessionInfo;
  size(id: string): number;
  readChunks(id: string, start: number, end: number): AsyncGenerator<Buffer>;
  readOutput(id: string, offset: number, limit: number): Promise<Buffer>;
  onOutput(listener: (chunk: OutputChunk) => void): () => void;
  onAttention(listener: (session: SessionInfo) => void): () => void;
  onChanged(listener: (session: SessionInfo) => void): () => void;
}
