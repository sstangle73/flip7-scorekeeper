/* Offline shell for the scorekeeper.
 *
 * The whole app is one HTML file, so caching that plus the icons is enough to
 * play on a device with no signal. Anything to a relay must never be cached:
 * a stale scorecard served from disk would be worse than an honest failure.
 */
/* build.sh rewrites this stamp from a hash of the built page. Without it the
   worker's bytes never change between deploys, so the browser never reinstalls
   it and the cached shell -- icons included -- is frozen forever. */
const BUILD = "3856007957";
const CACHE = "flip7-" + BUILD;
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // a missing optional file must not wedge install
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if(req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  /* Live game traffic and any cross-origin call goes straight to the network. */
  if(!sameOrigin || url.pathname.indexOf("/api/") === 0) return;

  /* Navigations: try the network so a deploy lands promptly, fall back to the
     cached shell when there is no signal. */
  if(req.mode === "navigate"){
    event.respondWith(
      fetch(req)
        .then(res => {
          /* Only ever cache a good page. Cache.put stores 4xx and 5xx happily,
             so one bad deploy would otherwise replace the app with an error
             page for every offline launch after it. */
          if(res && res.ok){
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put("./index.html", copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("./index.html")
          .then(r => r || caches.match("./"))
          .then(r => r || new Response(
            "<!doctype html><meta charset=utf-8><title>Offline</title>" +
            "<body style=\"font:16px system-ui;padding:2rem\"><h1>Offline</h1>" +
            "<p>The scorekeeper isn't cached on this device yet. Reconnect once and it will be.</p>",
            {status: 503, headers: {"Content-Type": "text/html; charset=utf-8"}})))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if(res && res.ok){
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => hit || new Response("", {status: 504, statusText: "Offline"}))));
});
