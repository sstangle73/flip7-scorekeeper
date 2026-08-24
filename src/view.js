/* The decisions the interface makes, as pure functions.
 *
 * app.js is nineteen hundred lines married to a document, so none of it can be
 * tested. But almost nothing that has gone wrong in it was a drawing bug: it was
 * always a decision. Whether the submit button appears. Whether a line is still
 * editable. Who the bar at the bottom is waiting on. Those decisions live here,
 * where they are plain functions of state and can be tested like the rules core.
 *
 * `me` is this device's relationship to the table:
 *
 *   {room, you, hostId, seats, present, mode, seat}
 *
 * A solo game has no room, which is what everything keys off: the person at the
 * screen runs the game, holds no particular seat, and waits for nobody.
 */
function Flip7View(G){
  "use strict";

  function networked(me){ return !!(me && me.room); }

  /* Solo, the player at the screen is in charge. Networked, the relay says so. */
  function isHost(me){
    if(!networked(me)) return true;
    return !!(me.you && me.you === me.hostId);
  }

  function mySeat(me){
    if(!networked(me)) return null;
    return (me.seats && me.seats[me.you]) || null;
  }

  /* Seats held right now by a phone that isn't this one. These are the only
     players who can meaningfully submit, so they are the only ones worth
     waiting for -- a player with no phone is entered by the host and would
     otherwise hold up the round forever. */
  function awaitedSeats(me){
    if(!networked(me)) return [];
    var seats = me.seats || {}, present = me.present || [], out = [];
    Object.keys(seats).forEach(function(cid){
      if(cid === me.you) return;
      if(present.indexOf(cid) < 0) return;
      var pid = seats[cid];
      if(pid && out.indexOf(pid) < 0) out.push(pid);
    });
    return out;
  }

  function canEdit(me, pid){
    return !networked(me) || isHost(me) || mySeat(me) === pid;
  }

  function isSubmitted(me, state, pid){
    return networked(me) && !!(state.submitted && state.submitted[pid]);
  }

  /* Submitting freezes a line; withdrawing is how it comes back. That holds for
     the host too, so a line nobody can change never looks editable. */
  function lineEditable(me, state, pid){
    return canEdit(me, pid) && !isSubmitted(me, state, pid);
  }

  /* Every line you can edit in a networked game gets a submit control. This was
     once hidden for the host, who is usually the one entering cards for the
     people around the table, and the option simply vanished for them. */
  function showSubmit(me, state, pid){
    return networked(me) && lineEditable(me, state, pid);
  }

  /* Taking a submission back: the person who made it, or the host tidying up. */
  function showWithdraw(me, state, pid){
    return isSubmitted(me, state, pid) && (mySeat(me) === pid || isHost(me));
  }

  function actor(me){ return {isHost: isHost(me), seat: mySeat(me)}; }

  /* Your own line opens first and everyone else's folds away; in a networked
     game at most one other line is open at a time. */
  function boardOpen(me, ui, pid){
    ui = ui || {};
    if(!networked(me) || pid === mySeat(me)) return !(ui.collapsed && ui.collapsed[pid]);
    return !!(ui.expanded && ui.expanded === pid);
  }

  function orderedPlayers(me, state){
    var seat = mySeat(me);
    var out = (state.players || []).slice();
    if(seat) out.sort(function(a, b){ return (b.id === seat) - (a.id === seat); });
    return out;
  }

  /* Everything the bar across the bottom of the screen needs to decide what it
     is. `control` is what its primary button does:
       "advance" -- pass-the-phone: hand the device to the next player
       "score"   -- the host ends the round
       "watch"   -- not the host, nothing to press
     and `prompt` is what to ask before scoring, if anything. The two prompts are
     mutually exclusive by construction rather than by two flags that could
     disagree. */
  function commitBar(me, state){
    var players = state.players || [];
    var current = state.current || {};
    var pass = !networked(me) && !!me && me.mode === "pass";
    var seat = clampSeat(me && me.seat, players.length);

    var entered = players.filter(function(p){ return !G.isEmpty(current[p.id]); }).length;
    var awaited = awaitedSeats(me);
    var waiting = awaited.length ? G.outstanding(state, awaited) : [];
    var expecting = awaited.length > 0;            // is anyone else even on a phone?
    var lastSeat = seat >= players.length - 1;

    var control = (pass && !lastSeat) ? "advance" : isHost(me) ? "score" : "watch";
    var nothingAtAll = entered === 0 && !Object.keys(state.submitted || {}).length;

    return {
      roundNo: (state.rounds || []).length + 1,
      seat: seat,
      canGoBack: pass && seat > 0,
      entered: entered,
      blank: players.length - entered,
      expecting: expecting,
      waiting: waiting,
      allIn: expecting && waiting.length === 0,
      control: control,
      /* Scoring with nobody in the game would commit an empty round. */
      disabled: control === "score" && players.length === 0,
      prompt: control !== "score" ? null
        : waiting.length ? "early"
        /* Everyone scoring nothing is a real round -- the whole table busted --
           but it is also exactly what an accidental tap looks like. */
        : nothingAtAll ? "zero"
        : null,
      /* What the non-host at the bottom of the screen is actually doing. */
      watching: control !== "watch" ? null
        : !mySeat(me) ? "spectator"
        : isSubmitted(me, state, mySeat(me)) ? "submitted"
        : "entering"
    };
  }

  /* The seat index can outlive the player it pointed at -- someone gets removed
     mid-round -- so it is pinned back into range wherever it is read. */
  function clampSeat(seat, count){
    seat = Math.floor(Number(seat)) || 0;
    if(seat < 0) return 0;
    var last = Math.max(0, count - 1);
    return seat > last ? last : seat;
  }

  return {
    networked: networked, isHost: isHost, mySeat: mySeat, awaitedSeats: awaitedSeats,
    canEdit: canEdit, isSubmitted: isSubmitted, lineEditable: lineEditable,
    showSubmit: showSubmit, showWithdraw: showWithdraw, actor: actor,
    boardOpen: boardOpen, orderedPlayers: orderedPlayers,
    commitBar: commitBar, clampSeat: clampSeat
  };
}
