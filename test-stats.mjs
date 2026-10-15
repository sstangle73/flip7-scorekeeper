/* Unit tests for src/stats.js -- the table record's arithmetic.
 *
 * Each block starts from something a player would see on the record screen,
 * not from how the code happens to work: "the game from last week says it took
 * a week", not "endedAt is preserved".
 *
 * Run with `node test-stats.mjs`.
 */
import { readFileSync } from "node:fs";

const load = (file, name) =>
  new Function(readFileSync(file, "utf8") + "; return " + name + ";")();
const G = load("src/game.js", "Flip7Rules")();
const S = load("src/stats.js", "Flip7Stats")(G);

let pass = 0, fail = 0;
function check(label, cond, detail){
  if(cond){ pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  -> " + detail : "")); }
}

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 10, 19, 0);                  // a game night, 7pm
/* The id app.js mints: "g" + Date.now() in base 36 + a random tail. */
const idAt = (t, tail = "ab12") => "g" + t.toString(36) + tail;

/* A played game: each round is [score for p0, score for p1, ...], played as a
   single number card where possible so the totals are easy to read. A score
   of -1 is a bust. */
function played(names, rounds, {target = 200, startedAt = T0} = {}){
  let s = G.newGame();
  s = G.applyAction(s, {t:"startGame", names, gameId:idAt(startedAt)}, {isHost:true}).state;
  s.target = target;
  rounds.forEach(row => {
    const r = {};
    row.forEach((v, i) => {
      r["p" + i] = v < 0 ? {nums:[3, 3], mods:[], x2:false, bust:true}
                         : {nums:[], mods:[v], x2:false, bust:false};
    });
    s.rounds.push(r);
  });
  return s;
}
/* A modifier on its own scores its face value, which is all these need. */
check("test helper: a lone +10 scores 10", G.scoreOf({nums:[], mods:[10], x2:false, bust:false}) === 10);

/* A record built the way app.js would after a game: filed when the last round
   is scored. */
function filed(game, endedAt, prev = null){ return S.record(game, prev, endedAt); }

console.log("\nWhen a game started\n");
{
  check("read straight off the game id", S.startOf({id:idAt(T0)}) === T0);
  check("whatever the random tail turned out to be", S.startOf({id:idAt(T0, "x")}) === T0);
  /* app.js's own minting expression, so a change to it breaks this test. */
  const now = Date.now();
  const minted = "g" + now.toString(36) + Math.random().toString(36).slice(2, 6);
  check("matches how app.js actually mints ids", S.startOf({id:minted}) === now);
  check("an id that isn't one of ours has no start", S.startOf({id:"room-7"}) === null);
  check("nor does a missing one", S.startOf({}) === null);
}

console.log("\n\"Average length of game\"\n");
{
  const a = filed(played(["Ann","Bo"], [[50,10],[50,10],[50,10],[60,10]], {startedAt:T0}), T0 + 30 * MIN);
  const b = filed(played(["Ann","Bo"], [[10,50],[10,50],[10,50],[10,60]], {startedAt:T0 + 60 * MIN}),
                  T0 + 110 * MIN);
  const sum = S.summary([b, a]);
  check("two games of 30 and 50 minutes average 40", sum.length && sum.length.avg === 40 * MIN,
        sum.length && sum.length.avg / MIN);
  check("shortest and longest are the two games", sum.length.min === 30 * MIN && sum.length.max === 50 * MIN);
  check("it says when timing began", sum.timedSince === T0 + 30 * MIN);
  check("40 minutes reads as \"40 min\"", S.duration(40 * MIN) === "40 min");
  check("65 minutes reads as \"1 h 05 min\"", S.duration(65 * MIN) === "1 h 05 min");
}

/* Re-filing happens on every render once a game is won, and again when the
   next game starts. */
console.log("\nOpening the app again doesn't make a finished game longer\n");
{
  const g = played(["Ann","Bo"], [[100,0],[110,0]]);
  const first = filed(g, T0 + 20 * MIN);
  const later = filed(g, T0 + 3 * 24 * 60 * MIN, first);           // three days on
  check("the end time stays at the winning round", later.endedAt === T0 + 20 * MIN, later.endedAt);
  check("so the length is still 20 minutes", S.lengthOf(later) === 20 * MIN);
}

console.log("\nA game from before timing existed isn't given a made-up length\n");
{
  /* What was on disk before this change: no endedAt, no toTarget. */
  const g = played(["Ann","Bo"], [[100,0],[110,0]]);
  const old = filed(g, T0 + 20 * MIN);
  delete old.endedAt; delete old.toTarget;
  const refiled = filed(g, T0 + 7 * 24 * 60 * MIN, old);            // opened a week later
  check("re-filing it doesn't stamp today as its end", !("endedAt" in refiled), refiled.endedAt);
  check("so it has no length", S.lengthOf(refiled) === null);
  const sum = S.summary([old]);
  check("and the summary has no length to report", sum.length === null);
  check("but it still counts as a finished game", sum.completed === 1);
}

console.log("\nA game left open overnight isn't a twelve-hour game\n");
{
  const g = filed(played(["Ann","Bo"], [[100,0],[110,0]]), T0 + 14 * 60 * MIN);
  check("it is left out of the length", S.lengthOf(g) === null);
}

