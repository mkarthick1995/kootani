/**
 * RoomClient — owns the signaling socket and the WebRTC peer mesh.
 *
 * Topology: full mesh. Each pair of peers has one RTCPeerConnection. Newcomers
 * still kick off the first offer (their tracks fire negotiationneeded on join),
 * but because screen sharing lets either side add/drop a track mid-call, we use
 * the perfect-negotiation pattern to resolve the resulting offer glare instead
 * of relying on a fixed offer direction. See ensurePeer/onSignal.
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
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  // Announces that the sender has started/stopped sharing their screen. The
  // pixels travel as a normal video track (negotiated via SDP); this just flags
  // the UI and lets the receiver drop the view promptly when sharing stops.
  | { kind: "screen"; on: boolean };

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
  /** Remote voice stream, once negotiated. */
  stream: MediaStream | null;
  /** The peer's shared-screen stream (video + any system audio), if sharing. */
  screenStream: MediaStream | null;
  /** Whether the peer is currently sharing their screen. */
  sharingScreen: boolean;
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
  /** Whether *this* user is currently sharing their screen. */
  sharing: boolean;
  /** This user's own shared-screen stream, for a local self-preview. */
  localScreenStream: MediaStream | null;
  settings: MediaSettings;
  peers: PeerView[];
  error: string | null;
}

interface PeerState {
  info: PeerInfo;
  pc: RTCPeerConnection;
  /** Remote voice stream. */
  stream: MediaStream | null;
  /** Remote shared-screen stream (video + any system audio). */
  screenStream: MediaStream | null;
  sharingScreen: boolean;
  connection: RTCPeerConnectionState;
  pendingCandidates: RTCIceCandidateInit[];
  outputVolume: number;
  // Perfect-negotiation bookkeeping. Either side may now (re)negotiate — adding
  // or dropping a screen track fires negotiationneeded on whichever peer shares —
  // so we can no longer assume a fixed offerer. `polite` is decided by a stable
  // id comparison (opposite on each end); on an offer collision the impolite peer
  // ignores the incoming offer while the polite peer rolls back and accepts it.
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
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

  // Screen share: a separate getDisplayMedia stream (video + optional system
  // audio) whose tracks are added to every peer connection while sharing.
  private screenStream: MediaStream | null = null;
  private sharing = false;

  private status: RoomStatus = "connecting";
  private selfId: string | null = null;
  private hostId: string | null = null;
  private muted = false;
  private error: string | null = null;

  // Initial-connection retry: after cloudflared registers, Cloudflare's edge takes
  // a few seconds to publish a route to a freshly-opened tunnel, so the first
  // WebSocket connect(s) can fail (close 1006 / DNS not-yet-resolving). We retry
  // here rather than gating in the main process: this socket is the same stack
  // that carries real traffic, so if it can connect, the tunnel genuinely works.
  // ~45s of patience covers normal edge propagation without hanging forever.
  private static readonly MAX_CONNECT_ATTEMPTS = 30;
  private static readonly RETRY_DELAY_MS = 1500;
  private socketOpened = false;
  private leaving = false;
  private connectAttempts = 0;

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

