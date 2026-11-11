/**
 * RoomClient — owns the signaling socket and the WebRTC peer mesh.
 *
 * Topology: full mesh, one RTCPeerConnection per pair, negotiated with the
 * perfect-negotiation pattern (either side may (re)negotiate at any time).
 *
 * Reliability, in layers:
 *  1. Signaling: an app-level heartbeat detects a dead socket within ~20 s; we
 *     then reconnect with backoff and RESUME our seat (same member id), so
 *     peers keep their WebRTC connections and voice never stops. Signals sent
 *     while reconnecting are queued and flushed on resume.
 *  2. Media: a peer connection that fails (or stays "disconnected") gets an ICE
 *     restart; an offer that's never answered is rolled back and retried, so
 *     negotiation can't deadlock after a lost message.
 *  3. A negotiated data channel per peer carries small P2P state (mute/deafen)
 *     and, if the host's tunnel is replaced, the new server address — guests
 *     follow it even though their signaling link to the old address is dead.
 *
 * Framework-agnostic: exposes a snapshot + onState callback for React.
 * Media never touches the signaling server.
 */

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type IceServer,
  type PeerInfo,
  type ServerMessage,
  type UserInfo,
} from "@shared/protocol";
import { playCue, type SoundCue } from "./sounds";
import { loadJson, saveJson } from "./storage";

/** Which of the sender's streams is which (stream ids are opaque on the wire). */
interface StreamIds {
  voice: string | null;
  screen: string | null;
}

/** WebRTC payloads relayed inside a signal message's `data` field. */
export type SignalData =
  | { kind: "sdp"; description: RTCSessionDescriptionInit; streams?: StreamIds }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  // Sharing started/stopped. Pixels travel as a normal negotiated video track;
  // this flags the UI and lets the receiver drop the view promptly on stop.
  | { kind: "screen"; on: boolean; streamId?: string };

/** Messages on the per-peer data channel. */
type PeerMessage =
  | { t: "state"; muted: boolean; deafened: boolean }
  | { t: "server-moved"; url: string };

/**
 * ICE servers. STUN lets peers discover their public address — enough for many
 * home networks. TURN relays (for CGNAT/symmetric NATs) come from config, and
 * the host's server also shares its TURN list with everyone who joins.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export type RoomStatus = "connecting" | "connected" | "reconnecting" | "closed" | "error";

/** Per-user audio settings. Persisted across sessions. */
export interface MediaSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Mic gain multiplier applied via a Web Audio GainNode. 1 = unchanged. */
  inputVolume: number;
  /** Chosen microphone ("" = system default). */
  inputDeviceId: string;
  /** Chosen speakers/headphones ("" = system default). */
  outputDeviceId: string;
  /** Join/leave/mute sound cues. */
  sounds: boolean;
  /** Include system audio (game sound) when sharing a screen. */
  shareSystemAudio: boolean;
}

const SETTINGS_KEY = "kootani.audioSettings";
const DEFAULT_SETTINGS: MediaSettings = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  inputVolume: 1,
  inputDeviceId: "",
  outputDeviceId: "",
  sounds: true,
  shareSystemAudio: true,
};

/** Screen-share quality: the capture height cap and frame rate. */
export interface ScreenQuality {
  /** Max captured height in px; width follows the source aspect ratio. */
  maxHeight: number;
  frameRate: number;
}

/** Resolution choices offered in the UI (height-based, the usual "Np" labels). */
export const SCREEN_RESOLUTIONS: { label: string; height: number }[] = [
  { label: "480p", height: 480 },
  { label: "720p", height: 720 },
  { label: "1080p (Full HD)", height: 1080 },
  { label: "1440p (2K)", height: 1440 },
  { label: "2160p (4K)", height: 2160 },
];

export const SCREEN_FRAME_RATES: number[] = [24, 30, 60, 120, 144];

const SCREEN_KEY = "kootani.screenQuality";
const DEFAULT_SCREEN_QUALITY: ScreenQuality = { maxHeight: 1080, frameRate: 30 };

/** Capping height (not width too) keeps the source aspect ratio. */
function screenConstraints(q: ScreenQuality): MediaTrackConstraints {
  return {
    height: { ideal: q.maxHeight, max: q.maxHeight },
    frameRate: { ideal: q.frameRate, max: q.frameRate },
  };
}

/** Encoder bitrate cap (bps) for a resolution/fps; WebRTC adapts below it. */
function screenBitrate(q: ScreenQuality): number {
  const width = Math.round((q.maxHeight * 16) / 9);
  const raw = width * q.maxHeight * q.frameRate * 0.07; // ~0.07 bits/pixel for motion
  return Math.min(25_000_000, Math.max(800_000, Math.round(raw)));
}

export interface DeviceOption {
  id: string;
  label: string;
}

export interface PeerView {
  id: string;
  user: UserInfo;
  isHost: boolean;
  /** Their signaling link is down; the server is holding their seat. */
  away: boolean;
  /** Remote voice stream, once negotiated. */
  stream: MediaStream | null;
  /** Their shared-screen stream (video + any system audio), if sharing. */
  screenStream: MediaStream | null;
  sharingScreen: boolean;
  connection: RTCPeerConnectionState;
  speaking: boolean;
  /** Self-reported over the data channel (null until known). */
  muted: boolean | null;
  deafened: boolean | null;
  /** Round-trip time to them in ms, when known. */
  rttMs: number | null;
  /** Media goes through a TURN relay rather than directly. */
  relayed: boolean;
  /** How loudly *this* user hears the peer's voice (0–1). Local-only. */
  outputVolume: number;
  /** How loudly *this* user hears the peer's shared-screen audio (0–1). */
  screenVolume: number;
}

