import { join } from "node:path";
import { app, BrowserWindow, clipboard, ipcMain, session, shell } from "electron";
import { googleLogin } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { startHosting, stopHosting } from "./hosting/index.js";
import type { UserInfo } from "../shared/protocol.js";

// Resolved once the app is ready (loadConfig reads app.getAppPath()).
let config: AppConfig;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: "Kootani",
    backgroundColor: "#1b1d24",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Let remote/peer audio play without a user gesture.
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // Open external links (e.g. avatar fallback) in the system browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  config = loadConfig();

  // getUserMedia (mic/cam) needs the media permission granted in-app.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");

  ipcMain.handle("config:get", () => ({
    signalingUrl: config.signalingUrl,
    googleConfigured: Boolean(config.googleClientId && config.googleClientSecret),
  }));

  // The renderer's navigator.clipboard is unreliable under our locked-down
  // permissions; use Electron's native clipboard instead.
  ipcMain.handle("clipboard:write", (_e, text: string) => {
    clipboard.writeText(String(text));
  });

  ipcMain.handle("auth:google", async (): Promise<UserInfo> => {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error(
        "Google sign-in is not configured. Set KOOTANI_GOOGLE_CLIENT_ID and " +
          "KOOTANI_GOOGLE_CLIENT_SECRET (see README).",
      );
    }
    return googleLogin(config.googleClientId, config.googleClientSecret);
  });

  // One-click hosting: spin up the signaling server + tunnel, streaming progress
  // back to the renderer so it can show "Opening tunnel…" etc.
  ipcMain.handle("host:start", (event) => {
    const sender = event.sender;
    return startHosting((status) => {
      if (!sender.isDestroyed()) sender.send("host:status", status);
    });
  });
  ipcMain.handle("host:stop", () => stopHosting());

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