    this.openSocket();
  }

  /** Diagnostics: forward a line to the main-process host log (no-op if absent). */
  private log(message: string): void {
    try {
      window.kootani?.log?.(`RoomClient: ${message}`);
    } catch {
      /* logging must never break connection logic */
    }
  }

  /** Opens the signaling WebSocket, retrying the initial connect a few times. */
  private openSocket(): void {
    this.log(`connect attempt ${this.connectAttempts + 1}/${RoomClient.MAX_CONNECT_ATTEMPTS} -> ${this.opts.signalingUrl}`);
    const ws = new WebSocket(this.opts.signalingUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.socketOpened = true;
      this.log("WebSocket OPEN — sending join");
      this.send({ type: "join", room: this.opts.room, user: this.opts.user });
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data) as ServerMessage);
    // onerror always precedes onclose; let onclose decide retry vs. fail.
    ws.onerror = () => this.log("WebSocket error event");
    ws.onclose = (ev) => {
      this.log(`WebSocket closed (code=${ev.code}, reason="${ev.reason}", wasClean=${ev.wasClean}, everOpened=${this.socketOpened})`);
      if (this.leaving) return;

      if (this.socketOpened) {
        // We were connected and the link dropped.
        if (this.status !== "error") {
          this.status = "closed";
          this.emit();
        }
        return;
      }

      // Never connected: the tunnel may still be warming up — retry a few times.
      if (this.connectAttempts < RoomClient.MAX_CONNECT_ATTEMPTS) {
        this.connectAttempts++;
        setTimeout(() => {
          if (!this.leaving && !this.socketOpened) this.openSocket();
        }, RoomClient.RETRY_DELAY_MS);
        return;
      }
      this.log("giving up — exhausted connect attempts");
      this.fail("Couldn't reach the signaling server.");
    };
  }

  leave(): void {
    this.leaving = true;
    this.send({ type: "leave" });
    for (const p of this.peers.values()) p.pc.close();
    this.peers.clear();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.sharing = false;
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

  // -- screen sharing -------------------------------------------------------

  /**
   * Capture the screen/window the user picked (the main process resolves which
   * one) and push it to every peer. Resolves quietly on failure. The source must
   * be chosen via window.kootani.prepareScreenShare() first.
   */
  async startScreenShare(): Promise<void> {
    if (this.sharing) return;
    let stream: MediaStream;
    try {
      // audio: true picks up system/loopback audio so game sound is shared too.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      // Our own picker (not the OS one) chose the source, so this is a real
      // capture failure rather than a user cancel — record it for diagnostics.
      this.log(`getDisplayMedia failed: ${String(err)}`);
      return;
    }
    this.screenStream = stream;
    this.sharing = true;
    // Stopping via Windows' own "stop sharing" overlay ends the track — mirror that.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stopScreenShare());
    for (const ps of this.peers.values()) this.addScreenTracks(ps);
    this.emit();
  }

  /** Stop sharing: drop the tracks from every peer (renegotiating) and notify them. */
  stopScreenShare(): void {
    if (!this.sharing) return;
    this.sharing = false;
    const tracks = this.screenStream?.getTracks() ?? [];
    for (const ps of this.peers.values()) {
      ps.pc.getSenders().forEach((s) => {
        if (s.track && tracks.includes(s.track)) ps.pc.removeTrack(s);
      });
      this.sendSignal(ps.info.id, { kind: "screen", on: false });
    }
    tracks.forEach((t) => t.stop());
    this.screenStream = null;
    this.emit();
  }

  /** Add the current screen tracks to one peer and tell them a share is starting. */
  private addScreenTracks(ps: PeerState): void {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => ps.pc.addTrack(t, this.screenStream!));
    this.sendSignal(ps.info.id, { kind: "screen", on: true });
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
        // We're the newcomer: building each peer adds our tracks, which fires
        // negotiationneeded so we offer to everyone already here.
        for (const peer of msg.peers) this.ensurePeer(peer);
        this.emit();
        break;

      case "peer-joined": {
        // They're the newcomer. ensurePeer adds our tracks (incl. our screen, if
        // we're sharing) and negotiates; tell them about the share so they label it.
        const ps = this.ensurePeer(msg.peer);
        if (this.sharing) this.sendSignal(ps.info.id, { kind: "screen", on: true });
        this.emit();
        break;
      }

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
    // Politeness must be stable and opposite on the two ends; a plain id compare
    // gives that (my id vs theirs flips when they compute it about me).
    const polite = (this.selfId ?? "") > info.id;
    const state: PeerState = {
      info,
      pc,
      stream: null,
      screenStream: null,
      sharingScreen: false,
      connection: "new",
      pendingCandidates: [],
      outputVolume: 1,
      polite,
      makingOffer: false,
      ignoreOffer: false,
    };
    ps = state;
    this.peers.set(info.id, state);

    // Add our voice, and our screen too if we're already sharing when they join.
    this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream!));
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => pc.addTrack(t, this.screenStream!));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal(info.id, { kind: "ice", candidate: e.candidate.toJSON() });
    };
    // A stream carrying video is a screen share (plus any system audio it brought);
    // an audio-only stream is voice. We key off the stream the sender attached the
    // track to (each getDisplayMedia/getUserMedia stream has its own id), so a
    // screen's video + system audio land together. The guard stops a screen's audio
    // track — which can arrive before its video — from clobbering the voice stream:
    // a new audio-only stream is only treated as voice if we have no voice yet (or
    // it's the same stream); otherwise it waits for its video to mark it a screen.
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      if (stream.getVideoTracks().length > 0 || e.track.kind === "video") {
        state.screenStream = stream;
      } else if (!state.stream || stream.id === state.stream.id) {
        state.stream = stream;
      }
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      state.connection = pc.connectionState;
      this.emit();
    };
    // Either side may (re)negotiate when tracks are added/removed. setLocalDescription()
    // with no args creates an offer when stable; perfect negotiation (onSignal) sorts
    // out any collision with the other end's simultaneous offer.
    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        await pc.setLocalDescription();
        await this.tuneAudioBitrate(pc);
        if (pc.localDescription) {
          this.sendSignal(info.id, { kind: "sdp", description: pc.localDescription.toJSON() });
        }
      } catch (err) {
        this.log(`negotiationneeded error for ${info.id}: ${String(err)}`);
      } finally {
        state.makingOffer = false;
      }
    };

    return state;
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

    if (data.kind === "screen") {
      ps.sharingScreen = data.on;
      if (!data.on) ps.screenStream = null; // drop the view as soon as they stop
      this.emit();
      return;
    }

    if (data.kind === "ice") {
      // Buffer until we have a remote description; suppress errors for a candidate
      // belonging to an offer we deliberately ignored during a collision.
      if (ps.pc.remoteDescription) {
        await ps.pc.addIceCandidate(data.candidate).catch((err) => {
          if (!ps.ignoreOffer) this.log(`addIceCandidate failed for ${from}: ${String(err)}`);
        });
      } else {
        ps.pendingCandidates.push(data.candidate);
      }
      return;
    }

    const desc = data.description;
    // Collision: their offer arrives while we're mid-offer or otherwise unstable.
    const collision =
      desc.type === "offer" && (ps.makingOffer || ps.pc.signalingState !== "stable");
    ps.ignoreOffer = !ps.polite && collision;
    if (ps.ignoreOffer) return; // impolite peer keeps its own offer

    try {
      // On the polite side a collision is resolved by setRemoteDescription, which
      // implicitly rolls back our own offer (supported by Chromium/Electron).
      await ps.pc.setRemoteDescription(desc);
      await this.drainCandidates(ps);
      if (desc.type === "offer") {
        await ps.pc.setLocalDescription(); // implicit answer
        await this.tuneAudioBitrate(ps.pc);
        if (ps.pc.localDescription) {
          this.sendSignal(from, { kind: "sdp", description: ps.pc.localDescription.toJSON() });
        }
      }
    } catch (err) {
      this.log(`onSignal error for ${from}: ${String(err)}`);
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
      screenStream: p.screenStream,
      sharingScreen: p.sharingScreen,
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
      sharing: this.sharing,
      localScreenStream: this.screenStream,
      settings: { ...this.settings },
      peers,
      error: this.error,
    };
  }
}
