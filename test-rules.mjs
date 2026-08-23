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
check("a guest cannot undo",
  G.applyAction(s, {t:"undoRound"}, guest).ok === false);
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
check("undoing with no rounds is refused",
  G.applyAction(s, {t:"undoRound"}, {isHost:true}).ok === false);
check("a negative target is refused",
  G.applyAction(s, {t:"setTarget", target:-5}, {isHost:true}).ok === false);
check("an unknown action is refused",
  G.applyAction(s, {t:"drainTheBank"}, {isHost:true}).ok === false);

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
