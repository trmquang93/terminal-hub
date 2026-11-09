import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventName, HandshakeInfo, HandshakeState, ListenerKind, ListenerRequest } from '../shared/types';

/** The on-disk handshake record. It holds a SHA-256 of the token, never the token. */
export interface HandshakeRecord {
  id: string;
  state: HandshakeState;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  ackTimeoutSec: number;
  listenerId: string;
  kind: ListenerKind;
  events: EventName[];
  /** What the caller asked to create; null when adding to a running session. */
  sessionRequest: { cwd: string; command: string; title?: string } | null;
  sessionId: string | null;
}

export interface HandshakeCreated {
  record: HandshakeRecord;
  /** The one-time token; only the test event carries it. */
  token: string;
}

export function handshakesDir(dataDir: string): string {
  return join(dataDir, 'handshakes');
}

export function handshakePath(dataDir: string, id: string): string {
  return join(handshakesDir(dataDir), `${id}.json`);
}

export function newHandshake(dataDir: string, listener: ListenerRequest & { id: string }, sessionRequest: HandshakeRecord['sessionRequest'], now: Date = new Date()): HandshakeCreated {
  const ackTimeoutSec = listener.ackTimeoutSec ?? 30;
  const token = randomBytes(32).toString('base64url');
  const record: HandshakeRecord = {
    id: `hs_${randomBytes(8).toString('hex')}`,
    state: 'pending',
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ackTimeoutSec * 1000).toISOString(),
    ackTimeoutSec,
    listenerId: listener.id,
    kind: listener.kind,
    events: listener.events ?? ['attention', 'resolved', 'turn', 'exit'],
    sessionRequest,
    sessionId: null,
  };
  writeHandshake(dataDir, record);
  return { record, token };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of the presented token with the stored hash. */
export function tokenMatches(storedHash: string, token: string): boolean {
  const presented = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function readHandshake(dataDir: string, id: string): HandshakeRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(handshakePath(dataDir, id), 'utf8')) as HandshakeRecord;
    return typeof parsed.id === 'string' && typeof parsed.state === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeHandshake(dataDir: string, record: HandshakeRecord): void {
  const dir = handshakesDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = handshakePath(dataDir, record.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function updateHandshake(dataDir: string, id: string, patch: Partial<HandshakeRecord>): HandshakeRecord | null {
  const current = readHandshake(dataDir, id);
  if (!current) return null;
  const next = { ...current, ...patch };
  writeHandshake(dataDir, next);
  return next;
}

export function deleteHandshake(dataDir: string, id: string): void {
  rmSync(handshakePath(dataDir, id), { force: true });
}

export function isExpired(record: HandshakeRecord, now: Date = new Date()): boolean {
  return Date.parse(record.expiresAt) <= now.getTime();
}

export function handshakeInfo(record: HandshakeRecord): HandshakeInfo {
  return { id: record.id, state: record.state, expiresAt: record.expiresAt, sessionId: record.sessionId };
}

/** Deletes handshake files older than `maxAgeMs` (default 1 h); expired records are useful to a poller for a while. */
export function cleanupHandshakes(dataDir: string, maxAgeMs = 60 * 60 * 1000, now: Date = new Date()): void {
  let names: string[];
  try {
    names = readdirSync(handshakesDir(dataDir));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = readHandshake(dataDir, name.slice(0, -5));
    if (!record) {
      rmSync(join(handshakesDir(dataDir), name), { force: true });
      continue;
    }
    if (now.getTime() - Date.parse(record.createdAt) > maxAgeMs) rmSync(handshakePath(dataDir, record.id), { force: true });
  }
}
