# Kootani · கூட்டணி

A self-contained Windows voice app for gaming with a small group of friends.
You share one `.exe`, sign in, host a room (your PC becomes the server, on
demand), and your friends join from anywhere with a link. No accounts to
manage, no servers to rent, no cost.

> கூட்டணி (Kootani) means *alliance / coalition* in Tamil — a group joined for a
> common purpose.

---

## Features

- 🎙️ **Live group voice** over WebRTC (peer-to-peer mesh, low latency).
- 🖥️ **Screen sharing** — share a whole monitor or a single window, with system
  /game audio riding along (Windows loopback). Pick **resolution** (480p →
  2160p/4K) and **frame rate** (24–144 fps), changeable live while sharing.
  Anyone in the room can share; multiple shares appear side by side.
- 🖱️ **One-click hosting** — "Host a new room" turns your PC into the backend
  automatically (signaling server + secure tunnel); no setup, no terminal.
- 🌍 **Works across the internet** — friends in different countries, no VPN, no
  port-forwarding, via a free Cloudflare tunnel.
- 🔑 **Google (Gmail) sign-in**, with a nickname fallback for quick testing.
- 👑 **Host = room owner.** The creator hosts; the host can hand off the role,
  and if the host drops, it auto-transfers to another member.
- 🎛️ **Per-user audio controls** — echo cancellation, noise suppression, auto
  gain, mic input volume, and a per-person output volume. All live, all saved.
- 📦 **One portable `.exe`** — friends double-click; nothing else to install.
- 💸 **$0 to run** — no cloud bill, no credit card.

---

## How it works (in one picture)

```
        YOUR PC (host — one click)                        A FRIEND, anywhere
 ┌───────────────────────────────────┐
 │  signaling server (in the app)     │◄── wss://xxx.trycloudflare.com ──► Kootani.exe
 │  + cloudflared tunnel (auto)       │◄──────────────────────────────────► Kootani.exe
 │                                    │
 └───────────────────────────────────┘
                   ▲
        voice is peer-to-peer (WebRTC) ── it does NOT flow through your PC or the cloud
```

Three pieces:

1. **The client** (`app/`) — an Electron app. UI, WebRTC, sign-in. When you host,
   it also runs the two pieces below for you.
2. **The signaling server** — a tiny WebSocket service that helps peers find each
   other and exchange connection info. It never carries audio. Hosting runs it
   in-app; there's also a standalone copy in `server/` for development.
3. **The tunnel** (`cloudflared`) — exposes the signaling server on your PC to the
   internet, free, with no router changes. The app starts it automatically.

"Host is the server" is true in two senses: the signaling server literally runs
on the host's PC, **and** the host owns the room. The audio itself is direct
peer-to-peer between friends. See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
for the full design.

---

## Requirements

