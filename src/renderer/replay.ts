const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';

/**
 * A full-screen app (Claude Code) leaves the alternate screen when it exits, which would wipe its
 * last frame. For a finished session, stop just before that final exit so the last frame stays visible.
 */
export function keepLastFrame(data: Uint8Array): Uint8Array {
  const text = new TextDecoder('latin1').decode(data);
  const off = text.lastIndexOf(ALT_SCREEN_OFF);
  return off > text.lastIndexOf(ALT_SCREEN_ON) ? data.subarray(0, off) : data;
}
