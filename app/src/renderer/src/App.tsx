import { useCallback, useEffect, useRef, useState } from "react";
import type { UserInfo } from "@shared/protocol";
import type { KootaniConfig, ShortcutAction } from "@shared/ipc";
import { RoomClient, type RoomSnapshot } from "./lib/RoomClient";
import { normalizeWsUrl } from "./lib/joinlink";
import { loadJson, removeKey, saveJson } from "./lib/storage";
import { Login } from "./components/Login";
import { Lobby, type EnterOptions } from "./components/Lobby";
import { Room } from "./components/Room";

const USER_KEY = "kootani.user";
/** After a new tunnel is up, give Cloudflare's edge a moment before sending guests to it. */
const SERVER_MOVE_DELAY_MS = 8_000;

function loadUser(): UserInfo | null {
  const u = loadJson<{ name: string; email: string; picture: string }>(USER_KEY, { name: "", email: "", picture: "" });
  if (!u.name) return null;
  return { name: u.name, ...(u.email ? { email: u.email } : {}), ...(u.picture ? { picture: u.picture } : {}) };
}

export function App(): JSX.Element {
  const [config, setConfig] = useState<KootaniConfig | null>(null);
  // Remembered between launches — no signing in every time.
  const [user, setUser] = useState<UserInfo | null>(loadUser);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [hostBanner, setHostBanner] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState<ShortcutAction[]>([]);
  const clientRef = useRef<RoomClient | null>(null);
  // True when this PC runs the signaling server/tunnel for the session, so
  // leaving the room must also tear those down.
  const selfHostedRef = useRef(false);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    window.kootani.getConfig().then(setConfig, () =>
      setConfig({ version: "?", signalingUrl: "ws://localhost:8787", googleConfigured: false, iceServers: [] }),
    );
  }, []);

  const signIn = useCallback((u: UserInfo) => {
    saveJson(USER_KEY, { name: u.name, email: u.email ?? "", picture: u.picture ?? "" });
    setUser(u);
  }, []);

  const signOut = useCallback(() => {
    removeKey(USER_KEY);
    setUser(null);
  }, []);

  const enterRoom = useCallback(
    (room: string, connectUrl: string, opts?: EnterOptions) => {
      if (!user) return;
      clientRef.current?.leave();
      // The URL we connect to and the URL we hand to friends can differ: a host
      // connects to its own server over loopback while friends use the tunnel URL.
      selfHostedRef.current = opts?.selfHosted ?? false;
      setHostBanner(null);
      const client = new RoomClient({
        signalingUrl: normalizeWsUrl(connectUrl),
        inviteUrl: normalizeWsUrl(opts?.inviteUrl ?? connectUrl),
        room,
        user,
        onState: setSnapshot,
        extraIceServers: config?.iceServers,
      });
      clientRef.current = client;
      setSnapshot(client.snapshot());
      window.kootani.setInRoom(true);
      void window.kootani.setShortcutsEnabled(true).then(setShortcuts);
      void client.connect();
    },
    [user, config],
  );

  const leaveRoom = useCallback(() => {
    if (moveTimer.current) clearTimeout(moveTimer.current);
    clientRef.current?.leave();
    clientRef.current = null;
    setSnapshot(null);
    setHostBanner(null);
    window.kootani.setInRoom(false);
    void window.kootani.setShortcutsEnabled(false);
    if (selfHostedRef.current) {
      selfHostedRef.current = false;
      void window.kootani.stopHosting();
    }
  }, []);

  // Global hotkeys (mute/deafen), delivered by the main process.
  useEffect(
    () =>
      window.kootani.onShortcut((action) => {
        const client = clientRef.current;
        if (!client) return;
        const s = client.snapshot();
        if (action === "toggle-mute") client.setMuted(!s.muted);
        else client.setDeafened(!s.deafened);
      }),
    [],
  );

  // The host's tunnel died and was replaced: update the invite and move guests over.
  useEffect(
    () =>
      window.kootani.onHostEvent((e) => {
        const client = clientRef.current;
        if (!client || !selfHostedRef.current) return;
        if (e.type === "tunnel-down") {
          setHostBanner("Your internet tunnel dropped — reopening it. Voice keeps working for people already here.");
        } else if (e.type === "tunnel-up") {
          client.setInviteUrl(e.url);
          setHostBanner("Tunnel restored with a new invite link. Friends in the room are moved over automatically.");
          if (moveTimer.current) clearTimeout(moveTimer.current);
          moveTimer.current = setTimeout(() => {
            client.announceServerMoved(e.url);
            setHostBanner(null);
          }, SERVER_MOVE_DELAY_MS);
        } else if (e.type === "tunnel-failed") {
          setHostBanner(e.message);
        }
      }),
    [],
  );

  // Config comes back from the main process almost instantly; wait for it so
  // the lobby's defaults are right on first paint.
  if (!config) return <div className="app" />;

  const phase = !user ? "login" : snapshot ? "room" : "lobby";

  return (
    <div className="app">
      {phase === "login" && <Login config={config} onLogin={signIn} />}
      {phase === "lobby" && user && (
        <Lobby
          user={user}
          version={config.version}
          defaultUrl={config.signalingUrl}
          onEnter={enterRoom}
          onSignOut={signOut}
        />
      )}
      {phase === "room" && snapshot && clientRef.current && (
        <Room
          snapshot={snapshot}
          client={clientRef.current}
          selfHosted={selfHostedRef.current}
          hostBanner={hostBanner}
          shortcuts={shortcuts}
          version={config.version}
          onLeave={leaveRoom}
        />
      )}
    </div>
  );
}
