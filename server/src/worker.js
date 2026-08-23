/* Flip 7 Scorekeeper relay.
 *
 * One Durable Object per room. The DO owns the authoritative game state and is
 * the only thing that may mutate it; every connected phone sends actions and
 * receives the resulting state.
 *
 * It scores nothing itself — all rules live in rules.js, generated from
 * src/game.js by build.sh, so the server and the browser cannot drift apart.
 */
import Flip7Rules from "./rules.js";

const G = Flip7Rules();

/* No O/0/I/1 — these get read aloud across a table. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const ROOM_TTL_MS = 1000 * 60 * 60 * 24 * 7;   // a week of inactivity, once in use
const UNCLAIMED_TTL_MS = 1000 * 60 * 60;       // an allocated but never-joined room
const HOST_GRACE_MS = 1000 * 90;               // before the room promotes someone else

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(body, status = 200){
  return new Response(JSON.stringify(body), {
    status,
    headers: {"Content-Type": "application/json", ...CORS}
  });
}

function randomCode(){
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for(const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/* One IP per household behind NAT, so this is a blunt instrument by design:
   tight on creating rooms, loose on joining them. */
function clientIp(request){
  return request.headers.get("CF-Connecting-IP") || "local";
}

/* A missing binding (local dev, or a fork that hasn't configured one) must not
   break the service, and neither should the limiter itself failing. */
async function withinLimit(limiter, key){
  if(!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch(e){
    return true;
  }
}

function validCode(code){
  return typeof code === "string" &&
    code.length === CODE_LENGTH &&
    [...code].every(c => CODE_ALPHABET.includes(c));
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if(request.method === "OPTIONS") return new Response(null, {headers: CORS});

    if(path === "/" || path === "/api/health"){
      return json({service: "flip7-relay", ok: true});
    }

    /* Aggregate counters. Deliberately dull: how much the relay is being used
       and nothing about who is using it. There are no per-player, per-game or
       per-room figures here, and room codes are never exposed -- publishing
       those would hand out a list of live games to walk into. */
    if(path === "/api/stats"){
      const stub = env.STATS.get(env.STATS.idFromName("global"));
      return stub.fetch(new Request("https://stats/read?now=" + Date.now()));
    }

    /* Create a room: find an unused code and hand it back. */
    if(path === "/api/rooms" && request.method === "POST"){
      if(!await withinLimit(env.ROOM_CREATE_LIMIT, clientIp(request))){
        return json({error: "That's a lot of rooms at once. Wait a minute and try again."}, 429);
      }
      for(let attempt = 0; attempt < 8; attempt++){
        const code = randomCode();
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
        const res = await stub.fetch(new Request("https://room/claim?code=" + code, {method: "POST"}));
        if(res.status === 200) return json({code});
      }
      return json({error: "Couldn't allocate a room code, please try again."}, 503);
    }

    /* Is this room still alive? Lets a returning device offer "rejoin" without
       silently resurrecting a room that has already expired. */
    const info = path.match(/^\/api\/rooms\/([^/]+)\/info$/);
    if(info){
      const code = info[1].toUpperCase();
      if(!validCode(code)) return json({error: "That room code doesn't look right."}, 400);
      if(!await withinLimit(env.ROOM_JOIN_LIMIT, clientIp(request))){
        return json({error: "Too many lookups. Wait a minute and try again."}, 429);
      }
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
      const who = url.searchParams.get("client") || "";
      return stub.fetch(new Request("https://room/info?client=" + encodeURIComponent(who)));
    }

    /* Join a room over a WebSocket. */
    const m = path.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if(m){
      const code = m[1].toUpperCase();
      if(!validCode(code)) return json({error: "That room code doesn't look right."}, 400);
      if(!await withinLimit(env.ROOM_JOIN_LIMIT, clientIp(request))){
        return json({error: "Too many join attempts. Wait a minute and try again."}, 429);
      }
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
      return stub.fetch(new Request(`https://room/ws?code=${code}`, {
        headers: request.headers
      }));
    }

    return json({error: "Not found."}, 404);
  }
};

export class GameRoom {
  constructor(ctx, env){
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.meta = null;
    /* clientId -> {seat, name} for every socket, live or hibernating. */
    this.loaded = this.ctx.blockConcurrencyWhile(async () => {
      this.state = (await this.ctx.storage.get("state")) || G.newGame();
      this.meta = (await this.ctx.storage.get("meta")) || {
        created: 0, hostId: null, hostGoneSince: 0, seats: {}, seatNames: {}, exists: false
      };
      this.lastState = JSON.stringify(this.state);
      this.lastMeta = JSON.stringify(this.meta);
      this.lastTouch = 0;
    });
  }

