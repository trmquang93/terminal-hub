import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadNotifyConfig } from '../src/main/notifyConfig';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thub-notifycfg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeFile = (content: string): void => writeFileSync(join(dir, 'notify.json'), content);

describe('loadNotifyConfig', () => {
  it('reads url and bearer from notify.json', () => {
    writeFile('{"url": "http://127.0.0.1:9/hooks/x", "bearer": " s3cret "}');
    expect(loadNotifyConfig(dir, {})).toEqual({ config: { url: 'http://127.0.0.1:9/hooks/x', bearer: 's3cret', source: 'file' } });
  });

  it('treats a missing or empty bearer as none', () => {
    writeFile('{"url": "https://example.test/h"}');
    expect(loadNotifyConfig(dir, {}).config?.bearer).toBe('');
    writeFile('{"url": "https://example.test/h", "bearer": ""}');
    expect(loadNotifyConfig(dir, {}).config?.bearer).toBe('');
  });

  it('re-reads the file on every call', () => {
    writeFile('{"url": "http://127.0.0.1:1/a"}');
    expect(loadNotifyConfig(dir, {}).config?.url).toBe('http://127.0.0.1:1/a');
    writeFile('{"url": "http://127.0.0.1:2/b"}');
    expect(loadNotifyConfig(dir, {}).config?.url).toBe('http://127.0.0.1:2/b');
  });

  it('falls back to the environment when there is no file', () => {
    expect(loadNotifyConfig(dir, { TERMINAL_HUB_NOTIFY_URL: 'http://127.0.0.1:3/e', TERMINAL_HUB_NOTIFY_BEARER: 'tok' })).toEqual({
      config: { url: 'http://127.0.0.1:3/e', bearer: 'tok', source: 'env' },
    });
  });

  it('uses one source whole: the file wins, and the env bearer never rides along to the file url', () => {
    writeFile('{"url": "http://127.0.0.1:4/f"}');
    const { config } = loadNotifyConfig(dir, { TERMINAL_HUB_NOTIFY_URL: 'http://127.0.0.1:3/e', TERMINAL_HUB_NOTIFY_BEARER: 'tok' });
    expect(config).toEqual({ url: 'http://127.0.0.1:4/f', bearer: '', source: 'file' });
  });

  it('returns no config, and no warning, when nothing is set', () => {
    expect(loadNotifyConfig(dir, {})).toEqual({ config: null, warning: undefined });
    writeFile('   ');
    expect(loadNotifyConfig(dir, {}).config).toBeNull();
    writeFile('{"url": ""}');
    expect(loadNotifyConfig(dir, {})).toEqual({ config: null, warning: undefined });
  });

  it.each([['not json {'], ['[]'], ['null'], ['"http://x"'], ['{"url": 5}'], ['{"url": "ftp://x/y"}'], ['{"url": "no scheme"}']])('ignores garbage %j with a warning', (content) => {
    writeFile(content);
    const result = loadNotifyConfig(dir, {});
    expect(result.config).toBeNull();
    if (content !== '[]' && content !== 'null' && content !== '"http://x"') expect(result.warning).toBeTruthy();
  });

  it('uses the environment when the file is garbage, and says the file was ignored', () => {
    writeFile('oops');
    const result = loadNotifyConfig(dir, { TERMINAL_HUB_NOTIFY_URL: 'http://127.0.0.1:3/e' });
    expect(result.config?.source).toBe('env');
    expect(result.warning).toMatch(/not valid JSON/);
  });

  it('rejects a non-http env url', () => {
    expect(loadNotifyConfig(dir, { TERMINAL_HUB_NOTIFY_URL: 'file:///etc/passwd' }).config).toBeNull();
  });

  it('does not fail when the data dir does not exist', () => {
    mkdirSync(join(dir, 'x'));
    expect(loadNotifyConfig(join(dir, 'missing'), {}).config).toBeNull();
  });
});
