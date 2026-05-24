/**
 * Kootani signaling server.
 *
 * Responsibilities:
 *  - Track rooms and their members.
 *  - Assign/transfer the host role (creator hosts; auto-transfer on host drop).
 *  - Relay WebRTC signaling between peers (never the media itself).
 *
 * State is in-memory: rooms vanish when empty. That's intentional — a room is
 * just a live gaming session, not persistent data.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, ServerMessage, PeerInfo, UserInfo } from "./protocol.js";

const PORT = Number(process.env.PORT ?? 8787);

interface Member {
  id: string;
  ws: WebSocket;
  user: UserInfo;
  isAlive: boolean;
}

interface Room {
  id: string;
  hostId: string;
  /** Insertion order matters: the oldest remaining member inherits the host role. */
  members: Map<string, Member>;
}

const rooms = new Map<string, Room>();
/** ws -> { roomId, memberId } so we can clean up on disconnect. */
const connectionIndex = new WeakMap<WebSocket, { roomId: string; memberId: string }>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function peerInfo(room: Room, member: Member): PeerInfo {
  return {
    id: member.id,
    user: member.user,
    isHost: room.hostId === member.id,
  };
}

function broadcast(room: Room, msg: ServerMessage, exceptId?: string): void {
  for (const member of room.members.values()) {
    if (member.id !== exceptId) send(member.ws, msg);
  }
}

function handleJoin(ws: WebSocket, room: string, user: UserInfo): void {
  // A connection may only be in one room at a time.
  if (connectionIndex.has(ws)) {
    send(ws, { type: "error", message: "Already in a room." });
    return;
  }

  let r = rooms.get(room);
  const memberId = randomUUID();

  if (!r) {
    r = { id: room, hostId: memberId, members: new Map() };
    rooms.set(room, r);
    console.log(`[room ${room}] created, host=${memberId} (${user.name})`);
  }

  const existingPeers: PeerInfo[] = [...r.members.values()].map((m) => peerInfo(r!, m));

  const member: Member = { id: memberId, ws, user, isAlive: true };
  r.members.set(memberId, member);
  connectionIndex.set(ws, { roomId: room, memberId });

  // Tell the newcomer who's already here (it will offer to each of them).
  send(ws, {
    type: "joined",
    selfId: memberId,
    room,
    hostId: r.hostId,
    peers: existingPeers,
  });

  // Tell everyone else that a peer arrived.
  broadcast(r, { type: "peer-joined", peer: peerInfo(r, member) }, memberId);

  console.log(`[room ${room}] +${user.name} (${memberId}) — ${r.members.size} member(s)`);
}

function handleLeave(ws: WebSocket): void {
  const entry = connectionIndex.get(ws);
  if (!entry) return;
  connectionIndex.delete(ws);

  const room = rooms.get(entry.roomId);
  if (!room) return;

  const leaving = room.members.get(entry.memberId);
  room.members.delete(entry.memberId);

  if (room.members.size === 0) {
    rooms.delete(room.id);
    console.log(`[room ${room.id}] empty — destroyed`);
    return;
  }

  // If the host left (cleanly or abruptly), promote the oldest remaining member.
  if (room.hostId === entry.memberId) {
    const next = room.members.values().next().value as Member;
    room.hostId = next.id;
    broadcast(room, { type: "host-changed", hostId: next.id });
    console.log(`[room ${room.id}] host left — promoted ${next.user.name} (${next.id})`);
  }

  broadcast(room, { type: "peer-left", peerId: entry.memberId });
  console.log(
    `[room ${room.id}] -${leaving?.user.name ?? entry.memberId} — ${room.members.size} member(s)`,
  );
}

function handleSignal(ws: WebSocket, to: string, data: unknown): void {
  const entry = connectionIndex.get(ws);
  if (!entry) return;
  const room = rooms.get(entry.roomId);
  const target = room?.members.get(to);
  if (!target) return; // peer may have just left; drop silently
  send(target.ws, { type: "signal", from: entry.memberId, data });
}

function handleTransferHost(ws: WebSocket, to: string): void {
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
  console.log(`[room ${room.id}] host transferred to ${to}`);
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`Kootani signaling server — ${rooms.size} active room(s)`);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
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
        send(ws, { type: "error", message: `Unknown message type.` });
    }
  });

  ws.on("close", () => handleLeave(ws));
  ws.on("error", () => handleLeave(ws));

  // Liveness: mark alive on pong; the interval below culls the silent.
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on("pong", () => {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  });
});

// Detect half-open connections (e.g. a laptop that slept) so host auto-transfer
// actually fires instead of leaving a ghost host.
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

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use — a Kootani server is probably already running.\n` +
        `Stop it first (close its terminal), or run with a different PORT.\n` +
        `Tip: when using "npm run host" you do NOT also need "npm run dev:server".\n`,
    );
    process.exit(1);
  }
  throw err;
});

httpServer.listen(PORT, () => {
  console.log(`Kootani signaling server listening on http://localhost:${PORT}`);
});
