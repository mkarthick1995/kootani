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
- 🌍 **Works across the internet** — friends in different countries, no VPN, no
  port-forwarding, via a free Cloudflare tunnel.
- 🔑 **Google (Gmail) sign-in**, with a nickname fallback for quick testing.
- 👑 **Host = room owner.** The creator hosts; the host can hand off the role,
  and if the host drops, it auto-transfers to another member.
- 🎛️ **Per-user audio controls** — echo cancellation, noise suppression, auto
  gain, mic input volume, and a per-person output volume. All live, all saved.
- 📦 **One portable `.exe`** — friends double-click; nothing else to install.
- 💸 **$0 to run** — no cloud bill, no credit card.

> Video sharing is planned but intentionally deferred until voice is rock-solid.

---

## How it works (in one picture)

```
        YOUR PC (host, on demand)                         A FRIEND, anywhere
 ┌───────────────────────────────────┐
 │  signaling server  (server/)       │◄── wss://xxx.trycloudflare.com ──► Kootani.exe
 │  + cloudflared tunnel  (npm run    │◄──────────────────────────────────► Kootani.exe
 │    host)                           │
 └───────────────────────────────────┘
                   ▲
        voice is peer-to-peer (WebRTC) ── it does NOT flow through your PC or the cloud
```

Three pieces:

1. **The client** (`app/`) — an Electron app. UI, WebRTC, sign-in.
2. **The signaling server** (`server/`) — a tiny WebSocket service that helps
   peers find each other and exchange connection info. It never carries audio.
3. **The tunnel** (`cloudflared`, launched by `npm run host`) — exposes the
   signaling server on your PC to the internet, free, with no router changes.

"Host is the server" is true in two senses: the signaling server literally runs
on the host's PC, **and** the host owns the room. The audio itself is direct
peer-to-peer between friends. See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
for the full design.

---

## Requirements

- **To develop / host:** [Node.js](https://nodejs.org/) 18+ (tested on 22) and Windows.
- **To just join as a friend:** nothing — only the `.exe`.

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
— no account, no credit card, no router config.

```powershell
npm run host
```

This downloads `cloudflared` (first run only), starts the signaling server, opens
the tunnel, and prints a public address like `wss://random-words.trycloudflare.com`.
Then:

1. In the app, paste that address into **"Your server address"** → **Host a new room**.
2. Click **Copy** on the invite link and send it to your friends.
3. Friends paste it into **"Join a friend's room"** in their copy of the app.

Keep the `npm run host` window open while you play; `Ctrl+C` ends the session.

> **Don't also run `npm run dev:server`** alongside `npm run host` — the launcher
> starts its own server, and two would collide on port 8787.
>
> The tunnel address is **random and changes each run** (a fixed one needs a paid
> domain), so you share a fresh invite link each session.

See **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** if a friend can't connect
or there's no audio.

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
│   │   │   ├── index.ts         window, permissions, IPC, config
│   │   │   ├── auth.ts          Google OAuth (system browser + PKCE)
│   │   │   └── config.ts        config loader
│   │   ├── preload/index.ts     contextBridge → window.kootani
│   │   ├── renderer/            React UI
│   │   │   └── src/
│   │   │       ├── App.tsx              login → lobby → room
│   │   │       ├── lib/RoomClient.ts    WebRTC mesh + audio pipeline
│   │   │       ├── lib/joinlink.ts      invite-link encode/decode
│   │   │       └── components/RemoteAudio.tsx
│   │   └── shared/              protocol.ts (wire messages), ipc.ts
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
| `npm run host` | Start server + Cloudflare tunnel, print the public address |
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
- ⏭️ **One-click hosting** — embed the server + tunnel into the app (no `npm run host`).
- ⏭️ **TURN relay** — add a free relay for the minority of networks where direct
  peer-to-peer fails.
- ⏸️ **Video sharing** — after voice is proven across the group.
