import { useCallback, useEffect, useRef, useState } from "react";
import type { UserInfo } from "@shared/protocol";
import type { KootaniConfig } from "@shared/ipc";
import { RoomClient, type MediaSettings, type RoomSnapshot } from "./lib/RoomClient";
import { decodeJoinLink, encodeJoinLink, normalizeWsUrl } from "./lib/joinlink";
import { RemoteAudio } from "./components/RemoteAudio";

type Phase = "login" | "lobby" | "room";

function randomRoomCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no easily-confused chars
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(
    "",
  );
}

export function App(): JSX.Element {
  const [config, setConfig] = useState<KootaniConfig | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [signalingUrl, setSignalingUrl] = useState("");
  // The address shown in the room's invite bar — what friends connect to. For a
  // self-hosted room this is the public tunnel URL, which is NOT the same as the
  // URL this PC connects to (loopback); see enterRoom.
  const [inviteUrl, setInviteUrl] = useState("");
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const clientRef = useRef<RoomClient | null>(null);
  // True when this PC is running the signaling server/tunnel for the session,
  // so leaving the room must also tear those down.
  const selfHostedRef = useRef(false);

  useEffect(() => {
    window.kootani.getConfig().then((c) => {
      setConfig(c);
      setSignalingUrl(c.signalingUrl);
    });
  }, []);

  const enterRoom = useCallback(
    (room: string, connectUrl: string, opts?: { selfHosted?: boolean; inviteUrl?: string }) => {
      if (!user) return;
      // The URL we connect to and the URL we hand to friends can differ: a host
      // connects to its own server over loopback while friends use the tunnel URL.
      const connect = normalizeWsUrl(connectUrl);
      setInviteUrl(normalizeWsUrl(opts?.inviteUrl ?? connectUrl));
      selfHostedRef.current = opts?.selfHosted ?? false;
      const client = new RoomClient({
        signalingUrl: connect,
        room,
        user,
        onState: setSnapshot,
      });
      clientRef.current = client;
      setSnapshot(client.snapshot());
      void client.connect();
    },
    [user],
  );

  const leaveRoom = useCallback(() => {
    clientRef.current?.leave();
    clientRef.current = null;
    setSnapshot(null);
    if (selfHostedRef.current) {
      selfHostedRef.current = false;
      void window.kootani.stopHosting();
    }
  }, []);

  const phase: Phase = !user ? "login" : snapshot ? "room" : "lobby";

  return (
    <div className="app">
      {phase === "login" && <Login config={config} onLogin={setUser} />}
      {phase === "lobby" && user && (
        <Lobby
          user={user}
          defaultUrl={signalingUrl}
          onEnter={enterRoom}
          onSignOut={() => setUser(null)}
        />
      )}
      {phase === "room" && snapshot && (
        <Room
          snapshot={snapshot}
          client={clientRef.current!}
          inviteUrl={inviteUrl}
          onLeave={leaveRoom}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Login({
  config,
  onLogin,
}: {
  config: KootaniConfig | null;
  onLogin: (u: UserInfo) => void;
}): JSX.Element {
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInWithGoogle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onLogin(await window.kootani.googleLogin());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <div className="card login">
        <h1 className="brand">Kootani</h1>
        <p className="tagline">கூட்டணி — your alliance, in voice.</p>

        <button
          className="btn primary"
          disabled={busy || !config?.googleConfigured}
          onClick={signInWithGoogle}
        >
          {busy ? "Opening browser…" : "Sign in with Google"}
        </button>
        {config && !config.googleConfigured && (
          <p className="hint">
            Google sign-in isn't configured yet (see README). Use a nickname for now.
          </p>
        )}

        <div className="divider">
          <span>or</span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (nickname.trim()) onLogin({ name: nickname.trim() });
          }}
        >
          <input
            className="input"
            placeholder="Nickname (for testing)"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={24}
          />
          <button className="btn" type="submit" disabled={!nickname.trim()}>
            Continue
          </button>
        </form>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Lobby({
  user,
  defaultUrl,
  onEnter,
  onSignOut,
}: {
  user: UserInfo;
  defaultUrl: string;
  onEnter: (
    room: string,
    connectUrl: string,
    opts?: { selfHosted?: boolean; inviteUrl?: string },
  ) => void;
  onSignOut: () => void;
}): JSX.Element {
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const [hosting, setHosting] = useState(false);
  const [hostStatus, setHostStatus] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [serverUrl, setServerUrl] = useState(defaultUrl);

  const joinByLink = (): void => {
    const target = decodeJoinLink(link);
    if (!target) {
      const looksLikeRoomCode = /^[a-z0-9]{4,10}$/i.test(link.trim());
      setLinkError(
        looksLikeRoomCode
          ? "That's the room code, not the join link. Ask the host to click “Copy link” and paste the whole thing here."
          : "That doesn't look like a valid join link.",
      );
      return;
    }
    onEnter(target.room, target.url);
  };

  // One click: the app starts the signaling server + tunnel for you, then hosts.
  const hostOneClick = async (): Promise<void> => {
    setHosting(true);
    setHostError(null);
    setHostStatus("Starting…");
    const unsubscribe = window.kootani.onHostStatus(setHostStatus);
    try {
      const { url, localUrl } = await window.kootani.startHosting();
      // Connect to our own server over loopback; share the tunnel URL with friends.
      onEnter(randomRoomCode(), localUrl, { selfHosted: true, inviteUrl: url }); // navigates away on success
    } catch (e) {
      setHostError(e instanceof Error ? e.message : "Couldn't start hosting.");
      void window.kootani.stopHosting();
      setHosting(false);
    } finally {
      unsubscribe();
    }
  };

  const isLocal = /localhost|127\.0\.0\.1/.test(serverUrl);

  return (
    <div className="centered">
      <div className="card lobby">
        <Identity user={user} />

        <label className="field-label">Join a friend's room</label>
        <form
          className="join-row"
          onSubmit={(e) => {
            e.preventDefault();
            joinByLink();
          }}
        >
          <input
            className="input"
            placeholder="Paste the host's join link (not the room code)"
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setLinkError(null);
            }}
            disabled={hosting}
          />
          <button className="btn" type="submit" disabled={!link.trim() || hosting}>
            Join
          </button>
        </form>
        {linkError && <p className="error">{linkError}</p>}

        <div className="divider">
          <span>or host your own</span>
        </div>

        <button className="btn primary big" onClick={hostOneClick} disabled={hosting}>
          {hosting ? "Setting up…" : "Host a new room"}
        </button>
        {hosting && (
          <p className="host-status">
            <span className="spinner" /> {hostStatus}
          </p>
        )}
        {!hosting && (
          <p className="hint">
            Your PC becomes the server and a secure link is created automatically —
            no setup, free.
          </p>
        )}
        {hostError && <p className="error">{hostError}</p>}

        {!hosting && (
          <>
            <button
              className="link advanced-toggle"
              onClick={() => setShowAdvanced((s) => !s)}
            >
              {showAdvanced ? "▾ " : "▸ "}Advanced: use a custom server address
            </button>
            {showAdvanced && (
              <div className="advanced">
                <label className="field-label">
                  Server address{" "}
                  <span className="hint-inline">
                    {isLocal ? "(local — for testing on this PC)" : "(e.g. from “npm run host”)"}
                  </span>
                </label>
                <input
                  className="input"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="wss://something.trycloudflare.com"
                />
                <button
                  className="btn"
                  onClick={() => onEnter(randomRoomCode(), serverUrl)}
                  disabled={!serverUrl.trim()}
                >
                  Host with this address
                </button>
              </div>
            )}
          </>
        )}

        <button className="link" onClick={onSignOut} disabled={hosting}>
          Sign out
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Room({
  snapshot,
  client,
  inviteUrl,
  onLeave,
}: {
  snapshot: RoomSnapshot;
  client: RoomClient;
  inviteUrl: string;
  onLeave: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const joinLink = encodeJoinLink({ url: inviteUrl, room: snapshot.room });

  const copyLink = (): void => {
    void window.kootani.copyText(joinLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="room">
      <header className="room-header">
        <div>
          <span className="room-label">Room</span>
          <span className="room-code">{snapshot.room}</span>
        </div>
        <div className="status-line">
          <ConnDot status={snapshot.status} />
          <span>
            {snapshot.status === "connecting" && "Connecting…"}
            {snapshot.status === "connected" && `${snapshot.peers.length + 1} in room`}
            {snapshot.status === "closed" && "Disconnected"}
            {snapshot.status === "error" && (snapshot.error ?? "Error")}
          </span>
        </div>
        <div className="header-actions">
          <button
            className={`btn small ${showSettings ? "primary" : ""}`}
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙ Audio
          </button>
          <button className="btn danger" onClick={onLeave}>
            Leave
          </button>
        </div>
      </header>

      <div className="invite-bar">
        <span className="field-label">Invite link</span>
        <input
          className="input invite-input"
          readOnly
          value={joinLink}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button className="btn small" onClick={copyLink}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>

      {showSettings && <AudioSettings settings={snapshot.settings} client={client} />}

      {snapshot.error && snapshot.status !== "error" && (
        <div className="banner">{snapshot.error}</div>
      )}

      <ul className="peer-grid">
        {/* Self */}
        <li className="peer self">
          <div className="peer-row">
            <Avatar user={snapshot.self} />
            <div className="peer-meta">
              <span className="peer-name">
                {snapshot.self.name} <em>(you)</em>
              </span>
              <span className="badges">
                {snapshot.isSelfHost && <span className="badge host">HOST</span>}
                {snapshot.muted && <span className="badge muted">MUTED</span>}
              </span>
            </div>
            <button
              className={`btn ${snapshot.muted ? "" : "primary"}`}
              onClick={() => client.setMuted(!snapshot.muted)}
            >
              {snapshot.muted ? "Unmute" : "Mute"}
            </button>
          </div>
        </li>

        {/* Peers */}
        {snapshot.peers.map((peer) => (
          <li className="peer" key={peer.id}>
            <div className="peer-row">
              <Avatar user={peer.user} />
              <div className="peer-meta">
                <span className="peer-name">{peer.user.name}</span>
                <span className="badges">
                  {peer.isHost && <span className="badge host">HOST</span>}
                  <span className={`conn ${peer.connection}`}>{peer.connection}</span>
                </span>
              </div>
              {snapshot.isSelfHost && !peer.isHost && (
                <button className="btn small" onClick={() => client.transferHostTo(peer.id)}>
                  Make host
                </button>
              )}
            </div>
            <div className="peer-volume">
              <span className="vol-icon">🔊</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={peer.outputVolume}
                onChange={(e) => client.setPeerVolume(peer.id, Number(e.target.value))}
              />
              <span className="slider-val">{Math.round(peer.outputVolume * 100)}%</span>
            </div>
            <RemoteAudio stream={peer.stream} volume={peer.outputVolume} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AudioSettings({
  settings,
  client,
}: {
  settings: MediaSettings;
  client: RoomClient;
}): JSX.Element {
  return (
    <div className="settings-panel">
      <div className="settings-title">
        Your microphone <span className="hint-inline">— these only affect you</span>
      </div>
      <div className="settings-grid">
        <Toggle
          label="Echo cancellation"
          checked={settings.echoCancellation}
          onChange={(v) => client.setEchoCancellation(v)}
        />
        <Toggle
          label="Noise suppression"
          checked={settings.noiseSuppression}
          onChange={(v) => client.setNoiseSuppression(v)}
        />
        <Toggle
          label="Auto gain"
          checked={settings.autoGainControl}
          onChange={(v) => client.setAutoGainControl(v)}
        />
      </div>
      <div className="slider-row">
        <span className="slider-label">Input volume</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={settings.inputVolume}
          onChange={(e) => client.setInputVolume(Number(e.target.value))}
        />
        <span className="slider-val">{Math.round(settings.inputVolume * 100)}%</span>
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------

function Identity({ user }: { user: UserInfo }): JSX.Element {
  return (
    <div className="identity">
      <Avatar user={user} />
      <div>
        <div className="peer-name">{user.name}</div>
        {user.email && <div className="hint">{user.email}</div>}
      </div>
    </div>
  );
}

function Avatar({ user }: { user: UserInfo }): JSX.Element {
  if (user.picture) {
    return <img className="avatar" src={user.picture} alt={user.name} referrerPolicy="no-referrer" />;
  }
  const initial = user.name.trim().charAt(0).toUpperCase() || "?";
  return <div className="avatar fallback">{initial}</div>;
}

function ConnDot({ status }: { status: RoomSnapshot["status"] }): JSX.Element {
  return <span className={`dot ${status}`} />;
}
