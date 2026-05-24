/**
 * Kootani signaling protocol — client-side copy.
 *
 * NOTE: this mirrors server/src/protocol.ts. Keep them in sync.
 * See that file for the full description of the mesh/host conventions.
 */

export interface UserInfo {
  name: string;
  email?: string;
  picture?: string;
}

export interface PeerInfo {
  id: string;
  user: UserInfo;
  isHost: boolean;
}

// Client -> Server
export interface JoinMessage {
  type: "join";
  room: string;
  user: UserInfo;
}
export interface LeaveMessage {
  type: "leave";
}
export interface SignalOutMessage {
  type: "signal";
  to: string;
  data: unknown;
}
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

// Server -> Client
export interface JoinedMessage {
  type: "joined";
  selfId: string;
  room: string;
  hostId: string;
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
export interface SignalInMessage {
  type: "signal";
  from: string;
  data: unknown;
}
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

// The WebRTC payload shape carried inside signal `data` (SignalData) lives in
// the renderer (RoomClient.ts) because it references DOM-only WebRTC types that
// the main/preload processes don't compile against.
