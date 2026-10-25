// GladRags service worker: just enough to make the app installable and to
// show an offline page. Deliberately does NOT cache API responses or images:
// wardrobe photos are private and served through short-lived signed URLs.

const CACHE = "gladrags-shell-v1";
// Must equal MODEL_CACHE_NAME in src/lib/images/model-cache.ts (a test checks).
const MODEL_CACHE = "gladrags-models-v1";
const OFFLINE_URL = "/offline.html";

/** Old versions of our own caches. The current model cache and anyone else's caches stay. */
function isStale(key) {
  if (key.startsWith("gladrags-shell-")) return key !== CACHE;
  if (key.startsWith("gladrags-models-")) return key !== MODEL_CACHE;
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, "/icons/icon-192.png"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Old shell caches, and model caches from an earlier MODEL_CACHE_NAME.
      // The current model cache survives service worker updates.
      .then((keys) => Promise.all(keys.filter(isStale).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Build assets have content hashes in their names, so cache-first is safe.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Pages: always go to the network; show the offline page if it's down.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
  }
});
