/* Unit tests for src/app.js -- the screens themselves, driven headlessly.
 *
 * app.js was the one file with no suite: it is the DOM, so the only way to find
 * a bug in it was to hit one mid-game, and that is where the reported ones keep
 * coming from. What stood in the way was never the logic, it was the browser --
 * so this file brings just enough of one. Roughly 200 lines of nodes, a selector
 * engine that covers the handful of selectors app.js actually uses, and a fake
 * relay socket. Everything else -- the rules, the rendering, the event handlers
 * -- is the shipping code, loaded the same way test-view.mjs loads it.
 *
 * The shim is deliberately strict. A querySelector it cannot parse throws
 * rather than returning null: a DOM that silently finds nothing would let this
 * suite report success about a screen it never looked at.
 *
 * Run with `node test-app.mjs`.
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function check(label, cond, detail){
  if(cond){ pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  -> " + detail : "")); }
}

/* ---------------------------------------------------------------- the DOM --
   Only what src/app.js touches. Every method here exists because a line of the
   app calls it; nothing is provided speculatively. */

function Text(data){ this.nodeType = 3; this.data = String(data); this.parentNode = null; }
Object.defineProperty(Text.prototype, "textContent", {
  get(){ return this.data; },
  set(v){ this.data = String(v); }
});

function Element(tag){
  this.nodeType = 1;
  this.tagName = String(tag).toUpperCase();
  this.attrs = Object.create(null);
  this.childNodes = [];
  this.listeners = Object.create(null);
  this.parentNode = null;
  this.style = {};
  this.inert = false;
}

Element.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
Element.prototype.getAttribute = function(k){ return k in this.attrs ? this.attrs[k] : null; };
Element.prototype.removeAttribute = function(k){ delete this.attrs[k]; };
Element.prototype.hasAttribute = function(k){ return k in this.attrs; };

Element.prototype.appendChild = function(n){
  if(n.parentNode) n.parentNode.removeChild(n);
  n.parentNode = this;
  this.childNodes.push(n);
  return n;
};
Element.prototype.removeChild = function(n){
  const i = this.childNodes.indexOf(n);
  if(i >= 0){ this.childNodes.splice(i, 1); n.parentNode = null; }
  return n;
};
Object.defineProperty(Element.prototype, "firstChild", {
  get(){ return this.childNodes[0] || null; }
});

/* className is a live property in a browser and app.js assigns it directly, but
   selectors read it too -- so keep the one copy in the attribute. */
Object.defineProperty(Element.prototype, "className", {
  get(){ return this.attrs["class"] || ""; },
  set(v){ this.attrs["class"] = String(v); }
});

/* disabled reflects to the attribute, as it does in a browser. The lobby's
   start button is switched by property and read back by selector; if these two
   ever came apart, the test would be checking something the screen isn't. */
