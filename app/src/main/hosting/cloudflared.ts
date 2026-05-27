/**
 * cloudflared — download and run a free Cloudflare "quick tunnel" so the
 * in-process signaling server (on localhost) is reachable by friends anywhere.
 *
 * This is the runtime counterpart of `scripts/host.mjs`, adapted for the
 * packaged app: the binary is cached under the app's userData dir (writable in
 * an installed build) rather than the repo's `.cache/`.
 *
 * Quick tunnels need no Cloudflare account and no credit card. The trade-off is
 * a random URL per run — fine for on-demand game nights.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:os";
import { hostLog } from "./logger.js";

function cloudflaredAsset(): { name: string; file: string } {
  const a = arch() === "arm64" ? "arm64" : "amd64";
  if (platform() === "win32") return { name: `cloudflared-windows-${a}.exe`, file: "cloudflared.exe" };
  if (platform() === "darwin") return { name: `cloudflared-darwin-${a}.tgz`, file: "cloudflared" };
  return { name: `cloudflared-linux-${a}`, file: "cloudflared" };
}

/**
 * Ensures the cloudflared binary exists in `dir`, downloading it on first use.
 * Returns the absolute path to the executable.
 */
export async function ensureCloudflared(dir: string): Promise<string> {
  const { name, file } = cloudflaredAsset();
  const dest = join(dir, file);
  if (existsSync(dest)) {
    hostLog(`cloudflared already present: ${dest} (${statSync(dest).size} bytes)`);
    return dest;
  }

  if (platform() === "darwin") {
    // The macOS asset is a .tgz; we only officially support a Windows host, so
    // keep this path simple and fail loudly rather than shipping a tar extractor.
    throw new Error("Automatic cloudflared download isn't supported on macOS. Install it with 'brew install cloudflared'.");
  }

  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`;
  hostLog(`downloading cloudflared: ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Couldn't download the tunnel helper (HTTP ${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, bytes, { mode: 0o755 });
  hostLog(`downloaded cloudflared -> ${dest} (${bytes.length} bytes)`);
  return dest;
}

export interface Tunnel {
  /** Public wss:// address that proxies to the local signaling server. */
  readonly url: string;
  /** Kill the tunnel process. */
  stop(): void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED_RE = /registered tunnel connection/i;
const TUNNEL_TIMEOUT_MS = 30_000;
// If cloudflared prints the URL but we never see a "registered" line (e.g. a log
// format change), resolve this long after the URL anyway rather than hang.
const REGISTER_FALLBACK_MS = 6_000;

/**
 * Spawns `cloudflared tunnel --url http://127.0.0.1:<port>` and resolves with the
 * public address once the tunnel is actually routable.
 *
 * cloudflared prints the URL in its startup banner *before* it has registered an
 * edge connection — connecting at that instant fails. So we capture the URL but
 * only resolve once cloudflared logs that a tunnel connection is registered (with
 * a time-based fallback). Rejects on timeout or if the process exits early.
 */
export function startTunnel(bin: string, port: number, onLog?: (line: string) => void): Promise<Tunnel> {
  return new Promise<Tunnel>((resolve, reject) => {
    // Use 127.0.0.1, not localhost: the server binds to IPv4 loopback, and on
    // Windows "localhost" can resolve to ::1 (IPv6) first, which cloudflared
    // then fails to reach.
    //
    // --protocol http2 + --edge-ip-version 4: cloudflared defaults to QUIC over
    // UDP/7844, which restrictive home/office networks and some VPN adapters drop.
    // HTTP/2 runs over plain TCP/443 (and IPv4 only), which traverses far more
    // networks unchanged — important when friends connect from arbitrary ISPs. A
    // reachability probe confirmed an http2 quick tunnel serves an external network
    // end-to-end, so this is a proven-good configuration.
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
    hostLog(`spawning: "${bin}" ${args.join(" ")}`);
    const child: ChildProcess = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let settled = false;
    let url: string | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const finishOk = (): void => {
      if (settled || !url) return;
      settled = true;
      clearTimeout(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      resolve({
        url: url.replace(/^https:/, "wss:"),
        stop: () => child.kill(),
      });
    };
    const finishErr = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      child.kill();
      reject(err);
    };

    const timer = setTimeout(
      () => finishErr(new Error("The tunnel took too long to come up. Check your internet connection and try again.")),
      TUNNEL_TIMEOUT_MS,
    );

    const scan = (buf: Buffer): void => {
      const text = String(buf);
      onLog?.(text.trim());
      if (!url) {
        const m = text.match(URL_RE);
        if (m) {
          url = m[0];
          // Safety net in case the "registered" line never matches.
          fallbackTimer = setTimeout(finishOk, REGISTER_FALLBACK_MS);
        }
      }
      // The tunnel is only routable once an edge connection is registered.
      if (url && REGISTERED_RE.test(text)) finishOk();
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan); // cloudflared prints the URL to stderr
    child.on("error", (err) => finishErr(err));
    child.on("exit", (code, signal) => {
      // If this fires AFTER we've resolved, the tunnel died mid-session — the
      // process is gone, so the public URL goes dead. Log it either way.
      hostLog(`[cloudflared] process exited (code=${code ?? "?"}, signal=${signal ?? "none"})`);
      finishErr(new Error(`The tunnel helper exited unexpectedly (code ${code ?? "?"}).`));
    });
  });
}
