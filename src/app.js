(function(){
  "use strict";

  var G = Flip7Rules();
  var V = Flip7View(G);                    // the interface's decisions, tested separately
  var LV = Flip7Live(G);                   // live card entry and the odds, tested separately
  var NUM_WORDS = G.NUM_WORDS, MODS = G.MODS, ACTIONS = G.ACTIONS, DECK_SIZE = G.DECK_SIZE;
  var copiesOf = G.copiesOf, blankEntry = G.blankEntry, isEmpty = G.isEmpty, scoreOf = G.scoreOf;

  var RULES_URL = "https://cdn.shopify.com/s/files/1/0611/3958/3198/files/25_FLIP_7_TB_RULES_C_Rev_9_2_25_ND.pdf?v=1756935535";
  var REPO_URL = "https://gitlab.com/sstangle73/flip7-scorekeeper";
  var COFFEE_URL = "https://buymeacoffee.com/stevenstorie";

  /* Bake a relay in here to skip the setup step for your own group. Left empty,
     the app is a standalone scorekeeper and never touches the network. */
  var RELAY_URL = "";

  /* The alphabet the relay mints from: no O, 0, I or 1, since codes get read
     aloud across a table. Checking here turns a mis-heard letter into an
     instant, specific message instead of a minute of silent reconnecting. */
  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function codeProblem(code){
    if(code.length !== 4) return "Room codes are four characters.";
    for(var i = 0; i < code.length; i++){
      if(CODE_ALPHABET.indexOf(code[i]) < 0){
        return "Codes never contain O, 0, I or 1 — check that " + code[i] + ".";
      }
    }
    return null;
  }

  var GAME_KEY = "flip7-scorekeeper-v1";
  var PREF_KEY = "flip7-prefs-v1";
  var HIST_KEY = "flip7-history-v1";

  /* ---------- storage (sandbox-safe) ---------- */
  var mem = {};
  function put(key, val){
    var raw = JSON.stringify(val);
    mem[key] = raw;
    try { localStorage.setItem(key, raw); } catch(e){ /* in-memory only */ }
  }
  function get(key){
    var raw = null;
    try { raw = localStorage.getItem(key); } catch(e){ raw = mem[key]; }
    if(raw === null || raw === undefined) raw = mem[key];
    if(!raw) return null;
    try { return JSON.parse(raw); } catch(e){ return null; }
  }
  function drop(key){
    delete mem[key];
    try { localStorage.removeItem(key); } catch(e){}
  }

  function relayHost(u){
    try { return new URL(u).host; } catch(e){ return u || ""; }
  }

  /* ---------- local, per-device state ---------- */
  var prefs = get(PREF_KEY) || {};
  if(typeof prefs !== "object" || !prefs) prefs = {};
  /* Math.random is predictable from observed output, and the client id IS
     observed -- it is broadcast to the whole room. A secret drawn from the same
     stream moments later is therefore guessable, so use the CSPRNG. */
  function randomId(prefix, bytes){
    var out = "";
    try {
      var buf = new Uint8Array(bytes);
      crypto.getRandomValues(buf);
      for(var i = 0; i < buf.length; i++) out += (buf[i] + 256).toString(16).slice(1);
    } catch(e){
      for(var j = 0; j < bytes; j++) out += Math.floor(Math.random() * 256).toString(16);
    }
    return prefix + out;
  }
  if(!prefs.clientId) prefs.clientId = randomId("c", 8);

  /* Proves this device owns its client id. Kept per relay: a relay you were
     talked into trusting once must not learn a credential that works on the
     one you actually play on. */
  if(typeof prefs.secrets !== "object" || !prefs.secrets) prefs.secrets = {};
  function secretFor(relay){
    var key = relayHost(relay || "") || "local";
    if(!prefs.secrets[key]) { prefs.secrets[key] = randomId("s", 16); savePrefs(); }
    return prefs.secrets[key];
  }
  if(typeof prefs.name !== "string") prefs.name = "";
  if(typeof prefs.relay !== "string" || (!prefs.relay && RELAY_URL)) prefs.relay = RELAY_URL;
  if(prefs.mode !== "pass" && prefs.mode !== "live") prefs.mode = "table";

  /* Rooms this device has been in. Older builds kept two things that disagreed:
     a list of bare codes nothing ever read, and a single `lastRoom` pointer that
     a deliberate exit wiped -- so leaving a room threw away the only copy of its
     code while the room itself sat on the relay for the rest of its week. Fold
     both into one dated list, and let leaving mark an entry rather than delete
     it. */
  (function migrateRooms(){
    var now = Date.now();
    var host = relayHost(prefs.relay);
    var list = V.normalizeRooms(prefs.rooms, {now:now, relayHost:host});
    if(prefs.lastRoom){
      var code = String(prefs.lastRoom).toUpperCase();
      var at = Number(prefs.lastRoomAt) || 0;
      var hit = list.filter(function(r){ return r.code === code && r.relay === host; })[0];
      /* The pointer is the one thing that carried a real timestamp, so it wins
         over the undated copy of the same code in the list. */
      if(hit){ if(at){ hit.at = at; hit.approx = false; } }
      else list.push({code:code, at:at || now, relay:host, approx:!at, left:false});
    }
    delete prefs.lastRoom;
    delete prefs.lastRoomAt;
    prefs.rooms = V.normalizeRooms(list, {now:now, relayHost:host});
  })();

  var ui = {
    screen: "launch",       // launch | setup | together | game
    mode: prefs.mode,       // table | pass | live (pass is solo only)
    byHand: {},             // live mode: lines switched to the end-of-round picker
    collapsed: {},
    seat: 0,
    room: "",
    busy: null,
    notice: null
  };

  var state = G.newGame();
  var seats = ["", ""];                    // solo setup screen name boxes
  var link = {you:null, hostId:null, seats:{}, present:[], people:[], status:"offline", detail:null};
  var net = null;

  /* Resume whatever was going on. A room in the URL wins over a saved game. */
  (function boot(){
    var saved = G.normalize(get(GAME_KEY));
    if(saved){
      state = saved;
      seats = state.players.length ? state.players.map(function(p){ return p.name; }) : ["",""];
      if(state.started) ui.screen = "game";
    }
    openLocator(parseLocator());
    savePrefs();
  })();

  function openLocator(q){
    if(q.relay && q.relay !== prefs.relay){
      /* Anything other than the relay this build ships with, or the one already
         saved on the device, needs an explicit yes. A clone with no baked relay
         used to accept any address a link handed it. */
      var known = q.relay === RELAY_URL;
      if(!known && (RELAY_URL || prefs.relay)){
        ui.foreignRelay = q.relay;
      } else {
        prefs.relay = q.relay;
      }
    }
    if(q.room){
      ui.screen = "together";
      ui.pendingRoom = q.room.toUpperCase();
    }
  }

  /* Tapping a room link while the app is already open only changes the hash, so
     nothing reloads. React to it. */
  window.addEventListener("hashchange", function(){
    var q = parseLocator();
    if(!q.room) return;
    var code = q.room.toUpperCase();
    if(code === ui.room) return;                 // already in that room

    /* Work out whether we can actually join BEFORE giving up the room we are
       in. Leaving first meant a link to a relay we do not trust would eject you
       from a live game and leave the solo save holding its scorecard. */
    var foreign = q.relay && q.relay !== prefs.relay &&
                  q.relay !== RELAY_URL && (RELAY_URL || prefs.relay);
    if(foreign){
      ui.foreignRelay = q.relay;
      ui.pendingRoom = code;
      notify("That link points at a different relay. Confirm before joining.");
      render();
      return;                                    // still in the current room
    }
    if(networked()) leaveRoom(true);             // only now is it safe to hop
    openLocator(q);
    savePrefs();
    if(ui.pendingRoom && prefs.relay) joinRoom(ui.pendingRoom);
    else { ui.screen = "together"; render(); }
  });

  function parseLocator(){
    var out = {};
    var search = (location.search || "").replace(/^\?/, "");
    var hash = (location.hash || "").replace(/^#/, "");
    [search, hash].forEach(function(part){
      part.split("&").forEach(function(kv){
        var i = kv.indexOf("=");
        if(i < 0) return;
        var k = decodeURIComponent(kv.slice(0, i));
        var v = decodeURIComponent(kv.slice(i + 1));
        if(k === "relay" || k === "room") out[k] = v;
      });
    });
    return out;
  }

  function savePrefs(){
    prefs.mode = ui.mode;
    put(PREF_KEY, prefs);
  }
  /* Only the solo game is persisted; a networked room lives on the server, and
     overwriting the local save would clobber the game you left behind. */
  function saveGame(){ if(!networked()) put(GAME_KEY, state); }

  /* ---------- finished games ---------- */
  function freshGameId(){
    return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function history(){
    var h = get(HIST_KEY);
    return Array.isArray(h) ? h : [];
  }

  /* Called whenever a game is put away. Keyed on gameId so archiving the same
     game twice -- once when it is won, again when a new one starts -- updates
     the record rather than duplicating it. */
  function archiveGame(g){
    if(!g || !g.started || !g.rounds.length || !g.gameId) return;
    var rec = {
      id: g.gameId,
      at: Date.now(),
      target: g.target,
      rounds: g.rounds.length,
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
    var best = rec.players.reduce(function(m, p){ return Math.max(m, p.total); }, -Infinity);
    var winners = rec.players.filter(function(p){ return p.total === best; });
    /* A draw is a draw. Crediting the first name in the roster invented a win
       that never happened, permanently, on every device at the table. */
    rec.winners = winners.map(function(p){ return p.name; });
    rec.winner = winners.length === 1 ? winners[0].name : null;
    rec.tied = winners.length > 1;
    var h = history().filter(function(x){ return x.id !== rec.id; });
    h.unshift(rec);
    put(HIST_KEY, h.slice(0, 50));
  }

  /* Roll every archived game up per player name. */
  function lifetime(){
    var by = {};
    history().forEach(function(g){
      g.players.forEach(function(p){
        var e = by[p.name] || (by[p.name] = {name:p.name, games:0, wins:0, ties:0, best:0, busts:0, flip7s:0, points:0, rounds:0});
        e.games++;
        if(g.winner === p.name) e.wins++;
        else if(g.tied && (g.winners || []).indexOf(p.name) >= 0) e.ties++;
        if(p.best > e.best) e.best = p.best;
        e.busts += p.busts;
        e.flip7s += p.flip7s;
        e.points += p.total;
        e.rounds += g.rounds;
      });
    });
    return Object.keys(by).map(function(k){ return by[k]; })
      .sort(function(a, b){ return b.wins - a.wins || b.games - a.games; });
  }

  /* ---------- who am I in this game ----------
     The answers all live in view.js, which knows nothing about the DOM and so
     can be tested; these are the adapters that hand it what it needs. */
  function viewer(){
    return {room:ui.room, you:link.you, hostId:link.hostId, seats:link.seats,
            present:link.present, mode:ui.mode, seat:ui.seat};
  }
  function networked(){ return V.networked(viewer()); }
  function isHost(){ return V.isHost(viewer()); }
  function mySeat(){ return V.mySeat(viewer()); }
  function actor(){ return V.actor(viewer()); }

  /* ---------- the one way state changes ---------- */
  function dispatch(action){
    /* An optimistic edit with nowhere to send it looks accepted, then vanishes
       when the next broadcast arrives. Say so instead of losing it quietly. */
    if(networked() && !net.isOnline()){
      notify("Not connected to the table — waiting to reconnect. Nothing is lost, but this change didn't go through.");
      return false;
    }
    var res = G.applyAction(state, action, actor());
    if(!res.ok){ notify(res.error); return false; }
    state = res.state;                       // optimistic; the server may correct us
    if(networked()) net.send({t:"action", action:action});
    saveGame();
    render();
    return true;
  }

  /* One persistent live region whose TEXT changes, rather than a fresh node each
     render. Rebuilding it made assistive tech re-announce the same message on
     every card tap anyone at the table made. */
  var toastEl = null;
  function paintToast(){
    if(!toastEl){
      toastEl = el("div",{class:"toast", role:"status", "aria-live":"polite"},[
        el("span",{class:"ico", text:"⚠", "aria-hidden":"true"}),
        el("span",{class:"toast-text"}),
        el("button",{class:"toast-x", type:"button", "aria-label":"Dismiss",
          onclick:function(){ ui.notice = null; render(); }},[el("span",{text:"×"})])
      ]);
      document.body.appendChild(toastEl);
    }
    var span = toastEl.querySelector(".toast-text");
    var next = ui.notice || "";
    if(span.textContent !== next) span.textContent = next;
    toastEl.style.display = next ? "" : "none";
  }

  function notify(msg){
    ui.notice = msg;
    clearTimeout(notify._t);
    /* Draw it now. It used to rely on some later re-render happening to appear,
       so a message from a path that just returns -- a bad room code, say -- was
       set and never shown. */
    if(!notify._drawing){
      notify._drawing = true;
      try { render(); } finally { notify._drawing = false; }
    }
    /* Long enough to read a sentence, and dismissible either way. */
    notify._t = setTimeout(function(){ ui.notice = null; render(); }, 8000);
  }

  /* ---------- convenience wrappers over the rules core ---------- */
  function totalFor(pid){ return G.totalFor(state, pid); }
  function flip7Holder(exceptId){ return G.flip7Holder(state, exceptId); }
  function roundConflicts(){ return G.roundConflicts(state); }
  function numCap(e){ return G.numCap(e); }
  function tapeSteps(e){ return G.tapeSteps(e); }
  function openRound(){ return G.openRound(state); }
  function editingRound(){ return V.editingRound(state); }
  function entryFor(pid){ return openRound()[pid] || blankEntry(); }
  function editEntry(pid, mutate){
    var e = G.clone(entryFor(pid));
    mutate(e);
    dispatch({t:"setEntry", pid:pid, entry:e});
  }

  /* ---------- dom helper ---------- */
  function el(tag, attrs, kids){
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function(k){
      var v = attrs[k];
      if(v === null || v === false || v === undefined) return;
      if(k === "class") n.className = v;
      else if(k === "text") n.textContent = v;
      else if(k.slice(0,2) === "on") n.addEventListener(k.slice(2), v);
      else if(v === true) n.setAttribute(k, "");
      else n.setAttribute(k, v);
    });
    (kids || []).forEach(function(c){
      if(c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  function clear(n){ while(n.firstChild) n.removeChild(n.firstChild); }
  function reducedMotion(){
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function toTop(){ window.scrollTo({top:0, behavior: reducedMotion() ? "auto" : "smooth"}); }

  /* The floating scoreboard is showing only while the standings it stands in
     for are off the top of the screen. Every render rebuilds it, so it is built
     already in its last state -- otherwise each tap would replay the slide-in --
     and checked again once the page is whole: measuring mid-draw, with the
     view half rebuilt, could pull the scroll position up with it. */
  var floatShown = false;
  function syncScoreFloat(){
    var f = document.querySelector(".scorefloat");
    var s = document.querySelector(".standings");
    if(!f || !s || typeof s.getBoundingClientRect !== "function"){ floatShown = false; return; }
    floatShown = s.getBoundingClientRect().bottom < 0;
    var cls = "scorefloat" + (floatShown ? " show" : "");
    if(f.className !== cls) f.className = cls;
  }
  window.addEventListener("scroll", syncScoreFloat, {passive:true});
  window.addEventListener("resize", syncScoreFloat);
  function rounds(n){ return n + (n === 1 ? " round" : " rounds"); }

  /* ---------- focus survives the re-render ---------- */
  var focusNext = null;
  function activeKey(){
    var a = document.activeElement;
    return a && a.getAttribute ? a.getAttribute("data-fk") : null;
  }
  function restoreFocus(key){
    if(!key) return;
    var t = document.querySelector('[data-fk="' + key.replace(/["\\]/g, "") + '"]');
    if(!t || typeof t.focus !== "function") return;
    try { t.focus({preventScroll:true}); } catch(e){ t.focus(); }
  }

  /* ---------- dialogs (sandboxes block native confirm()) ---------- */
  var overlayEl = null;
  var focusBeforeDialog = null;
  function setBackgroundInert(on){
    [".app", ".commitbar"].forEach(function(sel){
      var n = document.querySelector(sel);
      if(!n) return;
      if(on){ n.setAttribute("aria-hidden", "true"); try { n.inert = true; } catch(e){} }
      else { n.removeAttribute("aria-hidden"); try { n.inert = false; } catch(e){} }
    });
  }
  function closeDialog(reopening){
    if(overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
    setBackgroundInert(false);
    document.removeEventListener("keydown", onDialogKey);
    if(reopening) return;                 // another dialog is taking its place
    /* Put the keyboard back where it came from, not at the top of the page. */
    var back = focusBeforeDialog;
    focusBeforeDialog = null;
    if(back && document.contains(back) && typeof back.focus === "function"){
      try { back.focus({preventScroll:true}); } catch(e){ back.focus(); }
    } else if(back && back.getAttribute){
      restoreFocus(back.getAttribute("data-fk"));
    }
  }
  function focusablesIn(root){
    return root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])');
  }
  function trapTab(ev){
    var f = focusablesIn(overlayEl);
    if(!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if(!overlayEl.contains(document.activeElement)){ ev.preventDefault(); first.focus(); }
    else if(ev.shiftKey && document.activeElement === first){ ev.preventDefault(); last.focus(); }
    else if(!ev.shiftKey && document.activeElement === last){ ev.preventDefault(); first.focus(); }
  }
  function onDialogKey(ev){
    if(!overlayEl) return;
    if(ev.key === "Escape"){ ev.preventDefault(); closeDialog(); }
    else if(ev.key === "Tab"){ trapTab(ev); }
  }
  function openDialog(title, body, actions, focusEl){
    var opener = document.activeElement;
    /* A dialog that reopens over itself must keep the anchor from outside it,
       not adopt a button that is about to be destroyed. */
    var keep = (overlayEl && overlayEl.contains(opener)) ? focusBeforeDialog : null;
    closeDialog(true);
    focusBeforeDialog = keep || ((opener && opener !== document.body && !document.querySelector(".overlay")) ? opener : keep);
    overlayEl = el("div",{class:"overlay", role:"dialog", "aria-modal":"true", "aria-label":title,
      onclick:function(ev){ if(ev.target === overlayEl) closeDialog(); }
    },[
      el("div",{class:"dialog"},[
        el("h2",{text:title}),
        el("div",{class:"dialog-scroll"}, body),
        el("div",{class:"dialog-actions"}, actions)
      ])
    ]);
    document.body.appendChild(overlayEl);
    setBackgroundInert(true);
    document.addEventListener("keydown", onDialogKey);
    if(focusEl) focusEl.focus();
  }
  function askConfirm(title, message, confirmLabel, onYes){
    var yes = el("button",{class:"btn btn-solid", type:"button",
      onclick:function(){ closeDialog(); onYes(); }},[el("span",{text:confirmLabel})]);
    var no = el("button",{class:"btn", type:"button", onclick:closeDialog},[el("span",{text:"Cancel"})]);
    openDialog(title, [el("p",{text:message})], [no, yes], yes);
  }

  /* ---------- card odds ---------- */
  function oddsRow(label, pipText, pipClass, count, maxCount){
    var pct = (count / DECK_SIZE) * 100;
    return el("div",{class:"odds-row"},[
      el("span",{class:"odds-name"},[
        el("span",{class:"odds-pip" + (pipClass ? " " + pipClass : ""), text:pipText, "aria-hidden":"true"}),
        el("span",{text:label})
      ]),
      el("span",{class:"odds-bar" + (pipClass ? " " + pipClass : "")},[
        el("i",{style:"width:" + Math.max(3, (count / maxCount) * 100) + "%"})
      ]),
      el("span",{class:"odds-val"},[
        el("b",{text:count + "/" + DECK_SIZE}),
        el("span",{text:"  " + pct.toFixed(1) + "%"})
      ])
    ]);
  }
  function showOdds(){
    var body = [];
    body.push(el("p",{class:"odds-note",
      text:"Your chance of drawing each card on the very first flip of a shuffled " + DECK_SIZE +
           "-card deck. The bigger a number is, the more copies exist — which is exactly what makes it dangerous to chase."}));
    var nums = el("div",{class:"odds-group"},[el("h3",{text:"Number cards"})]);
    for(var n = 0; n <= 12; n++){
      nums.appendChild(oddsRow(n === 0 ? "ZERO — no points" : NUM_WORDS[n], String(n), "", copiesOf(n), 12));
    }
    body.push(nums);
    var mods = el("div",{class:"odds-group"},[el("h3",{text:"Score modifiers"})]);
    MODS.forEach(function(m){ mods.appendChild(oddsRow("+" + m, "+", "mod", 1, 12)); });
    mods.appendChild(oddsRow("×2", "×", "x2", 1, 12));
    body.push(mods);
    var acts = el("div",{class:"odds-group"},[el("h3",{text:"Action cards"})]);
    ACTIONS.forEach(function(a){ acts.appendChild(oddsRow(a.name, "!", "act", a.count, 12)); });
    body.push(acts);

    var numTotal = 0;
    for(var k = 0; k <= 12; k++) numTotal += copiesOf(k);
    var actTotal = ACTIONS.reduce(function(t, a){ return t + a.count; }, 0);
    var modTotal = MODS.length + 1;
    body.push(el("div",{class:"odds-group"},[
      el("h3",{text:"By type"}),
      el("div",{class:"odds-total"},[el("span",{text:"Any number card"}),
        el("span",{text:numTotal + "/" + DECK_SIZE + "  ·  " + ((numTotal / DECK_SIZE) * 100).toFixed(1) + "%"})]),
      el("div",{class:"odds-total"},[el("span",{text:"Any action card"}),
        el("span",{text:actTotal + "/" + DECK_SIZE + "  ·  " + ((actTotal / DECK_SIZE) * 100).toFixed(1) + "%"})]),
      el("div",{class:"odds-total"},[el("span",{text:"Any score modifier"}),
        el("span",{text:modTotal + "/" + DECK_SIZE + "  ·  " + ((modTotal / DECK_SIZE) * 100).toFixed(1) + "%"})])
    ]));
    body.push(el("p",{class:"odds-note",
      text:"These shift with every card that comes out — the rules put it plainly: keep the card count in mind."}));
    var close = el("button",{class:"btn", type:"button", onclick:closeDialog},[el("span",{text:"Close"})]);
    openDialog("Card odds off a fresh deck", body, [close], close);
  }

  function showAbout(){
    var body = [
      el("p",{text:"Flip 7 is a game by Eric Olsen, published by The Op (USAopoly, Inc.), © 2025. Scoring here follows ruleset edition 3.1."}),
      el("a",{class:"btn-link", href:RULES_URL, target:"_blank", rel:"noopener noreferrer"},
        [el("span",{text:"Read the official rules"}), el("span",{text:"↗"})]),
      el("p",{text:"This scorekeeper is an unofficial fan-made tool. It isn't affiliated with, endorsed by, or licensed by The Op or USAopoly — please support the game by buying a copy."}),
      el("p",{text:"Played on one device this page needs no network at all — even the type is built in — and your scores never leave the device. Playing together sends the scorecard to whichever relay server you point it at, and nothing else."}),
      el("a",{class:"btn-link", href:REPO_URL, target:"_blank", rel:"noopener noreferrer"},
        [el("span",{text:"Source code on GitLab"}), el("span",{text:"↗"})]),
      el("p",{text:"Free, and staying that way. If it has saved your table some arithmetic, you can buy me a coffee — though buy the game first."}),
      el("a",{class:"btn-link coffee", href:COFFEE_URL, target:"_blank", rel:"noopener noreferrer"},
        [el("span",{text:"☕", "aria-hidden":"true"}), el("span",{text:"Buy me a coffee"}), el("span",{text:"↗"})])
    ];
    var close = el("button",{class:"btn", type:"button", onclick:closeDialog},[el("span",{text:"Close"})]);
    openDialog("About this scorekeeper", body, [close], close);
  }

  function creditLine(){
    return el("footer",{class:"credit"},[
      el("span",{text:"Flip 7 is a game by "}),
      el("strong",{text:"Eric Olsen"}),
      el("span",{text:", published by The Op. This is an unofficial scorekeeper — "}),
      el("a",{href:RULES_URL, target:"_blank", rel:"noopener noreferrer", text:"official rules"}),
      el("span",{text:" · "}),
      el("a",{href:REPO_URL, target:"_blank", rel:"noopener noreferrer", text:"source on GitLab"}),
      el("span",{text:" · "}),
      el("a",{href:COFFEE_URL, target:"_blank", rel:"noopener noreferrer", text:"buy me a coffee"})
    ]);
  }

  function showStats(){
    var games = history();
    if(!games.length){
      var closeE = el("button",{class:"btn", type:"button", onclick:closeDialog},[el("span",{text:"Close"})]);
      openDialog("Table record", [el("p",{text:"Nothing here yet. Finish a game and it lands in this list — wins, best rounds, and how often each of you busts."})], [closeE], closeE);
      return;
    }
    var body = [];
    var totals = lifetime();

    var table = el("div",{class:"stats"});
    table.appendChild(el("div",{class:"stats-row stats-head"},[
      el("span",{text:"Player"}), el("span",{text:"Won"}), el("span",{text:"Best"}),
      el("span",{text:"Flip 7s"}), el("span",{text:"Bust"}), el("span",{text:"Avg"})
    ]));
    totals.forEach(function(p){
      var bustPct = p.rounds ? Math.round((p.busts / p.rounds) * 100) : 0;
      var avg = p.rounds ? Math.round(p.points / p.rounds) : 0;
      table.appendChild(el("div",{class:"stats-row"},[
        el("span",{class:"stats-name", text:p.name}),
        el("span",{},[el("b",{text:String(p.wins)}),
          p.ties ? el("span",{class:"of", text:"+" + p.ties + "t"}) : null,
          el("span",{class:"of", text:"/" + p.games})]),
        el("span",{text:String(p.best)}),
        el("span",{text: p.flip7s ? "★ " + p.flip7s : "–"}),
        el("span",{text:bustPct + "%"}),
        el("span",{text:String(avg)})
      ]));
    });
    body.push(el("div",{class:"odds-group"},[el("h3",{text:"Across " + games.length + (games.length === 1 ? " game" : " games")}), table]));

    var recent = el("div",{class:"stats-games"});
    games.slice(0, 8).forEach(function(g){
      var line = g.players.slice().sort(function(a, b){ return b.total - a.total; })
        .map(function(p){ return p.name + " " + p.total; }).join("  ·  ");
      recent.appendChild(el("div",{class:"stats-game"},[
        el("div",{class:"stats-game-top"},[
          el("span",{class:"stats-winner", text: g.winner
            ? "★ " + g.winner
            : (g.winners && g.winners.length ? "= " + g.winners.join(" & ") + " tied" : "–")}),
          el("span",{class:"stats-meta", text:g.rounds + (g.rounds === 1 ? " round" : " rounds") + " · to " + g.target})
        ]),
        el("div",{class:"stats-line", text:line})
      ]));
    });
    body.push(el("div",{class:"odds-group"},[el("h3",{text:"Recent games"}), recent]));

    var wipe2 = el("button",{class:"btn btn-danger", type:"button", onclick:function(){
      closeDialog();
      askConfirm("Clear the table record?",
        "Every finished game on this device is deleted. Games in progress aren't touched.",
        "Clear it", function(){ drop(HIST_KEY); render(); });
    }},[el("span",{text:"Clear"})]);
    var close = el("button",{class:"btn", type:"button", onclick:closeDialog},[el("span",{text:"Close"})]);
    openDialog("Table record", body, [wipe2, close], close);
  }

  /* One menu rather than three buttons: a phone's top bar has room for what you
     press mid-game, not for reference material. */
  function referenceButtons(){
    return el("button",{class:"btn btn-quiet", type:"button", "data-fk":"more",
      title:"Record, card odds and credits", "aria-label":"More",
      onclick:showMore
    },[el("span",{text:"⋯"}), el("span",{text:"More"})]);
  }

  function showPlayers(){
    var list = el("div",{class:"lobby"});
    state.players.forEach(function(p){
      var box = el("input",{type:"text", value:p.name, maxlength:"18",
        "aria-label":"Name for " + p.name,
        onchange:function(ev){
          var v = ev.target.value.trim();
          /* Compare against the CURRENT name, not the one captured when this row
             was drawn -- otherwise correcting a name back to its original was
             silently dropped and the editor showed a name the game did not hold. */
          var live = state.players.filter(function(x){ return x.id === p.id; })[0];
          if(!live){ showPlayers(); return; }
          if(v && v !== live.name){ dispatch({t:"renamePlayer", pid:p.id, name:v}); showPlayers(); }
          else { ev.target.value = live.name; }
        }});
      list.appendChild(el("div",{class:"lobby-row"},[
        box,
        el("div",{class:"lobby-actions"},[
          state.players.length > 1 ? el("button",{class:"remove-seat", type:"button",
            title:"Remove " + p.name, "aria-label":"Remove " + p.name,
            onclick:function(){
              askConfirm("Remove " + p.name + "?",
                "Their scores from rounds already played are removed with them.",
                "Remove", function(){ dispatch({t:"removePlayer", pid:p.id}); showPlayers(); });
            }},[el("span",{text:"×"})]) : null
        ])
      ]));
    });
    var add = el("input",{type:"text", placeholder:"Add someone", maxlength:"18",
      "aria-label":"Name of a player to add",
      onkeydown:function(ev){
        if(ev.key !== "Enter") return;
        ev.preventDefault();
        addPending(true);
      }});
    /* Done is the same trap the lobby had: a name left in the box is one the
       host typed and never got, so take it before the dialog goes. */
    function addPending(redraw){
      var v = add.value.trim();
      if(!v) return true;
      var went = dispatch({t:"addPlayer", name:v});
      if(went && redraw) showPlayers();
      return went;
    }
    var body = [
      el("p",{text:"Fix a spelling, or change who's at the table. Scores already recorded stay with each player."}),
      list,
      el("div",{class:"lobby-add"},[add,
        el("button",{class:"btn", type:"button", onclick:function(){ addPending(true); }},
          [el("span",{text:"+"}), el("span",{text:"Add"})])])
    ];
    var close = el("button",{class:"btn", type:"button",
      onclick:function(){ if(addPending(false)) closeDialog(); }},[el("span",{text:"Done"})]);
    openDialog("Players", body, [close], close);
  }

  function showMore(){
    var items = [];
    if(history().length) items.push(["☷", "Table record", "Wins, best rounds and bust rates", showStats]);
    if(state.started && isHost()){
      items.push(["✎", "Players", "Fix a name, or add and remove people", showPlayers]);
    }
    items.push(["⌷", "Card odds", "What you're likely to draw from a fresh deck", showOdds]);
    items.push(["ⓘ", "About", "Credits, the official rules, and the source", showAbout]);
    var list = el("div",{class:"menu"});
    items.forEach(function(it){
      list.appendChild(el("button",{class:"menu-item", type:"button", onclick:function(){
        closeDialog(); it[3]();
      }},[
        el("span",{class:"menu-ico", text:it[0], "aria-hidden":"true"}),
        el("span",{},[
          el("span",{class:"menu-name", text:it[1]}),
          el("span",{class:"menu-sub", text:it[2]})
        ])
      ]));
    });
    var close = el("button",{class:"btn", type:"button", onclick:closeDialog},[el("span",{text:"Close"})]);
    openDialog("More", [list], [close], close);
  }

  /* ---------- render ---------- */
  var view = document.getElementById("view");
  var bar = document.getElementById("topbar-actions");
  var commitbar = null;

  function render(){
    var key = focusNext || activeKey();
    focusNext = null;
    try { draw(); }
    catch(err){ drawCrash(err); return; }
    saveGame(); savePrefs();
    if(overlayEl) setBackgroundInert(true);   // the commit bar was just rebuilt
    syncScoreFloat();
    restoreFocus(key);
  }

  function draw(){
    clear(view); clear(bar);
    if(commitbar && commitbar.parentNode) commitbar.parentNode.removeChild(commitbar);
    commitbar = null;

    paintToast();
    if(ui.screen === "launch") renderLaunch();
    else if(ui.screen === "setup") renderSetup();
    else if(ui.screen === "together") renderTogether();
    else renderGame();
  }

  function drawCrash(err){
    clear(view); clear(bar);
    if(commitbar && commitbar.parentNode) commitbar.parentNode.removeChild(commitbar);
    commitbar = null;
    view.appendChild(el("section",{class:"panel setup"},[
      el("h1",{text:"That saved game wouldn't open"}),
      el("p",{class:"lede",text:"Starting over clears it and gets you back to the table. Nothing else on your device is touched."}),
      el("p",{class:"lede", style:"font-size:.75rem;opacity:.8", text:String((err && err.message) || err)}),
      el("button",{class:"btn btn-primary", type:"button", style:"justify-self:start", onclick:function(){
        drop(GAME_KEY);
        state = G.newGame(); seats = ["",""]; ui.screen = "launch"; leaveRoom(true);
        render();
      }},[el("span",{text:"Start over"})])
    ]));
  }

  /* ----- launch ----- */
  function renderLaunch(){
    bar.appendChild(referenceButtons());
    checkResumable();
    var resumable = state.started && state.players.length;

    view.appendChild(el("section",{class:"panel setup"},[
      el("div",{},[
        el("h1",{text:"How are you keeping score?"}),
        el("p",{class:"lede",text:"Tap the cards in front of each player at the end of a round and the scoring is handled for you."})
      ]),
      attribution(),
      el("div",{class:"choices"},[
        el("button",{class:"choice", type:"button", "data-fk":"solo", onclick:function(){
          ui.screen = state.started ? "game" : "setup"; render();
        }},[
          el("span",{class:"choice-ico", text:"▤", "aria-hidden":"true"}),
          el("span",{class:"choice-name", text:"Just this device"}),
          el("span",{class:"choice-sub", text:"One phone goes round the table, or one person keeps score. Works offline, nothing leaves the device."})
        ]),
        el("button",{class:"choice", type:"button", "data-fk":"together", onclick:function(){
          ui.screen = "together"; render();
        }},[
          el("span",{class:"choice-ico", text:"⇄", "aria-hidden":"true"}),
          el("span",{class:"choice-name", text:"Play together"}),
          el("span",{class:"choice-sub", text:"Everyone joins on their own phone with a room code, enters their own cards and watches the leaderboard live."})
        ])
      ]),
      installPrompt ? el("div",{class:"install-row"},[
        el("span",{class:"install-text", text:"Add this to your home screen and it opens like an app, and keeps working with no signal."}),
        installButton()
      ]) : null,
      ui.resume ? el("div",{class:"resume-room"},[
        el("div",{},[
          el("div",{class:"resume-head"},[
            el("span",{class:"room-code", text:ui.resume.code}),
            ui.resume.info.you.host ? el("span",{class:"role-pill", text:"★ YOU HOSTED"}) : null,
            ui.resume.info.you.seatName ? el("span",{class:"role-pill seat", text:ui.resume.info.you.seatName}) : null
          ]),
          el("p",{class:"resume-sub", text:
            ui.resume.info.players + (ui.resume.info.players === 1 ? " player" : " players") +
            " · " + (ui.resume.info.rounds ? "round " + (ui.resume.info.rounds + 1) : "not started yet") +
            " · still going"})
        ]),
        el("button",{class:"btn btn-primary", type:"button", "data-fk":"resume",
          onclick:function(){ joinRoom(ui.resume.code); }
        },[el("span",{text:"Rejoin"}), el("span",{text:"→"})])
      ]) : null,
      resumable ? el("p",{class:"resume-note"},[
        el("span",{text:"You have a game in progress on this device — "}),
        el("button",{class:"linkish", type:"button", onclick:function(){ ui.screen = "game"; render(); }},
          [el("span",{text:"pick it back up"})]),
        el("span",{text:", or "}),
        /* Without this the choice above is the only way in, and it resumes: a
           started game made the roster screen unreachable from anywhere. */
        el("button",{class:"linkish", type:"button", "data-fk":"reseat", onclick:toSetup},
          [el("span",{text:"change who's playing"})]),
        el("span",{text:"."})
      ]) : null
    ]));
    view.appendChild(rulesKey());
    view.appendChild(creditLine());
  }

  function attribution(){
    return el("p",{class:"attrib"},[
      el("span",{text:"Keeping score for "}),
      el("strong",{text:"Flip 7"}),
      el("span",{text:", a game by "}),
      el("strong",{text:"Eric Olsen"}),
      el("span",{text:", published by The Op. This is an unofficial fan-made scorekeeper — "}),
      el("a",{href:RULES_URL, target:"_blank", rel:"noopener noreferrer", text:"official rules ↗"})
    ]);
  }

  /* ----- solo setup ----- */
  function renderSetup(){
    bar.appendChild(backButton("launch"));
    bar.appendChild(referenceButtons());
    if(seats.length < 2) seats = ["",""];

    var inputs = el("div",{class:"player-inputs"});
    function drawSeats(focusLast){
      clear(inputs);
      seats.forEach(function(name, i){
        var input = el("input",{
          type:"text", value:name, placeholder:"Player " + (i + 1),
          "aria-label":"Name of player " + (i + 1), maxlength:"18",
          "data-fk":"seatname:" + i,
          oninput:function(ev){ seats[i] = ev.target.value; },
          onkeydown:function(ev){ if(ev.key === "Enter"){ ev.preventDefault(); start(); } }
        });
        inputs.appendChild(el("div",{class:"player-input"},[
          el("span",{class:"seat", text:String(i + 1)}),
          input,
          seats.length > 2 ? el("button",{
            class:"remove-seat", type:"button", title:"Remove this player",
            "aria-label":"Remove player " + (i + 1),
            onclick:function(){ seats.splice(i, 1); drawSeats(); }
          },[el("span",{text:"×"})]) : null
        ]));
      });
      if(focusLast){
        var all = inputs.querySelectorAll("input");
        if(all.length) all[all.length - 1].focus();
      }
    }
    drawSeats();

    function start(){
      var names = seats.map(function(s, i){ return (s || "").trim() || "Player " + (i + 1); });
      function go(){
        archiveGame(state);        // a no-op unless there is a scored game to keep
        if(dispatch({t:"startGame", names:names, gameId:freshGameId()})){
          ui.screen = "game"; ui.collapsed = {}; ui.seat = 0; render();
        }
      }
      /* This screen is reachable mid-game now, so it can no longer assume there
         is nothing to lose. */
      if(state.started && state.rounds.length){
        askConfirm("Clear the game in progress?",
          "Everything scored so far is kept in your table record first, then this table takes over.",
          "Start scoring", go);
      } else go();
    }

    view.appendChild(el("section",{class:"panel setup"},[
      el("div",{},[
        el("h1",{text:"Who's at the table?"}),
        el("p",{class:"lede",text:"Add everyone playing. At the end of each round, tap the cards sitting in front of each player."})
      ]),
      attribution(),
      state.started && state.rounds.length ? el("p",{class:"resume-note"},[
        el("span",{text:"Starting here clears the game in progress — " + rounds(state.rounds.length) +
                        ", kept in your table record first. Nothing goes until you start scoring, so "}),
        el("button",{class:"linkish", type:"button", onclick:function(){ ui.screen = "game"; render(); }},
          [el("span",{text:"go back to it"})]),
        el("span",{text:" if you only came to look."})
      ]) : null,
      inputs,
      el("div",{class:"setup-foot"},[
        el("button",{class:"btn", type:"button", onclick:function(){
          if(seats.length < 12){ seats.push(""); drawSeats(true); }
        }},[el("span",{text:"+"}), el("span",{text:"Add player"})]),
        el("label",{class:"target-field"},[
          el("span",{text:"Play to"}),
          el("input",{
            type:"number", min:"1", step:"5", value:String(state.target),
            "aria-label":"Points needed to win",
            oninput:function(ev){ var v = parseInt(ev.target.value, 10); if(v > 0) state.target = v; }
          }),
          el("span",{text:"points"})
        ])
      ]),
      el("button",{class:"btn btn-primary", type:"button", onclick:start, style:"justify-self:start"},
        [el("span",{text:"Start scoring"})])
    ]));
    view.appendChild(rulesKey());
    view.appendChild(creditLine());
  }

  /* The roster screen, holding whoever is at the table now. Looking costs
     nothing: the game in progress is only cleared if you go on to start
     scoring a new one. */
  function toSetup(){
    seats = state.players.length ? state.players.map(function(p){ return p.name; }) : ["",""];
    ui.screen = "setup";
    render();
    toTop();
  }

  function backButton(to){
    return el("button",{class:"btn btn-quiet", type:"button", "data-fk":"back-screen",
      onclick:function(){
        /* Backing out of a join that never landed used to leave ui.room set, so
           the app stayed "networked": solo edits were refused as offline and
           saveGame() silently did nothing. */
        if(ui.room && !link.you) leaveRoom(true);
        ui.screen = to;
        render();
      }
    },[el("span",{text:"←"}), el("span",{text:"Back"})]);
  }

  /* ----- play together ----- */
  function renderTogether(){
    bar.appendChild(backButton("launch"));
    bar.appendChild(referenceButtons());

    var relayField = el("input",{
      type:"url", value:prefs.relay, placeholder:"https://flip7-relay.your-name.workers.dev",
      "aria-label":"Relay server address", "data-fk":"relay",
      oninput:function(ev){ prefs.relay = ev.target.value.trim(); savePrefs(); }
    });
    var codeField = el("input",{
      type:"text", value:ui.pendingRoom || "", placeholder:"ABCD", maxlength:"4",
      "aria-label":"Room code", "data-fk":"code", autocapitalize:"characters", spellcheck:"false",
      oninput:function(ev){ ui.pendingRoom = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""); ev.target.value = ui.pendingRoom; },
      onkeydown:function(ev){ if(ev.key === "Enter"){ ev.preventDefault(); doJoin(); } }
    });
    var nameField = el("input",{
      type:"text", value:prefs.name, placeholder:"Your name", maxlength:"18",
      "aria-label":"Your name", "data-fk":"myname",
      oninput:function(ev){ prefs.name = ev.target.value; savePrefs(); }
    });

    function needRelay(){
      if(prefs.relay) return false;
      notify("Add a relay server address first — see the About panel for how to run one.");
      return true;
    }
    function doCreate(){
      if(needRelay()) return;
      ui.busy = "Creating a room…"; render();
      ensureNet().createRoom(prefs.relay).then(function(code){
        ui.busy = null; joinRoom(code);
      }).catch(function(err){
        ui.busy = null; notify(err.message || "Couldn't reach that relay."); render();
      });
    }
    function doJoin(){
      if(needRelay()) return;
      var code = (ui.pendingRoom || "").toUpperCase();
      var problem = codeProblem(code);
      if(problem){ notify(problem); return; }
      joinRoom(code);
    }

    if(ui.foreignRelay){
      view.appendChild(el("div",{class:"alert", role:"alert"},[
        el("span",{class:"ico", text:"⚠", "aria-hidden":"true"}),
        el("div",{},[
          el("h3",{text:"That link points somewhere else"}),
          el("ul",{},[el("li",{text:"It wants to send your game to " + relayHost(ui.foreignRelay) +
            ", not " + (relayHost(prefs.relay) || relayHost(RELAY_URL) || "the relay you normally use") +
            ". Only continue if you know whose server that is."})]),
          el("div",{class:"together-actions", style:"margin-top:.6rem"},[
            el("button",{class:"btn", type:"button", onclick:function(){
              prefs.relay = ui.foreignRelay; ui.foreignRelay = null; savePrefs(); render();
            }},[el("span",{text:"Use it anyway"})]),
            el("button",{class:"btn btn-primary", type:"button", onclick:function(){
              ui.foreignRelay = null; render();
            }},[el("span",{text:"Stay on the usual relay"})])
          ])
        ])
      ]));
    }

    view.appendChild(el("section",{class:"panel setup"},[
      el("div",{},[
        el("h1",{text:"Play together"}),
        el("p",{class:"lede",text:"One person starts a room and reads out the code. Everyone else joins, takes a seat, and enters their own cards — the leaderboard updates for the whole table at once."})
      ]),
      el("div",{class:"field"},[
        el("label",{class:"field-label", text:"Your name"}), nameField
      ]),
      /* With a relay baked into the build there is nothing to configure, so keep
         it out of the way unless someone wants their own. */
      (RELAY_URL && prefs.relay === RELAY_URL && !ui.showRelay)
        ? el("p",{class:"field-hint"},[
            el("span",{text:"Using the relay built into this copy ("}),
            el("strong",{text:relayHost(RELAY_URL)}),
            el("span",{text:"). "}),
            el("button",{class:"linkish", type:"button", onclick:function(){ ui.showRelay = true; render(); }},
              [el("span",{text:"Use a different one"})])
          ])
        : el("div",{class:"field"},[
        el("label",{class:"field-label", text:"Relay server"}),
        relayField,
        RELAY_URL ? el("button",{class:"linkish", type:"button", style:"justify-self:start;font-size:.76rem",
          onclick:function(){ prefs.relay = RELAY_URL; ui.showRelay = false; savePrefs(); render(); }},
          [el("span",{text:"Back to the built-in relay"})]) : null,
        el("p",{class:"field-hint"},[
          el("span",{text:"The little server that passes the scorecard between phones. Deploy your own in a couple of minutes — "}),
          el("a",{href:REPO_URL + "/-/tree/main/server", target:"_blank", rel:"noopener noreferrer", text:"instructions ↗"}),
          el("span",{text:" — then paste its address here. It's remembered on this device."})
        ])
      ]),
      ui.busy ? el("p",{class:"field-hint", text:ui.busy}) : null,
      /* Joining changed nothing on screen until the welcome arrived, so a wrong
         code or a cold relay looked exactly like the app having died. */
      (ui.room && link.status !== "online") ? el("p",{class:"joining conn conn-" + link.status},[
        el("span",{class:"dot", text: link.status === "failed" ? "✗" : "◐", "aria-hidden":"true"}),
        el("span",{text: link.status === "failed"
          ? (link.detail || "Can't reach the relay.") + " Check the code and the address."
          : "Connecting to " + ui.room + "…"})
      ]) : null,
      el("div",{class:"together-actions"},[
        el("button",{class:"btn btn-primary", type:"button", "data-fk":"create", onclick:doCreate},
          [el("span",{text:"Start a room"})]),
        el("span",{class:"or", text:"or"}),
        el("div",{class:"join-row"},[codeField,
          el("button",{class:"btn", type:"button", "data-fk":"join", onclick:doJoin},[el("span",{text:"Join"})])
        ])
      ])
    ]));

    /* The way back in. A room outlives the evening it was made for -- a week, on
       the relay -- but the code only ever existed on the phones that used it, so
       leaving one used to strand it. No request is made to draw this: it is what
       this device remembers, and tapping a row is what finds out whether the
       room is still there. */
    var now = Date.now();
    var past = V.recentRooms(prefs.rooms, {now:now, relayHost:relayHost(prefs.relay)})
      .filter(function(r){ return r.code !== ui.room; });
    if(prefs.relay && past.length){
      view.appendChild(el("section",{class:"panel rooms-past"},[
        el("h2",{class:"rooms-past-head", text:"Rooms you've been in"}),
        el("p",{class:"field-hint", text:"A room stays on " + (relayHost(prefs.relay) || "the relay") +
          " for a week after its last round, so these are still open unless the table finished with them."}),
        el("ul",{class:"room-list"}, past.map(function(r){
          return el("li",{class:"room-row"},[
            el("div",{class:"room-row-main"},[
              el("span",{class:"room-code", text:r.code}),
              el("span",{class:"room-when", text:"last played " + V.roomAgeLabel(now - r.at, r.approx)})
            ]),
            el("button",{class:"btn", type:"button", "data-fk":"rejoin-" + r.code,
              onclick:function(){ joinRoom(r.code); }},
              [el("span",{text:"Rejoin"}), el("span",{text:"→"})])
          ]);
        }))
      ]));
    }
    view.appendChild(creditLine());
  }

  /* Offer a one-tap return without needing the link again. Keyed on this
     device's own id, which is stable and private -- unlike an IP, which the
     whole table shares and which would hand your room to anyone on the wifi. */
  function checkResumable(){
    if(!prefs.relay || ui.resumeChecked) return;
    var cand = V.resumeCandidate(prefs.rooms, {now:Date.now(), relayHost:relayHost(prefs.relay)});
    if(!cand) return;                     // older, or left on purpose: it's on the list instead
    ui.resumeChecked = true;
    var code = cand.code;
    var base = prefs.relay.replace(/\/+$/, "");
    if(!/^https?:/i.test(base)) base = "https://" + base;
    fetch(base + "/api/rooms/" + encodeURIComponent(code) + "/info?client=" + encodeURIComponent(prefs.clientId))
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(info){
        if(!info) return;
        if(!info.exists){ forgetRoom(code); render(); return; }
        if(!info.you) return;                            // we were never in it
        ui.resume = {code:code, info:info};
        render();
      })
      .catch(function(){ /* offline: just don't offer it */ });
  }



  function ensureNet(){
    if(net) return net;
    net = Flip7Net({
      onStatus:function(s, detail){
        link.status = s; link.detail = detail || null;
        /* Once we have stopped trying and never got in, stop pretending to be in
           a room. Otherwise the whole app is stuck in networked mode. */
        if(s === "failed" && !link.you){
          var why = detail || "Couldn't reach that room.";
          /* leaveRoom puts the local game back, which matters here: `state` may
             still hold a previous room's scorecard from a room hop, and the very
             next render would save it over the solo game. Quiet, because we were
             never in this room -- there is nothing to mark as left. */
          leaveRoom(true);
          ui.screen = "together";
          notify(why + " Check the code and the relay address.");
          return;
        }
        render();
      },
      onMessage:function(msg){
        if(msg.t === "welcome"){
          link.you = msg.you; link.hostId = msg.hostId;
          link.seats = msg.seats || {}; link.present = msg.present || []; link.people = msg.people || [];
          var s = G.normalize(msg.state); if(s) state = s;
          ui.screen = "game";
          /* Only now is this a room this device has been in. Recording it at the
             moment we asked to join would put every mistyped code on the list
             for a week, and re-dating it on each welcome keeps the entry pinned
             to the last time we were really here -- the same clock the relay
             measures its week from. */
          rememberRoom(ui.room);
          /* Claim the seat we held before, if it survived. */
          var mine = link.seats[link.you];
          if(mine && !state.players.some(function(p){ return p.id === mine; })) delete link.seats[link.you];
          render();
          return;
        }
        if(msg.t === "state"){
          var wasHost = link.you && link.you === link.hostId;
          link.hostId = msg.hostId; link.seats = msg.seats || {}; link.present = msg.present || [];
          link.people = msg.people || [];
          if(!wasHost && link.you && link.you === link.hostId){
            notify("You're the host now — you score the rounds.");
          }
          var s2 = G.normalize(msg.state); if(s2) state = s2;
          render();
          return;
        }
        if(msg.t === "reject"){
          var s3 = G.normalize(msg.state); if(s3) state = s3;   // roll back the optimistic edit
          link.seats = msg.seats || link.seats; link.hostId = msg.hostId || link.hostId;
          notify(msg.error || "The table didn't accept that.");
          render();
          return;
        }
        if(msg.t === "error"){ notify(msg.error || "Something went wrong."); render(); }
      }
    });
    return net;
  }

  /* ---------- the rooms this device can get back into ----------
     Which rooms to keep and which to offer is decided in view.js; these three
     are the writes. Every one of them re-normalises, so the stored list can only
     ever hold the shape the reader expects. */

  /* Called on every join, so an entry is dated by the last time this device was
     actually in the room -- the same clock the relay measures its week from. */
  function rememberRoom(code){
    var now = Date.now(), host = relayHost(prefs.relay);
    var list = V.normalizeRooms(prefs.rooms, {now:now, relayHost:host})
      .filter(function(r){ return !(r.code === code && r.relay === host); });
    list.unshift({code:code, at:now, relay:host, approx:false, left:false});
    prefs.rooms = V.normalizeRooms(list, {now:now, relayHost:host});
  }

  /* A deliberate exit is not "forget this room". The room is still on the relay
     for the rest of its week, and walking out of one used to be the one way to
     lose its code for good. Leaving only means: stop offering to drop me back in
     unasked. The code stays on the list, a tap away. */
  function markRoomLeft(code){
    var now = Date.now(), host = relayHost(prefs.relay);
    prefs.rooms = V.normalizeRooms(prefs.rooms, {now:now, relayHost:host})
      .map(function(r){
        if(r.code === code && r.relay === host) r.left = true;
        return r;
      });
  }

  /* The relay is the authority on whether a room still exists. When it says no,
     drop the code rather than leaving a dead row on the list. A relay we simply
     couldn't reach says nothing, and must not cost anyone their rooms. */
  function forgetRoom(code){
    var now = Date.now(), host = relayHost(prefs.relay);
    prefs.rooms = V.normalizeRooms(prefs.rooms, {now:now, relayHost:host})
      .filter(function(r){ return !(r.code === code && r.relay === host); });
    savePrefs();
  }

  function joinRoom(code){
    ui.room = code;
    ui.pendingRoom = code;
    /* The room is written down on welcome, not here -- see the handler. */
    ensureNet().connect(prefs.relay, code, prefs.clientId, prefs.name || "Player", secretFor(prefs.relay));
    render();
  }

  /* The local game is put back on every exit, quiet ones included: `state`
     outliving `ui.room` drops the app into solo mode still holding the room's
     scorecard, and the next render saves that over the solo game -- the room's
     game really would become yours.

     A deliberate exit always lands on the launch screen. Resuming a different
     game inside the same screen, which is what leaving used to do whenever a
     solo game happened to be saved, looked exactly like the room's scorecard
     turning into a solo one. */
  function leaveRoom(quiet){
    if(net) net.disconnect(true);
    if(!quiet && ui.room){
      markRoomLeft(ui.room);
      savePrefs();
    }
    ui.resume = null;
    ui.resumeChecked = false;
    ui.room = "";
    link = {you:null, hostId:null, seats:{}, present:[], people:[], status:"offline", detail:null};
    var saved = G.normalize(get(GAME_KEY));
    state = saved || G.newGame();
    seats = state.players.length ? state.players.map(function(p){ return p.name; }) : ["",""];
    if(quiet) return;
    ui.screen = "launch";
    /* Say where the game on screen went, and where the one now behind the solo
       choice came from. notify() draws, so this is the render. */
    if(state.started && state.rounds.length){
      notify("You've left the room. Your own game from before is still here — " +
             rounds(state.rounds.length) + " in.");
    } else {
      render();
    }
  }

  function roomLink(){
    var base = location.origin + location.pathname;
    var link = base + "#room=" + ui.room;
    /* Only carry the relay when it isn't the one this build already knows —
       a shorter link makes a denser QR far easier to scan. */
    if(prefs.relay && prefs.relay !== RELAY_URL) link += "&relay=" + encodeURIComponent(prefs.relay);
    return link;
  }

  function qrCanvas(text, px){
    var matrix;
    try { matrix = Flip7QR().encode(text); }
    catch(e){ return null; }
    var quiet = 4, n = matrix.length, total = n + quiet * 2;
    var scale = Math.max(2, Math.floor(px / total));
    var cv = document.createElement("canvas");
    cv.width = cv.height = total * scale;
    cv.className = "qr";
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", "QR code linking to room " + ui.room);
    var g = cv.getContext("2d");
    /* Always light-on-dark-free: scanners want a real quiet zone and hard
       black on white, whatever the page theme is doing. */
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = "#000000";
    for(var r = 0; r < n; r++){
      for(var c = 0; c < n; c++){
        if(matrix[r][c]) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return cv;
  }

  /* ----- the room bar ----- */
  function roomBar(){
    var statusText = {
      online:"Connected", connecting:"Connecting…", retrying:"Reconnecting…",
      failed:"Can't reach the relay", offline:"Offline"
    }[link.status] || link.status;

    var seated = mySeat();
    var me = seated && state.players.filter(function(p){ return p.id === seated; })[0];

    return el("div",{class:"roombar"},[
      el("div",{class:"roombar-main"},[
        el("span",{class:"room-label", text:"Room"}),
        el("span",{class:"room-code", text:ui.room}),
        el("span",{class:"conn conn-" + link.status},[
          el("span",{class:"dot", text: link.status === "online" ? "●" : link.status === "failed" ? "✗" : "◐", "aria-hidden":"true"}),
          el("span",{text:statusText})
        ]),
        isHost() ? el("span",{class:"role-pill", text:"★ HOST"}) : null,
        me ? el("span",{class:"role-pill seat", text:"SEAT · " + me.name}) : null
      ]),
      el("div",{class:"roombar-actions"},[
        el("button",{class:"btn btn-quiet", type:"button", "data-fk":"share", onclick:shareRoom},
          [el("span",{text:"⧉"}), el("span",{text:"Share"})]),
        isHost() && link.people.length > 1
          ? el("button",{class:"btn btn-quiet", type:"button", "data-fk":"passhost", onclick:showPassHost},
              [el("span",{text:"★"}), el("span",{text:"Pass host"})])
          : null,
        link.status === "failed" ? el("button",{class:"btn btn-quiet", type:"button",
          onclick:function(){ net.retryNow(); }},[el("span",{text:"Retry"})]) : null,
        el("button",{class:"btn btn-quiet", type:"button", "data-fk":"leave", onclick:function(){
          askConfirm("Leave this room?",
            "The game keeps going for everyone else, and you can rejoin with the same code. " +
            "This phone goes back to keeping score on its own.",
            "Leave room", function(){ leaveRoom(false); });
        }},[el("span",{text:"Leave"})])
      ])
    ]);
  }

  function showPassHost(){
    var others = link.people.filter(function(x){ return x.id !== link.you; });
    var body = [el("p",{text:"Whoever holds this scores the rounds. Hand it over if you're stepping away — if a host's phone drops out for good, the table promotes someone automatically after a minute or so."})];
    var list = el("div",{class:"lobby"});
    others.forEach(function(x){
      var seatPid = link.seats[x.id];
      var seat = seatPid && state.players.filter(function(p){ return p.id === seatPid; })[0];
      list.appendChild(el("div",{class:"lobby-row"},[
        el("span",{class:"lobby-name", text:x.name}),
        seat ? el("span",{class:"role-pill seat", text:seat.name}) : null,
        el("div",{class:"lobby-actions"},[
          el("button",{class:"btn", type:"button", onclick:function(){
            net.send({t:"passHost", to:x.id});
            closeDialog();
          }},[el("span",{text:"Make host"})])
        ])
      ]));
    });
    if(!others.length) list.appendChild(el("p",{class:"empty-note", text:"Nobody else is connected right now."}));
    body.push(list);
    var close = el("button",{class:"btn", type:"button", onclick:closeDialog},[el("span",{text:"Close"})]);
    openDialog("Pass the host role", body, [close], close);
  }

  function shareRoom(){
    var url = roomLink();
    var field = el("input",{type:"text", value:url, readonly:true, class:"share-field",
      "aria-label":"Link to this room", onclick:function(ev){ ev.target.select(); }});
    var qr = qrCanvas(url, 220);
    var body = [
      el("p",{text: qr
        ? "Point a camera at this, read out the code, or send the link — any of the three gets someone in."
        : "Read out the room code, or send this link."}),
      qr ? el("div",{class:"qr-wrap"},[qr]) : null,
      el("div",{class:"code-shout", text:ui.room}),
      field
    ];
    var copy = el("button",{class:"btn btn-solid", type:"button", onclick:function(){
      field.select();
      var done = false;
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(url).then(function(){ copy.textContent = "Copied"; },
          function(){ copy.textContent = "Select and copy"; });
        done = true;
      }
      if(!done){ try { document.execCommand("copy"); copy.textContent = "Copied"; }
                 catch(e){ copy.textContent = "Select and copy"; } }
    }},[el("span",{text:"Copy link"})]);
    var close = el("button",{class:"btn", type:"button", onclick:closeDialog},[el("span",{text:"Close"})]);
    openDialog("Invite the table", body, [close, copy], copy);
  }

  /* ----- lobby (networked, before the game starts) ----- */
  function renderLobby(){
    view.appendChild(roomBar());
    view.appendChild(el("div",{class:"section-head"},[
      el("h2",{text:"Take a seat"}),
      el("span",{class:"hint", text: isHost()
        ? "Add everyone playing, then start when the table's ready."
        : "Pick your name once the host has added it."})
    ]));

    var list = el("div",{class:"lobby"});
    state.players.forEach(function(p){
      var takenBy = Object.keys(link.seats).filter(function(cid){ return link.seats[cid] === p.id; })[0];
      var mine = takenBy === link.you;
      var occupied = takenBy && link.present.indexOf(takenBy) >= 0 && !mine;
      list.appendChild(el("div",{class:"lobby-row" + (mine ? " mine" : "")},[
        el("span",{class:"lobby-name", text:p.name}),
        occupied ? el("span",{class:"role-pill seat", text:"TAKEN"}) : null,
        mine ? el("span",{class:"role-pill seat", text:"● YOU"}) : null,
        el("div",{class:"lobby-actions"},[
          mine
            ? el("button",{class:"btn btn-quiet", type:"button", "data-fk":"release",
                onclick:function(){ focusNext = "claim:" + p.id; net.send({t:"releaseSeat"}); }},[el("span",{text:"Leave seat"})])
            : el("button",{class:"btn", type:"button", "data-fk":"claim:" + p.id, disabled: occupied || null,
                onclick:function(){ focusNext = "release"; net.send({t:"claimSeat", pid:p.id}); }},[el("span",{text:"That's me"})]),
          isHost() ? el("button",{class:"remove-seat", type:"button", title:"Remove " + p.name,
            "aria-label":"Remove " + p.name,
            onclick:function(){ dispatch({t:"removePlayer", pid:p.id}); }},[el("span",{text:"×"})]) : null
        ])
      ]));
    });
    if(!state.players.length){
      list.appendChild(el("p",{class:"empty-note", text: isHost()
        ? "No players yet — add everyone at the table below."
        : "The host hasn't added anyone yet."}));
    }
    view.appendChild(list);

    if(isHost()){
      var nameBox = el("input",{type:"text", placeholder:"Player name", maxlength:"18",
        "aria-label":"New player name", "data-fk":"newplayer",
        onkeydown:function(ev){
          if(ev.key === "Enter"){ ev.preventDefault(); addFromBox(true); }
        },
        oninput:function(){ syncStart(); }});
      /* A typed name is not a player until it is submitted, so anything that
         acts on the roster has to take the pending one off the box first.
         Otherwise the host types the last player, hits start, and that person
         is simply not in the game: the roster on screen and the roster the
         game began with were never the same list. */
      function addFromBox(keepFocus){
        var v = nameBox.value.trim();
        if(!v) return true;
        if(keepFocus) focusNext = "newplayer";
        return dispatch({t:"addPlayer", name:v});
      }
      view.appendChild(el("div",{class:"lobby-add"},[
        nameBox,
        el("button",{class:"btn", type:"button", onclick:function(){ addFromBox(true); }},
          [el("span",{text:"+"}), el("span",{text:"Add"})])
      ]));
      /* Same reason the box is flushed: with nobody added yet and a name typed,
         that name is the table, so the button cannot be dead. */
      var startBtn = el("button",{class:"btn btn-primary", type:"button",
        disabled: state.players.length < 1 || null,
        onclick:function(){
          if(!addFromBox()) return;      // refused -- say why, rather than start a player short
          dispatch({t:"beginGame", gameId:freshGameId()});
        }},[el("span",{text:"Start scoring"}), el("span",{text:"→"})]);
      function syncStart(){
        startBtn.disabled = state.players.length < 1 && !nameBox.value.trim();
      }
      view.appendChild(el("div",{class:"lobby-start"},[
        el("label",{class:"target-field"},[
          el("span",{text:"Play to"}),
          el("input",{type:"number", min:"1", step:"5", value:String(state.target),
            "aria-label":"Points needed to win", "data-fk":"target",
            onchange:function(ev){ dispatch({t:"setTarget", target:ev.target.value}); }}),
          el("span",{text:"points"})
        ]),
        startBtn
      ]));
    } else {
      view.appendChild(el("p",{class:"field-hint", text:"Waiting for the host to start the game."}));
    }
    view.appendChild(rulesKey());
    view.appendChild(creditLine());
  }

  /* A new game has two endings and only one of them used to be reachable: the
     same table plays again. The other -- a different set of people -- had no
     route at all, because the roster screen is behind a launch choice that
     resumes instead of asking once a game has started. */
  function askNewSoloGame(){
    var same = el("button",{class:"btn btn-solid", type:"button", onclick:function(){
      closeDialog();
      archiveGame(state);
      dispatch({t:"newGame", gameId:freshGameId()});
      toTop();
    }},[el("span",{text:"Same players"})]);
    var different = el("button",{class:"btn", type:"button", onclick:function(){
      closeDialog();
      toSetup();
    }},[el("span",{text:"Different players"})]);
    var cancel = el("button",{class:"btn", type:"button", onclick:closeDialog},[el("span",{text:"Cancel"})]);
    openDialog("Start a new game?", [
      el("p",{text:"Every round scored so far is cleared — it's kept in your table record first."}),
      el("p",{text:"Keep the same people at the table, or go back and say who's playing."})
    ], [cancel, different, same], same);
  }

  /* ----- game ----- */
  function renderGame(){
    if(networked() && !state.started){ bar.appendChild(referenceButtons()); renderLobby(); return; }

    if(!networked()){
      bar.appendChild(backButton("launch"));
      bar.appendChild(deleteRoundButton());
      bar.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"newgame",
        onclick:askNewSoloGame},[el("span",{text:"New game"})]));
    } else if(isHost()){
      bar.appendChild(deleteRoundButton());
      bar.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"newgame",
        onclick:function(){
          askConfirm("Start a new game?",
            "Everyone in this room goes back to round 1 with the same players. The finished game is kept in your record first.",
            "Clear and restart", function(){
              archiveGame(state);
              dispatch({t:"newGame", gameId:freshGameId()});
              toTop();
            });
        }},[el("span",{text:"New game"})]));
    }
    bar.appendChild(referenceButtons());

    if(networked()) view.appendChild(roomBar());

    /* Joining mid-game is normal — someone's phone died, or they arrived late.
       Without this they'd be stuck spectating with no way to take their seat. */
    if(networked() && !mySeat() && state.players.length){
      var pick = el("div",{class:"seatpick"},[
        el("div",{class:"seatpick-head"},[
          el("span",{class:"ico", text:"↴", "aria-hidden":"true"}),
          el("span",{text:"Which one are you? Take a seat to enter your own cards."})
        ])
      ]);
      var row = el("div",{class:"seats"});
      state.players.forEach(function(p){
        var takenBy = Object.keys(link.seats).filter(function(cid){ return link.seats[cid] === p.id; })[0];
        var occupied = takenBy && link.present.indexOf(takenBy) >= 0;
        row.appendChild(el("button",{class:"seat-chip", type:"button", "data-fk":"take:" + p.id,
          disabled: occupied || null,
          title: occupied ? p.name + " is already on another phone" : "Play as " + p.name,
          onclick:function(){ focusNext = "head:" + p.id; net.send({t:"claimSeat", pid:p.id}); }
        },[
          el("span",{text:p.name}),
          occupied ? el("span",{class:"sc", text:"taken"}) : null
        ]));
      });
      pick.appendChild(row);
      view.appendChild(pick);
    }

    var totals = {};
    state.players.forEach(function(p){ totals[p.id] = totalFor(p.id); });
    var best = state.players.length
      ? Math.max.apply(null, state.players.map(function(p){ return totals[p.id]; })) : 0;

    var overLine = state.players.filter(function(p){ return totals[p.id] >= state.target; });
    if(overLine.length) archiveGame(state);      // banked the moment it is won
    if(overLine.length && !state.dismissedWin){
      var top = state.players.filter(function(p){ return totals[p.id] === best; });
      view.appendChild(el("div",{class:"winner"},[
        el("span",{class:"crown", text:"★", "aria-hidden":"true"}),
        el("div",{},[
          el("h2",{text: top.length > 1
            ? top.map(function(p){ return p.name; }).join(" & ") + " are tied at " + best
            : top[0].name + " wins with " + best + " points"}),
          el("p",{text:"Someone crossed " + state.target + ", so the game ends here — most points takes it."})
        ]),
        isHost() ? el("button",{class:"btn", type:"button", onclick:function(){ dispatch({t:"dismissWin"}); }},
          [el("span",{text:"Keep playing"})]) : null
      ]));
    }

    view.appendChild(el("div",{class:"section-head"},[
      el("h2",{text:"Standings"}),
      isHost() ? el("label",{class:"target-inline"},[
        el("span",{text:"Race to"}),
        el("input",{type:"number", min:"1", step:"5", value:String(state.target), "data-fk":"target",
          "aria-label":"Points needed to win",
          onchange:function(ev){ dispatch({t:"setTarget", target:ev.target.value}); }})
      ]) : el("span",{class:"hint", text:"Race to " + state.target})
    ]));

    var ranked = V.standings(state);
    var stand = el("div",{class:"standings"});
    ranked.forEach(function(p){
      var t = p.total;
      var isLeader = p.leader;
      var online = networked() && Object.keys(link.seats).some(function(cid){
        return link.seats[cid] === p.id && link.present.indexOf(cid) >= 0;
      });
      stand.appendChild(el("div",{class:"stand" + (isLeader ? " leader" : "")},[
        el("div",{class:"stand-top"},[
          el("span",{class:"stand-name", text:p.name}),
          networked() ? el("span",{class:"here" + (online ? " on" : ""),
            title: online ? p.name + " is connected" : p.name + " isn't connected",
            text: online ? "●" : "○"}) : null,
          networked() && state.submitted[p.id] ? el("span",{class:"stand-in", title:p.name + " has submitted", text:"✓"}) : null,
          isLeader ? el("span",{class:"stand-mark", text:"▲ LEAD"}) : null,
          el("span",{class:"stand-total", text:String(t)})
        ]),
        el("div",{class:"stand-bar"},[
          el("i",{style:"width:" + Math.min(100, state.target ? (t / state.target) * 100 : 0) + "%"})
        ]),
        el("div",{class:"stand-sub", text: t >= state.target ? "Over the line" : (state.target - t) + " to go"})
      ]));
    });
    view.appendChild(stand);

    /* The same table, pinned to the top of the screen once the standings above
       have scrolled away -- entering cards further down shouldn't mean
       scrolling back up to see who's ahead. It repeats what the standings say,
       so it is kept out of the accessibility tree rather than read twice. */
    view.appendChild(el("div",{class:"scorefloat" + (floatShown ? " show" : ""), "aria-hidden":"true"},[
      el("div",{class:"scorefloat-inner"}, ranked.map(function(p){
        return el("span",{class:"sf-chip" + (p.leader ? " leader" : "")},[
          p.leader ? el("span",{class:"sf-mark", text:"▲"}) : null,
          el("span",{class:"sf-name", text:p.name}),
          el("span",{class:"sf-total", text:String(p.total)})
        ]);
      }).concat([el("span",{class:"sf-target", text:"to " + state.target})]))
    ]));

    var pass =editingRound() == null && !networked() && ui.mode === "pass";
    /* A seat index can outlive the player it pointed at, so pin it back into
       range before anything reads it. */
    ui.seat = V.clampSeat(ui.seat, state.players.length);
    var cbar = V.commitBar(viewer(), state);
    var roundNo = cbar.roundNo;

    var editIdx = editingRound();

    view.appendChild(el("div",{class:"section-head" + (editIdx != null ? " editing" : "")},[
      el("h2",{text: editIdx != null ? "Editing round " + roundNo : "Round " + roundNo}),
      el("span",{class:"hint", text: editIdx != null
          ? "Fixing a round that's already scored — every total updates as you go, and round " +
            cbar.liveNo + " is waiting where you left it"
        : liveMode() ? "Tap each card as it's flipped — the odds follow"
        : networked() ? "Enter your own cards"
        : pass ? "One player at a time" : "Tap each player's cards as the round ends"}),
      editIdx != null ? null : el("div",{class:"segmented", role:"group", "aria-label":"Scoring mode"},
        networked() ? [
          modeButton("table", "▤", "End of round"),
          modeButton("live", "%", "Live odds")
        ] : [
          modeButton("table", "▤", "Whole table"),
          modeButton("pass", "↝", "Pass the phone"),
          modeButton("live", "%", "Live odds")
        ])
    ]));
    if(liveMode()) view.appendChild(deckPanel());

    var conflicts = roundConflicts();
    if(conflicts.length){
      view.appendChild(el("div",{class:"alert", role:"status"},[
        el("span",{class:"ico", text:"⚠", "aria-hidden":"true"}),
        el("div",{},[
          el("h3",{text:"Check these cards"}),
          el("ul",{}, conflicts.map(function(c){ return el("li",{text:c}); }))
        ])
      ]));
    }

    var boards = el("div",{class:"boards" + (pass ? " solo" : "")});
    if(pass){
      var strip = el("div",{class:"seats"});
      state.players.forEach(function(p, i){
        var e = entryFor(p.id);
        var entered = !isEmpty(e);
        var isNow = i === ui.seat;
        var cls = "seat-chip";
        if(isNow) cls += " now";
        else if(entered) cls += " done" + (scoreOf(e) === 0 ? " zero" : "");
        strip.appendChild(el("button",{class:cls, type:"button", "data-fk":"seat:" + i,
          "aria-current": isNow ? "true" : null,
          "aria-label": isNow ? p.name + ", scoring now"
            : entered ? "Hand the phone to " + p.name + ", currently " +
                (e.bust ? "busted, nothing" : scoreOf(e) + " points")
            : "Hand the phone to " + p.name + ", nothing entered yet",
          onclick:function(){ ui.seat = i; render(); }
        },[
          el("span",{text:p.name}),
          isNow ? el("span",{class:"sc", text:"●", "aria-hidden":"true"})
            : entered ? el("span",{class:"sc", text: e.bust ? "✗ 0" : String(scoreOf(e))}) : null
        ]));
      });
      view.appendChild(strip);
      var who = state.players[ui.seat];
      view.appendChild(el("div",{class:"handoff"},[
        el("span",{text:"↝", "aria-hidden":"true"}),
        el("span",{},[
          el("span",{text:"Phone goes to "}), el("strong",{text:who.name}),
          el("span",{text:" — player " + (ui.seat + 1) + " of " + state.players.length})
        ])
      ]));
      boards.appendChild(playerBoard(who, totals[who.id], {forceOpen:true, collapsible:false}));
    } else {
      /* Networked: your own line opens first, and for the host so does every
         line with no phone behind it, since those are theirs to enter. */
      V.orderedPlayers(viewer(), state).forEach(function(p){
        boards.appendChild(playerBoard(p, totals[p.id],
          {forceOpen: V.boardOpen(viewer(), ui, p.id), collapsible:true}));
      });
    }
    view.appendChild(boards);

    view.appendChild(el("div",{class:"section-head"},[
      el("h2",{text:"Scorecard"}),
      el("span",{class:"hint", text: state.rounds.length + (state.rounds.length === 1 ? " round played" : " rounds played") +
        (isHost() && state.rounds.length ? " · tap one to go back and fix it" : "")})
    ]));
    view.appendChild(historyTable());
    view.appendChild(rulesKey());
    view.appendChild(creditLine());

    /* ----- commit bar -----
       What this bar is showing was decided up in V.commitBar(); everything here
       is turning that decision into elements and words. */
    var waiting = cbar.waiting, awaited = cbar.awaited;
    var inner = el("div",{class:"commitbar-inner"});

    if(cbar.canGoBack){
      inner.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"back",
        "aria-label":"Back to " + state.players[ui.seat - 1].name,
        onclick:function(){ ui.seat--; render(); toTop(); }
      },[el("span",{text:"←"})]));
    }

    inner.appendChild(el("div",{class:"commit-info"},[
      el("div",{class:"r", text: cbar.editing != null ? "Editing round " + roundNo : "Round " + roundNo}),
      cbar.expecting
        ? el("div",{class:"s" + (cbar.allIn ? " ready" : "")}, cbar.allIn
            ? [el("span",{text:"✓ "}), el("span",{text: awaited.length === 1 ? "They're in" : "All " + awaited.length + " are in"})]
            : [el("span",{text:(awaited.length - waiting.length) + " of " + awaited.length + " in · waiting on "}),
               el("strong",{text: waiting.slice(0, 3).map(function(p){ return p.name; }).join(", ") +
                 (waiting.length > 3 ? " +" + (waiting.length - 3) + " more" : "")})])
        : el("div",{class:"s", text: cbar.entered === 0 ? "No cards entered yet"
            : cbar.blank === 0 ? "All " + state.players.length + " players entered"
            : cbar.entered + " entered · " + cbar.blank + (cbar.blank === 1 ? " blank line scores 0" : " blank lines score 0")})
    ]));

    if(cbar.control === "advance"){
      inner.appendChild(el("button",{class:"btn btn-primary", type:"button", "data-fk":"advance",
        onclick:function(){ ui.seat++; render(); toTop(); }
      },[el("span",{text:"Hand to " + state.players[ui.seat + 1].name}), el("span",{text:"→"})]));
    } else if(cbar.control === "score"){
      inner.appendChild(el("button",{class:"btn btn-primary" + (cbar.expecting && !cbar.allIn ? " btn-wait" : ""),
        type:"button", "data-fk":"advance",
        disabled: cbar.disabled || null,
        onclick:function(){
          if(cbar.prompt === "early"){
            askConfirm("Score round " + roundNo + " early?",
              (waiting.length === 1 ? waiting[0].name + " hasn't" : waiting.map(function(p){ return p.name; }).join(", ") + " haven't") +
              " submitted yet. Scoring now takes whatever is on screen for them" +
              (waiting.some(function(p){ return isEmpty(entryFor(p.id)); }) ? ", which is nothing for anyone with a blank line." : "."),
              "Score it anyway", function(){ commitRound(true); });
          } else if(cbar.prompt === "zero"){
            /* Everyone scoring nothing is a real round -- all busted, or frozen
               before a number came out -- but it is also what an accidental tap
               looks like, so confirm rather than refuse. */
            askConfirm("Score round " + roundNo + " as all zeros?",
              "No cards are entered for anyone, so everyone takes 0 for this round. That's right if the whole table busted — otherwise go back and enter the cards.",
              "Everyone scored 0", function(){ commitRound(true); });
          } else { commitRound(); }
        }
      },[el("span",{text:"Score round " + roundNo}), el("span",{text:"→"})]));
    } else if(cbar.control === "done"){
      inner.appendChild(el("button",{class:"btn btn-primary", type:"button", "data-fk":"advance",
        onclick:function(){ closeEdit(); }
      },[el("span",{text:"Done — back to round " + cbar.liveNo}), el("span",{text:"→"})]));
    } else {
      inner.appendChild(el("span",{class:"waiting", text:
        cbar.watching === "hostediting" ? "The host is correcting round " + roundNo + "."
        : cbar.watching === "spectator" ? "Watching — take a seat above to enter cards."
        : cbar.watching === "submitted" ? "You're in. Waiting for the host to score the round."
        : "Submit your line when you're done."}));
    }

    commitbar = el("div",{class:"commitbar"},[inner]);
    document.body.appendChild(commitbar);
  }

  function modeButton(mode, icon, label){
    return el("button",{class: ui.mode === mode ? "on" : "", type:"button", "data-fk":"mode:" + mode,
      "aria-pressed": ui.mode === mode ? "true" : "false",
      onclick:function(){ ui.mode = mode; ui.seat = 0; savePrefs(); render(); }
    },[el("span",{class:"ic", text:icon, "aria-hidden":"true"}), el("span",{text:label})]);
  }

  /* ---------- live mode ----------
     Cards are tapped in as they are flipped, and each line shows its chances
     on the next one. It is a way of entering the live round, so a scored round
     being corrected always gets the plain picker. */
  function liveMode(){ return ui.mode === "live" && editingRound() == null; }
  function pct(x){
    var v = x * 100;
    return (v > 0 && v < 1 ? v.toFixed(1) : String(Math.round(v))) + "%";
  }
  function liveEdit(pid, next){
    dispatch({t:"setEntry", pid:pid, entry:next(entryFor(pid))});
  }

  function deckPanel(){
    var d = LV.deck(state);
    var notes = [];
    if(d.reshuffled) notes.push(el("li",{},[el("span",{class:"ico", text:"↻", "aria-hidden":"true"}),
      el("span",{text:"The deck ran out this round, so the discards were shuffled back in. Only the cards in front of players are out of it now."})]));
    if(d.over.length) notes.push(el("li",{class:"warn"},[el("span",{class:"ico", text:"⚠", "aria-hidden":"true"}),
      el("span",{text:"More " + d.over.map(kindName).join(", ") + " on the table than the deck holds — check for a mis-tap."})]));
    if(d.approx) notes.push(el("li",{},[el("span",{class:"ico", text:"≈", "aria-hidden":"true"}),
      el("span",{text:"Some lines since the last shuffle were entered at the end of the round, without their action cards or the duplicate they busted on — so the deck is a little smaller than this says."})]));
    return el("div",{class:"deck-panel", role:"status"},[
      el("div",{class:"deck-top"},[
        el("span",{class:"deck-left"},[el("b",{text:String(d.left)}), el("span",{text:" cards left in the deck"})]),
        el("span",{class:"deck-sub", text:d.seen + " out this round · " + d.pile + " set aside since the last shuffle"})
      ]),
      notes.length ? el("ul",{class:"deck-notes"}, notes) : null
    ]);
  }
  function kindName(key){
    if(key.charAt(0) === "n") return key.slice(1) + "s";
    if(key.charAt(0) === "m") return "+" + key.slice(1) + " cards";
    return {x2:"×2 cards", freeze:"Freezes", flip3:"Flip Threes", sc:"Second Chances"}[key] || key;
  }

  /* The short form in a board's header, readable when it is folded away. */
  function oddsPill(o){
    if(o.status === "frozen") return el("span",{class:"odds-pill frozen", text:"❄ FROZEN"});
    if(o.status !== "active" || !o.dupes && !o.protectedBy) return null;   // bust and Flip 7 show in the round chip
    if(o.protectedBy) return el("span",{class:"odds-pill safe",
      title:"Holding a Second Chance: a duplicate costs it, not the round", text:"♥ SAFE"});
    return el("span",{class:"odds-pill", title:"Chance the next card busts them", text:"▲ " + pct(o.bust)});
  }

  function oddsPanel(e, o){
    var lv = LV.liveOf(e);
    if(o.status === "bust"){
      return el("div",{class:"odds-panel out"},[el("p",{class:"odds-big"},[
        el("span",{class:"ico", text:"✗", "aria-hidden":"true"}),
        el("span",{text: lv.bustOn != null ? "Busted on a second " + lv.bustOn + " — scores 0" : "Busted — scores 0"})])]);
    }
    if(o.status === "flip7"){
      return el("div",{class:"odds-panel out"},[el("p",{class:"odds-big"},[
        el("span",{class:"ico", text:"★", "aria-hidden":"true"}), el("span",{text:"Flip 7 — the round ends here"})])]);
    }
    if(o.status === "frozen"){
      return el("div",{class:"odds-panel out"},[el("p",{class:"odds-big"},[
        el("span",{class:"ico", text:"❄", "aria-hidden":"true"}),
        el("span",{text:"Frozen — banks " + scoreOf(e) + " and is out of the round"})])]);
    }
    if(!o.left){
      return el("div",{class:"odds-panel"},[el("p",{class:"odds-sub", text:"No cards left to count from."})]);
    }
    if(!e.nums.length){
      return el("div",{class:"odds-panel"},[
        el("p",{class:"odds-sub", text:"No numbers yet, so the next card can't bust them. Flip 7 if they keep going " + pct(o.flip7) + "."}),
        o.flipsLeft ? el("p",{class:"odds-flip3"},[
          el("span",{class:"ico", text:"▶▶▶", "aria-hidden":"true"}),
          el("span",{text:"Flipping three: " + o.flipsLeft + " still to come · " + pct(o.survive) + " chance to get through them"})
        ]) : null
      ]);
    }
    var headline = o.protectedBy
      ? [el("span",{class:"odds-num", text:"0%"}),
         el("span",{class:"odds-cap", text:"bust risk — the Second Chance takes a duplicate (" + pct(o.hit) + " chance it gets used up)"})]
      : [el("span",{class:"odds-num", text:pct(o.bust)}),
         el("span",{class:"odds-cap", text:"chance the next card busts " + (o.dupes === 1 ? "them — 1 duplicate in " : "them — " + o.dupes + " duplicates in ") + o.left})];
    return el("div",{class:"odds-panel" + (o.protectedBy ? " protected" : "")},[
      el("p",{class:"odds-big"}, headline),
      el("div",{class:"risk-bar", "aria-hidden":"true"},[el("i",{style:"width:" + Math.min(100, (o.protectedBy ? o.hit : o.bust) * 100) + "%"})]),
      el("p",{class:"odds-sub"},[
        el("span",{text:"Safe " + pct(o.safe)}),
        el("span",{text:" · new number " + pct(o.fresh)}),
        el("span",{text:" · Flip 7 if they keep going " + pct(o.flip7)})
      ]),
      o.flipsLeft ? el("p",{class:"odds-flip3"},[
        el("span",{class:"ico", text:"▶▶▶", "aria-hidden":"true"}),
        el("span",{text:"Flipping three: " + o.flipsLeft + " still to come · " + pct(o.survive) + " chance to get through them"})
      ]) : null
    ]);
  }

  function liveBody(p, e, sc, cap, blockedBy, odds){
    var lv = LV.liveOf(e);

    var modRow = el("div",{class:"mod-row"});
    MODS.forEach(function(m){
      var on = e.mods.indexOf(m) >= 0;
      modRow.appendChild(el("button",{class:"card mod" + (on ? " on" : ""), type:"button",
        "data-fk":"mod:" + p.id + ":" + m,
        "aria-pressed": on ? "true" : "false", "aria-label":"Plus " + m + " bonus card",
        onclick:function(){ liveEdit(p.id, function(x){ return LV.tapMod(x, m); }); }
      },[
        el("span",{class:"tick", text:"✓", "aria-hidden":"true"}),
        el("span",{class:"glyph", text:"+" + m}),
        el("span",{class:"word", text:"BONUS"})
      ]));
    });
    modRow.appendChild(el("button",{class:"card mod x2" + (e.x2 ? " on" : ""), type:"button",
      "data-fk":"mod:" + p.id + ":x2",
      "aria-pressed": e.x2 ? "true" : "false", "aria-label":"Times two multiplier card",
      onclick:function(){ liveEdit(p.id, function(x){ return LV.tapX2(x); }); }
    },[
      el("span",{class:"tick", text:"✓", "aria-hidden":"true"}),
      el("span",{class:"glyph", text:"×2"}),
      el("span",{class:"word", text:"DOUBLE"})
    ]));

    /* Each number cycles: not out -> held (✓) -> busted on its duplicate (✗).
       With a Second Chance in hand, the duplicate is saved (♥) instead. */
    var numGrid = el("div",{class:"num-grid"});
    for(var n = 0; n <= 12; n++){
      (function(n){
        var st = LV.numState(e, n);
        var locked = st === "none" && e.nums.length >= cap;
        var next = st === "none" ? "held"
          : st === "bust" ? "cleared"
          : lv.sc ? "saved by the Second Chance" : "busted";
        numGrid.appendChild(el("button",{class:"card num live" + (st === "none" ? "" : " on " + st), type:"button",
          "data-fk":"num:" + p.id + ":" + n,
          disabled: locked || null,
          "aria-label": n + ", " + (st === "none" ? "not drawn" : st === "held" ? "held"
            : st === "saved" ? "held, a duplicate eaten by a Second Chance" : "busted on its duplicate") +
            ". Tap for " + next + ".",
          title: locked ? (e.bust ? "A busted line can't take another number"
            : blockedBy ? blockedBy.name + " already has the Flip 7 this round"
            : "Seven number cards is a Flip 7 — the line is full") : null,
          onclick:function(){ liveEdit(p.id, function(x){ return LV.tapNumber(x, n, cap); }); }
        },[
          el("span",{class:"tick", text: st === "bust" ? "✗" : st === "saved" ? "♥" : "✓", "aria-hidden":"true"}),
          el("span",{class:"glyph", text:String(n)}),
          el("span",{class:"word", text: st === "bust" ? "BUST" : st === "saved" ? "SAVED" : NUM_WORDS[n]})
        ]));
      })(n);
    }

    var acts = el("div",{class:"act-row"},[
      el("button",{class:"toggle act freeze" + (lv.freeze ? " on" : ""), type:"button", "data-fk":"freeze:" + p.id,
        "aria-pressed": lv.freeze ? "true" : "false",
        onclick:function(){ liveEdit(p.id, LV.tapFreeze); }
      },[el("span",{class:"act-ico", text:"❄", "aria-hidden":"true"}),
         el("span",{text: lv.freeze ? "Frozen" : "Freeze"})]),
      el("span",{class:"act-pair"},[
        el("button",{class:"toggle act flip3" + (lv.flip3 ? " on" : ""), type:"button", "data-fk":"flip3:" + p.id,
          disabled: lv.flip3 >= 3 || null,
          "aria-label": lv.flip3 ? "Flip Three, " + lv.flip3 + " received. Add another" : "Flip Three",
          onclick:function(){ liveEdit(p.id, LV.addFlip3); }
        },[el("span",{class:"act-ico", text:"▶▶▶", "aria-hidden":"true"}),
           el("span",{text: lv.flip3 > 1 ? "Flip Three ×" + lv.flip3 : "Flip Three"}),
           lv.f3left ? el("span",{class:"act-count", text:lv.f3left + " to go"}) : null]),
        lv.flip3 ? el("button",{class:"toggle act minus", type:"button", "data-fk":"flip3-:" + p.id,
          "aria-label":"Take back a Flip Three",
          onclick:function(){ liveEdit(p.id, LV.removeFlip3); }
        },[el("span",{text:"−"})]) : null
      ]),
      el("button",{class:"toggle act sc" + (lv.sc ? " on" : ""), type:"button", "data-fk":"sc:" + p.id,
        "aria-pressed": lv.sc ? "true" : "false",
        disabled: (!lv.sc && lv.scUsed.length >= 3) || null,
        onclick:function(){ liveEdit(p.id, LV.tapSecondChance); }
      },[el("span",{class:"act-ico", text:"♥", "aria-hidden":"true"}),
         el("span",{text: lv.sc ? "Second Chance — ready" : "Second Chance"})])
    ]);
    /* Spent ones stay on screen, saying what they were spent on. Tapping one
       takes the spend back. */
    lv.scUsed.forEach(function(n, i){
      acts.appendChild(el("button",{class:"toggle act sc spent", type:"button", "data-fk":"spent:" + p.id + ":" + i,
        "aria-label":"Second Chance, used on " + n + ". Tap to undo.",
        onclick:function(){ liveEdit(p.id, function(x){ return LV.unspend(x, n); }); }
      },[el("span",{class:"act-ico", text:"♥", "aria-hidden":"true"}),
         el("span",{text:"Second Chance — used on " + n})]));
    });

    /* The odds sit below everything tappable: they change size with every
       card, and above the grid that moved the next card out from under a
       finger. The header pill keeps the headline in view. */
    return el("div",{class:"board-body"},[
      el("div",{class:"row-label"},[el("span",{text:"Score modifiers"})]),
      modRow,
      el("div",{class:"row-label"},[el("span",{text:"Number cards · " + e.nums.length + " of " + cap +
        (e.bust ? "" : " · tap a held one again to bust")})]),
      numGrid,
      blockedBy ? el("p",{class:"cap-note"},[el("span",{class:"ico", text:"ⓘ", "aria-hidden":"true"}),
        el("span",{text:blockedBy.name + " already has the Flip 7 this round, so this line stops at six."})]) : null,
      el("div",{class:"row-label"},[el("span",{text:"Action cards"})]),
      acts,
      oddsPanel(e, odds),
      scoreTape(e, sc),
      el("div",{class:"status-row"},[
        el("button",{class:"toggle clear", type:"button", "data-fk":"byhand:" + p.id,
          onclick:function(){ ui.byHand[p.id] = true; focusNext = "live:" + p.id; render(); }
        },[el("span",{text:"✎ Fix the score by hand"})]),
        isEmpty(e) && !LV.cardsOf(e).freeze && !LV.cardsOf(e).flip3 && !LV.cardsOf(e).sc ? null
          : el("button",{class:"toggle clear", type:"button", "data-fk":"clear:" + p.id,
              onclick:function(){ dispatch({t:"setEntry", pid:p.id, entry:blankEntry()}); }
            },[el("span",{text:"Clear line"})])
      ]),
      V.showSubmit(viewer(), state, p.id) ? submitButton(p, e, sc) : null
    ]);
  }

  function playerBoard(p, total, opts){
    opts = opts || {};
    var e = entryFor(p.id);
    var open = opts.forceOpen;
    var sc = scoreOf(e);
    var flip7 = !e.bust && e.nums.length === 7;
    var cap = numCap(e);
    var submitted = V.isSubmitted(viewer(), state, p.id);
    var editable = V.lineEditable(viewer(), state, p.id);

    var blockedBy = e.nums.length < 7 ? flip7Holder(p.id) : null;
    if(blockedBy) cap = Math.min(cap, 6);

    var chipClass = "round-chip";
    var chipText = "—";
    if(e.bust){ chipClass += " bust"; chipText = "✗ BUST  0"; }
    else if(flip7){ chipClass += " flip7"; chipText = "★ " + sc; }
    else if(!isEmpty(e)){ chipClass += " scored"; chipText = "+" + sc; }

    var odds = liveMode() ? LV.playerOdds(e, LV.deck(state).unseen) : null;

    var head = el(opts.collapsible ? "button" : "div",
      {class:"board-head", type: opts.collapsible ? "button" : null,
       "data-fk": opts.collapsible ? "head:" + p.id : null,
       "aria-expanded": opts.collapsible ? (open ? "true" : "false") : null,
       onclick: opts.collapsible ? function(){
         /* Lines that start open remember being folded; the rest are the one
            line you have expanded, so tapping another moves it. */
         if(V.openByDefault(viewer(), p.id)){
           if(open){ ui.collapsed[p.id] = true; }
           else { delete ui.collapsed[p.id]; }
         } else {
           ui.expanded = (ui.expanded === p.id) ? null : p.id;
         }
         render();
       } : null
    },[
      opts.collapsible ? el("span",{class:"chev", text:"❯", "aria-hidden":"true"}) : null,
      el("span",{class:"board-name", text:p.name}),
      networked() && p.id === mySeat() ? el("span",{class:"role-pill seat", text:"YOU"}) : null,
      submitted ? el("span",{class:"role-pill in", text:"✓ IN"}) : null,
      el("span",{class:"board-meta"},[
        odds ? oddsPill(odds) : null,
        el("span",{class:chipClass, text:chipText}),
        el("span",{class:"board-total", text:String(total)})
      ])
    ]);

    var board = el("div",{class:"board" + (open ? " open" : "") + (e.bust ? " is-bust" : "") +
      (editable ? "" : " readonly")},[head]);
    if(!open) return board;

    if(editable && odds && !ui.byHand[p.id]){
      board.appendChild(liveBody(p, e, sc, cap, blockedBy, odds));
      return board;
    }

    if(!editable){
      board.appendChild(el("div",{class:"board-body"},[
        odds ? oddsPanel(e, odds) : null,
        el("div",{class:"row-label"},[el("span",{text: submitted ? "Submitted" : "Their line"})]),
        readonlyLine(e),
        scoreTape(e, sc),
        V.showWithdraw(viewer(), state, p.id)
          ? el("div",{class:"status-row"},[
              el("button",{class:"toggle", type:"button", "data-fk":"withdraw:" + p.id,
                onclick:function(){ dispatch({t:"withdrawEntry", pid:p.id}); }
              },[el("span",{text:"↶"}), el("span",{text:"Change it"})])
            ])
          : null
      ]));
      return board;
    }

    var modRow = el("div",{class:"mod-row"});
    MODS.forEach(function(m){
      var on = e.mods.indexOf(m) >= 0;
      modRow.appendChild(el("button",{class:"card mod" + (on ? " on" : ""), type:"button",
        "data-fk":"mod:" + p.id + ":" + m,
        "aria-pressed": on ? "true" : "false", "aria-label":"Plus " + m + " bonus card",
        onclick:function(){
          editEntry(p.id, function(x){
            var i = x.mods.indexOf(m);
            if(i >= 0) x.mods.splice(i, 1); else x.mods.push(m);
          });
        }
      },[
        el("span",{class:"tick", text:"✓", "aria-hidden":"true"}),
        el("span",{class:"glyph", text:"+" + m}),
        el("span",{class:"word", text:"BONUS"})
      ]));
    });
    modRow.appendChild(el("button",{class:"card mod x2" + (e.x2 ? " on" : ""), type:"button",
      "data-fk":"mod:" + p.id + ":x2",
      "aria-pressed": e.x2 ? "true" : "false", "aria-label":"Times two multiplier card",
      onclick:function(){ editEntry(p.id, function(x){ x.x2 = !x.x2; }); }
    },[
      el("span",{class:"tick", text:"✓", "aria-hidden":"true"}),
      el("span",{class:"glyph", text:"×2"}),
      el("span",{class:"word", text:"DOUBLE"})
    ]));

    var numGrid = el("div",{class:"num-grid"});
    for(var n = 0; n <= 12; n++){
      (function(n){
        var on = e.nums.indexOf(n) >= 0;
        var locked = !on && e.nums.length >= cap;
        numGrid.appendChild(el("button",{class:"card num" + (on ? " on" : ""), type:"button",
          "data-fk":"num:" + p.id + ":" + n,
          disabled: locked || null, "aria-pressed": on ? "true" : "false",
          title: locked ? (e.bust
            ? "A busted line can't hold seven — the seventh unique card would have ended the round"
            : blockedBy
              ? blockedBy.name + " already has the Flip 7 this round, and it ends the round immediately — only one player can reach seven"
              : "Seven number cards is a Flip 7 — the line is full") : null,
          onclick:function(){
            editEntry(p.id, function(x){
              var i = x.nums.indexOf(n);
              if(i >= 0) x.nums.splice(i, 1);
              else if(x.nums.length < cap) x.nums.push(n);
              x.nums.sort(function(a, b){ return a - b; });
            });
          }
        },[
          el("span",{class:"tick", text:"✓", "aria-hidden":"true"}),
          el("span",{class:"glyph", text:String(n)}),
          el("span",{class:"word", text:NUM_WORDS[n]})
        ]));
      })(n);
    }

    var bustBlocked = e.nums.length === 7 && !e.bust;
    var status = el("div",{class:"status-row"},[
      el("button",{class:"toggle bust" + (e.bust ? " on" : ""), type:"button", "data-fk":"bust:" + p.id,
        "aria-pressed": e.bust ? "true" : "false",
        disabled: bustBlocked || null,
        title: bustBlocked ? "Seven unique number cards is a Flip 7 — the round ends before anyone can bust" : null,
        onclick:function(){ editEntry(p.id, function(x){ x.bust = !x.bust; }); }
      },[el("span",{text:"✗"}), el("span",{text: e.bust ? "Busted — scores 0" : "Mark busted"})]),
      flip7 ? el("span",{class:"flag"},[el("span",{text:"★"}), el("span",{text:"Flip 7  +15"})]) : null,
      liveMode() ? el("button",{class:"toggle clear", type:"button", "data-fk":"live:" + p.id,
        onclick:function(){ delete ui.byHand[p.id]; focusNext = "byhand:" + p.id; render(); }
      },[el("span",{text:"% Back to live cards"})]) : null,
      isEmpty(e) ? null : el("button",{class:"toggle clear", type:"button", "data-fk":"clear:" + p.id,
        onclick:function(){
          focusNext = "bust:" + p.id;
          dispatch({t:"setEntry", pid:p.id, entry:blankEntry()});
        }},[el("span",{text:"Clear line"})])
    ]);

    var capNote = null;
    if(e.bust){
      capNote = "A busted line stops at six — a seventh unique card would have ended the round before the duplicate turned up.";
    } else if(blockedBy){
      capNote = blockedBy.name + " already has the Flip 7 this round. It ends the round the moment it happens, so this line stops at six.";
    }

    board.appendChild(el("div",{class:"board-body"},[
      el("div",{class:"row-label"},[el("span",{text:"Score modifiers"})]),
      modRow,
      el("div",{class:"row-label"},[el("span",{text:"Number cards · " + e.nums.length + " of " + cap})]),
      numGrid,
      capNote ? el("p",{class:"cap-note"},[
        el("span",{class:"ico", text:"ⓘ", "aria-hidden":"true"}), el("span",{text:capNote})
      ]) : null,
      status,
      scoreTape(e, sc),
      V.showSubmit(viewer(), state, p.id) ? submitButton(p, e, sc) : null
    ]));
    return board;
  }

  function submitButton(p, e, sc){
    return el("button",{class:"btn btn-primary submit-line", type:"button",
      "data-fk":"submit:" + p.id,
      onclick:function(){ dispatch({t:"submitEntry", pid:p.id}); }
    },[el("span",{text: p.id === mySeat()
      ? (isEmpty(e) ? "✓  Submit — I scored nothing" : "✓  Submit " + sc + " points")
      : (isEmpty(e) ? "✓  Mark " + p.name + " in — scored nothing" : "✓  Mark " + p.name + " in — " + sc + " points")})]);
  }

  /* A read-only rendering of someone else's line. */
  function readonlyLine(e){
    var wrap = el("div",{class:"ro-line"});
    if(isEmpty(e)){
      wrap.appendChild(el("span",{class:"ro-empty", text:"Nothing entered yet"}));
      return wrap;
    }
    e.nums.forEach(function(n){
      wrap.appendChild(el("span",{class:"ro-card num", text:String(n)}));
    });
    e.mods.forEach(function(m){
      wrap.appendChild(el("span",{class:"ro-card mod", text:"+" + m}));
    });
    if(e.x2) wrap.appendChild(el("span",{class:"ro-card x2", text:"×2"}));
    if(e.bust) wrap.appendChild(el("span",{class:"ro-card bust", text:"✗ BUST"}));
    return wrap;
  }

  function scoreTape(e, sc){
    var tape = el("div",{class:"tape"});
    if(e.bust){
      tape.appendChild(el("span",{class:"seg bust", text:"✗ BUSTED"}));
      tape.appendChild(el("span",{class:"seg muted", text:"everything in front of you scores nothing"}));
      tape.appendChild(el("span",{class:"seg total zero", text:"0"}));
      return tape;
    }
    var steps = tapeSteps(e);
    steps.forEach(function(st, i){
      tape.appendChild(el("span",{class:"seg" + (st.kind === "nums" ? "" : " " + st.kind), text:st.expr}));
      if(i < steps.length - 1){
        tape.appendChild(el("span",{class:"seg op", text:"="}));
        tape.appendChild(el("span",{class:"seg", text:String(st.val)}));
      }
    });
    tape.appendChild(el("span",{class:"seg op", text:"="}));
    tape.appendChild(el("span",{class:"seg total" + (sc === 0 ? " zero" : ""), text:String(sc)}));
    if(e.x2 && e.nums.length === 0){
      tape.appendChild(el("span",{class:"note",
        text:"A ×2 card on its own scores nothing — it doubles number cards, and there are none."}));
    }
    return tape;
  }

  function deleteRoundButton(){
    var idx = editingRound() == null ? state.rounds.length - 1 : editingRound();
    return el("button",{class:"btn btn-quiet", type:"button", "data-fk":"delete-round",
      title: idx < 0 ? "No round has been scored yet"
        : "Remove round " + (idx + 1) + " from the scorecard for good",
      onclick:deleteRound, disabled: idx < 0 || null
    },[el("span",{text:"✕"}),
       el("span",{text: idx < 0 ? "Delete round" : "Delete round " + (idx + 1)})]);
  }

  function historyTable(){
    var wrap = el("div",{class:"history-wrap"});
    if(!state.rounds.length){
      wrap.appendChild(el("p",{class:"empty-note",
        text:"No rounds scored yet. Enter everyone's cards above, then hit “Score round”."}));
      return wrap;
    }
    var t = el("table",{class:"history"});
    var head = el("tr",{},[el("th",{text:"Round"})]);
    state.players.forEach(function(p){ head.appendChild(el("th",{text:p.name})); });
    t.appendChild(el("thead",{},[head]));

    var tb = el("tbody");
    var rows = V.roundRows(viewer(), state);
    state.rounds.forEach(function(r, i){
      var row = rows[i];
      var name = "Round " + row.no;
      /* The round cell carries the whole target, so the sticky first column is
         the tap area and the scores stay selectable text. */
      var cell = row.selectable
        ? el("button",{class:"round-jump", type:"button", "data-fk":"round:" + i,
            title:"Go back and fix " + name.toLowerCase(),
            "aria-label":"Go back and fix " + name.toLowerCase(),
            onclick:function(){ askEditRound(i); }},[
              el("span",{text:name}),
              el("span",{class:"jump-mark", text:"✎", "aria-hidden":"true"})
            ])
        : row.editing
          ? el("span",{class:"round-jump static"},[
              el("span",{class:"jump-mark on", text:"✎", "aria-hidden":"true"}),
              el("span",{text:name}),
              el("span",{class:"jump-word", text:"EDITING"})
            ])
          /* A guest reads the scorecard; only the host reorganises it. */
          : el("span",{class:"round-jump static plain"},[el("span",{text:name})]);
      var tr = el("tr", row.editing ? {class:"editing"} : {}, [el("td",{class:"round-cell"},[cell])]);
      state.players.forEach(function(p){
        var e = r[p.id];
        var s = scoreOf(e);
        var cls = null, txt = String(s);
        if(e && e.bust){ cls = "cell-bust"; txt = "✗ 0"; }
        else if(e && e.nums.length === 7){ cls = "cell-flip7"; txt = "★ " + s; }
        tr.appendChild(el("td",{class:cls, text:txt}));
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);

    var tf = el("tr",{},[el("td",{text:"Total"})]);
    state.players.forEach(function(p){ tf.appendChild(el("td",{text:String(totalFor(p.id))})); });
    t.appendChild(el("tfoot",{},[tf]));
    wrap.appendChild(t);
    return wrap;
  }

  function rulesKey(){
    return el("details",{class:"key"},[
      el("summary",{},[el("span",{text:"How a round is scored"})]),
      el("ol",{},[
        el("li",{text:"Add up the value of the number cards in front of you."}),
        el("li",{text:"If you have the ×2 card, double that number-card total."}),
        el("li",{text:"Then add any +2 to +10 bonus cards."}),
        el("li",{text:"Seven unique number cards is a Flip 7 — add 15 more, and the round ends immediately."})
      ]),
      el("p",{class:"foot", text:"Bust and you score nothing that round, whatever is in front of you. Modifier cards can't bust you and don't count toward the seven. Freeze, Flip Three and Second Chance carry no points, so leave them out — unless you are in Live odds, where they count toward what is left in the deck."})
    ]);
  }

  /* ---------- actions ---------- */
  function commitRound(force){
    if(dispatch({t:"commitRound", force:!!force})){
      ui.collapsed = {}; ui.seat = 0; ui.expanded = null; ui.byHand = {};
      render(); toTop();
    }
  }

  /* Stepping into a scored round to correct it. Nothing is discarded on the way
     in or out, so the confirmation is here to say where you are going rather
     than to warn about losing anything. */
  function askEditRound(index){
    var no = index + 1;
    askConfirm("Edit round " + no + "?",
      "Round " + no + " is already scored. Change anyone's cards and every total updates — " +
      "the rounds after it keep their scores, and round " + (state.rounds.length + 1) +
      " is waiting where you left it.",
      "Edit round " + no, function(){ step({t:"editRound", index:index}); });
  }
  function closeEdit(){ step({t:"closeEdit"}); }

  /* Taking a round off the scorecard altogether -- scored by accident, or the
     table agreed it never happened. This is the one that loses cards, so it
     names the round it will take and points at editing as the gentler option. */
  function deleteRound(){
    var idx = editingRound() == null ? state.rounds.length - 1 : editingRound();
    if(idx < 0) return;
    var no = idx + 1, shifts = idx < state.rounds.length - 1;
    askConfirm("Delete round " + no + "?",
      "Round " + no + " comes off the scorecard for good" +
      (shifts ? ", and every round after it shifts down a number" : "") +
      ". The cards in it can't be brought back — to fix them instead, edit the round.",
      "Delete round " + no, function(){ step({t:"deleteRound", index:idx}); });
  }

  /* Any move between rounds: the folded/expanded boards and the pass-the-phone
     seat all belong to the round you were in, so none of them come with you. */
  function step(action){
    if(dispatch(action)){
      ui.collapsed = {}; ui.seat = 0; ui.expanded = null;
      render(); toTop();
    }
  }

  /* Install support. Only meaningful on a real origin: file:// and the sandboxed
     artifact have no service worker, and failing to register is not an error
     worth showing anyone. */
  (function registerWorker(){
    if(!("serviceWorker" in navigator)) return;
    if(location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("sw.js").catch(function(){ /* not deployed as a site */ });
    });
  })();

  /* Chrome offers installation through an event we have to hold on to. */
  var installPrompt = null;
  window.addEventListener("beforeinstallprompt", function(ev){
    ev.preventDefault();
    installPrompt = ev;
    render();
  });
  window.addEventListener("appinstalled", function(){ installPrompt = null; render(); });

  function installButton(){
    if(!installPrompt) return null;
    return el("button",{class:"btn", type:"button", "data-fk":"install",
      onclick:function(){
        var p = installPrompt;
        installPrompt = null;
        p.prompt();
        p.userChoice.then(function(){ render(); }).catch(function(){});
      }
    },[el("span",{text:"⬇"}), el("span",{text:"Install app"})]);
  }

  /* Rejoin automatically when a link carried a room code. */
  if(ui.screen === "together" && ui.pendingRoom && prefs.relay && !ui.foreignRelay){
    joinRoom(ui.pendingRoom);
  } else {
    render();
  }
})();
