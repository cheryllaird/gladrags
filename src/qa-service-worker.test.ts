/**
 * QA tests for public/sw.js, run in a sandbox with fake Cache Storage and
 * fetch (CONTRACTS.md: images are private and served through short-lived
 * signed URLs; the background-removal model is downloaded once and cached).
 *
 * - An update (activate) deletes old shell caches only: the model cache
 *   ("gladrags-models-…") and anything else survive.
 * - API responses, item images (signed URLs, same-origin or Supabase) and
 *   the model files are never put in the service worker's cache.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { MODEL_CACHE_NAME } from "@/lib/images/model-cache";

const SW_SOURCE = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
const ORIGIN = "https://gladrags.example.com";

interface FakeCache {
  entries: Map<string, Response>;
}

function loadWorker(existingCaches: string[] = []) {
  const stores = new Map<string, FakeCache>(existingCaches.map((name) => [name, { entries: new Map() }]));
  const listeners = new Map<string, (event: unknown) => void>();
  const fetched: string[] = [];

  const cacheApi = (name: string) => {
    const store = stores.get(name) ?? { entries: new Map() };
    stores.set(name, store);
    return {
      addAll: async (urls: string[]) => urls.forEach((u) => store.entries.set(u, new Response("x"))),
      put: async (request: Request | string, response: Response) =>
        store.entries.set(typeof request === "string" ? request : request.url, response),
      match: async (request: Request | string) => store.entries.get(typeof request === "string" ? request : request.url),
    };
  };

  const sandbox = {
    URL,
    Response,
    Promise,
    console,
    self: {
      location: new URL(ORIGIN),
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async (name: string) => cacheApi(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (request: Request | string) => {
        for (const store of stores.values()) {
          const hit = store.entries.get(typeof request === "string" ? request : request.url);
          if (hit) return hit;
        }
        return undefined;
      },
    },
    fetch: async (request: Request | string) => {
      fetched.push(typeof request === "string" ? request : request.url);
      return new Response("network", { status: 200 });
    },
  };
  vm.runInNewContext(SW_SOURCE, sandbox);

  async function lifecycle(type: "install" | "activate") {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  }

  /** Dispatch a fetch event. Returns the response if the worker answered, or null if it let the browser handle it. */
  async function request(url: string, init: { method?: string; mode?: string } = {}) {
    const req = { url: new URL(url, ORIGIN).href, method: init.method ?? "GET", mode: init.mode ?? "cors" };
    let answered = null as Promise<Response> | null;
    listeners.get("fetch")!({ request: req, respondWith: (p: Promise<Response>) => (answered = p) });
    return answered ? await answered : null;
  }

  /** Everything any cache holds, as URLs. */
  const cachedUrls = () => [...stores.values()].flatMap((s) => [...s.entries.keys()]);

  return { stores, lifecycle, request, cachedUrls, fetched };
}

describe("service worker updates keep the model cache", () => {
  it("activate deletes old shell caches and keeps the model cache and unrelated caches", async () => {
    const sw = loadWorker([MODEL_CACHE_NAME, "gladrags-shell-v0", "gladrags-models-v0-old", "someone-elses-cache"]);
    sw.stores.get(MODEL_CACHE_NAME)!.entries.set(`${ORIGIN}/models/u2netp.onnx?v=1`, new Response("model"));
    await sw.lifecycle("install");
    await sw.lifecycle("activate");
    const names = [...sw.stores.keys()].sort();
    expect(names).toContain(MODEL_CACHE_NAME);
    expect(names).not.toContain("gladrags-shell-v0");
    expect(names).toContain("someone-elses-cache");
    expect(sw.stores.get(MODEL_CACHE_NAME)!.entries.size).toBe(1);
    // Review fix: a model cache from an earlier MODEL_CACHE_NAME is deleted.
    expect(names).not.toContain("gladrags-models-v0-old");
  });

  it("the worker's model cache name matches MODEL_CACHE_NAME in the app", () => {
    expect(SW_SOURCE).toContain(`const MODEL_CACHE = "${MODEL_CACHE_NAME}";`);
    expect(MODEL_CACHE_NAME).toMatch(/^gladrags-models-/);
  });

  it("the model cache's name can't be mistaken for a shell cache", () => {
    expect(MODEL_CACHE_NAME.startsWith("gladrags-shell-")).toBe(false);
  });

  it("install caches only the offline page and an icon", async () => {
    const sw = loadWorker();
    await sw.lifecycle("install");
    expect(sw.cachedUrls().sort()).toEqual(["/icons/icon-192.png", "/offline.html"]);
  });
});

describe("the service worker never caches private data", () => {
  it.each([
    "/api/items",
    "/api/items/4d000000-0000-4000-8000-000000000001",
    "/api/usage",
    "/api/outfits?status=saved",
    "/mock/items/navy-chinos.png",
    "/models/u2netp.onnx?v=1",
    "/ort/ort-wasm-simd-threaded.wasm?v=1.30.0",
    "/storage/v1/object/sign/cutouts/user/x.png?token=abc",
  ])("GET %s is left to the network, uncached", async (path) => {
    const sw = loadWorker();
    expect(await sw.request(path)).toBeNull();
    expect(sw.cachedUrls()).toEqual([]);
  });

  it("a Supabase signed image URL (another origin) is left alone", async () => {
    const sw = loadWorker();
    expect(await sw.request("https://qa-project.supabase.co/storage/v1/object/sign/originals/u/x.jpg?token=t")).toBeNull();
    expect(sw.cachedUrls()).toEqual([]);
  });

  it("POST uploads are never touched", async () => {
    const sw = loadWorker();
    expect(await sw.request("/api/items/photo", { method: "POST" })).toBeNull();
  });

  it("a page navigation goes to the network and isn't cached", async () => {
    const sw = loadWorker();
    const res = await sw.request("/wardrobe", { mode: "navigate" });
    expect(await res!.text()).toBe("network");
    expect(sw.cachedUrls()).toEqual([]);
  });

  it("only hashed build assets are cached", async () => {
    const sw = loadWorker();
    await sw.request("/_next/static/chunks/app-abc123.js");
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.cachedUrls()).toEqual([`${ORIGIN}/_next/static/chunks/app-abc123.js`]);
  });

  it("an /api path that merely contains '_next/static' later in it isn't cached", async () => {
    const sw = loadWorker();
    expect(await sw.request("/api/items?q=/_next/static/")).toBeNull();
    expect(sw.cachedUrls()).toEqual([]);
  });
});
