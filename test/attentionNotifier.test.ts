import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionNotifier, SETTLE_MS } from '../src/main/attentionNotifier';
import { SAFE_UNATTENDED_POLICY } from '../src/main/attention';
import type { NotifyEvent } from '../src/main/notifyDelivery';
import { SessionManager } from '../src/main/sessionManager';
import { SessionStore } from '../src/main/sessionStore';
import type { AttentionInfo, SessionInfo } from '../src/shared/types';

const prompt = (since: string, promptText = 'Continue? [y/N]'): AttentionInfo => ({ reason: 'prompt', promptText, since, source: 'heuristic' });

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    title: 'job',
    cwd: '/work',
    command: 'sh',
    argv: [],
    env: {},
    state: 'running',
    claude: null,
    resumeCount: 0,
    autoAnswer: null,
    archived: false,
    startedAt: '2026-11-08T07:00:00.000Z',
    endedAt: null,
    exitCode: null,
    signal: null,
    cols: 80,
    rows: 24,
    bytesWritten: 0,
    appVersion: 'test',
    running: true,
    attention: null,
    resumable: false,
    ...overrides,
  };
}

describe('AttentionNotifier', () => {
  let sent: NotifyEvent[];
  let notifier: AttentionNotifier;
  const summary = (): string[] => sent.map((e) => e.event);

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    notifier = new AttentionNotifier({ send: (event) => Promise.resolve(void sent.push(event)), secrets: () => ['api-token-123456'] });
  });
  afterEach(() => vi.useRealTimers());

  const settle = async (): Promise<void> => void (await vi.advanceTimersByTimeAsync(SETTLE_MS + 10));

  it('sends one attention when a prompt appears and one resolved when it is gone', async () => {
    notifier.update(session({ attention: prompt('t1') }));
    expect(sent).toEqual([]); // held back until it has settled
    await settle();
    expect(summary()).toEqual(['attention']);
    expect(sent[0]?.session).toMatchObject({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', title: 'job', cwd: '/work', command: 'sh', state: 'running', reason: 'prompt', promptText: 'Continue? [y/N]', source: 'heuristic', since: 't1' });
    notifier.update(session({ attention: null }));
    await settle();
    expect(summary()).toEqual(['attention', 'resolved']);
    expect(sent[1]?.session).toMatchObject({ since: 't1', promptText: 'Continue? [y/N]', reason: 'prompt' });
  });

  it('does not repeat attention for redraws: same episode, changing text, or repeated updates', async () => {
    notifier.update(session({ attention: prompt('t1', 'Continue? [y/N]') }));
    await settle();
    for (let i = 0; i < 20; i++) notifier.update(session({ attention: prompt('t1', `Continue? [y/N]\nspinner ${i}`), bytesWritten: i }));
    await settle();
    notifier.update(session({ title: 'renamed', attention: prompt('t1') }));
    await settle();
    expect(summary()).toEqual(['attention']);
  });

  it('does not flap: a prompt that vanishes before it settles is never sent', async () => {
    notifier.update(session({ attention: prompt('t1') }));
    await vi.advanceTimersByTimeAsync(SETTLE_MS / 2);
    notifier.update(session({ attention: null }));
    await settle();
    expect(sent).toEqual([]);
  });

  it('does not flap: a prompt that blinks off and on again is one attention and no resolved', async () => {
    notifier.update(session({ attention: prompt('t1') }));
    await settle();
    notifier.update(session({ attention: null }));
    await vi.advanceTimersByTimeAsync(SETTLE_MS / 3);
    notifier.update(session({ attention: prompt('t2') })); // same text, new episode
    await settle();
    expect(summary()).toEqual(['attention']);
  });

  it('sends resolved then attention for a different question that follows', async () => {
    notifier.update(session({ attention: prompt('t1', 'Delete? [y/N]') }));
    await settle();
    notifier.update(session({ attention: prompt('t2', 'Overwrite? [y/N]') }));
    await settle();
    expect(summary()).toEqual(['attention', 'resolved', 'attention']);
    expect(sent.map((e) => e.session.promptText)).toEqual(['Delete? [y/N]', 'Delete? [y/N]', 'Overwrite? [y/N]']);
  });

  it('sends resolved at once when the session exits, with its final state', async () => {
    notifier.update(session({ attention: prompt('t1') }));
    await settle();
    notifier.update(session({ running: false, state: 'exited', exitCode: 0, attention: null }));
    await vi.advanceTimersByTimeAsync(0);
    expect(summary()).toEqual(['attention', 'resolved']);
    expect(sent[1]?.session.state).toBe('exited');
  });

  it('sends nothing when a session exits before its prompt was reported', async () => {
    notifier.update(session({ attention: prompt('t1') }));
    notifier.update(session({ running: false, state: 'exited', attention: null }));
    await settle();
    expect(sent).toEqual([]);
  });

  it('ignores idle attention and sessions without attention', async () => {
    notifier.update(session({ attention: { reason: 'idle', promptText: 'quiet', since: 't1', source: 'idle' } }));
    notifier.update(session({ id: 'other', attention: null }));
    await settle();
    expect(sent).toEqual([]);
  });

  it('keeps sessions apart', async () => {
    notifier.update(session({ id: 'one', attention: prompt('t1') }));
    notifier.update(session({ id: 'two', attention: prompt('t1') }));
    await settle();
    notifier.update(session({ id: 'one', attention: null }));
    await settle();
    expect(sent.map((e) => `${e.event}:${e.session.id}`)).toEqual(['attention:one', 'attention:two', 'resolved:one']);
  });

  it('skips attention (and the resolved after it) when the auto-answer policy handles that prompt', async () => {
    const autoAnswer = SAFE_UNATTENDED_POLICY;
    notifier.update(session({ autoAnswer, attention: prompt('t1', 'Bash command\nDo you want to proceed?\n❯ 1. Yes') }));
    await settle();
    notifier.update(session({ autoAnswer, attention: null }));
    await settle();
    expect(sent).toEqual([]);
  });

  it('still reports a prompt the policy has no rule for, and honours a disabled policy', async () => {
    notifier.update(session({ autoAnswer: SAFE_UNATTENDED_POLICY, attention: prompt('t1', 'Delete everything? [y/N]') }));
    notifier.update(session({ id: 'two', autoAnswer: { ...SAFE_UNATTENDED_POLICY, enabled: false }, attention: prompt('t1', 'Do you want to proceed?') }));
    await settle();
    expect(sent.map((e) => e.session.id)).toEqual(['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'two']);
  });

  it('keeps the API token out of the payload', async () => {
    notifier.update(session({ attention: prompt('t1', 'run curl -H "Authorization: Bearer api-token-123456"') }));
    await settle();
    expect(JSON.stringify(sent)).not.toContain('api-token-123456');
  });

  it('sends one session\'s events in order even when the endpoint is slow', async () => {
    const order: string[] = [];
    const slow = new AttentionNotifier({
      send: async (event) => {
        order.push(`start ${event.event}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        order.push(`end ${event.event}`);
      },
    });
    slow.update(session({ attention: prompt('t1') }));
    await settle();
    slow.update(session({ attention: null }));
    await settle();
    await vi.advanceTimersByTimeAsync(7000);
    expect(order).toEqual(['start attention', 'end attention', 'start resolved', 'end resolved']);
  });

  it('never throws into the caller when the sender fails or blows up', async () => {
    const broken = new AttentionNotifier({ send: () => Promise.reject(new Error('down')), secrets: () => { throw new Error('boom'); } });
    expect(() => broken.update(session({ attention: prompt('t1') }))).not.toThrow();
    await settle();
  });

  it('drops events past the queue cap instead of growing without bound', async () => {
    const dropped: NotifyEvent[] = [];
    const stuck = new AttentionNotifier({ send: () => new Promise(() => undefined), onDrop: (event) => dropped.push(event) });
    for (let i = 0; i < 60; i++) stuck.update(session({ id: `s${i}`, attention: prompt('t1') }));
    await settle();
    expect(dropped).toHaveLength(10);
  });

  it('drain waits for in-flight sends but gives up after the timeout', async () => {
    const stuck = new AttentionNotifier({ send: () => new Promise(() => undefined) });
    stuck.update(session({ attention: prompt('t1') }));
    await settle();
    let done = false;
    void stuck.drain(2000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });
});

describe('AttentionNotifier on a real SessionManager', () => {
  let base: string;
  let managers: SessionManager[];

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'thub-notifier-')));
    mkdirSync(join(base, 'work'));
    managers = [];
  });
  afterEach(async () => {
    for (const m of managers) await m.shutdown();
    rmSync(base, { recursive: true, force: true });
  });

  function setup(): { m: SessionManager; events: NotifyEvent[]; waitFor: (n: number) => Promise<void> } {
    const m = new SessionManager(new SessionStore(join(base, 'sessions')), 'test', { baseEnv: () => ({ PATH: '/usr/bin:/bin' }), attention: { quietMs: 50, idleMs: 60_000 } });
    managers.push(m);
    const events: NotifyEvent[] = [];
    const notifier = new AttentionNotifier({ send: (event) => Promise.resolve(void events.push(event)), settleMs: 150 });
    m.onChanged((s) => notifier.update(s));
    const waitFor = async (n: number): Promise<void> => {
      for (let i = 0; i < 100 && events.length < n; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    return { m, events, waitFor };
  }

  it('reports a [y/N] prompt once, then resolved after the answer', async () => {
    const { m, events, waitFor } = setup();
    const { id } = m.start({ cwd: join(base, 'work'), command: 'sh', args: ['-c', 'read -p "Continue? [y/N] " a; echo got=$a'], title: 'asker' });
    await waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 600)); // redraw window: no second attention
    expect(events.map((e) => e.event)).toEqual(['attention']);
    expect(events[0]?.session).toMatchObject({ id, title: 'asker', command: 'sh', reason: 'prompt' });
    expect(events[0]?.session.promptText).toContain('Continue? [y/N]');
    m.answer(id, { text: 'y', submit: true });
    await waitFor(2);
    expect(events.map((e) => e.event)).toEqual(['attention', 'resolved']);
  });

  it('sends nothing for a prompt the auto-answer policy will answer itself, even when it waits a second first', async () => {
    const { m, events } = setup();
    const script = join(base, 'ask.sh');
    writeFileSync(script, '#!/bin/sh\necho "Do you want to proceed?"\nread a\necho answered\n');
    chmodSync(script, 0o755);
    const { id } = m.start({ cwd: join(base, 'work'), command: script, autoAnswer: { ...SAFE_UNATTENDED_POLICY, timeoutSec: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(m.get(id)?.state).toBe('exited');
    expect(events).toEqual([]);
  });
});
