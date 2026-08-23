/* WebSocket link to the relay.
 *
 * Owns nothing but the connection: it reconnects, it hands raw messages up, and
 * it reports status. All game state lives in app.js, all rules in game.js.
 */
function Flip7Net(handlers){
  "use strict";

  var ws = null;
  var status = "offline";     // offline | connecting | online | retrying | failed
  var relay = null, code = null, clientId = null, displayName = null;
  var retry = null, attempts = 0, deliberate = false, opened = false;

  function setStatus(s, detail){
    status = s;
    if(handlers.onStatus) handlers.onStatus(s, detail);
  }

  /* http(s) in, ws(s) out, with any trailing slash removed. */
  function socketUrl(base, roomCode){
    var u = String(base).trim().replace(/\/+$/, "");
    if(/^https:/i.test(u)) u = "wss:" + u.slice(6);
    else if(/^http:/i.test(u)) u = "ws:" + u.slice(5);
    else if(!/^wss?:/i.test(u)) u = "wss://" + u;
    return u + "/api/rooms/" + encodeURIComponent(roomCode) + "/ws";
  }

  function apiUrl(base, path){
    var u = String(base).trim().replace(/\/+$/, "");
    if(/^wss:/i.test(u)) u = "https:" + u.slice(4);
    else if(/^ws:/i.test(u)) u = "http:" + u.slice(3);
    else if(!/^https?:/i.test(u)) u = "https://" + u;
    return u + path;
  }

  function createRoom(base){
    return fetch(apiUrl(base, "/api/rooms"), {method:"POST"})
      .then(function(r){
        if(!r.ok) return r.json().catch(function(){ return {}; }).then(function(b){
          throw new Error(b.error || ("The relay answered " + r.status + "."));
        });
        return r.json();
      })
      .then(function(b){
        if(!b.code) throw new Error("The relay didn't return a room code.");
        return b.code;
      });
  }

  function health(base){
    return fetch(apiUrl(base, "/api/health")).then(function(r){
      if(!r.ok) throw new Error("The relay answered " + r.status + ".");
      return r.json();
    });
  }

  function connect(base, roomCode, id, who){
    disconnect(true);
    relay = base; code = roomCode; clientId = id; displayName = who;
    deliberate = false;
    attempts = 0;
    opened = false;
    open();
  }

  function open(){
    setStatus(attempts ? "retrying" : "connecting");
    var url;
    try { url = socketUrl(relay, code); }
    catch(e){ setStatus("failed", "That relay address doesn't look like a URL."); return; }

    try { ws = new WebSocket(url); }
    catch(e){ scheduleRetry("Couldn't open a connection."); return; }

    ws.onopen = function(){
      opened = true;
      attempts = 0;
      setStatus("online");
      send({t:"hello", clientId:clientId, name:displayName});
    };
    ws.onmessage = function(ev){
      var msg;
      try { msg = JSON.parse(ev.data); } catch(e){ return; }
      if(handlers.onMessage) handlers.onMessage(msg);
    };
    ws.onclose = function(){
      ws = null;
      if(deliberate){ setStatus("offline"); return; }
      /* Closing without ever opening usually means the upgrade was refused --
         most often because there is no room on that code. Retrying forever
         just looks like the app has hung. */
      if(!opened && attempts >= 2){
        setStatus("failed", "No room answered on that code.");
        return;
      }
      scheduleRetry("Lost the connection.");
    };
    ws.onerror = function(){ /* onclose follows and handles the retry */ };
  }

  function scheduleRetry(why){
    if(deliberate) return;
    attempts++;
    if(attempts > 8){ setStatus("failed", why + " Gave up after several tries."); return; }
    var wait = Math.min(15000, 800 * Math.pow(1.7, attempts - 1));
    setStatus("retrying", why);
    clearTimeout(retry);
    retry = setTimeout(open, wait);
  }

  function send(obj){
    if(!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; }
    catch(e){ return false; }
  }

  function disconnect(quiet){
    deliberate = true;
    clearTimeout(retry);
    if(ws){ try { ws.close(); } catch(e){} ws = null; }
    if(!quiet) setStatus("offline");
  }

  function retryNow(){
    if(!relay || !code) return;
    deliberate = false;
    attempts = 0;
    clearTimeout(retry);
    open();
  }

  return {
    connect:connect, disconnect:disconnect, retryNow:retryNow, send:send,
    createRoom:createRoom, health:health,
    getStatus:function(){ return status; },
    isOnline:function(){ return status === "online"; }
  };
}
