export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function shortenPath(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
