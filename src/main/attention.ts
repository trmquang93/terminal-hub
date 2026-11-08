import type { AnswerRequest, AttentionInfo, AutoAnswerPolicy, AutoAnswerRule } from '../shared/types';
import { AnsiStripper } from './ansi';
import { HubError } from './errors';

export const IDLE_MS = 20_000;
export const QUIET_MS = 400;
/** A heuristic prompt must be gone this long before it is cleared, so mid-redraw screens do not flap. */
export const CLEAR_AFTER_MS = 1500;
export const NOTIFY_THROTTLE_MS = 30_000;
const TAIL_CHARS = 8192;
const SCAN_LINES = 12;
const PROMPT_LINES = 10;
const AUTO_ANSWER_DELAY_UNIT_MS = 1000;
/** Same string Claude Code shows when a permission dialog is waiting. */
export const SAFE_UNATTENDED_POLICY: AutoAnswerPolicy = { enabled: true, rules: [{ match: 'Do you want to proceed?', keys: '\r' }], timeoutSec: 0 };

/** A phrase as a regex that tolerates missing or extra whitespace between words (TUIs redraw spacing). */
function phrase(text: string, flags = ''): RegExp {
  return new RegExp(`\\b${text.split(' ').map((word) => word.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')}`, flags);
}

const PROMPT_SIGNATURES: readonly RegExp[] = [
  phrase('Do you want to proceed?'),
  /❯\s*1[.)]/,
  /\[[yY]\/[nN]\]/,
  /\((?:yes|y)\/(?:no|n)\)/i,
  phrase('Press Enter', 'i'),
  phrase('Esc to cancel'),
  phrase('will automatically deny this request in'),
];

/** Last `count` meaningful lines: blank lines, pure decoration (rules, spinner glyphs) and immediate repeats are skipped; column padding is collapsed. */
function lastLines(text: string, count: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd().replaceAll(/(\S) {2,}/g, '$1 ');
    if (/[\p{L}\p{N}]/u.test(line) && line !== lines.at(-1)) lines.push(line);
  }
  return lines.slice(-count);
}

/** The last ~10 plain-text lines when the recent output looks like a question to the person, else null. */
export function detectPrompt(plainText: string): string | null {
  const recent = lastLines(plainText, SCAN_LINES);
  const joined = recent.join('\n');
  return PROMPT_SIGNATURES.some((signature) => signature.test(joined)) ? recent.slice(-PROMPT_LINES).join('\n') : null;
}

/** Rule matching ignores whitespace differences: TUIs pad columns, so "Do  you" must match "Do you". */
function squash(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/** The enabled policy's first rule whose `match` appears in the prompt, i.e. the one that will answer it. */
export function matchingRule(policy: AutoAnswerPolicy | null, promptText: string): AutoAnswerRule | undefined {
  if (!policy?.enabled) return undefined;
  return policy.rules.find((candidate) => candidate.match !== '' && squash(promptText).includes(squash(candidate.match)));
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  yes: 'y\r',
  no: 'n\r',
  enter: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), String(i + 1)])),
};

/**
 * Turns an answer request into the PTY writes to perform, in order. Literal
 * text and its Enter are separate writes so a TUI sees a typed message, not a paste.
 */
export function resolveAnswer(request: AnswerRequest): string[] {
  const { keys, text, submit } = request;
  if ((keys === undefined) === (text === undefined)) throw new HubError(400, 'send exactly one of "keys" or "text"');
  if (keys !== undefined) {
    if (typeof keys !== 'string' || keys === '') throw new HubError(400, 'keys must be a non-empty string');
    return [keys];
  }
  if (typeof text !== 'string' || text === '') throw new HubError(400, 'text must be a non-empty string');
  const named = NAMED_KEYS[text.trim().toLowerCase()];
  if (named !== undefined) return [submit === true && !named.endsWith('\r') ? `${named}\r` : named];
  return submit === true ? [text, '\r'] : [text];
}

/** One macOS notification per session per window. */
export class NotificationThrottle {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs: number = NOTIFY_THROTTLE_MS) {}

  shouldNotify(id: string, now: number = Date.now()): boolean {
    const previous = this.last.get(id);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    this.last.set(id, now);
    return true;
  }
}

