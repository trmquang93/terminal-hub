import { describe, expect, it } from 'vitest';
import { findUrlSpans, linkifyText, safeExternalUrl } from '../src/shared/links';

const urls = (line: string): string[] => findUrlSpans(line).map((span) => span.url);

describe('findUrlSpans', () => {
  it('finds one URL mid-line with exact offsets', () => {
    const line = 'open https://example.com/a?b=1 now';
    expect(findUrlSpans(line)).toEqual([{ start: 5, end: 30, url: 'https://example.com/a?b=1' }]);
    expect(line.slice(5, 30)).toBe('https://example.com/a?b=1');
  });

  it('finds two URLs on one line', () => {
    expect(urls('http://a.test/x and https://b.test/y')).toEqual(['http://a.test/x', 'https://b.test/y']);
  });

  it('excludes a trailing ")" or "." from the URL', () => {
    expect(urls('(see https://example.com/docs)')).toEqual(['https://example.com/docs']);
    expect(urls('Visit https://example.com/docs.')).toEqual(['https://example.com/docs']);
    expect(urls('(visit https://example.com/docs).')).toEqual(['https://example.com/docs']);
  });

  it('keeps a balanced ")" that belongs to the URL', () => {
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  it('ignores non-http schemes', () => {
    expect(urls('ftp://a.test/x file:///etc/passwd javascript:alert(1) data:text/html,hi mailto:a@b.test')).toEqual([]);
    expect(urls('ftp+http://a.test/x')).toEqual([]);
  });

  it('ignores a bare scheme with no host', () => {
    expect(urls('see https:// for details')).toEqual([]);
  });
});

const only = (line: string) => {
  const spans = linkifyText(line);
  expect(spans).toHaveLength(1);
  return spans[0]!;
};

describe('linkifyText', () => {
  it('reads a ":line" suffix off a path', () => {
    const line = 'error in src/main/sessionManager.ts:12 today';
    expect(only(line)).toEqual({ start: 9, end: 38, kind: 'path', target: 'src/main/sessionManager.ts', line: 12 });
    expect(line.slice(9, 38)).toBe('src/main/sessionManager.ts:12');
  });

  it('reads a ":line:col" suffix', () => {
    expect(only('/tmp/a.ts:12:5')).toEqual({ start: 0, end: 14, kind: 'path', target: '/tmp/a.ts', line: 12, col: 5 });
  });

  it('drops a trailing colon after the location', () => {
    expect(only('src/a.ts:12:5: error TS2322')).toMatchObject({ target: 'src/a.ts', line: 12, col: 5, end: 13 });
  });

  it('keeps spaces inside double quotes, single quotes and backslash escapes', () => {
    expect(only('open "/tmp/my dir/a b.txt" now')).toMatchObject({ start: 6, end: 25, target: '/tmp/my dir/a b.txt' });
    expect(only("open '/tmp/my dir/a b.txt:7' now")).toMatchObject({ target: '/tmp/my dir/a b.txt', line: 7 });
    expect(only('open /tmp/my\\ dir/a.txt now')).toMatchObject({ start: 5, end: 23, target: '/tmp/my dir/a.txt' });
  });

  it('never swallows a space in an unquoted path', () => {
    expect(only('see /tmp/a.txt and more')).toMatchObject({ target: '/tmp/a.txt', end: 14 });
  });

  it('finds ~/ and ./ and ../ paths', () => {
    expect(only('~/notes/todo.md')).toMatchObject({ target: '~/notes/todo.md' });
    expect(only('run ./scripts/build.sh')).toMatchObject({ start: 4, target: './scripts/build.sh' });
    expect(only('../other/file.ts:3')).toMatchObject({ target: '../other/file.ts', line: 3 });
  });

  it('trims a trailing ")." and keeps the path inside brackets', () => {
    expect(only('(see src/a.ts).')).toEqual({ start: 5, end: 13, kind: 'path', target: 'src/a.ts' });
    expect(only('(see src/a.ts:12).')).toMatchObject({ target: 'src/a.ts', line: 12, end: 16 });
  });

  it('does not treat a flag or an assignment as a path', () => {
    expect(linkifyText('--file=/x')).toEqual([]);
    expect(linkifyText('-/x')).toEqual([]);
    expect(linkifyText('FOO=/x/y')).toEqual([]);
  });

  it('does not split the ":line" off a URL', () => {
    expect(only('https://example.com/src/file.ts:12')).toEqual({ start: 0, end: 34, kind: 'url', target: 'https://example.com/src/file.ts:12' });
  });

  it('does not read a URL query or an ignored scheme as a path', () => {
    expect(only('https://example.com/a/b?x=/y/z&q=1')).toMatchObject({ kind: 'url' });
    expect(linkifyText('file:///etc/passwd')).toEqual([]);
  });

  it('returns a URL and a path from one line in order', () => {
    const line = 'src/a.ts:3 mentions https://example.com/docs and ~/b.md.';
    expect(linkifyText(line).map(({ kind, target, line: n }) => ({ kind, target, line: n }))).toEqual([
      { kind: 'path', target: 'src/a.ts', line: 3 },
      { kind: 'url', target: 'https://example.com/docs', line: undefined },
      { kind: 'path', target: '~/b.md', line: undefined },
    ]);
  });

  it('leaves ordinary prose alone', () => {
    expect(linkifyText('Build finished in 3.2s: 14 files, no errors. Don\'t panic, it\'s "fine" (really).')).toEqual([]);
    expect(linkifyText('a bare word like README or a / b or // comment')).toEqual([]);
  });

  it('does not scan past the line cap', () => {
    expect(linkifyText(`${'x '.repeat(5000)}/tmp/late.txt`)).toEqual([]);
  });
});

describe('safeExternalUrl', () => {
  it('allows only http and https', () => {
    expect(safeExternalUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com/');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://a.test', 'not a url', '', 42, null]) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
  });
});
