import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { HubApi, MenuAction, OutputEvent, SessionInfo, UpdaterStatus } from '../shared/types';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api: HubApi = {
  defaults: () => ipcRenderer.invoke('hub:defaults'),
  listSessions: () => ipcRenderer.invoke('hub:list'),
  createSession: (options) => ipcRenderer.invoke('hub:create', options),
  sendInput: (id, data) => ipcRenderer.send('hub:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('hub:resize', id, cols, rows),
  readOutput: (id, tailBytes) => ipcRenderer.invoke('hub:read', id, tailBytes),
  stopSession: (id) => ipcRenderer.invoke('hub:stop', id),
  resumeSession: (id) => ipcRenderer.invoke('hub:resume', id),
  deleteSession: (id) => ipcRenderer.invoke('hub:delete', id),
  deleteSessions: (ids) => ipcRenderer.invoke('hub:deleteMany', ids),
  archiveSession: (id, archived) => ipcRenderer.invoke('hub:archive', id, archived),
  deleteAllHistory: () => ipcRenderer.invoke('hub:deleteAll'),
  answer: (id, request) => ipcRenderer.invoke('hub:answer', id, request),
  renameSession: (id, title) => ipcRenderer.invoke('hub:rename', id, title),
  pickFolder: () => ipcRenderer.invoke('hub:pickFolder'),
  onSessionChanged: (callback) => subscribe<SessionInfo>('hub:changed', callback),
  onSessionRemoved: (callback) => subscribe<string>('hub:removed', callback),
  onOutput: (callback) => subscribe<OutputEvent>('hub:output', callback),
  onMenu: (callback) => subscribe<MenuAction>('hub:menu', callback),
  onSelect: (callback) => subscribe<string>('hub:select', callback),
  getUpdate: () => ipcRenderer.invoke('hub:getUpdate'),
  onUpdate: (callback) => subscribe<UpdaterStatus>('hub:update', callback),
};

contextBridge.exposeInMainWorld('hub', api);
