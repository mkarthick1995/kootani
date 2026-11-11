import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { IceServer } from "../shared/protocol.js";
import { log } from "./logger.js";

export interface AppConfig {
  signalingUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Extra ICE servers (TURN relays) appended to the built-in STUN list. */
  iceServers: IceServer[];
}

interface RawConfigFile {
  signalingUrl?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  iceServers?: unknown;
  // Google's downloaded client_secret_*.json nests creds under "installed".
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
}

function readJsonIfExists(path: string): RawConfigFile | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // not there — normal
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      log(`config: loaded ${path}`);
      return parsed as RawConfigFile;
    }
  } catch (err) {
    log(`config: IGNORING ${path} — invalid JSON (${String(err)})`);
  }
  return null;
}

/** Keep only well-formed STUN/TURN entries; a typo shouldn't break every call. */
function sanitizeIceServers(raw: unknown): IceServer[] {
  if (!Array.isArray(raw)) return [];
  const out: IceServer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const urls = (Array.isArray(e.urls) ? e.urls : [e.urls]).filter(
      (u): u is string => typeof u === "string" && /^(stun|stuns|turn|turns):/i.test(u),
    );
    if (urls.length === 0) {
      log(`config: skipping ICE server with no valid stun:/turn: urls: ${JSON.stringify(e.urls)}`);
      continue;
    }
    const isTurn = urls.some((u) => /^turns?:/i.test(u));
    if (isTurn && (typeof e.username !== "string" || typeof e.credential !== "string")) {
      log(`config: skipping TURN server without username/credential: ${urls.join(", ")}`);
      continue;
    }
    out.push({
      urls: urls.length === 1 ? urls[0] : urls,
      ...(typeof e.username === "string" ? { username: e.username } : {}),
      ...(typeof e.credential === "string" ? { credential: e.credential } : {}),
    });
  }
  return out;
}

/**
 * Resolves config from (in priority order): env vars, then the user's own
 * `%APPDATA%\Kootani\kootani.config.json` (lets a host add TURN servers without
 * rebuilding), then the bundled/dev `kootani.config.json`. The loader also
 * accepts Google's downloaded `client_secret_*.json` verbatim.
 */
export function loadConfig(): AppConfig {
  const bundledCandidates = [
    join(app.getAppPath(), "kootani.config.json"),
    join(process.cwd(), "kootani.config.json"),
    process.resourcesPath ? join(process.resourcesPath, "kootani.config.json") : "",
  ].filter(Boolean);

  let bundled: RawConfigFile | null = null;
  for (const path of bundledCandidates) {
    bundled = readJsonIfExists(path);
    if (bundled) break;
  }
  const user = readJsonIfExists(join(app.getPath("userData"), "kootani.config.json"));
  const file: RawConfigFile = { ...bundled, ...user };
  const google = file.installed ?? file.web;

  const iceServers = sanitizeIceServers(file.iceServers);
  log(`config: ${iceServers.length} extra ICE server(s) configured`);

  return {
    signalingUrl: process.env.KOOTANI_SIGNALING_URL ?? file.signalingUrl ?? "ws://localhost:8787",
    googleClientId: process.env.KOOTANI_GOOGLE_CLIENT_ID ?? file.googleClientId ?? google?.client_id ?? "",
    googleClientSecret:
      process.env.KOOTANI_GOOGLE_CLIENT_SECRET ?? file.googleClientSecret ?? google?.client_secret ?? "",
    iceServers,
  };
}
