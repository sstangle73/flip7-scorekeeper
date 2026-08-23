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
const ROOM_TTL_MS = 1000 * 60 * 60 * 24 * 7;   // a week of inactivity

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

    /* Create a room: find an unused code and hand it back. */
    if(path === "/api/rooms" && request.method === "POST"){
      for(let attempt = 0; attempt < 8; attempt++){
        const code = randomCode();
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
        const res = await stub.fetch(new Request("https://room/claim", {method: "POST"}));
        if(res.status === 200) return json({code});
      }
      return json({error: "Couldn't allocate a room code, please try again."}, 503);
    }

    /* Join a room over a WebSocket. */
    const m = path.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if(m){
      const code = m[1].toUpperCase();
      if(!validCode(code)) return json({error: "That room code doesn't look right."}, 400);
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
        created: 0, hostId: null, seats: {}, exists: false
      };
    });
  }

  async persist(){
    await this.ctx.storage.put("state", this.state);
    await this.ctx.storage.put("meta", this.meta);
  }

  async fetch(request){
    await this.loaded;
    const url = new URL(request.url);

    /* Claim: succeeds only if this code has never been used. */
    if(url.pathname === "/claim"){
      if(this.meta.exists) return new Response("taken", {status: 409});
      this.meta.exists = true;
      this.meta.created = Date.now();
      await this.persist();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return new Response("ok", {status: 200});
    }

    if(url.pathname === "/ws"){
      if(request.headers.get("Upgrade") !== "websocket"){
        return new Response("Expected a WebSocket upgrade.", {status: 426});
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      /* Hibernation: the DO can be evicted between messages and the socket
         still survives, so an idle table costs nothing. */
      this.ctx.acceptWebSocket(server);
      this.meta.exists = true;
      await this.persist();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);

      return new Response(null, {status: 101, webSocket: client});
    }

    return new Response("Not found", {status: 404});
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
      present: this.presentClients()
    });
    for(const ws of this.sockets()){
      try { ws.send(payload); } catch(e){ /* dropping socket, ignore */ }
    }
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
      await this.persist();

      this.send(ws, {
        t: "welcome",
        you: clientId,
        hostId: this.meta.hostId,
        state: this.state,
        seats: this.meta.seats,
        present: this.presentClients()
      });
      this.broadcastState();
      return;
    }

    if(!a.clientId) return this.send(ws, {t:"error", error:"Say hello first."});

    if(msg.t === "claimSeat"){
      const pid = msg.pid;
      const exists = this.state.players.some(p => p.id === pid);
      if(!exists) return this.send(ws, {t:"error", error:"No such player."});
      const takenBy = Object.keys(this.meta.seats).find(
        cid => this.meta.seats[cid] === pid && cid !== a.clientId
      );
      if(takenBy && this.presentClients().includes(takenBy)){
        return this.send(ws, {t:"error", error:"Someone else is already on that seat."});
      }
      this.meta.seats[a.clientId] = pid;
      await this.persist();
      this.broadcastState();
      return;
    }

    if(msg.t === "releaseSeat"){
      delete this.meta.seats[a.clientId];
      await this.persist();
      this.broadcastState();
      return;
    }

    if(msg.t === "action"){
      const actor = {
        isHost: this.isHost(a.clientId),
        seat: this.meta.seats[a.clientId] || null
      };
      const res = G.applyAction(this.state, msg.action, actor);
      if(!res.ok){
        this.send(ws, {t:"reject", error: res.error, state: this.state, seats: this.meta.seats, hostId: this.meta.hostId});
        return;
      }
      this.state = res.state;

      /* Seats can outlive the players they point at. */
      const alive = new Set(this.state.players.map(p => p.id));
      for(const cid of Object.keys(this.meta.seats)){
        if(!alive.has(this.meta.seats[cid])) delete this.meta.seats[cid];
      }
      await this.persist();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      this.broadcastState();
      return;
    }

    if(msg.t === "ping") return this.send(ws, {t:"pong"});

    this.send(ws, {t:"error", error:"Unrecognised message."});
  }

  async webSocketClose(ws){
    await this.loaded;
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
