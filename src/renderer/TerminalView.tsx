import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type IBufferLine } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { linkifyText, safeExternalUrl, type LinkSpan } from '../shared/links';
import type { OutputEvent } from '../shared/types';
import { formatBytes } from './format';
import { keepLastFrame } from './replay';

const REPLAY_BYTES = 8 * 1024 * 1024;
/** Erase the visible screen and the scrollback, then home the cursor. No mode reset, so a running TUI keeps its state. */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/** What a click on a link does, once per gesture. */
type Opener = () => void;
/** One Cmd/Ctrl+click can reach us as a pointerdown, a contextmenu and xterm's own mouseup activation; opens within this window count as one. */
const OPEN_DEDUPE_MS = 300;

interface Cell {
  x: number;
  y: number;
}

interface RowSpan {
  span: LinkSpan;
  start: Cell;
  end: Cell;
}

/** The URL and path spans that touch buffer row y (1-based). Spans are found on the whole wrapped line and mapped back to 1-based cell positions. */
function spansAtRow(term: Terminal, y: number): RowSpan[] {
  const buffer = term.buffer.active;
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  const cells: Cell[] = []; // cells[i]: the cell that holds text[i]
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
  return linkifyText(text).flatMap((span) => {
    const start = cells[span.start];
    const end = cells[span.end - 1];
    return start && end && y >= start.y && y <= end.y ? [{ span, start, end }] : [];
  });
}

/** The link span under a mouse event, found from its coordinates (not from xterm's hover state), or null. */
function spanAtPointer(term: Terminal, event: MouseEvent): LinkSpan | null {
  const screen = term.element?.querySelector('.xterm-screen');
  if (!screen || term.cols === 0 || term.rows === 0) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const col = Math.floor(((event.clientX - rect.left) / rect.width) * term.cols) + 1;
  const row = Math.floor(((event.clientY - rect.top) / rect.height) * term.rows);
  if (col < 1 || col > term.cols || row < 0 || row >= term.rows) return null;
  const y = term.buffer.active.viewportY + row + 1;
  const hit = spansAtRow(term, y).find(({ start, end }) => (y > start.y || col >= start.x) && (y < end.y || col <= end.x));
  return hit?.span ?? null;
}

/** Shows one session: replays the tail of output.log (shell), the in-memory tail (running agent) or the native transcript (finished agent), then follows live output. Remount per session id. */
export function TerminalView({ id, cwd, ended }: { id: string; cwd: string; ended: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // Only Cmd+click or Ctrl+click opens a link; a plain click still selects text.
    let lastOpen = 0;
    /** Set when this gesture's pointerdown already opened a link, so xterm's own mouseup activation and the contextmenu do not open a second one. */
    let openedByPointerDown = false;
    const openOnce = (open: Opener): void => {
      const now = Date.now();
      if (now - lastOpen < OPEN_DEDUPE_MS) return;
      lastOpen = now;
      open();
    };
    const openSpan = (span: LinkSpan): void =>
      openOnce(span.kind === 'url' ? () => void window.hub.openExternal(span.target) : () => void window.hub.openPath(span.target, cwd, span.line, span.col));
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 20000,
      allowProposedApi: true,
      theme: { background: '#14161a', foreground: '#d7dae0' },
      // OSC 8 links: without a handler xterm asks confirm() and calls window.open(), which this app blocks.
      linkHandler: {
        activate: (event, uri) => {
          const url = safeExternalUrl(uri);
          if (url !== null && (event.metaKey || event.ctrlKey) && !openedByPointerDown) openOnce(() => void window.hub.openExternal(url));
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    // The provider only draws the underline and pointer cursor; opening is decided from the pointer position below.
    const links = term.registerLinkProvider({
      provideLinks: (y, callback) =>
        callback(
          spansAtRow(term, y).map(({ span, start, end }) => ({
            range: { start, end },
            text: span.target,
            decorations: { pointerCursor: true, underline: true },
            activate: () => undefined,
          })),
        ),
    });
    const onPointerDown = (event: PointerEvent): void => {
      openedByPointerDown = false;
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
      const span = spanAtPointer(term, event);
      if (!span) return;
      openedByPointerDown = true;
      openSpan(span);
    };
    // On macOS Ctrl+click also sends a contextmenu after the pointerdown; it must not show a menu or open a second time.
    const onContextMenu = (event: MouseEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const span = openedByPointerDown ? null : spanAtPointer(term, event);
      if (!openedByPointerDown && !span) return;
      event.preventDefault();
      if (span) openSpan(span);
    };
    element.addEventListener('pointerdown', onPointerDown, true);
    element.addEventListener('contextmenu', onContextMenu, true);

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
      element.removeEventListener('pointerdown', onPointerDown, true);
      element.removeEventListener('contextmenu', onContextMenu, true);
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      term.dispose();
    };
  }, [id]);

  return <div className="terminal-pane" ref={host} />;
}
