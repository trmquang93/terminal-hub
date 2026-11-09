import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventJournal, JOURNAL_MAX_LINES } from '../src/main/eventJournal';
import type { HubEvent } from '../src/shared/types';

const SID = '11111111-1111-4111-8111-111111111111';
let root: string;

function event(seq = 0): Omit<HubEvent, 'seq' | 'eventId' | 'at'> & { seq?: number } {
  return {
    ...(seq > 0 ? { seq } : {}),
    event: 'attention',
    session: { id: SID, title: 't', cwd: '/tmp', command: 'sh', state: 'running', exitCode: null },
    attention: { reason: 'prompt', promptText: 'Continue?', source: 'heuristic', since: '2026-01-01T00:00:00.000Z' },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'thub-journal-'));
  mkdirSync(join(root, SID), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('EventJournal', () => {
  it('assigns a persisted monotonic seq and replays only events after `since`', () => {
    const journal = new EventJournal(root);
    const first = journal.append(SID, event());
    const second = journal.append(SID, event());
    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);

    // A fresh instance (an app restart) keeps counting from the file, not from zero.
    const reloaded = new EventJournal(root);
    const third = reloaded.append(SID, event());
    expect(third?.seq).toBe(3);
    expect(reloaded.read(SID, 1)).toMatchObject({ next: 3 });
    expect(reloaded.read(SID, 1).events.map((item) => item.seq)).toEqual([2, 3]);
    expect(reloaded.read(SID, 3).events).toEqual([]);
  });

  it('writes exactly one JSON line per event and keeps eventId/at', () => {
    const journal = new EventJournal(root);
    const stored = journal.append(SID, event());
    const lines = readFileSync(join(root, SID, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ seq: 1, eventId: stored?.eventId, event: 'attention' });
  });

  it('trims oldest lines first once the journal passes its line cap', () => {
    const lines = Array.from({ length: JOURNAL_MAX_LINES + 5 }, (_, index) => JSON.stringify({ ...event(index + 1), eventId: `evt_${index + 1}`, at: '2026-01-01T00:00:00.000Z' }));
    writeFileSync(join(root, SID, 'events.jsonl'), `${lines.join('\n')}\n`);
    const journal = new EventJournal(root);
    const stored = journal.append(SID, event());
    expect(stored?.seq).toBe(JOURNAL_MAX_LINES + 6);
    const kept = journal.read(SID, 0, JOURNAL_MAX_LINES + 10).events;
    // Both caps apply: the byte cap bites first here, so the journal keeps fewer than the line cap.
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(JOURNAL_MAX_LINES);
    expect(Buffer.byteLength(readFileSync(join(root, SID, 'events.jsonl')))).toBeLessThanOrEqual(1024 * 1024);
    expect(kept[0]?.seq).toBeGreaterThan(7);
    expect(kept.at(-1)?.seq).toBe(JOURNAL_MAX_LINES + 6);
  });
});
