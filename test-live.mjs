/* Unit tests for src/live.js -- live card entry, the deck count, and the odds.
 *
 * Every expected probability below is worked out by hand in the comment beside
 * it from the deck list on page 2 of the rules (one 0, one 1, two 2s ... twelve
 * 12s; +2 +4 +6 +8 +10 x2 once each; three each of Freeze, Flip Three and
 * Second Chance -- 94 cards), never by running the code and copying its answer.
 *
 * Run with `node test-live.mjs`.
 */
import { readFileSync } from "node:fs";

const load = (file, name) =>
  new Function(readFileSync(file, "utf8") + "; return " + name + ";")();
const G = load("src/game.js", "Flip7Rules")();
const L = load("src/live.js", "Flip7Live")(G);

let pass = 0, fail = 0;
function check(label, cond, detail){
  if(cond){ pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  -> " + detail : "")); }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
const live = o => Object.assign(L.blankLive(), o);
const entry = (o, lv) => {
  const e = Object.assign(G.blankEntry(), o);
  if(lv !== undefined) e.live = live(lv);
  return e;
};
function game(n){
  const names = Array.from({length:n}, (_, i) => "P" + i);
  return G.applyAction(G.newGame(), {t:"startGame", names}, {isHost:true}).state;
}

console.log("\nThe deck\n");

check("the deck list adds up to 94, as the rules say",
  G.DECK_SIZE === 94 && L.KINDS.reduce((t, k) => t + k.copies, 0) === 94);
check("79 number cards, 6 modifiers, 9 action cards",
  L.KINDS.filter(k => k.key[0] === "n").reduce((t, k) => t + k.copies, 0) === 79 &&
  L.KINDS.filter(k => k.key[0] === "m" || k.key === "x2").length === 6 &&
  L.FULL.freeze + L.FULL.flip3 + L.FULL.sc === 9);

{
  const s = game(2);
  const d = L.deck(s);
  check("a fresh game has all 94 to come", d.left === 94 && d.seen === 0 && d.pile === 0 && !d.reshuffled);
}

{
  /* A busted 7 is two 7s on the table; a Second Chance spent on a 3 is a
     second 3 and the Second Chance itself. 94 - 2 - 3 = 89. */
  const s = game(2);
  s.current.p0 = entry({nums:[7], bust:true}, {bustOn:7});
  s.current.p1 = entry({nums:[3]}, {scUsed:[3]});
  const d = L.deck(s);
  check("the duplicate a player busted on counts as seen", d.unseen.n7 === 5, d.unseen.n7);
  check("a spent Second Chance and the duplicate it ate both count as seen",
    d.unseen.n3 === 1 && d.unseen.sc === 2, JSON.stringify([d.unseen.n3, d.unseen.sc]));
  check("so 89 cards are left", d.left === 89 && d.seen === 5, d.left);
}

{
  /* Round 1 put a 1 and a 2 in the discard. The rules set those aside rather
     than shuffle them back, so round 2 starts from 92. */
  let s = game(1);
  s = G.applyAction(s, {t:"setEntry", pid:"p0", entry:entry({nums:[1,2]}, {})}, {isHost:true}).state;
  s = G.applyAction(s, {t:"commitRound"}, {isHost:true}).state;
  const d = L.deck(s);
  check("last round's cards stay out of the deck until it runs out",
    d.left === 92 && d.pile === 2 && d.unseen.n1 === 0 && d.unseen.n2 === 1, JSON.stringify(d));
}

/* Sixty-three cards: every 6 through 12 in the deck, spread over twelve
   players so nobody holds a number twice. Player i holds v when i < copies(v). */
function bigRound(){
  const r = {};
  for(let i = 0; i < 12; i++){
    const nums = [];
    for(let v = 6; v <= 12; v++) if(i < v) nums.push(v);
    r["p" + i] = entry({nums}, {});
  }
  return r;
}
{
  const s = game(12);
  s.rounds.push(bigRound());
  let d = L.deck(s);
  check("after a 63-card round, 31 are left", d.left === 31 && d.pile === 63, d.left);

  /* Round 2 needs 63 with only 31 to draw from, so the deck ran out during it
     and the discard (round 1) was shuffled in. What is set aside afterwards is
     round 2 alone: 94 - 63 = 31 again, not 94 - 126. */
  s.rounds.push(bigRound());
  d = L.deck(s);
  check("a round that drew more than was left reshuffled the discard back in",
    d.left === 31 && d.pile === 63 && d.unseen.n5 === 5, JSON.stringify([d.left, d.pile, d.unseen.n5]));

  s.current = bigRound();
  d = L.deck(s);
  check("a reshuffle mid-round leaves only the cards in front of players out",
    d.reshuffled && d.left === 31 && d.unseen.n12 === 0 && d.unseen.n0 === 1, JSON.stringify(d));
}

{
  const s = game(2);
  s.rounds.push({p0: entry({nums:[4], bust:true}), p1: entry({nums:[5]}, {})});
  check("a bust entered without its duplicate makes the count approximate", L.deck(s).approx);
  s.rounds[0].p0 = entry({nums:[4], bust:true}, {bustOn:4});
  check("entered card by card, it is exact", !L.deck(s).approx);
  s.current.p0 = entry({nums:[2]}, {scUsed:[2]});
  s.current.p1 = entry({nums:[2]}, {});
  check("three 2s on the table, with only two in the deck, is flagged",
    L.deck(s).over.indexOf("n2") >= 0, JSON.stringify(L.deck(s).over));
}

console.log("\nThe next card, kind by kind\n");

{
  /* Off a fresh deck each kind is its copies over 94. */
  const n = L.nextCard(L.deck(game(1)).unseen);
  check("a 12 off a fresh deck is 12/94, the 0 is 1/94", near(n.p.n12, 12/94) && near(n.p.n0, 1/94));
  check("the x2 is 1/94 and a Freeze 3/94", near(n.p.x2, 1/94) && near(n.p.freeze, 3/94));
  check("by type: 79 numbers, 6 modifiers, 9 actions out of 94",
    n.groups.numbers.count === 79 && n.groups.modifiers.count === 6 && n.groups.actions.count === 9 &&
    near(n.groups.actions.p, 9/94));
  check("the chances add up to one", near(Object.values(n.p).reduce((a, b) => a + b, 0), 1));

  /* A 12 and the Freeze on the table: 11 twelves and 2 Freezes in 92. */
  const s = game(1);
  s.current.p0 = entry({nums:[12]}, {freeze:1});
  const m = L.nextCard(L.deck(s).unseen);
  check("they move with the cards out: a 12 is now 11/92, a Freeze 2/92",
    m.left === 92 && near(m.p.n12, 11/92) && near(m.p.freeze, 2/92));
  check("a kind with none left is 0, not missing", near(L.nextCard({n1:0, n2:1}).p.n1, 0));
}

console.log("\nOdds\n");

{
  /* Holding a 12 off a fresh deck: 11 more 12s in the 93 left. */
  const s = game(1);
  s.current.p0 = entry({nums:[12]}, {});
  const o = L.playerOdds(s.current.p0, L.deck(s).unseen);
  check("holding a 12 off a fresh deck, bust risk is 11/93", near(o.bust, 11/93), o.bust);
  check("and the next card is safe 82/93 of the time", near(o.safe, 82/93), o.safe);
}

{
  /* Holding 0 1 2 3 4 5: duplicates left are 0+0+1+2+3+4 = 10 in 88.
     Unseen numbers 6..12 are 6+7+...+12 = 63, so the next NUMBER card is new
     63 times in 73 -- and since a seventh new number is the Flip 7, that is
     the whole chance of reaching it. */
  const s = game(1);
  s.current.p0 = entry({nums:[0,1,2,3,4,5]}, {});
  const o = L.playerOdds(s.current.p0, L.deck(s).unseen);
  check("holding 0-5, bust risk is 10/88", near(o.bust, 10/88), o.bust);
  check("the next card is a new number 63/88 of the time", near(o.fresh, 63/88), o.fresh);
  check("one number from seven, Flip 7 chance is 63/73", near(o.flip7, 63/73), o.flip7);
  check("nobody flipping three has no survival figure", o.survive === null);
}

{
  /* The same hand with an unused Second Chance: the Second Chance is on the
     table too, so 87 left, and a duplicate (10 of them) now costs the Second
     Chance instead of the round. Flip 7: 63/73 straight away, or a duplicate
     (10/73) is absorbed, leaving 9 duplicates and 63 new among 72: 63/72. */
  const s = game(1);
  s.current.p0 = entry({nums:[0,1,2,3,4,5]}, {sc:1});
  const o = L.playerOdds(s.current.p0, L.deck(s).unseen);
  check("an unused Second Chance means no bust risk", o.bust === 0 && o.protectedBy && o.safe === 1);
  check("but it still reports the chance of spending it, 10/87", near(o.hit, 10/87), o.hit);
  check("and Flip 7 becomes 63/73 + 10/73 x 63/72", near(o.flip7, 63/73 + (10/73) * (63/72)), o.flip7);
}

{
  /* Surviving two forced flips holding only a 12, off a fresh deck (93 left:
     11 twelves, 67 other numbers, 15 non-number cards).
       first card non-number (15/93): then bust only on a 12, 11/92 -> survive 81/92
       first card a new number v with U[v] copies (U[v]/93): then bust on a 12
       or another v, 11 + U[v]-1 of 92 -> survive (82 - U[v])/92
       first card a 12: bust
     Sum over v = 0..11, U = 1,1,2,...,11: sum U = 67, sum U^2 = 507, so
     sum U(82-U) = 82*67 - 507 = 4987. Total (15*81 + 4987) / (93*92) = 6202/8556. */
  const s = game(1);
  s.current.p0 = entry({nums:[12]}, {});
  const p = L.reach7([12], false, L.deck(s).unseen, 2);
  check("holding a 12, surviving the next two flips is 6202/8556", near(p, 6202/8556), p);
  check("surviving one flip is just the safe chance", near(L.reach7([12], false, L.deck(s).unseen, 1), 82/93));
}

{
  const s = game(1);
  s.current.p0 = entry({nums:[12]}, {flip3:1, f3left:3});
  const o = L.playerOdds(s.current.p0, L.deck(s).unseen);
  check("a player flipping three gets a survival figure for the flips left",
    o.flipsLeft === 3 && o.survive > 0 && o.survive < 1 - 11/92, o.survive);
  s.current.p0 = entry({nums:[12], bust:true}, {bustOn:12});
  check("a busted player is out, with no flips left",
    L.playerOdds(s.current.p0, L.deck(s).unseen).status === "bust" &&
    L.playerOdds(s.current.p0, L.deck(s).unseen).flipsLeft === 0);
  s.current.p0 = entry({nums:[12]}, {freeze:1});
  check("a frozen player is reported as frozen", L.playerOdds(s.current.p0, L.deck(s).unseen).status === "frozen");
}

console.log("\nTapping cards in\n");

{
  let e = G.blankEntry();
  e = L.tapNumber(e, 7, 7);
  check("a number goes from none to held", L.numState(e, 7) === "held" && !e.bust);
  e = L.tapNumber(e, 7, 7);
  check("then to busted, which busts the line", L.numState(e, 7) === "bust" && e.bust && e.live.bustOn === 7);
  e = L.tapNumber(e, 7, 7);
  check("then back to none, unbusting it", L.numState(e, 7) === "none" && !e.bust && e.nums.length === 0);

  e = L.tapNumber(L.tapNumber(L.tapNumber(G.blankEntry(), 3, 7), 5, 7), 3, 7);
  e = L.tapNumber(e, 5, 7);
  check("only one number can be the bust: busting another moves it",
    e.live.bustOn === 5 && L.numState(e, 3) === "held", JSON.stringify(e));
}

{
  let e = L.tapNumber(G.blankEntry(), 7, 7);
  e = L.tapSecondChance(e);
  check("a Second Chance in hand is ready", e.live.sc === 1);
  e = L.tapNumber(e, 7, 7);
  check("a duplicate with a Second Chance ready spends it instead of busting",
    !e.bust && e.live.sc === 0 && e.live.scUsed[0] === 7 && L.numState(e, 7) === "saved");
  const d = L.deck({players:[{id:"p0", name:"A"}], rounds:[], current:{p0:e}});
  check("both the duplicate and the Second Chance leave the deck", d.unseen.n7 === 5 && d.unseen.sc === 2);
  const back = L.unspend(e, 7);
  check("undoing the spend hands the Second Chance back", back.live.sc === 1 && back.live.scUsed.length === 0);
  e = L.tapNumber(e, 7, 7);
  check("another 7 after that busts them", e.bust && e.live.bustOn === 7 && e.live.scUsed[0] === 7);
  e = L.tapNumber(e, 7, 7);
  check("clearing the number gives back the Second Chance it ate", e.live.sc === 1 && e.live.scUsed.length === 0 && !e.bust);
}

{
  let e = L.tapNumber(G.blankEntry(), 4, 7);
  e = L.addFlip3(e);
  check("receiving Flip Three owes three flips", e.live.flip3 === 1 && e.live.f3left === 3);
  e = L.tapNumber(e, 9, 7);
  e = L.tapMod(e, 6);
  check("every card dealt -- number or modifier -- uses one up", e.live.f3left === 1, e.live.f3left);
  e = L.tapNumber(e, 9, 7);
  check("a bust ends the flips", e.bust && e.live.f3left === 0);
}

{
  let e = G.blankEntry();
  [0,1,2,3,4,5].forEach(n => { e = L.tapNumber(e, n, 6); });
  check("a line capped at six refuses a seventh", L.tapNumber(e, 9, 6).nums.length === 6);
  [6].forEach(n => { e = L.tapNumber(e, n, 7); });
  check("a seven-card line can't bust", !L.tapNumber(e, 3, 7).bust);
}

console.log("\nThe rules core keeps live cards\n");

{
  let s = game(2);
  const lv = {bustOn:7, sc:1, scUsed:[3, 9], freeze:1, flip3:2, f3left:4};
  s = G.applyAction(s, {t:"setEntry", pid:"p0", entry:entry({nums:[3,7], bust:true}, lv)}, {isHost:true}).state;
  const got = s.current.p0.live;
  check("a held number's bust and Second Chance survive setEntry",
    got.bustOn === 7 && got.sc === 1 && got.freeze === 1 && got.flip3 === 2 && got.f3left === 4);
  check("a Second Chance spent on a number the line doesn't hold is dropped",
    JSON.stringify(got.scUsed) === "[3]", JSON.stringify(got.scUsed));
  s = G.applyAction(s, {t:"commitRound"}, {isHost:true}).state;
  check("and the live cards are kept when the round is scored", s.rounds[0].p0.live && s.rounds[0].p0.live.bustOn === 7);
  const bad = G.scrubEntry({nums:[2], bust:false, live:{bustOn:2, sc:5, flip3:99}});
  check("bustOn needs a busted line; counts are clamped",
    bad.live.bustOn === null && bad.live.sc === 1 && bad.live.flip3 === 3, JSON.stringify(bad.live));
  check("an end-of-round line carries no live field", !("live" in G.scrubEntry({nums:[2]})));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
