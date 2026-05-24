/**
 * `npm run host` — turn this PC into the Kootani backend, on demand.
 *
 * It (1) makes sure cloudflared is available, (2) starts the signaling server,
 * (3) opens a free Cloudflare quick tunnel so friends can reach it from
 * anywhere, and (4) prints the public wss:// address to paste into the app's
 * "server address" field. Ctrl+C tears both down. No account, no card, no cost.
 *
 * The tunnel address is random and changes each run — that's the price of free.
 * Host a room in the app with this address, then share the room's "join link".
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT ?? "8787";
const CACHE = join(ROOT, ".cache");

function cloudflaredAsset() {
  if (platform() !== "win32") {
    // The friend running the backend is on Windows; other platforms are a bonus.
    const os = platform() === "darwin" ? "darwin" : "linux";
    const a = arch() === "arm64" ? "arm64" : "amd64";
    return { name: `cloudflared-${os}-${a}`, file: "cloudflared" };
  }
  const a = arch() === "arm64" ? "arm64" : "amd64";
  return { name: `cloudflared-windows-${a}.exe`, file: "cloudflared.exe" };
}

async function ensureCloudflared() {
  const { name, file } = cloudflaredAsset();
  const dest = join(CACHE, file);
  if (existsSync(dest)) return dest;

  mkdirSync(CACHE, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`;
  console.log(`Downloading cloudflared (first run only)…\n  ${url}`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  console.log("cloudflared ready.\n");
  return dest;
}

function startServer() {
  console.log(`Starting Kootani signaling server on :${PORT} …`);
  const child = spawn(process.execPath, ["--import", "tsx", "server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return child;
}

function startTunnel(bin) {
  const child = spawn(
    bin,
    ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  let announced = false;
  const scan = (buf) => {
    const m = String(buf).match(urlRe);
    if (m && !announced) {
      announced = true;
      const wss = m[0].replace(/^https:/, "wss:");
      console.log(
        "\n" +
          "════════════════════════════════════════════════════════════\n" +
          "  ✅  Kootani backend is LIVE\n\n" +
          "  Paste this into the app's “Your server address” field,\n" +
          "  then click “Host a new room”:\n\n" +
          `      ${wss}\n\n` +
          "  After hosting, click “Copy join link” and send it to your\n" +
          "  friends. Keep this window open while you play; Ctrl+C ends it.\n" +
          "════════════════════════════════════════════════════════════\n",
      );
    }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);
  return child;
}

async function main() {
  const bin = await ensureCloudflared();
  const server = startServer();
  const tunnel = startTunnel(bin);

  const shutdown = () => {
    server.kill();
    tunnel.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("exit", shutdown);
  tunnel.on("exit", shutdown);
}

main().catch((err) => {
  console.error("\nCouldn't start the host backend:", err.message);
  console.error(
    "If the cloudflared download failed, install it manually " +
      "(winget install Cloudflare.cloudflared) and re-run.",
  );
  process.exit(1);
});
