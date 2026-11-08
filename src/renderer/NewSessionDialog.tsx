import { useEffect, useState } from 'react';
import { parseCommandLine } from '../shared/commandLine';
import type { HubDefaults, StartSessionOptions } from '../shared/types';
import { baseName, shortenPath } from './format';

type Preset = 'shell' | 'claude' | 'codex' | 'custom';

const PRESET_LABELS: Record<Preset, string> = { shell: 'Login shell', claude: 'Claude Code (claude)', codex: 'Codex (codex)', custom: 'Custom command…' };

function buildCommand(preset: Preset, custom: string, shell: string): { command: string; args: string[] } | null {
  if (preset === 'shell') return { command: shell, args: ['-l'] };
  if (preset === 'claude') return { command: 'claude', args: [] };
  if (preset === 'codex') return { command: 'codex', args: [] };
  return parseCommandLine(custom, shell);
}

export function NewSessionDialog({ defaults, onCreate, onClose }: { defaults: HubDefaults; onCreate: (options: StartSessionOptions) => Promise<void>; onClose: () => void }) {
  const [cwd, setCwd] = useState(defaults.recentFolders[0] ?? defaults.home);
  const [preset, setPreset] = useState<Preset>('shell');
  const [custom, setCustom] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const spec = buildCommand(preset, custom, defaults.shell);
  const label = spec ? (spec.command === 'env' ? (spec.args.find((arg) => !arg.includes('=')) ?? 'env') : baseName(spec.command)) : '';
  const generatedTitle = spec ? `${label === 'zsh' || spec.command === defaults.shell ? baseName(defaults.shell) : label} — ${baseName(cwd)}` : '';

  async function submit(): Promise<void> {
    if (!spec) {
      setError('Enter a command.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({ cwd, command: spec.command, args: spec.args, title: title.trim() || undefined });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(caught));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form
        className="dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>New session</h2>
        <label>
          Folder
          <span className="row">
            <input value={cwd} onChange={(event) => setCwd(event.target.value)} spellCheck={false} />
            <button type="button" onClick={() => void window.hub.pickFolder().then((picked) => picked && setCwd(picked))}>
              Choose…
            </button>
          </span>
        </label>
        {defaults.recentFolders.length > 0 && (
          <div className="recent">
            {defaults.recentFolders.map((folder) => (
              <button type="button" key={folder} className={folder === cwd ? 'chip active' : 'chip'} onClick={() => setCwd(folder)} title={folder}>
                {shortenPath(folder, defaults.home)}
              </button>
            ))}
          </div>
        )}
        <label>
          Command
          <select value={preset} onChange={(event) => setPreset(event.target.value as Preset)}>
            {Object.entries(PRESET_LABELS).map(([key, text]) => (
              <option key={key} value={key}>
                {text}
              </option>
            ))}
          </select>
        </label>
        {preset === 'custom' && <input value={custom} placeholder="e.g. npm run dev" onChange={(event) => setCustom(event.target.value)} spellCheck={false} autoFocus />}
        <label>
          Title
          <input value={title} placeholder={generatedTitle} onChange={(event) => setTitle(event.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Start
          </button>
        </div>
      </form>
    </div>
  );
}
