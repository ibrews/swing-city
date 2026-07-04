// Swing City multiplayer relay -- a Cloudflare Worker + Durable Object.
//
// Deliberately dumb: the Durable Object is a pure broadcast relay, no
// server-side physics or state authority. Every connected client sends its
// own position/state ~15x/sec; the DO fans that out to everyone else
// as-is. "Joust" hits (Alex: "landing on top of another player makes them
// explode"), stick "poke" hits (Alex: "carrying a jousting stick ... allows
// players to explode each other directly" -- a second, distinct way to
// trigger the same kill), and regular player-to-player "knocks" (Alex: "we
// should be able to knock each other around just like cars") are all
// detected CLIENT-SIDE by the ATTACKING player (same as every other
// collision in this game -- it has no server-authoritative physics anywhere,
// so this matches the existing architecture rather than introducing a new
// one) and reported as a single message ({type:'joust'} / {type:'poke'} /
// {type:'knock'}); the DO just re-broadcasts that as {type:'jousted'} /
// {type:'poked'} / {type:'knocked'} so every client (including the victim)
// finds out at the same time, and only the named victim's OWN client
// applies the resulting death/impulse to itself.
//
// Uses the WebSocket Hibernation API (state.acceptWebSocket, not the older
// addEventListener pattern) so an idle room with open-but-silent sockets
// doesn't have to keep the Durable Object pinned in memory between
// messages -- the recommended modern pattern for this exact "many open
// sockets, bursty traffic" shape.

const COLORS = [0xff5566, 0x55ddff, 0xffe066, 0x8fff8f, 0xc98fff, 0xff9f4d];

// Standard HSL->RGB->hex conversion (Workers have no DOM/Color API) --
// used only as the >6-concurrent-players fallback in pickUniqueColor.
function hslToHex(h, s, l) {
  const k = n => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = n => Math.round(f(n) * 255);
  return (toHex(0) << 16) | (toHex(8) << 8) | toHex(4);
}

