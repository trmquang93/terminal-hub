const WATCHED = new Set(['attention', 'turn', 'exit']);

/** One /events SSE message as a JSON line `{"event": …, …payload}`, or null for anything `hub watch` does not print. */
export function formatWatchLine(event: string | undefined, data: string): string | null {
  if (event === undefined || !WATCHED.has(event)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  return JSON.stringify(Object.assign({ event }, payload, { event }));
}
