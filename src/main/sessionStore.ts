import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionMeta, SessionState } from '../shared/types';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLUSH_DELAY_MS = 100;
const CHUNK_SIZE = 1024 * 1024;

interface Writer {
  fd: number;
  total: number;
  pending: Buffer[];
  timer: ReturnType<typeof setTimeout> | null;
}

export function isSessionId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * On-disk session storage: `<root>/<id>/{meta.json,output.log}`.
 * output.log exists for shell sessions only: Claude Code and opencode keep their own transcript (see transcript.ts).
 * Nothing here ever prunes; only delete()/deleteAll() remove data.
 */
export class SessionStore {
  private readonly writers = new Map<string, Writer>();

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  private dir(id: string): string {
    if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`);
    return join(this.root, id);
  }

  private outputPath(id: string): string {
    return join(this.dir(id), 'output.log');
  }

  create(meta: SessionMeta): void {
    mkdirSync(this.dir(meta.id), { recursive: true });
    if (meta.claude === null) appendFileSync(this.outputPath(meta.id), '');
    this.writeMeta(meta);
  }

  writeMeta(meta: SessionMeta): void {
    const path = join(this.dir(meta.id), 'meta.json');
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
    renameSync(tmp, path);
  }

  /**
   * Loads every session folder. A session recorded as `running` has no live
   * process at load time, so it becomes `interrupted` (and is persisted so).
   */
  loadAll(): SessionMeta[] {
    const sessions: SessionMeta[] = [];
    for (const name of readdirSync(this.root)) {
      if (!isSessionId(name)) continue;
      let raw: Partial<SessionMeta>;
      try {
        raw = JSON.parse(readFileSync(join(this.root, name, 'meta.json'), 'utf8')) as Partial<SessionMeta>;
      } catch (error) {
        console.error(`skipping unreadable session ${name}:`, error);
        continue;
      }
      sessions.push(this.reconcile(name, raw));
    }
    return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  private reconcile(id: string, raw: Partial<SessionMeta>): SessionMeta {
    const logSize = this.size(id);
    const wasRunning = raw.state === 'running' || (raw.state === undefined && raw.endedAt == null);
    const state: SessionState = wasRunning ? 'interrupted' : (raw.state ?? 'exited');
    const startedAt = raw.startedAt ?? new Date(0).toISOString();
    const meta: SessionMeta = {
      id,
      title: raw.title ?? id,
      cwd: raw.cwd ?? '',
      command: raw.command ?? '',
      argv: raw.argv ?? [],
      env: raw.env ?? {},
      state,
      claude: raw.claude ? { ...raw.claude, provider: raw.claude.provider === 'opencode' ? 'opencode' : 'claude' } : null,
      resumeCount: raw.resumeCount ?? 0,
      autoAnswer: raw.autoAnswer ?? null,
      archived: raw.archived === true,
      startedAt,
      endedAt: raw.endedAt ?? (wasRunning ? this.lastWrite(id, startedAt) : null),
      exitCode: raw.exitCode ?? null,
      signal: raw.signal ?? null,
      cols: raw.cols ?? 80,
      rows: raw.rows ?? 24,
      bytesWritten: logSize,
      appVersion: raw.appVersion ?? '',
    };
    if (wasRunning || meta.bytesWritten !== raw.bytesWritten) this.writeMeta(meta);
    return meta;
  }

  private lastWrite(id: string, fallback: string): string {
    // An agent session has no output.log; meta.json is rewritten on every title and id change.
    for (const path of [this.outputPath(id), join(this.dir(id), 'meta.json')]) {
      try {
        return statSync(path).mtime.toISOString();
      } catch {
        // try the next file
      }
    }
    return fallback;
  }

  private writer(id: string): Writer {
    let writer = this.writers.get(id);
    if (!writer) {
      const fd = openSync(this.outputPath(id), 'a');
      writer = { fd, total: fstatSync(fd).size, pending: [], timer: null };
      this.writers.set(id, writer);
    }
    return writer;
  }

  /** Buffers output and writes it within FLUSH_DELAY_MS. Returns the new total size. */
  appendOutput(id: string, chunk: Buffer): number {
    const writer = this.writer(id);
    writer.pending.push(chunk);
    writer.total += chunk.length;
    writer.timer ??= setTimeout(() => this.flush(id), FLUSH_DELAY_MS);
    return writer.total;
  }

  /** One JSON line per auto-answer, so unattended approvals can be audited. */
  appendAnswerLog(id: string, entry: Record<string, string>): void {
    appendFileSync(join(this.dir(id), 'answers.log'), `${JSON.stringify(entry)}\n`);
  }

  flush(id: string): void {
    const writer = this.writers.get(id);
    if (!writer) return;
    if (writer.timer) clearTimeout(writer.timer);
    writer.timer = null;
    if (writer.pending.length === 0) return;
    const data = Buffer.concat(writer.pending);
    writer.pending = [];
    writeSync(writer.fd, data);
  }

  /** Flushes and closes the output file handle; later appends reopen it. */
  close(id: string): void {
    this.flush(id);
    const writer = this.writers.get(id);
    if (writer) closeSync(writer.fd);
    this.writers.delete(id);
  }

  /** Total bytes of output.log, including anything still buffered. */
  size(id: string): number {
    const writer = this.writers.get(id);
    if (writer) return writer.total;
    try {
      return statSync(this.outputPath(id)).size;
    } catch {
      return 0;
    }
  }

  async *readChunks(id: string, start: number, end: number): AsyncGenerator<Buffer> {
    this.flush(id);
    if (start >= end) return;
    const handle = await open(this.outputPath(id), 'r');
    try {
      for (let position = start; position < end; ) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, end - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) return;
        yield buffer.subarray(0, bytesRead);
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  async readOutput(id: string, offset = 0, limit = Infinity): Promise<Buffer> {
    const total = this.size(id);
    const start = Math.min(Math.max(offset, 0), total);
    const end = Math.min(total, start + limit);
    const parts: Buffer[] = [];
    for await (const chunk of this.readChunks(id, start, end)) parts.push(chunk);
    return Buffer.concat(parts);
  }

  delete(id: string): void {
    const dir = this.dir(id);
    const writer = this.writers.get(id);
    if (writer) {
      if (writer.timer) clearTimeout(writer.timer);
      closeSync(writer.fd);
      this.writers.delete(id);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
