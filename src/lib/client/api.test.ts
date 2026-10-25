import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_ITEMS, MOCK_SUGGESTED_TAGS } from "@/lib/mocks/fixtures";
import { ApiClientError, createItem, importLink, listItems, updateItemTags, uploadLinkCutout, uploadPhoto } from "./api";

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

  it("sends the photo, the cut-out and the source link as multipart fields", async () => {
    const fetchMock = respond(200, { draft });
    await uploadPhoto({
      original: { blob: new Blob(["jpeg"], { type: "image/jpeg" }), name: "shirt-mock-no-tags.jpg" },
      cutout: { blob: new Blob(["png"], { type: "image/png" }), name: "shirt-mock-no-tags.png" },
      sourceUrl: "https://shop.example.com/p/1",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/items/photo");
    const form = init!.body as FormData;
    expect((form.get("original") as File).name).toBe("shirt-mock-no-tags.jpg");
    expect((form.get("cutout") as File).type).toBe("image/png");
    expect(form.get("sourceUrl")).toBe("https://shop.example.com/p/1");
  });

  it("leaves the cut-out out when there isn't one", async () => {
    const fetchMock = respond(200, { draft });
    await uploadPhoto({ original: { blob: new Blob(["jpeg"]), name: "a.jpg" }, cutout: null });
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(form.has("cutout")).toBe(false);
    expect(form.has("sourceUrl")).toBe(false);
  });

  it("sends only the image key as link step 2's meta", async () => {
    const fetchMock = respond(200, { draft: { ...draft, source: "link", sourceUrl: "https://shop.example.com/p/1" } });
    await uploadLinkCutout({ originalImageKey: KEY, cutout: null });
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(form.get("meta") as string)).toEqual({ originalImageKey: KEY });
  });
});
