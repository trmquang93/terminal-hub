const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const BRACKET = 0x5d;
const BACKSLASH = 0x5c;
/** Longest OSC payload kept; a longer sequence is dropped whole. */
export const MAX_OSC_BYTES = 4096;

type State = 'text' | 'esc' | 'osc' | 'oscEsc' | 'skip' | 'skipEsc';

/**
 * Streaming reader for the terminal-title escape sequences iTerm2 honors: `ESC ] 0 ; text` and `ESC ] 2 ; text`,
 * ended by BEL or ST (`ESC \`). OSC 1 (icon name only) and every other OSC are ignored. State survives across
 * chunks, so a sequence or a multi-byte character may be split anywhere.
 */
export class OscTitleParser {
  private state: State = 'text';
  private payload: number[] = [];
  private readonly decoder = new TextDecoder();

  /** Feeds one chunk of PTY output; returns the titles completed by it, in order. */
  push(chunk: Uint8Array): string[] {
    const titles: string[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case 'text':
          if (byte === ESC) this.state = 'esc';
          break;
        case 'esc':
          this.state = byte === BRACKET ? 'osc' : byte === ESC ? 'esc' : 'text';
          this.payload = [];
          break;
        case 'osc':
        case 'skip':
          if (byte === BEL) this.finish(titles);
          else if (byte === ESC) this.state = this.state === 'osc' ? 'oscEsc' : 'skipEsc';
          else if (byte === CAN || byte === SUB) this.state = 'text';
          else if (this.state === 'osc') {
            this.payload.push(byte);
            if (this.payload.length > MAX_OSC_BYTES) this.drop('skip');
          }
          break;
        case 'oscEsc':
        case 'skipEsc':
          if (byte === BACKSLASH) this.finish(titles);
          else {
            // ESC followed by anything else cancels the sequence; that ESC may begin the next one.
            this.drop('text');
            this.state = byte === BRACKET ? 'osc' : byte === ESC ? 'esc' : 'text';
          }
          break;
      }
    }
    return titles;
  }

  private drop(next: State): void {
    this.payload = [];
    this.state = next;
  }

  private finish(titles: string[]): void {
    const bytes = this.state === 'oscEsc' || this.state === 'osc' ? this.payload : [];
    this.drop('text');
    const separator = bytes.indexOf(0x3b);
    if (separator < 0) return;
    const code = this.decoder.decode(Uint8Array.from(bytes.slice(0, separator)));
    if (code !== '0' && code !== '2') return;
    const title = this.decoder.decode(Uint8Array.from(bytes.slice(separator + 1))).replace(/\p{Cc}/gu, '').trim();
    if (title) titles.push(title);
  }
}
