# Kootani — Troubleshooting

Real problems encountered while building and testing, with fixes. Ordered
roughly by how often they bite.

---

## "Couldn't reach the signaling server"

The app couldn't open a WebSocket to the address it was given. Two causes:

**1. No server is running at that address.**
- Hosting locally? Start it: `npm run dev:server` (or `npm run host`).
- The server and the app are **separate processes**. The server terminal just
  sits showing "listening…" — that's correct; leave it open.

**2. The invite link points at `localhost` (most common in real tests).**
- If you host with the **default** "Your server address" (`ws://localhost:8787`),
  the invite link tells your friend's PC to connect to *its own* localhost —
  where nothing is running. It works between two windows on your machine but
  **fails for anyone remote.**
- Fix: run `npm run host`, paste the printed `wss://….trycloudflare.com` address
  into "Your server address", host, then share that invite link.

---

## `Error: listen EADDRINUSE: address already in use :::8787`

Something is already on port 8787.

- You're probably running **both** `npm run dev:server` and `npm run host`.
  `npm run host` starts its own server — use one or the other, not both.
- Or a previous server didn't shut down. Close its terminal, or find and stop it:
  ```powershell
  Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```
- Or run on another port: `$env:PORT = "8790"; npm run host`.

The server now prints a friendly hint for this instead of a raw stack trace.

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

Free Cloudflare quick-tunnel URLs are **random per run** and disappear when you
`Ctrl+C` the `npm run host` window. If you restarted hosting, the old invite link
is dead — host again and share the **new** link. (A permanent URL would require a
paid domain + named tunnel.)
