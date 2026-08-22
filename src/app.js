(function(){
  "use strict";

  var NUM_WORDS = ["ZERO","ONE","TWO","THREE","FOUR","FIVE","SIX","SEVEN","EIGHT","NINE","TEN","ELEVEN","TWELVE"];
  var MODS = [2,4,6,8,10];
  var FLIP7_BONUS = 15;
  var STORE_KEY = "flip7-scorekeeper-v1";

  /* The deck holds n copies of card n, and a single 0. Since cards in front of
     players are never reshuffled mid-round, this bounds how many players can
     show the same card in one round. */
  function copiesOf(n){ return n === 0 ? 1 : n; }

  /* Full contents, per the rules: 79 number cards + 9 action + 6 modifier = 94. */
  var ACTIONS = [{name:"Freeze", count:3}, {name:"Flip Three", count:3}, {name:"Second Chance", count:3}];
  var DECK_SIZE = (function(){
    var t = 0;
    for(var n = 0; n <= 12; n++) t += copiesOf(n);
    ACTIONS.forEach(function(a){ t += a.count; });
    return t + MODS.length + 1;   // one of each bonus, plus the single x2
  })();

  var RULES_URL = "https://cdn.shopify.com/s/files/1/0611/3958/3198/files/25_FLIP_7_TB_RULES_C_Rev_9_2_25_ND.pdf?v=1756935535";

  /* ---------- storage (sandbox-safe) ---------- */
  var mem = null;
  function save(){
    var raw = JSON.stringify(state);
    mem = raw;
    try { localStorage.setItem(STORE_KEY, raw); } catch(e){ /* in-memory only */ }
  }
  function wipe(){
    mem = null;
    try { localStorage.removeItem(STORE_KEY); } catch(e){ /* nothing to clear */ }
  }
  function load(){
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch(e){ raw = mem; }
    if(!raw) return null;
    var s;
    try { s = JSON.parse(raw); } catch(e){ return null; }
    return normalize(s);
  }

  /* Repair anything repairable, reject only what can't be a game. A save that
     slips through half-formed must never be able to wedge the app. */
  function normalize(s){
    if(!s || typeof s !== "object" || !Array.isArray(s.players)) return null;
    for(var i = 0; i < s.players.length; i++){
      var p = s.players[i];
      if(!p || typeof p.id !== "string" || typeof p.name !== "string") return null;
    }
    if(!Array.isArray(s.rounds)) s.rounds = [];
    if(typeof s.target !== "number" || !isFinite(s.target) || s.target < 1) s.target = 200;
    if(s.mode !== "pass") s.mode = "table";
    if(!s.collapsed || typeof s.collapsed !== "object") s.collapsed = {};
    if(typeof s.seat !== "number" || !isFinite(s.seat) || s.seat < 0) s.seat = 0;
    s.started = !!s.started && s.players.length > 0;
    s.dismissedWin = !!s.dismissedWin;
    s.rounds = s.rounds.map(scrubRound);
    s.current = scrubRound(s.current);
    return s;
  }
  function scrubRound(r){
    var out = {};
    if(!r || typeof r !== "object") return out;
    Object.keys(r).forEach(function(k){ out[k] = scrubEntry(r[k]); });
    return out;
  }
  function scrubEntry(e){
    var b = blankEntry();
    if(!e || typeof e !== "object") return b;
    if(Array.isArray(e.nums)){
      b.nums = e.nums
        .filter(function(n){ return typeof n === "number" && n >= 0 && n <= 12 && n === Math.floor(n); })
        .filter(function(n, i, a){ return a.indexOf(n) === i; })
        .slice(0, 7)
        .sort(function(x, y){ return x - y; });
    }
    if(Array.isArray(e.mods)){
      b.mods = e.mods
        .filter(function(m){ return MODS.indexOf(m) >= 0; })
        .filter(function(m, i, a){ return a.indexOf(m) === i; });
    }
    b.x2 = !!e.x2;
    b.bust = !!e.bust;
    return b;
  }

  /* ---------- state ---------- */
  function newGame(){
    return {
      started:false,
      target:200,
      players:[],
      rounds:[],
      current:{},
      mode:"table",    // "table" = score everyone at once, "pass" = hand the phone around
      collapsed:{},    // table mode: players folded away once they're entered
      seat:0,          // pass mode: whose turn it is to hold the phone
      dismissedWin:false
    };
  }

  var state = load() || newGame();
  var seats = state.players.length ? state.players.map(function(p){ return p.name; }) : ["",""];

  function blankEntry(){ return {nums:[], mods:[], x2:false, bust:false}; }
  function entryFor(pid){
    if(!state.current[pid]) state.current[pid] = blankEntry();
    return state.current[pid];
  }
  function isEmpty(e){ return !e || (!e.bust && e.nums.length === 0 && e.mods.length === 0 && !e.x2); }

  /* ---------- scoring, in the rulebook's order ---------- */
  function sum(a){ return a.reduce(function(x, y){ return x + y; }, 0); }
  function scoreOf(e){
    if(!e || e.bust) return 0;                    // bust scores nothing
    var base = sum(e.nums);                       // 1. add the number cards
    if(e.x2) base = base * 2;                     // 2. double them if the x2 card is out
    base += sum(e.mods);                          // 3. then add the +2..+10 bonuses
    if(e.nums.length === 7) base += FLIP7_BONUS;  // 4. Flip 7 (added after, so never doubled)
    return base;
  }
  function totalFor(pid){
    var t = 0;
    state.rounds.forEach(function(r){ t += scoreOf(r[pid]); });
    return t;
  }
  function tapeSteps(e){
    var steps = [];
    var s = sum(e.nums);
    steps.push({expr: e.nums.length ? e.nums.join(" + ") : "no number cards", val:s, kind:"nums"});
    var run = s;
    if(e.x2){ run = s * 2; steps.push({expr:"× 2", val:run, kind:"x2"}); }
    var m = sum(e.mods);
    if(m){ run += m; steps.push({expr:"+ " + m, val:run, kind:"mod"}); }
    if(e.nums.length === 7){ run += FLIP7_BONUS; steps.push({expr:"+ 15 Flip 7", val:run, kind:"flip7"}); }
    return steps;
  }

  /* A line can't hold seven uniques and be busted: the seventh ends the round
     before anyone can draw a duplicate. */
  function numCap(e){ return e.bust ? 6 : 7; }

  /* A Flip 7 ends the round the instant it happens, and cards are flipped one
     at a time — so at most one player per round can hold seven. */
  function flip7Holder(exceptId){
    for(var i = 0; i < state.players.length; i++){
      var p = state.players[i];
      if(p.id === exceptId) continue;
      var e = state.current[p.id];
      if(e && !e.bust && e.nums.length === 7) return p;
    }
    return null;
  }

  /* ---------- what this round couldn't have looked like ---------- */
  function roundConflicts(){
    var out = [], numCount = {}, modCount = {}, x2Count = 0;

    var sevens = state.players.filter(function(p){
      var e = state.current[p.id];
      return e && !e.bust && e.nums.length === 7;
    });
    if(sevens.length > 1){
      out.push(sevens.map(function(p){ return p.name; }).join(" and ") +
        " both have seven number cards. A Flip 7 ends the round immediately, so only one player can reach it.");
    }

    state.players.forEach(function(p){
      var e = state.current[p.id];
      if(!e) return;
      e.nums.forEach(function(n){ numCount[n] = (numCount[n] || 0) + 1; });
      e.mods.forEach(function(m){ modCount[m] = (modCount[m] || 0) + 1; });
      if(e.x2) x2Count++;
    });
    Object.keys(numCount).map(Number).sort(function(a, b){ return a - b; }).forEach(function(n){
      var have = numCount[n], copies = copiesOf(n);
      if(have > copies){
        out.push("The " + n + " card is in front of " + have + " players, but the deck holds " +
          (copies === 1 ? "only one." : "just " + copies + "."));
      }
    });
    MODS.forEach(function(m){
      if((modCount[m] || 0) > 1){
        out.push("The +" + m + " card is in front of " + modCount[m] + " players — there's only one in the deck.");
      }
    });
    if(x2Count > 1){
      out.push("The ×2 card is in front of " + x2Count + " players — there's only one in the deck.");
    }
    return out;
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
  function toTop(){
    window.scrollTo({top:0, behavior: reducedMotion() ? "auto" : "smooth"});
  }

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

  /* ---------- confirmation dialog (sandboxes block native confirm()) ---------- */
  var overlayEl = null;

  /* Keep the page behind a modal out of the tab order and off the a11y tree. */
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

  /* ---------- card odds off a fresh deck ---------- */
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
      nums.appendChild(oddsRow(
        n === 0 ? "ZERO — no points" : NUM_WORDS[n],
        String(n), "", copiesOf(n), 12));
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

  /* ---------- about ---------- */
  function showAbout(){
    var body = [
      el("p",{text:"Flip 7 is a game by Eric Olsen, published by The Op (USAopoly, Inc.), © 2025. Scoring here follows ruleset edition 3.1."}),
      el("a",{class:"btn-link", href:RULES_URL, target:"_blank", rel:"noopener noreferrer"},
        [el("span",{text:"Read the official rules"}), el("span",{text:"↗"})]),
      el("p",{text:"This scorekeeper is an unofficial fan-made tool. It isn't affiliated with, endorsed by, or licensed by The Op or USAopoly — please support the game by buying a copy."}),
      el("p",{text:"Everything stays on this device: scores are saved in your browser and never sent anywhere."})
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
      el("span",{text:"."})
    ]);
  }

  /* ---------- render ---------- */
  var view = document.getElementById("view");
  var bar = document.getElementById("topbar-actions");
  var commitbar = null;

  function render(){
    var key = focusNext || activeKey();
    focusNext = null;
    try {
      draw();
    } catch(err){
      drawCrash(err);   // deliberately no save(): never persist a state that can't draw
      return;
    }
    save();
    restoreFocus(key);
  }

  function draw(){
    clear(view); clear(bar);
    if(commitbar && commitbar.parentNode) commitbar.parentNode.removeChild(commitbar);
    commitbar = null;
    if(!state.started) renderSetup(); else renderGame();
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
        wipe();
        state = newGame();
        seats = ["",""];
        render();
      }},[el("span",{text:"Start over"})])
    ]));
  }

  /* ----- setup ----- */
  function renderSetup(){
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
      state.players = names.map(function(n, i){ return {id:"p" + i, name:n}; });
      state.rounds = [];
      state.current = {};
      state.collapsed = {};
      state.seat = 0;
      state.started = true;
      state.dismissedWin = false;
      render();
    }

    view.appendChild(el("section",{class:"panel setup"},[
      el("div",{},[
        el("h1",{text:"Who's at the table?"}),
        el("p",{class:"lede",text:"Add everyone playing. At the end of each round, tap the cards sitting in front of each player and the scoring is handled for you."})
      ]),
      el("p",{class:"attrib"},[
        el("span",{text:"Keeping score for "}),
        el("strong",{text:"Flip 7"}),
        el("span",{text:", a game by "}),
        el("strong",{text:"Eric Olsen"}),
        el("span",{text:", published by The Op. This is an unofficial fan-made scorekeeper — "}),
        el("a",{href:RULES_URL, target:"_blank", rel:"noopener noreferrer", text:"official rules ↗"})
      ]),
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

  /* ----- game ----- */
  function renderGame(){
    bar.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"undo",
      title:"Undo the last scored round and reopen it for editing",
      onclick:undoRound, disabled: state.rounds.length === 0 || null
    },[el("span",{text:"↶"}), el("span",{text:"Undo round"})]));

    bar.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"newgame",
      onclick:function(){
        askConfirm("Start a new game?",
          "Every round scored so far is cleared. The same players stay at the table so you can go straight into round 1.",
          "Clear and restart",
          function(){
            var names = state.players.map(function(p){ return p.name; });
            var target = state.target;
            state = newGame();
            state.target = target;
            seats = names.slice();
            render();
            toTop();
          });
      }
    },[el("span",{text:"New game"})]));

    bar.appendChild(referenceButtons());

    var totals = {};
    state.players.forEach(function(p){ totals[p.id] = totalFor(p.id); });
    var best = state.players.length
      ? Math.max.apply(null, state.players.map(function(p){ return totals[p.id]; }))
      : 0;

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
        el("button",{class:"btn", type:"button", onclick:function(){
          state.dismissedWin = true; render();
        }},[el("span",{text:"Keep playing"})])
      ]));
    }

    view.appendChild(el("div",{class:"section-head"},[
      el("h2",{text:"Standings"}),
      el("label",{class:"target-inline"},[
        el("span",{text:"Race to"}),
        el("input",{type:"number", min:"1", step:"5", value:String(state.target), "data-fk":"target",
          "aria-label":"Points needed to win",
          onchange:function(ev){
            var v = parseInt(ev.target.value, 10);
            if(v > 0) state.target = v;
            render();
          }})
      ])
    ]));
    var stand = el("div",{class:"standings"});
    state.players.slice().sort(function(a, b){ return totals[b.id] - totals[a.id]; }).forEach(function(p){
      var t = totals[p.id];
      var isLeader = t === best && best > 0;
      stand.appendChild(el("div",{class:"stand" + (isLeader ? " leader" : "")},[
        el("div",{class:"stand-top"},[
          el("span",{class:"stand-name", text:p.name}),
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
    var pass = state.mode === "pass";
    if(state.seat > state.players.length - 1) state.seat = Math.max(0, state.players.length - 1);
    if(state.seat < 0) state.seat = 0;

    view.appendChild(el("div",{class:"section-head"},[
      el("h2",{text:"Round " + roundNo}),
      el("span",{class:"hint", text: pass ? "One player at a time" : "Tap each player's cards as the round ends"}),
      el("div",{class:"segmented", role:"group", "aria-label":"Scoring mode"},[
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
        var isNow = i === state.seat;
        var cls = "seat-chip";
        if(isNow) cls += " now";
        else if(entered) cls += " done" + (scoreOf(e) === 0 ? " zero" : "");
        strip.appendChild(el("button",{class:cls, type:"button", "data-fk":"seat:" + i,
          "aria-current": isNow ? "true" : null,
          "aria-label": isNow ? p.name + ", scoring now" : "Hand the phone to " + p.name,
          onclick:function(){ state.seat = i; render(); }
        },[
          el("span",{text:p.name}),
          isNow ? el("span",{class:"sc", text:"●", "aria-hidden":"true"})
            : entered ? el("span",{class:"sc", text: e.bust ? "✗ 0" : String(scoreOf(e))}) : null
        ]));
      });
      view.appendChild(strip);

      var who = state.players[state.seat];
      view.appendChild(el("div",{class:"handoff"},[
        el("span",{text:"↝", "aria-hidden":"true"}),
        el("span",{},[
          el("span",{text:"Phone goes to "}),
          el("strong",{text:who.name}),
          el("span",{text:" — player " + (state.seat + 1) + " of " + state.players.length})
        ])
      ]));
      boards.appendChild(playerBoard(who, totals[who.id], {forceOpen:true, collapsible:false}));
    } else {
      state.players.forEach(function(p){
        boards.appendChild(playerBoard(p, totals[p.id], {forceOpen: !state.collapsed[p.id], collapsible:true}));
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

    if(pass && state.seat > 0){
      inner.appendChild(el("button",{class:"btn btn-quiet", type:"button", "data-fk":"back",
        "aria-label":"Back to " + state.players[state.seat - 1].name,
        onclick:function(){ state.seat--; render(); toTop(); }
      },[el("span",{text:"←"})]));
    }

    inner.appendChild(el("div",{class:"commit-info"},[
      el("div",{class:"r", text:"Round " + roundNo}),
      el("div",{class:"s", text: entered === 0 ? "No cards entered yet"
        : blank === 0 ? "All " + state.players.length + " players entered"
        : entered + " entered · " + blank + (blank === 1 ? " blank line scores 0" : " blank lines score 0")})
    ]));

    var lastSeat = state.seat >= state.players.length - 1;
    if(pass && !lastSeat){
      inner.appendChild(el("button",{class:"btn btn-primary", type:"button", "data-fk":"advance",
        onclick:function(){ state.seat++; render(); toTop(); }
      },[el("span",{text:"Hand to " + state.players[state.seat + 1].name}), el("span",{text:"→"})]));
    } else {
      inner.appendChild(el("button",{class:"btn btn-primary", type:"button", "data-fk":"advance",
        disabled: entered === 0 || null, onclick:commitRound
      },[el("span",{text:"Score round " + roundNo}), el("span",{text:"→"})]));
    }

    commitbar = el("div",{class:"commitbar"},[inner]);
    document.body.appendChild(commitbar);
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

  function modeButton(mode, icon, label){
    return el("button",{class: state.mode === mode ? "on" : "", type:"button", "data-fk":"mode:" + mode,
      "aria-pressed": state.mode === mode ? "true" : "false",
      onclick:function(){ state.mode = mode; state.seat = 0; render(); }
    },[el("span",{class:"ic", text:icon, "aria-hidden":"true"}), el("span",{text:label})]);
  }

  function playerBoard(p, total, opts){
    opts = opts || {};
    var e = entryFor(p.id);
    var open = opts.forceOpen;
    var sc = scoreOf(e);
    var flip7 = !e.bust && e.nums.length === 7;
    var cap = numCap(e);

    /* Someone else already flipped 7, so this line can't reach it. Only
       constrain a player not already sitting on seven, so a line loaded from
       older data stays editable rather than locking itself. */
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
         if(open) state.collapsed[p.id] = true; else delete state.collapsed[p.id];
         render();
       } : null
    },[
      opts.collapsible ? el("span",{class:"chev", text:"❯", "aria-hidden":"true"}) : null,
      el("span",{class:"board-name", text:p.name}),
      el("span",{class:"board-meta"},[
        el("span",{class:chipClass, text:chipText}),
        el("span",{class:"board-total", text:String(total)})
      ])
    ]);

    var board = el("div",{class:"board" + (open ? " open" : "") + (e.bust ? " is-bust" : "")},[head]);
    if(!open) return board;

    /* score modifiers sit above the number line, the way they do on the table */
    var modRow = el("div",{class:"mod-row"});
    MODS.forEach(function(m){
      var on = e.mods.indexOf(m) >= 0;
      modRow.appendChild(el("button",{class:"card mod" + (on ? " on" : ""), type:"button",
        "data-fk":"mod:" + p.id + ":" + m,
        "aria-pressed": on ? "true" : "false", "aria-label":"Plus " + m + " bonus card",
        onclick:function(){
          var i = e.mods.indexOf(m);
          if(i >= 0) e.mods.splice(i, 1); else e.mods.push(m);
          render();
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
      onclick:function(){ e.x2 = !e.x2; render(); }
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
            var i = e.nums.indexOf(n);
            if(i >= 0) e.nums.splice(i, 1);
            else if(e.nums.length < cap) e.nums.push(n);
            e.nums.sort(function(a, b){ return a - b; });
            render();
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
        onclick:function(){ e.bust = !e.bust; render(); }
      },[el("span",{text:"✗"}), el("span",{text: e.bust ? "Busted — scores 0" : "Mark busted"})]),
      flip7 ? el("span",{class:"flag"},[el("span",{text:"★"}), el("span",{text:"Flip 7  +15"})]) : null,
      isEmpty(e) ? null : el("button",{class:"toggle clear", type:"button", "data-fk":"clear:" + p.id,
        onclick:function(){
          state.current[p.id] = blankEntry();
          focusNext = "bust:" + p.id;   // this button is about to vanish
          render();
        }},[el("span",{text:"Clear line"})])
    ]);

    var tape = el("div",{class:"tape"});
    if(e.bust){
      tape.appendChild(el("span",{class:"seg bust", text:"✗ BUSTED"}));
      tape.appendChild(el("span",{class:"seg muted", text:"everything in front of you scores nothing"}));
      tape.appendChild(el("span",{class:"seg total zero", text:"0"}));
    } else {
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
    }

    /* Say why the line stops short of seven — a tooltip is invisible on a phone. */
    var capNote = null;
    if(e.bust){
      /* The bust is this line's own reason for stopping at six, so it wins over
         someone else's Flip 7 when both happen to apply. */
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
        el("span",{class:"ico", text:"ⓘ", "aria-hidden":"true"}),
        el("span",{text:capNote})
      ]) : null,
      status,
      tape
    ]));
    return board;
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
    var round = {};
    state.players.forEach(function(p){
      var e = state.current[p.id] || blankEntry();
      round[p.id] = {nums:e.nums.slice(), mods:e.mods.slice(), x2:e.x2, bust:e.bust};
    });
    state.rounds.push(round);
    state.current = {};
    state.collapsed = {};
    state.seat = 0;
    render();
    toTop();
  }

  function undoRound(){
    if(!state.rounds.length) return;
    var pending = state.players.some(function(p){ return !isEmpty(state.current[p.id]); });
    if(pending){
      askConfirm("Undo round " + state.rounds.length + "?",
        "The cards you've already entered for round " + (state.rounds.length + 1) +
        " will be discarded to make room for it.",
        "Discard and undo", doUndo);
    } else {
      doUndo();
    }
  }
  function doUndo(){
    state.current = state.rounds.pop();
    state.collapsed = {};
    state.seat = 0;
    render();
    toTop();
  }

  render();
})();
