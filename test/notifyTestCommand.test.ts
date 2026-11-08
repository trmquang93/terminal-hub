import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let dir: string;
let cli: string;
let server: Server;
let status = 200;
let received: { headers: IncomingHttpHeaders; body: string }[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'thub-notifycli-'));
  cli = join(dir, 'hub.cjs');
  await build({ entryPoints: [join(__dirname, '..', 'src', 'cli', 'hub.ts')], outfile: cli, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(async () => {
  received = [];
  status = 200;
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(parts).toString() });
      res.writeHead(status).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  rmSync(join(dir, 'notify.json'), { force: true });
  await new Promise<void>((resolve) => void server.close(() => resolve()));
});

const endpoint = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/xyz`;

function hub(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, 'notify-test'], { env: { PATH: process.env.PATH ?? '', ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('hub notify-test', () => {
  it('sends one synthetic attention event from notify.json and prints the HTTP status', async () => {
    writeFileSync(join(dir, 'notify.json'), JSON.stringify({ url: endpoint(), bearer: 'tok' }));
    const result = await hub({ TERMINAL_HUB_DATA_DIR: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/attention event delivered to 127\.0\.0\.1:\d+ \(config from file\): HTTP 200/);
    expect(result.stdout).not.toContain('/hooks/xyz');
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe('Bearer tok');
    const body = JSON.parse(received[0]?.body ?? '') as { event: string; session: Record<string, string> };
    expect(body.event).toBe('attention');
    expect(Object.keys(body.session).sort()).toEqual(['command', 'cwd', 'id', 'promptText', 'reason', 'since', 'source', 'state', 'title']);
    expect(body.session).toMatchObject({ id: 'notify-test', reason: 'prompt' });
  });

  it('works from the environment variables alone, without the app running', async () => {
    const result = await hub({ TERMINAL_HUB_DATA_DIR: dir, TERMINAL_HUB_NOTIFY_URL: endpoint() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('config from env');
    expect(received[0]?.headers.authorization).toBeUndefined();
  });

  it('exits 1 with the status when the endpoint rejects the event, without retrying', async () => {
    status = 401;
    const result = await hub({ TERMINAL_HUB_DATA_DIR: dir, TERMINAL_HUB_NOTIFY_URL: endpoint() });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/failed: HTTP 401/);
    expect(received).toHaveLength(1);
  });

  it('exits 1 and names the failure when nothing listens', async () => {
    const url = endpoint();
    await new Promise<void>((resolve) => void server.close(() => resolve()));
    server.listen(0, '127.0.0.1'); // keep afterEach's close() valid
    const result = await hub({ TERMINAL_HUB_DATA_DIR: dir, TERMINAL_HUB_NOTIFY_URL: url });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/delivery to 127\.0\.0\.1:\d+ failed: ECONNREFUSED/);
  });

  it('explains how to configure when there is no endpoint', async () => {
    const result = await hub({ TERMINAL_HUB_DATA_DIR: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no notification endpoint configured[\s\S]*notify\.json[\s\S]*TERMINAL_HUB_NOTIFY_URL/);
  });
});
