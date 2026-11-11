/**
 * Embedded Kootani signaling server.
 *
 * The desktop app runs the exact same signaling core as the standalone server
 * (`server/src/signaling.ts`) in-process — that's what makes "Host a new room"
 * a single click. This wrapper only wires in the app's logger and the hosting
 * policy (loopback-only, one room per hosting session, shared TURN servers).
 */
import { createSignalingServer as createCore, type SignalingHandle } from "../../../../server/src/signaling";
import type { IceServer } from "../../shared/protocol.js";
import { log } from "../logger.js";

export type { SignalingHandle };

export function createSignalingServer(iceServers: IceServer[]): Promise<SignalingHandle> {
  return createCore({
    port: 0, // OS-assigned: can never collide (no more EADDRINUSE)
    host: "127.0.0.1", // reached only through the tunnel, never the LAN
    lockToFirstRoom: true,
    iceServers,
    log,
  });
}
