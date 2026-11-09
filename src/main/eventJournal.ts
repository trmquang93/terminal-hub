import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HubEvent } from '../shared/types';

export const JOURNAL_MAX_LINES = 5000;
export const JOURNAL_MAX_BYTES = 1024 * 1024;
export const EVENTS_PAGE_LIMIT = 500;

export function eventsPath(sessionDir: string): string {
  return join(sessionDir, 'events.jsonl');
}

function parseLine(line: string): HubEvent | null {
  if (line.trim() === '') return null;
  try {
    const parsed = JSON.parse(line) as HubEvent;
    return typeof parsed.seq === 'number' && typeof parsed.eventId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `sessions/<id>/events.jsonl`: one JSON line per emitted event, with a persisted monotonic `seq`.
 * Capped at JOURNAL_MAX_LINES / JOURNAL_MAX_BYTES, oldest first. Every event is written once, whether or not a
 * listener is alive, so a listener that was down can replay from its cursor.
 */
export class EventJournal {
  private readonly seqs = new Map<string, number>();

  constructor(private readonly sessionsRoot: string) {}

  private dir(sessionId: string): string {
    return join(this.sessionsRoot, sessionId);
  }

  private path(sessionId: string): string {
    return eventsPath(this.dir(sessionId));
  }

  private lastSeq(sessionId: string): number {
    const cached = this.seqs.get(sessionId);
    if (cached !== undefined) return cached;
    let seq = 0;
    try {
      for (const line of readFileSync(this.path(sessionId), 'utf8').split('\n')) {
        const event = parseLine(line);
        if (event && event.seq > seq) seq = event.seq;
      }
    } catch {
      // no journal yet
    }
    this.seqs.set(sessionId, seq);
    return seq;
  }

  /** Appends one event, assigning eventId/seq/at when the caller left them empty. Never throws into the PTY loop. */
  append(sessionId: string, event: Omit<HubEvent, 'seq' | 'eventId' | 'at'> & Partial<Pick<HubEvent, 'seq' | 'eventId' | 'at'>>): HubEvent | null {
    const seq = (event.seq ?? 0) > 0 ? (event.seq as number) : this.lastSeq(sessionId) + 1;
    const stored: HubEvent = {
      ...event,
      eventId: event.eventId ?? `evt_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-6)}`,
      seq,
      at: event.at ?? new Date().toISOString(),
    };
    try {
      mkdirSync(this.dir(sessionId), { recursive: true });
      appendFileSync(this.path(sessionId), `${JSON.stringify(stored)}\n`);
      this.seqs.set(sessionId, seq);
      this.trim(sessionId);
      return stored;
    } catch {
      return null;
    }
  }

  /** Events with `seq > since`, oldest first, at most `limit` (default EVENTS_PAGE_LIMIT). */
  read(sessionId: string, since = 0, limit = EVENTS_PAGE_LIMIT): { events: HubEvent[]; next: number } {
    let lines: string[];
    try {
      lines = readFileSync(this.path(sessionId), 'utf8').split('\n');
    } catch {
      return { events: [], next: since };
    }
    const events: HubEvent[] = [];
    for (const line of lines) {
      const event = parseLine(line);
      if (event && event.seq > since) events.push(event);
    }
    const page = events.slice(0, Math.max(1, limit));
    return { events: page, next: page.at(-1)?.seq ?? since };
  }

  /** The last known seq for a session (its cursor high-water mark). */
  last(sessionId: string): number {
    return this.lastSeq(sessionId);
  }

  forget(sessionId: string): void {
    this.seqs.delete(sessionId);
  }

  private trim(sessionId: string): void {
    const path = this.path(sessionId);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const bytes = Buffer.byteLength(text);
    if (lines.length <= JOURNAL_MAX_LINES && bytes <= JOURNAL_MAX_BYTES) return;
    let start = Math.max(0, lines.length - JOURNAL_MAX_LINES);
    const keptBytes = (from: number): number => Buffer.byteLength(lines.slice(from).join('\n')) + 1;
    while (start < lines.length - 1 && keptBytes(start) > JOURNAL_MAX_BYTES) start++;
    const kept = lines.slice(start);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }
}
