import { describe, expect, it } from 'vitest';
import { HubError } from '../src/main/errors';
import { DEFAULT_EVENTS, redactListener, validateListener, type StoredListener } from '../src/main/listenerConfig';

describe('listener validation', () => {
  it('accepts the three kinds and defaults the filter to all four events', () => {
    expect(validateListener({ kind: 'http', http: { url: 'https://agent.example/hook' } })).toEqual({
      kind: 'http',
      events: DEFAULT_EVENTS,
      http: { url: 'https://agent.example/hook' },
    });
    expect(validateListener({ kind: 'command', command: { argv: ['/usr/bin/node', 'hook.mjs'] } })).toMatchObject({
      kind: 'command',
      command: { argv: ['/usr/bin/node', 'hook.mjs'] },
    });
    expect(validateListener({ kind: 'openmausbot', openmausbot: { botId: 'b1', threadId: 't1' } })).toMatchObject({
      kind: 'openmausbot',
      openmausbot: { botId: 'b1', threadId: 't1' },
    });
  });

  it('treats an empty events array as all events and rejects unknown names', () => {
    expect(validateListener({ kind: 'http', http: { url: 'http://a.example' }, events: [] }).events).toEqual(DEFAULT_EVENTS);
    expect(() => validateListener({ kind: 'http', http: { url: 'http://a.example' }, events: ['attention', 'nope'] })).toThrow(HubError);
  });

  it('rejects unknown keys so a typo cannot silently drop a filter', () => {
    expect(() => validateListener({ kind: 'http', http: { url: 'http://a.example' }, event: ['attention'] })).toThrow(/unknown listener key/);
    expect(() => validateListener({ kind: 'http', http: { url: 'http://a.example', bearer: 1 } })).toThrow(/bearer/);
  });

  it('requires exactly the endpoint block for the kind', () => {
    expect(() => validateListener({ kind: 'http', command: { argv: ['/bin/echo'] } })).toThrow(/must not carry a command block|needs its http block/);
    expect(() => validateListener({ kind: 'command', command: { argv: ['/bin/echo'] }, http: { url: 'http://a.example' } })).toThrow(/must not carry/);
    expect(() => validateListener({ kind: 'http', http: { url: 'file:///etc/passwd' } })).toThrow(/http\(s\)/);
  });

  it('bounds ackTimeoutSec to 1..300 and caps command timeoutMs at 60000', () => {
    expect(() => validateListener({ kind: 'http', http: { url: 'http://a.example' }, ackTimeoutSec: 0 })).toThrow(/ackTimeoutSec/);
    expect(() => validateListener({ kind: 'http', http: { url: 'http://a.example' }, ackTimeoutSec: 301 })).toThrow(/ackTimeoutSec/);
    expect(validateListener({ kind: 'command', command: { argv: ['/bin/echo'], timeoutMs: 999999 } })).toMatchObject({ command: { timeoutMs: 60000 } });
  });

  it('rejects a null, empty or non-object listener', () => {
    for (const value of [null, 'x', [], {}]) expect(() => validateListener(value)).toThrow(HubError);
  });
});

describe('listener redaction', () => {
  const base = { id: 'lst_1', state: 'active' as const, createdAt: '2026-01-01T00:00:00.000Z', acknowledgedAt: '2026-01-01T00:00:01.000Z', events: ['attention' as const] };

  it('returns the host, never the path or bearer of an http listener', () => {
    const stored: StoredListener = { ...base, kind: 'http', http: { url: 'https://agent.example/secret-path', bearer: 'tok', headers: { 'X-Run': '42' } } };
    const info = redactListener(stored);
    expect(info).toMatchObject({ id: 'lst_1', kind: 'http', host: 'agent.example', state: 'active' });
    expect(JSON.stringify(info)).not.toContain('secret-path');
    expect(JSON.stringify(info)).not.toContain('tok');
  });

  it('returns argv[0] basename and argv length for a command listener', () => {
    const stored: StoredListener = { ...base, kind: 'command', command: { argv: ['/opt/agent/hook.mjs', '--flag'] } };
    expect(redactListener(stored)).toMatchObject({ command: 'hook.mjs', argvLength: 2 });
  });

  it('returns the openmausbot ids and nothing else', () => {
    const stored: StoredListener = { ...base, kind: 'openmausbot', openmausbot: { botId: 'b1', threadId: 't1' } };
    expect(redactListener(stored)).toMatchObject({ kind: 'openmausbot', botId: 'b1', threadId: 't1' });
  });
});
