// Service worker source. `tools/vite-plugin-sw.ts` fills in the version and
// the precache list at build time and emits the result as `dist/sw.js`, so the
// list always names the current hashed filenames. Not TypeScript:
// it runs in a worker scope the project's `tsconfig.json` DOM lib doesn't
// describe, and it is never bundled.
/* eslint-env serviceworker */

const VERSION = "__VERSION__";
const CACHE = `scoba-relica-${VERSION}`;
const PRECACHE = __PRECACHE__;

// Paths are stored relative so the same worker runs from a user page, a
// project page under a repo subpath, or a custom domain.
const abs = (path) => new URL(path, self.registration.scope).toString();
const INDEX = abs("index.html");

// Vary is ignored on purpose. A host that sends `Vary: Origin` (Vite's preview
// server does) makes the cached entry miss for Vite's `crossorigin` module
// script, which sends an Origin header the precaching request did not, and the
// miss falls through to a network that is not there. Every URL here is either
// content-hashed or the shell, so the URL alone decides the bytes.
const lookup = (req) => caches.match(req, { ignoreVary: true });

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map(abs))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/**
 * Navigations go to the network first so a fresh deploy is picked up on the
 * next launch, and fall back to the cached shell when offline. Everything else
 * is content-hashed by Vite, so a cache hit can never be stale and is served
 * without touching the network.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(self.registration.scope)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(INDEX, copy));
          return res;
        })
        .catch(async () => (await lookup(INDEX)) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await lookup(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        void caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    })(),
  );
});

// A waiting worker only takes over on the next launch, so an update can never
// swap the bundle out from under a battle in progress. The page can call this
// when it knows nothing is at stake.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void self.skipWaiting();
});

/**
 * Care reminders. The relay sends `{ title, body, tag, url }`; `tag` collapses
 * repeats so a Relica left hungry overnight yields one notification rather
 * than a stack of them.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Scoba Relica";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      tag: payload.tag || "care",
      renotify: false,
      icon: abs("icons/icon-192.png"),
      badge: abs("icons/icon-192.png"),
      data: { url: payload.url ? abs(payload.url) : abs("./") },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? abs("./");
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope)) return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
