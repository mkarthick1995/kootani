/**
 * Kootani signaling protocol.
 *
 * The signaling server is a thin rendezvous: it tracks room membership and the
 * host role, and relays WebRTC offer/answer/ICE blobs between peers verbatim.
 * The actual audio/video never flows through this server — it goes peer-to-peer.
 *
 * Mesh convention (important): when a peer joins, the JOINING peer creates the
 * WebRTC offer to each peer already in the room. Existing peers wait for that
 * offer and answer it. This one-directional rule avoids "glare" (both sides
 * offering at once) without needing perfect-negotiation in the skeleton.
 *
 * NOTE: this file is duplicated in app/src/shared/protocol.ts. Keep them in sync.
 */

export interface UserInfo {
  /** Display name (from Google profile, or a dev nickname). */
  name: string;
  email?: string;
  /** Avatar URL. */
  picture?: string;
}

export interface PeerInfo {
  /** Server-assigned connection id, unique within the room. */
  id: string;
  user: UserInfo;
  isHost: boolean;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** Join (and implicitly create, if it doesn't exist) a room. */
export interface JoinMessage {
  type: "join";
  room: string;
  user: UserInfo;
}

/** Cleanly leave the current room. */
export interface LeaveMessage {
  type: "leave";
}

/** Relay a WebRTC signaling payload (SDP or ICE candidate) to one peer. */
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

/** Sent to a peer right after it joins. */
export interface JoinedMessage {
  type: "joined";
  selfId: string;
  room: string;
  hostId: string;
  /** Peers already present (excludes self). The newcomer offers to each. */
  peers: PeerInfo[];
}

export interface PeerJoinedMessage {
  type: "peer-joined";
  peer: PeerInfo;
}

export interface PeerLeftMessage {
  type: "peer-left";
  peerId: string;
}

/** A WebRTC signaling payload relayed from another peer. */
export interface SignalInMessage {
  type: "signal";
  from: string;
  data: unknown;
}

/** The host role moved (manual transfer or auto-transfer on host disconnect). */
export interface HostChangedMessage {
  type: "host-changed";
  hostId: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface PongMessage {
  type: "pong";
}

export type ServerMessage =
  | JoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | SignalInMessage
  | HostChangedMessage
  | ErrorMessage
  | PongMessage;
