/**
 * Kootani signaling core — used by BOTH the standalone server (`server/src/index.ts`)
 * and the server embedded in the desktop app (`app/src/main/hosting/signaling.ts`).
 * One implementation, so they can't drift.
 *
 * Responsibilities:
 *  - Track rooms and members; assign/transfer the host role.
 *  - Relay WebRTC signaling between peers (never media).
 *  - Hold a disconnected member's seat for a grace period so a signaling blip
 *    (Wi-Fi hiccup, tunnel reconnect, sleep/wake) doesn't end their call.
 *  - Treat every inbound message as untrusted: the server is reachable from the
 *    public internet through the tunnel, so malformed input must never throw.
 *
 * State is in-memory and ephemeral — a room is a live session, not data.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  LIMITS,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ErrorCode,
  type IceServer,
  type PeerInfo,
  type ServerMessage,
  type UserInfo,
} from "./protocol.js";

export interface SignalingOptions {
  /** Port to listen on; 0 (default) lets the OS pick a free one. */
  port?: number;
  /** Interface to bind; default 127.0.0.1 (reached via the tunnel, never the LAN). */
  host?: string;
  /** Diagnostics sink. */
  log?: (line: string) => void;
  /** ICE servers (e.g. TURN) to hand every client in `joined`. */
  iceServers?: IceServer[];
  /**
   * Only allow the first room ever created on this server. The in-app host runs
   * one room per session; locking stops strangers who find the public tunnel URL
   * from using the host's PC as a free relay for their own rooms.
   */
  lockToFirstRoom?: boolean;
  /** How long a disconnected member's seat is held (ms). */
  graceMs?: number;
  /** Protocol-level ping interval used to cull half-open sockets (ms). */
  heartbeatMs?: number;
  /** Max members per room. */
  maxMembers?: number;
}

export interface SignalingStats {
  rooms: number;
  /** Members across all rooms (including ones in their grace period). */
  members: number;
}

export interface SignalingHandle {
  /** The actual port the server bound to. */
  readonly port: number;
  stats(): SignalingStats;
  /** Stop accepting connections and free the port. */
  close(): Promise<void>;
}

