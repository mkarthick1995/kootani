/**
 * cloudflared — download and run a free Cloudflare "quick tunnel" so the
 * in-process signaling server (on loopback) is reachable by friends anywhere.
 *
 * The binary is cached under the app's userData dir (writable in a packaged
 * build). Quick tunnels need no Cloudflare account and no credit card; the
 * trade-off is a random URL per run — fine for on-demand game nights.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:os";
import { log } from "../logger.js";

/** A real cloudflared binary is tens of MB; anything tiny is a truncated/blocked download. */
const MIN_BINARY_BYTES = 5 * 1024 * 1024;
/** Abort a download that makes no progress for this long. */
const DOWNLOAD_STALL_MS = 30_000;

function cloudflaredAsset(): { name: string; file: string } {
  const a = arch() === "arm64" ? "arm64" : "amd64";
  if (platform() === "win32") return { name: `cloudflared-windows-${a}.exe`, file: "cloudflared.exe" };
  if (platform() === "darwin") return { name: `cloudflared-darwin-${a}.tgz`, file: "cloudflared" };
  return { name: `cloudflared-linux-${a}`, file: "cloudflared" };
}

export function cloudflaredPath(dir: string): string {
  return join(dir, cloudflaredAsset().file);
}

/** Delete a cached binary that turned out to be unusable, so the next attempt re-downloads. */
export function discardCloudflared(dir: string): void {
  const path = cloudflaredPath(dir);
  try {
    rmSync(path, { force: true });
    log(`discarded unusable cloudflared at ${path}`);
  } catch (err) {
    log(`couldn't discard cloudflared: ${String(err)}`);
  }
}

/**
 * Ensures the cloudflared binary exists in `dir`, downloading it on first use.
 * The download streams to a temp file (renamed only when complete and plausibly
 * sized), so an interrupted download can never leave a corrupt cached binary.
 */
export async function ensureCloudflared(
  dir: string,
  onProgress?: (percent: number | null) => void,
): Promise<string> {
  const { name } = cloudflaredAsset();
  const dest = cloudflaredPath(dir);
  if (existsSync(dest)) {
    const size = statSync(dest).size;
    if (size >= MIN_BINARY_BYTES) {
      log(`cloudflared present: ${dest} (${size} bytes)`);
      return dest;
    }
    log(`cloudflared at ${dest} is only ${size} bytes — re-downloading`);
    rmSync(dest, { force: true });
  }

  if (platform() === "darwin") {
    throw new Error("Automatic tunnel setup isn't supported on macOS. Install it with 'brew install cloudflared'.");
  }

  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`;
  const tmp = `${dest}.download`;
  log(`downloading cloudflared: ${url}`);

  const controller = new AbortController();
  let stallTimer = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
  const bump = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
  };

  // Set if writing to disk fails (disk full, antivirus lock); reported in preference
  // to the AbortError that aborting the download then causes.
  let writeError: Error | null = null;
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Couldn't download the tunnel helper (HTTP ${res.status}).`);
    const total = Number(res.headers.get("content-length")) || 0;

    const file = createWriteStream(tmp, { mode: 0o755 });
    file.on("error", (err) => {
      writeError = err;
      controller.abort(); // stop downloading
    });
    let received = 0;
    let lastPct = -1;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || writeError) break;
        bump();
        received += value.byteLength;
        if (!file.write(value)) {
          await new Promise<void>((r) => {
            file.once("drain", () => r());
            file.once("error", () => r());
          });
        }
        // Report each whole percent once (or once, if the size is unknown).
        const pct = total ? Math.floor((received / total) * 100) : null;
        const key = pct ?? -2;
        if (key !== lastPct) {
          lastPct = key;
          onProgress?.(pct);
        }
      }
    } finally {
      await new Promise<void>((r) => (file.destroyed ? r() : file.end(() => r())));
    }
    if (writeError) throw writeError;

    if ((total && received !== total) || received < MIN_BINARY_BYTES) {
      throw new Error("The tunnel helper download was incomplete. Check your connection and try again.");
    }
    renameSync(tmp, dest);
    log(`downloaded cloudflared -> ${dest} (${received} bytes)`);
    return dest;
  } catch (err) {
    rmSync(tmp, { force: true });
    log(`cloudflared download failed: ${err instanceof Error ? err.message : String(err)}`);
    if (writeError) {
      throw new Error(`Couldn't save the tunnel helper (${(writeError as Error).message}). Check disk space and antivirus.`);
    }
    if (controller.signal.aborted) {
      throw new Error("Downloading the tunnel helper stalled. Check your connection (GitHub must be reachable) and try again.");
    }
    throw err;
  } finally {
    clearTimeout(stallTimer);
  }
}