Object.defineProperty(Element.prototype, "disabled", {
  get(){ return this.hasAttribute("disabled"); },
  set(v){ if(v) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
});

/* A form control's value starts at its attribute and then lives on its own,
   which is the difference a user typing makes. */
Object.defineProperty(Element.prototype, "value", {
  get(){ return this._value !== undefined ? this._value : (this.attrs.value || ""); },
  set(v){ this._value = String(v); }
});

Object.defineProperty(Element.prototype, "textContent", {
  get(){ return this.childNodes.map(n => n.textContent).join(""); },
  set(v){
    this.childNodes.forEach(n => { n.parentNode = null; });
    this.childNodes = [];
    if(v !== "") this.appendChild(new Text(v));
  }
});

Element.prototype.addEventListener = function(type, fn){
  (this.listeners[type] || (this.listeners[type] = [])).push(fn);
};
Element.prototype.removeEventListener = function(type, fn){
  const l = this.listeners[type];
  if(l) this.listeners[type] = l.filter(f => f !== fn);
};
Element.prototype.focus = function(){ doc.activeElement = this; };
Element.prototype.contains = function(n){
  for(let p = n; p; p = p.parentNode) if(p === this) return true;
  return false;
};

Element.prototype.descendants = function(){
  const out = [];
  (function walk(n){
    n.childNodes.forEach(c => { if(c.nodeType === 1){ out.push(c); walk(c); } });
  })(this);
  return out;
};
Element.prototype.querySelectorAll = function(sel){
  return this.descendants().filter(n => matchesAny(n, sel));
};
Element.prototype.querySelector = function(sel){
  return this.querySelectorAll(sel)[0] || null;
};

/* ------------------------------------------------------- selector engine --
   Supports exactly the shapes app.js uses: tag, .class, #id, [attr],
   [attr="v"], a :not(...) tail, and comma-separated lists. Anything else is a
   selector this shim has never been asked about -- throw, so it cannot quietly
   match nothing and turn a broken screen into a passing test. */
const SIMPLE = /^(\*|[a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)(?::not\(([^)]+)\))?$/;

function matchesAny(node, sel){
  return String(sel).split(",").some(part => matches(node, part.trim()));
}
function matches(node, sel){
  const m = SIMPLE.exec(sel);
  if(!m) throw new Error("test-app.mjs: unsupported selector " + JSON.stringify(sel));
  const [, tag, bits, not] = m;
  if(tag && tag !== "*" && node.tagName !== tag.toUpperCase()) return false;
  for(const bit of bits.match(/[#.][\w-]+|\[[^\]]+\]/g) || []){
    if(!matchesBit(node, bit)) return false;
  }
  if(not && matches(node, not)) return false;
  return true;
}
function matchesBit(node, bit){
  if(bit[0] === "#") return node.getAttribute("id") === bit.slice(1);
  if(bit[0] === ".") return node.className.split(/\s+/).indexOf(bit.slice(1)) >= 0;
  const attr = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(bit);
  if(!attr) throw new Error("test-app.mjs: unsupported attribute selector " + bit);
  if(!node.hasAttribute(attr[1])) return false;
  return attr[2] === undefined || node.getAttribute(attr[1]) === attr[2];
}

/* ------------------------------------------------------------ the page --
   The skeleton app.js reaches into: the two ids it holds on to, and the .app
   wrapper it makes inert behind a dialog. */
const doc = {
  activeElement: null,
  listeners: Object.create(null),
  createElement: tag => new Element(tag),
  createTextNode: t => new Text(t),
  addEventListener(type, fn){ (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
  removeEventListener(type, fn){
    const l = this.listeners[type];
    if(l) this.listeners[type] = l.filter(f => f !== fn);
  },
  getElementById(id){ return doc.body.querySelector("#" + id); },
  querySelector(sel){ return doc.body.querySelector(sel); },
  querySelectorAll(sel){ return doc.body.querySelectorAll(sel); },
  contains(n){ return doc.body.contains(n); },
  execCommand(){ return false; }
};
doc.body = new Element("body");
const app = new Element("div");
app.className = "app";
const topbar = new Element("div");
topbar.setAttribute("id", "topbar-actions");
const viewEl = new Element("main");
viewEl.setAttribute("id", "view");
app.appendChild(topbar);
app.appendChild(viewEl);
doc.body.appendChild(app);

const win = {
  addEventListener(){},
  removeEventListener(){},
  scrollTo(){}
  /* no matchMedia: reducedMotion() already treats its absence as "no". */
};
const loc = {search:"", hash:"", protocol:"http:", hostname:"localhost",
             origin:"http://localhost", pathname:"/"};

const store = new Map();
const localStorageShim = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); }
};

/* ----------------------------------------------------------- the relay --
   One room, one socket. It answers a hello with a welcome and records every
   frame the app sends, which is how the order actions reach the server can be
   checked -- an optimistic screen that is right for the wrong reason would
   still show the correct table. */
const relay = {sent: [], sockets: []};

function FakeSocket(url){
  this.url = url;
  this.readyState = 1;
  relay.sockets.push(this);
  setTimeout(() => { if(this.onopen) this.onopen(); }, 0);
}
FakeSocket.prototype.send = function(raw){
  const msg = JSON.parse(raw);
  relay.sent.push(msg);
  if(msg.t === "hello"){
    this.deliver({
      t: "welcome", you: "c-host", hostId: "c-host",
      seats: {}, present: ["c-host"], people: [],
      state: G.newGame()
    });
  }
};
FakeSocket.prototype.deliver = function(msg){
  setTimeout(() => { if(this.onmessage) this.onmessage({data: JSON.stringify(msg)}); }, 0);
};
FakeSocket.prototype.close = function(){ this.readyState = 3; };

const fetchShim = (url, opts) => {
  if(/\/api\/rooms$/.test(url) && opts && opts.method === "POST"){
    return Promise.resolve({ok: true, json: () => Promise.resolve({code: "TEST"})});
  }
  throw new Error("test-app.mjs: unexpected fetch " + url);
};

/* ------------------------------------------------------------- loading --
   The same `new Function` trick the other suites use, so there is no generated
   copy of app.js to keep in sync -- this runs the file that ships. */
const read = f => readFileSync(f, "utf8");
const G = new Function(read("src/game.js") + "; return Flip7Rules;")()();
const V = new Function(read("src/view.js") + "; return Flip7View;")()(G);
/* net.js is the one module that reaches for the network, so it gets the fake
   relay in place of the real globals. */
const Flip7Net = new Function("fetch", "WebSocket", read("src/net.js") + "; return Flip7Net;")(
  fetchShim, FakeSocket);

function boot(source){
  relay.sent.length = 0;
  relay.sockets.length = 0;
  new Function(
    "document", "window", "location", "navigator", "localStorage",
    "fetch", "WebSocket", "Flip7Rules", "Flip7View", "Flip7Net", source
  )(doc, win, loc, {}, localStorageShim, fetchShim, FakeSocket,
    () => G, () => V, Flip7Net);
}

/* ------------------------------------------------------------- driving --
   What a person does: find the control by the words on it, click it, type. */
const settle = () => new Promise(r => setTimeout(r, 5));

function buttonSaying(text){
  return doc.body.querySelectorAll("button").filter(b => b.textContent.includes(text))[0] || null;
}
function click(node){
  if(!node) throw new Error("test-app.mjs: nothing to click");
  /* A browser fires nothing at a disabled control, and neither does this. */
  if(node.disabled) return false;
  (node.listeners.click || []).forEach(fn => fn({target: node, preventDefault(){}}));
  return true;
}
function clickSaying(text){
  const b = buttonSaying(text);
  if(!b) throw new Error("test-app.mjs: no button saying " + JSON.stringify(text));
  return click(b);
}
function field(fk){ return doc.body.querySelector('[data-fk="' + fk + '"]'); }
function type(node, text){
  node.value = text;
  (node.listeners.input || []).forEach(fn => fn({target: node}));
}
function pressEnter(node){
  (node.listeners.keydown || []).forEach(fn => fn({key: "Enter", target: node, preventDefault(){}}));
}
/* The names actually on screen, wherever the screen happens to show them: the
   lobby lists them one way, the standings on the game screen another. */
const onScreen = () =>
  doc.body.querySelectorAll(".lobby-name, .stand-name").map(n => n.textContent);

async function hostALobby(source){
  store.clear();
  store.set("flip7-prefs-v1", JSON.stringify({relay: "http://relay.test", name: "Host"}));
  boot(source);
  /* A device that has been here before opens on the together screen already. */
  if(buttonSaying("Play together")) clickSaying("Play together");
  clickSaying("Start a room");
  await settle();
  await settle();
}

/* ================================================================ tests == */

const CURRENT = read("src/app.js");

console.log("\nThe host reaches a lobby\n");
await hostALobby(CURRENT);
check("starting a room lands on the lobby", !!field("newplayer"),
      "no player-name box on screen");
check("the relay was told who we are", relay.sent.some(m => m.t === "hello"));

console.log("\nAdding people to the table\n");
{
  const box = field("newplayer");
  type(box, "Alice");
  pressEnter(box);
  check("Enter adds the name in the box", onScreen().join(",") === "Alice", onScreen().join(","));

  type(field("newplayer"), "Bob");
  clickSaying("Add");
  check("the Add button adds it too", onScreen().join(",") === "Alice,Bob", onScreen().join(","));
}

/* The reported bug, written from what was seen: the host typed the last player,
   hit start, and that person was not in the game. */
console.log("\nThe last name typed, with start hit straight after\n");
{
  type(field("newplayer"), "Carol");
  clickSaying("Start scoring");

  check("the player typed last is at the table", onScreen().indexOf("Carol") >= 0,
        "table is " + onScreen().join(","));
  check("the players added before are still there",
        ["Alice", "Bob"].every(n => onScreen().indexOf(n) >= 0), onScreen().join(","));
  check("the game did start", !field("newplayer"), "still on the lobby");

  /* Every edit is optimistic, so the screen can be right while the relay never
     hears about the player -- and the next broadcast would then take them away
     again. Name the player being looked for: "some addPlayer went first" is
     true whether or not the one that matters was ever sent. */
  const acted = relay.sent.filter(m => m.t === "action").map(m => m.action);
  const added = acted.findIndex(a => a.t === "addPlayer" && a.name === "Carol");
  const began = acted.findIndex(a => a.t === "beginGame");
  check("the relay was told to add that player, before the game began",
        added >= 0 && began >= 0 && added < began,
        acted.map(a => a.t + (a.name ? ":" + a.name : "")).join(" -> "));
  check("the relay heard about all three",
        acted.filter(a => a.t === "addPlayer").map(a => a.name).join(",") === "Alice,Bob,Carol");
}

console.log("\nThe floating scoreboard\n");
{
  const strip = doc.body.querySelector(".scorefloat");
  const inStrip = doc.body.querySelectorAll(".sf-name").map(n => n.textContent).join(",");
  const inStandings = doc.body.querySelectorAll(".stand-name").map(n => n.textContent).join(",");
  check("the game screen carries one", !!strip);
  check("it lists the same players, in the same order, as the standings",
        inStrip === inStandings && inStrip.split(",").length === 3, inStrip + " vs " + inStandings);
  check("it starts out of sight, with the standings on screen",
        strip && strip.className === "scorefloat", strip && strip.className);
  check("screen readers get the standings once, not twice",
        strip && strip.getAttribute("aria-hidden") === "true");
}

console.log("\nA table of one, typed and never added\n");
{
  await hostALobby(CURRENT);
  check("with nobody added, start is dead", field("newplayer") && buttonSaying("Start scoring").disabled);
  type(field("newplayer"), "Solo");
  check("a name in the box brings it to life", !buttonSaying("Start scoring").disabled);
  clickSaying("Start scoring");
  check("that one name is the table", onScreen().join(",") === "Solo", onScreen().join(","));
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
