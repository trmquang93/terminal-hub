import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDir(): string {
  return process.env.TERMINAL_HUB_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'TerminalHub');
}

export function apiFilePath(dir: string = dataDir()): string {
  return join(dir, 'api.json');
}