  /* Every put() and every setAlarm() is a billed row written, and this runs on
     each card tap, so write only what actually changed. */
  async persist(){
    const meta = JSON.stringify(this.meta);
    const state = JSON.stringify(this.state);
    const writes = {};
    if(state !== this.lastState){ writes.state = this.state; this.lastState = state; }
    if(meta !== this.lastMeta){ writes.meta = this.meta; this.lastMeta = meta; }
    const keys = Object.keys(writes);
    if(!keys.length) return;
    await this.ctx.storage.put(writes);
  }

  /* Push the expiry out at most once an hour rather than on every message. */
  async touch(){
    const now = Date.now();
    if(this.lastTouch && now - this.lastTouch < 3600000) return;
    this.lastTouch = now;
    await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
  }

  async fetch(request){
    await this.loaded;
    const url = new URL(request.url);

    /* Claim: succeeds only if this code has never been used. */
    if(url.pathname === "/claim"){
      if(this.meta.exists) return new Response("taken", {status: 409});
      this.meta.exists = true;
      this.meta.created = Date.now();
      this.meta.code = url.searchParams.get("code") || "";
      await this.persist();
      this.bump("room", this.meta.code);
      /* Anyone can POST for a code, so an unvisited room expires in an hour
         rather than squatting on storage for a week. */
      await this.ctx.storage.setAlarm(Date.now() + UNCLAIMED_TTL_MS);
      return new Response("ok", {status: 200});
    }

    if(url.pathname === "/info"){
      const who = url.searchParams.get("client") || "";
      const mine = !!this.meta.seats[who] || this.meta.hostId === who;
      const body = {
        exists: !!this.meta.exists,
        started: !!this.state.started,
        players: this.state.players.length,
        rounds: this.state.rounds.length,
        /* Names only for a device that was actually in this room. Anyone can
           probe a code; they should not learn who is playing. */
        you: mine ? {
          host: this.meta.hostId === who,
          seat: this.meta.seats[who] || null,
          seatName: (this.state.players.find(p => p.id === this.meta.seats[who]) || {}).name || null
        } : null
      };
      return new Response(JSON.stringify(body), {
        headers: {"Content-Type": "application/json", ...CORS}
      });
    }

    if(url.pathname === "/ws"){
      if(request.headers.get("Upgrade") !== "websocket"){
        return new Response("Expected a WebSocket upgrade.", {status: 426});
      }
      /* Connecting must never bring a room into being. Otherwise every probe of
         the code space reserves a code for a week, outside the creation limit,
         and a mistyped code silently drops someone into their own empty room
         instead of telling them it does not exist. */
      if(!this.meta.exists){
        return new Response(JSON.stringify({error: "No room with that code. Check it and try again."}), {
          status: 404,
          headers: {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}
        });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      /* Hibernation: the DO can be evicted between messages and the socket
         still survives, so an idle table costs nothing. */
      this.ctx.acceptWebSocket(server);
      await this.touch();

      return new Response(null, {status: 101, webSocket: client});
    }

    return new Response("Not found", {status: 404});
  }

  /* Fire-and-forget: a counter must never be able to break a game. */
  bump(kind, code){
    try {
      const stub = this.env.STATS.get(this.env.STATS.idFromName("global"));
      const url = "https://stats/bump?kind=" + kind + "&now=" + Date.now() +
                  (code ? "&room=" + encodeURIComponent(code) : "");
      this.ctx.waitUntil(stub.fetch(new Request(url)).catch(() => {}));
    } catch(e){ /* counters are optional */ }
  }

  sockets(){ return this.ctx.getWebSockets(); }

  attach(ws){
    let a = ws.deserializeAttachment();
    if(!a){ a = {clientId: null, name: null}; ws.serializeAttachment(a); }
    return a;
  }

  broadcastState(){
    const payload = JSON.stringify({
      t: "state",
      state: this.state,
      seats: this.meta.seats,
      hostId: this.meta.hostId,
      present: this.presentClients(),
      people: this.people()
    });
    for(const ws of this.sockets()){
      try { ws.send(payload); } catch(e){ /* dropping socket, ignore */ }
    }
  }

  /* Everyone currently connected, with the name they joined under. */
  people(){
    const out = [];
    for(const ws of this.sockets()){
      const a = this.attach(ws);
      if(a.clientId) out.push({id: a.clientId, name: a.name || "Player"});
    }
    return out;
  }

  presentClients(){
    const ids = [];
    for(const ws of this.sockets()){
      const a = this.attach(ws);
      if(a.clientId) ids.push(a.clientId);
    }
    return ids;
  }

  send(ws, obj){
    try { ws.send(JSON.stringify(obj)); } catch(e){ /* socket gone */ }
  }

  isHost(clientId){ return this.meta.hostId === clientId; }

  /* A host who never comes back would otherwise leave the table unable to score
     anything, so hand the role on after a grace period. Someone reconnecting
     inside that window keeps it. */
  maybePromoteHost(){
    const present = this.presentClients();
    if(!present.length) return false;
    if(this.meta.hostId && present.includes(this.meta.hostId)){
      this.meta.hostGoneSince = 0;
      return false;
    }
    const now = Date.now();
    if(!this.meta.hostId){
      this.meta.hostId = present[0];
      this.meta.hostGoneSince = 0;
      return true;
    }
    if(!this.meta.hostGoneSince){ this.meta.hostGoneSince = now; return false; }
    if(now - this.meta.hostGoneSince < HOST_GRACE_MS) return false;
    this.meta.hostId = present[0];
    this.meta.hostGoneSince = 0;
    return true;
  }

  /* A socket that is past the HTTP rate limits still costs a storage write and
     an N-way broadcast per message, so give each one a budget. Generous enough
     that fast tapping never trips it. */
  overBudget(ws, a){
    const now = Date.now();
    if(!a.winStart || now - a.winStart > 10000){ a.winStart = now; a.count = 0; }
    a.count = (a.count || 0) + 1;
    ws.serializeAttachment(a);
    return a.count > 120;                     // 12 messages a second, sustained
  }

  async webSocketMessage(ws, raw){
    await this.loaded;
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ return this.send(ws, {t:"error", error:"Malformed message."}); }
    const a = this.attach(ws);

    if(msg.t === "hello"){
      const clientId = typeof msg.clientId === "string" ? msg.clientId.slice(0, 64) : null;
      if(!clientId) return this.send(ws, {t:"error", error:"Missing client id."});
      ws.serializeAttachment({clientId, name: G.cleanName(msg.name, "Player")});

      /* First device through the door hosts. If the host's id reappears after a
         reconnect it keeps the role, so backgrounding a phone doesn't lose it. */
      if(!this.meta.hostId) this.meta.hostId = clientId;
      if(this.meta.hostId === clientId) this.meta.hostGoneSince = 0;
      this.maybePromoteHost();
      await this.persist();

      this.send(ws, {
        t: "welcome",
        you: clientId,
        hostId: this.meta.hostId,
        state: this.state,
        seats: this.meta.seats,
        present: this.presentClients(),
        people: this.people()
      });
      this.broadcastState();
      return;
    }

    if(!a.clientId) return this.send(ws, {t:"error", error:"Say hello first."});

    if(this.overBudget(ws, a)){
      this.send(ws, {t:"error", error:"Slow down a moment."});
      return;
    }

    if(msg.t === "passHost"){
      if(!this.isHost(a.clientId)) return this.send(ws, {t:"error", error:"Only the host can pass that on."});
      const to = msg.to;
      if(!this.presentClients().includes(to)){
        return this.send(ws, {t:"error", error:"That player isn't connected."});
      }
      this.meta.hostId = to;
      this.meta.hostGoneSince = 0;
      await this.persist();
      this.broadcastState();
      return;
    }

    if(msg.t === "claimSeat"){
      const pid = msg.pid;
      const exists = this.state.players.some(p => p.id === pid);
      if(!exists) return this.send(ws, {t:"error", error:"No such player."});
      /* Look at every client on this seat, not just the first one found: a
         stale entry from a dropped phone would otherwise mask a live holder
         and let two people share a seat. */
      const present = this.presentClients();
      const holders = Object.keys(this.meta.seats).filter(
        cid => this.meta.seats[cid] === pid && cid !== a.clientId
      );
      if(holders.some(cid => present.includes(cid))){
        return this.send(ws, {t:"error", error:"Someone else is already on that seat."});
      }
      /* Nobody live holds it, so drop the stale claims rather than let them pile up. */
      holders.forEach(cid => { delete this.meta.seats[cid]; });
      this.meta.seats[a.clientId] = pid;
      /* Record the name too, so a roster edit that reuses an id under a
         different person is caught rather than silently inherited. */
      if(!this.meta.seatNames) this.meta.seatNames = {};
      this.meta.seatNames[a.clientId] = (this.state.players.find(p => p.id === pid) || {}).name || "";
      await this.persist();
      this.broadcastState();
      return;
    }

    if(msg.t === "releaseSeat"){
      delete this.meta.seats[a.clientId];
      if(this.meta.seatNames) delete this.meta.seatNames[a.clientId];
      await this.persist();
      this.broadcastState();
      return;
    }

    if(msg.t === "action"){
      if(this.maybePromoteHost()) await this.persist();
      const actor = {
        isHost: this.isHost(a.clientId),
        seat: this.meta.seats[a.clientId] || null
      };
      const before = this.state;
      const res = G.applyAction(this.state, msg.action, actor);
      if(!res.ok){
        this.send(ws, {t:"reject", error: res.error, state: this.state, seats: this.meta.seats, hostId: this.meta.hostId});
        return;
      }
      const wasWon = before.players.some(p => G.totalFor(before, p.id) >= before.target);
      this.state = res.state;
      if(msg.action && msg.action.t === "commitRound"){
        this.bump("round", this.meta.code);
        const nowWon = this.state.players.some(p => G.totalFor(this.state, p.id) >= this.state.target);
        if(nowWon && !wasWon) this.bump("finish", this.meta.code);
      }

      /* Seats can outlive the players they point at, and an id can be reused by
         a different person. Drop a seat if its player is gone OR is no longer
         the person who claimed it. */
      const byId = new Map(this.state.players.map(p => [p.id, p]));
      if(!this.meta.seatNames) this.meta.seatNames = {};
      for(const cid of Object.keys(this.meta.seats)){
        const player = byId.get(this.meta.seats[cid]);
        const claimed = this.meta.seatNames[cid];
        if(!player || (claimed !== undefined && claimed !== "" && player.name !== claimed)){
          delete this.meta.seats[cid];
          delete this.meta.seatNames[cid];
        }
      }
      await this.persist();
      await this.touch();
      this.broadcastState();
      return;
    }

    if(msg.t === "ping") return this.send(ws, {t:"pong"});

    this.send(ws, {t:"error", error:"Unrecognised message."});
  }

