/**
 * A "join link" bundles everything a friend needs to connect: the signaling
 * server address (the host's tunnel URL) plus the room code. It's base64url'd
 * JSON — one opaque token to paste, trivially decodable for debugging.
 *
 * Decoding is forgiving, because links travel through chat apps: surrounding
 * text ("join us: …"), line breaks, quotes and stray whitespace are all fine.
 */

export interface JoinTarget {
  url: string;
  room: string;
}

export function encodeJoinLink(target: JoinTarget): string {
  const json = JSON.stringify({ u: target.url, r: target.room });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tryDecodeToken(token: string): JoinTarget | null {
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const parsed = JSON.parse(json) as { u?: unknown; r?: unknown };
    if (typeof parsed.u !== "string" || typeof parsed.r !== "string") return null;
    const url = normalizeWsUrl(parsed.u);
    const room = parsed.r.trim();
    if (!/^wss?:\/\/[^\s/]+/.test(url) || !/^[A-Za-z0-9_-]{1,32}$/.test(room)) return null;
    return { url, room };
  } catch {
    return null;
  }
}

/** Find and decode a join link anywhere in pasted text. */
export function decodeJoinLink(text: string): JoinTarget | null {
  // Chat apps may wrap long tokens across lines; rejoin before scanning.
  const compact = text.replace(/\s+/g, " ").trim();
  const direct = tryDecodeToken(compact.replace(/\s/g, ""));
  if (direct) return direct;
  // Otherwise try every token-shaped run, longest first ("eyJ" = base64 of '{"').
  const candidates = compact.match(/[A-Za-z0-9_-]{16,}/g) ?? [];
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    const hit = tryDecodeToken(c);
    if (hit) return hit;
  }
  return null;
}

/** Accept http(s)/ws(s)/bare host and normalize to a ws(s) URL with no trailing slash. */
export function normalizeWsUrl(raw: string): string {
  let s = raw.trim();
  if (/^https:\/\//i.test(s)) s = "wss://" + s.slice("https://".length);
  else if (/^http:\/\//i.test(s)) s = "ws://" + s.slice("http://".length);
  else if (!/^wss?:\/\//i.test(s)) s = "wss://" + s;
  return s.replace(/\/+$/, "");
}

/** True for addresses only this PC can reach (useless in an invite). */
export function isLoopbackUrl(url: string): boolean {
  return /^wss?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(url.trim());
}
