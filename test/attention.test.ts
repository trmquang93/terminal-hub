import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionTracker, detectPrompt, NotificationThrottle, resolveAnswer, SAFE_UNATTENDED_POLICY } from '../src/main/attention';
import type { AttentionInfo, AutoAnswerPolicy, AutoAnswerRule } from '../src/shared/types';

describe('detectPrompt', () => {
  it.each([
    ['Do you want to proceed?'],
    [' ❯ 1. Yes\n   2. Yes, and don’t ask again\n   3. No'],
    [' ❯ 1) Yes'],
    ['Continue? [y/N] '],
    ['Overwrite? (yes/no)'],
    ['Press Enter to continue'],
    ['Esc to cancel · Tab to amend'],
    ['Enter to confirm · Esc to cancel'],
    ['Entertoconfirm·Esctocancel'],
    ['Doyouwanttoproceed?'],
    ['Claude Code will automatically deny this request in 0:23, to avoid blocking progress on an unattended session'],
  ])('matches %j', (screen) => {
    expect(detectPrompt(`some earlier output\n${screen}\n`)).toContain((screen.split('\n')[0] ?? '').trimEnd());
  });

  it.each([
    ['Compiling 42 files...\nDone in 3.2s\n'],
    ['total 8\ndrwxr-xr-x  2 me  staff   64 Nov  8 12:00 proceed\n-rw-r--r--  1 me  staff   10 Nov  8 12:00 yes-no.txt\n'],
    ['Do you want some coffee\nproceeding with install\n'],
    ['Tests: 5 passed\n1. first item\n2. second item\n'],
    [''],
  ])('does not match normal output %j', (screen) => {
    expect(detectPrompt(screen)).toBeNull();
  });

  it('keeps seeing a dialog while the TUI blinks a bullet or spinner under it, and leaves decoration out of the text', () => {
    const dialog = ' Bash command\n────────\n touch /tmp/x\n╌╌╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend\n';
    const text = detectPrompt(`${dialog}${'⏺\n'.repeat(40)}`);
    expect(text).toContain('Do you want to proceed?');
    expect(text).not.toMatch(/[─╌⏺]/);
    expect(text?.split('\n')).toEqual([' Bash command', ' touch /tmp/x', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend']);
  });

  it('only looks at the most recent lines and returns about ten of them', () => {
    const old = 'Do you want to proceed?\n';
    const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(detectPrompt(`${old}${filler}\n`)).toBeNull();
    const text = detectPrompt(`${filler}\nDo you want to proceed?\n`);
    expect(text?.split('\n')).toHaveLength(10);
    expect(text?.endsWith('Do you want to proceed?')).toBe(true);
  });
});

describe('resolveAnswer', () => {
  const joined = (request: Parameters<typeof resolveAnswer>[0]): string => resolveAnswer(request).join('');

  it('maps friendly names', () => {
    expect(joined({ text: 'yes' })).toBe('y\r');
    expect(joined({ text: 'no' })).toBe('n\r');
    expect(joined({ text: 'enter' })).toBe('\r');
    expect(joined({ text: 'esc' })).toBe('\x1b');
    expect(joined({ text: 'tab' })).toBe('\t');
    expect(joined({ text: 'up' })).toBe('\x1b[A');
    expect(joined({ text: 'down' })).toBe('\x1b[B');
    expect(joined({ text: '3' })).toBe('3');
  });

  it('submit appends Enter once', () => {
    expect(joined({ text: '1', submit: true })).toBe('1\r');
    expect(joined({ text: 'yes', submit: true })).toBe('y\r');
    expect(joined({ text: 'esc', submit: true })).toBe('\x1b\r');
  });

  it('types other text literally, with Enter as its own write so a TUI sees typing, not a paste', () => {
    expect(resolveAnswer({ text: 'hello there', submit: true })).toEqual(['hello there', '\r']);
    expect(resolveAnswer({ text: 'y' })).toEqual(['y']);
  });

  it('passes raw keys through untouched', () => {
    expect(resolveAnswer({ keys: '1\r' })).toEqual(['1\r']);
  });

  it('rejects ambiguous or empty requests', () => {
    expect(() => resolveAnswer({})).toThrow(/exactly one/);
    expect(() => resolveAnswer({ keys: 'a', text: 'b' })).toThrow(/exactly one/);
    expect(() => resolveAnswer({ keys: '' })).toThrow(/non-empty/);
  });
});

describe('NotificationThrottle', () => {
  it('allows one notification per session per 30 s', () => {
    const throttle = new NotificationThrottle();
    expect(throttle.shouldNotify('a', 0)).toBe(true);
    expect(throttle.shouldNotify('a', 29_999)).toBe(false);
    expect(throttle.shouldNotify('b', 100)).toBe(true);
    expect(throttle.shouldNotify('a', 30_000)).toBe(true);
  });
});

describe('AttentionTracker', () => {
  const changes: (AttentionInfo | null)[] = [];
  const answered: { rule: AutoAnswerRule; text: string }[] = [];
  let policy: AutoAnswerPolicy | null = null;
  let tracker: AttentionTracker;
  const feed = (text: string): void => tracker.output(Buffer.from(text));

  beforeEach(() => {
    vi.useFakeTimers();
    changes.length = 0;
    answered.length = 0;
    policy = null;
    tracker = new AttentionTracker({
      idleMs: 20_000,
      quietMs: 400,
      policy: () => policy,
      onChange: (a) => changes.push(a),
      autoAnswer: (rule, text) => answered.push({ rule, text }),
    });
  });
  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
  });

  it('flags a prompt once output goes quiet, with the question text', () => {
    feed('\x1b[1mContinue? [y/N] \x1b[0m');
    expect(tracker.attention).toBeNull();
    vi.advanceTimersByTime(400);
    expect(tracker.attention).toMatchObject({ reason: 'prompt', source: 'heuristic', promptText: 'Continue? [y/N]' });
  });

  it('does not flag a prompt-like string that is followed by more output', () => {
    feed('Do you want to proceed?\n');
    vi.advanceTimersByTime(300);
    feed(Array.from({ length: 20 }, (_, i) => `(just a log line ${i})\n`).join(''));
    vi.advanceTimersByTime(400);
    expect(tracker.attention).toBeNull();
  });

  it('clears a heuristic prompt when output moves on, and when input is sent', () => {
    feed('Do you want to proceed?\n');
    vi.advanceTimersByTime(400);
    expect(tracker.attention?.reason).toBe('prompt');
    feed(Array.from({ length: 15 }, (_, i) => `later output ${i}\n`).join(''));
    vi.advanceTimersByTime(400);
    expect(tracker.attention?.reason).toBe('prompt');
    vi.advanceTimersByTime(1500);
    expect(tracker.attention).toBeNull();

    feed('Continue? [y/N] ');
    vi.advanceTimersByTime(400);
    expect(tracker.attention).not.toBeNull();
    tracker.input();
    expect(tracker.attention).toBeNull();
    vi.advanceTimersByTime(400);
    expect(tracker.attention).toBeNull();
  });

  it('does not flap when a redraw momentarily hides the prompt: same start time, no clear/re-raise', () => {
    feed('Do you want to proceed?\n');
    vi.advanceTimersByTime(400);
    const since = tracker.attention?.since;
    const seen = changes.length;
    feed('Fermenting… (partial frame)\n'.repeat(1));
    vi.advanceTimersByTime(400);
    feed('Do you want to proceed?\n');
    vi.advanceTimersByTime(2000);
    expect(tracker.attention?.since).toBe(since);
    expect(changes.slice(seen).includes(null)).toBe(false);
  });

  it('keeps the prompt (and its start time) while the screen redraws the same question', () => {
    feed('Do you want to proceed?\nwill automatically deny this request in 0:23\n');
    vi.advanceTimersByTime(400);
    const since = tracker.attention?.since;
    vi.advanceTimersByTime(1000);
    feed('\rwill automatically deny this request in 0:22\n');
    vi.advanceTimersByTime(400);
    expect(tracker.attention?.since).toBe(since);
  });

  it('flags idle after 20 s of silence, as idle and never as a prompt, and clears on output', () => {
    feed('building...\n');
    vi.advanceTimersByTime(19_000);
    expect(tracker.attention).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(tracker.attention).toMatchObject({ reason: 'idle', source: 'idle' });
    feed('more\n');
    expect(tracker.attention).toBeNull();
  });

  it('a busy session that keeps printing is never flagged', () => {
    for (let i = 0; i < 100; i++) {
      feed(`step ${i}\n`);
      vi.advanceTimersByTime(1_000);
    }
    expect(tracker.attention).toBeNull();
  });

  it('a hook notification flags attention at once and stays until input', () => {
    tracker.hook('Claude needs your permission to use Bash');
    expect(tracker.attention).toMatchObject({ reason: 'prompt', source: 'hook', promptText: 'Claude needs your permission to use Bash' });
    feed('unrelated redraw\n');
    vi.advanceTimersByTime(400);
    expect(tracker.attention?.source).toBe('hook');
    tracker.input();
    expect(tracker.attention).toBeNull();
  });

  it('a "waiting for your input" hook is informational (idle), not a prompt', () => {
    tracker.hook('Claude is waiting for your input');
    expect(tracker.attention?.reason).toBe('idle');
  });

  it('auto-answers only a rule that matches, after timeoutSec, once', () => {
    policy = { enabled: true, rules: [{ match: 'Do you want to proceed?', keys: '\r' }], timeoutSec: 2 };
    feed('Delete everything? [y/N] ');
    vi.advanceTimersByTime(5_000);
    expect(answered).toEqual([]);

    feed('\nBash command\n ❯ 1. Yes\n   2. No\nDo you want to proceed?\n');
    vi.advanceTimersByTime(400 + 1_999);
    expect(answered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.rule.keys).toBe('\r');
    vi.advanceTimersByTime(10_000);
    expect(answered).toHaveLength(1);
  });

  it('matches rules despite TUI column padding ("Do  you want to proceed?")', () => {
    policy = { enabled: true, rules: [{ match: 'Do you want to proceed?', keys: '\r' }], timeoutSec: 0 };
    feed('Bash command\n touch  /tmp/x\n Do  you want to proceed?\n ❯  1. Yes\n');
    vi.advanceTimersByTime(400);
    expect(tracker.attention?.promptText).toContain('Do you want to proceed?');
    vi.advanceTimersByTime(1);
    expect(answered).toHaveLength(1);
  });

  it('does not auto-answer when the policy is off, and the safe unattended policy only approves "Do you want to proceed?"', () => {
    feed('Do you want to proceed?\n');
    vi.advanceTimersByTime(400);
    expect(answered).toEqual([]);
    expect(SAFE_UNATTENDED_POLICY).toEqual({ enabled: true, rules: [{ match: 'Do you want to proceed?', keys: '\r' }], timeoutSec: 0 });
  });

  it('does not auto-answer if the person answered first', () => {
    policy = { enabled: true, rules: [{ match: 'Do you want to proceed?', keys: '\r' }], timeoutSec: 3 };
    feed('Do you want to proceed?\n');
    vi.advanceTimersByTime(400 + 1_000);
    tracker.input();
    vi.advanceTimersByTime(10_000);
    expect(answered).toEqual([]);
  });
});
