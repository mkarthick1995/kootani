/**
 * Standalone Kootani signaling server (development / bring-your-own-server).
 *
 * The room/host/relay logic lives in ./signaling.ts and is shared with the server
 * embedded in the desktop app, so the two can't drift.
 *
 *   PORT=8787 HOST=0.0.0.0 npm run dev --workspace server
 */
import { createSignalingServer } from "./signaling.js";

const PORT = Number(process.env.PORT ?? 8787);
// All interfaces, IPv4 + IPv6 ("::" is dual-stack), so LAN testing works and
// "localhost" reaches it whichever family it resolves to. The tunnel only needs
// loopback: `HOST=127.0.0.1` is the tighter choice for `npm run host`.
const HOST = process.env.HOST ?? "::";

createSignalingServer({
  port: PORT,
  host: HOST,
  log: (line) => console.log(line),
})
  .then((server) => {
    console.log(`Kootani signaling server listening on http://localhost:${server.port}`);
    const shutdown = (): void => {
      void server.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\nPort ${PORT} is already in use — a Kootani server is probably already running.\n` +
          `Stop it first (close its terminal), or run with a different PORT.\n` +
          `Tip: when using "npm run host" you do NOT also need "npm run dev:server".\n`,
      );
    } else {
      console.error("Couldn't start the signaling server:", err.message);
    }
    process.exit(1);
  });
