import type { AttentionInfo, SessionInfo, TurnInfo } from '../shared/types';
import { matchingRule } from './attention';
import { buildEvent, buildTurnEvent, type NotifyEvent } from './notifyDelivery';

/** A prompt must still be there (or still be gone) this long after it changed before the endpoint hears about it. */
export const SETTLE_MS = 1000;
const MAX_QUEUED = 50;

export interface NotifierOptions {
  /** Delivers one event; must not throw. Events of one session are sent in order, never concurrently. */
  send: (event: NotifyEvent) => Promise<unknown>;
  settleMs?: number;
  /** Strings that must never appear in a payload (the API token). */
  secrets?: () => string[];
  onDrop?: (event: NotifyEvent) => void;
}

interface Tracked {
  /** What the session wants right now: a prompt, or null. */
  want: AttentionInfo | null;
  /** The prompt the endpoint was last told about, until a `resolved` goes out. */
  told: AttentionInfo | null;
  /** The turn state the endpoint was last told about; null after the session ends or its turn is cleared. */
  turnTold: TurnInfo | null;
  latest: SessionInfo;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<unknown>;
}

/** The same question seen again: identical episode, or identical text (a redraw that restarted the episode). */
function sameQuestion(a: AttentionInfo, b: AttentionInfo): boolean {
  return a.since === b.since || a.promptText === b.promptText;
}

/**
 * Turns the stream of session changes into webhook events, one `attention` per prompt and one `resolved` when it goes away
 * or the session exits, and one `turn` per real change of a Claude Code session's turn state (sent at once: hook events are
 * discrete, there is nothing to settle). All of a session's events share one ordered queue. A change is held for `settleMs` first, so a prompt that appears and vanishes (a redraw) or is answered
 * by the auto-answer policy never reaches the endpoint. Only `prompt` attention counts; the 20 s `idle` fallback does not.
 */
export class AttentionNotifier {
  private readonly tracked = new Map<string, Tracked>();
  private queued = 0;

  constructor(private readonly options: NotifierOptions) {}

  /** Feed every `changed` event of the session manager. */
  update(session: SessionInfo): void {
    const state = this.state(session);
    state.latest = session;
    this.noteTurn(state, session);
    const want = session.running && session.attention?.reason === 'prompt' ? session.attention : null;
    const episodeChanged = (want?.since ?? null) !== (state.want?.since ?? null);
    state.want = want;
    if (!session.running) {
      this.reconcile(state);
    } else if (episodeChanged) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => this.reconcile(state), this.options.settleMs ?? SETTLE_MS);
    }
  }

  /** Resolves when everything queued so far has been sent, or after `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    for (const state of this.tracked.values()) {
      if (state.timer) this.reconcile(state);
    }
    const pending = Promise.all([...this.tracked.values()].map((state) => state.chain));
    await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  forget(id: string): void {
    const state = this.tracked.get(id);
    if (state?.timer) clearTimeout(state.timer);
    this.tracked.delete(id);
  }

  private state(session: SessionInfo): Tracked {
    let state = this.tracked.get(session.id);
    if (!state) {
      state = { want: null, told: null, turnTold: null, latest: session, timer: null, chain: Promise.resolve() };
      this.tracked.set(session.id, state);
    }
    return state;
  }

  private noteTurn(state: Tracked, session: SessionInfo): void {
    const turn = session.running ? session.turn : null;
    if (turn === null) {
      state.turnTold = null;
      return;
    }
    if (state.turnTold?.state === turn.state && state.turnTold.since === turn.since) return;
    state.turnTold = turn;
    this.enqueue(state, buildTurnEvent(session, turn));
  }

  /** Runs from timers and event listeners: it must never throw into the PTY loop or crash the app. */
  private reconcile(state: Tracked): void {
    try {
      this.settle(state);
    } catch {
      // the endpoint is optional; a bug here must not take a session down
    }
  }

  private settle(state: Tracked): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const session = state.latest;
    // A rule that will answer this prompt by itself is not a question for anyone else.
    const want = state.want && matchingRule(session.autoAnswer, state.want.promptText) === undefined ? state.want : null;
    const secrets = this.options.secrets?.() ?? [];
    if (state.told && (!want || !sameQuestion(state.told, want))) {
      this.enqueue(state, buildEvent('resolved', session, state.told, secrets));
      state.told = null;
    }
    if (want && !state.told) {
      this.enqueue(state, buildEvent('attention', session, want, secrets));
      state.told = want;
    }
  }

  private enqueue(state: Tracked, event: NotifyEvent): void {
    if (this.queued >= MAX_QUEUED) {
      this.options.onDrop?.(event);
      return;
    }
    this.queued++;
    state.chain = state.chain
      .then(() => this.options.send(event))
      .catch(() => undefined)
      .finally(() => this.queued--);
  }
}
