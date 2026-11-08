import { describe, expect, it } from 'vitest';
import { keepLastFrame } from '../src/renderer/replay';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const show = (data: Uint8Array): string => new TextDecoder().decode(data);

describe('keepLastFrame', () => {
  it('stops before the final alternate-screen exit so the last frame of a full-screen app stays', () => {
    const log = '\x1b[?1049h\x1b[2JFRAME-1\x1b[HFRAME-2\x1b[?1049l\r\nResume this session with: claude --resume x\r\n';
    expect(show(keepLastFrame(bytes(log)))).toBe('\x1b[?1049h\x1b[2JFRAME-1\x1b[HFRAME-2');
  });

  it('leaves plain output, and a session that re-entered the alternate screen, untouched', () => {
    expect(show(keepLastFrame(bytes('hello\r\n')))).toBe('hello\r\n');
    const reentered = '\x1b[?1049h a \x1b[?1049l b \x1b[?1049h c';
    expect(show(keepLastFrame(bytes(reentered)))).toBe(reentered);
  });
});
