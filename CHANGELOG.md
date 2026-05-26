# Changelog

All notable changes to Kootani. Versions refer to the packaged app
(`app/package.json`).

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
