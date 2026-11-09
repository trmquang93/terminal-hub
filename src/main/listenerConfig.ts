import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EventName, ListenerInfo, ListenerKind, ListenerRequest, ListenerState } from '../shared/types';
import { HubError } from './errors';

export const EVENT_NAMES: readonly EventName[] = ['attention', 'resolved', 'turn', 'exit'];
export const DEFAULT_EVENTS: EventName[] = [...EVENT_NAMES];
export const DEFAULT_ACK_TIMEOUT_SEC = 30;
export const MAX_ACK_TIMEOUT_SEC = 300;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
export const MAX_COMMAND_TIMEOUT_MS = 60000;

const LISTENER_KINDS: readonly ListenerKind[] = ['openmausbot', 'http', 'command'];
const TOP_KEYS = new Set(['kind', 'events', 'ackTimeoutSec', 'http', 'command', 'openmausbot']);
const ENDPOINT_KEYS: Record<ListenerKind, string> = { http: 'http', command: 'command', openmausbot: 'openmausbot' };

/** A listener as it is stored on disk: the caller's request plus server-generated identity and state. */
export interface StoredListener extends ListenerRequest {
  id: string;
  state: ListenerState;
  createdAt: string;
  acknowledgedAt: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(message: string): never {
  throw new HubError(400, message);
}

function stringMap(value: unknown, name: string): Record<string, string> {
  if (!isObject(value)) bad(`${name} must be an object of strings`);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') bad(`${name}.${key} must be a string`);
  }
  return value as Record<string, string>;
}

function validateHttp(block: unknown): ListenerRequest['http'] {
  if (!isObject(block)) bad('http must be an object');
  const allowed = new Set(['url', 'bearer', 'headers']);
  for (const key of Object.keys(block)) if (!allowed.has(key)) bad(`http.${key} is not allowed`);
  if (typeof block.url !== 'string') bad('http.url must be a string');
  let protocol: string;
  try {
    protocol = new URL(block.url).protocol;
  } catch {
    return bad('http.url must be an absolute http(s) URL');
  }
  if (protocol !== 'http:' && protocol !== 'https:') bad('http.url must be an absolute http(s) URL');
  if (block.bearer !== undefined && typeof block.bearer !== 'string') bad('http.bearer must be a string');
  return {
    url: block.url,
    ...(typeof block.bearer === 'string' ? { bearer: block.bearer } : {}),
    ...(block.headers !== undefined ? { headers: stringMap(block.headers, 'http.headers') } : {}),
  };
}

function validateCommand(block: unknown): ListenerRequest['command'] {
  if (!isObject(block)) bad('command must be an object');
  const allowed = new Set(['argv', 'cwd', 'timeoutMs']);
  for (const key of Object.keys(block)) if (!allowed.has(key)) bad(`command.${key} is not allowed`);
  if (!Array.isArray(block.argv) || block.argv.length === 0 || !block.argv.every((item) => typeof item === 'string' && item !== '')) {
    bad('command.argv must be a non-empty array of strings');
  }
  if (block.cwd !== undefined && (typeof block.cwd !== 'string' || !block.cwd.startsWith('/'))) bad('command.cwd must be an absolute path');
  if (block.timeoutMs !== undefined && (typeof block.timeoutMs !== 'number' || !Number.isFinite(block.timeoutMs) || block.timeoutMs <= 0)) {
    bad('command.timeoutMs must be a positive number');
  }
  return {
    argv: block.argv as string[],
    ...(typeof block.cwd === 'string' ? { cwd: block.cwd } : {}),
    ...(typeof block.timeoutMs === 'number' ? { timeoutMs: Math.min(Math.round(block.timeoutMs), MAX_COMMAND_TIMEOUT_MS) } : {}),
  };
}

function validateOpenmausbot(block: unknown): ListenerRequest['openmausbot'] {
  if (!isObject(block)) bad('openmausbot must be an object');
  const allowed = new Set(['botId', 'threadId']);
  for (const key of Object.keys(block)) if (!allowed.has(key)) bad(`openmausbot.${key} is not allowed`);
  if (typeof block.botId !== 'string' || block.botId === '') bad('openmausbot.botId must be a non-empty string');
  if (typeof block.threadId !== 'string' || block.threadId === '') bad('openmausbot.threadId must be a non-empty string');
  return { botId: block.botId, threadId: block.threadId };
}

