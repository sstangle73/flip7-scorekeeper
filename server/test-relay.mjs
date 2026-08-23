/* Integration test: drives the relay with two simulated phones over real
 * WebSockets. Run the worker first (`npx wrangler dev --port 8787 --local`),
 * then `node test-relay.mjs`.
 */
const BASE = process.env.RELAY || "http://127.0.0.1:8787";
let pass = 0, fail = 0;

function check(label, cond, detail){
  if(cond){ pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  -> " + detail : "")); }
}

function phone(code, clientId, name){
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + `/api/rooms/${code}/ws`);
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    inbox.push(m);
    for(let i = waiters.length - 1; i >= 0; i--){
      if(waiters[i].match(m)){ waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  const api = {
    ws,
    open: () => new Promise(r => ws.readyState === 1 ? r() : ws.addEventListener("open", r, {once:true})),
    send: o => ws.send(JSON.stringify(o)),
    hello: () => api.send({t:"hello", clientId, name}),
    /* Wait for the next message matching a predicate, with a timeout. */
    next(match, ms = 3000){
      const hit = inbox.find(match);
      if(hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = {match, resolve};
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if(i >= 0){ waiters.splice(i, 1); reject(new Error("timed out waiting for a message")); }
        }, ms);
      });
    },
    /* The most recent state we have seen. */
    latest(){
      for(let i = inbox.length - 1; i >= 0; i--){
        if(inbox[i].t === "state" || inbox[i].t === "welcome") return inbox[i];
      }
      return null;
    },
    clear(){ inbox.length = 0; },
    close(){ ws.close(); }
  };
  return api;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log("\nFlip 7 relay integration test\n");

/* --- health + room creation --- */
const health = await (await fetch(BASE + "/api/health")).json();
check("relay is healthy", health.ok === true, JSON.stringify(health));

const madeRes = await fetch(BASE + "/api/rooms", {method:"POST"});
if(madeRes.status === 429){
  console.log("  SKIP  room creation is rate limited right now (5/min per IP).");
  console.log("        Wait a minute and re-run, or restart `wrangler dev` to reset the local counter.");
  process.exit(2);
}
const made = await madeRes.json();
const code = made.code;
check("room code allocated", typeof code === "string" && code.length === 4, JSON.stringify(made));
check("code avoids ambiguous characters", !/[O0I1]/.test(code), code);

const bad = await fetch(BASE + "/api/rooms/ZZ/ws");
check("a malformed code is rejected", bad.status === 400, "status " + bad.status);

/* --- two phones join --- */
const host = phone(code, "client-host", "Sam");
await host.open(); host.hello();
const hostWelcome = await host.next(m => m.t === "welcome");
check("host receives welcome", hostWelcome.you === "client-host");
check("first client becomes host", hostWelcome.hostId === "client-host");

const guest = phone(code, "client-guest", "Jo");
let guestSock = guest;          // reassigned when the guest reconnects below
await guest.open(); guest.hello();
const guestWelcome = await guestSock.next(m => m.t === "welcome");
check("second client is not host", guestWelcome.hostId === "client-host");

/* --- host sets the table --- */
host.send({t:"action", action:{t:"addPlayer", name:"Sam"}});
await guestSock.next(m => m.t === "state" && m.state.players.length === 1);
host.send({t:"action", action:{t:"addPlayer", name:"Jo"}});
const seen = await guestSock.next(m => m.t === "state" && m.state.players.length === 2);
check("guest sees players the host added", seen.state.players.map(p => p.name).join(",") === "Sam,Jo");

/* --- a guest cannot do host-only things --- */
guestSock.clear();
guestSock.send({t:"action", action:{t:"addPlayer", name:"Sneaky"}});
const rejected = await guestSock.next(m => m.t === "reject");
check("guest cannot add players", /host/i.test(rejected.error), rejected.error);
check("rejection carries authoritative state", rejected.state.players.length === 2);

/* --- seats --- */
host.send({t:"claimSeat", pid:"p0"});
guestSock.send({t:"claimSeat", pid:"p1"});
await sleep(300);
const seatState = guestSock.latest();
check("seats are recorded", seatState.seats["client-host"] === "p0" && seatState.seats["client-guest"] === "p1",
  JSON.stringify(seatState.seats));

