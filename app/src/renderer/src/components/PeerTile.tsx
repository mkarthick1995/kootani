import type { PeerView, RoomClient } from "../lib/RoomClient";
import { Avatar } from "./Avatar";
import { RemoteAudio } from "./RemoteAudio";

/** Friendly words for the raw RTCPeerConnectionState (+ ping when connected). */
function connectionLabel(peer: PeerView): { text: string; tone: "good" | "warn" | "bad" | "muted" } {
  if (peer.away) return { text: "Reconnecting…", tone: "warn" };
  switch (peer.connection) {
    case "connected": {
      const ping = peer.rttMs !== null ? `${peer.rttMs} ms` : "Connected";
      return { text: peer.relayed ? `${ping} · relay` : ping, tone: peer.rttMs !== null && peer.rttMs > 250 ? "warn" : "good" };
    }
    case "new":
    case "connecting":
      return { text: "Connecting…", tone: "warn" };
    case "disconnected":
      return { text: "Connection unstable…", tone: "warn" };
    case "failed":
      return { text: "Can't connect", tone: "bad" };
    default:
      return { text: "—", tone: "muted" };
  }
}

export function PeerTile({
  peer,
  client,
  canTransferHost,
  deafened,
  sinkId,
}: {
  peer: PeerView;
  client: RoomClient;
  canTransferHost: boolean;
  deafened: boolean;
  sinkId: string;
}): JSX.Element {
  const conn = connectionLabel(peer);
  return (
    <li className={`peer ${peer.away ? "away" : ""}`}>
      <div className="peer-row">
        <Avatar user={peer.user} speaking={peer.speaking && !peer.muted} />
        <div className="peer-meta">
          <span className="peer-name" title={peer.user.email ?? peer.user.name}>
            {peer.user.name}
          </span>
          <span className="badges">
            {peer.isHost && <span className="badge host">HOST</span>}
            {peer.deafened ? (
              <span className="badge muted" title="Deafened">
                DEAFENED
              </span>
            ) : (
              peer.muted && (
                <span className="badge muted" title="Muted">
                  MUTED
                </span>
              )
            )}
            {peer.sharingScreen && <span className="badge live">LIVE</span>}
            <span className={`conn ${conn.tone}`}>{conn.text}</span>
          </span>
        </div>
        {canTransferHost && !peer.isHost && (
          <button className="btn small ghost" onClick={() => client.transferHostTo(peer.id)} title="Hand the host role to them">
            Make host
          </button>
        )}
      </div>
      {peer.connection === "failed" && !peer.away && (
        <p className="peer-hint">
          No direct path between your networks. A TURN relay fixes this — see Troubleshooting.
        </p>
      )}
      <div className="peer-volume">
        <span className="vol-icon" aria-hidden>
          🔊
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={peer.outputVolume}
          aria-label={`Volume for ${peer.user.name}`}
          onChange={(e) => client.setPeerVolume(peer.id, Number(e.target.value))}
        />
        <span className="slider-val">{Math.round(peer.outputVolume * 100)}%</span>
      </div>
      <RemoteAudio stream={peer.stream} volume={peer.outputVolume} muted={deafened} sinkId={sinkId} />
    </li>
  );
}
