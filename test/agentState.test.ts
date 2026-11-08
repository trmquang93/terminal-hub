import { describe, expect, it } from 'vitest';
import { TurnTracker, turnForHook } from '../src/main/agentState';
import type { TurnInfo } from '../src/shared/types';

function tracker(): { tracker: TurnTracker; changes: (TurnInfo | null)[]; tick: () => void } {
  const changes: (TurnInfo | null)[] = [];
  let seconds = 0;
  return { tracker: new TurnTracker((turn) => changes.push(turn), () => new Date(Date.UTC(2026, 10, 9, 4, 0, seconds))), changes, tick: () => void seconds++ };
}

describe('turnForHook', () => {
  it.each([
    ['UserPromptSubmit', 'working'],
    ['PreToolUse', 'working'],
    ['PostToolUse', 'working'],
    ['SubagentStart', 'working'],
    ['SubagentStop', 'working'],
    ['Stop', 'done'],
    ['StopFailure', 'done'],
    ['Notification', 'waiting'],
    ['PermissionRequest', 'waiting'],
    ['SessionEnd', 'clear'],
    ['SessionStart', null],
    ['SomethingNew', null],
  ])('%s → %s', (event, expected) => expect(turnForHook(event)).toBe(expected));

  it('treats the idle "waiting for your input" Notification as no change: the turn is still done', () => {
    expect(turnForHook('Notification', 'Claude is waiting for your input')).toBeNull();
    expect(turnForHook('Notification', 'Claude needs your permission to use Bash')).toBe('waiting');
  });
});

describe('TurnTracker', () => {
  it('follows a turn: working, waiting for a permission, working again, done', () => {
    const { tracker: t, changes, tick } = tracker();
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']) {
      t.hook(event);
      tick();
    }
    expect(changes.map((c) => c?.state)).toEqual(['working', 'waiting', 'working', 'done']);
    expect(t.turn?.state).toBe('done');
  });

  it('the same state twice emits nothing and keeps `since`', () => {
    const { tracker: t, changes, tick } = tracker();
    t.hook('UserPromptSubmit');
    const first = t.turn?.since;
    tick();
    for (const event of ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreToolUse']) t.hook(event);
    expect(changes).toHaveLength(1);
    expect(t.turn?.since).toBe(first);
    t.hook('Stop');
    t.hook('StopFailure');
    expect(changes.map((c) => c?.state)).toEqual(['working', 'done']);
  });

  it('a new episode of the same state after another one gets a new `since`', () => {
    const { tracker: t, tick } = tracker();
    t.hook('PreToolUse');
    const first = t.turn?.since;
    tick();
    t.hook('Stop');
    tick();
    t.hook('UserPromptSubmit');
    expect(t.turn?.since).not.toBe(first);
  });

  it('SessionEnd clears the state once; clearing an empty tracker is silent', () => {
    const { tracker: t, changes } = tracker();
    t.hook('SessionEnd');
    expect(changes).toEqual([]);
    t.hook('Stop');
    t.hook('SessionEnd');
    t.hook('SessionEnd');
    expect(changes.map((c) => c?.state ?? null)).toEqual(['done', null]);
    expect(t.turn).toBeNull();
  });

  it('ignores SessionStart, unknown events and the idle reminder', () => {
    const { tracker: t, changes } = tracker();
    t.hook('SessionStart');
    t.hook('Whatever');
    expect(changes).toEqual([]);
    t.hook('Stop');
    t.hook('Notification', 'Claude is waiting for your input');
    expect(t.turn?.state).toBe('done');
  });
});
