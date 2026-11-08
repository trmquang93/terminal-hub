import { describe, expect, it } from 'vitest';
import { groupSessions } from '../src/renderer/grouping';
import type { SessionInfo } from '../src/shared/types';

function session(id: string, cwd: string, startedAt: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, title: id, cwd, command: 'sh', argv: [], env: {}, state: 'exited', claude: null, resumeCount: 0, autoAnswer: null, archived: false,
    startedAt, endedAt: startedAt, exitCode: 0, signal: null, cols: 80, rows: 24, bytesWritten: 0, appVersion: 't',
    running: false, attention: null, resumable: true, ...overrides,
  };
}

describe('groupSessions', () => {
  it('returns no groups for no sessions', () => {
    expect(groupSessions([])).toEqual([]);
  });

  it('groups by cwd, names a group after its folder and orders sessions newest first', () => {
    const groups = groupSessions([
      session('a1', '/work/app', '2026-01-01T00:00:00.000Z'),
      session('b1', '/work/site/', '2026-01-02T00:00:00.000Z'),
      session('a2', '/work/app', '2026-01-03T00:00:00.000Z'),
      session('a3', '/work/app', '2026-01-02T12:00:00.000Z'),
    ]);
    expect(groups.map((g) => [g.cwd, g.name])).toEqual([['/work/app', 'app'], ['/work/site/', 'site']]);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['a2', 'a3', 'a1']);
    expect(groups[0]?.latest).toBe('2026-01-03T00:00:00.000Z');
  });

  it('orders idle groups by their newest session', () => {
    const groups = groupSessions([session('old', '/a', '2026-01-01T00:00:00.000Z'), session('new', '/b', '2026-02-01T00:00:00.000Z'), session('mid', '/c', '2026-01-15T00:00:00.000Z')]);
    expect(groups.map((g) => g.cwd)).toEqual(['/b', '/c', '/a']);
  });

  it('keeps a group with a running session above newer idle groups, by recency within that tier', () => {
    const groups = groupSessions([
      session('idle-new', '/idle-new', '2026-03-01T00:00:00.000Z'),
      session('run-old', '/run-old', '2026-01-01T00:00:00.000Z', { running: true, state: 'running', endedAt: null }),
      session('run-new', '/run-new', '2026-02-01T00:00:00.000Z', { running: true, state: 'running', endedAt: null }),
      session('idle-old', '/idle-old', '2026-01-15T00:00:00.000Z'),
    ]);
    expect(groups.map((g) => [g.cwd, g.active])).toEqual([['/run-new', true], ['/run-old', true], ['/idle-new', false], ['/idle-old', false]]);
  });

  it('counts a session needing attention as active, and a running one does not reorder the sessions inside its group', () => {
    const attention = { reason: 'prompt' as const, promptText: 'Continue? [y/N]', since: '2026-01-01T00:00:00.000Z', source: 'heuristic' as const };
    const groups = groupSessions([
      session('newer-idle', '/other', '2026-05-01T00:00:00.000Z'),
      session('old-running', '/busy', '2026-01-01T00:00:00.000Z', { running: true, state: 'running', attention }),
      session('new-done', '/busy', '2026-04-01T00:00:00.000Z'),
    ]);
    expect(groups.map((g) => g.cwd)).toEqual(['/busy', '/other']);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['new-done', 'old-running']);
  });

  it('does not mutate its input and labels an empty cwd', () => {
    const input = [session('x', '', '2026-01-01T00:00:00.000Z'), session('y', '', '2026-01-02T00:00:00.000Z')];
    const copy = [...input];
    const [group] = groupSessions(input);
    expect(input).toEqual(copy);
    expect(group?.name).toBe('(no folder)');
  });
});
