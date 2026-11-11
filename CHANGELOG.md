# Changelog

All notable changes to Kootani. Versions refer to the packaged app
(`app/package.json`).

## [0.4.0] — 2026-11-12

A reliability and usability pass. **Everyone needs this build:** the signaling
protocol changed, and a 0.4.0 host tells older builds to update (instead of a
call that half-works).

### Fixed
- **Anyone who had the tunnel URL could crash the host's app** by sending the
  JSON text `null` (an unchecked `msg.type` threw in the main process). The
  server now validates every message, caps frame size (256 KB, was 100 MB) and
  room size (10), and can't be taken down by bad input. The in-app server also
  only allows the host's own room.
- **A brief signaling drop ended the call.** The client never reconnected, and
  the server treated any dropped socket as "left", so everyone tore down their
  peer connections. See *Reconnect without dropping the call* below.
- **Joins could leave a pair stuck on "Connecting…" forever.** Every join caused
  an offer collision; the polite side's rollback of its *initial* offer could
  leave Chromium's ICE agent with no candidates. The member already in the room
  now waits for the newcomer's offer (with a watchdog fallback). 8/8 rejoin
  rounds connected in testing.
- Failed or dropped peer connections were never recovered; a lost offer could
  deadlock negotiation. Now: ICE restart on `failed`/prolonged `disconnected`,
  and unanswered offers are rolled back and retried.
- No microphone (denied, missing) meant you couldn't join at all. You now join
  listen-only with a banner and a "Try again".
- An interrupted `cloudflared` download could be cached as a corrupt binary
  forever, and the download had no timeout. Now streamed to a temp file, size
  checked, 30 s stall timeout, and an unrunnable binary is re-downloaded.
- The guest-side diagnostics log grew without bound; the host log was wiped on
  every host attempt. One rotating `kootani.log` now.
- Voice vs. screen streams are identified by stream id (sent in the SDP) rather
  than guessed from track arrival order.
- `npm run host`: tunnel now targets `127.0.0.1` with `--protocol http2`, like
  the app (avoids the IPv6 `localhost` trap).

### Added
- **Reconnect without dropping the call.** Seats are held for 60 s after a
  disconnect; the client detects dead links (heartbeat), reconnects with backoff
  and resumes its seat. Peer connections — and voice — are untouched. Others see
  you as "Reconnecting…", not gone.
- **Tunnel auto-restart.** If the host's tunnel dies, a new one opens, the invite
  link updates, and guests are moved to the new address automatically over a
  per-peer WebRTC data channel.
- **TURN relays from config, shared by the host.** `iceServers` in
  `kootani.config.json` (bundled, or `%APPDATA%\Kootani\kootani.config.json` with
  no rebuild); the host's server hands its relay list to every guest.
- **Speaking indicators**, peers' **mute/deafen** badges, **ping** per peer (and
  "relay" when relayed), and a "you're muted" hint when you talk while muted.
- **Deafen**, **global hotkeys** (`Ctrl+Shift+M` mute, `Ctrl+Shift+D` deafen,
  working while a game has focus), and join/leave/mute **sound cues** (toggle).
- **Microphone and speaker selection**, hot-swappable without renegotiating, with
  automatic fallback when a device is unplugged, and a mic test.
- Screen share: **fullscreen** (double-click), per-share **volume**, and a
  **"Share system audio" toggle** (loopback also captures friends' voices).
- **Remembered sign-in**, cancellable Google sign-in, "Paste & join", forgiving
  invite parsing (links inside chat text, line breaks), friendlier connection
  states, a confirm before the host leaves (or quits) while friends are in the
  room, version + "Open logs" in the UI.
- Tests: `npm test` (signaling server over real sockets; invite links).

### Changed
- One signaling implementation (`server/src/signaling.ts`) and one protocol
  definition, used by both the standalone and in-app servers — no hand-synced
  copies.
- Room UI: bottom control bar (mute, deafen, share, settings, leave), settings
  drawer, clearer banners; the renderer is now `sandbox: true` and can't be
  navigated away.

## [0.3.1] — 2026-05-28

### Added
- **Screen-share quality controls.** Pick the capture **resolution** (480p, 720p,
  1080p, 1440p/2K, 2160p/4K) and **frame rate** (24, 30, 60, 120, 144 fps) — in
  the picker before sharing, or live on your own preview tile while sharing
  (changes apply instantly, no reconnection). The choice is remembered.
  - The encoder's max bitrate now scales with the chosen resolution/fps (WebRTC
    still adapts below it), so high-res/high-fps shares stay sharp instead of
    blocky, and the screen sender sheds resolution before frame rate under
    congestion (smoother for fast-moving games).

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
