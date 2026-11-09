// Offline shell. The HTML document is fetched fresh every load (falling back to cache only
// when there's no signal) so a shipped fix is never stuck behind a stale cached copy — that
// exact staleness (cache-first on index.html) was why earlier fixes didn't visibly land.
// The three scripts are part of the app and follow the same rule; only the icon and
// manifest are cache-first, since they rarely change.
const CACHE = "ledger-v6";
const SHELL = ["./", "./index.html", "./data.js", "./render.js", "./app.js",
               "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  // Prices must never come out of a cache-first shelf: that shows yesterday's quote as live.
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  const isDoc = e.request.mode === "navigate" || e.request.destination === "document"
    || e.request.destination === "script";
  e.respondWith(
    isDoc
      ? fetch(e.request)
          .then(res => { if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })
          .catch(() => caches.match(e.request))
      : caches.match(e.request).then(hit => {
          const live = fetch(e.request)
            .then(res => { if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })
            .catch(() => hit);
          return hit || live;
        })
  );
});
