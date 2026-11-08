import { describe, expect, it } from 'vitest';
import { MAX_OSC_BYTES, OscTitleParser } from '../src/main/oscTitle';

const bytes = (text: string): Buffer => Buffer.from(text);
const parse = (...chunks: (string | Buffer)[]): string[] => {
  const parser = new OscTitleParser();
  return chunks.flatMap((chunk) => parser.push(typeof chunk === 'string' ? bytes(chunk) : chunk));
};

describe('OscTitleParser', () => {
  it('reads OSC 0 and OSC 2 ended by BEL', () => {
    expect(parse('\x1b]0;icon and title\x07')).toEqual(['icon and title']);
    expect(parse('\x1b]2;window title\x07')).toEqual(['window title']);
  });

  it('reads both ended by ST (ESC \\)', () => {
    expect(parse('\x1b]0;one\x1b\\\x1b]2;two\x1b\\')).toEqual(['one', 'two']);
  });

  it('finds sequences between ordinary output and returns them in order', () => {
    expect(parse('\x1b[31mred\x1b[0m\r\n\x1b]2;a\x07text\x1b]2;b\x07more')).toEqual(['a', 'b']);
  });

  it('ignores OSC 1 (icon only) and other OSC codes', () => {
    expect(parse('\x1b]1;icon\x07\x1b]8;;https://example.com\x07\x1b]52;c;aGk=\x07\x1b]20;x\x07')).toEqual([]);
    expect(parse('\x1b]1;icon\x07\x1b]2;kept\x07')).toEqual(['kept']);
  });

  it('survives a sequence split across three chunks, at any byte', () => {
    expect(parse('\x1b]', '2;split ti', 'tle\x07')).toEqual(['split title']);
    expect(parse('\x1b', ']2;st\x1b', '\\')).toEqual(['st']);
    const all = bytes('x\x1b]0;every byte\x07y');
    const parser = new OscTitleParser();
    expect([...all].flatMap((byte) => parser.push(Buffer.from([byte])))).toEqual(['every byte']);
  });

  it('survives a UTF-8 character split between chunks', () => {
    const whole = bytes('\x1b]2;✳ Claude — tên\x07');
    const cut = whole.indexOf(0xe2) + 1; // inside the three-byte ✳
    expect(parse(whole.subarray(0, cut), whole.subarray(cut))).toEqual(['✳ Claude — tên']);
  });

  it('drops an oversized sequence, ignores its tail and recovers on the next one', () => {
    const huge = 'x'.repeat(MAX_OSC_BYTES + 10);
    expect(parse(`\x1b]2;${huge}\x07`)).toEqual([]);
    expect(parse(`\x1b]2;${huge}`, 'tail\x07\x1b]2;ok\x07')).toEqual(['ok']);
    expect(parse(`\x1b]2;${huge}\x1b\\\x1b]2;ok\x07`)).toEqual(['ok']);
    expect(parse(`\x1b]2;${'y'.repeat(MAX_OSC_BYTES - 2)}\x07`)).toHaveLength(1);
  });

  it('strips control characters and trims', () => {
    expect(parse('\x1b]2;  \x01he\x08llo\tworld\r\n  \x07')).toEqual(['helloworld']);
  });

  it('ignores an empty or blank title and a sequence without a code separator', () => {
    expect(parse('\x1b]2;\x07\x1b]0;   \x07\x1b]2;\x01\x02\x07\x1b]2\x07')).toEqual([]);
  });

  it('abandons a sequence cut short by another escape and still sees the next one', () => {
    expect(parse('\x1b]2;lost\x1b[31m text\x07\x1b]2;next\x07')).toEqual(['next']);
    expect(parse('\x1b]2;lost\x1b]2;next\x07')).toEqual(['next']);
    expect(parse('\x1b]2;lost\x18text\x1b]2;next\x07')).toEqual(['next']);
  });
});
