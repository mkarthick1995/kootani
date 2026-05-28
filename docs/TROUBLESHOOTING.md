# Kootani — Troubleshooting

Real problems encountered while building and testing, with fixes. Ordered
roughly by how often they bite.

---

## "Host a new room" hangs or errors

One-click hosting starts a local server and opens a Cloudflare tunnel. If it gets
stuck on "Opening a secure tunnel…" or shows an error:

- **First run downloads `cloudflared`** (~30 MB) from GitHub. On a slow or blocked
  connection this can stall. Make sure GitHub releases are reachable, then try
  again (the download is cached after the first success).
- **Antivirus / SmartScreen may quarantine `cloudflared.exe`.** It's downloaded to
  `%APPDATA%\kootani\bin\`. Allow it if your AV flags it, then retry.
- **"The tunnel took too long to come up."** Usually transient — just click **Host
  a new room** again. If it persists, your network may block outbound QUIC/HTTPS to
  Cloudflare.
- Need a server you control instead? Use the lobby's **Advanced → custom server
  address** with `npm run host` (see below).

---

## "Couldn't reach the signaling server"

The app couldn't open a WebSocket to the address it was given. With one-click
hosting the address is handled for you, so this almost always means the **Advanced
(custom server address)** path:

**1. No server is running at that address.**
- Start one: `npm run host` (server + tunnel), or `npm run dev:server` for local.
- The server and the app are **separate processes**. The server terminal just
  sits showing "listening…" — that's correct; leave it open.

**2. The address points at `localhost`.**
- A custom address of `ws://localhost:8787` tells your friend's PC to connect to
  *its own* localhost — where nothing is running. It works between two windows on
  your machine but **fails for anyone remote.** Use the `wss://….trycloudflare.com`
  address from `npm run host`, or just use one-click hosting, which never has this
  problem.

---

## `Error: listen EADDRINUSE: address already in use :::8787`

Only affects the **standalone** server (`npm run host` / `npm run dev:server`) —
one-click hosting uses an OS-assigned port and can't collide.

- You're probably running **both** `npm run dev:server` and `npm run host`.
  `npm run host` starts its own server — use one or the other, not both.
- Or a previous server didn't shut down. Close its terminal, or find and stop it:
  ```powershell
  Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```
- Or run on another port: `$env:PORT = "8790"; npm run host`.

The server prints a friendly hint for this instead of a raw stack trace.

---

## Friend sees "Windows protected your PC" (SmartScreen)

Expected. The `.exe` is **unsigned** (a code-signing certificate costs money).
Click **More info → Run anyway**. One-time per machine.

---

## You hear your own voice echoed back

This is **acoustic echo**, not a bug, and not caused by being the host. The other
person is on **speakers**: their mic picks up your voice coming out of their
speakers and sends it back to you.

- **Surest fix:** the person on speakers uses **headphones/earphones**.
- In-app: open **⚙ Audio** and make sure **Echo cancellation** is on (it is by
  default). It helps, but loud speakers close to a mic can still leak.
- The person who *causes* the echo is the one to fix it (headphones / echo
  cancellation), even though it's the *other* person who hears it.

---

## Connected, but no audio at all

The peer appears and may even show "connected", but silence.

- Check **output volume** for that peer (🔊 slider on their tile) and your OS
  volume / output device.
- Make sure you actually granted **microphone** permission (Windows Settings →
  Privacy → Microphone).
- If the connection dot is stuck on **"connecting"/"failed"**, the two networks
  can't establish a direct path — typical with strict/CGNAT NAT. Kootani is
  **STUN-only** today; this needs a **TURN relay**. Add free ExpressTURN
  credentials to `ICE_SERVERS` in `app/src/renderer/src/lib/RoomClient.ts`,
  rebuild, and re-share the `.exe`.

---

## Screen share: the picker is empty / has no windows

The picker lists what `desktopCapturer` reports. If you see only "Screen 1" and
no windows:

- Some apps render to surfaces the OS doesn't expose to screen capture
  (fullscreen-exclusive games, certain DRM-protected video players). Share the
  **whole screen** instead, or run the game in **borderless windowed** mode.
- A few seconds after opening the picker, thumbnails refresh; if a window opened
  after the picker, close and reopen the picker.

---

## Screen share: viewers see a black frame / nothing

The video track negotiated but the picture never appears on the other end.

- **Wait a few seconds.** WebRTC sometimes needs a moment to deliver the first
  keyframe across a fresh peer connection, especially on slower links.
