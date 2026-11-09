import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type IBufferLine, type ILink } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { findUrlSpans } from '../shared/links';
import type { OutputEvent } from '../shared/types';
import { formatBytes } from './format';
import { keepLastFrame } from './replay';

const REPLAY_BYTES = 8 * 1024 * 1024;
/** Erase the visible screen and the scrollback, then home the cursor. No mode reset, so a running TUI keeps its state. */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/** The http(s) links on buffer row y (1-based). URLs are found on the whole wrapped line and mapped back to 1-based cell positions. */
function linksAtRow(term: Terminal, y: number): ILink[] {
  const buffer = term.buffer.active;
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  const cells: { x: number; y: number }[] = []; // cells[i]: the cell that holds text[i]
  const empty = buffer.getNullCell();
  for (let row = first; ; row++) {
    const line: IBufferLine | undefined = buffer.getLine(row);
    if (!line || (row > first && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, empty);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: row + 1 });
    }
  }
  return findUrlSpans(text).flatMap((span) => {
    const start = cells[span.start];
    const end = cells[span.end - 1];
    if (!start || !end || y < start.y || y > end.y) return [];
    return [{ range: { start, end }, text: span.url, activate: () => void window.hub.openExternal(span.url) }];
  });
}

/** Shows one session: replays the tail of output.log (shell), the in-memory tail (running agent) or the native transcript (finished agent), then follows live output. Remount per session id. */
export function TerminalView({ id, ended }: { id: string; ended: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 20000,
      allowProposedApi: true,
      theme: { background: '#14161a', foreground: '#d7dae0' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    const links = term.registerLinkProvider({ provideLinks: (y, callback) => callback(linksAtRow(term, y)) });

    let offset = 0;
    let ready = false;
    const pending: OutputEvent[] = [];
    const apply = (event: OutputEvent): void => {
      if (event.endOffset <= offset) return;
      const start = event.endOffset - event.data.length;
      term.write(event.data.subarray(Math.max(0, offset - start)));
      offset = event.endOffset;
    };

    // Subscribe first, then replay; offsets drop any overlap.
    const offOutput = window.hub.onOutput((event) => {
      if (event.id !== id) return;
      if (ready) apply(event);
      else pending.push(event);
    });
    void window.hub.readOutput(id, REPLAY_BYTES).then((slice) => {
      if (slice.source === 'log' && slice.start > 0) {
        term.write(`\x1b[2m… showing the last ${formatBytes(slice.total - slice.start)} of ${formatBytes(slice.total)}; the full log is on disk …\x1b[0m\r\n`);
      }
      term.write(ended ? keepLastFrame(slice.data) : slice.data);
      offset = slice.total;
      ready = true;
      pending.splice(0).forEach(apply);
    });

    const onData = term.onData((data) => window.hub.sendInput(id, data));
    const onResize = term.onResize(({ cols, rows }) => window.hub.resize(id, cols, rows));
    window.hub.resize(id, term.cols, term.rows);
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    const offMenu = window.hub.onMenu((action) => {
      if (action !== 'clear') return;
      term.clear(); // scrollback only; keeps the current line
      term.write(CLEAR_SCREEN); // local to xterm, never sent to the PTY

    });
    term.focus();

    return () => {
      offOutput();
      offMenu();
      links.dispose();
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      term.dispose();
    };
  }, [id]);

  return <div className="terminal-pane" ref={host} />;
}
