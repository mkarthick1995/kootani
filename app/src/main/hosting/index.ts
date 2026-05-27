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
import { hostLog, hostLogPath, startLogSession } from "./logger.js";

interface ActiveHost {
  server: SignalingHandle;
  tunnel: Tunnel;
}

let active: ActiveHost | null = null;

/**
 * Starts the local signaling server and a Cloudflare tunnel to it. Resolves with
 * a public `wss://` address (the invite link friends connect to) and a
 * `ws://127.0.0.1:<port>` address (what this PC connects to — see below).
 * `onStatus` receives human-readable progress (download can take a few seconds on
 * first run).
 */
export async function startHosting(
  onStatus?: (status: string) => void,
): Promise<{ url: string; localUrl: string }> {
  startLogSession();
  hostLog(`startHosting() called. Log file: ${hostLogPath()}`);

  if (active) {
    const localUrl = `ws://127.0.0.1:${active.server.port}`;
    hostLog(`already hosting, reusing ${active.tunnel.url} (local ${localUrl})`);
    return { url: active.tunnel.url, localUrl };
  }

  onStatus?.("Starting local server…");
  const server = await createSignalingServer(0);
  const localUrl = `ws://127.0.0.1:${server.port}`;
  hostLog(`signaling server listening on 127.0.0.1:${server.port}`);
  let tunnel: Tunnel | null = null;

  try {
    onStatus?.("Preparing the tunnel (first run downloads a small helper)…");
    const bin = await ensureCloudflared(join(app.getPath("userData"), "bin"));

    onStatus?.("Opening a secure tunnel…");
    // Pass hostLog so EVERY line cloudflared prints (registration, edge
    // connections, and any incoming-request / 502 origin errors once a client
    // connects) lands in the log — that's what tells us whether the edge routes.
    tunnel = await startTunnel(bin, server.port, (line) => hostLog(`[cloudflared] ${line}`));
    hostLog(`tunnel reported ready: ${tunnel.url}`);

    // The tunnel URL is only ever handed out in invite links, for friends on the
    // outside internet to connect through. THIS PC connects to its own server via
    // localUrl (loopback) instead — never back through the tunnel. A probe proved
    // why: an external network reaches the tunnel's origin fine while the origin's
    // OWN machine gets HTTP 530 from Cloudflare's edge (and the request never
    // arrives). That mismatch is what made every host attempt fail. Loopback
    // sidesteps the edge entirely, so hosting now connects instantly and reliably.
    active = { server, tunnel };
    onStatus?.("Live");
    return { url: tunnel.url, localUrl };
  } catch (err) {
    hostLog(`startHosting FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    // Don't leave a dangling tunnel/server if anything failed.
    tunnel?.stop();
    await server.close();
    throw err;
  }
}

export async function stopHosting(): Promise<void> {
  if (!active) return;
  hostLog("stopHosting() — tearing down tunnel + server");
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
