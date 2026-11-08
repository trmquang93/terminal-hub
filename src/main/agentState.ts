import type { TurnInfo, TurnState } from '../shared/types';

const WORKING = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop']);
const DONE = new Set(['Stop', 'StopFailure']);
const WAITING = new Set(['Notification', 'PermissionRequest']);
/** Claude's idle reminder, sent a minute after Stop: the turn is still done, nobody is being asked anything. */
const IDLE_REMINDER = /waiting for your input/i;

/** What a Claude Code hook event does to the turn state: a new state, `'clear'` (SessionEnd), or null for events that do not matter. */
export function turnForHook(hookEvent: string, message = ''): TurnState | 'clear' | null {
  if (hookEvent === 'SessionEnd') return 'clear';
  if (WORKING.has(hookEvent)) return 'working';
  if (DONE.has(hookEvent)) return 'done';
  if (WAITING.has(hookEvent)) return hookEvent === 'Notification' && IDLE_REMINDER.test(message) ? null : 'waiting';
  return null;
}

/**
 * One session's turn state, like iTerm2's cc-status: working while Claude runs a turn, waiting for a decision, done after Stop.
 * `onChange` fires only on a real transition; repeating the current state (every PreToolUse) changes nothing, `since` included.
 */
export class TurnTracker {
  private current: TurnInfo | null = null;

  constructor(
    private readonly onChange: (turn: TurnInfo | null) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get turn(): TurnInfo | null {
    return this.current;
  }

  hook(hookEvent: string, message?: string): void {
    const next = turnForHook(hookEvent, message);
    if (next === null) return;
    this.set(next === 'clear' ? null : next);
  }

  clear(): void {
    this.set(null);
  }

  private set(state: TurnState | null): void {
    if ((this.current?.state ?? null) === state) return;
    this.current = state === null ? null : { state, since: this.now().toISOString() };
    this.onChange(this.current);
  }
}
