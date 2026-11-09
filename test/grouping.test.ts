import { describe, expect, it } from 'vitest';
import { groupKeyFor, groupSessions, parseGroupMode, parseGroupOrder, placeKey, reorderSaved } from '../src/renderer/grouping';
import type { SessionInfo } from '../src/shared/types';

function session(id: string, cwd: string, startedAt: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, title: id, cwd, command: 'sh', argv: [], env: {}, state: 'exited', claude: null, resumeCount: 0, autoAnswer: null, archived: false,
    startedAt, endedAt: startedAt, exitCode: 0, signal: null, cols: 80, rows: 24, bytesWritten: 0, appVersion: 't',
    running: false, attention: null, turn: null, resumable: true, ...overrides,
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

describe('repo grouping', () => {
  const roots = { '/work/app': '/work/app', '/work/app/packages/ui': '/work/app', '/tmp/scratch': null };
  const repoKey = groupKeyFor('repo', roots);

  it('merges two cwds that share a repo root into one group named after the root', () => {
    const groups = groupSessions([
      session('a', '/work/app', '2026-01-01T00:00:00.000Z'),
      session('b', '/work/app/packages/ui', '2026-01-02T00:00:00.000Z'),
    ], { keyOf: repoKey });
    expect(groups.map((g) => [g.cwd, g.name, g.sessions.map((s) => s.id)])).toEqual([['/work/app', 'app', ['b', 'a']]]);
  });

  it('gives a cwd outside any repo, or not resolved yet, its own group', () => {
    const groups = groupSessions([
      session('a', '/work/app/packages/ui', '2026-01-03T00:00:00.000Z'),
      session('b', '/tmp/scratch', '2026-01-02T00:00:00.000Z'),
      session('c', '/never/looked/up', '2026-01-01T00:00:00.000Z'),
    ], { keyOf: repoKey });
    expect(groups.map((g) => g.cwd)).toEqual(['/work/app', '/tmp/scratch', '/never/looked/up']);
  });

  it('folder mode ignores the roots', () => {
    const groups = groupSessions([session('a', '/work/app', '2026-01-01T00:00:00.000Z'), session('b', '/work/app/packages/ui', '2026-01-02T00:00:00.000Z')], { keyOf: groupKeyFor('folder', roots) });
    expect(groups.map((g) => g.cwd)).toEqual(['/work/app/packages/ui', '/work/app']);
  });
});

describe('manual group order', () => {
  const running = { running: true, state: 'running' as const, endedAt: null };
  const sessions = [
    session('a', '/a', '2026-01-01T00:00:00.000Z'),
    session('b', '/b', '2026-02-01T00:00:00.000Z'),
    session('c', '/c', '2026-03-01T00:00:00.000Z', running),
  ];

  it('beats active-first: a running group stays where the saved order puts it, and keeps its active flag', () => {
    const groups = groupSessions(sessions, { order: ['/a', '/b', '/c'] });
    expect(groups.map((g) => g.cwd)).toEqual(['/a', '/b', '/c']);
    expect(groups.find((g) => g.cwd === '/c')?.active).toBe(true);
  });

  it('puts groups missing from the saved order after it, by the default rule', () => {
    const more = [...sessions, session('d', '/d', '2026-01-15T00:00:00.000Z'), session('e', '/e', '2026-04-01T00:00:00.000Z')];
    expect(groupSessions(more, { order: ['/b', '/a'] }).map((g) => g.cwd)).toEqual(['/b', '/a', '/c', '/e', '/d']);
  });

  it('skips a saved key that no longer has a group', () => {
    expect(groupSessions(sessions, { order: ['/gone', '/b', '/also-gone', '/a'] }).map((g) => g.cwd)).toEqual(['/b', '/a', '/c']);
  });

  it('uses the default rule when no order is saved', () => {
    expect(groupSessions(sessions, { order: [] }).map((g) => g.cwd)).toEqual(['/c', '/b', '/a']);
  });
});

describe('reordering', () => {
  it('places a key before or after a target', () => {
    expect(placeKey(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b']);
    expect(placeKey(['a', 'b', 'c'], 'a', 'b', true)).toEqual(['b', 'a', 'c']);
    expect(placeKey(['a', 'b', 'c'], 'a', 'a', true)).toEqual(['a', 'b', 'c']);
    expect(placeKey(['a', 'b'], 'x', 'a', true)).toEqual(['a', 'b']);
  });

  it('keeps saved keys that are not displayed when saving a move', () => {
    expect(reorderSaved(['b', 'gone', 'a'], ['b', 'a', 'new'], 'new', 'b', false)).toEqual(['new', 'b', 'a', 'gone']);
  });

  it('parses stored mode and order defensively', () => {
    expect(parseGroupMode('repo')).toBe('repo');
    expect(parseGroupMode('x')).toBe('folder');
    expect(parseGroupMode(null)).toBe('folder');
    expect(parseGroupOrder('["/a",1,"/b"]')).toEqual(['/a', '/b']);
    expect(parseGroupOrder('{bad')).toEqual([]);
    expect(parseGroupOrder(null)).toEqual([]);
  });
});
