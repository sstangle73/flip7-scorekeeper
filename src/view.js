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

  /* Is the table looking at a scored round the host stepped back into? */
  function editingRound(state){
    return state && state.editing != null ? state.editing : null;
  }

  /* Submitting freezes a line; withdrawing is how it comes back. That holds for
     the host too, so a line nobody can change never looks editable.

     A scored round is different: nobody is holding those cards any more, so a
     seat grants no claim on them and only the host may correct them. */
  function lineEditable(me, state, pid){
    if(editingRound(state) != null) return isHost(me);
    return canEdit(me, pid) && !isSubmitted(me, state, pid);
  }

  /* Every line you can edit in a networked game gets a submit control. This was
     once hidden for the host, who is usually the one entering cards for the
     people around the table, and the option simply vanished for them. */
  function showSubmit(me, state, pid){
    if(editingRound(state) != null) return false;   // history is corrected, not submitted
    return networked(me) && lineEditable(me, state, pid);
  }

  /* Taking a submission back: the person who made it, or the host tidying up. */
  function showWithdraw(me, state, pid){
    if(editingRound(state) != null) return false;
    return isSubmitted(me, state, pid) && (mySeat(me) === pid || isHost(me));
  }

  function actor(me){ return {isHost: isHost(me), seat: mySeat(me)}; }

  /* A seat is claimed when a phone that is here holds it. A player whose phone
     never arrived, or has gone, is a line the host enters -- the same test
     awaitedSeats() makes to decide who is worth waiting for. */
  function seatClaimed(me, pid){
    if(!networked(me)) return false;
    var seats = me.seats || {}, present = me.present || [];
    return Object.keys(seats).some(function(cid){
      return seats[cid] === pid && present.indexOf(cid) >= 0;
    });
  }

  /* Which lines start open, before anyone folds or expands anything. Your own
     always does. The host also gets every unclaimed line, because those are the
     ones they have to enter -- and they get them again each round, since
     committing clears the folds. */
  function openByDefault(me, pid){
    if(!networked(me) || pid === mySeat(me)) return true;
    return isHost(me) && !seatClaimed(me, pid);
  }

  /* A line that starts open folds away by tapping it; the rest are closed until
     expanded, and at most one of those is open at a time. */
  function boardOpen(me, ui, pid){
    ui = ui || {};
    if(openByDefault(me, pid)) return !(ui.collapsed && ui.collapsed[pid]);
    return !!(ui.expanded && ui.expanded === pid);
  }

  /* Which rounds the scorecard offers to step back into.

     The scorecard is the list of rounds already -- with the scores that are how
     a wrong round gets noticed in the first place -- so it is the way back in.
     A separate strip of round chips along the top said the same thing twice and
     grew a horizontal scrollbar somewhere around round nine. */
  function roundRows(me, state){
    var host = isHost(me);
    var editing = editingRound(state);
    return (state.rounds || []).map(function(_, i){
      return {
        index: i,
        no: i + 1,
        editing: editing === i,
        selectable: host && editing !== i
      };
    });
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
    var editing = editingRound(state);
    var current = G.openRound(state);
    /* Pass-the-phone is a way of collecting a live round. Correcting a scored
       one is the host at the table with the card already face up, so the strip
       of seats has nothing to hand round. */
    var pass = editing == null && !networked(me) && !!me && me.mode === "pass";
    var seat = clampSeat(me && me.seat, players.length);

    var entered = players.filter(function(p){ return !G.isEmpty(current[p.id]); }).length;
    var awaited = awaitedSeats(me);
    /* outstanding() reads state.submitted directly, so hand it a state that has
       one -- everything else here degrades on a partial state and this should
       too. No submissions recorded means everyone awaited is still out. */
    var counted = state.submitted ? state : {players: players, submitted: {}};
    var waiting = awaited.length ? G.outstanding(counted, awaited) : [];
    var expecting = awaited.length > 0;            // is anyone else even on a phone?
    var lastSeat = seat >= players.length - 1;

    var control = editing != null ? (isHost(me) ? "done" : "watch")
      : (pass && !lastSeat) ? "advance" : isHost(me) ? "score" : "watch";
    /* Submissions only exist in a networked game. A solo game carrying a
       submitted map -- a scorecard that came back from a room this device has
       since left -- must not let that suppress the all-zeros question, which is
       the only guard against an accidental tap scoring an untouched round. */
    var anySubmitted = networked(me) && Object.keys(state.submitted || {}).length > 0;
    var nothingAtAll = entered === 0 && !anySubmitted;

    return {
      /* The round on screen, which is the one being edited if there is one. */
      roundNo: editing == null ? (state.rounds || []).length + 1 : editing + 1,
      editing: editing,
      liveNo: (state.rounds || []).length + 1,
      seat: seat,
      canGoBack: pass && seat > 0,
      entered: entered,
      blank: players.length - entered,
      expecting: expecting,
      /* Both halves of "N of M in" come from here, so they cannot disagree. */
      awaited: awaited,
      waiting: waiting,
      allIn: expecting && waiting.length === 0,
      control: control,
      /* Scoring with nobody in the game would commit an empty round. */
      disabled: control === "score" && players.length === 0,
      /* Nothing is being scored while a scored round is open, so nothing to ask. */
      prompt: control !== "score" ? null
        : waiting.length ? "early"
        /* Everyone scoring nothing is a real round -- the whole table busted --
           but it is also exactly what an accidental tap looks like. */
        : nothingAtAll ? "zero"
        : null,
      /* What the non-host at the bottom of the screen is actually doing. */
      watching: control !== "watch" ? null
        : editing != null ? "hostediting"
        : !mySeat(me) ? "spectator"
        : isSubmitted(me, state, mySeat(me)) ? "submitted"
        : "entering"
    };
  }

  /* ---------- rooms this device has been in ----------
     The relay deletes a room a week after its last action, so a code older than
     that cannot possibly still work and is not worth offering; a code newer than
     that probably does. That is the whole list, and reading it costs no network
     at all -- which is the point. The one room we ask the relay about is the one
     we might still be sitting in, and that is a much narrower question than
     "which of these rooms exist". */
  var ROOM_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;   // matches the relay's ROOM_TTL_MS
  var ROOM_MEMORY_MAX = 5;                        // offered on screen
  var ROOM_STORE_MAX = 12;                        // kept, across every relay
  /* How long the newest room stays worth a launch-time request. Past this it is
     still in the list; it just costs a tap instead of a round trip, so a phone
     that joined one room once does not go on contacting the relay at every
     launch for a week. */
  var RESUME_PROBE_MS = 12 * 60 * 60 * 1000;

  /* Entries were once bare code strings with one shared timestamp beside them.
     Carry those forward rather than dropping them -- the whole reason this list
     exists is that a room you walked out of is still there for a week -- but
     mark them `approx`, because their real age is genuinely unknown. `opts.now`
     is what an undated entry inherits, so callers must pass it. */
  function normalizeRooms(rooms, opts){
    opts = opts || {};
    var now = Number(opts.now) || 0;
    var host = opts.relayHost || "";
    var out = [], seen = {};
    (Array.isArray(rooms) ? rooms : []).forEach(function(r){
      var e = null;
      if(typeof r === "string" && r){
        e = {code:r.toUpperCase(), at:now, relay:host, approx:true, left:false};
      } else if(r && typeof r === "object" && typeof r.code === "string" && r.code){
        e = {code:r.code.toUpperCase(), at:Number(r.at) || 0,
             relay:typeof r.relay === "string" ? r.relay : "",
             approx:!!r.approx, left:!!r.left};
      }
      if(!e) return;
      /* The same four characters on two relays are two different rooms. */
      var key = e.relay + " " + e.code;
      if(seen[key]) return;
      seen[key] = true;
      out.push(e);
    });
    /* Stable, so migrated entries that all share `now` keep the order they were
       stored in -- which was newest first. */
    out.sort(function(a, b){ return b.at - a.at; });
    return out.slice(0, ROOM_STORE_MAX);
  }

  /* What to put on screen, newest first: rooms on the relay we are pointed at
     now, still inside the week the relay keeps them for. A code minted by some
     other relay means nothing here, so it is filtered out rather than shown and
     then failed to join. */
  function recentRooms(rooms, opts){
    opts = opts || {};
    var now = Number(opts.now) || 0;
    var host = opts.relayHost || "";
    return normalizeRooms(rooms, opts).filter(function(r){
      if(host && r.relay && r.relay !== host) return false;
      return r.at > 0 && now - r.at <= ROOM_MEMORY_MS;
    }).slice(0, ROOM_MEMORY_MAX);
  }

  /* The single room worth asking the relay about unprompted. Only the newest,
     only if this device did not deliberately walk out of it, and only while it
     is fresh: leaving is a decision, and answering it with a "Rejoin" banner on
     the very next screen would be arguing. The room stays in the list either
     way, which is the difference between "don't offer" and "forget". */
  function resumeCandidate(rooms, opts){
    opts = opts || {};
    var now = Number(opts.now) || 0;
    var top = recentRooms(rooms, opts)[0];
    if(!top || top.left) return null;
    return (now - top.at <= RESUME_PROBE_MS) ? top : null;
  }

  /* Coarse on purpose: the exact minute a room was last touched is noise, and
     an entry carried over from the old format only honestly knows "recently". */
  function roomAgeLabel(ms, approx){
    if(approx) return "recently";
    var mins = Math.floor((Number(ms) || 0) / 60000);
    if(mins < 1) return "just now";
    if(mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
    var hours = Math.floor(mins / 60);
    if(hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
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
    openByDefault: openByDefault, boardOpen: boardOpen, orderedPlayers: orderedPlayers,
    editingRound: editingRound, roundRows: roundRows,
    commitBar: commitBar, clampSeat: clampSeat,
    normalizeRooms: normalizeRooms, recentRooms: recentRooms,
    resumeCandidate: resumeCandidate, roomAgeLabel: roomAgeLabel,
    ROOM_MEMORY_MS: ROOM_MEMORY_MS, ROOM_MEMORY_MAX: ROOM_MEMORY_MAX,
    ROOM_STORE_MAX: ROOM_STORE_MAX, RESUME_PROBE_MS: RESUME_PROBE_MS
  };
}
