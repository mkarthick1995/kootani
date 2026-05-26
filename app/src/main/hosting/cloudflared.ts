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
const TUNNEL_TIMEOUT_MS = 30_000;

/**
 * Spawns `cloudflared tunnel --url http://localhost:<port>` and resolves with
 * the public address once cloudflared prints it. Rejects on timeout or if the
 * process exits before announcing a URL.
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
    const finishOk = (httpsUrl: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        url: httpsUrl.replace(/^https:/, "wss:"),
        stop: () => child.kill(),
      });
    };
    const finishErr = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      const m = text.match(URL_RE);
      if (m) finishOk(m[0]);
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan); // cloudflared prints the URL to stderr
    child.on("error", (err) => finishErr(err));
    child.on("exit", (code) => finishErr(new Error(`The tunnel helper exited unexpectedly (code ${code ?? "?"}).`)));
  });
}