interface Member {
  id: string;
  token: string;
  user: UserInfo;
  /** null while away (socket dropped, seat held for the grace period). */
  ws: WebSocket | null;
  /** Messages that arrived while away; flushed on resume. */
  queue: ServerMessage[];
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface Room {
  id: string;
  hostId: string;
  /** Insertion order matters: the oldest remaining member inherits the host role. */
  members: Map<string, Member>;
}

/** WebSocket frames larger than this are rejected (SDP for a busy peer is ~20 KB). */
const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Per-member cap on messages queued while away; oldest are dropped beyond it. */
const MAX_QUEUE = 1000;
const ROOM_RE = /^[A-Za-z0-9_-]+$/;

class BadRequest extends Error {}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Validate and normalize a client-supplied identity. */
function sanitizeUser(raw: unknown): UserInfo {
  if (!raw || typeof raw !== "object") throw new BadRequest("Missing user.");
  const u = raw as Record<string, unknown>;
  const name = str(u.name, LIMITS.maxNameLength);
  if (!name) throw new BadRequest("A display name is required.");
  const email = str(u.email, 254);
  const pictureRaw = str(u.picture, 2048);
  const picture = pictureRaw && /^https:\/\//i.test(pictureRaw) ? pictureRaw : undefined;
  return { name, ...(email ? { email } : {}), ...(picture ? { picture } : {}) };
}

function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createSignalingServer(options: SignalingOptions = {}): Promise<SignalingHandle> {
  const log = options.log ?? (() => {});
  const graceMs = options.graceMs ?? 60_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxMembers = options.maxMembers ?? LIMITS.maxMembers;
  const iceServers = options.iceServers?.length ? options.iceServers : undefined;

  const rooms = new Map<string, Room>();
  let closing = false;
  let lockedRoom: string | null = null;
  /** socket -> its seat. A socket is in at most one room. */
  const seats = new WeakMap<WebSocket, { room: Room; member: Member }>();

  const rawSend = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  /** Deliver to a member, queueing while they're away. */
  const deliver = (member: Member, msg: ServerMessage): void => {
    if (member.ws) {
      rawSend(member.ws, msg);
      return;
    }
    member.queue.push(msg);
    if (member.queue.length > MAX_QUEUE) member.queue.shift();
  };

  const broadcast = (room: Room, msg: ServerMessage, exceptId?: string): void => {
    for (const m of room.members.values()) if (m.id !== exceptId) deliver(m, msg);
  };

  const error = (ws: WebSocket, message: string, code: ErrorCode, fatal = false): void => {
    rawSend(ws, { type: "error", message, code, ...(fatal ? { fatal: true } : {}) });
  };

  const peerInfo = (room: Room, m: Member): PeerInfo => ({
    id: m.id,
    user: m.user,
    isHost: room.hostId === m.id,
    ...(m.ws ? {} : { away: true }),
  });

  const joinedFor = (room: Room, m: Member, resumed: boolean): ServerMessage => ({
    type: "joined",
    selfId: m.id,
    room: room.id,
    hostId: room.hostId,
    peers: [...room.members.values()].filter((o) => o.id !== m.id).map((o) => peerInfo(room, o)),
    token: m.token,
    resumed,
    ...(iceServers ? { iceServers } : {}),
  });

  /** Remove a member for good (clean leave, or grace period expired). */
  const removeMember = (room: Room, member: Member, reason: string): void => {
    if (member.graceTimer) clearTimeout(member.graceTimer);
    member.graceTimer = null;
    if (!room.members.delete(member.id)) return;
    log(`[server] ${member.user.name} (${member.id.slice(0, 8)}) left room ${room.id}: ${reason}`);

    if (room.members.size === 0) {
      rooms.delete(room.id);
      return;
    }
    // Host gone: promote the oldest member who is actually connected (falling
    // back to the oldest at all), so the role doesn't land on a ghost.
    if (room.hostId === member.id) {
      const members = [...room.members.values()];
      const next = members.find((m) => m.ws) ?? members[0];
      room.hostId = next.id;
      broadcast(room, { type: "host-changed", hostId: next.id });
    }
    broadcast(room, { type: "peer-left", peerId: member.id });
  };

  const handleJoin = (ws: WebSocket, msg: Record<string, unknown>): void => {
    if (seats.has(ws)) {
      error(ws, "Already in a room.", "already-joined");
      return;
    }
    const version = typeof msg.version === "number" ? msg.version : 1;
    if (version < MIN_PROTOCOL_VERSION) {
      error(
        ws,
        "Your copy of Kootani is out of date and can't join this room. Ask the host for the latest version.",
        "outdated-client",
        true,
      );
      ws.close(4000, "outdated client");
      return;
    }
    const roomId = str(msg.room, LIMITS.maxRoomLength);
    if (!roomId || !ROOM_RE.test(roomId)) throw new BadRequest("Invalid room code.");
    const user = sanitizeUser(msg.user);

    // Resume: reclaim a seat held since a disconnect.
    const resume = msg.resume as { memberId?: unknown; token?: unknown } | undefined;
    if (resume && typeof resume.memberId === "string" && typeof resume.token === "string") {
      const room = rooms.get(roomId);
      const member = room?.members.get(resume.memberId);
      if (room && member && sameSecret(member.token, resume.token)) {
        if (member.graceTimer) clearTimeout(member.graceTimer);
        member.graceTimer = null;
        const wasAway = member.ws === null;
        if (member.ws && member.ws !== ws) {
          // The old socket is half-open (we haven't noticed it die yet); retire it.
          const old = member.ws;
          seats.delete(old);
          old.terminate();
        }
        member.ws = ws;
        member.user = user;
        seats.set(ws, { room, member });
        rawSend(ws, joinedFor(room, member, true));
        const queued = member.queue.splice(0);
        for (const q of queued) rawSend(ws, q);
        if (wasAway) broadcast(room, { type: "peer-status", peerId: member.id, away: false }, member.id);
        log(`[server] ${user.name} resumed in room ${roomId} (${queued.length} queued message(s))`);
        return;
      }
      // Seat expired — fall through to a fresh join (the client rebuilds its peers).
      log(`[server] resume for room ${roomId} failed (seat expired); joining fresh`);
    }

    let room = rooms.get(roomId);
    if (!room) {
      if (options.lockToFirstRoom && lockedRoom !== null && lockedRoom !== roomId) {
        error(ws, "That room doesn't exist on this server. Check the invite link.", "no-such-room", true);
        ws.close(4004, "no such room");
        return;
      }
      lockedRoom ??= roomId;
    } else if (room.members.size >= maxMembers) {
      error(ws, `This room is full (max ${maxMembers} people).`, "room-full", true);
      ws.close(4003, "room full");
      return;
    }

    const member: Member = {
      id: randomUUID(),
      token: randomBytes(24).toString("base64url"),
      user,
      ws,
      queue: [],
      graceTimer: null,
    };
    if (!room) {
      room = { id: roomId, hostId: member.id, members: new Map() };
      rooms.set(roomId, room);
    }
    room.members.set(member.id, member);
    seats.set(ws, { room, member });
    rawSend(ws, joinedFor(room, member, false));
    broadcast(room, { type: "peer-joined", peer: peerInfo(room, member) }, member.id);
    log(`[server] ${user.name} (${member.id.slice(0, 8)}) joined room ${roomId} — ${room.members.size} member(s)`);
  };

  /** Socket gone without a `leave`: hold the seat for the grace period. */
  const handleDrop = (ws: WebSocket): void => {
    const seat = seats.get(ws);
    if (!seat || closing) return;
    seats.delete(ws);
    const { room, member } = seat;
    if (member.ws !== ws) return; // already replaced by a resume
    member.ws = null;
    log(`[server] ${member.user.name} disconnected; holding seat ${Math.round(graceMs / 1000)}s`);
    broadcast(room, { type: "peer-status", peerId: member.id, away: true }, member.id);
    member.graceTimer = setTimeout(() => removeMember(room, member, "did not reconnect"), graceMs);
  };

  const handleMessage = (ws: WebSocket, raw: RawData): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      throw new BadRequest("Malformed message (invalid JSON).");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BadRequest("Malformed message.");
    }
    const msg = parsed as Record<string, unknown>;

