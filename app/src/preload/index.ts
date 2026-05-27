import { contextBridge, ipcRenderer } from "electron";
import type { KootaniApi } from "../shared/ipc.js";

const api: KootaniApi = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  googleLogin: () => ipcRenderer.invoke("auth:google"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  startHosting: () => ipcRenderer.invoke("host:start"),
  stopHosting: () => ipcRenderer.invoke("host:stop"),
  onHostStatus: (cb) => {
    const listener = (_e: unknown, status: string): void => cb(status);
    ipcRenderer.on("host:status", listener);
    return () => ipcRenderer.removeListener("host:status", listener);
  },
  log: (message) => ipcRenderer.send("host:log", String(message)),
};

contextBridge.exposeInMainWorld("kootani", api);
