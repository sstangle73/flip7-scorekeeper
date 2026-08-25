/* Unit tests for the interface's decisions: who may edit what, which controls
 * appear, and who the table is waiting on.
 *
 * These used to be unreachable -- half the codebase lives inside app.js with the
 * DOM, so the only way to find a bug in it was to hit one mid-game. Both bugs
 * anyone actually reported ("why am i not seeing the mark ready option", and the
 * round that would not score) were decisions of exactly this kind.
 *
 * Run with `node test-view.mjs`.
 */
import { readFileSync } from "node:fs";

/* Both modules are plain browser scripts, loaded the same way test-qr.mjs loads
   the encoder -- no build step, so there is no generated copy to go stale. */
const load = (file, name) =>
  new Function(readFileSync(file, "utf8") + "; return " + name + ";")();
const G = load("src/game.js", "Flip7Rules")();
const V = load("src/view.js", "Flip7View")(G);

let pass = 0, fail = 0;
function check(label, cond, detail){
  if(cond){ pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  -> " + detail : "")); }
}

/* A table of four, two of them on their own phones. */
function table(){
  let s = G.newGame();
  s = G.applyAction(s, {t:"startGame", names:["Alice","Bob","Carol","Dave"]}, {isHost:true}).state;
  return s;
}
const SOLO = {room:"", you:null, hostId:null, seats:{}, present:[], mode:"table", seat:0};
const HOST = {room:"ABCD", you:"c-alice", hostId:"c-alice",
              seats:{"c-alice":"p0", "c-bob":"p1"}, present:["c-alice","c-bob"],
              mode:"table", seat:0};
const BOB = {...HOST, you:"c-bob"};
const WATCHER = {...HOST, you:"c-nobody", present:["c-alice","c-bob","c-nobody"]};

const entry = o => Object.assign({nums:[], mods:[], x2:false, bust:false}, o);
const withEntry = (s, pid, e) => G.applyAction(s, {t:"setEntry", pid, entry:e}, {isHost:true}).state;
const submit = (s, pid) => G.applyAction(s, {t:"submitEntry", pid}, {isHost:true}).state;
const names = list => list.map(p => p.name).join(",");

console.log("\nWho am I at this table\n");
check("solo, the player at the screen runs the game", V.isHost(SOLO) === true);
check("solo, nobody holds a particular seat", V.mySeat(SOLO) === null);
check("networked, the relay decides who hosts", V.isHost(HOST) === true && V.isHost(BOB) === false);
check("a phone knows its own seat", V.mySeat(BOB) === "p1");
check("a phone with no seat is a spectator", V.mySeat(WATCHER) === null);
check("a spectator is not the host", V.isHost(WATCHER) === false);

console.log("\nWho may edit which line\n");
check("solo, every line is editable", V.canEdit(SOLO, "p2") === true);
check("the host may edit anyone", V.canEdit(HOST, "p2") === true);
check("a phone may edit its own line", V.canEdit(BOB, "p1") === true);
check("but not somebody else's", V.canEdit(BOB, "p0") === false);
check("a spectator may edit nothing", V.canEdit(WATCHER, "p0") === false);

let s = table();
s = withEntry(s, "p1", entry({nums:[5, 9]}));
s = submit(s, "p1");
check("a submitted line is frozen for its owner", V.lineEditable(BOB, s, "p1") === false);
check("and frozen for the host too", V.lineEditable(HOST, s, "p1") === false);
check("an unsubmitted line stays editable", V.lineEditable(HOST, s, "p0") === true);
check("solo has no submitting, so lines never freeze",
  V.isSubmitted(SOLO, s, "p1") === false && V.lineEditable(SOLO, s, "p1") === true);

console.log("\nThe submit control -- the one that went missing\n");
check("the host sees it on a line they are entering for someone else",
  V.showSubmit(HOST, s, "p2") === true);
check("a phone sees it on its own line", V.showSubmit(BOB, table(), "p1") === true);
check("it goes once the line is in", V.showSubmit(BOB, s, "p1") === false);
check("a phone never sees it on someone else's line", V.showSubmit(BOB, s, "p0") === false);
check("solo has nothing to submit to", V.showSubmit(SOLO, table(), "p0") === false);

console.log("\nTaking a submission back\n");
check("the player who submitted can", V.showWithdraw(BOB, s, "p1") === true);
check("the host can", V.showWithdraw(HOST, s, "p1") === true);
check("a bystander cannot", V.showWithdraw(WATCHER, s, "p1") === false);
check("there is nothing to take back on an open line", V.showWithdraw(HOST, s, "p0") === false);

console.log("\nWhat the reducer is told about you\n");
/* actor() is the hand-off between this module and the rules core: every dispatch
   goes through applyAction(state, action, actor()). Assert the shape, then feed
   it to the reducer so the permission model is checked end to end rather than
   the two halves being tested in isolation and trusted to agree. */
const shape = a => JSON.stringify([a.isHost, a.seat]);
check("solo, you act as host with no particular seat", shape(V.actor(SOLO)) === '[true,null]', shape(V.actor(SOLO)));
check("the host acts as host, in their own seat", shape(V.actor(HOST)) === '[true,"p0"]', shape(V.actor(HOST)));
check("a phone acts as a guest in its own seat", shape(V.actor(BOB)) === '[false,"p1"]', shape(V.actor(BOB)));
check("a spectator acts as a guest with no seat", shape(V.actor(WATCHER)) === '[false,null]', shape(V.actor(WATCHER)));

check("and the reducer lets that actor edit their own line",
  G.applyAction(table(), {t:"setEntry", pid:"p1", entry:entry({nums:[5]})}, V.actor(BOB)).ok === true);
check("but refuses them somebody else's",
  G.applyAction(table(), {t:"setEntry", pid:"p0", entry:entry({nums:[5]})}, V.actor(BOB)).ok === false);
check("refuses them the round", G.applyAction(table(), {t:"commitRound"}, V.actor(BOB)).ok === false);
check("and refuses a spectator any line at all",
  G.applyAction(table(), {t:"setEntry", pid:"p0", entry:entry({nums:[5]})}, V.actor(WATCHER)).ok === false);
check("while the host may commit", G.applyAction(
  withEntry(table(), "p0", entry({nums:[5]})), {t:"commitRound"}, V.actor(HOST)).ok === true);

console.log("\nWho the round is waiting on\n");
check("the host waits on the other seated phone",
  V.awaitedSeats(HOST).join(",") === "p1", V.awaitedSeats(HOST).join(","));
check("a phone never waits on itself", V.awaitedSeats(BOB).indexOf("p1") < 0);
check("a phone that has dropped off is not waited on",
  V.awaitedSeats({...HOST, present:["c-alice"]}).length === 0);
check("players with no phone are never waited on",
  V.awaitedSeats(HOST).indexOf("p2") < 0 && V.awaitedSeats(HOST).indexOf("p3") < 0);
check("solo waits on nobody", V.awaitedSeats(SOLO).length === 0);

console.log("\nThe bar across the bottom\n");
let bar = V.commitBar(HOST, table());
check("the host's button scores the round", bar.control === "score");
check("it is round 1", bar.roundNo === 1);
check("with a phone out there, the bar counts them", bar.expecting === true);
check("and knows they are not in yet",
  bar.allIn === false && names(bar.waiting) === "Bob", names(bar.waiting));

bar = V.commitBar(HOST, s);
check("once they submit, the table is all in", bar.allIn === true && bar.waiting.length === 0);
check("and scoring asks nothing", bar.prompt === null);

check("a phone that is not host only watches", V.commitBar(BOB, s).control === "watch");
check("and is told it is already in", V.commitBar(BOB, s).watching === "submitted");
check("a phone yet to submit is told to", V.commitBar(BOB, table()).watching === "entering");
check("a spectator is told to take a seat", V.commitBar(WATCHER, s).watching === "spectator");

console.log("\nThe two things worth asking about before scoring\n");
check("scoring while someone is still out asks first",
  V.commitBar(HOST, table()).prompt === "early");
check("an untouched round asks whether everyone really scored zero",
  V.commitBar({...HOST, seats:{"c-alice":"p0"}, present:["c-alice"]}, table()).prompt === "zero");

/* The round that would not score: everyone submitted, nobody had a card. That is
   a whole table busting, and it has to go through without a word. */
let allZero = table();
["p0","p1","p2","p3"].forEach(pid => { allZero = submit(allZero, pid); });
check("but a round everyone deliberately submitted blank just scores",
  V.commitBar(HOST, allZero).prompt === null, V.commitBar(HOST, allZero).prompt);
check("waiting on someone outranks the zero question",
  V.commitBar(HOST, table()).prompt === "early");
check("an empty game cannot be scored", V.commitBar(HOST, G.newGame()).disabled === true);

/* A scorecard can come back from a room this device has since left, carrying a
   submitted map into a solo game. Off-network there is no submitting, so that
   stale map must not stand in for a deliberate all-zero round. */
let leftovers = table();
["p0","p1"].forEach(pid => { leftovers = submit(leftovers, pid); });
check("a submitted map left over from a room does not suppress the zero question",
  V.commitBar(SOLO, leftovers).prompt === "zero", V.commitBar(SOLO, leftovers).prompt);
check("and networked, the same map still does",
  V.commitBar({...HOST, seats:{"c-alice":"p0"}, present:["c-alice"]}, leftovers).prompt === null);

console.log("\nThe bar's two halves come from one place\n");
const counts = V.commitBar(HOST, table());
check("it reports who it is waiting on and who it expects",
  Array.isArray(counts.awaited) && counts.awaited.join(",") === "p1", JSON.stringify(counts.awaited));
check("so 'N of M in' can never disagree with itself",
  counts.awaited.length >= counts.waiting.length);
check("a partial state with no submitted map still counts everyone as out",
  V.commitBar(HOST, {players:[{id:"p0",name:"A"},{id:"p1",name:"B"}], current:{}, rounds:[]})
    .waiting.map(p => p.name).join(",") === "B");

console.log("\nPass-the-phone\n");
const PASS = {...SOLO, mode:"pass", seat:0};
check("mid-table, the button hands the phone on", V.commitBar(PASS, table()).control === "advance");
check("there is nobody to go back to at the first seat",
  V.commitBar(PASS, table()).canGoBack === false);
check("from the second seat there is",
  V.commitBar({...PASS, seat:1}, table()).canGoBack === true);
check("the last player scores the round",
  V.commitBar({...PASS, seat:3}, table()).control === "score");
check("pass mode is ignored in a networked game",
  V.commitBar({...HOST, mode:"pass"}, table()).control === "score");

console.log("\nA seat index that outlived its player\n");
check("past the end, it lands on the last player", V.clampSeat(9, 4) === 3);
check("below zero, it lands on the first", V.clampSeat(-2, 4) === 0);
check("an empty table has no seat to land on", V.clampSeat(3, 0) === 0);
check("nonsense reads as the first seat",
  V.clampSeat(undefined, 4) === 0 && V.clampSeat("x", 4) === 0);
check("the commit bar clamps it too", V.commitBar({...PASS, seat:99}, table()).seat === 3);

console.log("\nWhich boards are open\n");
const ui = {collapsed:{}, expanded:null};
check("solo, every board starts open", V.boardOpen(SOLO, ui, "p2") === true);
check("solo, collapsing one closes it",
  V.boardOpen(SOLO, {collapsed:{p2:true}}, "p2") === false);
check("networked, your own board is open", V.boardOpen(BOB, ui, "p1") === true);
check("and everyone else's is folded away", V.boardOpen(BOB, ui, "p0") === false);
check("until you expand one", V.boardOpen(BOB, {collapsed:{}, expanded:"p0"}, "p0") === true);
check("only one other board at a time",
  V.boardOpen(BOB, {collapsed:{}, expanded:"p0"}, "p2") === false);

console.log("\nWhose line comes first\n");
check("your own line is sorted to the top",
  names(V.orderedPlayers(BOB, table())) === "Bob,Alice,Carol,Dave",
  names(V.orderedPlayers(BOB, table())));
check("solo keeps the seating order",
  names(V.orderedPlayers(SOLO, table())) === "Alice,Bob,Carol,Dave");
check("a spectator keeps it too",
  names(V.orderedPlayers(WATCHER, table())) === "Alice,Bob,Carol,Dave");

/* The bug these cover: you start a room, nobody joins, you tap "Leave room" --
 * and the code is gone from the phone while the room itself sits on the relay
 * for another week. Leaving must demote a room, not erase it. */
console.log("\nRooms this device can get back into\n");

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const NOW = 1750000000000;
const on = (host, extra) => ({now:NOW, relayHost:host, ...extra});
const room = (code, ago, extra) => ({code, at:NOW - ago, relay:"relay.example", ...extra});
const codes = list => list.map(r => r.code).join(",");

check("a room from six days ago is still offered",
  codes(V.recentRooms([room("ABCD", 6 * DAY)], on("relay.example"))) === "ABCD");
check("a room from eight days is past what the relay keeps",
  V.recentRooms([room("ABCD", 8 * DAY)], on("relay.example")).length === 0);
check("the boundary is the relay's own week",
  V.ROOM_MEMORY_MS === 7 * DAY);
check("newest first, whatever order they were stored in",
  codes(V.recentRooms([room("AAAA", 3 * DAY), room("BBBB", 1 * HOUR), room("CCCC", 2 * DAY)],
    on("relay.example"))) === "BBBB,CCCC,AAAA");
check("at most five are offered",
  V.recentRooms([1,2,3,4,5,6,7].map(n => room("R" + n, n * HOUR)), on("relay.example")).length === 5);

check("a code from another relay is not offered here",
  V.recentRooms([{code:"ABCD", at:NOW - HOUR, relay:"other.example"}], on("relay.example")).length === 0);
check("but it is not thrown away either",
  codes(V.normalizeRooms([{code:"ABCD", at:NOW - HOUR, relay:"other.example"}], on("relay.example"))) === "ABCD");
check("the same code on two relays is two rooms",
  V.normalizeRooms([{code:"ABCD", at:NOW, relay:"a.example"},
                    {code:"ABCD", at:NOW, relay:"b.example"}], on("a.example")).length === 2);
check("the same code on one relay is one room",
  V.normalizeRooms([room("ABCD", HOUR), room("ABCD", 2 * HOUR)], on("relay.example")).length === 1);

console.log("\nLeaving a room, and coming back to it\n");
check("the newest fresh room is worth asking the relay about",
  (V.resumeCandidate([room("ABCD", HOUR)], on("relay.example")) || {}).code === "ABCD");
check("a room walked out of is not offered unasked",
  V.resumeCandidate([room("ABCD", HOUR, {left:true})], on("relay.example")) === null);
check("but it is still on the list, a tap away",
  codes(V.recentRooms([room("ABCD", HOUR, {left:true})], on("relay.example"))) === "ABCD");
check("an old room costs a tap, not a request",
  V.resumeCandidate([room("ABCD", 3 * DAY)], on("relay.example")) === null &&
  V.recentRooms([room("ABCD", 3 * DAY)], on("relay.example")).length === 1);
check("nothing remembered, nothing asked",
  V.resumeCandidate([], on("relay.example")) === null &&
  V.resumeCandidate(null, on("relay.example")) === null);

console.log("\nCarrying the old single-room format forward\n");
const migrated = V.normalizeRooms(["ABCD", "EFGH"], on("relay.example"));
check("bare codes survive the upgrade",
  codes(migrated) === "ABCD,EFGH", codes(migrated));
check("they inherit this relay",
  migrated.every(r => r.relay === "relay.example"));
check("and admit they don't know when",
  migrated.every(r => r.approx === true));
check("an undated entry is still offered rather than pruned",
  V.recentRooms(["ABCD"], on("relay.example")).length === 1);
check("junk in the stored list is dropped, not crashed on",
  codes(V.normalizeRooms([null, "", 7, {}, {code:""}, "ABCD"], on("relay.example"))) === "ABCD");

console.log("\nHow long ago that was\n");
check("under a minute", V.roomAgeLabel(30 * 1000) === "just now");
check("minutes", V.roomAgeLabel(5 * 60 * 1000) === "5 minutes ago");
check("one minute is singular", V.roomAgeLabel(60 * 1000) === "1 minute ago");
check("hours", V.roomAgeLabel(3 * HOUR) === "3 hours ago");
check("one hour is singular", V.roomAgeLabel(HOUR) === "1 hour ago");
check("days", V.roomAgeLabel(6 * DAY) === "6 days ago");
check("one day is singular", V.roomAgeLabel(DAY) === "1 day ago");
check("a migrated entry says only what it knows",
  V.roomAgeLabel(0, true) === "recently");
/* A phone whose clock is ahead of the relay's shouldn't render "-3 minutes ago". */
check("a clock running fast reads as now", V.roomAgeLabel(-90 * 1000) === "just now");

console.log("\nNothing here mutates what it is given\n");
const frozen = table();
const before = JSON.stringify(frozen);
V.commitBar(HOST, frozen); V.orderedPlayers(BOB, frozen); V.awaitedSeats(HOST);
check("the state is untouched", JSON.stringify(frozen) === before);

/* app.js edits the entries these hand back -- markRoomLeft flips `left` on one
   -- so they must be copies, or the stored list would change under a read. */
const stored = [room("ABCD", HOUR)];
const storedBefore = JSON.stringify(stored);
V.recentRooms(stored, on("relay.example"))[0].left = true;
V.normalizeRooms(stored, on("relay.example"))[0].at = 0;
check("the remembered rooms are untouched", JSON.stringify(stored) === storedBefore);

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
