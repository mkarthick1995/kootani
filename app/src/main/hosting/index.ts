/**
 * One-click hosting: orchestrates the in-process signaling server + the
 * Cloudflare tunnel so the renderer can become a backend with a single call.
 *
 * Only one host session at a time (a PC hosts one room). If the tunnel dies
 * mid-session, a new one is opened automatically and the renderer is told the
 * new public URL (it relays that to guests over WebRTC so they can follow).
 * Everything is torn down on stop and on app quit.
 */
import { join } from "node:path";
import { app } from "electron";
import type { HostEvent } from "../../shared/ipc.js";
import type { IceServer } from "../../shared/protocol.js";
import { log } from "../logger.js";
import { createSignalingServer, type SignalingHandle } from "./signaling.js";
import { discardCloudflared, ensureCloudflared, startTunnel, TunnelSpawnError, type Tunnel } from "./cloudflared.js";

interface ActiveHost {
  server: SignalingHandle;
  tunnel: Tunnel | null;
  bin: string;
  emit: (e: HostEvent) => void;
  restarting: boolean;
}

let active: ActiveHost | null = null;
let starting: Promise<{ url: string; localUrl: string }> | null = null;

const binDir = (): string => join(app.getPath("userData"), "bin");
const RESTART_DELAYS_MS = [1_000, 4_000, 10_000];

/** Open a tunnel, retrying once on a transient failure; re-downloads a broken binary. */
async function openTunnel(port: number, emit: (e: HostEvent) => void): Promise<{ tunnel: Tunnel; bin: string }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const bin = await ensureCloudflared(binDir(), (pct) =>
      emit({
        type: "status",
        message: pct === null ? "Downloading the tunnel helper (first run only)…" : `Downloading the tunnel helper… ${pct}%`,
      }),
    );
    emit({ type: "status", message: attempt === 1 ? "Opening a secure tunnel…" : "Retrying the tunnel…" });
    try {
      const tunnel = await startTunnel(bin, port, (reason) => onTunnelDied(reason));
      return { tunnel, bin };
    } catch (err) {
      lastErr = err;
      log(`tunnel attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof TunnelSpawnError) discardCloudflared(binDir());
    }
  }
  throw lastErr;
}

/** The tunnel process exited mid-session: open a fresh one (new URL). */
function onTunnelDied(reason: string): void {
  const host = active;
  if (!host || host.restarting) return;
  host.restarting = true;
  host.tunnel = null;
  log(`tunnel died mid-session (${reason}) — reopening`);
  host.emit({ type: "tunnel-down" });

  void (async () => {
    for (const delay of RESTART_DELAYS_MS) {
      await new Promise((r) => setTimeout(r, delay));
      if (active !== host) return; // hosting stopped meanwhile
      try {
        const tunnel = await startTunnel(host.bin, host.server.port, (r) => onTunnelDied(r));
        if (active !== host) {
          tunnel.stop();
          return;
        }
        host.tunnel = tunnel;
        host.restarting = false;
        log(`tunnel reopened: ${tunnel.url}`);
        host.emit({ type: "tunnel-up", url: tunnel.url });
        return;
      } catch (err) {
        log(`tunnel reopen failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    host.restarting = false;
    host.emit({
      type: "tunnel-failed",
      message: "Lost the secure tunnel and couldn't reopen it. Friends can't join; leave and host again.",
    });
  })();
}

/**
 * Starts the local signaling server and a Cloudflare tunnel to it. Resolves with
 * the public `wss://` address (for invite links) and a `ws://127.0.0.1:<port>`
 * address (what THIS PC connects to — never back through the tunnel, which
 * Cloudflare's edge doesn't reliably route for the origin's own network).
 */
export function startHosting(
  emit: (e: HostEvent) => void,
  iceServers: IceServer[],
): Promise<{ url: string; localUrl: string }> {
  if (active?.tunnel) {
    active.emit = emit;
    return Promise.resolve({ url: active.tunnel.url, localUrl: `ws://127.0.0.1:${active.server.port}` });
  }
  // A double-click (or a second window) gets the in-flight attempt, not a second server.
  starting ??= doStart(emit, iceServers).finally(() => {
    starting = null;
  });
  return starting;
}

async function doStart(
  emit: (e: HostEvent) => void,
  iceServers: IceServer[],
): Promise<{ url: string; localUrl: string }> {
  log("startHosting()");
  emit({ type: "status", message: "Starting local server…" });
  const server = await createSignalingServer(iceServers);
  const localUrl = `ws://127.0.0.1:${server.port}`;
  log(`signaling server listening on 127.0.0.1:${server.port}`);

  try {
    // `active` must exist before the tunnel can report dying.
    active = { server, tunnel: null, bin: "", emit, restarting: false };
    const { tunnel, bin } = await openTunnel(server.port, (e) => active?.emit(e));
    if (!active || active.server !== server) {
      tunnel.stop(); // stopHosting() ran while we were starting
      throw new Error("Hosting was cancelled.");
    }
    active.tunnel = tunnel;
    active.bin = bin;
    log(`tunnel ready: ${tunnel.url}`);
    emit({ type: "status", message: "Live" });
    return { url: tunnel.url, localUrl };
  } catch (err) {
    log(`startHosting FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (active?.server === server) active = null;
    await server.close();
    throw err;
  }
}

export async function stopHosting(): Promise<void> {
  const host = active;
  if (!host) return;
  active = null;
  log("stopHosting() — tearing down tunnel + server");
  host.tunnel?.stop();
  await host.server.close();
}

/** How many people (including the host) are in the hosted room right now. */
export function hostedMemberCount(): number {
  return active?.server.stats().members ?? 0;
}

/** Synchronous best-effort teardown for quit paths that can't await. */
export function killHostingNow(): void {
  active?.tunnel?.stop();
}
