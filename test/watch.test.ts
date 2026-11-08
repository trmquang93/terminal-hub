import { describe, expect, it } from 'vitest';
import { formatWatchLine } from '../src/cli/watch';

describe('formatWatchLine', () => {
  it('prints attention, turn and exit events as one JSON line carrying the event name', () => {
    const turn = JSON.stringify({ id: 'abc', title: 'job', running: true, state: 'running', attention: null, turn: { state: 'working', since: 't1' } });
    const line = formatWatchLine('turn', turn);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line ?? '')).toEqual({ event: 'turn', id: 'abc', title: 'job', running: true, state: 'running', attention: null, turn: { state: 'working', since: 't1' } });
    expect(JSON.parse(formatWatchLine('attention', '{"id":"abc"}') ?? '')).toEqual({ event: 'attention', id: 'abc' });
    expect(JSON.parse(formatWatchLine('exit', '{"id":"abc","exitCode":0}') ?? '')).toEqual({ event: 'exit', id: 'abc', exitCode: 0 });
  });

  it('lets the event name win over a payload field called event', () => {
    expect(JSON.parse(formatWatchLine('turn', '{"event":"spoofed"}') ?? '')).toEqual({ event: 'turn' });
  });

  it('skips unnamed or unknown events, broken JSON and non-objects', () => {
    expect(formatWatchLine(undefined, '{}')).toBeNull();
    expect(formatWatchLine('message', '{}')).toBeNull();
    expect(formatWatchLine('turn', 'not json')).toBeNull();
    expect(formatWatchLine('turn', '[1]')).toBeNull();
    expect(formatWatchLine('turn', 'null')).toBeNull();
  });
});
