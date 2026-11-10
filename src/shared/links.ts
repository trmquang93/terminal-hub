export interface UrlSpan {
  /** Index of the first character in the line. */
  start: number;
  /** Index one past the last character. */
  end: number;
  url: string;
}

export interface LinkSpan {
  /** Index of the first character in the line. */
  start: number;
  /** Index one past the last character. */
  end: number;
  kind: 'url' | 'path';
  /** The URL, or the path with the ":line:col" suffix and any escaping removed. */
  target: string;
  line?: number;
  col?: number;
}

/** Longest logical line scanned for links; a minified bundle on one line must not stall hovering. */
const MAX_SCANNED = 8192;

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

// A quote opens a path only when it does not follow a word character, so the apostrophe in "don't" opens nothing.
const PATH_CANDIDATE = /(?<!\w)"([^"\n]+)"|(?<!\w)'([^'\n]+)'|(?:\\ |[^\s\\"'`<>|])+/g;
const PATH_TRAILING = /[.,;:!?)\]}]$/;
const PATH_LEADING = /^[([{]+/;
const LINE_SUFFIX = /^(.+?):(\d+)(?::(\d+))?$/;
const BARE_FIRST_SEGMENT = /^[\w@.+]+$/;

function looksLikePath(path: string): boolean {
  if (path.startsWith('-') || path.includes('://') || !/[^/]/.test(path)) return false;
  if (path.startsWith('/') || path.startsWith('~/') || path.startsWith('./') || path.startsWith('../')) return true;
  const slash = path.indexOf('/');
  return slash > 0 && BARE_FIRST_SEGMENT.test(path.slice(0, slash));
}

/** Splits a candidate into path and optional line and column; null when it is not a path. */
function parsePath(candidate: string): { path: string; line?: number; col?: number } | null {
  const suffix = LINE_SUFFIX.exec(candidate);
  const path = suffix ? suffix[1] : candidate;
  if (path === undefined || !looksLikePath(path)) return null;
  if (!suffix) return { path };
  const line = Number(suffix[2]);
  return suffix[3] === undefined ? { path, line } : { path, line, col: Number(suffix[3]) };
}

function findPathSpans(text: string, offset: number): LinkSpan[] {
  const spans: LinkSpan[] = [];
  for (const match of text.matchAll(PATH_CANDIDATE)) {
    const quoted = match[1] ?? match[2];
    let candidate: string;
    let start: number;
    if (quoted !== undefined) {
      if (quoted !== quoted.trim()) continue;
      candidate = quoted;
      start = match.index + 1;
    } else {
      let token = match[0];
      start = match.index;
      const leading = PATH_LEADING.exec(token)?.[0].length ?? 0;
      token = token.slice(leading);
      start += leading;
      while (PATH_TRAILING.test(token)) token = token.slice(0, -1);
      candidate = token;
    }
    const parsed = parsePath(candidate);
    if (!parsed) continue;
    const target = quoted === undefined ? parsed.path.replaceAll('\\ ', ' ') : parsed.path;
    spans.push({ start: offset + start, end: offset + start + candidate.length, kind: 'path', target, ...(parsed.line !== undefined ? { line: parsed.line } : {}), ...(parsed.col !== undefined ? { col: parsed.col } : {}) });
  }
  return spans;
}

/** The clickable spans of one logical line, in order: http(s) URLs first, then file paths in the text between them. */
export function linkifyText(line: string): LinkSpan[] {
  const text = line.length > MAX_SCANNED ? line.slice(0, MAX_SCANNED) : line;
  const spans: LinkSpan[] = [];
  let from = 0;
  for (const url of findUrlSpans(text)) {
    spans.push(...findPathSpans(text.slice(from, url.start), from), { start: url.start, end: url.end, kind: 'url', target: url.url });
    from = url.end;
  }
  spans.push(...findPathSpans(text.slice(from), from));
  return spans;
}