- **To play (host *or* join):** nothing but the `.exe` — hosting is built in.
- **To develop / build:** [Node.js](https://nodejs.org/) 18+ (tested on 22) and Windows.

---

## Quick start (development)

```powershell
npm install            # installs both workspaces (app + server)

# Terminal 1 — signaling server on ws://localhost:8787
npm run dev:server

# Terminal 2 — the app (hot-reloads)
npm run dev:app
```

To test two participants on one machine: build once (`npm run build:app`) and
launch two windows with `cd app ; npx electron .` (twice). Host in one, copy the
invite link, join in the other. **Use headphones** to avoid echo/feedback.

You can sign in with a **nickname** immediately; Google sign-in needs setup (below).

---

## Playing with friends across the internet (free)

Your PC becomes the backend on demand, exposed by a free Cloudflare quick tunnel
— no account, no credit card, no router config. It's one click:

1. **Host a new room.** The app starts the signaling server and opens a secure
   tunnel for you. (The first time, it downloads a small helper, `cloudflared` —
   a few seconds.)
2. **Copy** the invite link and send it to your friends.
3. Friends paste it into **"Join a friend's room"** in their copy of the app.

Keep the app open while you play; leaving the room or quitting shuts the tunnel
down. The tunnel address is **random each session**, so you share a fresh invite
link each time.

See **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** if a friend can't connect
or there's no audio.

> **Advanced — bring your own server.** In the lobby, expand *“Advanced: use a
> custom server address”* to point Kootani at a server you run yourself. For that,
> `npm run host` starts the standalone signaling server + tunnel from a terminal
> and prints a `wss://…` address to paste in. Useful for development or a
> longer-lived server; not needed for normal play.

---

## Building the distributable `.exe`

```powershell
npm run dist:app
```

Produces a single portable executable at:

```
app/release/Kootani-<version>-portable.exe
```

Friends double-click it — no installer, no admin rights. Because it's unsigned
(a code-signing certificate costs money), Windows shows a SmartScreen prompt the
first time: **More info → Run anyway**. That's expected and one-time.

What gets bundled (and why) is covered in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#packaging--distribution)**.

---

## Configuration

Resolved in priority order: environment variables → `app/kootani.config.json` →
defaults. The config file is **gitignored** (it holds the Google client secret).

| Setting | Env var | Config-file key | Default |
| --- | --- | --- | --- |
| Signaling URL (default for the address field) | `KOOTANI_SIGNALING_URL` | `signalingUrl` | `ws://localhost:8787` |
| Google OAuth client ID | `KOOTANI_GOOGLE_CLIENT_ID` | `googleClientId` | — |
| Google OAuth client secret | `KOOTANI_GOOGLE_CLIENT_SECRET` | `googleClientSecret` | — |
| Signaling server port | `PORT` (server) | — | `8787` |

`app/kootani.config.json` also accepts Google's downloaded `client_secret_*.json`
shape verbatim (its `installed` block). When packaged, this file is bundled into
the app's resources so sign-in works in the distributed `.exe`.

### Google sign-in setup (one-time, by you)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project
   and an **OAuth client ID** of type **Desktop app**.
2. Put the **Client ID** and **Client secret** in `app/kootani.config.json`.
3. On the OAuth consent screen, either **Publish to Production** (so any Google
   account can sign in — the basic `openid/email/profile` scopes need no
   verification) or add each friend's Gmail as a **Test user**.

Friends never touch Google Cloud — they just click "Sign in with Google". The
client secret living inside the `.exe` is expected for desktop apps (we also use
PKCE); fine for a friends-only app.

---

## Project structure

```
kootani/
├── app/                         Electron client (React + TypeScript)
│   ├── src/
│   │   ├── main/                main process
│   │   │   ├── index.ts         window, permissions, IPC, config,
│   │   │   │                    display-media handler + desktopCapturer
│   │   │   ├── auth.ts          Google OAuth (system browser + PKCE)
│   │   │   ├── config.ts        config loader
│   │   │   └── hosting/         one-click hosting: embedded server + tunnel
│   │   │       ├── index.ts     orchestration + lifecycle
│   │   │       ├── signaling.ts in-process WebSocket signaling server
│   │   │       ├── cloudflared.ts  cloudflared download + tunnel start
│   │   │       └── logger.ts    host diagnostics log
│   │   ├── preload/index.ts     contextBridge → window.kootani
│   │   ├── renderer/            React UI
│   │   │   └── src/
│   │   │       ├── App.tsx                          login → lobby → room
│   │   │       ├── lib/RoomClient.ts                WebRTC mesh, audio + screen
│   │   │       ├── lib/joinlink.ts                  invite-link encode/decode
│   │   │       └── components/
│   │   │           ├── RemoteAudio.tsx              per-peer audio + volume
│   │   │           ├── ScreenVideo.tsx              <video> with srcObject
│   │   │           ├── ScreenPicker.tsx             in-app screens/windows picker
│   │   │           └── QualityControls.tsx          resolution/fps dropdowns
│   │   └── shared/              protocol.ts (wire messages), ipc.ts (incl. screen:* IPC)
│   ├── electron-builder.yml     packaging config (portable target)
│   ├── electron.vite.config.ts
│   └── kootani.config.json      (gitignored) Google creds + defaults
├── server/                      signaling server (Node + ws)
│   └── src/{index.ts,protocol.ts}
├── scripts/host.mjs             `npm run host` — server + cloudflared tunnel
└── docs/                        ARCHITECTURE, TROUBLESHOOTING
```

---

## npm scripts (root)

| Script | What it does |
| --- | --- |
| `npm run dev:server` | Run the signaling server with hot reload (`:8787`) |
| `npm run dev:app` | Run the Electron app with hot reload |
| `npm run host` | Standalone server + Cloudflare tunnel (optional — in-app hosting is one click) |
| `npm run build:app` | Build the app bundle (no packaging) |
| `npm run dist:app` | Build + package the portable `.exe` |
| `npm run typecheck` | Typecheck both workspaces |

---

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — full technical design: signaling
  protocol, WebRTC mesh, host transfer, audio pipeline, security model, packaging.
- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — every issue we've hit and its fix.
- **[CHANGELOG.md](CHANGELOG.md)** — version history.

---

## Status & roadmap

- ✅ Voice: sign-in → host/join → live audio mesh, verified **cross-region**.
- ✅ Host role + manual/auto transfer.
- ✅ Run-on-your-PC backend via free tunnel + invite links.
- ✅ Portable `.exe` packaging.
- ✅ Per-user audio controls (echo/noise/gain/volumes), persisted.
- ✅ **One-click hosting** — server + tunnel embedded in the app (no `npm run host`).
- ✅ **Screen sharing** with system/game audio, in-app picker, multiple
  concurrent shares, and live resolution/fps controls.
- ⏭️ **TURN relay** — add a free relay for the minority of networks where direct
  peer-to-peer fails.
- ⏸️ **Webcam video** — a per-person camera tile (separate from screen share).
