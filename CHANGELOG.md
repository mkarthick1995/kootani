# Changelog

All notable changes to Kootani. Versions refer to the packaged app
(`app/package.json`).

## [0.3.0] — 2026-05-28

### Added
- **Screen sharing.** A "🖥 Share screen" button in the room lets you share a
  whole monitor or a single window; system/game audio rides along (Windows
  loopback). Anyone in the room can share, multiple shares show side by side,
  and shared screens appear on a stage above the participants.
  - Electron has no native screen picker on Windows, so Kootani shows its own:
    a grid of live thumbnails for each screen and window, resolved through a
    main-process `desktopCapturer` + `setDisplayMediaRequestHandler`.
  - Stopping via the button or Windows' own "stop sharing" overlay both tear the
    share down and drop the view for everyone.

### Changed
- The peer mesh now uses **perfect negotiation** (polite/impolite roles, offer
  rollback) instead of a fixed offer direction. Adding or removing a screen
  track mid-call renegotiates from whichever side is sharing, so a fixed offerer
  no longer holds — this resolves the resulting offer glare cleanly.

## [0.2.1] — 2026-05-27

### Fixed
- **Hosting no longer fails with "Couldn't reach the signaling server."** The
  host was connecting to its own signaling server through the public tunnel URL —
  routing out to Cloudflare's edge and back to the same machine. A reachability
  probe showed why that failed: an external network reached the tunnel's origin
  fine, while the origin's *own* machine got HTTP 530 from Cloudflare's edge and
  the request never arrived. The host now connects to its server over loopback
  (`ws://127.0.0.1:<port>`) and only hands the tunnel URL to friends in the invite
  link. Hosting connects instantly and reliably; the tunnel only carries traffic
  from the outside internet, which is exactly the path that works.
- Also removed the 0.2.0 main-process health poll that gated hosting on the
  tunnel being reachable from this machine — the very check that was failing
  above. cloudflared is spawned with `--protocol http2 --edge-ip-version 4` (plain
  TCP/443, IPv4) for broad network compatibility, and the renderer's WebSocket
  retry is patient up to ~45s to absorb edge route-propagation for friends.

## [0.2.0] — 2026-05-26

### Added
- **One-click hosting.** "Host a new room" now starts the signaling server and a
  Cloudflare tunnel **inside the app** and hosts automatically — no more
  `npm run host`, no pasting a tunnel URL, and no way to accidentally host on
  `ws://localhost` (which worked locally but was unreachable for friends).
  - The embedded server runs in the Electron main process on an OS-assigned
    loopback port (so it can't collide — goodbye `EADDRINUSE`).
  - `cloudflared` is downloaded on first host to the app's user-data folder and
    reused after that; live progress ("Opening a secure tunnel…") is shown.
  - Hosting is torn down automatically when you leave the room or quit the app.
- The manual "server address" flow is still available under an **Advanced**
  toggle in the lobby (handy for local dev or a custom server).

### Fixed
- Point the tunnel origin at `127.0.0.1` (not `localhost`) so it works on Windows,
  where `localhost` can resolve to IPv6 `::1` first and miss the IPv4 server.
- Don't hand back the tunnel URL until it is **actually routable**: after
  cloudflared registers, the main process polls the tunnel's `/health` until it
  truly serves traffic (the edge publishes the tunnel's DNS/route a few seconds
  *after* "registered"), then hands the URL to the UI. The renderer also retries
  the initial connect as a safety net. Fixes "Couldn't reach the signaling
  server" right after hosting, caused by connecting before the edge had a route
  (WebSocket close 1006 / DNS `ENOTFOUND`). If the tunnel never comes online,
  hosting now fails with a clear "try again" message instead of a dead room.

### Internal
- `ws` is now bundled into the main-process build (no extra runtime dependency to
  ship). Removed `*.tsbuildinfo` from version control.

## [0.1.2] — 2026-05-26

### Added
- **Per-user audio controls** in a new in-room **⚙ Audio** panel:
  - Toggle echo cancellation, noise suppression, and auto gain (applied live to
    the mic via `applyConstraints`, no reconnect).
  - **Input volume** slider (0–200%) via a Web Audio `GainNode`.
  - **Per-peer output volume** slider (0–100%) on each peer's tile — local-only.
- Mic settings persist across sessions in `localStorage`.

## [0.1.1] — 2026-05-26

### Changed / Fixed
- Explicitly enable **echo cancellation, noise suppression, and auto gain** on
  mic capture (previously relied on browser defaults) — addresses echo when a
  peer is on speakers.
- Raised the audio sender's Opus **bitrate to ~64 kbps** for clearer voice.

## [0.1.0] — 2026-05-25

First distributable build.

### Added
- **Voice chat** over a WebRTC full mesh (peer-to-peer; signaling server never
  carries media).
- **Authentication:** Google (Gmail) sign-in via the desktop OAuth flow (system
  browser + PKCE loopback), plus a nickname fallback.
- **Rooms & host role:** create/join by code; creator is host; manual host
  transfer; automatic transfer to the oldest remaining member on host disconnect.
- **Run-on-your-PC backend:** `npm run host` starts the signaling server and a
  free Cloudflare quick tunnel, printing a public `wss://` address — no account,
  no card, no port-forwarding.
- **Invite links** that bundle the tunnel address + room code; copy via Electron's
  native clipboard, also shown as selectable text.
- **Portable Windows `.exe`** via electron-builder (single file, no installer);
  `kootani.config.json` bundled so sign-in works in the distributed build.

### Verified
- Two-way audio between two PCs in **different regions**, on STUN only.

---

## Development milestones (pre-release)

- Walking skeleton: login → host/join room → live audio between two local windows.
- Signaling server (`server/`) with room membership, host assignment/transfer, and
  a connection heartbeat; smoke-tested over real WebSockets.
- Cloudflare quick-tunnel path verified end-to-end (HTTP + WebSocket through the
  public URL).
