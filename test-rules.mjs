/* Unit tests for the shared rules core: the rulebook's worked examples, the
 * states the rules make impossible, and the reducer's permission model.
 * Run with `node test-rules.mjs`.
 */
import Flip7Rules from "./server/src/rules.js";
const G = Flip7Rules();

let pass = 0, fail = 0;
function check(label, cond, detail){
  if(cond){ pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  -> " + detail : "")); }
}
function eq(label, got, want){ check(label + " = " + want, got === want, "got " + got); }
const entry = o => Object.assign({nums:[], mods:[], x2:false, bust:false}, o);

console.log("\nScoring — every worked example in the rulebook\n");
eq("3+11+5+7+10",                     G.scoreOf(entry({nums:[3,11,5,7,10]})), 36);
eq("...with x2",                      G.scoreOf(entry({nums:[3,11,5,7,10], x2:true})), 72);
eq("...with +10 instead",             G.scoreOf(entry({nums:[3,11,5,7,10], mods:[10]})), 46);
eq("Flip 7: 3+11+5+7+10+9+4 +15",     G.scoreOf(entry({nums:[3,11,5,7,10,9,4]})), 64);
eq("p5 example 11+5+12 with +4",      G.scoreOf(entry({nums:[11,5,12], mods:[4]})), 32);

console.log("\nScoring — order of operations\n");
eq("x2 doubles numbers only, before bonuses",
   G.scoreOf(entry({nums:[3,11,5,7,10], mods:[10], x2:true})), 82);
eq("the Flip 7 bonus is never doubled",
   G.scoreOf(entry({nums:[0,1,2,3,4,5,6], mods:[10], x2:true})), 67);
eq("bust scores nothing at all",
   G.scoreOf(entry({nums:[12,11,10], mods:[10], x2:true, bust:true})), 0);
eq("a lone +10 still scores",          G.scoreOf(entry({mods:[10]})), 10);
eq("a lone x2 scores nothing",         G.scoreOf(entry({x2:true})), 0);
eq("the 0 card adds nothing",          G.scoreOf(entry({nums:[0]})), 0);
eq("but 0 counts toward the seven",    G.scoreOf(entry({nums:[0,1,2,3,4,5,6]})), 36);

console.log("\nLine caps\n");
eq("a fresh line holds seven",         G.numCap(entry({})), 7);
eq("a busted line holds six",          G.numCap(entry({bust:true})), 6);

console.log("\nValidation of untrusted input\n");
const dirty = G.scrubEntry({nums:[3, 99, -1, 3, 7, "x", 4.5], mods:[4, 5, 4], x2:1, bust:0});
check("out-of-range, duplicate and non-integer cards are dropped",
  dirty.nums.join(",") === "3,7", dirty.nums.join(","));
check("invalid modifiers are dropped and duplicates collapsed",
  dirty.mods.join(",") === "4", dirty.mods.join(","));
check("flags are coerced to booleans", dirty.x2 === true && dirty.bust === false);
check("nonsense is rejected outright", G.normalize({hello:"world"}) === null);
check("a save missing `current` is repaired",
  !!G.normalize({players:[{id:"p0",name:"S"}], rounds:[], target:200}));

console.log("\nThe reducer's permission model\n");
let s = G.newGame();
s = G.applyAction(s, {t:"startGame", names:["Sam","Jo"]}, {isHost:true}).state;
check("host can start a game", s.started && s.players.length === 2);

const guest = {isHost:false, seat:"p1"};
check("a guest cannot start a game",
  G.applyAction(s, {t:"startGame", names:["X"]}, guest).ok === false);
check("a guest cannot commit a round",
  G.applyAction(s, {t:"commitRound"}, guest).ok === false);
check("a guest cannot step into a scored round",
  G.applyAction(s, {t:"editRound", index:0}, guest).ok === false);
check("a guest cannot delete a round",
  G.applyAction(s, {t:"deleteRound", index:0}, guest).ok === false);
check("a guest cannot change the target",
  G.applyAction(s, {t:"setTarget", target:50}, guest).ok === false);
check("a guest cannot add a player",
  G.applyAction(s, {t:"addPlayer", name:"Mallory"}, guest).ok === false);
check("a guest cannot edit another seat",
  G.applyAction(s, {t:"setEntry", pid:"p0", entry:entry({nums:[5]})}, guest).ok === false);

const own = G.applyAction(s, {t:"setEntry", pid:"p1", entry:entry({nums:[5]})}, guest);
check("a guest CAN edit their own seat", own.ok === true, own.error);
check("the host can edit any seat",
  G.applyAction(s, {t:"setEntry", pid:"p1", entry:entry({nums:[5]})}, {isHost:true}).ok === true);

console.log("\nImpossible states the reducer refuses\n");
s = G.applyAction(s, {t:"setEntry", pid:"p0", entry:entry({nums:[0,1,2,3,4,5,6]})}, {isHost:true}).state;
const second = G.applyAction(s, {t:"setEntry", pid:"p1", entry:entry({nums:[2,3,4,5,6,7,8]})}, {isHost:true});
check("a second Flip 7 in one round is refused", second.ok === false, second.error);

const bustedSeven = G.applyAction(s, {t:"setEntry", pid:"p1",
  entry:entry({nums:[1,2,3,4,5,6,7], bust:true})}, {isHost:true});
check("a busted line is trimmed to six",
  bustedSeven.ok && bustedSeven.state.current.p1.nums.length === 6,
  JSON.stringify(bustedSeven.state && bustedSeven.state.current.p1));

check("committing an empty round is refused",
  G.applyAction(G.applyAction(G.newGame(), {t:"startGame", names:["A"]}, {isHost:true}).state,
    {t:"commitRound"}, {isHost:true}).ok === false);
check("editing a round that isn't there is refused",
  G.applyAction(s, {t:"editRound", index:0}, {isHost:true}).ok === false);
check("deleting a round that isn't there is refused",
  G.applyAction(s, {t:"deleteRound", index:3}, {isHost:true}).ok === false);
check("undoRound is gone, not silently accepted",
  G.applyAction(s, {t:"undoRound"}, {isHost:true}).ok === false);
check("a negative target is refused",
  G.applyAction(s, {t:"setTarget", target:-5}, {isHost:true}).ok === false);
check("an unknown action is refused",
  G.applyAction(s, {t:"drainTheBank"}, {isHost:true}).ok === false);

console.log("\nSubmitting, and the deadlock it used to cause\n");
let sub = G.newGame();
sub = G.applyAction(sub, {t:"startGame", names:["Sam","Jo"], gameId:"g1"}, {isHost:true}).state;
check("an untouched round is refused as a likely accident",
  G.applyAction(sub, {t:"commitRound"}, {isHost:true}).ok === false);
check("but a deliberate all-zero round scores", (function(){
  const z = G.applyAction(sub, {t:"commitRound", force:true}, {isHost:true});
  return z.ok && G.totalFor(z.state, "p0") === 0 && z.state.rounds.length === 1;
})());

sub = G.applyAction(sub, {t:"submitEntry", pid:"p0"}, {isHost:true}).state;
sub = G.applyAction(sub, {t:"submitEntry", pid:"p1"}, {isHost:true}).state;
const blankRound = G.applyAction(sub, {t:"commitRound"}, {isHost:true});
check("a round everyone submitted blank still scores", blankRound.ok === true, blankRound.error);
check("and records zeros rather than nothing",
  blankRound.ok && G.totalFor(blankRound.state, "p0") === 0 &&
  Object.keys(blankRound.state.rounds[0]).length === 2);

const fresh = G.applyAction(sub, {t:"withdrawEntry", pid:"p1"}, {isHost:true}).state;
check("a player on a phone who has not submitted is waited on",
  G.outstanding(fresh, ["p1"]).map(p => p.id).join(",") === "p1");
check("a player with no phone is never waited on", G.outstanding(fresh, []).length === 0);
check("passing null still considers everyone", G.outstanding(fresh, null).length === 1);

console.log("\nPlayer ids must stay attached to the same person\n");
let ids = G.newGame();
ids = G.applyAction(ids, {t:"startGame", names:["Alice","Bob","Carol","Dave"], gameId:"g"}, {isHost:true}).state;
const idsBefore = ids.players.map(p => p.id + "=" + p.name).join(" ");
ids = G.applyAction(ids, {t:"removePlayer", pid:"p1"}, {isHost:true}).state;
ids = G.applyAction(ids, {t:"beginGame", gameId:"g2"}, {isHost:true}).state;
check("beginGame leaves every surviving id on its original player",
  ids.players.map(p => p.id + "=" + p.name).join(" ") === "p0=Alice p2=Carol p3=Dave",
  ids.players.map(p => p.id + "=" + p.name).join(" "));
check("beginGame does start the game", ids.started === true);

const again = G.applyAction(ids, {t:"newGame", gameId:"g3"}, {isHost:true}).state;
check("newGame keeps the same ids too",
  again.players.map(p => p.id + "=" + p.name).join(" ") === "p0=Alice p2=Carol p3=Dave",
  again.players.map(p => p.id + "=" + p.name).join(" "));
check("newGame clears the scorecard", again.rounds.length === 0 && again.started === true);
check("beginGame is host-only",
  G.applyAction(ids, {t:"beginGame"}, {isHost:false, seat:"p0"}).ok === false);

console.log("\nThe reducer never mutates its input\n");
const before = JSON.stringify(s);
G.applyAction(s, {t:"commitRound"}, {isHost:true});
G.applyAction(s, {t:"addPlayer", name:"Zed"}, {isHost:true});
check("input state is untouched", JSON.stringify(s) === before);

console.log("\nDeck arithmetic\n");
eq("deck size", G.DECK_SIZE, 94);
eq("one 0 card", G.copiesOf(0), 1);
eq("twelve 12s", G.copiesOf(12), 12);

console.log("\nCross-table deck legality\n");
let d = G.newGame();
d = G.applyAction(d, {t:"startGame", names:["A","B","C"]}, {isHost:true}).state;
d.current = {p0:entry({nums:[0,3]}), p1:entry({nums:[0,3]}), p2:entry({nums:[3]})};
const conflicts = G.roundConflicts(d);
check("two players holding the single 0 is flagged",
  conflicts.some(c => /The 0 card/.test(c)), JSON.stringify(conflicts));
check("three players holding a 3 is fine (the deck has three)",
  !conflicts.some(c => /The 3 card/.test(c)), JSON.stringify(conflicts));

d.current = {p0:entry({x2:true}), p1:entry({x2:true}), p2:entry({})};
check("two players holding the single x2 is flagged",
  G.roundConflicts(d).some(c => /×2/.test(c)));

console.log("\nEditing a round that has already been scored\n");
/* The reported bug: round 5 held Eric's Flip 7, round 6 was scored wrong, and
   pressing undo walked back to round 5 while the screen was still being read as
   round 6 -- so the app said "Eric already has the Flip 7 this round" about a
   round the player was not in. Undo reached the round it reopened by destroying
   whatever came after it. Stepping into a round destroys nothing. */
const H = {isHost:true};
function played(lines){
  let g = G.applyAction(G.newGame(), {t:"startGame", names:["Eric","Sam","Jo"]}, H).state;
  lines.forEach(round => {
    Object.keys(round).forEach(pid => {
      g = G.applyAction(g, {t:"setEntry", pid, entry:entry({nums:round[pid]})}, H).state;
    });
    g = G.applyAction(g, {t:"commitRound"}, H).state;
  });
  return g;
}
/* Rounds 1-5, Eric taking the Flip 7 in round 5, then round 6 half entered. */
let e6 = played([{p0:[1,2]}, {p0:[1,2]}, {p0:[1,2]}, {p0:[1,2]}, {p0:[0,1,2,3,4,5,6], p1:[7]}]);
e6 = G.applyAction(e6, {t:"setEntry", pid:"p0", entry:entry({nums:[9]})}, H).state;

eq("five rounds are scored", e6.rounds.length, 5);
check("the live round is the open one by default", G.openRound(e6) === e6.current);

const into5 = G.applyAction(e6, {t:"editRound", index:4}, H);
check("the host can step into round 5", into5.ok === true, into5.error);
const ed = into5.state;
eq("stepping in scores nothing new", ed.rounds.length, 5);
check("and the round being entered is left exactly where it was",
  JSON.stringify(ed.current) === JSON.stringify(e6.current), JSON.stringify(ed.current));
check("the open round is now round 5",
  G.openRound(ed).p0.nums.length === 7, JSON.stringify(G.openRound(ed).p0));
check("so the Flip 7 is held, correctly, in the round on screen",
  (G.flip7Holder(ed, "p1") || {}).name === "Eric");
check("a second Flip 7 in the round being edited is still refused",
  G.applyAction(ed, {t:"setEntry", pid:"p1", entry:entry({nums:[1,2,3,4,5,6,7]})}, H).ok === false);

const fixed = G.applyAction(ed, {t:"setEntry", pid:"p0", entry:entry({nums:[3,4]})}, H);
check("correcting a line writes into the round being edited, not the live one",
  fixed.ok && fixed.state.rounds[4].p0.nums.join(",") === "3,4",
  JSON.stringify(fixed.state && fixed.state.rounds[4].p0));
check("the live round is untouched by the correction",
  fixed.state.current.p0.nums.join(",") === "9", JSON.stringify(fixed.state.current.p0));
/* Rounds 1-4 gave Eric 3 apiece; round 5 was 36 and is now 7. */
eq("and the total picks the correction up", G.totalFor(fixed.state, "p0"), 19);
check("once the Flip 7 is gone another player may take it",
  G.applyAction(fixed.state, {t:"setEntry", pid:"p1", entry:entry({nums:[1,2,3,4,5,6,7]})}, H).ok === true);

check("scoring is refused while a scored round is open",
  G.applyAction(ed, {t:"commitRound"}, H).ok === false);
const closed = G.applyAction(ed, {t:"closeEdit"}, H);
check("closing returns to the live round", closed.ok && closed.state.editing === null);
check("and the half-entered round is still there",
  closed.state.current.p0.nums.join(",") === "9");

console.log("\nDeleting a round\n");
const del = G.applyAction(e6, {t:"deleteRound", index:4}, H);
check("deleting takes the round off the scorecard", del.ok && del.state.rounds.length === 4, del.error);
check("without touching the round being entered",
  del.state.current.p0.nums.join(",") === "9");
const delMid = G.applyAction(G.applyAction(e6, {t:"editRound", index:4}, H).state,
  {t:"deleteRound", index:1}, H);
check("deleting a round below the one being edited shifts the pointer down",
  delMid.ok && delMid.state.editing === 3, String(delMid.state && delMid.state.editing));
const delSelf = G.applyAction(G.applyAction(e6, {t:"editRound", index:4}, H).state,
  {t:"deleteRound", index:4}, H);
check("deleting the round you are editing returns you to the live round",
  delSelf.ok && delSelf.state.editing === null);

console.log("\nThe editing pointer is never allowed to dangle\n");
check("an index past the end of rounds normalizes to the live round",
  G.normalize({players:[{id:"p0",name:"S"}], rounds:[], current:{}, editing:4}).editing === null);
check("a negative index does too",
  G.normalize({players:[{id:"p0",name:"S"}], rounds:[{}], current:{}, editing:-1}).editing === null);
check("a nonsense index does too",
  G.normalize({players:[{id:"p0",name:"S"}], rounds:[{}], current:{}, editing:"5"}).editing === null);
check("a valid index survives",
  G.normalize({players:[{id:"p0",name:"S"}], rounds:[{},{}], current:{}, editing:1}).editing === 1);
check("a guest cannot correct history even from their own seat",
  G.applyAction(G.applyAction(e6, {t:"editRound", index:4}, H).state,
    {t:"setEntry", pid:"p1", entry:entry({nums:[5]})}, {isHost:false, seat:"p1"}).ok === false);


console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
