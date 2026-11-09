import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { safeExternalUrl } from '../shared/links';
import type { AnswerRequest, HubDefaults, MenuAction, StartSessionOptions } from '../shared/types';
import { createApiServer, listenOnLoopback } from './apiServer';
import { loadOrCreateToken, removeApiFile, writeApiFile } from './apiFile';
import { NotificationThrottle } from './attention';
import { AttentionNotifier } from './attentionNotifier';
import { createHookRefresher } from './claudeHooks';
import { loadNotifyConfig } from './notifyConfig';
import { NotifyLog } from './notifyDelivery';
import { dataDir } from './paths';
import { cachedRepoRoot } from './repoRoot';
import { SessionListeners } from './sessionListeners';
import { SessionManager } from './sessionManager';
import { SessionStore } from './sessionStore';
import { loginShellPath } from './shellEnv';
import { isDryRun, Updater } from './updater';

const REPLAY_BYTES = 8 * 1024 * 1024;
const RECENT_FOLDERS = 12;
/** On quit, how long to let the final `resolved` events go out. */
const NOTIFY_DRAIN_MS = 2000;

const dir = dataDir();
app.setName('TerminalHub');
app.setPath('userData', join(dir, 'electron'));

let window: BrowserWindow | null = null;
let manager: SessionManager;
let listeners: SessionListeners | null = null;
let notifier: AttentionNotifier | null = null;
let updater: Updater | null = null;
let apiServer: Server | null = null;
let apiBaseUrl: string | null = null;
let quitting = false;
const startedAt = new Date().toISOString();

function defaultShell(): string {
  return process.env.SHELL ?? '/bin/zsh';
}

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function recentFolders(): string[] {
  const seen = new Set<string>();
  for (const session of manager.list().sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    if (session.cwd) seen.add(session.cwd);
  }
  return [...seen].slice(0, RECENT_FOLDERS);
}

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  const options = { type: 'warning' as const, buttons: [action, 'Cancel'], defaultId: 1, cancelId: 1, message, detail };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return response === 0;
}

async function deleteAllHistory(): Promise<boolean> {
  const count = manager.list().length;
  if (count === 0) return false;
  const ok = await confirm(
    `Delete all ${count} session${count === 1 ? '' : 's'}?`,
    'Running sessions are killed. Every session folder, including its output log, is removed from disk. This cannot be undone.',
    'Delete all history',
  );
  if (ok) await manager.removeAll();
  return ok;
}

