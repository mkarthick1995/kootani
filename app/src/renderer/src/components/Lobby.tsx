import { useState } from "react";
import type { UserInfo } from "@shared/protocol";
import { decodeJoinLink, isLoopbackUrl, normalizeWsUrl } from "../lib/joinlink";
import { Avatar } from "./Avatar";

export interface EnterOptions {
  selfHosted?: boolean;
  inviteUrl?: string;
}

function randomRoomCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no easily-confused chars
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Strip Electron's "Error invoking remote method …" wrapper from IPC errors. */
function ipcMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : "";
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;
}

export function Lobby({
  user,
  version,
  defaultUrl,
  onEnter,
  onSignOut,
}: {
  user: UserInfo;
  version: string;
  defaultUrl: string;
  onEnter: (room: string, connectUrl: string, opts?: EnterOptions) => void;
  onSignOut: () => void;
}): JSX.Element {
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const [hosting, setHosting] = useState(false);
  const [hostStatus, setHostStatus] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [serverUrl, setServerUrl] = useState(defaultUrl);

  const join = (text: string): void => {
    const target = decodeJoinLink(text);
    if (!target) {
      const looksLikeRoomCode = /^[a-z0-9]{4,10}$/i.test(text.trim());
      setLinkError(
        looksLikeRoomCode
          ? "That's just the room code. Ask the host to click “Copy” on the invite link and paste the whole thing here."
          : "That doesn't look like a Kootani invite link.",
      );
      return;
    }
    onEnter(target.room, target.url);
  };

  const pasteAndJoin = async (): Promise<void> => {
    const text = (await window.kootani.readClipboard()).trim();
    setLink(text);
    setLinkError(null);
    if (!text) {
      setLinkError("Your clipboard is empty — copy the invite link first.");
      return;
    }
    join(text);
  };

  // One click: the app starts the signaling server + tunnel for you, then hosts.
  const hostOneClick = async (): Promise<void> => {
    setHosting(true);
    setHostError(null);
    setHostStatus("Starting…");
    const unsubscribe = window.kootani.onHostEvent((e) => {
      if (e.type === "status") setHostStatus(e.message);
    });
    try {
      const { url, localUrl } = await window.kootani.startHosting();
      // Connect to our own server over loopback; share the tunnel URL with friends.
      onEnter(randomRoomCode(), localUrl, { selfHosted: true, inviteUrl: url }); // navigates away
    } catch (e) {
      setHostError(ipcMessage(e, "Couldn't start hosting."));
      void window.kootani.stopHosting();
      setHosting(false);
    } finally {
      unsubscribe();
    }
  };

  const advancedUrl = serverUrl.trim() ? normalizeWsUrl(serverUrl) : "";
  const isLocal = isLoopbackUrl(advancedUrl);

  return (
    <div className="centered">
      <div className="card lobby">
        <div className="identity">
          <Avatar user={user} />
          <div className="identity-text">
            <div className="peer-name">{user.name}</div>
            {user.email && <div className="hint">{user.email}</div>}
          </div>
          <button className="link inline" onClick={onSignOut} disabled={hosting}>
            Sign out
          </button>
        </div>

        <label className="field-label" htmlFor="invite">
          Join a friend's room
        </label>
        <form
          className="join-row"
          onSubmit={(e) => {
            e.preventDefault();
            join(link);
          }}
        >
          <input
            id="invite"
            className="input"
            placeholder="Paste the invite link"
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setLinkError(null);
            }}
            disabled={hosting}
          />
          {link.trim() ? (
            <button className="btn primary" type="submit" disabled={hosting}>
              Join
            </button>
          ) : (
            <button className="btn" type="button" onClick={() => void pasteAndJoin()} disabled={hosting}>
              Paste &amp; join
            </button>
          )}
        </form>
        {linkError && <p className="error">{linkError}</p>}

        <div className="divider">
          <span>or host your own</span>
        </div>

        <button className="btn primary big" onClick={hostOneClick} disabled={hosting}>
          {hosting ? "Setting up…" : "Host a new room"}
        </button>
        {hosting ? (
          <p className="host-status">
            <span className="spinner" /> {hostStatus}
          </p>
        ) : (
          <p className="hint">Your PC becomes the server and a secure invite link is created automatically — free, no setup.</p>
        )}
        {hostError && (
          <p className="error">
            {hostError}{" "}
            <button className="link inline" onClick={() => void window.kootani.openLogs()}>
              Open logs
            </button>
          </p>
        )}

        {!hosting && (
          <>
            <button className="link advanced-toggle" onClick={() => setShowAdvanced((s) => !s)}>
              {showAdvanced ? "▾ " : "▸ "}Advanced: use a custom server address
            </button>
            {showAdvanced && (
              <div className="advanced">
                <label className="field-label">
                  Server address{" "}
                  <span className="hint-inline">
                    {isLocal ? "(local — only works on this PC)" : "(e.g. from “npm run host”)"}
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
                  onClick={() => onEnter(randomRoomCode(), advancedUrl)}
                  disabled={!advancedUrl}
                >
                  Host with this address
                </button>
              </div>
            )}
          </>
        )}

        <p className="version-line">
          v{version} ·{" "}
          <button className="link inline" onClick={() => void window.kootani.openLogs()}>
            Open logs
          </button>
        </p>
      </div>
    </div>
  );
}
