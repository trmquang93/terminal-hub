import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEvent, createSender, deliver, NotifyLog, type NotifyEvent } from '../src/main/notifyDelivery';
import type { AttentionInfo } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thub-notifydel-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const attention: AttentionInfo = { reason: 'prompt', promptText: 'Continue? [y/N]', since: '2026-11-08T07:00:00.000Z', source: 'heuristic' };
const session = { id: '11111111-2222-4333-8444-555555555555', title: 'job', cwd: '/work', command: 'sh', state: 'running' as const };
const event = (): NotifyEvent => buildEvent('attention', session, attention);
const config = { url: 'http://127.0.0.1:9/hooks/secret-path', bearer: '', source: 'file' as const };
const noSleep = (_ms: number): Promise<void> => Promise.resolve();
const respond = (status: number): Response => new Response(status === 204 ? null : '{}', { status });
const logText = (): string => readFileSync(join(dir, 'notifications.log'), 'utf8');

describe('buildEvent', () => {
  it('has exactly the documented fields', () => {
    expect(event()).toEqual({
      event: 'attention',
      session: { id: session.id, title: 'job', cwd: '/work', command: 'sh', state: 'running', reason: 'prompt', promptText: 'Continue? [y/N]', source: 'heuristic', since: attention.since },
    });
  });

  it('copies only allow-listed fields even from a full SessionInfo', () => {
    const full = { ...session, argv: ['--token', 'abc'], env: { SECRET: 'x' }, autoAnswer: null, bytesWritten: 99, attention };
    const { session: out } = buildEvent('resolved', full, attention);
    expect(Object.keys(out).sort()).toEqual(['command', 'cwd', 'id', 'promptText', 'reason', 'since', 'source', 'state', 'title']);
    expect(JSON.stringify(out)).not.toMatch(/abc|SECRET|argv/);
  });

  it('scrubs the API token and the bearer from the question text', () => {
    const leaky: AttentionInfo = { ...attention, promptText: 'curl -H "Authorization: Bearer api-token-123456" and hook-bearer-987654' };
    const text = JSON.stringify(buildEvent('attention', session, leaky, ['api-token-123456', 'hook-bearer-987654', '']));
    expect(text).not.toContain('api-token-123456');
    expect(text).not.toContain('hook-bearer-987654');
    expect(text).toContain('[redacted]');
  });

  it('caps the question text', () => {
    expect(buildEvent('attention', session, { ...attention, promptText: 'x'.repeat(10_000) }).session.promptText).toHaveLength(4000);
  });
});

describe('deliver', () => {
  it('POSTs JSON, with Authorization only when a bearer is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(respond(200)));
    await deliver(config, event(), { fetchImpl });
    await deliver({ ...config, bearer: 'tok' }, event(), { fetchImpl });
    const [first, second] = fetchImpl.mock.calls.map(([, init]) => init as RequestInit);
    expect(first?.method).toBe('POST');
    expect(first?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(second?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer tok' });
    expect(JSON.parse(first?.body as string)).toEqual(event());
  });

  it('succeeds on the first 2xx without retrying', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(respond(204)));
    expect(await deliver(config, event(), { fetchImpl, sleep: noSleep })).toEqual({ ok: true, attempts: 1, status: 204 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([[500], [503], [429]])('retries HTTP %i up to 3 attempts, with backoff', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(respond(status)));
    const sleep = vi.fn(noSleep);
    const result = await deliver(config, event(), { fetchImpl, sleep });
    expect(result).toMatchObject({ ok: false, attempts: 3, status });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1500]);
  });

  it('retries network errors and stops once one attempt succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(respond(502))
      .mockResolvedValueOnce(respond(200));
    expect(await deliver(config, event(), { fetchImpl, sleep: noSleep })).toEqual({ ok: true, attempts: 3, status: 200 });
  });

  it.each([[400], [401], [403], [404], [410], [422]])('does not retry HTTP %i', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(respond(status)));
    const sleep = vi.fn(noSleep);
    expect(await deliver(config, event(), { fetchImpl, sleep })).toMatchObject({ ok: false, attempts: 1, status });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not follow or retry a redirect', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 302, headers: { Location: 'http://elsewhere.test/' } })));
    expect(await deliver(config, event(), { fetchImpl, sleep: noSleep })).toMatchObject({ ok: false, attempts: 1, status: 302 });
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).redirect).toBe('manual');
  });

  it('times out a hung endpoint and reports it as a timeout', async () => {
    const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error)));
    const result = await deliver(config, event(), { fetchImpl, sleep: noSleep, timeoutMs: 20, maxAttempts: 2, log: new NotifyLog(dir) });
    expect(result).toMatchObject({ ok: false, attempts: 2, status: null, error: 'timeout' });
  });

  it('logs every attempt and the outcome, without the url path or the bearer', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(200));
    await deliver({ ...config, bearer: 'topsecretbearer' }, event(), { fetchImpl, sleep: noSleep, log: new NotifyLog(dir) });
    const lines = logText().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/WARN attention session=11111111 host=127\.0\.0\.1:9 attempt 1\/3 HTTP 503 \(\d+ ms\), retrying in 500 ms/);
    expect(lines[1]).toMatch(/INFO .* attempt 2\/3 HTTP 200/);
    expect(logText()).not.toMatch(/secret-path|topsecretbearer/);
  });

  it('logs an unreachable endpoint as warnings and resolves normally', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })));
    const result = await deliver(config, event(), { fetchImpl, sleep: noSleep, log: new NotifyLog(dir) });
    expect(result).toMatchObject({ ok: false, attempts: 3, status: null, error: 'ECONNREFUSED' });
    const lines = logText().trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.includes(' WARN '))).toBe(true);
    expect(lines.at(-1)).toMatch(/not delivered after 3 attempt\(s\): ECONNREFUSED/);
  });
});

