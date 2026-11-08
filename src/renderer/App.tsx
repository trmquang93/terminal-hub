import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HubDefaults, SessionInfo, StartSessionOptions } from '../shared/types';
import { formatTime, shortenPath } from './format';
import { NewSessionDialog } from './NewSessionDialog';
import { TerminalView } from './TerminalView';

function AttentionBadge({ session }: { session: SessionInfo }) {
  if (!session.attention) return null;
  return session.attention.reason === 'prompt' ? <span className="badge attention">needs input</span> : <span className="badge idle">idle</span>;
}

function Badge({ session }: { session: SessionInfo }) {
  if (session.running) return <span className="badge running">running</span>;
  if (session.state === 'interrupted') return <span className="badge interrupted">interrupted</span>;
  const failed = session.exitCode !== 0 || session.signal !== null;
  const detail = session.signal !== null ? `signal ${session.signal}` : `code ${session.exitCode ?? '?'}`;
  return <span className={failed ? 'badge failed' : 'badge exited'}>exited · {detail}</span>;
}

function SessionRow({ session, home, selected, onSelect, onDelete }: { session: SessionInfo; home: string; selected: boolean; onSelect: () => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const commit = (): void => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== session.title) void window.hub.renameSession(session.id, draft.trim());
  };
  return (
    <li className={selected ? 'session selected' : 'session'} onClick={onSelect}>
      <div className="session-head">
        {editing ? (
          <input
            className="rename"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') setEditing(false);
            }}
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <span
            className="title"
            title="Double-click to rename"
            onDoubleClick={() => {
              setDraft(session.title);
              setEditing(true);
            }}
          >
            {session.title}
          </span>
        )}
        <button className="icon" title="Delete session" onClick={(event) => (event.stopPropagation(), onDelete())}>
          ×
        </button>
      </div>
      <div className="cwd" title={session.cwd}>
        {shortenPath(session.cwd, home)}
      </div>
      <div className="meta">
        <Badge session={session} />
        <AttentionBadge session={session} />
        {session.claude && <span className="badge tag">{session.claude.provider}</span>}
      </div>
      <div className="times">
        started {formatTime(session.startedAt)}
        {session.endedAt && <> · ended {formatTime(session.endedAt)}</>}
      </div>
    </li>
  );
}

const NUMBERED_MENU = /❯\s*1[.)]|^\s*1[.)]\s/m;

function AttentionPanel({ session }: { session: SessionInfo }) {
  const { attention } = session;
  const [error, setError] = useState<string | null>(null);
  if (!attention || !session.running) return null;
  const menu = NUMBERED_MENU.test(attention.promptText);
  const answer = (text: string): void => {
    setError(null);
    window.hub.answer(session.id, { text }).catch((caught: unknown) => setError(String(caught)));
  };
  const keys: [string, string][] = [['Yes', menu ? '1' : 'yes'], ['No', menu ? 'esc' : 'no'], ['1', '1'], ['2', '2'], ['Esc', 'esc'], ['Enter', 'enter']];
  return (
    <div className={attention.reason === 'prompt' ? 'attention-panel prompt' : 'attention-panel'}>
      <div className="attention-head">
        {attention.reason === 'prompt' ? 'Waiting for your answer' : 'No output for a while'} · {attention.source} · since {formatTime(attention.since)}
      </div>
      {attention.promptText && <pre>{attention.promptText}</pre>}
      {attention.reason === 'prompt' && (
        <div className="row">
          {keys.map(([label, text]) => (
            <button key={label} onClick={() => answer(text)}>
              {label}
            </button>
          ))}
          {error && <span className="error">{error}</span>}
        </div>
      )}
    </div>
  );
}

function Toasts({ toasts, onPick }: { toasts: Toast[]; onPick: (id: string) => void }) {
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <button key={toast.key} className="toast" onClick={() => onPick(toast.id)}>
          <strong>{toast.title} needs input</strong>
          <span>{toast.text}</span>
        </button>
      ))}
    </div>
  );
}

interface Toast {
  key: string;
  id: string;
  title: string;
  text: string;
}