guestSock.clear();
guestSock.send({t:"claimSeat", pid:"p0"});
const seatTaken = await guestSock.next(m => m.t === "error");
check("cannot take an occupied seat", /already/i.test(seatTaken.error), seatTaken.error);

/* --- a dropped phone must not let two people share one seat --- */
const ghost = phone(code, "client-ghost", "Ghost");
await ghost.open(); ghost.hello();
await ghost.next(m => m.t === "welcome");
ghost.send({t:"claimSeat", pid:"p1"});      // guest already holds p1, so this is refused
await sleep(250);
ghost.clear();
guest.ws.close();                            // the live holder drops off
await sleep(500);
ghost.send({t:"claimSeat", pid:"p1"});      // now free, so this should succeed
await sleep(400);
const afterGhost = ghost.latest();
check("a seat freed by a dropped phone can be taken",
  afterGhost.seats["client-ghost"] === "p1", JSON.stringify(afterGhost.seats));
check("the dropped phone's stale claim is cleared",
  afterGhost.seats["client-guest"] === undefined, JSON.stringify(afterGhost.seats));
ghost.close();
await sleep(300);

/* the guest comes back and reclaims its seat */
const guest2 = phone(code, "client-guest", "Jo");
await guest2.open(); guest2.hello();
await guest2.next(m => m.t === "welcome");
guest2.send({t:"claimSeat", pid:"p1"});
await sleep(400);
check("the returning phone gets its seat back",
  guest2.latest().seats["client-guest"] === "p1", JSON.stringify(guest2.latest().seats));

/* --- start, then each phone enters its own line --- */
guestSock = guest2;
host.send({t:"action", action:{t:"startGame", names:["Sam","Jo"]}});
await guestSock.next(m => m.t === "state" && m.state.started);

guestSock.clear();
guestSock.send({t:"action", action:{t:"setEntry", pid:"p1", entry:{nums:[3,5,7,10,11], mods:[10], x2:true, bust:false}}});
const guestEntry = await host.next(m => m.t === "state" && m.state.current.p1 && m.state.current.p1.nums.length === 5);
check("guest's own line reaches the host", guestEntry.state.current.p1.nums.join("+") === "3+5+7+10+11");

/* the rulebook's worked example: 36 -> x2 = 72 -> +10 = 82 */
const { default: Flip7Rules } = await import("./src/rules.js");
const G = Flip7Rules();
check("server-side score matches the rulebook", G.scoreOf(guestEntry.state.current.p1) === 82,
  "got " + G.scoreOf(guestEntry.state.current.p1));

guestSock.clear();
guestSock.send({t:"action", action:{t:"setEntry", pid:"p0", entry:{nums:[1], mods:[], x2:false, bust:false}}});
const notYours = await guestSock.next(m => m.t === "reject");
check("a phone cannot edit someone else's line", /your own/i.test(notYours.error), notYours.error);

/* --- the cross-player Flip 7 rule, enforced server-side --- */
host.send({t:"action", action:{t:"setEntry", pid:"p0", entry:{nums:[0,1,2,3,4,5,6], mods:[], x2:false, bust:false}}});
await guestSock.next(m => m.t === "state" && m.state.current.p0 && m.state.current.p0.nums.length === 7);
guestSock.clear();
guestSock.send({t:"action", action:{t:"setEntry", pid:"p1", entry:{nums:[2,3,4,5,6,7,8], mods:[], x2:false, bust:false}}});
const twoSevens = await guestSock.next(m => m.t === "reject");
check("server refuses a second Flip 7 in one round", /Flip 7/i.test(twoSevens.error), twoSevens.error);

/* --- submitting a line, and the host's waiting-on status --- */
guestSock.clear();
guestSock.send({t:"action", action:{t:"setEntry", pid:"p1", entry:{nums:[4,6], mods:[], x2:false, bust:false}}});
await host.next(m => m.t === "state" && m.state.current.p1 && m.state.current.p1.nums.length === 2);
guestSock.send({t:"action", action:{t:"submitEntry", pid:"p1"}});
const submitted = await host.next(m => m.t === "state" && m.state.submitted && m.state.submitted.p1 === true);
check("a submitted line is visible to the whole table", submitted.state.submitted.p1 === true);
check("the host can see who is still out",
  G.outstanding(submitted.state).map(p => p.id).join(",") === "p0",
  G.outstanding(submitted.state).map(p => p.id).join(","));

