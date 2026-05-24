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
}
