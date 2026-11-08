export interface CommandSpec {
  command: string;
  args: string[];
}

const SHELL_SYNTAX = /[|&;<>()$`\\*?~#]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function splitWords(line: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(current);
  return words;
}

/**
 * Turns a command line typed in the UI into command + args. Plain words are
 * spawned directly (leading VAR=value goes through `env`); anything using
 * shell syntax runs via `<shell> -l -i -c`.
 */
export function parseCommandLine(line: string, shell: string): CommandSpec | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const words = SHELL_SYNTAX.test(trimmed) ? null : splitWords(trimmed);
  if (!words || words.length === 0) return { command: shell, args: ['-l', '-i', '-c', trimmed] };
  const [first = '', ...rest] = words;
  return ASSIGNMENT.test(first) ? { command: 'env', args: [first, ...rest] } : { command: first, args: rest };
}