// Daily leaderboard (Alex: "a daily leaderboard, separate from the current
// session... refresh all the scores" at midnight EST). No cron/reset job
// needed: the board is keyed by the current EST calendar date, so a new day
// simply reads/writes a fresh, empty key -- storage for old dates is just
// never touched again (Durable Object storage is cheap enough not to
// bother expiring it). Uses `state.storage` (not in-memory), so it survives
// the DO being evicted between bursts of traffic, same as any other
// Cloudflare Durable Object persistence.
const EST_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function estDateKey() { return EST_FMT.format(new Date()); }

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async loadDailyBoard() {
    const dateKey = estDateKey();
    const board = (await this.state.storage.get('daily:' + dateKey)) || {};
    return { dateKey, board };
  }

  dailyTop(board) {
    return Object.values(board).sort((a, b) => b.score - a.score).slice(0, 20);
  }

  // "Players today" (a distinct HUD stat from the live session PLAYERS
  // count) -- same date-keyed storage pattern as the daily leaderboard
  // above, but tracking distinct CONNECTIONS rather than scores. No real
  // login identity exists in this game (see file header -- pure relay, no
  // auth), so "unique" here means unique connection id; a reload or
  // reconnect is a new id and counts again, same tradeoff the daily
  // leaderboard already makes by being keyed on connection id too.
  async recordTodayPlayer(id) {
    const dateKey = estDateKey();
    const key = 'today:' + dateKey;
    const ids = (await this.state.storage.get(key)) || [];
    if (!ids.includes(id)) {
      ids.push(id);
      await this.state.storage.put(key, ids);
    }
    return ids.length;
  }

  // SESSION ANALYTICS (Alex: "good logging from all sessions... play time,
  // how many orbs people tend to get, and errors or crashes"). Same date-
  // keyed aggregate pattern as the two above -- no per-player identity
  // attached, just running totals for the day plus a capped sample of raw
  // error strings (unbounded storage growth from noisy repeated errors
  // would just bloat the Durable Object for no analytical benefit beyond
  // a representative sample).
  async recordAnalytics(report) {
    const dateKey = estDateKey();
    const key = 'analytics:' + dateKey;
    // reportCount, not "sessions" -- a single session sends one of these
    // roughly every ANALYTICS_INTERVAL_MS plus one at game-over, so this
    // counts CHECKPOINTS, not distinct players (see recordTodayPlayer
    // above for the actual unique-connection count).
    const agg = (await this.state.storage.get(key)) || { reportCount: 0, totalPlaySeconds: 0, totalOrbs: 0, errorCount: 0, errorSamples: [] };
    agg.reportCount++;
    agg.totalPlaySeconds += typeof report.playSeconds === 'number' ? Math.max(0, report.playSeconds) : 0;
    agg.totalOrbs += typeof report.orbs === 'number' ? Math.max(0, report.orbs) : 0;
    if (Array.isArray(report.errors)) {
      agg.errorCount += report.errors.length;
      for (const e of report.errors) {
        if (agg.errorSamples.length < 20) agg.errorSamples.push(String(e).slice(0, 200));
      }
    }
    await this.state.storage.put(key, agg);
  }

  // UNIQUE COLORS (Alex: "make sure everyone gets a unique color!"). Picking
  // purely at random from the 6-entry COLORS palette collided constantly --
  // even at just 2 players, 1-in-6 odds of a repeat every join. Checks every
  // currently-connected socket's color tag first and picks a free one from
  // the curated palette; if the room somehow has more than 6 players and the
  // whole palette is taken, falls back to a procedurally generated distinct
  // hue rather than silently repeating.
  pickUniqueColor() {
    const used = new Set();
    for (const ws of this.state.getWebSockets()) {
      const [, colorStr] = this.state.getTags(ws);
      used.add(Number(colorStr));
    }
    const free = COLORS.filter(c => !used.has(c));
    if (free.length) return free[Math.floor(Math.random() * free.length)];
    let hue = Math.random();
    for (let tries = 0; tries < 50; tries++) {
      const hex = hslToHex(hue, 0.65, 0.6);
      if (!used.has(hex)) return hex;
      hue = (hue + 0.17) % 1;
    }
    return COLORS[Math.floor(Math.random() * COLORS.length)];   // give up, accept a repeat
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const id = crypto.randomUUID();
    const color = this.pickUniqueColor();
    // Tags let us recover per-socket metadata after hibernation without
    // keeping a live JS closure around -- see webSocketMessage/Close below.
    // Color rides along as a SECOND tag so every future state broadcast for
    // this player can include it (a player's own color is assigned once,
    // here, and never changes -- no need for clients to keep re-sending it).
    this.state.acceptWebSocket(server, [id, String(color)]);
    server.send(JSON.stringify({ type: 'welcome', id, color }));

    // Tell the newcomer about everyone already in the room (with their
    // colors, so an avatar never has to render in a placeholder color even
    // for the first frame), and tell everyone already in the room about
    // the newcomer.
    for (const ws of this.state.getWebSockets()) {
      if (ws === server) continue;
      const [otherId, otherColor] = this.state.getTags(ws);
      server.send(JSON.stringify({ type: 'join', id: otherId, color: Number(otherColor) }));
      // We don't retain last-known POSITION server-side (pure relay, no
      // state authority -- see file header), so a joiner's avatar only
      // actually appears to others once it sends its first state update.
      ws.send(JSON.stringify({ type: 'join', id, color }));
    }

    const { dateKey, board } = await this.loadDailyBoard();
    server.send(JSON.stringify({ type: 'dailyboard', date: dateKey, entries: this.dailyTop(board) }));

    const playersToday = await this.recordTodayPlayer(id);
    this.broadcast({ type: 'today', count: playersToday });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const [id, colorStr] = this.state.getTags(ws);
    if (msg.type === 'state') {
      // anchor now carries the actual [x,y,z] world position of whatever
      // building the sender is swinging from (or null), not just a
      // boolean -- Alex: "we should see each other's webs", which needs
      // the real anchor point to draw a line to, not just "someone's
      // swinging."
      // initials + score ride along here too (leaderboard + name tags) --
      // same "sender reports its own state, DO just relays" shape as
      // everything else; no server-side score authority, so a player's
      // score is only as fresh as their last state packet (~15/sec).
      this.broadcast({
        type: 'state', id, color: Number(colorStr), pos: msg.pos, yaw: msg.yaw,
        anchor: Array.isArray(msg.anchor) ? msg.anchor : null, alive: msg.alive !== false,
        initials: typeof msg.initials === 'string' ? msg.initials.slice(0, 3).toUpperCase() : '',
        score: typeof msg.score === 'number' ? msg.score : 0,
      }, ws);
    } else if (msg.type === 'joust' && typeof msg.victimId === 'string') {
      this.broadcast({ type: 'jousted', victimId: msg.victimId, byId: id });
    } else if (msg.type === 'poke' && typeof msg.victimId === 'string') {
      // Stick-poke (Alex: "all players are carrying a thin jousting stick
      // ... this allows players to explode each other directly") -- a
      // second, distinct way to trigger the same instakill/explode effect
      // as a joust, same "attacker reports, only the named victim acts on
      // it" shape.
      this.broadcast({ type: 'poked', victimId: msg.victimId, byId: id });
    } else if (msg.type === 'knock' && typeof msg.victimId === 'string' && Array.isArray(msg.dir)) {
      // Regular body-to-body contact (Alex: "we should be able to knock
      // each other around just like cars") -- same "attacker reports, only
      // the named victim acts on it" shape as joust, since there's no
      // server-authoritative physics here for the DO to apply directly.
      this.broadcast({ type: 'knocked', victimId: msg.victimId, byId: id, dir: msg.dir, momentum: msg.momentum });
    } else if (msg.type === 'leader' && typeof msg.initials === 'string' && typeof msg.score === 'number') {
      // Leaderboard-topping announcement (Alex: "whenever someone becomes
      // a new leader, everyone should see text..."). Same shape as
      // joust/knock: the client that just became #1 detects that itself
      // and reports once; broadcast (no exclude) so the new leader ALSO
      // sees their own banner, same as an attacker sees its own joust
      // resolve.
      this.broadcast({ type: 'leader', id, initials: msg.initials.slice(0, 3).toUpperCase(), score: msg.score });
    } else if (msg.type === 'dailyscore' && typeof msg.initials === 'string' && typeof msg.score === 'number') {
      // Daily leaderboard entry -- persisted (unlike everything else in this
      // file), keyed by EST calendar date so it naturally resets at
      // midnight EST without a cron job (see estDateKey/loadDailyBoard).
      // Client sends this only when ITS OWN score just beat its own prior
      // best (see updateLeaderboard in index.html), so this only ever
      // ratchets up, never down.
      const { dateKey, board } = await this.loadDailyBoard();
      const initials = msg.initials.slice(0, 3).toUpperCase();
      const prev = board[id];
      // color rides along so the client can render each row in that
      // player's own game color (Alex: "your game color should show up
      // in the leaderboard as your text's initial colors").
      const color = typeof msg.color === 'number' ? msg.color : Number(colorStr);
      if (!prev || msg.score > prev.score) {
        board[id] = { initials, score: msg.score, color };
        await this.state.storage.put('daily:' + dateKey, board);
      }
      this.broadcast({ type: 'dailyboard', date: dateKey, entries: this.dailyTop(board) });
    } else if (msg.type === 'analytics' && msg.report && typeof msg.report === 'object') {
      // Server-side only -- no broadcast, this never needs to reach other
      // clients (see recordAnalytics above).
      await this.recordAnalytics(msg.report);
    } else if (msg.type === 'pickup' && Array.isArray(msg.pos)) {
      // Orb/coin collection (Alex: "show a floating +N popup AND play a
      // coin sound every time, for ALL players, not just the collector").
      // Announcement-only, excluded from the sender (it already applied
      // its own popup+sound locally) -- same shape as the solo 'effect'
      // broadcast.
      this.broadcast({ type: 'pickup', pos: msg.pos, amount: typeof msg.amount === 'number' ? msg.amount : 0 }, ws);
    } else if (msg.type === 'powerkill' && typeof msg.victimId === 'string') {
      // Energy blast / pong / bomber instakill -- generalized joust: one
      // message type instead of three, since the client-side effect (named
      // victim's own client dies) is identical regardless of WHICH power-up
      // caused it.
      this.broadcast({ type: 'powerkilled', victimId: msg.victimId, byId: id });
    } else if (msg.type === 'shrinktag' && typeof msg.victimId === 'string') {
      // Shrink-tag: a targeted attack (touch another player to shrink
      // THEM), not a self/everyone buff -- same shape again, byColor rides
      // along so bystanders can render "X SHRUNK Y!!" without a lookup.
      this.broadcast({ type: 'shrinktagged', victimId: msg.victimId, byId: id, byColor: Number(colorStr) });
    } else if (msg.type === 'effect' && typeof msg.name === 'string') {
      // Power-up orb system (Alex's "Delegation Manifest" item 14). SOLO
      // triggers (solid orb) apply instantly on the toucher's own client
      // (see triggerSoloEffect in index.html) -- this broadcast is
      // announcement-only, so it's excluded from the sender like 'state'.
      // EVERYONE triggers (halo orb) carry the actual effect and go to
      // ALL sockets including the sender, same no-exclude shape as
      // joust/knock, so every client (sender included) applies it from one
      // consistent code path.
      // initials rides along so the banner can attribute "who" instead of
      // just a color name (Alex: "It should use my initials, not green").
      const effectInitials = typeof msg.initials === 'string' ? msg.initials.slice(0, 3).toUpperCase() : '';
      if (msg.world) {
        this.broadcast({ type: 'poweractivated', name: msg.name, world: true, byId: id, color: Number(colorStr), initials: effectInitials, pos: Array.isArray(msg.pos) ? msg.pos : null });
      } else {
        this.broadcast({ type: 'poweractivated', name: msg.name, world: false, byId: id, color: Number(colorStr), initials: effectInitials }, ws);
      }
    }
  }

  async webSocketClose(ws) {
    const [id] = this.state.getTags(ws);
    this.broadcast({ type: 'leave', id }, ws);
  }
  async webSocketError(ws) {
    const [id] = this.state.getTags(ws);
    this.broadcast({ type: 'leave', id }, ws);
  }

  broadcast(obj, exclude) {
    const json = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(json); } catch { /* socket already gone -- hibernation cleans it up */ }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') return new Response('swing-city multiplayer relay -- connect to /ws', { status: 200 });
    // Single shared room for the whole game (Alex didn't ask for room
    // codes/lobbies) -- everyone who connects lands in the same session.
    const id = env.ROOM.idFromName('main');
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};
