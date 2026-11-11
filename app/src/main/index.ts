import { join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  session,
  shell,
} from "electron";
import { cancelGoogleLogin, googleLogin } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { hostedMemberCount, killHostingNow, startHosting, stopHosting } from "./hosting/index.js";
import { log, logBanner, logPath } from "./logger.js";
import type { HostEvent, KootaniConfig, ScreenSource, ShortcutAction } from "../shared/ipc.js";
import type { UserInfo } from "../shared/protocol.js";

// A bug in the main process must never take the whole call down with a crash
// dialog; log it (the user can send us the log) and keep running.
process.on("uncaughtException", (err) => log(`UNCAUGHT: ${err.stack ?? err.message}`));
process.on("unhandledRejection", (reason) => log(`UNHANDLED REJECTION: ${String(reason)}`));

// Resolved once the app is ready (loadConfig reads app paths).
let config: AppConfig;
let mainWindow: BrowserWindow | null = null;

const SHORTCUTS: Record<ShortcutAction, string> = {
  "toggle-mute": "CommandOrControl+Shift+M",
  "toggle-deafen": "CommandOrControl+Shift+D",
};

function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

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
      sandbox: true,
      // Let remote/peer audio play without a user gesture.
      autoplayPolicy: "no-user-gesture-required",
      // Keep audio/timers running at full speed while minimized behind a game.
      backgroundThrottling: false,
    },
  });
  mainWindow = win;

  // Links open in the system browser — and only web links, never file:// etc.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The UI is a single page; never navigate away (e.g. a file dropped on the window).
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    log(`renderer gone: ${details.reason} (exit ${details.exitCode})`);
  });

  // Closing while hosting ends the room for everyone — make sure that's intended.
  win.on("close", (e) => {
    const others = hostedMemberCount() - 1;
    if (others <= 0) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Keep hosting", "Close and end the room"],
      defaultId: 0,
      cancelId: 0,
      title: "You're hosting",
      message: `The room runs on your PC. Closing Kootani disconnects ${others} ${others === 1 ? "friend" : "friends"}.`,
    });
    if (choice === 0) e.preventDefault();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function setShortcuts(enabled: boolean): ShortcutAction[] {
  for (const accel of Object.values(SHORTCUTS)) {
    if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
  }
  if (!enabled) return [];
  const registered: ShortcutAction[] = [];
  for (const [action, accel] of Object.entries(SHORTCUTS) as [ShortcutAction, string][]) {
    const ok = globalShortcut.register(accel, () => mainWindow?.webContents.send("shortcut", action));
    if (ok) registered.push(action);
    else log(`shortcut ${accel} is taken by another app`);
  }
  return registered;
}

app.whenReady().then(() => {
  logBanner();
  config = loadConfig();

  // getUserMedia (mic) and getDisplayMedia (screen) need media/display-capture
  // granted in-app — we have no UI to prompt for them. Everything else is denied.
  const allowed = (p: string): boolean => p === "media" || p === "display-capture" || p === "speaker-selection";
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission));

  // Screen sharing. Electron has no built-in picker on Windows, so getDisplayMedia
  // must be answered by us: the renderer shows our own picker, stashes the chosen
  // source id via "screen:prepare", then calls getDisplayMedia — and this handler
  // resolves that id to a desktopCapturer source. `audio: "loopback"` also captures
  // system audio (game sound) on Windows. Without a stashed id we deny the request.
  let pending: { id: string; audio: boolean } | null = null;
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const wanted = pending;
    pending = null;
    if (!wanted) {
      callback({}); // nothing selected → deny
      return;
    }
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => {
        const match = sources.find((s) => s.id === wanted.id);
        if (!match) {
          log(`screen share: source ${wanted.id} no longer exists`);
          callback({});
          return;
        }
        callback(wanted.audio ? { video: match, audio: "loopback" } : { video: match });
      })
      .catch((err) => {
        log(`screen share: getSources failed: ${String(err)}`);
        callback({});
      });
  });

  ipcMain.handle(
    "config:get",
    (): KootaniConfig => ({
      version: app.getVersion(),
      signalingUrl: config.signalingUrl,
      googleConfigured: Boolean(config.googleClientId && config.googleClientSecret),
      iceServers: config.iceServers,
    }),
  );

  // The renderer's navigator.clipboard is unreliable under our locked-down
  // permissions; use Electron's native clipboard instead.
  ipcMain.handle("clipboard:write", (_e, text: unknown) => {
    clipboard.writeText(String(text));
  });
  ipcMain.handle("clipboard:read", () => clipboard.readText().slice(0, 4096));

  ipcMain.handle("auth:google", async (): Promise<UserInfo> => {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error("Google sign-in is not configured in this build. Use a nickname instead.");
    }
    return googleLogin(config.googleClientId, config.googleClientSecret);
  });
  ipcMain.handle("auth:cancel", () => cancelGoogleLogin());

  // One-click hosting: spin up the signaling server + tunnel, streaming progress
  // and later tunnel lifecycle events back to the renderer that asked.
  ipcMain.handle("host:start", (event) => {
    const sender = event.sender;
    return startHosting((e: HostEvent) => {
      if (!sender.isDestroyed()) sender.send("host:event", e);
    }, config.iceServers);
  });
  ipcMain.handle("host:stop", () => stopHosting());

  // Enumerate shareable screens/windows with thumbnails for the in-app picker.
  ipcMain.handle("screen:sources", async (): Promise<ScreenSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    const ownTitle = mainWindow?.getTitle();
    return sources
      .filter((s) => s.name !== ownTitle) // sharing Kootani itself is never what you want
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }));
  });
  // Remember the user's pick for the imminent getDisplayMedia call (see handler above).
  ipcMain.handle("screen:prepare", (_e, sourceId: unknown, withAudio: unknown) => {
    pending = { id: String(sourceId), audio: withAudio !== false };
  });

  ipcMain.handle("shortcuts:set", (_e, enabled: unknown) => setShortcuts(Boolean(enabled)));
  // Leaving the room (or reloading) always releases the global hotkeys.
  ipcMain.on("room:state", (_e, value: unknown) => {
    if (!value) setShortcuts(false);
  });
  ipcMain.handle("logs:open", () => shell.showItemInFolder(logPath()));

  // Renderer-side diagnostics (connection attempts, WebRTC state) go to the same log.
  ipcMain.on("app:log", (_e, message: unknown) => log(`[renderer] ${String(message).slice(0, 2000)}`));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  killHostingNow(); // never leave an orphaned cloudflared behind
  void stopHosting();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
