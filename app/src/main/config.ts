import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

export interface AppConfig {
  signalingUrl: string;
  googleClientId: string;
  googleClientSecret: string;
}

interface RawConfigFile {
  signalingUrl?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  // Google's downloaded client_secret_*.json nests creds under "installed".
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
}

function readJsonIfExists(path: string): RawConfigFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawConfigFile;
  } catch {
    return null;
  }
}

/**
 * Resolves config from (in priority order): env vars, then a local
 * `kootani.config.json`. The file is gitignored in dev; at packaging time it
 * gets bundled so friends never touch credentials. The loader also accepts
 * Google's downloaded `client_secret_*.json` verbatim (its "installed" block).
 */
export function loadConfig(): AppConfig {
  const candidates = [
    join(app.getAppPath(), "kootani.config.json"),
    join(process.cwd(), "kootani.config.json"),
    process.resourcesPath ? join(process.resourcesPath, "kootani.config.json") : "",
  ].filter(Boolean);

  let file: RawConfigFile | null = null;
  for (const path of candidates) {
    file = readJsonIfExists(path);
    if (file) break;
  }

  const google = file?.installed ?? file?.web;

  return {
    signalingUrl: process.env.KOOTANI_SIGNALING_URL ?? file?.signalingUrl ?? "ws://localhost:8787",
    googleClientId:
      process.env.KOOTANI_GOOGLE_CLIENT_ID ?? file?.googleClientId ?? google?.client_id ?? "",
    googleClientSecret:
      process.env.KOOTANI_GOOGLE_CLIENT_SECRET ??
      file?.googleClientSecret ??
      google?.client_secret ??
      "",
  };
}
