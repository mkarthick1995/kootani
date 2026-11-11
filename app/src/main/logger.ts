/**
 * App diagnostics log.
 *
 * Everything — hosting (signaling server + cloudflared output), and the
 * renderer's connection/WebRTC events — goes to one timestamped file, so a
 * friend's problem can be diagnosed after the fact without devtools: they click
 * "Open logs" and send the file.
 *
 * File: <userData>/kootani.log  (packaged: %APPDATA%\Kootani\kootani.log)
 * Rotated to kootani.old.log once it passes MAX_BYTES, so it never grows unbounded.
 */
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

const MAX_BYTES = 2 * 1024 * 1024;
const CHECK_EVERY = 200; // writes between size checks

let writes = 0;

export function logPath(): string {
  return join(app.getPath("userData"), "kootani.log");
}

function rotateIfLarge(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, join(app.getPath("userData"), "kootani.old.log"));
    }
  } catch {
    /* logging must never throw */
  }
}

/** Append one timestamped line (and echo to the console in dev). */
export function log(line: string): void {
  const file = logPath();
  if (writes++ % CHECK_EVERY === 0) rotateIfLarge(file);
  try {
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never throw */
  }
  if (!app.isPackaged) console.log("[kootani]", line);
}

/** Write a banner marking an app launch, with the facts every bug report needs. */
export function logBanner(): void {
  log(
    `═══ Kootani ${app.getVersion()} start — platform=${process.platform} arch=${process.arch} ` +
      `electron=${process.versions.electron} packaged=${app.isPackaged}`,
  );
}
