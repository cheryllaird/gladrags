import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_ITEMS, MOCK_SUGGESTED_TAGS } from "@/lib/mocks/fixtures";
import {
  ApiClientError,
  createItem,
  finishLink,
  finishLinkForReview,
  getSettings,
  importLink,
  listEmailImports,
  listItems,
  markItemReviewed,
  markItemsReviewed,
  replaceItemPhoto,
  resetForwardingAddress,
  updateFavouriteShops,
  updateItemTags,
  uploadPhoto,
  uploadPhotoForReview,
} from "./api";

const KEY = "0a000000-0000-4000-8000-000000000001/1b000000-0000-4000-8000-000000000001.jpg";

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listItems", () => {
  it("sends only the filters that are set", async () => {
    const fetchMock = respond(200, { items: MOCK_ITEMS });
    await listItems({ category: "top", q: "  linen " });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/items?category=top&q=linen");
  });

  it("parses the response with the contract", async () => {
    respond(200, { items: MOCK_ITEMS });
    const items = await listItems();
    expect(items).toHaveLength(MOCK_ITEMS.length);
  });

  it("rejects a response that doesn't match the contract", async () => {
    respond(200, { items: [{ id: "not-a-uuid" }] });
    await expect(listItems()).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("errors", () => {
  it("turns an API error body into an ApiClientError with its cap details", async () => {
    const cap = { kind: "items_per_day", limit: 40, resetsAt: "2026-10-26T00:00:00+01:00" };
    respond(429, { error: { code: "daily_cap_reached", message: "You've reached today's limit", cap } });
    const error = await listItems().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code: "daily_cap_reached", status: 429, cap, message: "You've reached today's limit" });
  });

  it("reports a network failure plainly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(listItems()).rejects.toMatchObject({ code: "network" });
  });

  it("treats an error without a contract body as internal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));
    await expect(listItems()).rejects.toMatchObject({ code: "internal", status: 502 });
  });
});

describe("requests are checked against the contracts before sending", () => {
  it("refuses to save tags the schema rejects, without calling the API", async () => {
    const fetchMock = respond(200, {});
    await expect(updateItemTags(MOCK_ITEMS[0]!.id, { ...MOCK_SUGGESTED_TAGS, subcategory: "jeans" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a link item without its source URL", async () => {
    const fetchMock = respond(201, {});
    await expect(
      createItem({ source: "link", sourceUrl: null, originalImageKey: KEY, cutoutImageKey: null, tags: MOCK_SUGGESTED_TAGS, tagsEdited: false }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a link that isn't http or https", async () => {
    const fetchMock = respond(200, {});
    await expect(importLink("javascript:alert(1)")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("uploads", () => {
  const draft = {
    source: "photo",
    sourceUrl: null,
    originalImageKey: KEY,
    cutoutImageKey: null,
    originalUrl: "/mock/items/uploaded.svg",
    cutoutUrl: null,
    suggestedTags: null,
  };

  it("sends the photo and the source link as multipart fields, and never a cut-out", async () => {
    const fetchMock = respond(200, { draft });
    await uploadPhoto({
      original: { blob: new Blob(["jpeg"], { type: "image/jpeg" }), name: "shirt-mock-no-tags.jpg" },
      sourceUrl: "https://shop.example.com/p/1",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/items/photo");
    const form = init!.body as FormData;
    expect((form.get("original") as File).name).toBe("shirt-mock-no-tags.jpg");
    expect(form.get("sourceUrl")).toBe("https://shop.example.com/p/1");
    expect(form.has("cutout")).toBe(false);
    expect(form.has("saveForReview")).toBe(false);
  });

  it("a batch photo is sent with saveForReview and returns saved or draft", async () => {
    const fetchMock = respond(200, { status: "draft", draft });
    const result = await uploadPhotoForReview({ original: { blob: new Blob(["jpeg"]), name: "a.jpg" } });
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(form.get("saveForReview")).toBe("true");
    expect(form.has("sourceUrl")).toBe(false);
    expect(result.status).toBe("draft");
  });

  it("sends only the image key as link step 2's meta", async () => {
    const fetchMock = respond(200, { draft: { ...draft, source: "link", sourceUrl: "https://shop.example.com/p/1" } });
    await finishLink(KEY);
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(form.get("meta") as string)).toEqual({ originalImageKey: KEY });
    expect(form.has("cutout")).toBe(false);
  });

  it("a batch link's step 2 adds saveForReview to the meta", async () => {
    const fetchMock = respond(200, { status: "saved", item: MOCK_ITEMS[0] });
    const result = await finishLinkForReview(KEY);
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(form.get("meta") as string)).toEqual({ originalImageKey: KEY, saveForReview: true });
    expect(result.status).toBe("saved");
  });

  it("a later photo for an item goes to PUT /api/items/:id/photo as `original`", async () => {
    const fetchMock = respond(200, { item: MOCK_ITEMS[0] });
    await replaceItemPhoto(MOCK_ITEMS[0]!.id, { blob: new Blob(["jpeg"]), name: "p.jpg" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/items/${MOCK_ITEMS[0]!.id}/photo`);
    expect(init!.method).toBe("PUT");
    expect((init!.body as FormData).has("original")).toBe(true);
  });
});

describe("reviewing", () => {
  it("lists only items to review with needsReview=true", async () => {
    const fetchMock = respond(200, { items: [] });
    await listItems({ needsReview: true });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/items?needsReview=true");
  });

  it("confirms one item with { reviewed: true }", async () => {
    const fetchMock = respond(200, { item: MOCK_ITEMS[0] });
    await markItemReviewed(MOCK_ITEMS[0]!.id);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ reviewed: true });
  });

  it("confirm all: de-duplicates and sends at most 100 IDs a request", async () => {
    const fetchMock = respond(200, { updated: 1 });
    const ids = Array.from({ length: 150 }, (_, i) => `0a000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const updated = await markItemsReviewed([...ids, ids[0]!]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).itemIds).toHaveLength(100);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).itemIds).toHaveLength(50);
    expect(updated).toBe(2);
  });
});

describe("settings", () => {
  const settings = { favouriteShopIds: ["next"], forwardingAddress: "0123456789abcdef0123456789abcdef@inbound.gladrags.test" };

  it("reads, changes shops and resets the address", async () => {
    const fetchMock = respond(200, settings);
    await getSettings();
    await updateFavouriteShops(["next", "zara"]);
    await resetForwardingAddress();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      ["/api/settings", "GET"],
      ["/api/settings", "PUT"],
      ["/api/settings/forwarding-address", "POST"],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ favouriteShopIds: ["next", "zara"] });
  });

  it("refuses an empty shop list before sending", async () => {
    const fetchMock = respond(200, settings);
    await expect(updateFavouriteShops([])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists email imports", async () => {
    respond(200, { imports: [] });
    expect(await listEmailImports()).toEqual([]);
  });
});
