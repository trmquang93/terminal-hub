import type { SessionInfo } from '../shared/types';
import { baseName } from './format';

export type GroupMode = 'folder' | 'repo';

export interface SessionGroup {
  /** Group key: the session cwd, or the repo root in repo mode. */
  cwd: string;
  name: string;
  /** A session in the group is running or needs attention. */
  active: boolean;
  /** Newest startedAt in the group. */
  latest: string;
  /** Newest first. */
  sessions: SessionInfo[];
}

export interface GroupOptions {
  /** Group key of a session; defaults to its cwd. */
  keyOf?: (session: SessionInfo) => string;
  /** Saved manual order of group keys. */
  order?: readonly string[];
}

export function parseGroupMode(raw: string | null): GroupMode {
  return raw === 'repo' ? 'repo' : 'folder';
}

export function parseGroupOrder(raw: string | null): string[] {
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

/** Repo mode groups by repo root; a cwd with no resolved root (outside a repo, or not looked up yet) keeps its own cwd. */
export function groupKeyFor(mode: GroupMode, roots: Readonly<Record<string, string | null>>): (session: SessionInfo) => string {
  return (session) => (mode === 'repo' ? (roots[session.cwd] ?? session.cwd) : session.cwd);
}

/**
 * Groups sessions. Without a manual order, groups with a live session come first and each tier is ordered by its newest session.
 * A saved manual order wins over that: its keys come first in exactly that order (keys with no group are skipped), so a running or
 * attention group no longer jumps to the top, though its badge stays visible. Groups not in the order follow, by the default rule.
 */
export function groupSessions(sessions: SessionInfo[], options: GroupOptions = {}): SessionGroup[] {
  const keyOf = options.keyOf ?? ((session: SessionInfo) => session.cwd);
  const byKey = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const key = keyOf(session);
    byKey.set(key, [...(byKey.get(key) ?? []), session]);
  }
  const groups = [...byKey].map(([cwd, members]): SessionGroup => {
    const newestFirst = [...members].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      cwd,
      name: baseName(cwd) || '(no folder)',
      active: newestFirst.some((session) => session.running || session.attention !== null),
      latest: newestFirst[0]?.startedAt ?? '',
      sessions: newestFirst,
    };
  });
  const rank = new Map<string, number>();
  for (const key of options.order ?? []) if (!rank.has(key)) rank.set(key, rank.size);
  const automatic = (a: SessionGroup, b: SessionGroup): number => Number(b.active) - Number(a.active) || b.latest.localeCompare(a.latest) || a.cwd.localeCompare(b.cwd);
  return groups.sort((a, b) => {
    const ra = rank.get(a.cwd);
    const rb = rank.get(b.cwd);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return automatic(a, b);
  });
}

/** Moves `key` next to `target` (after it when `after`); unchanged when either is missing or they are the same. */
export function placeKey(keys: readonly string[], key: string, target: string, after: boolean): string[] {
  if (key === target || !keys.includes(key) || !keys.includes(target)) return [...keys];
  const rest = keys.filter((item) => item !== key);
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, key);
  return rest;
}

/** New saved order after moving `key` within the displayed keys. Saved keys that are not displayed now stay, after the displayed ones, so a saved order is never lost. */
export function reorderSaved(saved: readonly string[], displayed: readonly string[], key: string, target: string, after: boolean): string[] {
  const moved = placeKey(displayed, key, target, after);
  return [...moved, ...saved.filter((item) => !displayed.includes(item))];
}
