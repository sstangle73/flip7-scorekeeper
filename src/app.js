(function(){
  "use strict";

  var G = Flip7Rules();
  var NUM_WORDS = G.NUM_WORDS, MODS = G.MODS, ACTIONS = G.ACTIONS, DECK_SIZE = G.DECK_SIZE;
  var copiesOf = G.copiesOf, blankEntry = G.blankEntry, isEmpty = G.isEmpty, scoreOf = G.scoreOf;

  var RULES_URL = "https://cdn.shopify.com/s/files/1/0611/3958/3198/files/25_FLIP_7_TB_RULES_C_Rev_9_2_25_ND.pdf?v=1756935535";
  var REPO_URL = "https://gitlab.com/sstangle73/flip7-scorekeeper";

  /* Bake a relay in here to skip the setup step for your own group. Left empty,
     the app is a standalone scorekeeper and never touches the network. */
  var RELAY_URL = "";

  var GAME_KEY = "flip7-scorekeeper-v1";
  var PREF_KEY = "flip7-prefs-v1";

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

  /* ---------- local, per-device state ---------- */
  var prefs = get(PREF_KEY) || {};
  if(typeof prefs !== "object" || !prefs) prefs = {};
  if(!prefs.clientId) prefs.clientId = "c" + Math.random().toString(36).slice(2, 12);
  if(typeof prefs.name !== "string") prefs.name = "";
  if(typeof prefs.relay !== "string") prefs.relay = RELAY_URL;
  if(prefs.mode !== "pass") prefs.mode = "table";

  var ui = {
    screen: "launch",       // launch | setup | together | game
    mode: prefs.mode,       // solo only: table | pass
    collapsed: {},
    seat: 0,
    room: "",
    busy: null,
    notice: null
  };

  var state = G.newGame();
  var seats = ["", ""];                    // solo setup screen name boxes
  var link = {you:null, hostId:null, seats:{}, present:[], status:"offline", detail:null};
  var net = null;

  /* Resume whatever was going on. A room in the URL wins over a saved game. */
  (function boot(){
    var saved = G.normalize(get(GAME_KEY));
    if(saved){
      state = saved;
      seats = state.players.length ? state.players.map(function(p){ return p.name; }) : ["",""];
      if(state.started) ui.screen = "game";
    }
    var q = parseLocator();
    if(q.relay) prefs.relay = q.relay;
    if(q.room){
      ui.screen = "together";
      ui.pendingRoom = q.room.toUpperCase();
    }
    savePrefs();
  })();

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

  /* ---------- who am I in this game ---------- */
  function networked(){ return !!ui.room; }
  function isHost(){ return !networked() || (link.you && link.you === link.hostId); }
  function mySeat(){ return networked() ? (link.seats[link.you] || null) : null; }
  function canEdit(pid){ return !networked() || isHost() || mySeat() === pid; }
  function actor(){ return {isHost:isHost(), seat:mySeat()}; }

  /* ---------- the one way state changes ---------- */
  function dispatch(action){
    var res = G.applyAction(state, action, actor());
    if(!res.ok){ notify(res.error); return false; }
    state = res.state;                       // optimistic; the server may correct us
    if(networked()) net.send({t:"action", action:action});
    saveGame();
    render();
    return true;
  }

  function notify(msg){
    ui.notice = msg;
    clearTimeout(notify._t);
    notify._t = setTimeout(function(){ ui.notice = null; render(); }, 4000);
  }

  /* ---------- convenience wrappers over the rules core ---------- */
  function totalFor(pid){ return G.totalFor(state, pid); }
  function flip7Holder(exceptId){ return G.flip7Holder(state, exceptId); }
  function roundConflicts(){ return G.roundConflicts(state); }
  function numCap(e){ return G.numCap(e); }
  function tapeSteps(e){ return G.tapeSteps(e); }
  function entryFor(pid){ return state.current[pid] || blankEntry(); }
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
  function setBackgroundInert(on){
    [".app", ".commitbar"].forEach(function(sel){
      var n = document.querySelector(sel);
      if(!n) return;
      if(on){ n.setAttribute("aria-hidden", "true"); try { n.inert = true; } catch(e){} }
      else { n.removeAttribute("aria-hidden"); try { n.inert = false; } catch(e){} }
    });
  }
  function closeDialog(){
    if(overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
    setBackgroundInert(false);
    document.removeEventListener("keydown", onDialogKey);
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
    closeDialog();
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
      el("p",{text:"Played on one device, everything stays on it: scores are saved in your browser and never sent anywhere. Playing together sends the scorecard to whichever relay server you point it at, and nothing else."}),
      el("a",{class:"btn-link", href:REPO_URL, target:"_blank", rel:"noopener noreferrer"},
        [el("span",{text:"Source code on GitLab"}), el("span",{text:"↗"})])
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
      el("a",{href:REPO_URL, target:"_blank", rel:"noopener noreferrer", text:"source on GitLab"})
    ]);
  }

  function referenceButtons(){
    var frag = document.createDocumentFragment();
    frag.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"odds",
      title:"Chance of drawing each card from a fresh deck", onclick:showOdds
    },[el("span",{text:"⌗"}), el("span",{text:"Odds"})]));
    frag.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"about",
      title:"Credits and the official rules", onclick:showAbout
    },[el("span",{text:"ⓘ"}), el("span",{text:"About"})]));
    return frag;
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
    restoreFocus(key);
  }

  function draw(){
    clear(view); clear(bar);
    if(commitbar && commitbar.parentNode) commitbar.parentNode.removeChild(commitbar);
    commitbar = null;
    if(ui.notice) view.appendChild(el("div",{class:"notice", role:"status"},[
      el("span",{text:"⚠", "aria-hidden":"true"}), el("span",{text:ui.notice})
    ]));
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
      resumable ? el("p",{class:"resume-note"},[
        el("span",{text:"You have a game in progress on this device — "}),
        el("button",{class:"linkish", type:"button", onclick:function(){ ui.screen = "game"; render(); }},
          [el("span",{text:"pick it back up"})]),
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
      if(dispatch({t:"startGame", names:names})){
        ui.screen = "game"; ui.collapsed = {}; ui.seat = 0; render();
      }
    }

    view.appendChild(el("section",{class:"panel setup"},[
      el("div",{},[
        el("h1",{text:"Who's at the table?"}),
        el("p",{class:"lede",text:"Add everyone playing. At the end of each round, tap the cards sitting in front of each player."})
      ]),
      attribution(),
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

  function backButton(to){
    return el("button",{class:"btn btn-quiet", type:"button", "data-fk":"back-screen",
      onclick:function(){ ui.screen = to; render(); }
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
      if(code.length !== 4){ notify("Room codes are four characters."); return; }
      joinRoom(code);
    }

    view.appendChild(el("section",{class:"panel setup"},[
      el("div",{},[
        el("h1",{text:"Play together"}),
        el("p",{class:"lede",text:"One person starts a room and reads out the code. Everyone else joins, takes a seat, and enters their own cards — the leaderboard updates for the whole table at once."})
      ]),
      el("div",{class:"field"},[
        el("label",{class:"field-label", text:"Your name"}), nameField
      ]),
      el("div",{class:"field"},[
        el("label",{class:"field-label", text:"Relay server"}),
        relayField,
        el("p",{class:"field-hint"},[
          el("span",{text:"The little server that passes the scorecard between phones. Deploy your own in a couple of minutes — "}),
          el("a",{href:REPO_URL + "/-/tree/main/server", target:"_blank", rel:"noopener noreferrer", text:"instructions ↗"}),
          el("span",{text:" — then paste its address here. It's remembered on this device."})
        ])
      ]),
      ui.busy ? el("p",{class:"field-hint", text:ui.busy}) : null,
      el("div",{class:"together-actions"},[
        el("button",{class:"btn btn-primary", type:"button", "data-fk":"create", onclick:doCreate},
          [el("span",{text:"Start a room"})]),
        el("span",{class:"or", text:"or"}),
        el("div",{class:"join-row"},[codeField,
          el("button",{class:"btn", type:"button", "data-fk":"join", onclick:doJoin},[el("span",{text:"Join"})])
        ])
      ])
    ]));
    view.appendChild(creditLine());
  }

  function ensureNet(){
    if(net) return net;
    net = Flip7Net({
      onStatus:function(s, detail){
        link.status = s; link.detail = detail || null;
        render();
      },
      onMessage:function(msg){
        if(msg.t === "welcome"){
          link.you = msg.you; link.hostId = msg.hostId;
          link.seats = msg.seats || {}; link.present = msg.present || [];
          var s = G.normalize(msg.state); if(s) state = s;
          ui.screen = "game";
          /* Claim the seat we held before, if it survived. */
          var mine = link.seats[link.you];
          if(mine && !state.players.some(function(p){ return p.id === mine; })) delete link.seats[link.you];
          render();
          return;
        }
        if(msg.t === "state"){
          link.hostId = msg.hostId; link.seats = msg.seats || {}; link.present = msg.present || [];
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

  function joinRoom(code){
    ui.room = code;
    ui.pendingRoom = code;
    prefs.lastRoom = code;
    savePrefs();
    ensureNet().connect(prefs.relay, code, prefs.clientId, prefs.name || "Player");
    render();
  }

  function leaveRoom(quiet){
    if(net) net.disconnect(true);
    ui.room = "";
    link = {you:null, hostId:null, seats:{}, present:[], status:"offline", detail:null};
    if(!quiet){
      /* Come back to whatever solo game was here before. */
      var saved = G.normalize(get(GAME_KEY));
      state = saved || G.newGame();
      ui.screen = state.started ? "game" : "launch";
      render();
    }
  }

  function roomLink(){
    var base = location.origin + location.pathname;
    return base + "#room=" + ui.room + "&relay=" + encodeURIComponent(prefs.relay);
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
        link.status === "failed" ? el("button",{class:"btn btn-quiet", type:"button",
          onclick:function(){ net.retryNow(); }},[el("span",{text:"Retry"})]) : null,
        el("button",{class:"btn btn-quiet", type:"button", "data-fk":"leave", onclick:function(){
          askConfirm("Leave this room?",
            "The game keeps going for everyone else, and you can rejoin with the same code.",
            "Leave room", function(){ leaveRoom(false); });
        }},[el("span",{text:"Leave"})])
      ])
    ]);
  }

  function shareRoom(){
    var url = roomLink();
    var field = el("input",{type:"text", value:url, readonly:true, class:"share-field",
      "aria-label":"Link to this room", onclick:function(ev){ ev.target.select(); }});
    var body = [
      el("p",{text:"Read out the room code, or send this link — it carries the code and the relay address."}),
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
                onclick:function(){ net.send({t:"releaseSeat"}); }},[el("span",{text:"Leave seat"})])
            : el("button",{class:"btn", type:"button", "data-fk":"claim:" + p.id, disabled: occupied || null,
                onclick:function(){ net.send({t:"claimSeat", pid:p.id}); }},[el("span",{text:"That's me"})]),
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
          if(ev.key === "Enter"){ ev.preventDefault(); addFromBox(); }
        }});
      function addFromBox(){
        var v = nameBox.value.trim();
        if(!v) return;
        focusNext = "newplayer";
        dispatch({t:"addPlayer", name:v});
      }
      view.appendChild(el("div",{class:"lobby-add"},[
        nameBox,
        el("button",{class:"btn", type:"button", onclick:addFromBox},[el("span",{text:"+"}), el("span",{text:"Add"})])
      ]));
      view.appendChild(el("div",{class:"lobby-start"},[
        el("label",{class:"target-field"},[
          el("span",{text:"Play to"}),
          el("input",{type:"number", min:"1", step:"5", value:String(state.target),
            "aria-label":"Points needed to win", "data-fk":"target",
            onchange:function(ev){ dispatch({t:"setTarget", target:ev.target.value}); }}),
          el("span",{text:"points"})
        ]),
        el("button",{class:"btn btn-primary", type:"button",
          disabled: state.players.length < 1 || null,
          onclick:function(){
            dispatch({t:"startGame", names:state.players.map(function(p){ return p.name; })});
          }},[el("span",{text:"Start scoring"}), el("span",{text:"→"})])
      ]));
    } else {
      view.appendChild(el("p",{class:"field-hint", text:"Waiting for the host to start the game."}));
    }
    view.appendChild(rulesKey());
    view.appendChild(creditLine());
  }

  /* ----- game ----- */
  function renderGame(){
    if(networked() && !state.started){ bar.appendChild(referenceButtons()); renderLobby(); return; }

    if(!networked()){
      bar.appendChild(backButton("launch"));
      bar.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"undo",
        title:"Undo the last scored round and reopen it for editing",
        onclick:undoRound, disabled: state.rounds.length === 0 || null
      },[el("span",{text:"↶"}), el("span",{text:"Undo round"})]));
      bar.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"newgame",
        onclick:function(){
          askConfirm("Start a new game?",
            "Every round scored so far is cleared. The same players stay at the table so you can go straight into round 1.",
            "Clear and restart", function(){ dispatch({t:"newGame"}); toTop(); });
        }},[el("span",{text:"New game"})]));
    } else if(isHost()){
      bar.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"undo",
        title:"Undo the last scored round and reopen it for editing",
        onclick:undoRound, disabled: state.rounds.length === 0 || null
      },[el("span",{text:"↶"}), el("span",{text:"Undo round"})]));
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
          onclick:function(){ net.send({t:"claimSeat", pid:p.id}); }
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

    var stand = el("div",{class:"standings"});
    state.players.slice().sort(function(a, b){ return totals[b.id] - totals[a.id]; }).forEach(function(p){
      var t = totals[p.id];
      var isLeader = t === best && best > 0;
      var online = networked() && Object.keys(link.seats).some(function(cid){
        return link.seats[cid] === p.id && link.present.indexOf(cid) >= 0;
      });
      stand.appendChild(el("div",{class:"stand" + (isLeader ? " leader" : "")},[
        el("div",{class:"stand-top"},[
          el("span",{class:"stand-name", text:p.name}),
          networked() ? el("span",{class:"here" + (online ? " on" : ""),
            title: online ? p.name + " is connected" : p.name + " isn't connected",
            text: online ? "●" : "○"}) : null,
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

    var roundNo = state.rounds.length + 1;
    var pass = !networked() && ui.mode === "pass";
    if(ui.seat > state.players.length - 1) ui.seat = Math.max(0, state.players.length - 1);
    if(ui.seat < 0) ui.seat = 0;

    view.appendChild(el("div",{class:"section-head"},[
      el("h2",{text:"Round " + roundNo}),
      el("span",{class:"hint", text: networked() ? "Enter your own cards"
        : pass ? "One player at a time" : "Tap each player's cards as the round ends"}),
      networked() ? null : el("div",{class:"segmented", role:"group", "aria-label":"Scoring mode"},[
        modeButton("table", "▤", "Whole table"),
        modeButton("pass", "↝", "Pass the phone")
      ])
    ]));

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
        var e = state.current[p.id];
        var entered = !isEmpty(e);
        var isNow = i === ui.seat;
        var cls = "seat-chip";
        if(isNow) cls += " now";
        else if(entered) cls += " done" + (scoreOf(e) === 0 ? " zero" : "");
        strip.appendChild(el("button",{class:cls, type:"button", "data-fk":"seat:" + i,
          "aria-current": isNow ? "true" : null,
          "aria-label": isNow ? p.name + ", scoring now" : "Hand the phone to " + p.name,
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
      /* Networked: your own line opens first and everyone else's folds away. */
      var ordered = state.players.slice();
      var seat = mySeat();
      if(seat) ordered.sort(function(a, b){ return (b.id === seat) - (a.id === seat); });
      ordered.forEach(function(p){
        var mine = !networked() || p.id === seat;
        var open = networked()
          ? (mine ? !ui.collapsed[p.id] : !!ui.expanded && ui.expanded === p.id)
          : !ui.collapsed[p.id];
        boards.appendChild(playerBoard(p, totals[p.id], {forceOpen:open, collapsible:true}));
      });
    }
    view.appendChild(boards);

    view.appendChild(el("div",{class:"section-head"},[
      el("h2",{text:"Scorecard"}),
      el("span",{class:"hint", text: state.rounds.length + (state.rounds.length === 1 ? " round played" : " rounds played")})
    ]));
    view.appendChild(historyTable());
    view.appendChild(rulesKey());
    view.appendChild(creditLine());

    /* ----- commit bar ----- */
    var entered = state.players.filter(function(p){ return !isEmpty(state.current[p.id]); }).length;
    var blank = state.players.length - entered;
    var inner = el("div",{class:"commitbar-inner"});

    if(pass && ui.seat > 0){
      inner.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"back",
        "aria-label":"Back to " + state.players[ui.seat - 1].name,
        onclick:function(){ ui.seat--; render(); toTop(); }
      },[el("span",{text:"←"})]));
    }
    inner.appendChild(el("div",{class:"commit-info"},[
      el("div",{class:"r", text:"Round " + roundNo}),
      el("div",{class:"s", text: entered === 0 ? "No cards entered yet"
        : blank === 0 ? "All " + state.players.length + " players entered"
        : entered + " entered · " + blank + (blank === 1 ? " blank line scores 0" : " blank lines score 0")})
    ]));

    var lastSeat = ui.seat >= state.players.length - 1;
    if(pass && !lastSeat){
      inner.appendChild(el("button",{class:"btn btn-primary", type:"button", "data-fk":"advance",
        onclick:function(){ ui.seat++; render(); toTop(); }
      },[el("span",{text:"Hand to " + state.players[ui.seat + 1].name}), el("span",{text:"→"})]));
    } else if(isHost()){
      inner.appendChild(el("button",{class:"btn btn-primary", type:"button", "data-fk":"advance",
        disabled: entered === 0 || null, onclick:commitRound
      },[el("span",{text:"Score round " + roundNo}), el("span",{text:"→"})]));
    } else {
      inner.appendChild(el("span",{class:"waiting", text:"Waiting for the host to score the round"}));
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

  function playerBoard(p, total, opts){
    opts = opts || {};
    var e = entryFor(p.id);
    var open = opts.forceOpen;
    var sc = scoreOf(e);
    var flip7 = !e.bust && e.nums.length === 7;
    var cap = numCap(e);
    var editable = canEdit(p.id);

    var blockedBy = e.nums.length < 7 ? flip7Holder(p.id) : null;
    if(blockedBy) cap = Math.min(cap, 6);

    var chipClass = "round-chip";
    var chipText = "—";
    if(e.bust){ chipClass += " bust"; chipText = "✗ BUST  0"; }
    else if(flip7){ chipClass += " flip7"; chipText = "★ " + sc; }
    else if(!isEmpty(e)){ chipClass += " scored"; chipText = "+" + sc; }

    var head = el(opts.collapsible ? "button" : "div",
      {class:"board-head", type: opts.collapsible ? "button" : null,
       "data-fk": opts.collapsible ? "head:" + p.id : null,
       "aria-expanded": opts.collapsible ? (open ? "true" : "false") : null,
       onclick: opts.collapsible ? function(){
         if(networked() && p.id !== mySeat()){
           ui.expanded = (ui.expanded === p.id) ? null : p.id;
         } else if(open){ ui.collapsed[p.id] = true; }
         else { delete ui.collapsed[p.id]; }
         render();
       } : null
    },[
      opts.collapsible ? el("span",{class:"chev", text:"❯", "aria-hidden":"true"}) : null,
      el("span",{class:"board-name", text:p.name}),
      networked() && p.id === mySeat() ? el("span",{class:"role-pill seat", text:"YOU"}) : null,
      el("span",{class:"board-meta"},[
        el("span",{class:chipClass, text:chipText}),
        el("span",{class:"board-total", text:String(total)})
      ])
    ]);

    var board = el("div",{class:"board" + (open ? " open" : "") + (e.bust ? " is-bust" : "") +
      (editable ? "" : " readonly")},[head]);
    if(!open) return board;

    if(!editable){
      board.appendChild(el("div",{class:"board-body"},[
        el("div",{class:"row-label"},[el("span",{text:"Their line"})]),
        readonlyLine(e),
        scoreTape(e, sc)
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
      scoreTape(e, sc)
    ]));
    return board;
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
    state.rounds.forEach(function(r, i){
      var tr = el("tr",{},[el("td",{text:"Round " + (i + 1)})]);
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
      el("p",{class:"foot", text:"Bust and you score nothing that round, whatever is in front of you. Modifier cards can't bust you and don't count toward the seven. Freeze, Flip Three and Second Chance carry no points, so leave them out."})
    ]);
  }

  /* ---------- actions ---------- */
  function commitRound(){
    if(dispatch({t:"commitRound"})){
      ui.collapsed = {}; ui.seat = 0; ui.expanded = null;
      render(); toTop();
    }
  }

  function undoRound(){
    if(!state.rounds.length) return;
    var pending = state.players.some(function(p){ return !isEmpty(state.current[p.id]); });
    if(pending){
      askConfirm("Undo round " + state.rounds.length + "?",
        "The cards already entered for round " + (state.rounds.length + 1) +
        " will be discarded to make room for it.",
        "Discard and undo", doUndo);
    } else { doUndo(); }
  }
  function doUndo(){
    if(dispatch({t:"undoRound"})){
      ui.collapsed = {}; ui.seat = 0;
      render(); toTop();
    }
  }

  /* Rejoin automatically when a link carried a room code. */
  if(ui.screen === "together" && ui.pendingRoom && prefs.relay){
    joinRoom(ui.pendingRoom);
  } else {
    render();
  }
})();
