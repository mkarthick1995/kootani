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
- [Reliability](#reliability)
- [Host role & transfer](#host-role--transfer)
- [Reaching a home PC: the tunnel](#reaching-a-home-pc-the-tunnel)
- [One-click hosting](#one-click-hosting)
- [Invite links](#invite-links)
- [Audio pipeline](#audio-pipeline)
- [Screen sharing](#screen-sharing)
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
| Signaling server | `server/src/signaling.ts` — run in-app when hosting, or standalone via `server/` | Node + `ws` | rendezvous, room & host state |
| Tunnel | in-app (`app/src/main/hosting/`); or `scripts/host.mjs` | `cloudflared` child process | makes the host PC reachable |

When you click **Host a new room**, the client runs the signaling server and the
tunnel itself (see [One-click hosting](#one-click-hosting)). The standalone
`server/` and `scripts/host.mjs` are the development / bring-your-own-server path.

## The signaling server

**One implementation:** `server/src/signaling.ts` (`createSignalingServer(options)`)
is used both by the standalone server (`server/src/index.ts`) and by the server
embedded in the app (`app/src/main/hosting/signaling.ts`, a thin wrapper). The
protocol types live once, in `server/src/protocol.ts`; `app/src/shared/protocol.ts`
re-exports them. Nothing is kept in sync by hand any more.

A WebSocket server on an HTTP server (so it can also answer `GET /health` with
`{ ok, protocol, rooms }`). State is **in-memory and ephemeral**: a room exists
only while someone is in it.

```
rooms: Map<roomId, {
  hostId: string,
  members: Map<memberId, {          // insertion order matters
    user, token,                     // token: secret for resuming the seat
    ws | null,                       // null = "away" (seat held)
    queue: ServerMessage[],          // messages that arrived while away
    graceTimer
  }>
}>
```

- **Seats survive disconnects.** When a socket drops without a `leave`, the
  member becomes *away* (others get `peer-status { away: true }`), messages to
  them are queued, and the seat is held for a **60 s grace period**. Rejoining
  with `resume: { memberId, token }` reclaims the same id, flushes the queue, and
  nobody sees a `peer-left` — so their WebRTC connections, and the voice on
  them, are never torn down by a signaling blip. Only when the grace period
  expires is the member removed (and the host role moved, if needed).
- **Joining a non-existent room creates it** and makes you host.
- A 15-second ping/pong heartbeat culls half-open sockets (e.g. a slept laptop)
  so their grace period starts.
- **Untrusted input.** The embedded server is reachable from the internet
  through the tunnel, so every message is validated (shape, types, lengths,
  room-code charset, https-only avatars); frames over 256 KB are refused; a
  malformed message gets an `error` reply and can never throw out of the handler.
  Rooms are capped at 10 (full mesh).
- **`lockToFirstRoom`** (embedded server): only the host's room can exist, so
  someone who discovers the tunnel URL can't use the host's PC to run rooms of
  their own.
- `EADDRINUSE` is reported as a friendly message, not a stack trace.

The server only relays; it never inspects or stores media. Tests:
`server/test/signaling.test.ts` (real sockets — `npm test`).

## The signaling protocol

All messages are JSON with a `type` discriminator. `PROTOCOL_VERSION` is **2**;
the server rejects older clients (`version` absent or < `MIN_PROTOCOL_VERSION`)
with a fatal, human-readable "out of date" error instead of a half-working call.

**Client → Server**

| Type | Payload | Meaning |
| --- | --- | --- |
| `join` | `room`, `user`, `version`, `resume?` | join/create a room, or reclaim a held seat |
| `leave` | — | leave cleanly (no grace period) |
| `signal` | `to`, `data` | relay an SDP/ICE blob to one peer (queued if they're away) |
| `transfer-host` | `to` | (host only) hand off the host role |
| `ping` | — | app-level heartbeat (the client uses the replies to detect a dead link) |

**Server → Client**

| Type | Payload | Meaning |
| --- | --- | --- |
| `joined` | `selfId`, `room`, `hostId`, `peers[]`, `token`, `resumed`, `iceServers?` | you're in; who's present; your resume secret; TURN servers shared by the host |
| `peer-joined` | `peer` | someone arrived |
| `peer-left` | `peerId` | someone left (or their grace period expired) |
| `peer-status` | `peerId`, `away` | someone's signaling link dropped / came back |
| `signal` | `from`, `data` | an SDP/ICE blob from a peer |
| `host-changed` | `hostId` | host role moved |
| `error` | `message`, `code?`, `fatal?` | `fatal` = don't retry (outdated client, room full, no such room) |
| `pong` | — | heartbeat reply |

The `data` inside `signal` is opaque to the server. On the client it's a
`SignalData` (`{ kind: "sdp" | "ice" | "screen", … }`), defined in `RoomClient.ts`
because it uses DOM-only WebRTC types. Every `sdp` also carries
`streams: { voice, screen }` — the sender's stream ids — so the receiver knows
exactly which incoming stream is which. The `"screen"` kind is a lightweight
sharing-state flag; the pixels travel as a normal negotiated video track.

## WebRTC mesh & connection setup

Topology is a **full mesh**: every pair of peers has one `RTCPeerConnection`.
For ~6 people this is simpler and more robust than a central relay, and the host
isn't burdened with forwarding everyone's audio (or screen pixels).

**The newcomer makes the first offer.** When someone joins, the members already
in the room create their side of the connection but hold their own offer
(`awaitingOffer`) and answer the newcomer's. Without this, *every* join was an
offer collision, and resolving it meant the polite side rolled back its
*initial* offer — which in testing left Chromium's ICE agent stuck with no
candidates (connection forever "new"). If the newcomer's offer never arrives,
the watchdog offers instead after 5 s.

**Perfect negotiation for everything after that.** Either side may
(re)negotiate at any time — adding or dropping a screen track fires
`negotiationneeded` on whichever peer is sharing — so later glare is real. The
mesh uses the MDN
[perfect-negotiation pattern](https://developer.mozilla.org/docs/Web/API/WebRTC_API/Perfect_negotiation)
to resolve it:

- Each pair has a stable **polite/impolite** assignment, decided by a plain id
  compare (`selfId > peerId` → polite). The two ends always disagree, which is
  the whole point.
- `pc.onnegotiationneeded` drives offers via `setLocalDescription()` with no
  args (implicit offer when stable, implicit answer when remote offer is set).
- On a collision (`desc.type === "offer" && (makingOffer || signalingState !== "stable")`),
  the **impolite** peer ignores the incoming offer and keeps its own; the
  **polite** peer accepts it, which implicitly rolls back its own in-flight offer.
- A `screen:false` notification lets the receiver drop the share view promptly
  even before the renegotiation that removes the track completes.

ICE candidates that arrive before the remote description is set are buffered per
peer and drained once it's applied. Candidates that belong to an offer we
deliberately ignored during a collision fail silently — `ignoreOffer` suppresses
their log noise.

**ICE servers.** Built-in public STUN (Google, Cloudflare) lets peers discover
their public address — enough for many home networks. A **TURN** relay, needed
when both ends are behind strict/symmetric NAT (common on Indian mobile/CGNAT),
comes from `iceServers` in `kootani.config.json`. Only the **host** needs it: the
host's server includes its list in every `joined`, and each client merges it
with its own. Malformed entries are dropped at load time (and logged).

**Per-peer data channel.** Each connection also has a pre-negotiated
`RTCDataChannel` (`negotiated: true, id: 0` — no extra signaling) carrying small
P2P messages: `{ t: "state", muted, deafened }` (so tiles show who's muted) and
`{ t: "server-moved", url }` (see [Reliability](#reliability)).

## Reliability

Failure is expected on home networks; each layer recovers on its own.

| What breaks | How it's detected | What happens |
| --- | --- | --- |
| Signaling socket drops (Wi-Fi blip, sleep, tunnel hiccup) | `close` event, or no server message for 20 s (the client pings every 5 s) | Reconnect with backoff (0.5 s → 5 s) and **resume the seat**; signals sent meanwhile are queued and flushed. Peer connections — and voice — are untouched. Banner: "Reconnecting…". Gives up after 2 min (manual **Reconnect**). |
| Seat expired (away > 60 s, or the server restarted) | `joined` with `resumed: false` | Close every peer connection and rebuild the mesh from scratch. |
| Peer connection `failed`, or `disconnected` > 5 s | `connectionstatechange` + 1 s watchdog | `restartIce()` (rate-limited to once per 8 s); perfect negotiation handles the resulting offer. |
| Our offer never answered (lost in a reconnect, ignored in a collision) | `have-local-offer` for > 15 s | Roll back, then ICE-restart to re-offer — negotiation can't deadlock. |
| Host's tunnel process dies | `cloudflared` exits after it was up | Main process reopens a tunnel (retries at 1/4/10 s) → new URL. The host's invite link updates, and ~8 s later (edge propagation) the host sends `server-moved` over every data channel; guests switch their signaling URL and resume their seats there. |
| Corrupt/blocked `cloudflared` | Binary under 5 MB, or spawn error | Delete it; re-download on the next attempt. Downloads stream to a temp file, renamed only when complete; a 30 s stall aborts. |
| Mic denied / missing / unplugged | `getUserMedia` failure, track `ended` | Join **listen-only** (a silent track keeps the mesh uniform) with a banner + "Try again"; a vanished chosen mic falls back to the default. |
| Bug in the main process | `uncaughtException` | Logged, not a crash dialog. |
| Old build joins a new host | `version` in `join` | Fatal, friendly "out of date" error. |

## Host role & transfer

The host is a **room-ownership role enforced by the server**, not a network
endpoint others dial.

- The room creator is host.
- **Manual transfer:** the host sends `transfer-host`; the server validates the
  sender is the current host and the target exists, updates `hostId`, and
  broadcasts `host-changed`. (UI: the host sees a "Make host" button on each peer.)
- **Auto-transfer:** when the host leaves cleanly, or drops and doesn't come back
  within the 60 s grace period, the server promotes the **oldest remaining
  member who is actually connected** (falling back to the oldest at all) and
  broadcasts `host-changed`.
- The *role* is room ownership; the *server* stays on the PC that started
  hosting. That's why leaving as the hosting PC asks for confirmation — it ends
  the room for everyone.

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

1. **Starts the signaling server in-process** (the shared core, wrapped by
   `hosting/signaling.ts`), binding `127.0.0.1` on an **OS-assigned port** (no
   `EADDRINUSE`, ever), locked to the host's one room, sharing the host's TURN
   list. `ws` is bundled into the main-process build, so nothing extra ships.
2. **Ensures `cloudflared`** (`cloudflared.ts` — `ensureCloudflared`), downloading
   it once to `app.getPath("userData")/bin` with live progress, a stall timeout,
   and an atomic temp-file-then-rename so a failed download is never cached.
3. **Opens the tunnel** (`startTunnel`), resolving with the `wss://` form once
   cloudflared reports a registered edge connection. One automatic retry; a
   binary that can't execute is discarded for re-download.
4. Returns `{ url, localUrl }`: friends get `url` in the invite; this PC connects
   over `localUrl` (loopback — see the 0.2.1 changelog for why never via the
   tunnel).

Progress and later lifecycle events stream to the renderer on `host:event`
(`status`, `tunnel-down`, `tunnel-up`, `tunnel-failed`). A double-click joins the
in-flight attempt rather than starting a second server. Everything is torn down
on room-leave and on quit — and quitting while friends are connected asks first
("Closing Kootani disconnects 3 friends").

## Invite links

`app/src/renderer/src/lib/joinlink.ts`. Because the tunnel URL changes each
session, the room code alone isn't enough — a guest also needs the server
address. An **invite link** is `base64url(JSON({ u: url, r: room }))`: opaque
enough to paste as one token, trivially decodable for debugging. The host copies
it from the room's invite bar; the guest pastes it into "Join a friend's room"
(or clicks **Paste & join**). Decoding is forgiving — the link is found inside
surrounding chat text, quotes, or line breaks — and validated (ws(s) URL, sane
room code). It's UTF-8 safe. `normalizeWsUrl` coerces `http(s)`/bare-host inputs
into `ws(s)://`. Tests: `app/test/joinlink.test.ts`.

## Audio pipeline

In `RoomClient.connect()`:

```
getUserMedia({ deviceId, echoCancellation, noiseSuppression, autoGainControl })  ← mic
        │
   MediaStreamSource ─► GainNode (input volume) ─┬─► MediaStreamDestination ─► addTrack to every peer
        │                                         └─► AnalyserNode (speaking meter)
   (raw track kept for live DSP toggles)
```

- **The graph is built before the mic is opened**, so the destination's track
  (what peers receive) exists even with no mic — it carries silence and the user
  is **listen-only** rather than locked out. Switching microphones just swaps the
  `MediaStreamSource`; peers keep the same track, so there's **no
  renegotiation**. A chosen mic that disappears (unplugged) falls back to the
  system default automatically.
- **DSP** is set at capture and toggled **live** via `applyConstraints`.
- **Input volume** is the `GainNode` (0–200%). If Web Audio fails, we fall back to
  sending the raw mic track (swapped with `replaceTrack` on device change).
- **Output device** (`setSinkId`) and **per-peer volume** (0–100%) are applied on
  each peer's `<audio>` element (`RemoteAudio.tsx`); shared-screen audio has its
  own per-share volume. **Deafen** mutes all of them and mutes the mic.
- **Mute** disables the outgoing track (`track.enabled = false`).
- **Speaking indicators.** Self: the analyser above (loudest ~21 ms chunk of a
  ~170 ms window, every 100 ms). Peers: the receiver's cumulative
  `totalAudioEnergy` / `totalSamplesDuration` from `getStats`, diffed every 150 ms
  — an energy integral, so no speech falls between samples. (Two approaches that
  *don't* work: the last RTP packet's `audioLevel` aliases badly, and Chromium
  feeds Web Audio silence from remote WebRTC streams.)
- **Bitrate**: the voice sender's `maxBitrate` is raised to ~64 kbps.
- Settings persist in `localStorage` (`kootani.audioSettings`: DSP, input volume,
  devices, sound cues, share-system-audio); per-peer volumes are ephemeral.

All of this is **per user, local** — your settings never affect anyone else's stream.

## Screen sharing

Any room member can share a monitor or a single window; system/game audio rides
along on Windows via loopback capture. Multiple shares can be live at once and
are stacked on a "screen stage" above the participants. Implemented across three
processes:

```
 renderer  ── prepareScreenShare(sourceId) ──►  main  (stash id)
 renderer  ── getDisplayMedia({video, audio}) ──►  Electron session ──► setDisplayMediaRequestHandler
                                                                          │
                                                          desktopCapturer.getSources(...)
                                                                          │
                                                       callback({ video: match, audio: "loopback" })
 renderer  ◄── MediaStream (video + system audio) ──┘
 renderer  ── addTrack(...) to every RTCPeerConnection ──► remote peers
 renderer  ── signal({ kind: "screen", on: true }) ──► remote peers (UI hint)
```

**No native picker on Windows.** Electron's `getDisplayMedia` has no built-in
picker on Windows, so Kootani renders its own (`ScreenPicker.tsx`): a modal
listing screens/windows resolved via `desktopCapturer.getSources` with
thumbnails (data URLs) and app icons (`fetchWindowIcons: true`). The chosen id
is stashed in the main process (`screen:prepare`) so that the very next
`getDisplayMedia` call's `setDisplayMediaRequestHandler` can return it. Without
a stashed id the handler denies the request.

**Capture quality is a ceiling, not a floor.** The picker (and a live control
on the self-preview tile) lets users set a height-based **resolution** (480p,
720p, 1080p, 1440p/2K, 2160p/4K) and a **frame rate** (24/30/60/120/144 fps).
These map to `getDisplayMedia` track constraints (`height`/`frameRate`,
`ideal`+`max`) and, on a live change, to `track.applyConstraints` — no
renegotiation needed. Height-capping keeps the source aspect ratio so
ultrawide/4:3 displays still fit.

**Encoder bitrate scales with the choice.** Resolution and frame rate alone
aren't enough: a 4K/60 share encoded at the default bitrate looks blocky. The
screen sender's `maxBitrate` is set proportional to `width × height × fps × 0.07`,
clamped to 0.8–25 Mbps. The sender also runs with
`degradationPreference: "maintain-framerate"` so under congestion it sheds
resolution before frame rate — smoother for fast-moving games. The track's
`contentHint = "motion"` nudges the encoder toward the same priority. WebRTC
still adapts *below* this cap as the link allows.

**Track classification on the receiver.** A peer can carry up to two streams
(voice + screen). Every SDP the sender sends names its stream ids
(`streams: { voice, screen }`), and the receiver keeps every incoming stream by
id — so classification is exact regardless of the order tracks arrive in (a
screen's loopback audio can arrive before its video). Heuristics (video ⇒
screen, audio-only ⇒ voice) remain only as a fallback.

**System audio is optional.** "Share system audio" in the picker (remembered)
decides whether `screen:prepare` asks for `audio: "loopback"`. Loopback captures
the *whole* system mix — including Kootani playing your friends' voices — so
viewers on a share with system audio can hear themselves echoed. Turn it off
when you don't need game sound. Viewers can **double-click a share for
fullscreen**.

**Stopping.** The user can stop via Kootani's button or Windows' own
"Stop sharing" overlay; both end up at `stopScreenShare`, which removes the
tracks from every `RTCPeerConnection` (firing `negotiationneeded` from this
side), sends `{ kind: "screen", on: false }` so receivers drop the view at
once, and stops the underlying tracks. The video track's `"ended"` event
catches the Windows-overlay path.

**Why not a single big stream?** Voice and screen live in independent
`MediaStream`s with separate quality, lifecycle, and mute semantics. Mixing
them would couple controls (e.g. live resolution changes shouldn't touch the
mic) and complicate the multi-share UX.

## Authentication

`app/src/main/auth.ts`. Google sign-in uses the **desktop OAuth flow**: the
**system browser** (Google blocks OAuth inside embedded webviews) plus a
**loopback redirect** and **PKCE**.

1. Spin up a throwaway `http://127.0.0.1:<random>` server.
2. Open Google's consent URL in the system browser (scopes `openid email profile`).
3. Catch the redirect, verify `state`, exchange the code (+ PKCE verifier) at
   Google's token endpoint.
4. Read identity (name/email/avatar) from the returned `id_token`.

A **nickname** login is always available without Google setup. The pending
browser sign-in can be cancelled (the loopback server is closed). The signed-in
identity (name/email/avatar — no tokens) is remembered in `localStorage`
(`kootani.user`), so people don't sign in on every launch; **Sign out** forgets it.

## Security model

- **Renderer is sandboxed:** `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`. The renderer talks to the main process only through
  a minimal `window.kootani` bridge (`shared/ipc.ts`). It can't navigate away
  (`will-navigate` is blocked) and only `http(s)` links open externally.
- **The signaling server treats all input as hostile** — see
  [The signaling server](#the-signaling-server). Before 0.4.0, anyone with the
  tunnel URL could crash the host's app by sending the JSON `null`.
- **Resume tokens** are 24 random bytes, compared in constant time; a wrong token
  just gets a fresh seat, never someone else's.
- **CSP** in `index.html` restricts sources; `connect-src` allows `ws:`/`wss:`/
  `https:` for the tunnel and avatars.
- **Permissions:** the session grants only `media` (mic, for `getUserMedia`)
  and `display-capture` (screen share, for `getDisplayMedia`); all others are
  denied. `getDisplayMedia` itself is also gated by our own
  `setDisplayMediaRequestHandler`, which denies the request unless the
  renderer has just called `screen:prepare` with a valid source id from our
  in-app picker.
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

- **No TURN relay by default.** Supported (host-side config, shared with guests),
  but you have to bring free credentials. Without one, a pair behind strict NATs
  shows "Can't connect".
- **Ephemeral tunnel URL.** Inherent to free quick tunnels; a stable address would
  need a paid domain + named tunnel. A tunnel that dies mid-session is replaced
  and guests are moved over automatically.
- **Server runs on the original host's PC.** Host *role* transfer moves room
  ownership, but the signaling server stays on the PC that started hosting — so if
  that person quits, the session ends for everyone. Truly portable hosting would
  mean the new host starts their own tunnel and migrating peers to it.
- **Full-mesh upload scales with viewers.** A screen sender's upload bandwidth
  is roughly `bitrate × (peers − 1)` — the price of a server-less mesh. For ~6
  friends at 1080p/30 this is fine on a typical home upload; 4K/60 to five
  viewers will saturate most consumer uplinks. Drop the quality, or wait for
  an SFU-style relay (not currently planned for the cost reasons).
- **Screen share is Windows-tested only.** Loopback system audio uses Electron's
  `audio: "loopback"`, which is a Windows path; macOS/Linux capture would need
  different plumbing. Kootani targets Windows today.
- **No webcam video.** Screen sharing is in; a per-person camera tile is on the
  roadmap. The mesh already carries two media streams per peer (voice + screen),
  so a third would extend the same `PeerView` plumbing.
