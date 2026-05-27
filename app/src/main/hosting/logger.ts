/**
 * Hosting diagnostics log.
 *
 * Everything about a host session — the signaling server, the cloudflared
 * process's own output, and the renderer's connection attempts — is funnelled
 * into a single timestamped file so a failed session can be diagnosed after the
 * fact (no devtools needed in the packaged app).
 *
 * File: <userData>/kootani-host.log
 * On Windows that's: %APPDATA%\@kootani\app\kootani-host.log
 *
 * The file is truncated at the start of each host attempt (startLogSession) so
 * it always reflects the most recent run.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

function logFile(): string {
  return join(app.getPath("userData"), "kootani-host.log");
}

/** Absolute path to the log file (handy to print / point a user at). */
export function hostLogPath(): string {
  return logFile();
}

/** Truncate the log and write a session banner. Call when a host attempt begins. */
export function startLogSession(): void {
  try {
    writeFileSync(
      logFile(),
      `[${new Date().toISOString()}] ═══ Kootani host session start ═══\n` +
        `[${new Date().toISOString()}] platform=${process.platform} arch=${process.arch} electron=${process.versions.electron}\n`,
    );
  } catch {
    /* logging must never throw */
  }
}

/** Append one timestamped line to the host log (and echo to the console). */
export function hostLog(line: string): void {
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  try {
    appendFileSync(logFile(), entry);
  } catch {
    /* logging must never throw */
  }
  // Also visible in the dev terminal / when run with a console.
  console.log("[host]", line);
}
