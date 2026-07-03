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

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const id = crypto.randomUUID();
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
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