guestSock.clear();
guestSock.send({t:"action", action:{t:"submitEntry", pid:"p0"}});
const notMine = await guestSock.next(m => m.t === "reject");
check("a phone cannot submit someone else's line", /your own/i.test(notMine.error), notMine.error);

/* changing a line after submitting withdraws it, so a declared score can't move */
guestSock.send({t:"action", action:{t:"setEntry", pid:"p1", entry:{nums:[4,6,8], mods:[], x2:false, bust:false}}});
const withdrawn = await host.next(m => m.t === "state" && m.state.current.p1 && m.state.current.p1.nums.length === 3);
check("editing a submitted line withdraws it", !withdrawn.state.submitted.p1);

guestSock.send({t:"action", action:{t:"submitEntry", pid:"p1"}});
await host.next(m => m.t === "state" && m.state.submitted.p1);

/* --- only the host commits --- */
guestSock.clear();
guestSock.send({t:"action", action:{t:"commitRound"}});
const noCommit = await guestSock.next(m => m.t === "reject");
check("guest cannot commit the round", /host/i.test(noCommit.error), noCommit.error);

host.send({t:"action", action:{t:"commitRound"}});
const committed = await guestSock.next(m => m.t === "state" && m.state.rounds.length === 1);
check("host commits and everyone sees it", committed.state.rounds.length === 1);
/* p0 flipped 7: 0+1+2+3+4+5+6 = 21, +15 = 36.
   p1's line is whatever they last submitted: 4+6+8 = 18. */
check("committed scores are right", G.totalFor(committed.state, "p0") === 36 && G.totalFor(committed.state, "p1") === 18,
  "p0=" + G.totalFor(committed.state, "p0") + " p1=" + G.totalFor(committed.state, "p1"));
check("current round cleared after commit", Object.keys(committed.state.current).length === 0);
check("submissions reset for the next round", Object.keys(committed.state.submitted).length === 0,
  JSON.stringify(committed.state.submitted));

/* --- the host role must never strand the table --- */
host.clear();
host.send({t:"passHost", to:"client-guest"});
const passed = await guestSock.next(m => m.t === "state" && m.hostId === "client-guest");
check("the host can hand the role over", passed.hostId === "client-guest");
check("a non-host cannot grab it back",
  (host.send({t:"passHost", to:"client-host"}), true));
const grabbed = await host.next(m => m.t === "error");
check("passing host is refused for non-hosts", /only the host/i.test(grabbed.error), grabbed.error);

guestSock.send({t:"passHost", to:"client-host"});
await host.next(m => m.t === "state" && m.hostId === "client-host");
check("and back again", true);

check("the room reports who is connected, with names",
  Array.isArray(host.latest().people) && host.latest().people.some(p => p.name === "Jo"),
  JSON.stringify(host.latest().people));

/* --- reconnect keeps the host role and the seat --- */
host.close();
await sleep(400);
const hostAgain = phone(code, "client-host", "Sam");
await hostAgain.open(); hostAgain.hello();
const back = await hostAgain.next(m => m.t === "welcome");
check("reconnecting keeps the host role", back.hostId === "client-host");
check("reconnecting keeps the seat", back.seats["client-host"] === "p0");
check("state survived the reconnect", back.state.rounds.length === 1);

/* --- room info, which the homepage uses to offer a rejoin --- */
const infoMine = await (await fetch(BASE + `/api/rooms/${code}/info?client=client-host`)).json();
check("info says the room is alive", infoMine.exists === true && infoMine.started === true,
  JSON.stringify(infoMine));
check("info tells a returning device what it was", infoMine.you && infoMine.you.seat === "p0",
  JSON.stringify(infoMine.you));
check("info reports the round it is up to", infoMine.rounds === 1, "rounds=" + infoMine.rounds);

const infoStranger = await (await fetch(BASE + `/api/rooms/${code}/info?client=someone-else`)).json();
check("a stranger probing a code learns nothing personal", infoStranger.you === null,
  JSON.stringify(infoStranger.you));
check("but can still see the room exists", infoStranger.exists === true);

const infoDead = await (await fetch(BASE + "/api/rooms/ZZZZ/info?client=x")).json();
check("an unused code reports not-exists rather than creating one", infoDead.exists === false,
  JSON.stringify(infoDead));

hostAgain.close(); guestSock.close();
await sleep(200);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
