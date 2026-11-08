import type { SessionInfo } from '../shared/types';
import { baseName } from './format';

export interface SessionGroup {
  cwd: string;
  name: string;
  /** A session in the group is running or needs attention. */
  active: boolean;
  /** Newest startedAt in the group. */
  latest: string;
  /** Newest first. */
  sessions: SessionInfo[];
}

/** Groups by cwd. Groups with a live session come first; each tier is ordered by its newest session. */
export function groupSessions(sessions: SessionInfo[]): SessionGroup[] {
  const byCwd = new Map<string, SessionInfo[]>();
  for (const session of sessions) byCwd.set(session.cwd, [...(byCwd.get(session.cwd) ?? []), session]);
  const groups = [...byCwd].map(([cwd, members]): SessionGroup => {
    const newestFirst = [...members].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      cwd,
      name: baseName(cwd) || '(no folder)',
      active: newestFirst.some((session) => session.running || session.attention !== null),
      latest: newestFirst[0]?.startedAt ?? '',
      sessions: newestFirst,
    };
  });
  return groups.sort((a, b) => Number(b.active) - Number(a.active) || b.latest.localeCompare(a.latest) || a.cwd.localeCompare(b.cwd));
}
