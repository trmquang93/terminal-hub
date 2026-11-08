import { StringDecoder } from 'node:string_decoder';

const MAX_CURSOR_SPACES = 200;
/** Cursor up/down/next/previous line and absolute position: a TUI redraw moves to another row. */
const ROW_MOVES = 'ABEFHf';

const enum State {
  Ground,
  Escape,
  EscapeIntermediate,
  Csi,
  /** OSC, DCS, SOS, PM, APC: swallowed until BEL or ST. */
  String,
  StringEscape,
}

/**
 * Streaming terminal-output-to-plain-text converter. Drops escape sequences,
 * carriage returns and control characters (keeps \n and \t); cursor-forward and
 * absolute-column moves become spaces and row moves become newlines. State carries
 * across push() calls, so partial sequences and split UTF-8 are handled.
 */
export class AnsiStripper {
  private readonly decoder = new StringDecoder('utf8');
  private state: State = State.Ground;
  private csiParams = '';
  /** Characters emitted on the current output line, so absolute columns can be padded with spaces. */
  private column = 0;

  push(chunk: Uint8Array): string {
    const text = this.decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    let out = '';
    const pad = (count: number): void => {
      out += ' '.repeat(Math.min(count, MAX_CURSOR_SPACES));
    };
    const lineLength = (): number => {
      const newline = out.lastIndexOf('\n');
      return newline < 0 ? this.column + [...out].length : [...out.slice(newline + 1)].length;
    };
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      switch (this.state) {
        case State.Ground:
          if (code === 0x1b) this.state = State.Escape;
          else if (code === 0x0a || code === 0x09) out += ch;
          else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) out += ch;
          break;
        case State.Escape:
          if (ch === '[') {
            this.state = State.Csi;
            this.csiParams = '';
          }
          else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') this.state = State.String;
          else if (code >= 0x20 && code <= 0x2f) this.state = State.EscapeIntermediate;
          else if (code === 0x1b) this.state = State.Escape;
          else this.state = State.Ground;
          break;
        case State.EscapeIntermediate:
          if (code < 0x20 || code > 0x2f) this.state = State.Ground;
          break;
        case State.Csi:
          if (code >= 0x40 && code <= 0x7e) {
            this.state = State.Ground;
            // TUIs (Claude Code) draw spaces as cursor moves; keep them as spaces.
            const n = Number.parseInt(this.csiParams, 10);
            if (ch === 'C') pad(n || 1);
            else if (ROW_MOVES.includes(ch) && !out.endsWith('\n')) out += '\n';
            else if (ch === 'G') pad(Math.max(0, (n || 1) - 1 - lineLength()));
          } else if (code === 0x1b) this.state = State.Escape;
          else this.csiParams += ch;
          break;
        case State.String:
          if (code === 0x07 || code === 0x9c) this.state = State.Ground;
          else if (code === 0x1b) this.state = State.StringEscape;
          break;
        case State.StringEscape:
          this.state = ch === '\\' ? State.Ground : code === 0x1b ? State.StringEscape : State.String;
          break;
      }
    }
    const newline = out.lastIndexOf('\n');
    this.column = newline < 0 ? this.column + [...out].length : [...out.slice(newline + 1)].length;
    return out;
  }
}

export function stripAnsi(data: Uint8Array | string): string {
  return new AnsiStripper().push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
}