export interface RoomSnapshot {
  status: RoomStatus;
  room: string;
  /** What friends should use to join (for the invite link). */
  inviteUrl: string;
  /** Attempts so far while first connecting (for "still trying…" feedback). */
  connectAttempt: number;
  selfId: string | null;
  hostId: string | null;
  self: UserInfo;
  isSelfHost: boolean;
  muted: boolean;
  deafened: boolean;
  selfSpeaking: boolean;
  /** Mic problem (we're in listen-only mode), or null. */
  micError: string | null;
  sharing: boolean;
  localScreenStream: MediaStream | null;
  screenQuality: ScreenQuality;
  settings: MediaSettings;
  inputs: DeviceOption[];
  outputs: DeviceOption[];
  peers: PeerView[];
  /** Fatal error (status "error") — or the reason for status "closed". */
  error: string | null;
  /** Transient, non-fatal message for a banner. */
  notice: string | null;
}

interface PeerState {
  info: PeerInfo;
  away: boolean;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  /** Every stream the peer has sent us, by id. */
  remoteStreams: Map<string, MediaStream>;
  remoteVoiceId: string | null;
  remoteScreenId: string | null;
  sharingScreen: boolean;
  connection: RTCPeerConnectionState;
  pendingCandidates: RTCIceCandidateInit[];
  outputVolume: number;
  screenVolume: number;
  speakingUntil: number;
  /** Last cumulative audio energy/duration seen for their voice (speaking meter). */
  energy: { total: number; duration: number } | null;
  muted: boolean | null;
  deafened: boolean | null;
  rttMs: number | null;
  relayed: boolean;
  // Perfect negotiation: `polite` is a stable id comparison (opposite on each
  // end); on an offer collision the impolite side ignores the incoming offer and
  // the polite side rolls back and accepts it.
  polite: boolean;
  /**
   * We're the member already in the room: let the newcomer make the first offer.
   * If both sides offered at once (glare) on every join, the polite side would
   * roll back its *initial* offer — which we've seen leave Chromium's ICE agent
   * stuck with no candidates. Later renegotiations still use perfect negotiation.
   */
  awaitingOffer: boolean;
  createdAt: number;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** When our current unanswered offer was made (watchdog). */
  offerAt: number;
  disconnectedAt: number;
  lastIceRestart: number;
}

export interface RoomClientOptions {
  signalingUrl: string;
  /** What friends connect to (defaults to signalingUrl). */
  inviteUrl?: string;
  room: string;
  user: UserInfo;
  onState: (snapshot: RoomSnapshot) => void;
  /** Extra ICE servers (TURN relays) from this user's config. */
  extraIceServers?: IceServer[];
}

const TICK_MS = 100;
/** Initial connect: patience for a freshly-opened tunnel's edge route to propagate. */
const INITIAL_PATIENCE_MS = 45_000;
const INITIAL_RETRY_MS = 1_500;
/** After being in the room: how long to keep trying to get back before giving up. */
const RECONNECT_GIVE_UP_MS = 120_000;
const HEARTBEAT_EVERY_MS = 5_000;
/** No message at all from the server for this long ⇒ the socket is dead. */
const HEARTBEAT_DEAD_MS = 20_000;
const OFFER_TIMEOUT_MS = 15_000;
const DISCONNECTED_RESTART_MS = 5_000;
const ICE_RESTART_MIN_GAP_MS = 8_000;
const SPEAKING_RMS = 0.015;
const PEER_LEVEL_EVERY_MS = 150;
const METER_FFT = 8192; // ~170 ms at 48 kHz: each tick sees (nearly) all audio since the last
const SPEAKING_HOLD_MS = 400;
const MAX_OUTBOX = 500;
const NOTICE_MS = 7_000;

export class RoomClient {
  private ws: WebSocket | null = null;
  /** True once `joined` arrived on the current socket. */
  private joinedOnSocket = false;
  private readonly peers = new Map<string, PeerState>();
  private outbox: { to: string; data: SignalData }[] = [];

  private signalingUrl: string;
  private inviteUrl: string;
  private sharedIceServers: IceServer[] = [];

  // Mic pipeline: mic source -> GainNode (input volume) -> destination (sent to
  // peers) + analyser (speaking meter). The destination's track is what peers
  // receive, so swapping microphones never needs renegotiation.
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Float32Array<ArrayBuffer> | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private rawTrack: MediaStreamTrack | null = null;
  private localStream: MediaStream | null = null;
  private micError: string | null = null;
  private settings: MediaSettings = loadJson(SETTINGS_KEY, DEFAULT_SETTINGS);
  private inputs: DeviceOption[] = [];
  private outputs: DeviceOption[] = [];

  private screenStream: MediaStream | null = null;
  private screenQuality: ScreenQuality = loadJson(SCREEN_KEY, DEFAULT_SCREEN_QUALITY);

  private status: RoomStatus = "connecting";
  private selfId: string | null = null;
  private token: string | null = null;
  private hostId: string | null = null;
  private muted = false;
  private deafened = false;
  private mutedBeforeDeafen = false;
  private selfSpeakingUntil = 0;
  private error: string | null = null;
  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  private disposed = false;
  private connectAttempt = 0;
  private firstAttemptAt = 0;
  private reconnectSince = 0;
  private reconnectTries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastServerMessageAt = 0;
  private lastPingAt = 0;
  private lastStatsAt = 0;
  private lastWatchdogAt = 0;
  private lastPeerLevelAt = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastEmittedSpeaking = "";

  constructor(private readonly opts: RoomClientOptions) {
    this.signalingUrl = opts.signalingUrl;
    this.inviteUrl = opts.inviteUrl ?? opts.signalingUrl;
  }

  // -- lifecycle ------------------------------------------------------------

  async connect(): Promise<void> {
    this.firstAttemptAt = Date.now();
    this.buildAudioGraph();
    await this.openMic(this.settings.inputDeviceId);
    if (this.disposed) return;
    void this.refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.openSocket();
  }

