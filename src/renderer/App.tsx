import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HubDefaults, SessionInfo, StartSessionOptions, UpdaterStatus } from '../shared/types';
import { formatTime, shortenPath } from './format';
import { groupSessions } from './grouping';
import { NewSessionDialog } from './NewSessionDialog';
import { TerminalView } from './TerminalView';

function AttentionBadge({ session }: { session: SessionInfo }) {
  if (!session.attention) return null;
  return session.attention.reason === 'prompt' ? <span className="badge attention">needs input</span> : <span className="badge idle">idle</span>;
}

function TurnBadge({ session }: { session: SessionInfo }) {
  return session.running && session.turn ? <span className={`badge turn-${session.turn.state}`}>{session.turn.state}</span> : null;
}

function Badge({ session }: { session: SessionInfo }) {
  if (session.running) return <span className="badge running">running</span>;
  if (session.state === 'interrupted') return <span className="badge interrupted">interrupted</span>;
  const failed = session.exitCode !== 0 || session.signal !== null;
  const detail = session.signal !== null ? `signal ${session.signal}` : `code ${session.exitCode ?? '?'}`;
  return <span className={failed ? 'badge failed' : 'badge exited'}>exited · {detail}</span>;
}

interface RowActions {
  home: string;
  selectedId: string | null;
  selectMode: boolean;
  checked: Set<string>;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
}

function SessionRow({ session, selected, selectMode, checked, onSelect, onDelete, onArchive }: { session: SessionInfo; selected: boolean; selectMode: boolean; checked: boolean; onSelect: () => void; onDelete: () => void; onArchive: (archived: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const commit = (): void => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== session.title) void window.hub.renameSession(session.id, draft.trim());
  };
  return (
    <li className={`session${selected && !selectMode ? ' selected' : ''}${checked ? ' checked' : ''}${session.archived ? ' archived' : ''}`} onClick={onSelect}>
      <div className="session-head">
        {selectMode && <input className="check" type="checkbox" checked={checked} onChange={onSelect} onClick={(event) => event.stopPropagation()} />}
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
        {!selectMode && !session.running && (
          <button className="icon text" title={session.archived ? 'Unarchive session' : 'Archive session'} onClick={(event) => (event.stopPropagation(), onArchive(!session.archived))}>
            {session.archived ? 'Unarchive' : 'Archive'}
          </button>
        )}
        {!selectMode && (
          <button className="icon" title="Delete session" onClick={(event) => (event.stopPropagation(), onDelete())}>
            ×
          </button>
        )}
      </div>
      <div className="meta">
        <Badge session={session} />
        <AttentionBadge session={session} />
        <TurnBadge session={session} />
        {session.claude && <span className="badge tag">{session.claude.provider}</span>}
      </div>
      <div className="times">
        started {formatTime(session.startedAt)}
        {session.endedAt && <> · ended {formatTime(session.endedAt)}</>}
      </div>
    </li>
  );
}

function SessionGroups({ sessions, actions }: { sessions: SessionInfo[]; actions: RowActions }) {
  return (
    <>
      {groupSessions(sessions).map((group) => (
        <li key={group.cwd} className="group">
          <div className="group-head" title={group.cwd}>
            <div className="group-title">
              <strong>{group.name}</strong>
              <span className="group-count" title={`${group.sessions.length} sessions`}>{group.sessions.length}</span>
            </div>
            <span className="cwd">{shortenPath(group.cwd, actions.home)}</span>
          </div>
          <ul className="group-sessions">
            {group.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={session.id === actions.selectedId}
                selectMode={actions.selectMode}
                checked={actions.checked.has(session.id)}
                onSelect={() => actions.onSelect(session.id)}
                onDelete={() => actions.onDelete(session.id)}
                onArchive={(archived) => actions.onArchive(session.id, archived)}
              />
            ))}
          </ul>
        </li>
      ))}
    </>
  );
}

function UpdateChip({ status }: { status: UpdaterStatus }) {
  if (status.phase === 'idle' || status.phase === 'checking') return null;
  return <div className={status.phase === 'error' ? 'update-chip error' : 'update-chip'}>{status.message}</div>;
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
  const [update, setUpdate] = useState<UpdaterStatus | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const announced = useRef(new Map<string, string>());

  const refreshDefaults = useCallback(() => window.hub.defaults().then(setDefaults), []);

  useEffect(() => {
    void window.hub.listSessions().then((list) => {
      setSessions(list);
      setSelectedId((current) => current ?? [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id ?? null);
    });
    void refreshDefaults();
    void window.hub.getUpdate().then(setUpdate);
    const offUpdate = window.hub.onUpdate(setUpdate);
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
      setChecked((current) => (current.has(id) ? new Set([...current].filter((item) => item !== id)) : current));
      setSelectedId((current) => (current === id ? null : current));
    });
    const offMenu = window.hub.onMenu((action) => {
      if (action === 'new') setDialog(true);
    });
    return () => {
      offUpdate();
      offChanged();
      offRemoved();
      offMenu();
      offSelect();
    };
  }, [refreshDefaults]);

  const unarchived = useMemo(() => sessions.filter((session) => !session.archived), [sessions]);
  const archived = useMemo(() => sessions.filter((session) => session.archived), [sessions]);
  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  function endSelectMode(): void {
    setSelectMode(false);
    setChecked(new Set());
  }

  function toggleChecked(id: string): void {
    setChecked((current) => new Set(current.has(id) ? [...current].filter((item) => item !== id) : [...current, id]));
  }

  async function deleteChecked(): Promise<void> {
    const ids = [...checked];
    endSelectMode();
    await window.hub.deleteSessions(ids);
  }

  const actions: RowActions = {
    home: defaults?.home ?? '',
    selectedId,
    selectMode,
    checked,
    onSelect: (id) => (selectMode ? toggleChecked(id) : setSelectedId(id)),
    onDelete: (id) => void window.hub.deleteSession(id),
    onArchive: (id, value) => void window.hub.archiveSession(id, value).catch((error: unknown) => alert(String(error))),
  };

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
          {update && <UpdateChip status={update} />}
        </div>
        <div className="select-bar">
          {selectMode ? (
            <>
              <span className="count">{checked.size} selected</span>
              <button className="danger" disabled={checked.size === 0} onClick={() => void deleteChecked()}>
                Delete selected
              </button>
              <button onClick={endSelectMode}>Cancel</button>
            </>
          ) : (
            <button disabled={sessions.length === 0} onClick={() => setSelectMode(true)}>
              Select
            </button>
          )}
        </div>
        <ul className="sessions">
          <SessionGroups sessions={unarchived} actions={actions} />
          {sessions.length === 0 && <li className="empty">No sessions yet.</li>}
          {sessions.length > 0 && unarchived.length === 0 && <li className="empty">No sessions outside the archive.</li>}
          {archived.length > 0 && (
            <li className="archived-section">
              <button className="archived-toggle" aria-expanded={archivedOpen} onClick={() => setArchivedOpen((open) => !open)}>
                {archivedOpen ? '▾' : '▸'} Archived ({archived.length})
              </button>
              {archivedOpen && (
                <ul className="group-sessions">
                  <SessionGroups sessions={archived} actions={actions} />
                </ul>
              )}
            </li>
          )}
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
