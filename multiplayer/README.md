# Swing City multiplayer relay

A Cloudflare Worker + Durable Object that lets Swing City players see each
other and joust (land on top of another player to explode them, Fortnite/
[fly.pieter.com](https://fly.pieter.com)-style). Pure relay, no server-side
physics — every client sends its own state, the Durable Object fans it out
to everyone else. `index.html` is multiplayer-off by default; it only
connects if you load it with a `?mp=` URL pointing at a deployed instance
of this Worker.

## Deploy your own

This machine's `wrangler` isn't logged into a Cloudflare account (checked —
no existing auth here, and no billable resources exist yet for this
project). Deploying is a one-time, ~2 minute step that needs to run under
*your* Cloudflare login:

```bash
cd /Users/alex/knowledge/projects/sensai-blender-demo/experiments/crazy-local-scene/swing-city/multiplayer
npx wrangler login          # opens a browser for Cloudflare OAuth
npx wrangler deploy         # ships worker.js + creates the ROOM Durable Object
```

That prints your Worker's URL, e.g. `https://swing-city-multiplayer.YOUR-SUBDOMAIN.workers.dev`.
Multiplayer uses a WebSocket, so swap `https://` for `wss://` and append
`/ws`:

```
wss://swing-city-multiplayer.YOUR-SUBDOMAIN.workers.dev/ws
```

Play with it: `https://ibrews.github.io/swing-city/?mp=wss://swing-city-multiplayer.YOUR-SUBDOMAIN.workers.dev%2Fws`
(URL-encode the `/ws` as `%2Fws`, or the browser will treat it as a path on
the outer page's URL instead of part of the `mp` value).

Free tier covers this comfortably — Durable Objects' free allowance is far
more than a casual multiplayer room needs, and Workers requests scale to
zero when nobody's connected.

## Verifying locally (no login needed)

Local dev via Miniflare doesn't require Cloudflare auth at all:

```bash
cd /Users/alex/knowledge/projects/sensai-blender-demo/experiments/crazy-local-scene/swing-city/multiplayer
npx wrangler dev --local --port 8791
```

Then load the game against it: `http://localhost:8377/?mp=ws://localhost:8791/ws`
(the KB has a `swing-city` launch config on port 8377 already, plus a
`swing-city-multiplayer` one for this Worker on 8791 — see
`~/knowledge/.claude/launch.json`).

This exact setup (real `wrangler dev` Durable Object + a second WebSocket
client simulating another player + the actual game page) is how this
feature was verified end-to-end before shipping: connect/welcome, remote-
player state sync and rendering, joust detection and the server-relayed
`jousted` broadcast, and the local player's game-over-on-being-jousted path
all confirmed working against a real (local) Durable Object instance — see
the commit that introduced this file for the full verification transcript.

## How it works

- **`worker.js`** — a `Room` Durable Object using the WebSocket Hibernation
  API (`state.acceptWebSocket`), so an idle room with open-but-silent
  sockets doesn't pin the DO in memory between messages. On connect, each
  socket gets a random id + color (`welcome`), other clients are told
  someone `join`ed. Incoming `state` messages (position, look yaw, web-
  anchor state, alive flag) are broadcast to everyone else as-is — no
  server-side authority, position is whatever the client says it is (same
  trust model as every other system in this game, which has never had a
  server before). Incoming `joust` reports (sent by whoever's client
  detects landing on another player) get broadcast as `jousted` to
  everyone, including the victim.
- **`index.html`** (`MULTIPLAYER` section, near the end of the script) —
  connects on load if `?mp=` is present, sends its own state ~15x/sec,
  renders a small capsule+sphere avatar per remote player, lerps toward
  each remote player's last-known position/yaw between updates, and
  detects joust hits locally (falling fast, close enough in XZ, above the
  target by a small margin) using the same proximity-check style as every
  other collision in this file. Getting jousted reuses the existing
  `triggerGameOver()` — same explosion + death screen as any other death.

## Known scope cuts (v1)

- One shared room for everyone — no room codes/lobbies (wasn't asked for).
- No player names, auth, or anti-cheat — position is client-reported and
  trusted, matching this game's existing trust model everywhere else.
- Remote players render as a simple capsule+sphere, not the full
  spidey-suit rig local players get.