describe('deliver against a real server', () => {
  let server: Server;
  const seen: { headers: IncomingHttpHeaders; body: string; url: string }[] = [];
  let status = 200;
  let url = '';
  beforeEach(async () => {
    seen.length = 0;
    status = 200;
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (chunk: Buffer) => parts.push(chunk));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(parts).toString(), url: req.url ?? '' });
        res.writeHead(status).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/abc`;
  });
  afterEach(() => new Promise<void>((resolve) => void server.close(() => resolve())));

  it('delivers the body and headers over HTTP', async () => {
    const result = await deliver({ url, bearer: 'tok', source: 'file' }, event(), { log: new NotifyLog(dir) });
    expect(result).toEqual({ ok: true, attempts: 1, status: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/hooks/abc');
    expect(seen[0]?.headers.authorization).toBe('Bearer tok');
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(event());
  });

  it('retries a 500 from a real server', async () => {
    status = 500;
    const result = await deliver({ url, bearer: '', source: 'file' }, event(), { sleep: noSleep });
    expect(result).toMatchObject({ ok: false, attempts: 3, status: 500 });
    expect(seen).toHaveLength(3);
  });
});

describe('createSender', () => {
  it('re-reads notify.json for every send and does nothing when unconfigured', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(respond(200)));
    const send = createSender(dir, new NotifyLog(dir), { fetchImpl, env: {} });
    expect(await send(event())).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    writeFileSync(join(dir, 'notify.json'), '{"url": "http://127.0.0.1:1/a"}');
    await send(event());
    writeFileSync(join(dir, 'notify.json'), '{"url": "http://127.0.0.1:2/b"}');
    await send(event());
    expect(fetchImpl.mock.calls.map(([target]) => target)).toEqual(['http://127.0.0.1:1/a', 'http://127.0.0.1:2/b']);
  });

  it('logs a warning for a garbage file and never throws', async () => {
    writeFileSync(join(dir, 'notify.json'), 'garbage');
    const send = createSender(dir, new NotifyLog(dir), { fetchImpl: () => Promise.reject(new Error('boom')), sleep: noSleep, env: { TERMINAL_HUB_NOTIFY_URL: 'http://127.0.0.1:1/x' } });
    await expect(send(event())).resolves.toMatchObject({ ok: false });
    expect(logText()).toMatch(/WARN notify\.json is not valid JSON; ignored/);
  });
});

describe('NotifyLog', () => {
  it('rotates once past the cap and keeps one old file', () => {
    const log = new NotifyLog(dir, 200);
    for (let i = 0; i < 20; i++) log.write('INFO', `line ${i} ${'x'.repeat(30)}`);
    expect(readdirSync(dir).sort()).toEqual(['notifications.log', 'notifications.log.1']);
    expect(logText()).toContain('line 19');
    expect(logText().length).toBeLessThan(400);
  });

  it('never throws when the directory is missing', () => {
    expect(() => new NotifyLog(join(dir, 'nope', 'deeper')).write('WARN', 'x')).not.toThrow();
  });
});