- **Drop the quality.** A 4K/60 share to a viewer on a weak link can stall
  before the first frame arrives. Use the resolution/fps controls on your
  self-preview tile to switch to 720p/30 and the viewer should pick it up.
- **Shared the wrong source.** If you shared a window that's since been
  minimised, the OS may stop producing frames. Re-share the whole screen, or
  bring the window back.
- **Hardware-accelerated content (DRM/fullscreen-exclusive).** Some content is
  drawn in a layer screen capture can't read — the share is black even though
  the connection is fine. Share a different window/screen, or switch the source
  app out of fullscreen-exclusive mode.

---

## Screen share: no game/system audio is reaching the other side

Kootani uses Windows loopback (`audio: "loopback"`) to capture system audio
alongside the chosen screen/window, so game sound rides on the share.

- **Sharing a single window?** Loopback captures the whole system mix, not a
  per-window stream — that part is OS-limited. The audio still goes out; just
  expect to hear *everything* coming out of your speakers, not only that one
  app.
- **Output device that bypasses the mixer** (some USB headsets in "exclusive"
  mode, certain virtual audio devices) won't be captured. Switch the OS output
  to your normal speakers/headphones for the duration of the share, or disable
  exclusive-mode on the device.
- **Friend has no voice + screen audio**, only one or the other? That's a
  rendering bug, not a capture one — report it; the `RoomClient.ts` ontrack
  classifier is the place to look.

---

## Screen share: quality looks blocky / drops to a slideshow

Kootani's "Resolution" and "Frame rate" controls set a **capture ceiling and an
encoder bitrate target**; WebRTC adapts *below* this as your upload and the
viewer's downlink allow.

- **Blocky-but-smooth** → encoder is hitting its bitrate cap. Pick a smaller
  resolution (1080p instead of 1440p, say) — fewer pixels at the same bitrate
  means each one gets more bits.
- **Sharp-but-stuttery** → frames are being dropped. Pick a lower frame rate
  (30 instead of 60), or accept the resolution drop the encoder is already
  doing; Kootani biases toward maintaining frame rate.
- **In a full mesh your upload is `bitrate × (viewers − 1)`.** Sharing 4K/60
  to five viewers on a typical home upload won't fit. The controls are there
  precisely so you can right-size for the room.

---

## Screen share: my friend keeps seeing my old share after I stopped

Stopping (via Kootani's button or Windows' "Stop sharing" overlay) sends a
`screen:false` notification so the view drops immediately, then renegotiates to
remove the track. If the view lingers:

- Check the host log (`%APPDATA%\@kootani\app\kootani-host.log`) — both sides
  log `RoomClient` errors. A failed renegotiation usually points to it.
- Leaving and rejoining the room is the surest reset; the receiver's stale
  `PeerView.screenStream` is cleared on `peer-left`.

---

## Google sign-in: "Access blocked / app not verified"

Your OAuth consent screen is in **Testing** mode and the signing-in account isn't
allowed.

- Add the person's Gmail under **Test users**, **or**
- **Publish** the consent screen to **Production** (the basic `openid/email/profile`
  scopes need no Google verification, so there's no review).
- For quick testing, the **nickname** login avoids Google entirely.

---

## Google button is greyed out / "Google sign-in isn't configured"

No client ID/secret was found. Put them in `app/kootani.config.json`
(`googleClientId`, `googleClientSecret`) — or you can paste Google's downloaded
`client_secret_*.json` content there as-is. In a packaged build, that file must be
bundled (it is, via `extraResources`). Restart the app after changing it.

---

## "Copy" did nothing

Older builds used the browser clipboard, which is blocked under the app's locked
permissions. Current builds copy via Electron's native clipboard. If a copy ever
fails, the invite link is shown as **selectable text** — click it and Ctrl+C.

---

## electron-builder: "Cannot compute electron version…"

Under npm workspaces, `electron` is hoisted to the repo-root `node_modules`, so
electron-builder (run from `app/`) can't detect its version. Fixed by pinning
`electronVersion:` in `app/electron-builder.yml`. If you bump Electron, update
that value to match.

---

## The tunnel URL stopped working

Free Cloudflare quick-tunnel URLs are **random per session** and disappear when
hosting stops — i.e. when the host **leaves the room or quits the app** (or
`Ctrl+C`s `npm run host`, on the standalone path). If you restarted hosting, the
old invite link is dead — host again and share the **new** link. (A permanent URL
would require a paid domain + named tunnel.)
