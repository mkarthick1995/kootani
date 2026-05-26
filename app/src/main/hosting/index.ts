/**
 * One-click hosting: orchestrates the in-process signaling server + the
 * Cloudflare tunnel so the renderer can become a backend with a single call.
 *
 * Only one host session at a time (a PC hosts one room). Everything is torn
 * down on stop and on app quit.
 */
import { join } from "node:path";
import { app } from "electron";
import { createSignalingServer, type SignalingHandle } from "./signaling.js";
import { ensureCloudflared, startTunnel, type Tunnel } from "./cloudflared.js";

interface ActiveHost {
  server: SignalingHandle;
  tunnel: Tunnel;
}

let active: ActiveHost | null = null;

/**
 * Starts the local signaling server and a Cloudflare tunnel to it. Resolves
 * with the public `wss://` address to host a room at. `onStatus` receives
 * human-readable progress (download can take a few seconds on first run).
 */
export async function startHosting(onStatus?: (status: string) => void): Promise<{ url: string }> {
  if (active) return { url: active.tunnel.url };

  onStatus?.("Starting local server…");
  const server = await createSignalingServer(0);

  try {
    onStatus?.("Preparing the tunnel (first run downloads a small helper)…");
    const bin = await ensureCloudflared(join(app.getPath("userData"), "bin"));

    onStatus?.("Opening a secure tunnel…");
    const tunnel = await startTunnel(bin, server.port);

    active = { server, tunnel };
    onStatus?.("Live");
    return { url: tunnel.url };
  } catch (err) {
    // Don't leave a dangling server if the tunnel failed.
    await server.close();
    throw err;
  }
}

export async function stopHosting(): Promise<void> {
  if (!active) return;
  const { server, tunnel } = active;
  active = null;
  tunnel.stop();
  await server.close();
}

export function isHosting(): boolean {
  return active !== null;
}

// Best-effort cleanup if the window closes while hosting.
app.on("before-quit", () => {
  void stopHosting();
});
