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

export interface KootaniApi {
  getConfig(): Promise<KootaniConfig>;
  googleLogin(): Promise<UserInfo>;
  copyText(text: string): Promise<void>;
  /** Start the in-app signaling server + tunnel; resolves with the public wss URL. */
  startHosting(): Promise<{ url: string }>;
  /** Tear down the in-app server + tunnel. */
  stopHosting(): Promise<void>;
  /** Subscribe to hosting progress messages. Returns an unsubscribe function. */
  onHostStatus(cb: (status: string) => void): () => void;
}
