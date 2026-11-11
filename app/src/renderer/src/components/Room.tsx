import { useRef, useState } from "react";
import type { ShortcutAction } from "@shared/ipc";
import type { RoomClient, RoomSnapshot } from "../lib/RoomClient";
import { encodeJoinLink, isLoopbackUrl } from "../lib/joinlink";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { PeerTile } from "./PeerTile";
import { QualityControls } from "./QualityControls";
import { ScreenPicker } from "./ScreenPicker";
import { ScreenVideo } from "./ScreenVideo";
import { SettingsPanel } from "./SettingsPanel";

function statusText(s: RoomSnapshot): string {
  switch (s.status) {
    case "connecting":
      return s.connectAttempt > 3 ? `Still trying to reach the host… (attempt ${s.connectAttempt})` : "Connecting…";
    case "connected":
      return `${s.peers.length + 1} in room`;
    case "reconnecting":
      return "Reconnecting…";
    case "closed":
      return s.error ?? "Disconnected";
    case "error":
      return "Couldn't join";
  }
}

export function Room({
  snapshot,
  client,
  selfHosted,
  hostBanner,
  shortcuts,
  version,
  onLeave,
}: {
  snapshot: RoomSnapshot;
  client: RoomClient;
  selfHosted: boolean;
  /** Tunnel trouble, shown to the person hosting. */
  hostBanner: string | null;
  shortcuts: ShortcutAction[];
  version: string;
  onLeave: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const joinLink = encodeJoinLink({ url: snapshot.inviteUrl, room: snapshot.room });
  const sinkId = snapshot.settings.outputDeviceId;

  const copyLink = (): void => {
    void window.kootani.copyText(joinLink);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  };

  const pickSource = async (sourceId: string): Promise<void> => {
    setPicking(false);
    setShareError(null);
    await window.kootani.prepareScreenShare(sourceId, snapshot.settings.shareSystemAudio);
    setShareError(await client.startScreenShare());
  };

  const requestLeave = (): void => {
    const othersConnected = snapshot.peers.length > 0;
    if (selfHosted && othersConnected) setConfirmLeave(true);
    else onLeave();
  };

  // Fatal error before ever getting in: a focused message instead of an empty room.
  if (snapshot.status === "error" && snapshot.peers.length === 0) {
    return (
      <div className="centered">
        <div className="card">
          <h2 className="card-title">Couldn't join the room</h2>
          <p className="card-body">{snapshot.error}</p>
          <div className="confirm-actions">
            <button className="btn small" onClick={onLeave}>
              Back
            </button>
            <button className="btn small primary" onClick={() => client.reconnect()}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Self-preview first (muted), then any peers actively sharing (with sound).
  const screenShares = [
    ...(snapshot.sharing && snapshot.localScreenStream
      ? [{ id: "self", label: "You", stream: snapshot.localScreenStream, self: true, volume: 1, hasAudio: false }]
      : []),
    ...snapshot.peers
      .filter((p) => p.screenStream)
      .map((p) => ({
        id: p.id,
        label: p.user.name,
        stream: p.screenStream!,
        self: false,
        volume: p.screenVolume,
        hasAudio: p.screenStream!.getAudioTracks().length > 0,
      })),
  ];

  const showReconnectBanner = snapshot.status === "reconnecting";
  const localOnly = isLoopbackUrl(snapshot.inviteUrl);

  return (
    <div className="room">
      <header className="room-header">
        <div className="room-title">
          <span className="room-label">Room</span>
          <span className="room-code">{snapshot.room}</span>
        </div>
        <div className="status-line" role="status">
          <span className={`dot ${snapshot.status}`} />
          <span>{statusText(snapshot)}</span>
          {(snapshot.status === "closed" || snapshot.status === "error") && (
            <button className="btn small" onClick={() => client.reconnect()}>
              Reconnect
            </button>
          )}
        </div>
      </header>

      <div className="invite-bar">
        <span className="field-label">Invite link</span>
        <input
          className="input invite-input"
          readOnly
          value={joinLink}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Invite link"
        />
        <button className="btn small primary" onClick={copyLink}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      {localOnly && (
        <div className="banner warn">
          This invite uses a local address, so it only works on this PC. Use “Host a new room” to invite friends over the
          internet.
        </div>
      )}

      {hostBanner && <div className="banner warn">{hostBanner}</div>}
      {showReconnectBanner && (
        <div className="banner warn">
          <span className="spinner" /> Lost the connection to the room — reconnecting. Voice with people you're already
          connected to keeps working.
        </div>
      )}
      {snapshot.micError && (
        <div className="banner danger">
          {snapshot.micError}{" "}
          <button className="link inline" onClick={() => void client.retryMic()}>
            Try again
          </button>
        </div>
      )}
      {(snapshot.notice || shareError) && (
        <div className="banner">
          <span>{shareError ?? snapshot.notice}</span>
          <button
            className="link inline banner-close"
            aria-label="Dismiss"
            onClick={() => {
              setShareError(null);
              client.dismissNotice();
            }}
          >
            ✕
          </button>
        </div>
      )}

      <div className="room-body">
        {screenShares.length > 0 && (
          <div className={`screen-stage ${screenShares.length > 1 ? "multi" : ""}`}>
            {screenShares.map((share) => (
              <ScreenTile
                key={share.id}
                label={share.label}
                stream={share.stream}
                self={share.self}
                muted={share.self || snapshot.deafened}
                volume={share.volume}
                hasAudio={share.hasAudio}
                sinkId={sinkId}
                onVolume={(v) => client.setScreenVolume(share.id, v)}
                controls={
                  share.self ? (
                    <QualityControls
                      quality={snapshot.screenQuality}
                      onChange={(q) => void client.setScreenQuality(q)}
                      compact
                    />
                  ) : null
                }
              />
            ))}
          </div>
        )}

        <ul className="peer-grid">
          <li className={`peer self ${snapshot.selfSpeaking && !snapshot.muted ? "talking" : ""}`}>
            <div className="peer-row">
              <Avatar user={snapshot.self} speaking={snapshot.selfSpeaking && !snapshot.muted} />
              <div className="peer-meta">
                <span className="peer-name">
                  {snapshot.self.name} <em>(you)</em>
                </span>
                <span className="badges">
                  {snapshot.isSelfHost && <span className="badge host">HOST</span>}
                  {snapshot.deafened ? (
                    <span className="badge muted">DEAFENED</span>
                  ) : (
                    snapshot.muted && <span className="badge muted">MUTED</span>
                  )}
                  {snapshot.sharing && <span className="badge live">LIVE</span>}
                </span>
              </div>
            </div>
            {snapshot.muted && snapshot.selfSpeaking && !snapshot.deafened && (
              <p className="peer-hint">You're muted — nobody can hear you.</p>
            )}
          </li>

          {snapshot.peers.map((peer) => (
            <PeerTile
              key={peer.id}
              peer={peer}
              client={client}
              canTransferHost={snapshot.isSelfHost}
              deafened={snapshot.deafened}
              sinkId={sinkId}
            />
          ))}

          {snapshot.peers.length === 0 && snapshot.status === "connected" && (
            <li className="peer empty">
              <strong>It's just you so far.</strong>
              <span>Copy the invite link above and send it to your friends.</span>
            </li>
          )}
        </ul>
      </div>

      {showSettings && (
        <SettingsPanel
          snapshot={snapshot}
          client={client}
          shortcuts={shortcuts}
          version={version}
          onClose={() => setShowSettings(false)}
        />
      )}

      <footer className="control-bar">
        <button
          className={`ctl ${snapshot.muted ? "off" : ""}`}
          onClick={() => client.setMuted(!snapshot.muted)}
          title={`${snapshot.muted ? "Unmute" : "Mute"} (Ctrl+Shift+M)`}
          aria-pressed={snapshot.muted}
        >
          <span className="ctl-icon">{snapshot.muted ? "🔇" : "🎙"}</span>
          {snapshot.muted ? "Unmute" : "Mute"}
        </button>
        <button
          className={`ctl ${snapshot.deafened ? "off" : ""}`}
          onClick={() => client.setDeafened(!snapshot.deafened)}
          title={`${snapshot.deafened ? "Undeafen" : "Deafen"} (Ctrl+Shift+D)`}
          aria-pressed={snapshot.deafened}
        >
          <span className="ctl-icon">{snapshot.deafened ? "🙉" : "🎧"}</span>
          {snapshot.deafened ? "Undeafen" : "Deafen"}
        </button>
        {snapshot.sharing ? (
          <button className="ctl live" onClick={() => client.stopScreenShare()}>
            <span className="ctl-icon">⏹</span>
            Stop sharing
          </button>
        ) : (
          <button className="ctl" onClick={() => setPicking(true)} disabled={snapshot.status !== "connected"}>
            <span className="ctl-icon">🖥</span>
            Share screen
          </button>
        )}
        <button
          className={`ctl ${showSettings ? "active" : ""}`}
          onClick={() => setShowSettings((s) => !s)}
          aria-pressed={showSettings}
        >
          <span className="ctl-icon">⚙</span>
          Settings
        </button>
        <span className="ctl-spacer" />
        <button className="ctl leave" onClick={requestLeave}>
          <span className="ctl-icon">📞</span>
          Leave
        </button>
      </footer>

      {picking && (
        <ScreenPicker
          quality={snapshot.screenQuality}
          onQualityChange={(q) => void client.setScreenQuality(q)}
          shareAudio={snapshot.settings.shareSystemAudio}
          onShareAudioChange={(on) => client.setShareSystemAudio(on)}
          onPick={(id) => void pickSource(id)}
          onCancel={() => setPicking(false)}
        />
      )}

      {confirmLeave && (
        <ConfirmDialog
          title="End the room for everyone?"
          message={`The room runs on your PC, so leaving disconnects ${snapshot.peers.length} ${
            snapshot.peers.length === 1 ? "friend" : "friends"
          }. To keep them together, hand the host role to someone and have them host a new room.`}
          confirmLabel="Leave and end room"
          danger
          onConfirm={() => {
            setConfirmLeave(false);
            onLeave();
          }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
    </div>
  );
}

function ScreenTile({
  label,
  stream,
  self,
  muted,
  volume,
  hasAudio,
  sinkId,
  onVolume,
  controls,
}: {
  label: string;
  stream: MediaStream;
  self: boolean;
  muted: boolean;
  volume: number;
  hasAudio: boolean;
  sinkId: string;
  onVolume: (v: number) => void;
  controls: JSX.Element | null;
}): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void ref.current?.requestFullscreen().catch(() => {});
  };
  return (
    <figure className="screen-tile" ref={ref} onDoubleClick={toggleFullscreen}>
      <ScreenVideo stream={stream} muted={muted} volume={volume} sinkId={sinkId} />
      <figcaption className="screen-caption">
        🖥 {label}
        {self && <em> (your screen)</em>}
      </figcaption>
      <div className="screen-tools" onDoubleClick={(e) => e.stopPropagation()}>
        {controls}
        {!self && hasAudio && (
          <label className="screen-volume" title="Volume of their shared audio">
            🔊
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => onVolume(Number(e.target.value))}
            />
          </label>
        )}
        <button className="btn small ghost" onClick={toggleFullscreen} title="Fullscreen (double-click)">
          ⛶
        </button>
      </div>
    </figure>
  );
}
