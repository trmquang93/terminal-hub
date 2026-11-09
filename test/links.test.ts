import { describe, expect, it } from 'vitest';
import { findUrlSpans, safeExternalUrl } from '../src/shared/links';

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

describe('safeExternalUrl', () => {
  it('allows only http and https', () => {
    expect(safeExternalUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com/');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://a.test', 'not a url', '', 42, null]) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
  });
});