export interface Tunnel {
  /** Public wss:// address that proxies to the local signaling server. */
  readonly url: string;
  /** Kill the tunnel process (does not trigger onDied). */
  stop(): void;
}

/** Raised when the binary itself can't be executed (missing, quarantined, corrupt). */
export class TunnelSpawnError extends Error {}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED_RE = /registered tunnel connection/i;
const TUNNEL_TIMEOUT_MS = 30_000;
// If cloudflared prints the URL but we never see a "registered" line (e.g. a log
// format change), resolve this long after the URL anyway rather than hang.
const REGISTER_FALLBACK_MS = 6_000;

/**
 * Spawns `cloudflared tunnel --url http://127.0.0.1:<port>` and resolves with the
 * public address once cloudflared reports a registered edge connection.
 *
 * `onDied` fires if the process exits *after* the tunnel came up (the public URL
 * is then dead) — the caller decides whether to open a new one.
 */
export function startTunnel(
  bin: string,
  port: number,
  onDied: (reason: string) => void,
): Promise<Tunnel> {
  return new Promise<Tunnel>((resolve, reject) => {
    // 127.0.0.1, not localhost: Windows may resolve localhost to ::1 first, which
    // the IPv4-bound server doesn't answer.
    // --protocol http2 + --edge-ip-version 4: plain TCP/443 over IPv4 traverses far
    // more networks (VPNs, strict firewalls) than the default QUIC over UDP/7844.
    const args = [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--edge-ip-version",
      "4",
      "--url",
      `http://127.0.0.1:${port}`,
    ];
    log(`spawning: "${bin}" ${args.join(" ")}`);

    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      reject(new TunnelSpawnError(`Couldn't start the tunnel helper: ${String(err)}`));
      return;
    }

    let ready = false;
    let settled = false;
    let stopping = false;
    let url: string | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
    const finishOk = (): void => {
      if (settled || !url) return;
      settled = true;
      ready = true;
      clearTimers();
      resolve({
        url: url.replace(/^https:/, "wss:"),
        stop: () => {
          stopping = true;
          child.kill();
        },
      });
    };
    const finishErr = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      stopping = true;
      child.kill();
      reject(err);
    };

    const timer = setTimeout(
      () => finishErr(new Error("The tunnel took too long to come up. Check your internet connection and try again.")),
      TUNNEL_TIMEOUT_MS,
    );

    const scan = (buf: Buffer): void => {
      const text = String(buf);
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(`[cloudflared] ${line.trim()}`);
      if (!url) {
        const m = text.match(URL_RE);
        if (m) {
          url = m[0];
          fallbackTimer = setTimeout(finishOk, REGISTER_FALLBACK_MS);
        }
      }
      if (url && REGISTERED_RE.test(text)) finishOk();
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan); // cloudflared logs to stderr
    child.on("error", (err) => {
      log(`[cloudflared] spawn error: ${err.message}`);
      finishErr(new TunnelSpawnError(`Couldn't run the tunnel helper (${err.message}). Your antivirus may have blocked it.`));
    });
    child.on("exit", (code, signal) => {
      log(`[cloudflared] exited (code=${code ?? "?"}, signal=${signal ?? "none"})`);
      if (!settled) {
        finishErr(new Error(`The tunnel helper exited unexpectedly (code ${code ?? "?"}).`));
      } else if (ready && !stopping) {
        onDied(`exit code ${code ?? "?"}`);
      }
    });
  });
}
