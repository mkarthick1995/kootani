import { contextBridge, ipcRenderer } from "electron";
import type { KootaniApi } from "../shared/ipc.js";

const api: KootaniApi = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  googleLogin: () => ipcRenderer.invoke("auth:google"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
};

contextBridge.exposeInMainWorld("kootani", api);
