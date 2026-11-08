import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface NotifyConfig {
  url: string;
  /** Empty when no Authorization header should be sent. */
  bearer: string;
  source: 'file' | 'env';
}

export interface NotifyConfigResult {
  config: NotifyConfig | null;
  /** Why a present-but-unusable source was ignored. */
  warning?: string;
}

export function notifyConfigPath(dir: string): string {
  return join(dir, 'notify.json');
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * `<dir>/notify.json` wins; the `TERMINAL_HUB_NOTIFY_URL` / `_BEARER` env vars are the fallback. One source is used whole,
 * so a bearer meant for one endpoint is never sent to another. Called for every send: edits apply without a restart.
 */
export function loadNotifyConfig(dir: string, env: NodeJS.ProcessEnv = process.env): NotifyConfigResult {
  let warning: string | undefined;
  let raw: string | null = null;
  try {
    raw = readFileSync(notifyConfigPath(dir), 'utf8');
  } catch {
    // no file: fall back to the environment
  }
  if (raw !== null && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      const url = typeof parsed === 'object' && parsed !== null ? parsed.url : undefined;
      if (validUrl(url)) {
        const bearer = typeof parsed?.bearer === 'string' ? parsed.bearer.trim() : '';
        return { config: { url, bearer, source: 'file' } };
      }
      if (url !== undefined && url !== '') warning = 'notify.json has no usable http(s) "url"';
    } catch {
      warning = 'notify.json is not valid JSON';
    }
  }
  const envUrl = env.TERMINAL_HUB_NOTIFY_URL?.trim();
  if (validUrl(envUrl)) return { config: { url: envUrl, bearer: env.TERMINAL_HUB_NOTIFY_BEARER?.trim() ?? '', source: 'env' }, warning };
  return { config: null, warning: warning ?? (envUrl ? 'TERMINAL_HUB_NOTIFY_URL is not an http(s) URL' : undefined) };
}
