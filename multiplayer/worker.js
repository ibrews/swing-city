// Swing City multiplayer relay -- a Cloudflare Worker + Durable Object.
//
// Deliberately dumb: the Durable Object is a pure broadcast relay, no
// server-side physics or state authority. Every connected client sends its
// own position/state ~15x/sec; the DO fans that out to everyone else
// as-is. "Joust" hits (Alex: "landing on top of another player makes them
// explode") are detected CLIENT-SIDE by the stomping player (same as every
// other collision in this game -- it has no server-authoritative physics
// anywhere, so this matches the existing architecture rather than
// introducing a new one) and reported as a single {type:'joust'} message;
// the DO just re-broadcasts that as {type:'jousted'} so every client
// (including the victim) finds out at the same time.
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
    this.state.acceptWebSocket(server, [id]);
    server.send(JSON.stringify({ type: 'welcome', id, color }));

    // Tell the newcomer about everyone already in the room, and tell
    // everyone already in the room about the newcomer.
    for (const ws of this.state.getWebSockets()) {
      if (ws === server) continue;
      const [otherId] = this.state.getTags(ws);
      // We don't retain last-known position server-side (pure relay, no
      // state authority -- see file header), so a joiner only appears to
      // others once IT sends its first state update, not immediately here.
      ws.send(JSON.stringify({ type: 'join', id }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const [id] = this.state.getTags(ws);
    if (msg.type === 'state') {
      this.broadcast({ type: 'state', id, pos: msg.pos, yaw: msg.yaw, anchor: !!msg.anchor, alive: msg.alive !== false }, ws);
    } else if (msg.type === 'joust' && typeof msg.victimId === 'string') {
      this.broadcast({ type: 'jousted', victimId: msg.victimId, byId: id });
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
