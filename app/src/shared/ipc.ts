/**
 * The contract for the bridge exposed by preload as `window.kootani`.
 * Lives in shared/ so the renderer can import these types without pulling in
 * Electron/node-only code, and preload can implement against the same shape.
 */
import type { IceServer, UserInfo } from "./protocol";

export interface KootaniConfig {
  /** App version (shown in the UI; mismatched builds are the #1 support issue). */
  version: string;
  signalingUrl: string;
  googleConfigured: boolean;
  /** TURN relays from kootani.config.json, used when a direct P2P path fails. */
  iceServers: IceServer[];
}

/** A screen or window the user can share, as offered by the OS picker. */
export interface ScreenSource {
  /** Opaque id from desktopCapturer; passed back to prepareScreenShare. */
  id: string;
  /** Human label, e.g. "Screen 1" or a window title. */
  name: string;
  /** A still thumbnail as a data: URL, for the picker grid. */
  thumbnail: string;
  /** The owning app's icon as a data: URL (windows only), or null. */
  appIcon: string | null;
}

/** Hosting lifecycle events streamed from the main process. */
export type HostEvent =
  /** Human-readable progress while starting ("Opening a secure tunnel…"). */
  | { type: "status"; message: string }
  /** The tunnel process died mid-session; a new one is being opened. */
  | { type: "tunnel-down" }
  /** A replacement tunnel is up at a NEW public URL. */
  | { type: "tunnel-up"; url: string }
  /** Gave up reopening the tunnel. */
  | { type: "tunnel-failed"; message: string };

/** Global hotkeys (work while a game has focus). */
export type ShortcutAction = "toggle-mute" | "toggle-deafen";

export interface KootaniApi {
  getConfig(): Promise<KootaniConfig>;
  googleLogin(): Promise<UserInfo>;
  /** Abort a Google sign-in that's waiting on the browser. */
  cancelGoogleLogin(): Promise<void>;
  copyText(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  /**
   * Start the in-app signaling server + tunnel. Resolves with:
   *  - `url`: the public `wss://…trycloudflare.com` address for invite links.
   *  - `localUrl`: `ws://127.0.0.1:<port>` — what *this* PC connects to (never
   *    back through the tunnel; Cloudflare's edge doesn't reliably route the
   *    origin's own network to itself).
   */
  startHosting(): Promise<{ url: string; localUrl: string }>;
  /** Tear down the in-app server + tunnel. */
  stopHosting(): Promise<void>;
  /** Subscribe to hosting events. Returns an unsubscribe function. */
  onHostEvent(cb: (event: HostEvent) => void): () => void;
  /** List the screens/windows available to share (with thumbnails). */
  getScreenSources(): Promise<ScreenSource[]>;
  /**
   * Choose which source the next getDisplayMedia() call will capture, and
   * whether to include system audio. Must be called right before getDisplayMedia.
   */
  prepareScreenShare(sourceId: string, withAudio: boolean): Promise<void>;
  /** Enable/disable the global mute/deafen hotkeys. Resolves with the ones that registered. */
  setShortcutsEnabled(enabled: boolean): Promise<ShortcutAction[]>;
  onShortcut(cb: (action: ShortcutAction) => void): () => void;
  /** Tell the main process whether we're in a room (used to confirm before quitting). */
  setInRoom(inRoom: boolean): void;
  /** Reveal the diagnostics log in Explorer. */
  openLogs(): Promise<void>;
  /** Fire-and-forget: append a line to the diagnostics log (main process). */
  log(message: string): void;
}
