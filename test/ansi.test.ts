import { describe, expect, it } from 'vitest';
import { AnsiStripper, stripAnsi } from '../src/main/ansi';

describe('stripAnsi', () => {
  it('removes SGR colours from ls --color output', () => {
    expect(stripAnsi('\x1b[0m\x1b[01;34mdir\x1b[0m  \x1b[01;32mrun.sh\x1b[0m\r\n')).toBe('dir  run.sh\n');
  });

  it('removes CSI cursor moves, OSC titles (BEL and ST) and charset selects', () => {
    expect(stripAnsi('a\x1b[2K\x1b[1;1Hb\x1b]0;title\x07c\x1b]8;;http://x\x1b\\d\x1b(Be')).toBe('a\nbcde');
  });

  it('drops carriage returns and other control characters but keeps newline and tab', () => {
    expect(stripAnsi('one\r\ntwo\tx\x08\x07\x00y\rz')).toBe('one\ntwo\txyz');
  });

  it('turns cursor-forward into spaces, as TUIs draw their spacing that way', () => {
    expect(stripAnsi('Esc\x1b[1Cto\x1b[1Ccancel a\x1b[3Cb\x1b[Cc')).toBe('Esc to cancel a   b c');
  });

  it('turns absolute-column moves into the spaces between words, per line, across chunks', () => {
    const stripper = new AnsiStripper();
    const text = stripper.push(Buffer.from('\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\r\n\x1b[2Gnext\x1b[8')) + stripper.push(Buffer.from('Gline\x1b[1Gx'));
    // a move back to column 1 cannot erase text already emitted, so it just continues the line
    expect(text).toBe(' Quick safety check:\n next  linex');
  });

  it('turns row moves (cursor up, home) into newlines so redraws do not run together', () => {
    expect(stripAnsi('frame1\x1b[2K\x1b[1Aframe2\x1b[H\x1b[2Jframe3')).toBe('frame1\nframe2\nframe3');
  });

  it('keeps multibyte text', () => {
    expect(stripAnsi('── xin chào ──\n')).toBe('── xin chào ──\n');
  });

  it('handles escape sequences and UTF-8 split across chunks', () => {
    const stripper = new AnsiStripper();
    const bytes = Buffer.from('\x1b[38;5;196mđỏ\x1b[0m');
    let text = '';
    for (const byte of bytes) text += stripper.push(Uint8Array.of(byte));
    expect(text).toBe('đỏ');
  });

  it('does not leak the rest of an unterminated string sequence', () => {
    expect(stripAnsi('x\x1bPsecret')).toBe('x');
  });
});
