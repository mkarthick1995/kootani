/**
 * RoomClient — owns the signaling socket and the WebRTC peer mesh.
 *
 * Topology: full mesh. Each pair of peers has one RTCPeerConnection. The
 * offer direction is fixed by the server convention (the JOINING peer offers
 * to everyone already present), so there's no glare and we don't need
 * perfect-negotiation rollback in the skeleton.
 *
 * The class is framework-agnostic: it exposes a snapshot + an onState callback
 * that React subscribes to. Media never touches the signaling server.
 */

import type { ClientMessage, PeerInfo, ServerMessage, UserInfo } from "@shared/protocol";

/**
 * Shape of the WebRTC payloads we relay inside a signal message's `data` field:
 * either an SDP description or a single ICE candidate. Lives here (not in the
 * shared protocol) because these are DOM-only types.
 */
export type SignalData =
  | { kind: "sdp"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

/**
 * ICE servers. STUN lets peers discover their public address; it's enough for
 * many home networks. TURN (relay) — needed for CGNAT/symmetric NATs, common in
 * India — gets added here later once we stand one up.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export type RoomStatus = "connecting" | "connected" | "closed" | "error";

export interface PeerView {
  id: string;
  user: UserInfo;
  isHost: boolean;
  /** Remote audio (and later video) stream, once negotiated. */
  stream: MediaStream | null;
  connection: RTCPeerConnectionState;
}

export interface RoomSnapshot {
  status: RoomStatus;
  room: string;
  selfId: string | null;
  hostId: string | null;
  self: UserInfo;
  isSelfHost: boolean;
  muted: boolean;
  peers: PeerView[];
  error: string | null;
}

interface PeerState {
  info: PeerInfo;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  connection: RTCPeerConnectionState;
  pendingCandidates: RTCIceCandidateInit[];
}

export interface RoomClientOptions {
  signalingUrl: string;
  room: string;
  user: UserInfo;
  onState: (snapshot: RoomSnapshot) => void;
}

export class RoomClient {
  private ws: WebSocket | null = null;
  private localStream: MediaStream | null = null;
  private readonly peers = new Map<string, PeerState>();

  private status: RoomStatus = "connecting";
  private selfId: string | null = null;
  private hostId: string | null = null;
  private muted = false;
  private error: string | null = null;

  constructor(private readonly opts: RoomClientOptions) {}

  // -- lifecycle ------------------------------------------------------------

  async connect(): Promise<void> {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.fail("Couldn't access your microphone. Check Windows mic permissions.");
      return;
    }

    const ws = new WebSocket(this.opts.signalingUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.send({ type: "join", room: this.opts.room, user: this.opts.user });
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data) as ServerMessage);
    ws.onerror = () => this.fail("Couldn't reach the signaling server.");
    ws.onclose = () => {
      if (this.status !== "error") {
        this.status = "closed";
        this.emit();
      }
    };
  }

  leave(): void {
    this.send({ type: "leave" });
    for (const p of this.peers.values()) p.pc.close();
    this.peers.clear();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.ws?.close();
    this.ws = null;
    this.status = "closed";
    this.emit();
  }

  // -- user actions ---------------------------------------------------------

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.emit();
  }

  transferHostTo(peerId: string): void {
    this.send({ type: "transfer-host", to: peerId });
  }

  // -- signaling ------------------------------------------------------------

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendSignal(to: string, data: SignalData): void {
    this.send({ type: "signal", to, data });
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "joined":
        this.selfId = msg.selfId;
        this.hostId = msg.hostId;
        this.status = "connected";
        // We're the newcomer: offer to everyone already here.
        for (const peer of msg.peers) {
          const ps = this.ensurePeer(peer);
          void this.makeOffer(ps);
        }
        this.emit();
        break;

      case "peer-joined":
        // They're the newcomer; they'll offer to us. Just prepare the connection.
        this.ensurePeer(msg.peer);
        this.emit();
        break;

      case "peer-left": {
        const ps = this.peers.get(msg.peerId);
        ps?.pc.close();
        this.peers.delete(msg.peerId);
        this.emit();
        break;
      }

      case "host-changed":
        this.hostId = msg.hostId;
        this.emit();
        break;

      case "signal":
        void this.onSignal(msg.from, msg.data as SignalData);
        break;

      case "error":
        // Non-fatal server messages (e.g. failed transfer); surface but stay in room.
        this.error = msg.message;
        this.emit();
        break;

      case "pong":
        break;
    }
  }

  private ensurePeer(info: PeerInfo): PeerState {
    let ps = this.peers.get(info.id);
    if (ps) {
      ps.info = info;
      return ps;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    ps = { info, pc, stream: null, connection: "new", pendingCandidates: [] };
    this.peers.set(info.id, ps);

    this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream!));

    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal(info.id, { kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      ps!.stream = e.streams[0] ?? null;
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      ps!.connection = pc.connectionState;
      this.emit();
    };

    return ps;
  }

  private async makeOffer(ps: PeerState): Promise<void> {
    const offer = await ps.pc.createOffer();
    await ps.pc.setLocalDescription(offer);
    this.sendSignal(ps.info.id, { kind: "sdp", description: offer });
  }

  private async onSignal(from: string, data: SignalData): Promise<void> {
    const ps = this.peers.get(from);
    if (!ps) return; // peer-joined should have created it; ignore strays

    if (data.kind === "ice") {
      if (ps.pc.remoteDescription) {
        await ps.pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        ps.pendingCandidates.push(data.candidate);
      }
      return;
    }

    const desc = data.description;
    await ps.pc.setRemoteDescription(desc);
    await this.drainCandidates(ps);

    if (desc.type === "offer") {
      const answer = await ps.pc.createAnswer();
      await ps.pc.setLocalDescription(answer);
      this.sendSignal(from, { kind: "sdp", description: answer });
    }
  }

  private async drainCandidates(ps: PeerState): Promise<void> {
    for (const c of ps.pendingCandidates) {
      await ps.pc.addIceCandidate(c).catch(() => {});
    }
    ps.pendingCandidates = [];
  }

  // -- state ----------------------------------------------------------------

  private fail(message: string): void {
    this.error = message;
    this.status = "error";
    this.emit();
  }

  private emit(): void {
    this.opts.onState(this.snapshot());
  }

  snapshot(): RoomSnapshot {
    const peers: PeerView[] = [...this.peers.values()].map((p) => ({
      id: p.info.id,
      user: p.info.user,
      isHost: p.info.id === this.hostId,
      stream: p.stream,
      connection: p.connection,
    }));

    return {
      status: this.status,
      room: this.opts.room,
      selfId: this.selfId,
      hostId: this.hostId,
      self: this.opts.user,
      isSelfHost: this.selfId !== null && this.selfId === this.hostId,
      muted: this.muted,
      peers,
      error: this.error,
    };
  }
}
