/**
 * Embedded Kootani signaling server.
 *
 * Same room / host / relay logic as `server/src/index.ts`, but factored as a
 * function so the desktop app can run the signaling server IN-PROCESS — that's
 * what makes "Host a new room" a single click (no separate `npm run host`).
 * Keep this in sync with `server/src/index.ts`; the protocol is small and stable.
 *
 * Binds to 127.0.0.1 only — the Cloudflare tunnel reaches it via localhost, so
 * the server is never directly exposed on the LAN or the internet.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, ServerMessage, PeerInfo, UserInfo } from "../../shared/protocol.js";
import { hostLog } from "./logger.js";

export interface SignalingHandle {
  /** The actual port the server bound to (we ask the OS for a free one). */
  readonly port: number;
  /** Stop accepting connections and free the port. */
  close(): Promise<void>;
}

interface Member {
  id: string;
  ws: WebSocket;
  user: UserInfo;
}

interface Room {
  id: string;
  hostId: string;
  /** Insertion order matters: the oldest remaining member inherits the host role. */
  members: Map<string, Member>;
}

/**
 * Starts a signaling server on `127.0.0.1:<preferredPort>`. Pass 0 (the default)
 * to let the OS pick a free port — avoids the EADDRINUSE problems that plagued
 * the fixed-port `npm run host` flow. Resolves once it's listening.
 */
export function createSignalingServer(preferredPort = 0): Promise<SignalingHandle> {
  const rooms = new Map<string, Room>();
  const connectionIndex = new WeakMap<WebSocket, { roomId: string; memberId: string }>();

  const send = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const peerInfo = (room: Room, member: Member): PeerInfo => ({
    id: member.id,
    user: member.user,
    isHost: room.hostId === member.id,
  });

  const broadcast = (room: Room, msg: ServerMessage, exceptId?: string): void => {
    for (const member of room.members.values()) {
      if (member.id !== exceptId) send(member.ws, msg);
    }
  };

  const handleJoin = (ws: WebSocket, roomId: string, user: UserInfo): void => {
    if (connectionIndex.has(ws)) {
      send(ws, { type: "error", message: "Already in a room." });
      return;
    }

    let room = rooms.get(roomId);
    const memberId = randomUUID();

    if (!room) {
      room = { id: roomId, hostId: memberId, members: new Map() };
      rooms.set(roomId, room);
    }

    const existingPeers = [...room.members.values()].map((m) => peerInfo(room!, m));
    const member: Member = { id: memberId, ws, user };
    room.members.set(memberId, member);
    connectionIndex.set(ws, { roomId, memberId });

    // Tell the newcomer who's already here (it offers to each of them).
    send(ws, { type: "joined", selfId: memberId, room: roomId, hostId: room.hostId, peers: existingPeers });
    // Tell everyone else a peer arrived.
    broadcast(room, { type: "peer-joined", peer: peerInfo(room, member) }, memberId);
  };

  const handleLeave = (ws: WebSocket): void => {
    const entry = connectionIndex.get(ws);
    if (!entry) return;
    connectionIndex.delete(ws);

    const room = rooms.get(entry.roomId);
    if (!room) return;

    room.members.delete(entry.memberId);

    if (room.members.size === 0) {
      rooms.delete(room.id);
      return;
    }

    // Host gone (cleanly or abruptly): promote the oldest remaining member.
    if (room.hostId === entry.memberId) {
      const next = room.members.values().next().value as Member;
      room.hostId = next.id;
      broadcast(room, { type: "host-changed", hostId: next.id });
    }

    broadcast(room, { type: "peer-left", peerId: entry.memberId });
  };

  const handleSignal = (ws: WebSocket, to: string, data: unknown): void => {
    const entry = connectionIndex.get(ws);
    if (!entry) return;
    const target = rooms.get(entry.roomId)?.members.get(to);
    if (!target) return; // peer may have just left; drop silently
    send(target.ws, { type: "signal", from: entry.memberId, data });
  };

  const handleTransferHost = (ws: WebSocket, to: string): void => {
    const entry = connectionIndex.get(ws);
    if (!entry) return;
    const room = rooms.get(entry.roomId);
    if (!room) return;

    if (room.hostId !== entry.memberId) {
      send(ws, { type: "error", message: "Only the host can transfer the host role." });
      return;
    }
    if (!room.members.has(to)) {
      send(ws, { type: "error", message: "Target peer is not in the room." });
      return;
    }
    room.hostId = to;
    broadcast(room, { type: "host-changed", hostId: to });
  };

  const httpServer = createServer((req, res) => {
    // Logged so we can see plain HTTP requests (e.g. a browser/health hit)
    // actually arriving through the tunnel.
    hostLog(`[server] HTTP ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`Kootani signaling server — ${rooms.size} active room(s)`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Passive upgrade logger: fires for EVERY WebSocket upgrade attempt that
  // reaches the origin (ws attaches its own upgrade handler separately). If a
  // client says it's "connecting" but nothing shows up here, the request never
  // made it through the tunnel — i.e. the edge isn't routing to us.
  httpServer.on("upgrade", (req) => {
    hostLog(`[server] WS upgrade attempt ${req.url} from ${req.socket.remoteAddress}`);
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    hostLog(`[server] WS connection established from ${req.socket.remoteAddress}`);
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "Malformed message (invalid JSON)." });
        return;
      }
      switch (msg.type) {
        case "join":
          handleJoin(ws, msg.room, msg.user);
          break;
        case "leave":
          handleLeave(ws);
          break;
        case "signal":
          handleSignal(ws, msg.to, msg.data);
          break;
        case "transfer-host":
          handleTransferHost(ws, msg.to);
          break;
        case "ping":
          send(ws, { type: "pong" });
          break;
        default:
          send(ws, { type: "error", message: "Unknown message type." });
      }
    });

    ws.on("close", () => handleLeave(ws));
    ws.on("error", () => handleLeave(ws));

    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on("pong", () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
  });

  // Cull half-open connections (e.g. a slept laptop) so host auto-transfer fires.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const sock = ws as WebSocket & { isAlive?: boolean };
      if (sock.isAlive === false) {
        ws.terminate();
        continue;
      }
      sock.isAlive = false;
      ws.ping();
    }
  }, 15_000);
  wss.on("close", () => clearInterval(heartbeat));

  return new Promise<SignalingHandle>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(preferredPort, "127.0.0.1", () => {
      httpServer.removeListener("error", onError);
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : preferredPort;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
  });
}