export interface TrackerOptions {
  idleMs?: number;
  quietMs?: number;
  policy: () => AutoAnswerPolicy | null;
  onChange: (attention: AttentionInfo | null) => void;
  /** Called when a rule matches; the owner writes the keys and logs. */
  autoAnswer: (rule: AutoAnswerRule, promptText: string) => void;
}

/**
 * Per-session "needs attention" state from three layers: Claude Code hook
 * notifications, a heuristic over the plain-text tail of the output, and an
 * idle fallback. Cleared when input is sent or a prompt scrolls away.
 */
export class AttentionTracker {
  private readonly stripper = new AnsiStripper();
  private readonly idleMs: number;
  private readonly quietMs: number;
  private tail = '';
  private current: AttentionInfo | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private autoDone = false;
  private stopped = false;

  constructor(private readonly options: TrackerOptions) {
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.quietMs = options.quietMs ?? QUIET_MS;
    this.armIdle();
  }

  get attention(): AttentionInfo | null {
    return this.current;
  }

  output(chunk: Uint8Array): void {
    if (this.stopped) return;
    this.tail = (this.tail + this.stripper.push(chunk)).slice(-TAIL_CHARS);
    if (this.current?.reason === 'idle') this.set(null);
    this.armIdle();
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.evaluate(), this.quietMs);
  }

  /** The person or an agent typed something: whatever was pending is handled. */
  input(): void {
    if (this.stopped) return;
    this.tail = '';
    this.set(null);
    this.armIdle();
  }

  /** A Claude Code Notification hook fired. */
  hook(message: string): void {
    if (this.stopped) return;
    if (/waiting for your input/i.test(message)) {
      this.current ??= this.make('idle', message, 'hook');
      this.options.onChange(this.current);
      return;
    }
    const existing = this.current?.reason === 'prompt' ? this.current : null;
    this.set({ reason: 'prompt', promptText: detectPrompt(this.tail) ?? message, since: existing?.since ?? new Date().toISOString(), source: 'hook' });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [this.quietTimer, this.idleTimer, this.autoTimer, this.clearTimer]) if (timer) clearTimeout(timer);
    this.set(null);
  }

  private make(reason: AttentionInfo['reason'], promptText: string, source: AttentionInfo['source']): AttentionInfo {
    return { reason, promptText, since: new Date().toISOString(), source };
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.current === null) this.set(this.make('idle', lastLines(this.tail, PROMPT_LINES).join('\n'), 'idle'));
    }, this.idleMs);
  }

  private evaluate(): void {
    const prompt = detectPrompt(this.tail);
    if (prompt !== null && this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
    if (prompt !== null) {
      const existing = this.current?.reason === 'prompt' ? this.current : null;
      this.set({ reason: 'prompt', promptText: prompt, since: existing?.since ?? new Date().toISOString(), source: existing?.source ?? 'heuristic' });
    } else if (this.current?.reason === 'prompt' && this.current.source === 'heuristic' && !this.clearTimer) {
      this.clearTimer = setTimeout(() => {
        this.clearTimer = null;
        if (this.current?.source === 'heuristic') this.set(null);
      }, CLEAR_AFTER_MS);
    }
  }

  private set(next: AttentionInfo | null): void {
    const previous = this.current;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.current = next;
    if (previous?.since !== next?.since) {
      if (this.autoTimer) clearTimeout(this.autoTimer);
      this.autoTimer = null;
      this.autoDone = false;
    }
    this.options.onChange(next);
    if (next?.reason === 'prompt') this.scheduleAutoAnswer(next);
  }

  private scheduleAutoAnswer(attention: AttentionInfo): void {
    const policy = this.options.policy();
    if (!policy || this.autoDone || this.autoTimer) return;
    const rule = matchingRule(policy, attention.promptText);
    if (!rule) return;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      const live = this.current;
      if (!live || live.since !== attention.since || !squash(live.promptText).includes(squash(rule.match))) return;
      this.autoDone = true;
      this.options.autoAnswer(rule, live.promptText);
    }, policy.timeoutSec * AUTO_ANSWER_DELAY_UNIT_MS);
  }
}
