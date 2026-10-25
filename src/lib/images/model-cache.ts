/**
 * Download-once caching for the background-removal model and runtime, using
 * the browser's Cache Storage. After the first download the files load from
 * the phone, even offline. Falls back to a plain fetch where Cache Storage
 * isn't available (non-HTTPS pages, some private modes).
 *
 * The service worker (public/sw.js) leaves this cache alone.
 *
 * Client-safe.
 */

export const MODEL_CACHE_NAME = "gladrags-models-v1";

async function openCache(cacheName: string): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(cacheName);
  } catch {
    return null;
  }
}

/** Fetch a file, from the cache if it's there, storing it otherwise. Throws if it can't be fetched. */
export async function fetchWithCache(url: string, cacheName = MODEL_CACHE_NAME): Promise<ArrayBuffer> {
  const cache = await openCache(cacheName);
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return await hit.arrayBuffer();
    } catch {
      // A broken entry: fetch it again below.
    }
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download ${url}: HTTP ${response.status}`);
  if (cache) {
    try {
      await cache.put(url, response.clone());
    } catch {
      // Storage full or not allowed: still works, just downloads again next time.
    }
  }
  return response.arrayBuffer();
}

/** Delete cached files other than these (old model or runtime versions). */
export async function pruneCache(keepUrls: readonly string[], cacheName = MODEL_CACHE_NAME): Promise<void> {
  const cache = await openCache(cacheName);
  if (!cache) return;
  try {
    const keep = new Set(keepUrls.map((url) => new URL(url, location.href).href));
    for (const request of await cache.keys()) {
      if (!keep.has(request.url)) await cache.delete(request);
    }
  } catch {
    // Not important enough to fail over.
  }
}

/** True if every one of these files is already cached, i.e. removal works offline and starts quickly. */
export async function isCached(urls: readonly string[], cacheName = MODEL_CACHE_NAME): Promise<boolean> {
  const cache = await openCache(cacheName);
  if (!cache) return false;
  try {
    for (const url of urls) {
      if (!(await cache.match(url))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
