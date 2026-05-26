# Kootani — Architecture

This document explains how Kootani is built and why. For setup and usage, see
the [README](../README.md); for fixes to specific problems, see
[TROUBLESHOOTING](TROUBLESHOOTING.md).

## Contents

- [Goals & constraints](#goals--constraints)
- [System overview](#system-overview)
- [The signaling server](#the-signaling-server)
- [The signaling protocol](#the-signaling-protocol)
- [WebRTC mesh & connection setup](#webrtc-mesh--connection-setup)
- [Host role & transfer](#host-role--transfer)
- [Reaching a home PC: the tunnel](#reaching-a-home-pc-the-tunnel)
- [One-click hosting](#one-click-hosting)
- [Invite links](#invite-links)
- [Audio pipeline](#audio-pipeline)
- [Authentication](#authentication)
- [Security model](#security-model)
- [Packaging & distribution](#packaging--distribution)
- [Known limitations & roadmap](#known-limitations--roadmap)

---

## Goals & constraints

These shaped every decision:

- **Self-contained for friends.** A friend installs nothing but the `.exe`. →
  Electron (bundles its own Chromium + Node) rather than Tauri (needs WebView2).
- **Works across regions, no VPN, no port-forwarding.** Friends are in different
  countries behind residential NAT/CGNAT.
- **Zero cost, no credit card.** No rented servers, no paid TURN, no cloud account.
- **"Host is the server."** The person who starts a session is the authority.

The tension — "host's home PC can't accept inbound connections from another
country" vs. "no cloud, no money" — is resolved by running the server **on the
host's PC** and exposing it through a **free Cloudflare quick tunnel**.

## System overview

```
        HOST PC (on demand)                                 GUEST(S)
 ┌──────────────────────────────┐
 │ signaling server (Node + ws) │◄═══ wss://*.trycloudflare.com ═══► Electron client
 │ cloudflared quick tunnel     │◄═══════════════════════════════► Electron client
 └──────────────────────────────┘
            ▲  signaling only (SDP/ICE, room & host state)
            │
   ┌────────┴─────────┐
   │  WebRTC mesh      │   audio flows peer-to-peer, NOT through the server/tunnel
   │  (every pair has  │
   │   a direct conn)  │
   └──────────────────┘
```

Three independently understandable parts:

| Part | Lives in | Runtime | Role |
| --- | --- | --- | --- |
| Client | `app/` | Electron (Chromium + Node) | UI, WebRTC, sign-in |
| Signaling server | in-app (`app/src/main/hosting/`); standalone copy in `server/` | Node + `ws` | rendezvous, room & host state |
| Tunnel | in-app (`app/src/main/hosting/`); or `scripts/host.mjs` | `cloudflared` child process | makes the host PC reachable |

When you click **Host a new room**, the client runs the signaling server and the
tunnel itself (see [One-click hosting](#one-click-hosting)). The standalone
`server/` and `scripts/host.mjs` are the development / bring-your-own-server path.

## The signaling server

`server/src/index.ts` — a WebSocket server on an HTTP server (so it can also
answer `GET /health`). State is **in-memory and ephemeral**: a room exists only
while someone is in it.

```
rooms: Map<roomId, {
  hostId: string,
  members: Map<memberId, { ws, user, isAlive }>   // insertion order matters
}>
```

- A connection may be in one room at a time (tracked via a `WeakMap<ws, …>`).
- Joining a non-existent room **creates** it and makes you host.
- A 15-second ping/pong heartbeat culls half-open connections (e.g. a slept
  laptop) so host auto-transfer actually fires instead of leaving a ghost host.
- `EADDRINUSE` is caught and reported as a friendly message, not a stack trace.

The server only relays; it never inspects or stores media.

## The signaling protocol

Defined in `server/src/protocol.ts` and mirrored in `app/src/shared/protocol.ts`
(kept in sync by hand — it's small and stable). All messages are JSON with a
`type` discriminator.

**Client → Server**

| Type | Payload | Meaning |
| --- | --- | --- |
| `join` | `room`, `user` | join/create a room |
| `leave` | — | leave cleanly |
| `signal` | `to`, `data` | relay an SDP/ICE blob to one peer |
| `transfer-host` | `to` | (host only) hand off the host role |
| `ping` | — | heartbeat |

**Server → Client**

| Type | Payload | Meaning |
| --- | --- | --- |
| `joined` | `selfId`, `room`, `hostId`, `peers[]` | you're in; here's who's present |
| `peer-joined` | `peer` | someone arrived |
| `peer-left` | `peerId` | someone left |
| `signal` | `from`, `data` | an SDP/ICE blob from a peer |
| `host-changed` | `hostId` | host role moved |
| `error` | `message` | non-fatal error (e.g. failed transfer) |
| `pong` | — | heartbeat reply |

The `data` inside `signal` is opaque to the server. On the client it's a
`SignalData` (`{ kind: "sdp" | "ice", … }`), defined in `RoomClient.ts` because
it uses DOM-only WebRTC types.

## WebRTC mesh & connection setup

Topology is a **full mesh**: every pair of peers has one `RTCPeerConnection`.
For ~6 people this is simpler and more robust than a central relay, and the host
isn't burdened with forwarding everyone's audio.

**Glare-free offer rule:** the **joining** peer creates the offer to everyone
already in the room; existing peers wait and answer. Because the server tells a
newcomer exactly who's present (and notifies the others), there's exactly one
offerer per pair — no offer collisions, so we don't need perfect-negotiation
rollback.

ICE candidates that arrive before the remote description is set are buffered per
peer and drained once it's applied.

**ICE servers** (`ICE_SERVERS` in `RoomClient.ts`): currently **STUN only**
(Google's public STUN). STUN lets peers discover their public address, which is
enough for many home networks. A **TURN** relay — needed when both ends are
behind strict/symmetric NAT (common on Indian mobile/CGNAT) — is the planned next
addition; it's a one-line config (`urls`/`username`/`credential`) using a free
tier such as ExpressTURN.

## Host role & transfer

The host is a **room-ownership role enforced by the server**, not a network
endpoint others dial.

- The room creator is host.
- **Manual transfer:** the host sends `transfer-host`; the server validates the
  sender is the current host and the target exists, updates `hostId`, and
  broadcasts `host-changed`. (UI: the host sees a "Make host" button on each peer.)
- **Auto-transfer:** when the host disconnects (cleanly or abruptly, detected via
  the heartbeat), the server promotes the **oldest remaining member** (first in
  the insertion-ordered member map) and broadcasts `host-changed`.

## Reaching a home PC: the tunnel

A residential PC can't accept inbound connections from another country. Rather
than port-forwarding (fragile, impossible under CGNAT) or a VPN (setup burden),
Kootani opens a **Cloudflare quick tunnel**, which:

1. Downloads `cloudflared` (official Cloudflare binary) on first run.
2. Starts the signaling server on a local port.
3. Runs `cloudflared tunnel --url http://127.0.0.1:<port>`, which dials **out** to
   Cloudflare and is handed a public `https://<random>.trycloudflare.com` URL
   that proxies back to the local server. WebSockets work over it.
4. Parses that URL from cloudflared's output and surfaces the `wss://` form.

This happens automatically in-app (see [One-click hosting](#one-click-hosting));
`scripts/host.mjs` does the same from a terminal for the standalone server.

> **Why `127.0.0.1`, not `localhost`?** The embedded server binds to the IPv4
> loopback. On Windows, `localhost` can resolve to IPv6 `::1` first, so pointing
> cloudflared at `127.0.0.1` avoids a "tunnel up but origin unreachable" failure.

Quick tunnels need **no Cloudflare account and no credit card**. The trade-offs:
the URL is **random per run** (a stable one needs a paid domain) and it's
best-effort (no SLA) — fine for on-demand game nights.

## One-click hosting

`app/src/main/hosting/` makes "Host a new room" a single click — no `npm run host`,
no pasting a tunnel URL, and no way to accidentally host on an unreachable
`ws://localhost`. The renderer calls `window.kootani.startHosting()`; the main
process then:

1. **Starts the signaling server in-process** (`signaling.ts` —
   `createSignalingServer(0)`), binding `127.0.0.1` on an **OS-assigned port**.
   Port 0 means it can never collide, so the old `EADDRINUSE` problems are gone.
   `ws` is bundled into the main-process build, so nothing extra ships.
2. **Ensures `cloudflared`** (`cloudflared.ts` — `ensureCloudflared`), downloading
   it once to `app.getPath("userData")/bin` (writable in a packaged build, unlike
   the repo's `.cache/`).
3. **Opens the tunnel** (`startTunnel`), parsing the `*.trycloudflare.com` URL
   from cloudflared's output and resolving with the `wss://` form (with a timeout).
4. Returns that URL; the lobby hosts a room at it and shows the invite link.

Progress is streamed to the renderer over a `host:status` channel
(`"Opening a secure tunnel…"`, etc.). Only one host session runs at a time, and
it's torn down on room-leave and on `before-quit`. The same room/host/relay logic
lives in both `signaling.ts` and the standalone `server/src/index.ts`; they're
kept in sync by hand (the protocol is small and stable).

## Invite links

`app/src/renderer/src/lib/joinlink.ts`. Because the tunnel URL changes each
session, the room code alone isn't enough — a guest also needs the server
address. An **invite link** is `base64url(JSON({ u: url, r: room }))`: opaque
enough to paste as one token, trivially decodable for debugging. The host copies
it from the room's invite bar; the guest pastes it into "Join a friend's room".
`normalizeWsUrl` coerces `http(s)`/bare-host inputs into `ws(s)://`.

## Audio pipeline

In `RoomClient.connect()`:

```
getUserMedia({ echoCancellation, noiseSuppression, autoGainControl })  ← raw mic track
        │
   MediaStreamSource ─► GainNode (input volume) ─► MediaStreamDestination
        │                                                   │
   (raw track kept for live DSP toggles)        destination.stream ─► addTrack to every peer
```

- **DSP** (echo cancellation, noise suppression, auto gain) is set at capture and
  toggled **live** via `track.applyConstraints(...)` — no renegotiation.
- **Input volume** is a Web Audio `GainNode` (0–200%). Auto gain will fight a
  manual setting, so turn it off for predictable manual control. If Web Audio
  fails for any reason, we fall back to sending the raw mic stream.
- **Output volume per peer** is the `<audio>` element's `.volume` (0–100%), set in
  `RemoteAudio.tsx`. Purely local — it changes how *you* hear someone.
- **Mute** disables the outgoing track (`track.enabled = false`).
- **Bitrate**: the audio sender's `maxBitrate` is raised to ~64 kbps for clearer
  Opus voice (default is ~32 kbps).
- All mic settings persist in `localStorage` (`kootani.audioSettings`); per-peer
  volumes are ephemeral.

All of this is **per user, local** — your settings never affect anyone else's stream.

## Authentication

`app/src/main/auth.ts`. Google sign-in uses the **desktop OAuth flow**: the
**system browser** (Google blocks OAuth inside embedded webviews) plus a
**loopback redirect** and **PKCE**.

1. Spin up a throwaway `http://127.0.0.1:<random>` server.
2. Open Google's consent URL in the system browser (scopes `openid email profile`).
3. Catch the redirect, verify `state`, exchange the code (+ PKCE verifier) at
   Google's token endpoint.
4. Read identity (name/email/avatar) from the returned `id_token`.

A **nickname** login is always available for quick testing without Google setup.

## Security model

- **Renderer is sandboxed:** `contextIsolation: true`, `nodeIntegration: false`.
  The renderer talks to the main process only through a minimal `window.kootani`
  bridge (`getConfig`, `googleLogin`, `copyText`).
- **CSP** in `index.html` restricts sources; `connect-src` allows `ws:`/`wss:`/
  `https:` for the tunnel and avatars.
- **Permissions:** the session grants only the `media` permission (mic); all
  others are denied.
- **Clipboard** goes through Electron's native clipboard via IPC (the browser
  Clipboard API is unreliable under these locked-down permissions).
- **The Google client secret is bundled in the `.exe`.** For an installed desktop
  app this is expected (Google's own model treats desktop clients as unable to
  keep a secret; we also use PKCE). Acceptable for a friends-only distribution;
  the file is gitignored so it stays out of source control.

## Packaging & distribution

`app/electron-builder.yml`, via `npm run dist:app` (`electron-vite build &&
electron-builder --win`).

- **Target:** `portable` → a single `Kootani-<version>-portable.exe` that runs
  without an installer or admin rights. Output in `app/release/`.
- **Bundled files:** only `out/**` + `package.json` (the main/preload have no
  third-party runtime deps; the renderer is bundled by Vite).
- **`kootani.config.json`** is shipped via `extraResources` to
  `resources/kootani.config.json`, where the config loader finds it through
  `process.resourcesPath` — so Google sign-in works in the distributed build.
- **`electronVersion` is pinned** in the config because, under npm workspaces,
  `electron` is hoisted to the repo-root `node_modules` and electron-builder can't
  auto-detect its version from `app/node_modules`.
- **Unsigned.** No code-signing certificate (it costs money), so Windows
  SmartScreen warns on first run → *More info → Run anyway*.

## Known limitations & roadmap

- **STUN-only.** Add a free TURN relay for networks where direct P2P fails.
- **Ephemeral tunnel URL.** Inherent to free quick tunnels; a stable address would
  need a paid domain + named tunnel.
- **Server runs on the original host's PC.** Host *role* transfer moves room
  ownership, but the signaling server stays on the PC that started hosting — so if
  that person quits, the session ends for everyone. Truly portable hosting would
  mean the new host starts their own tunnel and migrating peers to it.
- **No video yet.** Deferred until voice is proven across the whole group; the
  mesh and `PeerView.stream` plumbing already anticipate a second media track.