function registerIpc(): void {
  ipcMain.handle('hub:defaults', (): HubDefaults => ({ shell: defaultShell(), home: app.getPath('home'), recentFolders: recentFolders() }));
  ipcMain.handle('hub:repoRoots', async (_event, cwds: string[]) => {
    const roots: Record<string, string | null> = {};
    for (const cwd of cwds) if (typeof cwd === 'string') roots[cwd] = await cachedRepoRoot(cwd);
    return roots;
  });
  ipcMain.handle('hub:list', () => manager.list());
  ipcMain.handle('hub:create', (_event, options: StartSessionOptions) => manager.start(options).id);
  ipcMain.on('hub:input', (_event, id: string, data: string) => {
    try {
      manager.write(id, data);
    } catch {
      // session ended between keystroke and delivery
    }
  });
  ipcMain.on('hub:resize', (_event, id: string, cols: number, rows: number) => manager.resize(id, cols, rows));
  ipcMain.handle('hub:read', (_event, id: string, tailBytes: number) => manager.readTail(id, Math.min(tailBytes, REPLAY_BYTES)));
  ipcMain.handle('hub:stop', (_event, id: string) => manager.stop(id));
  ipcMain.handle('hub:resume', (_event, id: string) => void manager.resume(id));
  ipcMain.handle('hub:answer', (_event, id: string, request: AnswerRequest) => manager.answer(id, request));
  ipcMain.handle('hub:rename', (_event, id: string, title: string) => void manager.setTitle(id, title));
  ipcMain.handle('hub:archive', (_event, id: string, archived: boolean) => void manager.setArchived(id, archived));
  ipcMain.handle('hub:delete', async (_event, id: string) => {
    if (!manager.get(id)) return false;
    await manager.remove(id);
    return true;
  });
  ipcMain.handle('hub:deleteMany', async (_event, ids: string[]) => {
    const existing = ids.filter((id) => manager.get(id));
    await manager.removeMany(existing);
    return existing.length;
  });
  ipcMain.handle('hub:deleteAll', deleteAllHistory);
  ipcMain.handle('hub:getUpdate', () => updater?.getStatus() ?? { phase: 'idle', ahead: 0, message: 'auto-update off' });
  ipcMain.handle('hub:pickFolder', async () => {
    const options = { properties: ['openDirectory' as const, 'createDirectory' as const] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('hub:openExternal', async (_event, url: unknown) => {
    const safe = safeExternalUrl(url);
    if (safe === null) return false;
    await shell.openExternal(safe);
    return true;
  });
  manager.onOutput(({ id, endOffset, data }) => send('hub:output', { id, endOffset, data }));
  manager.onChanged((session) => send('hub:changed', session));
  manager.onRemoved((id) => send('hub:removed', id));
  const throttle = new NotificationThrottle();
  manager.onAttention((session) => {
    if (session.attention?.reason !== 'prompt' || !Notification.isSupported() || !throttle.shouldNotify(session.id)) return;
    const notification = new Notification({ title: `${session.title} needs input`, body: session.attention.promptText.split('\n').slice(-3).join('\n') });
    notification.on('click', () => {
      window?.show();
      send('hub:select', session.id);
    });
    notification.show();
  });
}

function buildMenu(): void {
  const action = (label: string, accelerator: string | undefined, menuAction: MenuAction): Electron.MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send('hub:menu', menuAction),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Session',
        submenu: [
          action('New Session…', 'CmdOrCtrl+T', 'new'),
          action('Clear Terminal', 'CmdOrCtrl+K', 'clear'),
          { type: 'separator' },
          { label: 'Delete All History…', click: () => void deleteAllHistory() },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#14161a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => (window = null));
  void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

async function startServices(): Promise<void> {
  const loginPath = await loginShellPath(defaultShell());
  const baseEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: [loginPath, process.env.PATH].filter(Boolean).join(':') });
  const notifyLog = new NotifyLog(dir);
  const hooksFile = createHookRefresher(
    dir,
    () => ({ repoRoot: join(__dirname, '..', '..'), resourcesPath: app.isPackaged ? process.resourcesPath : undefined, searchPath: baseEnv().PATH }),
    (level, message) => notifyLog.write(level, message),
  );
  hooksFile();
  manager = new SessionManager(new SessionStore(join(dir, 'sessions')), app.getVersion(), {
    baseEnv,
    hooksFile,
    log: (message) => notifyLog.write('INFO', message),
    listenerInfo: (id) => listeners?.list(id) ?? [],
  });
  listeners = new SessionListeners({
    dataDir: dir,
    sessionsRoot: join(dir, 'sessions'),
    startSession: (options) => manager.start(options),
    getSession: (id) => manager.get(id),
    log: (level, message) => notifyLog.write(level, message),
    apiBaseUrl: () => apiBaseUrl,
  });
  const token = loadOrCreateToken(dir);
  notifier = new AttentionNotifier({
    send: (event) => {
      const session = manager.get(event.session.id);
      if (session) listeners?.publish(event, session);
      return Promise.resolve();
    },
    secrets: () => [token, loadNotifyConfig(dir).config?.bearer ?? ''],
    onDrop: (event) => notifyLog.write('WARN', `${event.event} session=${event.session.id.slice(0, 8)} dropped: delivery queue full`),
  });
  manager.onChanged((session) => {
    notifier?.update(session);
    if (!session.running) listeners?.publishExit(session);
  });
  manager.onRemoved((id) => {
    notifier?.forget(id);
    listeners?.forget(id);
  });
  apiServer = createApiServer({ service: manager, token, version: app.getVersion(), startedAt, ...(listeners ? { listeners } : {}) });
  const port = await listenOnLoopback(apiServer);
  apiBaseUrl = `http://127.0.0.1:${port}`;
  writeApiFile(dir, { baseUrl: apiBaseUrl, token, pid: process.pid });
  updater = new Updater({
    manager,
    isPackaged: app.isPackaged,
    dataDir: dir,
    quit: shutdown,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    env: baseEnv,
    dryRun: isDryRun(process.env),
    onStatus: (status) => send('hub:update', status),
  });
  updater.start();
}

async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  updater?.stop();
  removeApiFile(dir);
  apiServer?.close();
  apiServer?.closeAllConnections();
  await manager.shutdown();
  await notifier?.drain(NOTIFY_DRAIN_MS);
  await listeners?.drain(NOTIFY_DRAIN_MS);
  app.exit(0);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => window?.focus());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void shutdown();
  });
  app.on('window-all-closed', () => undefined);
  app.on('activate', () => {
    if (!window) createWindow();
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void shutdown());

  void app.whenReady().then(async () => {
    await startServices();
    registerIpc();
    buildMenu();
    createWindow();
  });
}
