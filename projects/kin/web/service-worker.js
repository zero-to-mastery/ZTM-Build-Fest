// Only source-controlled static shell assets are eligible for this cache.
// API, archives, projections, drafts and keys never pass through Cache.put.
const CACHE = "kin-static-v0.10.3";
const SHELL = [
  "/", "/index.html", "/styles/app.css", "/manifest.webmanifest", "/icon.svg",
  "/browser-time.js", "/wasm/kin-engine.js", "/wasm/kin_engine.wasm",
  "/storage/event-store.js", "/storage/encrypted-idb.js", "/storage/root-rotation.js",
  "/security/local-vault.js", "/security/passkey-unlock.js", "/security/archive.js",
  "/sync/crypto.js", "/sync/key-store.js", "/sync/sync-coordinator.js",
  ...["app", "security", "household", "compose", "item", "today", "handoff-list", "talk-list", "pulse", "catch-up", "routines"].map((name) => `/components/kin-${name}.js`),
];
const ALLOWED = new Set(SHELL);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("kin-static-") && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate" && ["/", "/pair"].includes(url.pathname)) {
    // Never cache the requested URL (which could contain a pairing code).
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then((cache) => cache.match("/index.html"))));
  } else if (!url.search && ALLOWED.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(url.pathname)) ?? fetch(event.request)));
  }
});