  /** Leave the room and release every resource. The instance is dead afterwards. */
  leave(): void {
    if (this.disposed) return;
    this.send({ type: "leave" });
    this.disposed = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    navigator.mediaDevices.removeEventListener("devicechange", this.onDeviceChange);
    for (const ps of this.peers.values()) this.closePeer(ps);
    this.peers.clear();
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.rawTrack?.stop();
    this.rawTrack = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "left");
  }

  /** Manually retry after the connection was given up on. */
  reconnect(): void {
    if (this.disposed || (this.status !== "closed" && this.status !== "error")) return;
    this.error = null;
    if (this.selfId) {
      this.status = "reconnecting";
      this.reconnectSince = Date.now();
      this.reconnectTries = 0;
    } else {
      this.status = "connecting";
      this.firstAttemptAt = Date.now();
      this.connectAttempt = 0;
    }
    this.emit();
    this.openSocket();
  }

  /** Diagnostics: forward a line to the main-process log. */
  private log(message: string): void {
    try {
      window.kootani?.log?.(`RoomClient: ${message}`);
    } catch {
      /* logging must never break connection logic */
    }
  }

  // -- signaling socket -------------------------------------------------------

  private openSocket(): void {
    if (this.disposed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connectAttempt++;
    const url = this.signalingUrl;
    this.log(`connect attempt ${this.connectAttempt} -> ${url}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.fail(`That server address isn't valid: ${url}`);
      return;
    }
    this.ws = ws;
    this.joinedOnSocket = false;
    this.lastServerMessageAt = Date.now();

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastServerMessageAt = Date.now();
      const resume = this.selfId && this.token ? { memberId: this.selfId, token: this.token } : undefined;
      this.log(`socket open — ${resume ? "resuming seat" : "joining"}`);
      this.send({
        type: "join",
        room: this.opts.room,
        user: this.opts.user,
        version: PROTOCOL_VERSION,
        ...(resume ? { resume } : {}),
      });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastServerMessageAt = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onerror = () => {
      if (this.ws === ws) this.log("socket error event");
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.log(`socket closed (code=${ev.code}, reason="${ev.reason}")`);
      this.onSocketLost();
    };
  }

  /** The socket is gone (closed, or declared dead by the heartbeat). */
  private onSocketLost(): void {
    const ws = this.ws;
    this.ws = null;
    this.joinedOnSocket = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    if (this.disposed || this.status === "error" || this.status === "closed") return;

    // Never got in: a fresh tunnel's edge route can take a while to propagate.
    if (!this.selfId) {
      if (Date.now() - this.firstAttemptAt < INITIAL_PATIENCE_MS) {
        this.status = "connecting";
        this.emit();
        this.scheduleReconnect(INITIAL_RETRY_MS);
        return;
      }
      this.log("giving up initial connect");
      this.fail(
        "Couldn't reach the room. Invite links change every time the host starts hosting — " +
          "make sure you have the latest one and that the host still has Kootani open.",
      );
      return;
    }

    // We were in the room: get back in, resuming our seat.
    if (this.status !== "reconnecting") {
      this.status = "reconnecting";
      this.reconnectSince = Date.now();
      this.reconnectTries = 0;
      this.cue("disconnect");
      this.emit();
    }
    if (Date.now() - this.reconnectSince > RECONNECT_GIVE_UP_MS) {
      this.log("giving up reconnecting");
      this.status = "closed";
      this.error = "Lost connection to the room.";
      this.emit();
      return;
    }
    const delay = Math.min(5_000, 500 * 2 ** this.reconnectTries++);
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.disposed && !this.ws) this.openSocket();
    }, delayMs);
  }

  private send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Send now if we're in the room on a live socket, else queue for the resume. */
  private sendSignal(to: string, data: SignalData): void {
    if (this.joinedOnSocket && this.send({ type: "signal", to, data })) return;
    this.outbox.push({ to, data });
    if (this.outbox.length > MAX_OUTBOX) this.outbox.shift();
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "joined":
        this.onJoined(msg);
        break;

      case "peer-joined": {
        // They're the newcomer: they make the first offer.
        const { ps, created } = this.ensurePeer(msg.peer, { awaitOffer: true });
        if (created) {
          this.cue("join");
          if (this.screenStream) this.announceScreen(ps, true);
        }
        this.emit();
        break;
      }

      case "peer-left": {
        const ps = this.peers.get(msg.peerId);
        if (ps) {
          this.closePeer(ps);
          this.peers.delete(msg.peerId);
          this.cue("leave");
          this.emit();
        }
        break;
      }

      case "peer-status": {
        const ps = this.peers.get(msg.peerId);
        if (ps) {
          ps.away = msg.away;
          this.emit();
        }
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
        this.log(`server error (${msg.code ?? "?"}${msg.fatal ? ", fatal" : ""}): ${msg.message}`);
        if (msg.fatal) this.fail(msg.message);
        else this.setNotice(msg.message);
        break;

      case "pong":
        break;
    }
  }

  private onJoined(msg: Extract<ServerMessage, { type: "joined" }>): void {
    const first = this.selfId === null;
    const lostSeat = !first && (!msg.resumed || msg.selfId !== this.selfId);
    if (lostSeat) {
      // Our seat expired while we were away: everyone already saw us leave, so
      // their connections to us are gone. Start the mesh over.
      this.log("seat expired — rebuilding all peer connections");
      for (const ps of this.peers.values()) this.closePeer(ps);
      this.peers.clear();
      this.outbox = [];
    }
    const wasReconnecting = this.status === "reconnecting";

    this.selfId = msg.selfId;
    this.token = msg.token;
    this.hostId = msg.hostId;
    this.sharedIceServers = msg.iceServers ?? [];
    this.status = "connected";
    this.joinedOnSocket = true;
    this.reconnectTries = 0;
    this.error = null;

    // Reconcile with the server's view of the room.
    const present = new Set(msg.peers.map((p) => p.id));
    for (const [id, ps] of this.peers) {
      if (!present.has(id)) {
        this.closePeer(ps);
        this.peers.delete(id);
      }
    }
    const preexisting = new Set(this.peers.keys());
    for (const p of msg.peers) {
      // We're the newcomer to these peers: we make the first offer.
      const { ps, created } = this.ensurePeer(p, { awaitOffer: false });
      if (created && this.screenStream) this.announceScreen(ps, true);
    }

    // Deliver what we tried to send while disconnected. Offers in that queue are
    // only now reaching the peer, so restart the unanswered-offer clock.
    const now = Date.now();
    for (const ps of this.peers.values()) if (ps.offerAt) ps.offerAt = now;
    const queued = this.outbox.splice(0);
    for (const q of queued) this.send({ type: "signal", to: q.to, data: q.data });

    // Anything mid-negotiation or broken when the link dropped: kick it.
    if (msg.resumed) {
      for (const id of preexisting) {
        const ps = this.peers.get(id);
        if (ps && ps.pc.connectionState !== "connected") this.restartIce(ps, "after resume");
      }
    }
    this.log(
      `joined room ${msg.room} as ${msg.selfId.slice(0, 8)} (resumed=${msg.resumed}, peers=${msg.peers.length}, ` +
        `sharedIce=${this.sharedIceServers.length}, flushed=${queued.length})`,
    );
    if (wasReconnecting) {
      this.cue("reconnect");
      this.setNotice(lostSeat ? "Reconnected — rejoined the room." : "Reconnected.");
    }
    this.emit();
  }

  // -- periodic work ----------------------------------------------------------

  private tick(): void {
    if (this.disposed) return;
    const now = Date.now();

    // Heartbeat: the browser can't tell us a socket is half-open, so we check.
    if (this.ws && this.joinedOnSocket) {
      if (now - this.lastServerMessageAt > HEARTBEAT_DEAD_MS) {
        this.log("heartbeat: no word from the server — treating the socket as dead");
        this.onSocketLost();
      } else if (now - this.lastPingAt > HEARTBEAT_EVERY_MS) {
        this.lastPingAt = now;
        this.send({ type: "ping" });
      }
    }

    this.updateSpeaking(now);

    if (now - this.lastWatchdogAt > 1_000) {
      this.lastWatchdogAt = now;
      this.watchdog(now);
    }
    if (now - this.lastStatsAt > 2_000) {
      this.lastStatsAt = now;
      void this.updateStats();
    }
  }

  /** Recover peer connections that are stuck. */
  private watchdog(now: number): void {
    for (const ps of this.peers.values()) {
      if (ps.away) continue; // their messages queue server-side; give them time
      const { pc } = ps;
      // The newcomer never offered (lost message, old client…): offer ourselves.
      if (ps.awaitingOffer && now - ps.createdAt > OFFER_TIMEOUT_MS / 3) {
        this.log(`no offer from ${ps.info.id.slice(0, 8)} — offering instead`);
        ps.awaitingOffer = false;
        ps.lastIceRestart = 0;
        this.restartIce(ps, "newcomer never offered"); // marks negotiation needed
      }
      if (pc.connectionState === "failed") {
        this.restartIce(ps, "connection failed");
      } else if (pc.connectionState === "disconnected" && ps.disconnectedAt && now - ps.disconnectedAt > DISCONNECTED_RESTART_MS) {
        this.restartIce(ps, "disconnected too long");
      }
      // Our offer went unanswered (lost in a reconnect, or the other side
      // ignored it in a collision): roll back and try again rather than wait forever.
      if (
        pc.signalingState === "have-local-offer" &&
        this.joinedOnSocket &&
        ps.offerAt > 0 &&
        now - ps.offerAt > OFFER_TIMEOUT_MS
      ) {
        this.log(`offer to ${ps.info.id.slice(0, 8)} unanswered — rolling back and retrying`);
        ps.offerAt = now;
        pc.setLocalDescription({ type: "rollback" })
          .then(() => {
            ps.lastIceRestart = 0;
            this.restartIce(ps, "unanswered offer");
          })
          .catch((err) => this.log(`rollback failed: ${String(err)}`));
      }
    }
  }

  private restartIce(ps: PeerState, why: string): void {
    const now = Date.now();
    if (now - ps.lastIceRestart < ICE_RESTART_MIN_GAP_MS) return;
    ps.lastIceRestart = now;
    this.log(`ICE restart with ${ps.info.id.slice(0, 8)} (${why})`);
    try {
      ps.pc.restartIce();
    } catch (err) {
      this.log(`restartIce failed: ${String(err)}`);
    }
  }

  /** Loudest ~21 ms chunk in the analyser's window (so short syllables register). */
  private loudness(analyser: AnalyserNode): number {
    const buf = this.analyserBuf;
    if (!buf) return 0;
    analyser.getFloatTimeDomainData(buf);
    let loudest = 0;
    for (let start = 0; start < buf.length; start += 1024) {
      let sum = 0;
      for (let i = start; i < start + 1024; i++) sum += buf[i] * buf[i];
      loudest = Math.max(loudest, Math.sqrt(sum / 1024));
    }
    return loudest;
  }

  /**
   * Speaking indicators. For ourselves: an analyser on the mic. For peers: the
   * receiver's cumulative audio energy, diffed between polls — it integrates
   * every sample, so speech can't slip between samples (unlike reading the last
   * RTP packet's level). Chromium feeds Web Audio silence from remote WebRTC
   * streams, so an analyser isn't an option for peers.
   */
  private updateSpeaking(now: number): void {
    if (now - this.lastPeerLevelAt >= PEER_LEVEL_EVERY_MS) {
      this.lastPeerLevelAt = now;
      for (const ps of this.peers.values()) void this.measurePeer(ps);
    }
    if (this.analyser && this.rawTrack && this.loudness(this.analyser) > SPEAKING_RMS) {
      this.selfSpeakingUntil = now + SPEAKING_HOLD_MS;
    }
    // Only re-render when someone starts/stops speaking.
    const key =
      (this.selfSpeakingUntil > now ? "s" : "-") +
      [...this.peers.values()].map((p) => (p.speakingUntil > now ? "1" : "0")).join("");
    if (key !== this.lastEmittedSpeaking) {
      this.lastEmittedSpeaking = key;
      this.emit();
    }
  }

  private async measurePeer(ps: PeerState): Promise<void> {
    const track = this.voiceStreamOf(ps)?.getAudioTracks()[0];
    if (!track || ps.pc.connectionState !== "connected") return;
    try {
      const report = await ps.pc.getStats(track);
      let total = -1;
      let duration = 0;
      report.forEach((s: { type: string; totalAudioEnergy?: number; totalSamplesDuration?: number }) => {
        if (s.type === "inbound-rtp" && typeof s.totalAudioEnergy === "number") {
          total = s.totalAudioEnergy;
          duration = s.totalSamplesDuration ?? 0;
        }
      });
      if (total < 0) return;
      const prev = ps.energy;
      ps.energy = { total, duration };
      if (!prev || duration <= prev.duration) return;
      // Mean power over the interval -> RMS (same 0..1 scale as the mic meter).
      const rms = Math.sqrt(Math.max(0, total - prev.total) / (duration - prev.duration));
      if (rms > SPEAKING_RMS) ps.speakingUntil = Date.now() + SPEAKING_HOLD_MS;
    } catch {
      /* best-effort */
    }
  }

  /** Round-trip time and relay usage, from the selected ICE candidate pair. */
  private async updateStats(): Promise<void> {
    let changed = false;
    for (const ps of this.peers.values()) {
      if (ps.pc.connectionState !== "connected") {
        if (ps.rttMs !== null) {
          ps.rttMs = null;
          changed = true;
        }
        continue;
      }
      try {
        const report = await ps.pc.getStats();
        let pairId: string | undefined;
        report.forEach((s: { type: string; selectedCandidatePairId?: string }) => {
          if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
        });
        let pair: { currentRoundTripTime?: number; localCandidateId?: string; remoteCandidateId?: string } | undefined;
        report.forEach((s: { type: string; id: string; nominated?: boolean; state?: string }) => {
          if (s.type !== "candidate-pair") return;
          if (pairId ? s.id === pairId : s.nominated && s.state === "succeeded") pair = s as typeof pair;
        });
        if (!pair) continue;
        const rtt = typeof pair.currentRoundTripTime === "number" ? Math.round(pair.currentRoundTripTime * 1000) : null;
        const local = pair.localCandidateId ? (report.get(pair.localCandidateId) as { candidateType?: string } | undefined) : undefined;
        const remote = pair.remoteCandidateId ? (report.get(pair.remoteCandidateId) as { candidateType?: string } | undefined) : undefined;
        const relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
        if (rtt !== ps.rttMs || relayed !== ps.relayed) {
          ps.rttMs = rtt;
          ps.relayed = relayed;
          changed = true;
        }
      } catch {
        /* stats are best-effort */
      }
    }
    if (changed) this.emit();
  }

  // -- microphone -------------------------------------------------------------

  /** mic -> gain -> (destination sent to peers) + (analyser for the meter). */
  private buildAudioGraph(): void {
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = this.settings.inputVolume;
      const dest = ctx.createMediaStreamDestination();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = METER_FFT;
      gain.connect(dest);
      gain.connect(analyser);
      void ctx.resume();
      this.audioCtx = ctx;
      this.gainNode = gain;
      this.analyser = analyser;
      this.analyserBuf = new Float32Array(analyser.fftSize);
      // Until a mic connects this track carries silence — which keeps the mesh
      // uniform for listen-only users (no special negotiation path).
      this.localStream = dest.stream;
    } catch (err) {
      this.log(`Web Audio unavailable, sending the raw mic: ${String(err)}`);
    }
  }

  private micConstraints(deviceId: string): MediaTrackConstraints {
    return {
      echoCancellation: this.settings.echoCancellation,
      noiseSuppression: this.settings.noiseSuppression,
      autoGainControl: this.settings.autoGainControl,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
  }

  /** Open (or switch to) a microphone. Never throws; on failure we stay listen-only. */
  private async openMic(deviceId: string): Promise<void> {
    let raw: MediaStream;
    try {
      raw = await navigator.mediaDevices.getUserMedia({ audio: this.micConstraints(deviceId) });
    } catch (err) {
      this.log(`getUserMedia(${deviceId || "default"}) failed: ${String(err)}`);
      if (deviceId) {
        // The chosen mic is gone or busy — fall back to the system default.
        this.settings.inputDeviceId = "";
        saveJson(SETTINGS_KEY, this.settings);
        this.setNotice("Your selected microphone isn't available — using the default one.");
        return this.openMic("");
      }
      this.micError =
        "Can't use your microphone, so others can't hear you (you can still listen). " +
        "Check Windows Settings → Privacy → Microphone, then pick a mic in ⚙ Settings.";
      this.emit();
      return;
    }
    if (this.disposed) {
      raw.getTracks().forEach((t) => t.stop());
      return;
    }
    const track = raw.getAudioTracks()[0];
    if (!track) return;

    this.micSource?.disconnect();
    this.rawTrack?.stop();
    this.rawTrack = track;
    this.micError = null;
    track.addEventListener("ended", () => {
      if (this.rawTrack !== track || this.disposed) return;
      this.log("microphone ended (unplugged?) — falling back to the default mic");
      this.setNotice("Your microphone was disconnected — switched to the default one.");
      void this.openMic("");
    });

    if (this.audioCtx && this.gainNode) {
      this.micSource = this.audioCtx.createMediaStreamSource(raw);
      this.micSource.connect(this.gainNode);
    } else {
      // No Web Audio: send the mic track directly, swapping it on every sender.
      track.enabled = !this.muted;
      const old = this.localStream?.getAudioTracks()[0];
      this.localStream = new MediaStream([track]);
      for (const ps of this.peers.values()) {
        const sender = ps.pc.getSenders().find((s) => s.track === old);
        if (sender) void sender.replaceTrack(track).catch(() => {});
        else ps.pc.addTrack(track, this.localStream);
      }
    }
    this.emit();
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.settings.inputDeviceId = deviceId;
    saveJson(SETTINGS_KEY, this.settings);
    this.emit();
    await this.openMic(deviceId);
  }

  setOutputDevice(deviceId: string): void {
    this.settings.outputDeviceId = deviceId;
    saveJson(SETTINGS_KEY, this.settings);
    this.emit();
  }

  /** Retry the mic after fixing permissions. */
  retryMic(): Promise<void> {
    return this.openMic(this.settings.inputDeviceId);
  }

  private readonly onDeviceChange = (): void => {
    void this.refreshDevices();
  };

  private async refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      // Windows lists virtual "default"/"communications" aliases; we offer our
      // own "System default" entry instead.
      const pick = (kind: MediaDeviceKind, noun: string): DeviceOption[] =>
        all
          .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
          .map((d, i) => ({ id: d.deviceId, label: d.label || `${noun} ${i + 1}` }));
      this.inputs = pick("audioinput", "Microphone");
      this.outputs = pick("audiooutput", "Speakers");
      this.emit();
    } catch (err) {
      this.log(`enumerateDevices failed: ${String(err)}`);
    }
  }

  // -- user actions -----------------------------------------------------------

  setMuted(muted: boolean): void {
    if (this.deafened && !muted) {
      // Unmuting while deafened undeafens too (that's what people expect).
      this.deafened = false;
    }
    if (muted === this.muted) {
      this.emit();
      return;
    }
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.cue(muted ? "mute" : "unmute");
    this.broadcastState();
    this.emit();
  }

  setDeafened(deafened: boolean): void {
    if (deafened === this.deafened) return;
    this.deafened = deafened;
    if (deafened) {
      this.mutedBeforeDeafen = this.muted;
      this.muted = true;
    } else {
      this.muted = this.mutedBeforeDeafen;
    }
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    this.cue(deafened ? "deafen" : "undeafen");
    this.broadcastState();
    this.emit();
  }

  transferHostTo(peerId: string): void {
    if (!this.send({ type: "transfer-host", to: peerId })) {
      this.setNotice("Not connected right now — try again in a moment.");
    }
  }

  setPeerVolume(peerId: string, value: number): void {
    const ps = this.peers.get(peerId);
    if (!ps) return;
    ps.outputVolume = Math.max(0, Math.min(1, value));
    this.emit();
  }

  setScreenVolume(peerId: string, value: number): void {
    const ps = this.peers.get(peerId);
    if (!ps) return;
    ps.screenVolume = Math.max(0, Math.min(1, value));
    this.emit();
  }

  dismissNotice(): void {
    this.setNotice(null);
  }

  /**
   * Host only: the tunnel was replaced and friends must use a new address.
   * Updates our invite link and tells every guest over WebRTC, which still works
   * even though their signaling link to the old address is dead.
   */
  announceServerMoved(url: string): void {
    this.inviteUrl = url;
    for (const ps of this.peers.values()) this.sendPeer(ps, { t: "server-moved", url });
    this.emit();
  }

  /** Update the invite URL without telling anyone (e.g. the tunnel is down). */
  setInviteUrl(url: string): void {
    this.inviteUrl = url;
    this.emit();
  }

  // -- audio settings (all local to this user) -------------------------------

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
    saveJson(SETTINGS_KEY, this.settings);
    this.emit();
  }

  setSounds(on: boolean): void {
    this.settings.sounds = on;
    saveJson(SETTINGS_KEY, this.settings);
    this.emit();
  }

  setShareSystemAudio(on: boolean): void {
    this.settings.shareSystemAudio = on;
    saveJson(SETTINGS_KEY, this.settings);
    this.emit();
  }

  /** Re-apply the DSP toggles to the live mic track without renegotiating. */
  private applyMicSettings(): void {
    const { echoCancellation, noiseSuppression, autoGainControl } = this.settings;
    void this.rawTrack?.applyConstraints({ echoCancellation, noiseSuppression, autoGainControl }).catch(() => {});
    saveJson(SETTINGS_KEY, this.settings);
    this.emit();
  }

  // -- screen sharing ---------------------------------------------------------

  /**
   * Capture the screen/window the user picked (chosen via
   * window.kootani.prepareScreenShare() first) and push it to every peer.
   * Returns an error message on failure.
   */
  async startScreenShare(): Promise<string | null> {
    if (this.screenStream) return null;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: screenConstraints(this.screenQuality),
        audio: this.settings.shareSystemAudio,
      });
    } catch (err) {
      this.log(`getDisplayMedia failed: ${String(err)}`);
      return "Couldn't capture that screen or window. It may have closed — try picking it again.";
    }
    if (this.disposed) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    this.screenStream = stream;
    const video = stream.getVideoTracks()[0];
    if (video) {
      video.contentHint = "motion"; // games: favour frame rate
      video.addEventListener("ended", () => this.stopScreenShare()); // Windows "Stop sharing" overlay
    }
    for (const ps of this.peers.values()) {
      stream.getTracks().forEach((t) => ps.pc.addTrack(t, stream));
      void this.tuneScreenSender(ps.pc);
      this.announceScreen(ps, true);
    }
    this.emit();
    return null;
  }

  /**
   * Change screen-share resolution/fps. Persists the choice; if a share is live,
   * re-applies the capture constraints and encoder bitrate without renegotiating.
   */
  async setScreenQuality(quality: ScreenQuality): Promise<void> {
    this.screenQuality = quality;
    saveJson(SCREEN_KEY, quality);
    const video = this.screenStream?.getVideoTracks()[0];
    if (video) {
      try {
        await video.applyConstraints(screenConstraints(quality));
      } catch (err) {
        this.log(`applyConstraints (screen) failed: ${String(err)}`);
      }
      for (const ps of this.peers.values()) void this.tuneScreenSender(ps.pc);
    }
    this.emit();
  }

  /** Stop sharing: drop the tracks from every peer (renegotiating) and notify them. */
  stopScreenShare(): void {
    const stream = this.screenStream;
    if (!stream) return;
    this.screenStream = null;
    const tracks = stream.getTracks();
    for (const ps of this.peers.values()) {
      for (const s of ps.pc.getSenders()) {
        if (s.track && tracks.includes(s.track)) ps.pc.removeTrack(s);
      }
      this.announceScreen(ps, false);
    }
    tracks.forEach((t) => t.stop());
    this.emit();
  }

  private announceScreen(ps: PeerState, on: boolean): void {
    this.sendSignal(ps.info.id, { kind: "screen", on, ...(on && this.screenStream ? { streamId: this.screenStream.id } : {}) });
  }

  /** Cap the screen sender's bitrate; shed resolution before frame rate under congestion. */
  private async tuneScreenSender(pc: RTCPeerConnection): Promise<void> {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = screenBitrate(this.screenQuality);
      params.degradationPreference = "maintain-framerate";
      await sender.setParameters(params);
    } catch {
      // Not negotiated yet or unsupported; retried after the next negotiation.
    }
  }

  /** Raise the Opus bitrate for clearer voice (default is ~32 kbps). */
  private async tuneAudioBitrate(pc: RTCPeerConnection): Promise<void> {
    const voiceTrack = this.localStream?.getAudioTracks()[0];
    const sender = pc.getSenders().find((s) => s.track === voiceTrack);
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = 64_000;
      await sender.setParameters(params);
    } catch {
      // Not supported everywhere; quality just falls back.
    }
  }

  // -- peers ------------------------------------------------------------------

  private iceServers(): RTCIceServer[] {
    const seen = new Set<string>();
    return [...ICE_SERVERS, ...(this.opts.extraIceServers ?? []), ...this.sharedIceServers].filter((s) => {
      const key = JSON.stringify(s);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private ensurePeer(info: PeerInfo, opts: { awaitOffer: boolean }): { ps: PeerState; created: boolean } {
    const existing = this.peers.get(info.id);
    if (existing) {
      existing.info = info;
      existing.away = Boolean(info.away);
      return { ps: existing, created: false };
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    // Both ends create the same pre-negotiated channel; no extra signaling needed.
    const dc = pc.createDataChannel("kootani", { negotiated: true, id: 0 });
    const ps: PeerState = {
      info,
      away: Boolean(info.away),
      pc,
      dc,
      remoteStreams: new Map(),
      remoteVoiceId: null,
      remoteScreenId: null,
      sharingScreen: false,
      connection: "new",
      pendingCandidates: [],
      outputVolume: 1,
      screenVolume: 1,
      speakingUntil: 0,
      energy: null,
      muted: null,
      deafened: null,
      rttMs: null,
      relayed: false,
      // Stable and opposite on the two ends.
      polite: (this.selfId ?? "") > info.id,
      awaitingOffer: opts.awaitOffer,
      createdAt: Date.now(),
      makingOffer: false,
      ignoreOffer: false,
      offerAt: 0,
      disconnectedAt: 0,
      lastIceRestart: 0,
    };
    this.peers.set(info.id, ps);

    dc.onopen = () => this.sendPeer(ps, { t: "state", muted: this.muted, deafened: this.deafened });
    dc.onmessage = (e) => this.onPeerMessage(ps, e.data);

    const voice = this.localStream;
    voice?.getAudioTracks().forEach((t) => pc.addTrack(t, voice));
    const screen = this.screenStream;
    if (screen) {
      screen.getTracks().forEach((t) => pc.addTrack(t, screen));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal(info.id, { kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      ps.remoteStreams.set(stream.id, stream);
      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) ps.remoteStreams.delete(stream.id);
        this.emit();
      };
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      ps.connection = pc.connectionState;
      this.log(`peer ${info.id.slice(0, 8)} connection: ${pc.connectionState}`);
      if (pc.connectionState === "disconnected") ps.disconnectedAt = Date.now();
      else ps.disconnectedAt = 0;
      if (pc.connectionState === "failed") this.restartIce(ps, "connection failed");
      if (pc.connectionState === "connected" && this.screenStream) void this.tuneScreenSender(pc);
      this.emit();
    };
    pc.onnegotiationneeded = async () => {
      if (ps.awaitingOffer) return; // the newcomer offers; we answer (see awaitingOffer)
      try {
        ps.makingOffer = true;
        ps.offerAt = Date.now();
        await pc.setLocalDescription();
        ps.offerAt = Date.now();
        await this.tuneAudioBitrate(pc);
        if (pc.localDescription) this.sendSdp(ps, pc.localDescription);
      } catch (err) {
        this.log(`negotiationneeded error for ${info.id.slice(0, 8)}: ${String(err)}`);
      } finally {
        ps.makingOffer = false;
      }
    };

    return { ps, created: true };
  }

  private closePeer(ps: PeerState): void {
    try {
      ps.dc.close();
    } catch {
      /* already closed */
    }
    ps.pc.close();
  }

  private sendSdp(ps: PeerState, description: RTCSessionDescription): void {
    this.sendSignal(ps.info.id, {
      kind: "sdp",
      description: description.toJSON() as RTCSessionDescriptionInit,
      streams: { voice: this.localStream?.id ?? null, screen: this.screenStream?.id ?? null },
    });
  }

  private sendPeer(ps: PeerState, msg: PeerMessage): void {
    if (ps.dc.readyState !== "open") return;
    try {
      ps.dc.send(JSON.stringify(msg));
    } catch {
      /* channel closing */
    }
  }

  private broadcastState(): void {
    for (const ps of this.peers.values()) {
      this.sendPeer(ps, { t: "state", muted: this.muted, deafened: this.deafened });
    }
  }

  private onPeerMessage(ps: PeerState, raw: unknown): void {
    let msg: PeerMessage;
    try {
      msg = JSON.parse(String(raw)) as PeerMessage;
    } catch {
      return;
    }
    if (msg.t === "state") {
      ps.muted = Boolean(msg.muted);
      ps.deafened = Boolean(msg.deafened);
      this.emit();
    } else if (msg.t === "server-moved" && typeof msg.url === "string" && /^wss?:\/\//.test(msg.url)) {
      if (msg.url === this.signalingUrl) return;
      this.log(`server moved to ${msg.url} (told by ${ps.info.id.slice(0, 8)})`);
      this.signalingUrl = msg.url;
      this.inviteUrl = msg.url;
      this.setNotice("The host's connection changed — reconnecting…");
      // Drop the dead socket and try the new address right away (resuming our seat).
      if (this.status === "closed") this.reconnect();
      else if (!this.joinedOnSocket) {
        if (this.ws) this.onSocketLost();
        else this.scheduleReconnect(500);
      }
    }
  }

  private async onSignal(from: string, data: SignalData): Promise<void> {
    const ps = this.peers.get(from);
    if (!ps || !data || typeof data !== "object") return; // peer-joined creates it; ignore strays

    if (data.kind === "screen") {
      ps.sharingScreen = data.on;
      if (data.on && data.streamId) ps.remoteScreenId = data.streamId;
      if (!data.on) ps.remoteScreenId = null;
      this.emit();
      return;
    }

    if (data.kind === "ice") {
      // Buffer until we have a remote description; suppress errors for a candidate
      // belonging to an offer we deliberately ignored during a collision.
      if (ps.pc.remoteDescription) {
        await ps.pc.addIceCandidate(data.candidate).catch((err) => {
          if (!ps.ignoreOffer) this.log(`addIceCandidate failed for ${from.slice(0, 8)}: ${String(err)}`);
        });
      } else {
        ps.pendingCandidates.push(data.candidate);
      }
      return;
    }

    if (data.kind !== "sdp") return;
    const desc = data.description;
    if (data.streams) {
      ps.remoteVoiceId = data.streams.voice;
      ps.remoteScreenId = data.streams.screen;
      ps.sharingScreen = data.streams.screen !== null;
      if (data.streams.screen === null) {
        // Forget any old screen stream so a later share starts clean.
        for (const id of [...ps.remoteStreams.keys()]) if (id !== data.streams.voice) ps.remoteStreams.delete(id);
      }
    }

    if (desc.type === "offer") ps.awaitingOffer = false;
    const collision = desc.type === "offer" && (ps.makingOffer || ps.pc.signalingState !== "stable");
    ps.ignoreOffer = !ps.polite && collision;
    if (ps.ignoreOffer) return; // impolite peer keeps its own offer

    try {
      // On the polite side a collision is resolved by setRemoteDescription, which
      // implicitly rolls back our own offer.
      await ps.pc.setRemoteDescription(desc);
      await this.drainCandidates(ps);
      if (desc.type === "offer") {
        await ps.pc.setLocalDescription(); // implicit answer
        await this.tuneAudioBitrate(ps.pc);
        if (ps.pc.localDescription) this.sendSdp(ps, ps.pc.localDescription);
      } else if (this.screenStream) {
        void this.tuneScreenSender(ps.pc);
      }
      this.emit();
    } catch (err) {
      this.log(`onSignal error for ${from.slice(0, 8)}: ${String(err)}`);
    }
  }

  private async drainCandidates(ps: PeerState): Promise<void> {
    const pending = ps.pendingCandidates.splice(0);
    for (const c of pending) await ps.pc.addIceCandidate(c).catch(() => {});
  }

  /** The peer's voice stream, preferring what they told us over guessing. */
  private voiceStreamOf(ps: PeerState): MediaStream | null {
    if (ps.remoteVoiceId) {
      const s = ps.remoteStreams.get(ps.remoteVoiceId);
      if (s) return s;
    }
    for (const s of ps.remoteStreams.values()) {
      if (s.id !== ps.remoteScreenId && s.getVideoTracks().length === 0) return s;
    }
    return null;
  }

  private screenStreamOf(ps: PeerState): MediaStream | null {
    if (!ps.sharingScreen) return null;
    if (ps.remoteScreenId) {
      const s = ps.remoteStreams.get(ps.remoteScreenId);
      if (s) return s;
    }
    for (const s of ps.remoteStreams.values()) if (s.getVideoTracks().length > 0) return s;
    return null;
  }

  // -- state ------------------------------------------------------------------

  /** Play a sound cue (never while deafened, except the deafen cue itself). */
  private cue(cue: SoundCue): void {
    if (!this.settings.sounds || (this.deafened && cue !== "deafen")) return;
    playCue(cue, this.settings.outputDeviceId);
  }

  private setNotice(message: string | null): void {
    this.notice = message;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = message
      ? setTimeout(() => {
          this.notice = null;
          this.emit();
        }, NOTICE_MS)
      : null;
    this.emit();
  }

  private fail(message: string): void {
    this.error = message;
    this.status = "error";
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    this.joinedOnSocket = false;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.emit();
  }

  private emit(): void {
    if (!this.disposed) this.opts.onState(this.snapshot());
  }

  snapshot(): RoomSnapshot {
    const now = Date.now();
    const peers: PeerView[] = [...this.peers.values()].map((p) => ({
      id: p.info.id,
      user: p.info.user,
      isHost: p.info.id === this.hostId,
      away: p.away,
      stream: this.voiceStreamOf(p),
      screenStream: this.screenStreamOf(p),
      sharingScreen: p.sharingScreen,
      connection: p.connection,
      speaking: p.speakingUntil > now,
      muted: p.muted,
      deafened: p.deafened,
      rttMs: p.rttMs,
      relayed: p.relayed,
      outputVolume: p.outputVolume,
      screenVolume: p.screenVolume,
    }));

    return {
      status: this.status,
      room: this.opts.room,
      inviteUrl: this.inviteUrl,
      connectAttempt: this.connectAttempt,
      selfId: this.selfId,
      hostId: this.hostId,
      self: this.opts.user,
      isSelfHost: this.selfId !== null && this.selfId === this.hostId,
      muted: this.muted,
      deafened: this.deafened,
      selfSpeaking: this.selfSpeakingUntil > now,
      micError: this.micError,
      sharing: this.screenStream !== null,
      localScreenStream: this.screenStream,
      screenQuality: { ...this.screenQuality },
      settings: { ...this.settings },
      inputs: this.inputs,
      outputs: this.outputs,
      peers,
      error: this.error,
      notice: this.notice,
    };
  }
}