console.log("\n\"Number of rounds to win with 200 points\"\n");
{
  /* Ann crosses 200 in round 3. */
  const g = played(["Ann","Bo"], [[70,10],[70,10],[70,10]]);
  const rec = filed(g, T0 + 20 * MIN);
  check("counted at the round someone crossed", rec.toTarget === 3, rec.toTarget);

  /* The table hit "Keep playing" and played two more. */
  const kept = played(["Ann","Bo"], [[70,10],[70,10],[70,10],[10,10],[10,10]]);
  const krec = filed(kept, T0 + 30 * MIN);
  check("playing on after the win doesn't stretch it", krec.toTarget === 3, krec.toTarget);
  check("though the game itself was five rounds", krec.rounds === 5);

  const quick = filed(played(["Ann","Bo"], [[110,0],[110,0]]), T0);
  const slow = filed(played(["Ann","Bo"], [[25,0],[25,0],[25,0],[25,0],[25,0],[25,0],[25,0],[25,0]]), T0);
  const sum = S.summary([rec, quick, slow]);
  const at200 = sum.toTarget.filter(t => t.target === 200)[0];
  check("averaged across games", at200 && at200.avg === (3 + 2 + 8) / 3, at200 && at200.avg);
  check("with the fastest and slowest", at200.min === 2 && at200.max === 8);

  /* Put away after two rounds: nobody reached 200. */
  const quit = filed(played(["Ann","Bo"], [[40,30],[20,30]]), T0 + 10 * MIN);
  check("a game put away part-way has no rounds-to-200", S.toTargetOf(quit) === null);
  check("and isn't averaged in", S.summary([quit, quick]).toTarget[0].n === 1);
}

console.log("\nGames played to 150 and to 200 aren't averaged together\n");
{
  const to150 = filed(played(["Ann","Bo"], [[80,0],[80,0]], {target:150}), T0);
  const to200 = filed(played(["Ann","Bo"], [[70,0],[70,0],[70,0]]), T0);
  const t = S.summary([to150, to200]).toTarget;
  check("one line per target", t.length === 2 && t.some(x => x.target === 150 && x.avg === 2)
        && t.some(x => x.target === 200 && x.avg === 3), JSON.stringify(t));
}

console.log("\nOld records still give rounds-to-200 when they can\n");
{
  const rec = filed(played(["Ann","Bo"], [[70,10],[70,10],[70,10]]), T0);
  delete rec.toTarget; delete rec.endedAt;
  check("a game that ended over the line counts its rounds", S.toTargetOf(rec) === 3);
}

console.log("\nWin rate and streaks\n");
{
  /* Oldest first: Ann, Ann, Bo, Ann, Ann, Ann, then a draw. */
  const results = [[110,0],[110,0],[0,110],[110,0],[110,0],[110,0],[100,100]];
  const recs = results.map((r, i) =>
    filed(played(["Ann","Bo"], [r, r], {startedAt:T0 + i * 60 * MIN}), T0 + i * 60 * MIN + 20 * MIN));
  /* Stored newest first, and shuffled the way a re-file reorders them. */
  const stored = recs.slice().reverse();
  [stored[2], stored[4]] = [stored[4], stored[2]];
  const by = Object.fromEntries(S.players(stored).map(p => [p.name, p]));
  check("Ann won five of seven", by.Ann.wins === 5 && by.Ann.games === 7);
  check("that's a 71% win rate", Math.round(by.Ann.winRate * 100) === 71);
  check("her longest run was three, in start order not storage order", by.Ann.longest === 3, by.Ann.longest);
  check("and the draw ended it", by.Ann.streak === 0, by.Ann.streak);
  check("the draw is a tie for both, not a win", by.Ann.ties === 1 && by.Bo.ties === 1 && by.Bo.wins === 1);
}

console.log("\nPoints per round, busts and the best round\n");
{
  /* Ann: 10, bust, 30. Bo: 20, 20, 20. */
  const rec = filed(played(["Ann","Bo"], [[10,20],[-1,20],[30,20]]), T0);
  const by = Object.fromEntries(S.players([rec]).map(p => [p.name, p]));
  check("Ann averages 40/3 a round", Math.abs(by.Ann.perRound - 40 / 3) < 1e-9);
  check("one bust in three rounds", Math.abs(by.Ann.bustRate - 1 / 3) < 1e-9);
  const sum = S.summary([rec]);
  check("the table averages 100 over 6 lines", Math.abs(sum.perRound - 100 / 6) < 1e-9);
  check("best single round is Ann's 30", sum.bestRound.score === 30 && sum.bestRound.names.join() === "Ann");
}

console.log("\nA Flip 7 is counted\n");
{
  let s = played(["Ann"], [[10]]);
  s.rounds.push({p0:{nums:[0,1,2,3,4,5,6], mods:[], x2:false, bust:false}});
  check("one Flip 7", S.record(s, null, T0).players[0].flip7s === 1);
}

console.log("\nWhatever is on disk, the screen still opens\n");
{
  const junk = [null, {id:"g1"}, {players:"x", rounds:2}, {id:idAt(T0), players:[], rounds:1}];
  let ok = true;
  try { S.summary(junk); S.players(junk); } catch(e){ ok = false; }
  check("malformed records are skipped, not thrown on", ok);
  check("and don't count as games", S.summary(junk).games === 0);
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
