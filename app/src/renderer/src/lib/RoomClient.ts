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

/** Per-user microphone settings. Persisted in localStorage across sessions. */
export interface MediaSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Mic gain multiplier applied via a Web Audio GainNode. 1 = unchanged. */
  inputVolume: number;
}

const SETTINGS_KEY = "kootani.audioSettings";
const DEFAULT_SETTINGS: MediaSettings = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  inputVolume: 1,
};

function loadSettings(): MediaSettings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "") as Partial<MediaSettings>;
    return {
      echoCancellation: s.echoCancellation ?? DEFAULT_SETTINGS.echoCancellation,
      noiseSuppression: s.noiseSuppression ?? DEFAULT_SETTINGS.noiseSuppression,
      autoGainControl: s.autoGainControl ?? DEFAULT_SETTINGS.autoGainControl,
      inputVolume: typeof s.inputVolume === "number" ? s.inputVolume : DEFAULT_SETTINGS.inputVolume,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: MediaSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage may be unavailable; settings just won't persist */
  }
}

export interface PeerView {
  id: string;
  user: UserInfo;
  isHost: boolean;
  /** Remote audio (and later video) stream, once negotiated. */
  stream: MediaStream | null;
  connection: RTCPeerConnectionState;
  /** How loudly *this* user hears the peer (0–1). Local-only. */
  outputVolume: number;
}

export interface RoomSnapshot {
  status: RoomStatus;
  room: string;
  selfId: string | null;
  hostId: string | null;
  self: UserInfo;
  isSelfHost: boolean;
  muted: boolean;
  settings: MediaSettings;
  peers: PeerView[];
  error: string | null;
}

interface PeerState {
  info: PeerInfo;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  connection: RTCPeerConnectionState;
  pendingCandidates: RTCIceCandidateInit[];
  outputVolume: number;
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

  // Mic capture pipeline: raw mic track -> GainNode (input volume) -> output.
  private rawTrack: MediaStreamTrack | null = null;
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private settings: MediaSettings = loadSettings();

  private status: RoomStatus = "connecting";
  private selfId: string | null = null;
  private hostId: string | null = null;
  private muted = false;
  private error: string | null = null;

  constructor(private readonly opts: RoomClientOptions) {}

  // -- lifecycle ------------------------------------------------------------

  async connect(): Promise<void> {
    let raw: MediaStream;
    try {
      raw = await navigator.mediaDevices.getUserMedia({
        // The voice DSP: echo cancellation stops a peer on speakers from looping
        // our voice back; noise suppression + auto gain clean up the signal.
        // These start from the user's saved preferences and stay toggleable live.
        audio: {
          echoCancellation: this.settings.echoCancellation,
          noiseSuppression: this.settings.noiseSuppression,
          autoGainControl: this.settings.autoGainControl,
        },
      });
    } catch {
      this.fail("Couldn't access your microphone. Check Windows mic permissions.");
      return;
    }
    this.rawTrack = raw.getAudioTracks()[0] ?? null;

    // Route the mic through a GainNode so input volume is adjustable, then send
    // the processed stream to peers. Falls back to the raw mic if Web Audio fails.
    try {
      this.audioCtx = new AudioContext();
      void this.audioCtx.resume();
      const source = this.audioCtx.createMediaStreamSource(raw);
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.settings.inputVolume;
      const dest = this.audioCtx.createMediaStreamDestination();
      source.connect(this.gainNode).connect(dest);
      this.localStream = dest.stream;
    } catch {
      this.localStream = raw;
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
    this.rawTrack?.stop();
    this.rawTrack = null;
    this.localStream = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.gainNode = null;
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

  // -- audio controls (all local to this user) ------------------------------

  setEchoCancellation(on: boolean): void {
    this.settings.echoCancellation = on;
    this.applyMicSettings();
  }

  setNoiseSuppression(on: boolean): void {
    this.settings.noiseSuppression = on;
    this.applyMicSettings();
  }

  setAutoGainControl(on: boolean): void {
    this.settings.autoGainControl = on;
    this.applyMicSettings();
  }

  /** Mic input gain. 0 = silence, 1 = unchanged, >1 amplifies. */
  setInputVolume(value: number): void {
    this.settings.inputVolume = value;
    if (this.gainNode) this.gainNode.gain.value = value;
    saveSettings(this.settings);
    this.emit();
  }

  /** How loudly this user hears one peer (0–1). Doesn't affect anyone else. */
  setPeerVolume(peerId: string, value: number): void {
    const ps = this.peers.get(peerId);
    if (!ps) return;
    ps.outputVolume = value;
    this.emit();
  }

  /** Re-apply the DSP toggles to the live mic track without renegotiating. */
  private applyMicSettings(): void {
    void this.rawTrack
      ?.applyConstraints({
        echoCancellation: this.settings.echoCancellation,
        noiseSuppression: this.settings.noiseSuppression,
        autoGainControl: this.settings.autoGainControl,
      })
      .catch(() => {});
    saveSettings(this.settings);
    this.emit();
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
    ps = { info, pc, stream: null, connection: "new", pendingCandidates: [], outputVolume: 1 };
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
    await this.tuneAudioBitrate(ps.pc);
    this.sendSignal(ps.info.id, { kind: "sdp", description: offer });
  }

  /** Raise the Opus bitrate for clearer voice (default is ~32 kbps). */
  private async tuneAudioBitrate(pc: RTCPeerConnection): Promise<void> {
    const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = 64_000;
      await sender.setParameters(params);
    } catch {
      // setParameters isn't supported everywhere; quality just falls back.
    }
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
      await this.tuneAudioBitrate(ps.pc);
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
      outputVolume: p.outputVolume,
    }));

    return {
      status: this.status,
      room: this.opts.room,
      selfId: this.selfId,
      hostId: this.hostId,
      self: this.opts.user,
      isSelfHost: this.selfId !== null && this.selfId === this.hostId,
      muted: this.muted,
      settings: { ...this.settings },
      peers,
      error: this.error,
    };
  }
}
