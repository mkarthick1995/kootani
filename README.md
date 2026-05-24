# Kootani · கூட்டணி

A self-contained Windows voice & video app for gaming with a small group of
friends. Share the `.exe`, sign in with Google, host or join a room, talk.

> கூட்டணி (Kootani) means *alliance / coalition* in Tamil.

## How it works

- **Electron** client → fully self-contained `.exe` (no extra installs for your friends).
- **Signaling server** (`server/`) → a tiny always-on WebSocket service that lets
  peers find each other and exchange WebRTC connection info. It never carries
  your audio/video.
- **Media is peer-to-peer** (WebRTC full mesh). STUN handles NAT discovery; a
  TURN relay (added later) covers networks where direct connections fail.
- **"Host" is a room-ownership role**, enforced by the signaling server — not a
  network server. The creator hosts; the host can hand off the role, and if the
  host drops, it auto-transfers to the oldest remaining member.

See the project memory and `server/src/protocol.ts` for the full protocol.

## Repo layout

```
kootani/
├── server/   signaling server (Node + ws)
└── app/      Electron desktop client (React + TypeScript)
```

## Develop

Requires Node 18+ (tested on Node 22).

```powershell
npm install            # installs both workspaces

# Terminal 1 — signaling server (http://localhost:8787)
npm run dev:server

# Terminal 2 — the app (hot-reloads)
npm run dev:app
```

To test the full loop on one machine, launch the app **twice** (run
`npm run dev:app` in two terminals): host a room in one window, copy the code,
join from the other, and you should hear audio between them.

For now you can sign in with a **nickname** (dev login). Google sign-in needs
configuration — see below.

## Play with friends across the internet (free, no port-forwarding)

Your PC becomes the backend on demand, exposed via a free Cloudflare quick
tunnel — no account, no credit card, no router changes.

```powershell
npm run host
```

This downloads `cloudflared` (first run only), starts the signaling server, and
prints a public address like `wss://random-words.trycloudflare.com`. Then:

1. In the app, paste that address into **"Your server address"** and click
   **Host a new room**.
2. Click **Copy join link** and send it to your friends (any chat).
3. Friends paste the link into their app's **"Join a friend's room"** box.

Keep the `npm run host` window open while you play; `Ctrl+C` ends the session.
The address is random and changes each run (a fixed one needs a paid domain), so
you share a fresh join link each session.

> Note: `npm run host` starts its own signaling server — you do **not** also run
> `npm run dev:server` alongside it.

If a friend can connect but no audio flows, their network likely needs a TURN
relay (see "TURN" below) — most do not.

## Google sign-in setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and an **OAuth client ID** of type **Desktop app**.
2. Note the **Client ID** and **Client secret**. (For a distributed desktop app
   these aren't truly secret; that's expected and fine for a friends-only app.)
3. Provide them to the app via env vars before launching:

   ```powershell
   $env:KOOTANI_GOOGLE_CLIENT_ID = "xxxx.apps.googleusercontent.com"
   $env:KOOTANI_GOOGLE_CLIENT_SECRET = "yyyy"
   npm run dev:app
   ```

The app uses the system browser + PKCE loopback flow (Google blocks OAuth in
embedded webviews), and reads only your name, email, and avatar.

## Other config

| Env var                  | Default               | Purpose                          |
| ------------------------ | --------------------- | -------------------------------- |
| `KOOTANI_SIGNALING_URL`  | `ws://localhost:8787` | Where the app connects to signal |
| `PORT` (server)          | `8787`                | Signaling server port            |

## TURN (relay fallback)

Audio is peer-to-peer. When two peers' networks refuse a direct connection
(strict/CGNAT NATs), they need a TURN relay. STUN-only is configured by default
(`ICE_SERVERS` in `app/src/renderer/src/lib/RoomClient.ts`); to add a free TURN
relay, sign up for a free tier (e.g. [ExpressTURN](https://www.expressturn.com/),
1000 GB/mo) and add its `urls`/`username`/`credential` to that array.

## Status

- ✅ Walking skeleton: login → host/join room → **live audio mesh** + host transfer (verified locally).
- ✅ Run-on-your-PC backend via free Cloudflare tunnel (`npm run host`) + join links — public path verified.
- ⏭️ Next: package a portable Windows `.exe`; then optionally embed the server +
  tunnel into the app so hosting is one click; add TURN if a friend needs it.
- ⏸️ Video sharing — deferred until audio is proven across real friends.
