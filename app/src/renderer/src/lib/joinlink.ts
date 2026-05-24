/**
 * A "join link" bundles everything a friend needs to connect: the signaling
 * server address (the host's tunnel URL) plus the room code. The host copies it
 * and shares it; the guest pastes it. It's just base64url'd JSON — opaque enough
 * to paste as one token, but trivially decodable for debugging.
 */

export interface JoinTarget {
  url: string;
  room: string;
}

export function encodeJoinLink(target: JoinTarget): string {
  const json = JSON.stringify({ u: target.url, r: target.room });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeJoinLink(code: string): JoinTarget | null {
  try {
    const b64 = code.trim().replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(b64)) as { u?: unknown; r?: unknown };
    if (typeof parsed.u === "string" && typeof parsed.r === "string") {
      return { url: parsed.u, room: parsed.r };
    }
    return null;
  } catch {
    return null;
  }
}

/** Accept http(s)/ws(s)/bare host and normalize to a ws(s) URL with no trailing slash. */
export function normalizeWsUrl(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("https://")) s = "wss://" + s.slice("https://".length);
  else if (s.startsWith("http://")) s = "ws://" + s.slice("http://".length);
  else if (!s.startsWith("ws://") && !s.startsWith("wss://")) s = "wss://" + s;
  return s.replace(/\/+$/, "");
}
