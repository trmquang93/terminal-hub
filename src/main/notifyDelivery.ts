import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AttentionInfo, SessionInfo } from '../shared/types';
import { loadNotifyConfig, type NotifyConfig } from './notifyConfig';

export const NOTIFY_TIMEOUT_MS = 5000;
export const NOTIFY_MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and 3. */
export const NOTIFY_BACKOFF_MS = [500, 1500];
export const NOTIFY_LOG_MAX_BYTES = 1024 * 1024;
const MAX_PROMPT_CHARS = 4000;

export type NotifyEventName = 'attention' | 'resolved';

export interface NotifyEvent {
  event: NotifyEventName;
  session: {
    id: string;
    title: string;
    cwd: string;
    command: string;
    state: string;
    reason: AttentionInfo['reason'];
    promptText: string;
    source: AttentionInfo['source'];
    since: string;
  };
}

/**
 * The payload is built field by field from an allow-list: metadata and the detected question only. `secrets` (the app's API
 * token, the webhook bearer) are scrubbed from the question text in case the screen ever shows one.
 */
export function buildEvent(event: NotifyEventName, session: Pick<SessionInfo, 'id' | 'title' | 'cwd' | 'command' | 'state'>, attention: AttentionInfo, secrets: readonly string[] = []): NotifyEvent {
  let promptText = attention.promptText;
  for (const secret of secrets) if (secret.length >= 8) promptText = promptText.replaceAll(secret, '[redacted]');
  return {
    event,
    session: {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      command: session.command,
      state: session.state,
      reason: attention.reason,
      promptText: promptText.slice(-MAX_PROMPT_CHARS),
      source: attention.source,
      since: attention.since,
    },
  };
}

/** Append-only log with one rotation (`.1`) once it passes the cap. Never throws. */
export class NotifyLog {
  private readonly path: string;

  constructor(
    dir: string,
    private readonly maxBytes: number = NOTIFY_LOG_MAX_BYTES,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dir, 'notifications.log');
  }

  write(level: 'INFO' | 'WARN', message: string): void {
    try {
      try {
        if (statSync(this.path).size >= this.maxBytes) renameSync(this.path, `${this.path}.1`);
      } catch {
        // no log yet
      }
      appendFileSync(this.path, `${this.now().toISOString()} ${level} ${message}\n`);
    } catch {
      // logging must never break the app
    }
  }
}

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  /** Last HTTP status, null when the last attempt never got a response. */
  status: number | null;
  error?: string;
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: NotifyLog;
  maxAttempts?: number;
  timeoutMs?: number;
  backoffMs?: readonly number[];
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return String(typeof code === 'string' ? code : error.message).slice(0, 160);
  }
  return 'unknown error';
}

/** Network errors, 5xx and 429 are worth another try; any other status is final. */
export function isRetryable(status: number | null): boolean {
  return status === null || status >= 500 || status === 429;
}

/** The host only: the path of a webhook URL is usually its secret. */
function origin(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/** POSTs one event. Never throws; every attempt and the outcome are logged. */
export async function deliver(config: NotifyConfig, payload: NotifyEvent, options: DeliverOptions = {}): Promise<DeliveryResult> {
  const { fetchImpl = fetch, sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)), log, maxAttempts = NOTIFY_MAX_ATTEMPTS, timeoutMs = NOTIFY_TIMEOUT_MS, backoffMs = NOTIFY_BACKOFF_MS } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.bearer !== '') headers.Authorization = `Bearer ${config.bearer}`;
  const body = JSON.stringify(payload);
  const label = `${payload.event} session=${payload.session.id.slice(0, 8)} host=${origin(config.url)}`;
  let result: DeliveryResult = { ok: false, attempts: 0, status: null };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    let status: number | null = null;
    let error: string | undefined;
    try {
      const response = await fetchImpl(config.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      status = response.status;
      await response.body?.cancel().catch(() => undefined);
    } catch (caught) {
      error = describeError(caught);
    }
    const ok = status !== null && status >= 200 && status < 300;
    result = { ok, attempts: attempt, status, ...(ok ? {} : { error: error ?? `HTTP ${String(status)}` }) };
    const outcome = status === null ? `failed: ${String(error)}` : `HTTP ${status}`;
    const retry = !ok && isRetryable(status) && attempt < maxAttempts;
    const wait = backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 0;
    log?.write(ok ? 'INFO' : 'WARN', `${label} attempt ${attempt}/${maxAttempts} ${outcome} (${Date.now() - started} ms)${retry ? `, retrying in ${wait} ms` : ''}`);
    if (ok) return result;
    if (!retry) break;
    await sleep(wait);
  }
  log?.write('WARN', `${label} not delivered after ${result.attempts} attempt(s): ${result.error ?? 'unknown'}`);
  return result;
}

/** A send function that re-reads the configuration on every call, so editing notify.json takes effect at once. */
export function createSender(dir: string, log: NotifyLog, options: DeliverOptions & { env?: NodeJS.ProcessEnv } = {}): (event: NotifyEvent) => Promise<DeliveryResult | null> {
  return async (event) => {
    try {
      const { config, warning } = loadNotifyConfig(dir, options.env);
      if (warning) log.write('WARN', `${warning}; ignored`);
      if (!config) return null;
      return await deliver(config, event, { ...options, log });
    } catch (error) {
      log.write('WARN', `unexpected error: ${describeError(error)}`);
      return null;
    }
  };
}
