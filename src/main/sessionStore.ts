import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionMeta, SessionState } from '../shared/types';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLUSH_DELAY_MS = 100;
const CHUNK_SIZE = 1024 * 1024;
/** A shell's output.log keeps only its last KEEP_LINES lines; it is rewritten once it passes TRIM_AFTER_LINES. */
export const KEEP_LINES = 200;
export const TRIM_AFTER_LINES = 400;

interface Writer {
  fd: number;
  /** Bytes in output.log, including output still buffered. */
  total: number;
  /** Newlines in output.log, including output still buffered. */
  lines: number;
  pending: Buffer[];
  timer: ReturnType<typeof setTimeout> | null;
}

export function isSessionId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * On-disk session storage: `<root>/<id>/{meta.json,output.log}`.
 * output.log exists for shell sessions only: Claude Code and opencode keep their own transcript (see transcript.ts).
 * output.log is capped: after a flush it is cut back to its last KEEP_LINES lines once it passes TRIM_AFTER_LINES.
 *
 * Live offsets (what size(), appendOutput(), readChunks() and readOutput() speak) are positions in the whole stream of output
 * since the app started, so they only ever grow. `bases` holds the stream offset of output.log's first byte; a trim moves it
 * forward by the bytes it cut, so `base + file position` stays the stream offset of every byte appended afterwards.
 */
export class SessionStore {
  private readonly writers = new Map<string, Writer>();
  /** Stream offset of the first byte of each session's output.log. Survives close(), so a reopened writer keeps counting up. */
  private readonly bases = new Map<string, number>();

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
      writer = { fd, total: fstatSync(fd).size, lines: this.countLines(id), pending: [], timer: null };
      this.writers.set(id, writer);
    }
    return writer;
  }

  private base(id: string): number {
    return this.bases.get(id) ?? 0;
  }

  /** Buffers output and writes it within FLUSH_DELAY_MS. Returns the live offset the chunk ends at. */
  appendOutput(id: string, chunk: Buffer): number {
    const writer = this.writer(id);
    writer.pending.push(chunk);
    writer.total += chunk.length;
    writer.lines += countNewlines(chunk);
    writer.timer ??= setTimeout(() => this.flush(id), FLUSH_DELAY_MS);
    return this.base(id) + writer.total;
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
    if (writer.lines > TRIM_AFTER_LINES) this.trim(id, writer);
  }

  private countLines(id: string): number {
    let fd: number;
    try {
      fd = openSync(this.outputPath(id), 'r');
    } catch {
      return 0;
    }
    try {
      const block = Buffer.allocUnsafe(CHUNK_SIZE);
      let lines = 0;
      for (let n = readSync(fd, block, 0, block.length, null); n > 0; n = readSync(fd, block, 0, block.length, null)) {
        lines += countNewlines(block.subarray(0, n));
      }
      return lines;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Rewrites output.log as its last KEEP_LINES complete lines: no partial first line, and any partial line at the end is
   * dropped. Runs right after a flush, so nothing is pending and `total` is the file size. The bytes cut move `base` forward
   * so that `base + total` (the live end offset) does not change, and the next appended byte keeps its offset.
   */
  private trim(id: string, writer: Writer): void {
    const path = this.outputPath(id);
    const reader = openSync(path, 'r');
    let kept: Buffer;
    try {
      // Read backwards until the tail holds KEEP_LINES + 1 newlines (the extra one marks where the first kept line starts).
      let tail = Buffer.alloc(0);
      let position = fstatSync(reader).size;
      for (let newlines = 0; position > 0 && newlines <= KEEP_LINES; ) {
        const block = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, position));
        position -= block.length;
        readSync(reader, block, 0, block.length, position);
        newlines += countNewlines(block);
        tail = Buffer.concat([block, tail]);
      }
      const end = tail.lastIndexOf(10) + 1;
      let start = end;
      for (let line = 0; line < KEEP_LINES && start > 0; line++) {
        start = start >= 2 ? tail.lastIndexOf(10, start - 2) + 1 : 0;
      }
      kept = tail.subarray(start, end);
    } finally {
      closeSync(reader);
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, kept);
    renameSync(tmp, path);
    closeSync(writer.fd);
    writer.fd = openSync(path, 'a');
    this.bases.set(id, this.base(id) + writer.total - kept.length);
    writer.total = kept.length;
    writer.lines = countNewlines(kept);
  }

  /** Flushes and closes the output file handle; later appends reopen it. */
  close(id: string): void {
    this.flush(id);
    const writer = this.writers.get(id);
    if (writer) closeSync(writer.fd);
    this.writers.delete(id);
  }

  /** The live offset output runs to: the stream offset of output.log's end, including anything still buffered. */
  size(id: string): number {
    const writer = this.writers.get(id);
    if (writer) return this.base(id) + writer.total;
    try {
      return this.base(id) + statSync(this.outputPath(id)).size;
    } catch {
      return 0;
    }
  }

  /** The live offset output.log starts at: anything before it has been trimmed away. */
  startOffset(id: string): number {
    return this.base(id);
  }

  /** Reads live offsets [start, end); the part before startOffset() is gone and is skipped. */
  async *readChunks(id: string, start: number, end: number): AsyncGenerator<Buffer> {
    this.flush(id);
    const base = this.base(id);
    if (Math.max(start, base) >= end) return;
    const handle = await open(this.outputPath(id), 'r');
    try {
      for (let position = Math.max(start, base) - base; position < end - base; ) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, end - base - position));
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
    this.flush(id);
    const total = this.size(id);
    const start = Math.min(Math.max(offset, this.base(id)), total);
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
    this.bases.delete(id);
    rmSync(dir, { recursive: true, force: true });
  }
}

function countNewlines(data: Buffer): number {
  let count = 0;
  for (let at = data.indexOf(10); at !== -1; at = data.indexOf(10, at + 1)) count++;
  return count;
}
