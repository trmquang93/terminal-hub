export interface UrlSpan {
  /** Index of the first character in the line. */
  start: number;
  /** Index one past the last character. */
  end: number;
  url: string;
}

// http(s) only; the lookbehind keeps "ftp+http://x" or "xhttp://x" from matching mid-token.
const URL_PATTERN = /(?<![A-Za-z0-9+.-])https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"\]}]$/;

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Drops sentence punctuation and an unbalanced ')' from the end, so "(see https://a.b/c)." links "https://a.b/c" but "https://a.b/f(x)" keeps its ')'. */
function trimTrailing(url: string): string {
  let result = url;
  for (;;) {
    if (TRAILING_PUNCTUATION.test(result) || (result.endsWith(')') && count(result, ')') > count(result, '('))) result = result.slice(0, -1);
    else return result;
  }
}

/** Finds the http:// and https:// URLs in one line of terminal text. Other schemes are ignored. */
export function findUrlSpans(line: string): UrlSpan[] {
  const spans: UrlSpan[] = [];
  for (const match of line.matchAll(URL_PATTERN)) {
    const url = trimTrailing(match[0]);
    if (safeExternalUrl(url) === null) continue;
    spans.push({ start: match.index, end: match.index + url.length, url });
  }
  return spans;
}

/** The URL to hand to the OS browser, or null unless it parses and uses http: or https:. Never allows file:, javascript:, data: and the like. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
