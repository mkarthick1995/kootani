import { join } from "node:path";
import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, session, shell } from "electron";
import { googleLogin } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { startHosting, stopHosting } from "./hosting/index.js";
import { hostLog } from "./hosting/logger.js";
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

  // getUserMedia (mic) and getDisplayMedia (screen) need media/display-capture
  // granted in-app — we have no UI to prompt for them.
  const allowed = (p: string): boolean => p === "media" || p === "display-capture";
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission));

  // Screen sharing. Electron has no built-in picker on Windows, so getDisplayMedia
  // must be answered by us: the renderer shows our own picker, stashes the chosen
  // source id via "screen:prepare", then calls getDisplayMedia — and this handler
  // resolves that id to a desktopCapturer source. `audio: "loopback"` also captures
  // system audio (game sound) on Windows. Without a stashed id we deny the request.
  let pendingScreenSourceId: string | null = null;
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const wanted = pendingScreenSourceId;
    pendingScreenSourceId = null;
    if (!wanted) {
      callback({}); // nothing selected → deny
      return;
    }
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => {
        const match = sources.find((s) => s.id === wanted);
        if (match) callback({ video: match, audio: "loopback" });
        else callback({});
      })
      .catch(() => callback({}));
  });

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

  // Enumerate shareable screens/windows with thumbnails for the in-app picker.
  ipcMain.handle("screen:sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
  });
  // Remember the user's pick for the imminent getDisplayMedia call (see handler above).
  ipcMain.handle("screen:prepare", (_e, sourceId: string) => {
    pendingScreenSourceId = String(sourceId);
  });

  // Renderer-side diagnostics (WebSocket connect attempts, close codes, retries)
  // funnelled into the same host log so the whole picture is in one file.
  ipcMain.on("host:log", (_e, message: string) => hostLog(`[renderer] ${message}`));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
