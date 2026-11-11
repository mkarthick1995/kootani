/**
 * Kootani signaling protocol — the single source of truth.
 *
 * The app imports this file directly (app/src/shared/protocol.ts re-exports it),
 * so the standalone server, the in-app embedded server and the client can never
 * drift apart.
 *
 * The signaling server is a thin rendezvous: it tracks room membership and the
 * host role, and relays WebRTC offer/answer/ICE blobs between peers verbatim.
 * Audio/video never flows through it — media is peer-to-peer.
 *
 * Reliability model:
 *  - Every `joined` hands the client a secret `token`. If the socket drops, the
 *    server keeps the member's seat for a grace period (members are shown as
 *    "away") and queues messages for them. Reconnecting with `resume` reclaims
 *    the same member id, so peers keep their WebRTC connections — a signaling
 *    blip doesn't interrupt voice.
 *  - `version` lets the server turn away incompatible builds with a clear
 *    "update your app" message instead of a silently broken call.
 */

/** Bump when a change would break interop between builds. */
export const PROTOCOL_VERSION = 2;
/** The oldest client protocol the server still accepts. */
export const MIN_PROTOCOL_VERSION = 2;

/** Hard limits, enforced by the server and mirrored in the UI. */
export const LIMITS = {
  /** Full mesh: every member uploads to every other member, so keep rooms small. */
  maxMembers: 10,
  maxNameLength: 48,
  maxRoomLength: 32,
} as const;

export interface UserInfo {
  /** Display name (from Google profile, or a nickname). */
  name: string;
  email?: string;
  /** Avatar URL (https only). */
  picture?: string;
}

export interface PeerInfo {
  /** Server-assigned member id, unique within the room and stable across resumes. */
  id: string;
  user: UserInfo;
  isHost: boolean;
  /** True while the member's signaling link is down but their seat is held. */
  away?: boolean;
}

/** Same shape as the DOM's RTCIceServer (which non-DOM code can't import). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** Join (and implicitly create, if it doesn't exist) a room — or resume a seat. */
export interface JoinMessage {
  type: "join";
  room: string;
  user: UserInfo;
  /** Client protocol version; absent on pre-v2 builds. */
  version?: number;
  /** Reclaim a seat held after a disconnect (from the last `joined`). */
  resume?: { memberId: string; token: string };
}
/** Cleanly leave the current room (no grace period). */
export interface LeaveMessage {
  type: "leave";
}
/** Relay a WebRTC signaling payload (SDP, ICE candidate, …) to one peer. */
export interface SignalOutMessage {
  type: "signal";
  to: string;
  data: unknown;
}
/** Host only: hand the host role to another member. */
export interface TransferHostMessage {
  type: "transfer-host";
  to: string;
}
/** Application-level heartbeat so the client can detect a dead link quickly. */
export interface PingMessage {
  type: "ping";
}
export type ClientMessage =
  | JoinMessage
  | LeaveMessage
  | SignalOutMessage
  | TransferHostMessage
  | PingMessage;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface JoinedMessage {
  type: "joined";
  selfId: string;
  room: string;
  hostId: string;
  /** Everyone else currently in the room. */
  peers: PeerInfo[];
  /** Secret for `resume`; keep it private. */
  token: string;
  /** True when this reclaimed an existing seat (peers kept their connections). */
  resumed: boolean;
  /** Extra ICE servers (e.g. TURN) the host's server shares with everyone. */
  iceServers?: IceServer[];
}
export interface PeerJoinedMessage {
  type: "peer-joined";
  peer: PeerInfo;
}
export interface PeerLeftMessage {
  type: "peer-left";
  peerId: string;
}
/** A member's signaling link went down (away) or came back. */
export interface PeerStatusMessage {
  type: "peer-status";
  peerId: string;
  away: boolean;
}
export interface SignalInMessage {
  type: "signal";
  from: string;
  data: unknown;
}
export interface HostChangedMessage {
  type: "host-changed";
  hostId: string;
}
export type ErrorCode =
  | "bad-request"
  | "outdated-client"
  | "room-full"
  | "no-such-room"
  | "already-joined"
  | "not-host"
  | "no-such-peer";
export interface ErrorMessage {
  type: "error";
  message: string;
  code?: ErrorCode;
  /** The server will not let this connection proceed; don't auto-retry. */
  fatal?: boolean;
}
export interface PongMessage {
  type: "pong";
}
export type ServerMessage =
  | JoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | PeerStatusMessage
  | SignalInMessage
  | HostChangedMessage
  | ErrorMessage
  | PongMessage;