    switch (msg.type) {
      case "join":
        handleJoin(ws, msg);
        return;
      case "ping":
        rawSend(ws, { type: "pong" });
        return;
    }

    const seat = seats.get(ws);
    switch (msg.type) {
      case "leave":
        if (seat) {
          seats.delete(ws);
          seat.member.ws = null;
          removeMember(seat.room, seat.member, "left");
        }
        return;
      case "signal": {
        if (!seat) return;
        if (typeof msg.to !== "string") throw new BadRequest("Invalid signal target.");
        const target = seat.room.members.get(msg.to);
        // Target may have just left; drop silently.
        if (target) deliver(target, { type: "signal", from: seat.member.id, data: msg.data });
        return;
      }
      case "transfer-host": {
        if (!seat) return;
        const { room, member } = seat;
        if (room.hostId !== member.id) {
          error(ws, "Only the host can transfer the host role.", "not-host");
          return;
        }
        if (typeof msg.to !== "string" || !room.members.has(msg.to)) {
          error(ws, "That person is no longer in the room.", "no-such-peer");
          return;
        }
        room.hostId = msg.to;
        broadcast(room, { type: "host-changed", hostId: msg.to });
        return;
      }
      default:
        throw new BadRequest("Unknown message type.");
    }
  };

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "kootani", protocol: PROTOCOL_VERSION, rooms: rooms.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws, req) => {
    const via = req.headers["cf-connecting-ip"] ? "tunnel" : req.socket.remoteAddress;
    log(`[server] connection (${via})`);
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    ws.on("message", (raw) => {
      alive.add(ws); // any traffic proves liveness
      try {
        handleMessage(ws, raw);
      } catch (err) {
        if (err instanceof BadRequest) {
          error(ws, err.message, "bad-request");
        } else {
          // A bug, not bad input — never let it take the process down.
          log(`[server] internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
    });
    ws.on("close", () => handleDrop(ws));
    ws.on("error", (err) => log(`[server] socket error: ${err.message}`));
  });

  // Cull half-open sockets (e.g. a laptop that slept) so their seat enters the
  // grace period and, if they never return, host auto-transfer actually fires.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      try {
        ws.ping();
      } catch {
        /* socket already closing */
      }
    }
  }, heartbeatMs);

  return new Promise<SignalingHandle>((resolve, reject) => {
    const onError = (err: Error): void => {
      clearInterval(heartbeat);
      reject(err);
    };
    httpServer.once("error", onError);
    httpServer.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      httpServer.removeListener("error", onError);
      httpServer.on("error", (err) => log(`[server] http error: ${err.message}`));
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : (options.port ?? 0);
      resolve({
        port,
        stats: () => {
          let members = 0;
          for (const r of rooms.values()) members += r.members.size;
          return { rooms: rooms.size, members };
        },
        close: () =>
          new Promise<void>((done) => {
            closing = true;
            clearInterval(heartbeat);
            for (const room of rooms.values()) {
              for (const m of room.members.values()) if (m.graceTimer) clearTimeout(m.graceTimer);
            }
            rooms.clear();
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => httpServer.close(() => done()));
          }),
      });
    });
  });
}
