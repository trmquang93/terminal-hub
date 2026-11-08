import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiFilePath } from './paths';

export interface ApiFile {
  baseUrl: string;
  token: string;
  pid: number;
}

function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function loadOrCreateToken(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'token');
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= 32) {
      chmodSync(path, 0o600);
      return token;
    }
  }
  const token = randomBytes(32).toString('hex');
  writePrivate(path, `${token}\n`);
  return token;
}

export function writeApiFile(dir: string, info: ApiFile): void {
  mkdirSync(dir, { recursive: true });
  writePrivate(apiFilePath(dir), `${JSON.stringify(info, null, 2)}\n`);
}

/** Removes api.json, but only if this process wrote it. */
export function removeApiFile(dir: string, pid: number = process.pid): void {
  const path = apiFilePath(dir);
  try {
    const current = JSON.parse(readFileSync(path, 'utf8')) as Partial<ApiFile>;
    if (current.pid === pid) rmSync(path);
  } catch {
    // missing or unreadable: nothing to remove
  }
}