function Banner({ session }: { session: SessionInfo }) {
  if (session.running) return null;
  const label = session.claude ? 'Resume' : 'Restart';
  const blocked = !session.resumable;
  const message =
    session.state === 'interrupted'
      ? `Phiên này đã dừng khi khởi động lại máy — ${label} để tiếp tục.`
      : `Process ended${session.signal !== null ? ` (signal ${session.signal})` : ` with exit code ${session.exitCode ?? '?'}`} at ${formatTime(session.endedAt)}.`;
  return (
    <div className={session.state === 'interrupted' ? 'banner interrupted' : 'banner'}>
      <span>{message}{blocked && ` No ${session.claude?.provider === 'opencode' ? 'opencode' : 'Claude'} session id was found, so it cannot be resumed.`}</span>
      <button className="primary" disabled={blocked} onClick={() => void window.hub.resumeSession(session.id).catch((error: unknown) => alert(String(error)))}>
        {label}
      </button>
    </div>
  );
}

export function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<HubDefaults | null>(null);
  const [dialog, setDialog] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const announced = useRef(new Map<string, string>());

  const refreshDefaults = useCallback(() => window.hub.defaults().then(setDefaults), []);

  useEffect(() => {
    void window.hub.listSessions().then((list) => {
      setSessions(list);
      setSelectedId((current) => current ?? [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id ?? null);
    });
    void refreshDefaults();
    const offChanged = window.hub.onSessionChanged((session) => {
      const since = session.attention?.reason === 'prompt' ? session.attention.since : undefined;
      if (since === undefined) announced.current.delete(session.id);
      else if (announced.current.get(session.id) !== since && session.attention) {
        announced.current.set(session.id, since);
        const toast: Toast = { key: `${session.id}${since}`, id: session.id, title: session.title, text: session.attention.promptText.split('\n').slice(-2).join(' · ') };
        setToasts((list) => (list.some((item) => item.id === session.id) ? list : [...list, toast]));
        setTimeout(() => setToasts((list) => list.filter((item) => item.key !== toast.key)), 8000);
      }
      setSessions((list) => (list.some((item) => item.id === session.id) ? list.map((item) => (item.id === session.id ? session : item)) : [...list, session]));
    });
    const offSelect = window.hub.onSelect(setSelectedId);
    const offRemoved = window.hub.onSessionRemoved((id) => {
      setSessions((list) => list.filter((item) => item.id !== id));
      setSelectedId((current) => (current === id ? null : current));
    });
    const offMenu = window.hub.onMenu((action) => {
      if (action === 'new') setDialog(true);
    });
    return () => {
      offChanged();
      offRemoved();
      offMenu();
      offSelect();
    };
  }, [refreshDefaults]);

  const ordered = useMemo(() => [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [sessions]);
  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  async function create(options: StartSessionOptions): Promise<void> {
    const id = await window.hub.createSession(options);
    setSelectedId(id);
    setDialog(false);
    void refreshDefaults();
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-top">
          <button className="primary" onClick={() => setDialog(true)}>
            + New session
          </button>
        </div>
        <ul className="sessions">
          {ordered.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              home={defaults?.home ?? ''}
              selected={session.id === selectedId}
              onSelect={() => setSelectedId(session.id)}
              onDelete={() => void window.hub.deleteSession(session.id)}
            />
          ))}
          {ordered.length === 0 && <li className="empty">No sessions yet.</li>}
        </ul>
        <div className="sidebar-bottom">
          <button className="danger" disabled={sessions.length === 0} onClick={() => void window.hub.deleteAllHistory()}>
            Delete all history…
          </button>
        </div>
      </aside>
      <main className="main">
        {selected ? (
          <>
            <header className="toolbar">
              <div className="toolbar-title">
                <strong>{selected.title}</strong>
                <span className="cwd">{defaults ? shortenPath(selected.cwd, defaults.home) : selected.cwd}</span>
              </div>
              <Badge session={selected} />
              {selected.running && <button onClick={() => void window.hub.stopSession(selected.id)}>Stop</button>}
            </header>
            <AttentionPanel session={selected} />
            <Banner session={selected} />
            <TerminalView key={selected.id} id={selected.id} ended={!selected.running} />
          </>
        ) : (
          <div className="placeholder">Select a session or press ⌘T to start a new one.</div>
        )}
      </main>
      <Toasts
        toasts={toasts}
        onPick={(id) => {
          setSelectedId(id);
          setToasts([]);
        }}
      />
      {dialog && defaults && <NewSessionDialog defaults={defaults} onCreate={create} onClose={() => setDialog(false)} />}
    </div>
  );
}
