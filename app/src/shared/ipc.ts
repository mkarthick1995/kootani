/**
 * The contract for the bridge exposed by preload as `window.kootani`.
 * Lives in shared/ so the renderer can import these types without pulling in
 * Electron/node-only code, and preload can implement against the same shape.
 */
import type { UserInfo } from "./protocol";

export interface KootaniConfig {
  signalingUrl: string;
  googleConfigured: boolean;
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

export interface KootaniApi {
  getConfig(): Promise<KootaniConfig>;
  googleLogin(): Promise<UserInfo>;
  copyText(text: string): Promise<void>;
  /**
   * Start the in-app signaling server + tunnel. Resolves with:
   *  - `url`: the public `wss://…trycloudflare.com` address to put in invite links
   *    (what friends connect to, from the outside internet).
   *  - `localUrl`: `ws://127.0.0.1:<port>` — what *this* PC connects to. The host
   *    must NOT reach its own server via the tunnel: routing out to Cloudflare's
   *    edge and back to the same machine is both wasteful and unreliable (we've
   *    observed the edge return HTTP 530 to the origin's own network while serving
   *    every other network fine). Localhost is instant and always works.
   */
  startHosting(): Promise<{ url: string; localUrl: string }>;
  /** Tear down the in-app server + tunnel. */
  stopHosting(): Promise<void>;
  /** List the screens/windows available to share (with thumbnails). */
  getScreenSources(): Promise<ScreenSource[]>;
  /**
   * Choose which source the next getDisplayMedia() call will capture. Must be
   * called right before the renderer invokes getDisplayMedia — the main-process
   * display-media handler reads this to pick the source (our in-app picker
   * replaces Electron's absent native one).
   */
  prepareScreenShare(sourceId: string): Promise<void>;
  /** Subscribe to hosting progress messages. Returns an unsubscribe function. */
  onHostStatus(cb: (status: string) => void): () => void;
  /** Fire-and-forget: append a line to the host diagnostics log (main process). */
  log(message: string): void;
}
