/**
 * The route stubs, called directly in mock mode. Checks they validate input
 * with the contracts and that what they return matches the contracts, so
 * the UI agents can rely on them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorSchema,
  ItemDraftResponseSchema,
  ItemListResponseSchema,
  ItemResponseSchema,
  LinkImportResponseSchema,
  MagicLinkResponseSchema,
  OutfitGenerationResponseSchema,
  OutfitListResponseSchema,
  OutfitResponseSchema,
  UsageSummarySchema,
  displayImageUrl,
  type Outfit,
} from "@/contracts";
import { MOCK_USER } from "@/lib/auth/session";
import { MOCK_ITEMS, MOCK_SUGGESTED_TAGS } from "@/lib/mocks/fixtures";
import { resetMockStore } from "@/lib/mocks/store";
import { DAILY_CAPS } from "@/lib/usage";
import * as account from "./account/route";
import * as magicLink from "./auth/magic-link/route";
import * as itemById from "./items/[id]/route";
import * as itemLinkCutout from "./items/link/cutout/route";
import * as itemLink from "./items/link/route";
import * as itemPhoto from "./items/photo/route";
import * as items from "./items/route";
import * as refine from "./outfits/[id]/refine/route";
import * as outfitById from "./outfits/[id]/route";
import * as outfits from "./outfits/route";
import * as usage from "./usage/route";

const BASE = "http://localhost:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function json(path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function photo(original: File | null, options: { cutout?: File; sourceUrl?: string } = {}): Request {
  const form = new FormData();
  if (original) form.set("original", original);
  if (options.cutout) form.set("cutout", options.cutout);
  if (options.sourceUrl) form.set("sourceUrl", options.sourceUrl);
  return new Request(`${BASE}/api/items/photo`, { method: "POST", body: form });
}

function linkCutout(meta: unknown, cutout?: File): Request {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  if (cutout) form.set("cutout", cutout);
  return new Request(`${BASE}/api/items/link/cutout`, { method: "POST", body: form });
}

// Files with real magic bytes: the server checks content, not the declared type.
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function fileOf(magic: number[], size: number, name: string, type: string): File {
  const bytes = new Uint8Array(Math.max(size, magic.length));
  bytes.set(magic);
  return new File([bytes], name, { type });
}
const jpeg = (size = 1024) => fileOf(JPEG_MAGIC, size, "photo.jpg", "image/jpeg");
const png = (size = 1024) => fileOf(PNG_MAGIC, size, "cutout.png", "image/png");

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = ApiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
  resetMockStore();
  delete (globalThis as { __gladragsMockUsage?: unknown }).__gladragsMockUsage;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("items", () => {
  it("lists the mock wardrobe", async () => {
    const res = await items.GET(json("/api/items", "GET"));
    expect(res.status).toBe(200);
    expect(ItemListResponseSchema.parse(await res.json()).items).toHaveLength(MOCK_ITEMS.length);
  });

  it("filters by category and searches descriptions", async () => {
    const res = await items.GET(json("/api/items?category=shoes&q=LOAFERS", "GET"));
    const body = ItemListResponseSchema.parse(await res.json());
    expect(body.items.map((i) => i.tags.description)).toEqual(["Tan suede loafers"]);
  });

  it("rejects an unknown filter value", async () => {
    await expectError(await items.GET(json("/api/items?category=bags", "GET")), 400, "bad_request");
  });

  it("includes an item without a cut-out, for the UI's fallback", async () => {
    const res = await items.GET(json("/api/items?category=outerwear", "GET"));
    const body = ItemListResponseSchema.parse(await res.json());
    const noCutout = body.items.find((i) => i.cutoutUrl === null);
    expect(noCutout && displayImageUrl(noCutout)).toBe(noCutout?.originalUrl);
  });

  it("uploads a photo with its cut-out, then saves the draft as an item", async () => {
    const upload = await itemPhoto.POST(photo(jpeg(), { cutout: png() }));
    expect(upload.status).toBe(200);
    const { draft } = ItemDraftResponseSchema.parse(await upload.json());
    expect(draft.source).toBe("photo");
    expect(draft.cutoutImageKey).not.toBeNull();

    const save = await items.POST(
      json("/api/items", "POST", {
        source: draft.source,
        sourceUrl: draft.sourceUrl,
        originalImageKey: draft.originalImageKey,
        cutoutImageKey: draft.cutoutImageKey,
        tags: draft.suggestedTags,
        tagsEdited: false,
      }),
    );
    expect(save.status).toBe(201);
    const { item } = ItemResponseSchema.parse(await save.json());
    expect(item.cutoutUrl).toBe(draft.cutoutUrl);

    const list = ItemListResponseSchema.parse(await (await items.GET(json("/api/items", "GET"))).json());
    expect(list.items).toHaveLength(MOCK_ITEMS.length + 1);
  });

  it("accepts a photo without a cut-out (removal failed on the phone) and saves it", async () => {
    const upload = await itemPhoto.POST(photo(jpeg()));
    const { draft } = ItemDraftResponseSchema.parse(await upload.json());
    expect(draft).toMatchObject({ cutoutImageKey: null, cutoutUrl: null });

    const save = await items.POST(
      json("/api/items", "POST", {
        source: "photo",
        sourceUrl: null,
        originalImageKey: draft.originalImageKey,
        cutoutImageKey: null,
        tags: MOCK_SUGGESTED_TAGS,
        tagsEdited: false,
      }),
    );
    expect(ItemResponseSchema.parse(await save.json()).item.cutoutUrl).toBeNull();
  });

  it("treats a photo with a sourceUrl as a link item (screenshot fallback)", async () => {
    const res = await itemPhoto.POST(photo(jpeg(), { sourceUrl: "https://blocked.example.com/p/1" }));
    const { draft } = ItemDraftResponseSchema.parse(await res.json());
    expect(draft).toMatchObject({ source: "link", sourceUrl: "https://blocked.example.com/p/1" });
  });

  it.each([
    ["no original", () => photo(null)],
    ["only a cut-out", () => photo(null, { cutout: png() })],
    ["a GIF original", () => photo(fileOf([0x47, 0x49, 0x46, 0x38], 64, "a.gif", "image/gif"))],
    ["a JPEG that's really text", () => photo(new File(["hello"], "photo.jpg", { type: "image/jpeg" }))],
    ["an original over 1.5 MB", () => photo(jpeg(1.5 * 1024 * 1024 + 1))],
    ["a JPEG cut-out (must be PNG)", () => photo(jpeg(), { cutout: jpeg() })],
    ["a cut-out over 2.5 MB", () => photo(jpeg(), { cutout: png(2.5 * 1024 * 1024 + 1) })],
    ["a non-http sourceUrl", () => photo(jpeg(), { sourceUrl: "javascript:alert(1)" })],
  ])("rejects a photo upload with %s", async (_label, makeRequest) => {
    await expectError(await itemPhoto.POST(makeRequest()), 400, "bad_request");
  });

  it("refuses to save images from another user's folder", async () => {
    const other = "0b000000-0000-4000-8000-000000000002";
    const res = await items.POST(
      json("/api/items", "POST", {
        source: "photo",
        sourceUrl: null,
        originalImageKey: `${other}/1a000000-0000-4000-8000-000000000099.jpg`,
        cutoutImageKey: `${MOCK_USER.id}/1a000000-0000-4000-8000-000000000099.png`,
        tags: MOCK_SUGGESTED_TAGS,
        tagsEdited: false,
      }),
    );
    await expectError(res, 400, "bad_request");
  });

  it("edits tags and marks them edited", async () => {
    const id = MOCK_ITEMS[0]!.id;
    const res = await itemById.PATCH(json(`/api/items/${id}`, "PATCH", { tags: MOCK_SUGGESTED_TAGS }), ctx(id));
    const { item } = ItemResponseSchema.parse(await res.json());
    expect(item.tagsEdited).toBe(true);
    expect(item.tags.description).toBe(MOCK_SUGGESTED_TAGS.description);
  });

  it("returns 404 for unknown or malformed IDs, and deletes items", async () => {
    await expectError(await itemById.GET(json("/api/items/x", "GET"), ctx("not-a-uuid")), 404, "not_found");
    const id = MOCK_ITEMS[0]!.id;
    expect((await itemById.DELETE(json(`/api/items/${id}`, "DELETE"), ctx(id))).status).toBe(200);
    await expectError(await itemById.GET(json(`/api/items/${id}`, "GET"), ctx(id)), 404, "not_found");
  });

  it("enforces the daily item cap", async () => {
    for (let i = 0; i < DAILY_CAPS.item_ingest; i++) {
      expect((await itemPhoto.POST(photo(jpeg()))).status).toBe(200);
    }
    const error = await expectError(await itemPhoto.POST(photo(jpeg())), 429, "daily_cap_reached");
    expect(error.cap?.kind).toBe("items_per_day");
  });
});

describe("link import (two steps)", () => {
  async function stepOne(url = "https://shop.example.com/p/1") {
    const res = await itemLink.POST(json("/api/items/link", "POST", { url }));
    return LinkImportResponseSchema.parse(await res.json());
  }

  it("step 1 stores the product image and returns it with the product details", async () => {
    const body = await stepOne();
    expect(body.status).toBe("ok");
    if (body.status === "ok") {
      expect(body.originalImageKey.startsWith(`${MOCK_USER.id}/`)).toBe(true);
      expect(body.product.title).toBeTruthy();
    }
  });

  async function okStepOne(url?: string) {
    const one = await stepOne(url);
    if (one.status !== "ok") throw new Error("expected ok");
    return one;
  }

  const usageToday = async () =>
    UsageSummarySchema.parse(await (await usage.GET(json("/api/usage", "GET"))).json()).itemsToday.used;

  it("step 2 attaches the cut-out and returns a tagged draft", async () => {
    const one = await okStepOne();
    const res = await itemLinkCutout.POST(linkCutout({ originalImageKey: one.originalImageKey }, png()));
    const { draft } = ItemDraftResponseSchema.parse(await res.json());
    expect(draft).toMatchObject({ source: "link", sourceUrl: one.sourceUrl, originalImageKey: one.originalImageKey });
    expect(draft.cutoutImageKey).not.toBeNull();
    expect(draft.suggestedTags).not.toBeNull();
  });

  it("step 2 works without a cut-out (tags the original)", async () => {
    const one = await okStepOne();
    const res = await itemLinkCutout.POST(linkCutout({ originalImageKey: one.originalImageKey }));
    expect(ItemDraftResponseSchema.parse(await res.json()).draft.cutoutImageKey).toBeNull();
  });

  it("uses the server's stored source URL, not one the client echoes back", async () => {
    const one = await okStepOne();
    const res = await itemLinkCutout.POST(
      linkCutout({ originalImageKey: one.originalImageKey, sourceUrl: "https://evil.example.com/" }),
    );
    expect(ItemDraftResponseSchema.parse(await res.json()).draft.sourceUrl).toBe(one.sourceUrl);
  });

  it("counts the item at step 2 (where tagging runs), not at step 1", async () => {
    const one = await okStepOne();
    expect(await usageToday()).toBe(0);
    await itemLinkCutout.POST(linkCutout({ originalImageKey: one.originalImageKey }, png()));
    expect(await usageToday()).toBe(1);
  });

  it("step 2 is single use: a replay gets not_found and isn't counted", async () => {
    const one = await okStepOne();
    const meta = { originalImageKey: one.originalImageKey };
    expect((await itemLinkCutout.POST(linkCutout(meta, png()))).status).toBe(200);
    await expectError(await itemLinkCutout.POST(linkCutout(meta, png())), 404, "not_found");
    expect(await usageToday()).toBe(1);
  });

  it("step 2 enforces the daily cap, even for an import started before the cap was hit", async () => {
    const one = await okStepOne();
    for (let i = 0; i < DAILY_CAPS.item_ingest; i++) await itemPhoto.POST(photo(jpeg()));
    const res = await itemLinkCutout.POST(linkCutout({ originalImageKey: one.originalImageKey }, png()));
    await expectError(res, 429, "daily_cap_reached");
    // Step 1 refuses too, once the cap is reached.
    const again = await itemLink.POST(json("/api/items/link", "POST", { url: "https://shop.example.com/p/2" }));
    await expectError(again, 429, "daily_cap_reached");
  });

  it("step 2 refuses an import that isn't the user's, or that never existed", async () => {
    const otherUsersKey = "0b000000-0000-4000-8000-000000000002/1a000000-0000-4000-8000-000000000099.jpg";
    await expectError(await itemLinkCutout.POST(linkCutout({ originalImageKey: otherUsersKey }, png())), 404, "not_found");
    await expectError(await itemLinkCutout.POST(linkCutout({ originalImageKey: "nope" })), 400, "bad_request");
  });

  it.each([
    ["https://blocked.example.com/p/1", "fetch_blocked"],
    ["https://nodata.example.com/p/1", "no_product_data"],
    ["https://noimage.example.com/p/1", "no_image"],
  ])("asks for a screenshot for %s (%s)", async (url, reason) => {
    expect(await stepOne(url)).toMatchObject({ status: "needs_screenshot", reason, sourceUrl: url });
  });

  it("rejects a non-http link", async () => {
    await expectError(await itemLink.POST(json("/api/items/link", "POST", { url: "ftp://x.example.com" })), 400, "bad_request");
  });
});

describe("outfits", () => {
  async function generate(body: unknown) {
    const res = await outfits.POST(json("/api/outfits", "POST", body));
    return { res, body: OutfitGenerationResponseSchema.parse(await res.clone().json()) };
  }

  it("returns 4 valid outfits by default", async () => {
    const { body } = await generate({ style: { kind: "preset", presetId: "smart_casual" } });
    expect(body.status).toBe("ok");
    if (body.status === "ok") expect(body.outfits).toHaveLength(4);
  });

  it("builds every outfit around the anchor item", async () => {
    const anchor = MOCK_ITEMS.find((i) => i.tags.category === "dress_jumpsuit")!;
    const { body } = await generate({ style: { kind: "preset", presetId: "wedding_guest" }, anchorItemId: anchor.id, count: 3 });
    expect(body.status).toBe("ok");
    if (body.status === "ok") for (const o of body.outfits) expect(o.itemIds).toContain(anchor.id);
  });

  it("returns 404 for an anchor that isn't in the wardrobe", async () => {
    const res = await outfits.POST(
      json("/api/outfits", "POST", {
        style: { kind: "preset", presetId: "work" },
        anchorItemId: "9f000000-0000-4000-8000-000000000000",
      }),
    );
    await expectError(res, 404, "not_found");
  });

  it("says which category is missing, and fills it with a gap", async () => {
    for (const item of MOCK_ITEMS.filter((i) => i.tags.category === "shoes")) {
      await itemById.DELETE(json(`/api/items/${item.id}`, "DELETE"), ctx(item.id));
    }
    const { body } = await generate({ style: { kind: "preset", presetId: "casual" } });
    expect(body).toMatchObject({ status: "ok", missingCategories: ["shoes"] });
    if (body.status === "ok") for (const o of body.outfits) expect(o.gaps.map((g) => g.category)).toEqual(["shoes"]);
  });

  it("rejects a bad request body", async () => {
    await expectError(await outfits.POST(json("/api/outfits", "POST", { style: "work", count: 9 })), 400, "bad_request");
    const notJson = new Request(`${BASE}/api/outfits`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    await expectError(await outfits.POST(notJson), 400, "bad_request");
    const notLabelledJson = new Request(`${BASE}/api/outfits`, { method: "POST", body: JSON.stringify({ style: "work" }) });
    await expectError(await outfits.POST(notLabelledJson), 415, "unsupported_media_type");
  });

  describe("with a generated outfit", () => {
    let outfit: Outfit;

    beforeEach(async () => {
      const { body } = await generate({ style: { kind: "preset", presetId: "work" }, count: 3 });
      if (body.status !== "ok") throw new Error("expected outfits");
      outfit = body.outfits[0]!;
    });

    it("saves it and lists it under saved", async () => {
      const res = await outfitById.PATCH(json(`/api/outfits/${outfit.id}`, "PATCH", { status: "saved" }), ctx(outfit.id));
      expect(OutfitResponseSchema.parse(await res.json()).outfit.status).toBe("saved");
      const list = OutfitListResponseSchema.parse(await (await outfits.GET(json("/api/outfits?status=saved", "GET"))).json());
      expect(list.outfits.map((o) => o.id)).toEqual([outfit.id]);
    });

    it("swaps an item and links the new outfits to their parent", async () => {
      const swapped = outfit.itemIds[0]!;
      const res = await refine.POST(json(`/api/outfits/${outfit.id}/refine`, "POST", { kind: "swap", itemId: swapped }), ctx(outfit.id));
      const body = OutfitGenerationResponseSchema.parse(await res.json());
      expect(body.status).toBe("ok");
      if (body.status === "ok") {
        for (const o of body.outfits) {
          expect(o.parentOutfitId).toBe(outfit.id);
          expect(o.itemIds).not.toContain(swapped);
        }
      }
    });

    it("refuses to swap an item that isn't in the outfit", async () => {
      const other = MOCK_ITEMS.find((i) => !outfit.itemIds.includes(i.id))!;
      const res = await refine.POST(json(`/api/outfits/${outfit.id}/refine`, "POST", { kind: "swap", itemId: other.id }), ctx(outfit.id));
      await expectError(res, 400, "bad_request");
    });

    it("refines with guidance and keeps it on the request", async () => {
      const res = await refine.POST(json(`/api/outfits/${outfit.id}/refine`, "POST", { kind: "guidance", text: "warmer" }), ctx(outfit.id));
      const body = OutfitGenerationResponseSchema.parse(await res.json());
      if (body.status === "ok") expect(body.outfits[0]?.request.guidance).toBe("warmer");
    });
  });
});

describe("usage, auth and account", () => {
  it("reports usage", async () => {
    await itemPhoto.POST(photo(jpeg()));
    const summary = UsageSummarySchema.parse(await (await usage.GET(json("/api/usage", "GET"))).json());
    expect(summary.itemsToday).toEqual({ used: 1, limit: DAILY_CAPS.item_ingest });
    expect(summary.aiPaused).toBe(false);
  });

  it("sends a magic link to an invited email", async () => {
    const res = await magicLink.POST(json("/api/auth/magic-link", "POST", { email: "cheryl@example.com" }));
    expect(MagicLinkResponseSchema.parse(await res.json())).toEqual({ sent: true });
  });

  it("turns away an email that isn't on the allowlist", async () => {
    const res = await magicLink.POST(json("/api/auth/magic-link", "POST", { email: "not-invited@example.com" }));
    await expectError(res, 403, "not_invited");
  });

  it("deletes the account (mock: resets the data)", async () => {
    await itemById.DELETE(json("/x", "DELETE"), ctx(MOCK_ITEMS[0]!.id));
    expect((await account.DELETE(json("/api/account", "DELETE"))).status).toBe(200);
    const list = ItemListResponseSchema.parse(await (await items.GET(json("/api/items", "GET"))).json());
    expect(list.items).toHaveLength(MOCK_ITEMS.length);
  });
});

describe("mock markers for the UI's fallback and error states", () => {
  const named = (name: string) => fileOf(JPEG_MAGIC, 512, name, "image/jpeg");

  it("mock-no-tags in a photo's file name returns empty suggested tags", async () => {
    const res = await itemPhoto.POST(photo(named("shirt-mock-no-tags.jpg")));
    expect(ItemDraftResponseSchema.parse(await res.json()).draft.suggestedTags).toBeNull();
  });

  it("mock-ai-paused and mock-daily-cap in a photo's file name return those errors", async () => {
    await expectError(await itemPhoto.POST(photo(named("mock-ai-paused.jpg"))), 503, "ai_paused");
    const error = await expectError(await itemPhoto.POST(photo(named("mock-daily-cap.jpg"))), 429, "daily_cap_reached");
    expect(error.cap?.kind).toBe("items_per_day");
  });

  it("mock-no-tags in a link makes step 2 return empty tags", async () => {
    const one = LinkImportResponseSchema.parse(
      await (await itemLink.POST(json("/api/items/link", "POST", { url: "https://shop.example.com/p?t=mock-no-tags" }))).json(),
    );
    if (one.status !== "ok") throw new Error("expected ok");
    const res = await itemLinkCutout.POST(linkCutout({ originalImageKey: one.originalImageKey }));
    expect(ItemDraftResponseSchema.parse(await res.json()).draft.suggestedTags).toBeNull();
  });

  it("markers in a link, outfit guidance or custom style return cap errors", async () => {
    await expectError(await itemLink.POST(json("/api/items/link", "POST", { url: "https://shop.example.com/mock-ai-paused" })), 503, "ai_paused");
    const outfitsError = await expectError(
      await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, guidance: "mock-daily-cap" })),
      429,
      "daily_cap_reached",
    );
    expect(outfitsError.cap?.kind).toBe("outfit_requests_per_day");
    await expectError(
      await outfits.POST(json("/api/outfits", "POST", { style: { kind: "custom", text: "party mock-ai-paused" } })),
      503,
      "ai_paused",
    );
  });
});

describe("anchor-aware incomplete wardrobe", () => {
  it("says bottom is missing for a top anchor when there are no bottoms, despite a dress", async () => {
    for (const item of MOCK_ITEMS.filter((i) => i.tags.category === "bottom")) {
      await itemById.DELETE(json(`/api/items/${item.id}`, "DELETE"), ctx(item.id));
    }
    const top = MOCK_ITEMS.find((i) => i.tags.category === "top")!;
    const res = await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" }, anchorItemId: top.id }));
    const body = OutfitGenerationResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ status: "ok", missingCategories: ["bottom"] });
    if (body.status === "ok") {
      for (const o of body.outfits) {
        expect(o.itemIds).toContain(top.id);
        expect(o.gaps.map((g) => g.category)).toContain("bottom");
      }
    }
  });
});

describe("outside mock mode", () => {
  it("stubs refuse to serve mock data (and fail safe without Supabase config)", async () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    // No Supabase env here, so requireUser can't run: the route reports a
    // configuration error instead of serving data.
    const res = await items.GET(json("/api/items", "GET"));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = ApiErrorSchema.parse(await res.json());
    expect(["server_misconfigured", "internal"]).toContain(body.error.code);
  });
});
