/* The table record: what a finished game is filed as, and what the pile of
 * them adds up to.
 *
 * Pure, like view.js -- no DOM, no storage, and the clock comes in as an
 * argument -- so the arithmetic behind every number on the record screen can be
 * tested without a browser.
 *
 * A record is what app.js keeps in localStorage, one per game, newest first:
 *
 *   {id, at, target, rounds, players:[{name,total,best,busts,flip7s}],
 *    winner, winners, tied,
 *    endedAt,    // when the last round was scored          -- added Oct 2026
 *    toTarget}   // rounds until someone first reached target -- added Oct 2026
 *
 * Records written before the last two fields existed still load: anything that
 * needs them simply leaves those games out, and the screen says so. Nothing is
 * back-filled with a guess.
 */
function Flip7Stats(G){
  "use strict";

  /* A game left open overnight and finished in the morning is not a twelve-hour
     game. Spans past this are left out of the length figures. */
  var LONGEST_PLAUSIBLE_MS = 12 * 60 * 60 * 1000;

  /* When the game began. Not stored: the game id already says, because app.js
     mints it as "g" + Date.now() in base 36 + a random tail, at the moment the
     game starts. Eight base-36 digits covers every millisecond from 1972 to
     2059, so the timestamp is exactly the first eight characters. That makes
     this true of every game ever archived, not only new ones. */
  function startOf(rec){
    var id = rec && rec.id;
    if(typeof id !== "string" || id.charAt(0) !== "g" || id.length < 9) return null;
    var t = parseInt(id.slice(1, 9), 36);
    return isFinite(t) && t > Date.UTC(2020, 0, 1) ? t : null;
  }

  /* Rounds until someone's running total first reached the target, or null if
     nobody has. */
  function roundsToTarget(g){
    var run = {};
    for(var i = 0; i < g.rounds.length; i++){
      var r = g.rounds[i];
      for(var j = 0; j < g.players.length; j++){
        var pid = g.players[j].id;
        run[pid] = (run[pid] || 0) + G.scoreOf(r[pid]);
        if(run[pid] >= g.target) return i + 1;
      }
    }
    return null;
  }

  /* File a game. `prev` is this game's existing record, if it was filed
     before: app.js re-files on every render once a game is won, and again when
     the next one starts, so the end time has to survive all of that.

     The end time is the moment this game first reached its current number of
     rounds -- in practice, when the last round was scored. A record that was
     filed before end times existed keeps none: stamping it now would date a
     game from last week to today. */
  function record(g, prev, now){
    var rec = {
      id: g.gameId,
      at: now,
      target: g.target,
      rounds: g.rounds.length,
      toTarget: roundsToTarget(g),
      players: g.players.map(function(p){
        var scores = g.rounds.map(function(r){ return G.scoreOf(r[p.id]); });
        var busts = g.rounds.filter(function(r){ return r[p.id] && r[p.id].bust; }).length;
        var sevens = g.rounds.filter(function(r){
          var e = r[p.id]; return e && !e.bust && e.nums.length === 7;
        }).length;
        return {
          name: p.name,
          total: G.totalFor(g, p.id),
          best: scores.length ? Math.max.apply(null, scores) : 0,
          busts: busts,
          flip7s: sevens
        };
      })
    };
    if(!prev || prev.rounds !== rec.rounds) rec.endedAt = now;
    else if(typeof prev.endedAt === "number") rec.endedAt = prev.endedAt;

    var best = rec.players.reduce(function(m, p){ return Math.max(m, p.total); }, -Infinity);
    var winners = rec.players.filter(function(p){ return p.total === best; });
    /* A draw is a draw. Crediting the first name in the roster invented a win
       that never happened, permanently, on every device at the table. */
    rec.winners = winners.map(function(p){ return p.name; });
    rec.winner = winners.length === 1 ? winners[0].name : null;
    rec.tied = winners.length > 1;
    return rec;
  }

  function usable(h){
    return (Array.isArray(h) ? h : []).filter(function(g){
      return g && Array.isArray(g.players) && g.players.length && typeof g.rounds === "number";
    });
  }

  function topTotal(g){
    return g.players.reduce(function(m, p){ return Math.max(m, p.total || 0); }, 0);
  }

  /* Someone crossed the line. A game put away part-way through is still in the
     record, but it says nothing about how long a game takes. */
  function completed(g){ return g.rounds > 0 && topTotal(g) >= g.target; }

  /* Rounds it took to reach the target. Older records don't carry it; for a
     game that ended over the line, the rounds played are that number unless
     the table chose "Keep playing" after the win. */
  function toTargetOf(g){
    if(typeof g.toTarget === "number") return g.toTarget;
    return completed(g) ? g.rounds : null;
  }

  function lengthOf(g){
    if(typeof g.endedAt !== "number") return null;
    var s = startOf(g);
    if(s === null) return null;
    var d = g.endedAt - s;
    return d > 0 && d <= LONGEST_PLAUSIBLE_MS ? d : null;
  }

  function spread(xs){
    if(!xs.length) return null;
    var tot = xs.reduce(function(a, b){ return a + b; }, 0);
    return {n:xs.length, avg:tot / xs.length,
            min:Math.min.apply(null, xs), max:Math.max.apply(null, xs)};
  }

  /* Oldest first. The stored list is ordered by when each game was last filed,
     which a re-file reshuffles; when it started is what a streak runs along. */
  function chronological(h){
    return usable(h).map(function(g, i){ return {g:g, t:startOf(g) || g.at || 0, i:i}; })
      .sort(function(a, b){ return a.t - b.t || b.i - a.i; })
      .map(function(x){ return x.g; });
  }

  /* The whole table's numbers. */
  function summary(history){
    var h = usable(history);
    var done = h.filter(completed);

    var timed = [], firstTimed = null;
    done.forEach(function(g){
      var d = lengthOf(g);
      if(d === null) return;
      timed.push(d);
      if(firstTimed === null || g.endedAt < firstTimed) firstTimed = g.endedAt;
    });

    /* Rounds to reach the target, per target: 200 and 150 are different games. */
    var byTarget = {};
    done.forEach(function(g){
      var n = toTargetOf(g);
      if(n === null) return;
      (byTarget[g.target] = byTarget[g.target] || []).push(n);
    });
    var toTarget = Object.keys(byTarget).map(function(t){
      var s = spread(byTarget[t]); s.target = +t; return s;
    }).sort(function(a, b){ return b.n - a.n || a.target - b.target; });

    var points = 0, lines = 0, bestRound = null;
    h.forEach(function(g){
      g.players.forEach(function(p){
        points += p.total || 0;
        lines += g.rounds;
        if(p.best > 0 && (!bestRound || p.best > bestRound.score)){
          bestRound = {score:p.best, names:[p.name]};
        } else if(bestRound && p.best === bestRound.score && bestRound.names.indexOf(p.name) < 0){
          bestRound.names.push(p.name);
        }
      });
    });

    return {
      games: h.length,
      completed: done.length,
      length: spread(timed),               // ms; only games with an end time
      timedSince: firstTimed,
      toTarget: toTarget,
      perRound: lines ? points / lines : null,
      bestRound: bestRound,
      winningScore: spread(done.map(topTotal))
    };
  }

  /* Each player's numbers, rolled up by name. */
  function players(history){
    var by = {};
    chronological(history).forEach(function(g){
      g.players.forEach(function(p){
        var e = by[p.name] || (by[p.name] = {name:p.name, games:0, wins:0, ties:0, best:0,
          busts:0, flip7s:0, points:0, rounds:0, streak:0, longest:0});
        e.games++;
        if(g.winner === p.name){
          e.wins++;
          e.streak++;
          if(e.streak > e.longest) e.longest = e.streak;
        } else {
          if(g.tied && (g.winners || []).indexOf(p.name) >= 0) e.ties++;
          e.streak = 0;                    // a shared win doesn't keep a streak alive
        }
        if(p.best > e.best) e.best = p.best;
        e.busts += p.busts || 0;
        e.flip7s += p.flip7s || 0;
        e.points += p.total || 0;
        e.rounds += g.rounds;
      });
    });
    return Object.keys(by).map(function(k){
      var e = by[k];
      e.winRate = e.games ? e.wins / e.games : 0;
      e.bustRate = e.rounds ? e.busts / e.rounds : 0;
      e.perRound = e.rounds ? e.points / e.rounds : 0;
      return e;
    }).sort(function(a, b){ return b.wins - a.wins || b.games - a.games; });
  }

  /* "38 min", "1 h 05 min". */
  function duration(ms){
    var m = Math.round(ms / 60000);
    if(m < 60) return m + " min";
    var mm = m % 60;
    return Math.floor(m / 60) + " h " + (mm < 10 ? "0" : "") + mm + " min";
  }

  return {
    record: record, startOf: startOf, completed: completed, lengthOf: lengthOf,
    toTargetOf: toTargetOf, summary: summary, players: players, duration: duration,
    LONGEST_PLAUSIBLE_MS: LONGEST_PLAUSIBLE_MS
  };
}
