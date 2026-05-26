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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:os";
import { get as httpsGet } from "node:https";

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
  if (existsSync(dest)) return dest;

  if (platform() === "darwin") {
    // The macOS asset is a .tgz; we only officially support a Windows host, so
    // keep this path simple and fail loudly rather than shipping a tar extractor.
    throw new Error("Automatic cloudflared download isn't supported on macOS. Install it with 'brew install cloudflared'.");
  }

  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Couldn't download the tunnel helper (HTTP ${res.status}).`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
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
    const child: ChildProcess = spawn(
      bin,
      // Use 127.0.0.1, not localhost: the server binds to IPv4 loopback, and on
      // Windows "localhost" can resolve to ::1 (IPv6) first, which cloudflared
      // then fails to reach.
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

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
    child.on("exit", (code) => finishErr(new Error(`The tunnel helper exited unexpectedly (code ${code ?? "?"}).`)));
  });
}

const ROUTABLE_TIMEOUT_MS = 45_000;
const ROUTABLE_POLL_MS = 1_500;

/**
 * cloudflared reports a connection "registered" before Cloudflare's edge has
 * actually published a route to it — so a client that connects immediately gets
 * a refused/reset socket (WebSocket close code 1006). This polls the tunnel's
 * own /health endpoint until it genuinely serves the local server, so we only
 * hand the URL to the UI once it's truly usable. Rejects after a timeout.
 */
export function waitUntilRoutable(wssUrl: string, onLog?: (line: string) => void): Promise<void> {
  const healthUrl = wssUrl.replace(/^wss:/, "https:") + "/health";
  const deadline = Date.now() + ROUTABLE_TIMEOUT_MS;

  return new Promise<void>((resolve, reject) => {
    let tries = 0;

    const attempt = (): void => {
      tries++;
      const req = httpsGet(healthUrl, { timeout: 6000 }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode === 200 && body.includes("Kootani")) resolve();
          else retry(`status ${res.statusCode}`);
        });
      });
      req.on("error", (e) => retry(e.message));
      req.on("timeout", () => {
        req.destroy();
        retry("request timeout");
      });
    };

    const retry = (why: string): void => {
      if (Date.now() >= deadline) {
        reject(new Error("The tunnel didn't come online in time. Please try hosting again."));
        return;
      }
      onLog?.(`tunnel not routable yet (try ${tries}: ${why})`);
      setTimeout(attempt, ROUTABLE_POLL_MS);
    };

    attempt();
  });
}
