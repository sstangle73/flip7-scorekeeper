/* Live mode: entering each card as it is flipped, and the odds that follow.
 *
 * Pure, like game.js: no DOM, no clock, no randomness. Lines carry their live
 * cards in `entry.live` (game.js keeps that field honest); this file turns a
 * tap into the next entry, counts what has left the deck, and works out each
 * player's chances from what is still in it.
 *
 * How the deck moves, from the rules (edition 3.1, "Starting the next round"):
 * cards from a finished round are set aside, NOT shuffled back. The deck
 * carries on into the next round, and only when it runs out is the discard
 * pile shuffled into a new one -- leaving every card in front of players where
 * it is, busted or not. So the cards still in the deck are the 94 minus the
 * discards since the last shuffle minus everything on the table this round,
 * and a reshuffle shows itself as a round needing more cards than the deck had
 * left. Nothing about it has to be entered.
 */
function Flip7Live(G){
  "use strict";

  /* Every kind of card, with how many the deck holds. */
  var KINDS = [];
  for(var n = 0; n <= 12; n++) KINDS.push({key:"n" + n, copies:G.copiesOf(n)});
  G.MODS.forEach(function(m){ KINDS.push({key:"m" + m, copies:1}); });
  KINDS.push({key:"x2", copies:1});
  KINDS.push({key:"freeze", copies:3}, {key:"flip3", copies:3}, {key:"sc", copies:3});
  var FULL = {};
  KINDS.forEach(function(k){ FULL[k.key] = k.copies; });
  var DECK = G.DECK_SIZE;

  function blankLive(){ return {bustOn:null, sc:0, scUsed:[], freeze:0, flip3:0, f3left:0}; }
  function liveOf(e){ return (e && e.live) || blankLive(); }

  /* ---------- what one line has put on the table ---------- */
  function cardsOf(e){
    var out = {};
    if(!e) return out;
    function add(k, c){ if(c) out[k] = (out[k] || 0) + c; }
    e.nums.forEach(function(n){ add("n" + n, 1); });
    e.mods.forEach(function(m){ add("m" + m, 1); });
    if(e.x2) add("x2", 1);
    var lv = e.live;
    if(lv){
      if(lv.bustOn != null) add("n" + lv.bustOn, 1);           // the duplicate it busted on
      lv.scUsed.forEach(function(n){ add("n" + n, 1); });        // each duplicate a Second Chance ate
      add("sc", lv.sc + lv.scUsed.length);
      add("freeze", lv.freeze);
      add("flip3", lv.flip3);
    }
    return out;
  }
  function total(c){ var t = 0; Object.keys(c).forEach(function(k){ t += c[k]; }); return t; }
  function addInto(into, c){ Object.keys(c).forEach(function(k){ into[k] = (into[k] || 0) + c[k]; }); return into; }

  /* A line entered at the end of the round, rather than card by card, leaves
     out its action cards and the duplicate it busted on. */
  function exact(e){
    if(!e || G.isEmpty(e)) return true;
    return !!e.live && (!e.bust || e.live.bustOn != null);
  }
  function roundCards(round, players){
    var c = {}, ok = true;
    players.forEach(function(p){
      var e = round && round[p.id];
      addInto(c, cardsOf(e));
      if(!exact(e)) ok = false;
    });
    return {cards:c, exact:ok};
  }

  /* The deck as it stands in the live round.
     Walks the scored rounds in order keeping the discard pile; a round that
     drew more than the deck had left must have reshuffled, and the pile it
     leaves behind is then that round alone. Returns:
       unseen   cards of each kind still to come
       left     how many that is
       seen     cards out this round; pile, discards since the last shuffle
       reshuffled  this round has already been through a reshuffle
       approx   some line since the last shuffle was entered without its
                action cards, so the counts are a floor rather than exact
       over     kinds with more on the table than the deck holds -- a typo */
  function deck(state){
    var players = state.players || [];
    var pile = {}, approx = false;
    (state.rounds || []).forEach(function(r){
      var rc = roundCards(r, players);
      if(total(rc.cards) > DECK - total(pile)){ pile = {}; approx = false; }
      addInto(pile, rc.cards);
      if(!rc.exact) approx = true;
    });
    var cur = roundCards(state.current || {}, players);
    var reshuffled = total(cur.cards) > DECK - total(pile);
    if(reshuffled){ pile = {}; approx = false; }
    if(!cur.exact) approx = true;

    var unseen = {}, over = [], left = 0;
    KINDS.forEach(function(k){
      var onTable = cur.cards[k.key] || 0;
      if(onTable > k.copies) over.push(k.key);
      var u = k.copies - onTable - (pile[k.key] || 0);
      unseen[k.key] = u > 0 ? u : 0;
      left += unseen[k.key];
    });
    return {unseen:unseen, left:left, seen:total(cur.cards), pile:total(pile),
            reshuffled:reshuffled, approx:approx, over:over};
  }

  /* What the next card off the deck is, kind by kind -- the same for whoever
     flips it. `groups` adds them up as the rules sort them. */
  function nextCard(unseen){
    var left = 0;
    KINDS.forEach(function(k){ left += unseen[k.key] || 0; });
    var p = {}, groups = {numbers:0, modifiers:0, actions:0};
    KINDS.forEach(function(k){
      var c = unseen[k.key] || 0;
      p[k.key] = left ? c / left : 0;
      var g = k.key.charAt(0) === "n" ? "numbers"
        : (k.key.charAt(0) === "m" || k.key === "x2") ? "modifiers" : "actions";
      groups[g] += c;
    });
    Object.keys(groups).forEach(function(g){ groups[g] = {count:groups[g], p: left ? groups[g] / left : 0}; });
    return {left:left, p:p, groups:groups};
  }

  /* ---------- one player's chances ---------- */

  /* Bust risk on the next card is the duplicates of what they hold still in
     the deck, over everything still in it. A Second Chance turns that hit
     into a lost Second Chance instead of a bust, so it is reported as the
     risk of spending it.

     The Flip 7 chance is "if they keep flipping until it happens or they
     bust": only number cards matter to that question, so the others are
     skipped, and other players' draws are left out -- nobody knows yet what
     those will be. Flip Three survival does count every card, since each one
     uses up a flip. */
  function playerOdds(e, unseen){
    e = e || G.blankEntry();
    var lv = liveOf(e);
    var left = 0;
    Object.keys(unseen).forEach(function(k){ left += unseen[k]; });
    var held = e.nums.slice();
    var status = e.bust ? "bust" : held.length >= 7 ? "flip7" : lv.freeze ? "frozen" : "active";

    var dupes = 0, fresh = 0, numsLeft = 0;
    for(var n = 0; n <= 12; n++){
      var u = unseen["n" + n] || 0;
      numsLeft += u;
      if(held.indexOf(n) >= 0) dupes += u; else fresh += u;
    }
    var protectedBy = lv.sc > 0;
    var hit = left ? dupes / left : 0;
    var out = {
      status: status,
      left: left,
      dupes: dupes,
      hit: hit,                                  // chance the next card duplicates
      bust: protectedBy ? 0 : hit,               // chance the next card ends their round
      protectedBy: protectedBy,
      safe: left ? 1 - (protectedBy ? 0 : hit) : 1,
      fresh: left ? fresh / left : 0,            // chance the next card is a new number
      flip7: status === "active" ? reach7(held, lv.sc > 0, unseen, null) : (status === "flip7" ? 1 : 0),
      flipsLeft: status === "active" ? lv.f3left : 0,
      survive: null
    };
    if(out.flipsLeft > 0) out.survive = reach7(held, lv.sc > 0, unseen, out.flipsLeft);
    return out;
  }

  /* Probability of not busting: through `draws` more cards, or (draws null)
     until the line holds seven. State is the set held, whether a Second Chance
     is still unused, and which number it ate -- all three change what is left
     in the deck. */
  function reach7(held0, sc0, unseen, draws){
    var start = 0;
    held0.forEach(function(n){ start |= 1 << n; });
    var base = [], others = 0;
    for(var n = 0; n <= 12; n++) base.push(unseen["n" + n] || 0);
    Object.keys(unseen).forEach(function(k){ if(k.charAt(0) !== "n") others += unseen[k]; });
    var memo = {};

    function bits(m){ var c = 0; while(m){ c += m & 1; m >>= 1; } return c; }
    function go(mask, sc, ate, k, skipped){
      if(bits(mask) >= 7) return 1;
      if(draws != null && k === 0) return 1;
      var key = mask + "," + sc + "," + ate + "," + k + "," + skipped;
      if(key in memo) return memo[key];
      var avail = [], numTotal = 0;
      for(var v = 0; v <= 12; v++){
        var a = base[v];
        if((mask & (1 << v)) && !(start & (1 << v))) a--;      // drawn on the way here
        if(v === ate) a--;                                     // the duplicate the Second Chance ate
        avail.push(a > 0 ? a : 0);
        numTotal += avail[v];
      }
      /* Counting every card for Flip Three; only numbers for reaching seven. */
      var rest = draws != null ? Math.max(0, others - skipped) : 0;
      var all = numTotal + rest;
      var p;
      if(all === 0) p = draws != null ? 1 : 0;
      else {
        p = rest ? (rest / all) * go(mask, sc, ate, k - 1, skipped + 1) : 0;
        for(var w = 0; w <= 12; w++){
          if(!avail[w]) continue;
          var pw = avail[w] / all;
          if(!(mask & (1 << w))) p += pw * go(mask | (1 << w), sc, ate, k - 1, skipped);
          else if(sc && ate < 0) p += pw * go(mask, 0, w, k - 1, skipped);
          /* otherwise that card busts them */
        }
      }
      memo[key] = p;
      return p;
    }
    return go(start, sc0 ? 1 : 0, -1, draws == null ? 0 : draws, 0);
  }

  /* ---------- turning a tap into the next entry ---------- */

  function copyEntry(e){
    var x = G.clone(e || G.blankEntry());
    var lv = x.live || {};
    x.live = {
      bustOn: lv.bustOn == null ? null : lv.bustOn,
      sc: lv.sc || 0, scUsed: (lv.scUsed || []).slice(),
      freeze: lv.freeze || 0, flip3: lv.flip3 || 0, f3left: lv.f3left || 0
    };
    return x;
  }
  /* Each card dealt to a player flipping three uses up one of those flips; the
     ones that end the line -- a bust or a seventh number -- end them all. */
  function dealt(x){
    if(x.live.f3left > 0) x.live.f3left--;
    if(x.bust || x.nums.length >= 7) x.live.f3left = 0;
    return x;
  }
  function numState(e, n){
    var lv = liveOf(e);
    if(e.nums.indexOf(n) < 0) return "none";
    if(lv.bustOn === n) return "bust";
    if(lv.scUsed.indexOf(n) >= 0) return "saved";
    return "held";
  }

  /* A number card cycles none -> held -> bust -> none. A player holding an
     unused Second Chance doesn't bust on a duplicate, so from held it goes to
     saved instead: the duplicate and the Second Chance are both discarded and
     the number stays. Only one number can be the bust; tapping another moves
     it there. `cap` is how many numbers the line may hold (G.numCap, tightened
     when someone else already has the Flip 7). */
  function tapNumber(e, n, cap){
    var x = copyEntry(e), lv = x.live;
    var st = numState(x, n);
    if(st === "none"){
      if(x.nums.length >= cap) return x;
      x.nums.push(n);
      x.nums.sort(function(a, b){ return a - b; });
      return dealt(x);
    }
    if(st !== "bust" && lv.sc > 0){
      lv.sc = 0;
      lv.scUsed.push(n);
      return dealt(x);
    }
    if(st !== "bust"){
      if(x.nums.length > 6) return x;                      // seven unique ended the round already
      x.bust = true;
      lv.bustOn = n;
      return dealt(x);
    }
    /* bust -> none: drop the number, and any Second Chance it had eaten goes
       back to being unused, if there is room for it. */
    x.bust = false;
    lv.bustOn = null;
    x.nums = x.nums.filter(function(k){ return k !== n; });
    var ate = lv.scUsed.filter(function(k){ return k === n; }).length;
    lv.scUsed = lv.scUsed.filter(function(k){ return k !== n; });
    if(ate && !lv.sc) lv.sc = 1;
    return x;
  }

  /* Second Chance: none -> ready -> none. One spent on a number is undone from
     that number (or from its own chip, which hands it back as ready). */
  function tapSecondChance(e){
    var x = copyEntry(e), lv = x.live;
    if(lv.sc){ lv.sc = 0; return x; }
    if(lv.scUsed.length >= 3) return x;
    lv.sc = 1;
    return dealt(x);
  }
  function unspend(e, n){
    var x = copyEntry(e), lv = x.live;
    var i = lv.scUsed.indexOf(n);
    if(i < 0) return x;
    lv.scUsed.splice(i, 1);
    if(!lv.sc) lv.sc = 1;
    return x;
  }
  function tapFreeze(e){
    var x = copyEntry(e);
    if(x.live.freeze){ x.live.freeze = 0; return x; }
    x.live.freeze = 1;
    dealt(x);
    /* Frozen mid-Flip-Three, the rest of the flips still happen first: the
       rules resolve a Freeze only after all three are drawn. */
    return x;
  }
  function addFlip3(e){
    var x = copyEntry(e);
    if(x.live.flip3 >= 3) return x;
    dealt(x);
    x.live.flip3++;
    if(!x.bust && x.nums.length < 7) x.live.f3left += 3;
    return x;
  }
  function removeFlip3(e){
    var x = copyEntry(e);
    if(!x.live.flip3) return x;
    x.live.flip3--;
    x.live.f3left = Math.max(0, x.live.f3left - 3);
    return x;
  }
  /* The modifier cards score the same either way; in live mode they also use
     up a forced flip when they arrive. */
  function tapMod(e, m){
    var x = copyEntry(e);
    var i = x.mods.indexOf(m);
    if(i >= 0){ x.mods.splice(i, 1); return x; }
    x.mods.push(m);
    return dealt(x);
  }
  function tapX2(e){
    var x = copyEntry(e);
    x.x2 = !x.x2;
    return x.x2 ? dealt(x) : x;
  }

  return {
    KINDS:KINDS, FULL:FULL,
    blankLive:blankLive, liveOf:liveOf, cardsOf:cardsOf, exact:exact,
    deck:deck, nextCard:nextCard, playerOdds:playerOdds, reach7:reach7,
    numState:numState, tapNumber:tapNumber, tapSecondChance:tapSecondChance, unspend:unspend,
    tapFreeze:tapFreeze, addFlip3:addFlip3, removeFlip3:removeFlip3, tapMod:tapMod, tapX2:tapX2
  };
}
