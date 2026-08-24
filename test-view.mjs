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

console.log("\nNothing here mutates what it is given\n");
const frozen = table();
const before = JSON.stringify(frozen);
V.commitBar(HOST, frozen); V.orderedPlayers(BOB, frozen); V.awaitedSeats(HOST);
check("the state is untouched", JSON.stringify(frozen) === before);

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
