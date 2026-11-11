import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HostEvent, KootaniApi, ShortcutAction } from "../shared/ipc.js";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: KootaniApi = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  googleLogin: () => ipcRenderer.invoke("auth:google"),
  cancelGoogleLogin: () => ipcRenderer.invoke("auth:cancel"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  startHosting: () => ipcRenderer.invoke("host:start"),
  stopHosting: () => ipcRenderer.invoke("host:stop"),
  onHostEvent: (cb) => subscribe<HostEvent>("host:event", cb),
  getScreenSources: () => ipcRenderer.invoke("screen:sources"),
  prepareScreenShare: (sourceId, withAudio) => ipcRenderer.invoke("screen:prepare", sourceId, withAudio),
  setShortcutsEnabled: (enabled) => ipcRenderer.invoke("shortcuts:set", enabled),
  onShortcut: (cb) => subscribe<ShortcutAction>("shortcut", cb),
  setInRoom: (inRoom) => ipcRenderer.send("room:state", Boolean(inRoom)),
  openLogs: () => ipcRenderer.invoke("logs:open"),
  log: (message) => ipcRenderer.send("app:log", String(message)),
};

contextBridge.exposeInMainWorld("kootani", api);
