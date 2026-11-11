# Kootani — Troubleshooting

Real problems encountered while building and testing, with fixes. Ordered
roughly by how often they bite.

---

## First step for any problem: the log

Every Kootani writes one diagnostics log: hosting, the tunnel's own output, and
every connection/WebRTC event. Click **Open logs** (lobby footer, or ⚙ Settings in
a room) and send the file `kootani.log`.

- Packaged app: `%APPDATA%\Kootani\kootani.log` (dev builds:
  `%APPDATA%\@kootani\app\kootani.log`).
- Each launch starts with a `═══ Kootani <version> start` line — check that
  everyone is on the **same version**.
- It rotates to `kootani.old.log` at 2 MB, so it never grows without bound.

---

## "Your copy of Kootani is out of date"

The host runs a newer build than you. Builds from **0.4.0** on use a new
signaling protocol (seat resume, shared TURN), and the host's server turns away
older ones with this message rather than letting a call half-work. Get the same
`.exe` as the host. The version is shown in the lobby footer.

---

## "Host a new room" hangs or errors

One-click hosting starts a local server and opens a Cloudflare tunnel. Progress is
shown under the button ("Downloading the tunnel helper… 42%", "Opening a secure
tunnel…"). If it fails:

- **First run downloads `cloudflared`** (~50 MB) from GitHub. A download that makes
  no progress for 30 s is abandoned with a clear error; partial downloads are
  never kept, so just try again. GitHub releases must be reachable.
- **Antivirus / SmartScreen may quarantine `cloudflared.exe`.** It lives in
  `%APPDATA%\Kootani\bin\`. If it can't be executed, Kootani deletes it and
  re-downloads on the next attempt; allow it in your AV if this keeps happening.
- **"The tunnel took too long to come up."** Kootani already retried once. Try
  again; if it persists, your network may block outbound HTTPS to Cloudflare.
- The error has an **Open logs** link; the `[cloudflared]` lines say why.
- Need a server you control instead? Use the lobby's **Advanced → custom server
  address** with `npm run host` (see below).

---

## "Couldn't reach the room"

The app kept trying for ~45 s and couldn't open a connection to the address in
the invite. The usual causes, in order:

1. **The invite is from an old session.** Invite links change every time the host
   starts hosting. Ask for the current one.
2. **The host closed Kootani or left the room** (which ends it).
3. **A brand-new tunnel is still propagating.** Rare after 45 s; click **Try
   again**.

If you're using the **Advanced (custom server address)** path, also check:

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
- Check you're not **deafened** (🎧 button / `Ctrl+Shift+D`), and that ⚙
  Settings → **Speakers / headphones** is the device you're listening on.
- If **they** see a red banner "Can't use your microphone", they joined
  listen-only: Windows blocked the mic (Settings → Privacy → Microphone) or no mic
  is plugged in. Fix it, then click **Try again** in the banner. The ⚙ Settings
  mic test ("We can hear you") confirms it works.
- Their tile shows **MUTED**? They're muted on their side.
- If a tile says **"Can't connect"**, the two networks can't find a direct path —
  typical with strict/CGNAT NAT. Kootani tries ICE restarts automatically, but
  this needs a **TURN relay**. See the next section.

---

## Adding a TURN relay (for "Can't connect")

Get free TURN credentials (e.g. ExpressTURN or Metered) and put them in a
`kootani.config.json` — **only the host needs them**: the host's server hands
its relay list to everyone who joins.

```json
{
  "iceServers": [
    { "urls": "turn:relay.example.com:3478", "username": "…", "credential": "…" },
    { "urls": "turns:relay.example.com:443?transport=tcp", "username": "…", "credential": "…" }
  ]
}
```

Either bake it into the build (`app/kootani.config.json`, then `npm run
dist:app`), or — no rebuild needed — drop it at
`%APPDATA%\Kootani\kootani.config.json` on the hosting PC and restart Kootani.
Malformed entries are skipped (the log says which). When a pair is relayed,
their tile shows `· relay` after the ping.

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

- Is **"Share system audio"** ticked in the screen picker? It's remembered
  between shares.
- **Sharing a single window?** Loopback captures the whole system mix, not a
  per-window stream — that part is OS-limited. The audio still goes out; just
  expect to hear *everything* coming out of your speakers, not only that one
  app.
- **Viewers hear their own voices echoed through your share?** Same cause: the
  mix includes Kootani playing your friends. Untick "Share system audio" when
  you don't need game sound.
- Viewers can set your share's volume separately from your voice (🔊 slider on
  the share, shown on hover).
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

- Check `kootani.log` (see the top of this page) on both sides for
  `RoomClient` errors. A failed renegotiation usually points to it.
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

## "Reconnecting…" banner

Your link to the room's server dropped (Wi-Fi blip, the PC slept, the tunnel
hiccupped). Kootani reconnects by itself and **reclaims your seat** for up to 60 s,
so nobody sees you leave — and voice with people you're already connected to
keeps flowing the whole time, because it never went through the server. Others
see your tile dimmed with "Reconnecting…".

After ~2 minutes without success it gives up with **Reconnect** in the header.

---

## The tunnel URL stopped working

Free Cloudflare quick-tunnel URLs are **random per session** and disappear when
hosting stops — i.e. when the host **leaves the room or quits the app** (or
`Ctrl+C`s `npm run host`, on the standalone path). If you restarted hosting, the
old invite link is dead — host again and share the **new** link. (A permanent URL
would require a paid domain + named tunnel.)

If the tunnel **dies mid-session**, the host's Kootani opens a new one by itself
(banner: "Your internet tunnel dropped — reopening it"), updates the invite link,
and tells everyone already in the room the new address over their direct
connection, so they reconnect without doing anything. Only people who haven't
joined yet need the new link.

---

## Global hotkeys don't work

`Ctrl+Shift+M` (mute) and `Ctrl+Shift+D` (deafen) are registered while you're in a
room. If another app already owns a combination, ⚙ Settings marks it
"unavailable". Close the other app (or change its hotkey) and rejoin. Running two
Kootani windows on one PC (testing) has the same effect for the second window.