  async webSocketClose(ws){
    await this.loaded;
    /* Note the moment the host dropped; the grace period runs from here. */
    if(this.meta.hostId && !this.presentClients().includes(this.meta.hostId) && !this.meta.hostGoneSince){
      this.meta.hostGoneSince = Date.now();
      await this.persist();
    }
    this.broadcastState();
  }

  async webSocketError(ws){
    await this.loaded;
    this.broadcastState();
  }

  /* Rooms are disposable. A week after the last action, drop everything. */
  async alarm(){
    await this.ctx.storage.deleteAll();
  }
}

/* Counters for the whole relay. One object, so the numbers are consistent; the
 * write rate is one per room created and one per round scored, which is a
 * rounding error next to the traffic a game itself generates.
 */
export class Stats {
  constructor(ctx, env){
    this.ctx = ctx;
    this.env = env;
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      this.d = (await ctx.storage.get("d")) || {
        roomsCreated: 0, roundsScored: 0, gamesFinished: 0, since: 0, active: {}
      };
    });
  }

  /* A room counts as live if it has done something in the last half hour. */
  prune(now){
    const cutoff = now - 30 * 60 * 1000;
    for(const k of Object.keys(this.d.active)){
      if(this.d.active[k] < cutoff) delete this.d.active[k];
    }
  }

  async fetch(request){
    await this.loaded;
    const url = new URL(request.url);
    const now = Number(url.searchParams.get("now")) || 0;

    if(url.pathname === "/bump"){
      const kind = url.searchParams.get("kind");
      const room = url.searchParams.get("room") || "";
      if(!this.d.since) this.d.since = now;
      if(kind === "room") this.d.roomsCreated++;
      else if(kind === "round") this.d.roundsScored++;
      else if(kind === "finish") this.d.gamesFinished++;
      if(room) this.d.active[room] = now;
      this.prune(now);
      await this.ctx.storage.put("d", this.d);
      return new Response("ok");
    }

    if(url.pathname === "/read"){
      this.prune(now);
      const body = {
        roomsCreated: this.d.roomsCreated,
        roundsScored: this.d.roundsScored,
        gamesFinished: this.d.gamesFinished,
        liveRooms: Object.keys(this.d.active).length,
        since: this.d.since || null,
        note: "Aggregate counts only: no names and no scores. Room codes are held for 30 minutes to count active rooms and are never returned here."
      };
      return new Response(JSON.stringify(body, null, 1), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=30",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return new Response("Not found", {status: 404});
  }
}