/** Validates one listener request. Throws HubError(400) naming the first problem. */
export function validateListener(raw: unknown): ListenerRequest {
  if (!isObject(raw)) bad('a listener must be an object');
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) bad(`unknown listener key: ${key}`);
  const kind = raw.kind;
  if (typeof kind !== 'string' || !LISTENER_KINDS.includes(kind as ListenerKind)) bad('listener.kind must be one of openmausbot, http, command');
  const typedKind = kind as ListenerKind;

  for (const [otherKind, key] of Object.entries(ENDPOINT_KEYS)) {
    if (otherKind !== typedKind && raw[key] !== undefined) bad(`a ${typedKind} listener must not carry a ${key} block`);
  }
  const endpointKey = ENDPOINT_KEYS[typedKind];
  if (raw[endpointKey] === undefined) bad(`a ${typedKind} listener needs its ${endpointKey} block`);

  let events: EventName[] = DEFAULT_EVENTS;
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events)) bad('listener.events must be an array');
    for (const name of raw.events) if (typeof name !== 'string' || !EVENT_NAMES.includes(name as EventName)) bad(`unknown event name: ${String(name)}`);
    events = raw.events.length === 0 ? DEFAULT_EVENTS : [...new Set(raw.events as EventName[])];
  }

  let ackTimeoutSec: number | undefined;
  if (raw.ackTimeoutSec !== undefined) {
    if (typeof raw.ackTimeoutSec !== 'number' || !Number.isInteger(raw.ackTimeoutSec) || raw.ackTimeoutSec < 1 || raw.ackTimeoutSec > MAX_ACK_TIMEOUT_SEC) {
      bad(`ackTimeoutSec must be an integer between 1 and ${MAX_ACK_TIMEOUT_SEC}`);
    }
    ackTimeoutSec = raw.ackTimeoutSec;
  }

  const endpoint =
    typedKind === 'http' ? validateHttp(raw.http) : typedKind === 'command' ? validateCommand(raw.command) : validateOpenmausbot(raw.openmausbot);
  return { kind: typedKind, events, ...(ackTimeoutSec === undefined ? {} : { ackTimeoutSec }), [endpointKey]: endpoint };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The read shape: never a full URL, bearer, header value or argv beyond argv[0]'s basename. */
export function redactListener(listener: StoredListener): ListenerInfo {
  const base: ListenerInfo = {
    id: listener.id,
    kind: listener.kind,
    events: listener.events ?? DEFAULT_EVENTS,
    state: listener.state,
    createdAt: listener.createdAt,
    acknowledgedAt: listener.acknowledgedAt,
    ...(listener.ackTimeoutSec === undefined ? {} : { ackTimeoutSec: listener.ackTimeoutSec }),
  };
  if (listener.kind === 'http' && listener.http) base.host = hostOf(listener.http.url);
  if (listener.kind === 'command' && listener.command) {
    base.command = basename(listener.command.argv[0] ?? '');
    base.argvLength = listener.command.argv.length;
  }
  if (listener.kind === 'openmausbot' && listener.openmausbot) {
    base.botId = listener.openmausbot.botId;
    base.threadId = listener.openmausbot.threadId;
  }
  return base;
}

export function listenersPath(sessionDir: string): string {
  return join(sessionDir, 'listeners.json');
}

export function readListeners(sessionDir: string): StoredListener[] {
  let raw: string;
  try {
    raw = readFileSync(listenersPath(sessionDir), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredListener => isObject(item) && typeof item.id === 'string' && typeof item.kind === 'string' && typeof item.state === 'string' && typeof item.createdAt === 'string');
  } catch {
    return [];
  }
}

/** Atomic 0600 rewrite; it can hold a bearer or header values. */
export function writeListeners(sessionDir: string, listeners: StoredListener[]): void {
  mkdirSync(sessionDir, { recursive: true });
  const path = listenersPath(sessionDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(listeners, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** A listener's per-listener directory (cursor and delivery log). Removed with the session folder. */
export function listenerDir(sessionDir: string, listenerId: string): string {
  return join(sessionDir, 'listeners', listenerId);
}

export function removeListenerDir(sessionDir: string, listenerId: string): void {
  rmSync(listenerDir(sessionDir, listenerId), { recursive: true, force: true });
}
