import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import type { OutputEvent } from '../shared/types';
import { formatBytes } from './format';
import { keepLastFrame } from './replay';

const REPLAY_BYTES = 8 * 1024 * 1024;

/** Shows one session: replays the tail of output.log, then follows live output. Remount per session id. */
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
      if (slice.start > 0) {
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
      if (action === 'clear') term.clear();
    });
    term.focus();

    return () => {
      offOutput();
      offMenu();
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      term.dispose();
    };
  }, [id]);

  return <div className="terminal-pane" ref={host} />;
}
