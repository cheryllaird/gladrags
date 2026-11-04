import { describe, expect, it, vi } from "vitest";
import type { BatchAddResponse, ItemDraft, ItemTags, WardrobeItem } from "@/contracts";
import {
  MAX_BATCH_SIZE,
  addByPhoto,
  addLinksForReview,
  addPhotosForReview,
  addScreenshotForReview,
  extractLinks,
  finishLinkImport,
  linkFromShare,
  summariseBatch,
  type AddStage,
  type BatchEntryState,
  type PipelineDeps,
} from "./add-item";
import { ApiClientError } from "./api";

const KEY = "0a000000-0000-4000-8000-000000000001/1b000000-0000-4000-8000-000000000001.jpg";
const DRAFT: ItemDraft = {
  source: "photo",
  sourceUrl: null,
  originalImageKey: KEY,
  cutoutImageKey: null,
  originalUrl: "/mock/items/uploaded.svg",
  cutoutUrl: null,
  suggestedTags: null,
};
const TAGS: ItemTags = {
  category: "top",
  subcategory: "shirt",
  colours: ["white"],
  pattern: "plain",
  formality: 3,
  seasons: ["spring"],
  warmth: "light",
  occasions: ["work"],
  fabric: null,
  description: "White shirt",
};
const ITEM: WardrobeItem = {
  id: "0a000000-0000-4000-8000-0000000000aa",
  source: "photo",
  sourceUrl: null,
  originalUrl: "/mock/items/uploaded.svg",
  cutoutUrl: null,
  tags: TAGS,
  tagsEdited: false,
  needsReview: true,
  needsPhoto: false,
  createdAt: "2026-10-31T10:00:00.000Z",
};
const SAVED: BatchAddResponse = { status: "saved", item: ITEM };

const capError = () =>
  new ApiClientError("daily_cap_reached", "Cap", {
    status: 429,
    cap: { kind: "items_per_day", limit: 40, resetsAt: "2026-11-01T00:00:00.000Z" },
  });

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    prepare: vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" })),
    uploadPhoto: vi.fn(async () => DRAFT),
    uploadPhotoForReview: vi.fn(async () => SAVED),
    importLink: vi.fn(async (url: string) => ({
      status: "ok" as const,
      sourceUrl: url,
      originalImageKey: KEY,
      originalUrl: "/mock/items/uploaded.svg",
      product: { title: null, brand: null, colour: null },
    })),
    finishLink: vi.fn(async () => ({ ...DRAFT, source: "link" as const })),
    finishLinkForReview: vi.fn(async () => SAVED),
    ...overrides,
  };
}

const photo = (name: string) => new File(["raw"], name, { type: "image/heic" });

describe("addByPhoto", () => {
  it("prepares and uploads the original only, reporting each stage", async () => {
    const d = deps();
    const stages: AddStage[] = [];
    const result = await addByPhoto(photo("IMG_0001.HEIC"), { deps: d, onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["preparing", "uploading"]);
    expect(result.draft).toBe(DRAFT);
    const sent = vi.mocked(d.uploadPhoto).mock.calls[0]![0];
    // A HEIC photo goes up as a JPEG; no cut-out is sent any more.
    expect(sent.original.name).toBe("IMG_0001.jpg");
    expect(sent).not.toHaveProperty("cutout");
  });

  it("keeps mock markers in the uploaded file name", async () => {
    const d = deps();
    await addByPhoto(photo("shirt-mock-no-tags.png"), { deps: d });
    expect(vi.mocked(d.uploadPhoto).mock.calls[0]![0].original.name).toBe("shirt-mock-no-tags.jpg");
  });

  it("passes the source link for the screenshot fallback", async () => {
    const d = deps();
    await addByPhoto(photo("shot.png"), { deps: d, sourceUrl: "https://shop.example.com/p" });
    expect(vi.mocked(d.uploadPhoto).mock.calls[0]![0].sourceUrl).toBe("https://shop.example.com/p");
  });

  it("stops before uploading if the photo can't be read", async () => {
    const d = deps({ prepare: vi.fn(async () => Promise.reject(new Error("unreadable"))) });
    await expect(addByPhoto(photo("x.heic"), { deps: d })).rejects.toThrow("unreadable");
    expect(d.uploadPhoto).not.toHaveBeenCalled();
  });

  it("lets upload errors through for the screen to show", async () => {
    const d = deps({ uploadPhoto: vi.fn(async () => Promise.reject(capError())) });
    await expect(addByPhoto(photo("x.jpg"), { deps: d })).rejects.toMatchObject({ code: "daily_cap_reached" });
  });
});

describe("finishLinkImport", () => {
  it("tags the stored product image by its key, with no cut-out", async () => {
    const d = deps();
    const result = await finishLinkImport({ originalImageKey: KEY }, { deps: d });
    expect(d.finishLink).toHaveBeenCalledWith(KEY);
    expect(result.draft.source).toBe("link");
  });
});

describe("addPhotosForReview", () => {
  it("uploads one after another with saveForReview, reporting every change", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const d = deps({
      uploadPhotoForReview: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return SAVED;
      }),
    });
    const changes: [number, BatchEntryState["kind"]][] = [];
    const outcome = await addPhotosForReview([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")], (i, s) => changes.push([i, s.kind]), d);
    expect(maxInFlight).toBe(1);
    expect(outcome.stoppedBy).toBeNull();
    expect(outcome.states.map((s) => s.kind)).toEqual(["saved", "saved", "saved"]);
    expect(changes.filter(([, kind]) => kind === "saved").map(([i]) => i)).toEqual([0, 1, 2]);
  });

  it("a photo whose tagging failed comes back as a draft to fill in", async () => {
    const d = deps({
      uploadPhotoForReview: vi
        .fn()
        .mockResolvedValueOnce(SAVED)
        .mockResolvedValueOnce({ status: "draft", draft: DRAFT } satisfies BatchAddResponse),
    });
    const outcome = await addPhotosForReview([photo("a.jpg"), photo("b-mock-no-tags.jpg")], () => {}, d);
    expect(outcome.states[1]).toEqual({ kind: "draft", draft: DRAFT });
  });

  it("a photo that fails on its own doesn't stop the rest", async () => {
    const d = deps({
      prepare: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("Can't read that photo"), { name: "PhotoPrepError" }))
        .mockResolvedValue(new Blob(["jpeg"])),
    });
    const outcome = await addPhotosForReview([photo("bad.heic"), photo("good.jpg")], () => {}, d);
    expect(outcome.states.map((s) => s.kind)).toEqual(["failed", "saved"]);
    expect(outcome.stoppedBy).toBeNull();
  });

  it("stops cleanly at the daily cap: that photo and the rest aren't added", async () => {
    const d = deps({
      uploadPhotoForReview: vi.fn().mockResolvedValueOnce(SAVED).mockResolvedValueOnce(SAVED).mockRejectedValue(capError()),
    });
    const files = ["a", "b", "c", "d", "e"].map((n) => photo(`${n}.jpg`));
    const outcome = await addPhotosForReview(files, () => {}, d);
    expect(outcome.states.map((s) => s.kind)).toEqual(["saved", "saved", "not_added", "not_added", "not_added"]);
    expect(outcome.stoppedBy).toMatchObject({ code: "daily_cap_reached" });
    // Nothing more was tried after the cap.
    expect(d.uploadPhotoForReview).toHaveBeenCalledTimes(3);
    expect(summariseBatch(outcome.states)).toMatchObject({ total: 5, saved: 2, notAdded: 3, finished: 5 });
  });

  it.each(["ai_paused", "unauthorized", "network"] as const)("stops on %s too", async (code) => {
    const d = deps({ uploadPhotoForReview: vi.fn().mockRejectedValue(new ApiClientError(code, "x")) });
    const outcome = await addPhotosForReview([photo("a.jpg"), photo("b.jpg")], () => {}, d);
    expect(outcome.states.map((s) => s.kind)).toEqual(["not_added", "not_added"]);
    expect(d.uploadPhotoForReview).toHaveBeenCalledTimes(1);
  });

  it("keeps HEIC handling: every photo goes through prepare (resize + JPEG)", async () => {
    const d = deps();
    await addPhotosForReview([photo("IMG_1.HEIC"), photo("IMG_2.heic")], () => {}, d);
    expect(d.prepare).toHaveBeenCalledTimes(2);
    const names = vi.mocked(d.uploadPhotoForReview).mock.calls.map((c) => c[0].original.name);
    expect(names).toEqual(["IMG_1.jpg", "IMG_2.jpg"]);
  });
});

describe("addLinksForReview", () => {
  it("runs both steps for each link in turn, and leaves unreadable sites for a screenshot", async () => {
    const d = deps({
      importLink: vi.fn(async (url: string) =>
        url.includes("blocked")
          ? { status: "needs_screenshot" as const, reason: "fetch_blocked" as const, sourceUrl: url, message: "Couldn't read it" }
          : { status: "ok" as const, sourceUrl: url, originalImageKey: KEY, originalUrl: "/x", product: { title: null, brand: null, colour: null } },
      ),
    });
    const outcome = await addLinksForReview(["https://a.example/p", "https://blocked.example/p", "https://c.example/p"], () => {}, d);
    expect(outcome.states.map((s) => s.kind)).toEqual(["saved", "needs_screenshot", "saved"]);
    expect(outcome.states[1]).toMatchObject({ sourceUrl: "https://blocked.example/p", message: "Couldn't read it" });
    expect(d.finishLinkForReview).toHaveBeenCalledTimes(2);
    expect(d.finishLinkForReview).toHaveBeenCalledWith(KEY);
  });

  it("stops at the daily cap from step 1", async () => {
    const d = deps({ importLink: vi.fn().mockRejectedValue(capError()) });
    const outcome = await addLinksForReview(["https://a.example/p", "https://b.example/p"], () => {}, d);
    expect(outcome.states.map((s) => s.kind)).toEqual(["not_added", "not_added"]);
    expect(d.importLink).toHaveBeenCalledTimes(1);
  });

  it("an expired import (not_found) fails that link only", async () => {
    const d = deps({ finishLinkForReview: vi.fn().mockRejectedValueOnce(new ApiClientError("not_found", "x")).mockResolvedValue(SAVED) });
    const outcome = await addLinksForReview(["https://a.example/p", "https://b.example/p"], () => {}, d);
    expect(outcome.states.map((s) => s.kind)).toEqual(["failed", "saved"]);
  });
});

describe("addScreenshotForReview", () => {
  it("uploads the screenshot with the link, saved for review", async () => {
    const d = deps();
    const state = await addScreenshotForReview(photo("shot.png"), "https://blocked.example/p", d);
    expect(state).toEqual({ kind: "saved", item: ITEM });
    expect(vi.mocked(d.uploadPhotoForReview).mock.calls[0]![0]).toMatchObject({
      sourceUrl: "https://blocked.example/p",
      original: { name: "shot.jpg" },
    });
  });
});

describe("extractLinks", () => {
  it("one per line", () => {
    expect(extractLinks("https://a.example/1\nhttps://b.example/2\n\n  https://c.example/3  ").links).toEqual([
      "https://a.example/1",
      "https://b.example/2",
      "https://c.example/3",
    ]);
  });

  it("finds links in a block of text and drops the punctuation around them", () => {
    const text = "Got these: https://a.example/shirt, and (https://b.example/jeans). Also <https://c.example/p?x=1&y=2>!";
    expect(extractLinks(text).links).toEqual(["https://a.example/shirt", "https://b.example/jeans", "https://c.example/p?x=1&y=2"]);
  });

  it("keeps a closing bracket that belongs to the link", () => {
    expect(extractLinks("see https://en.example/wiki/Shirt_(garment).").links).toEqual(["https://en.example/wiki/Shirt_(garment)"]);
  });

  it("removes duplicates, including ones that differ only in host case or a missing slash", () => {
    expect(extractLinks("https://a.example/p https://a.example/p https://A.EXAMPLE/p https://b.example https://b.example/").links).toEqual([
      "https://a.example/p",
      "https://b.example",
    ]);
  });

  it("ignores things that aren't http(s) links", () => {
    expect(extractLinks("ftp://a.example/x javascript:alert(1) www.example.com mailto:x@y.z").links).toEqual([]);
  });

  it(`takes at most ${MAX_BATCH_SIZE} and says how many more there were`, () => {
    const text = Array.from({ length: MAX_BATCH_SIZE + 3 }, (_, i) => `https://shop.example/p/${i}`).join("\n");
    const { links, extra } = extractLinks(text);
    expect(links).toHaveLength(MAX_BATCH_SIZE);
    expect(extra).toBe(3);
  });
});

describe("linkFromShare", () => {
  it("uses the shared url when there is one", () => {
    expect(linkFromShare({ url: "https://shop.example.com/p/1", text: null })).toBe("https://shop.example.com/p/1");
  });

  it("finds the link inside shared text (Android often sends it there)", () => {
    expect(linkFromShare({ url: null, text: "Look at this https://shop.example.com/p/2 nice" })).toBe(
      "https://shop.example.com/p/2",
    );
  });

  it("is empty when nothing looks like a link", () => {
    expect(linkFromShare({ url: "", text: "hello" })).toBe("");
  });
});

describe("extractLinks after review", () => {
  it("cuts off non-ASCII characters stuck to the host", () => {
    expect(extractLinks("https://a.example“and https://b.exampleé/p").links).toEqual(["https://a.example", "https://b.example"]);
  });

  it("strips guillemets and full-width punctuation", () => {
    expect(extractLinks("«https://a.example/p» https://b.example/q。").links).toEqual(["https://a.example/p", "https://b.example/q"]);
  });
});

describe("aborting a batch (the user left the screen)", () => {
  it("finishes the photo in flight, then marks the rest not added", async () => {
    const controller = new AbortController();
    const d = deps({
      uploadPhotoForReview: vi.fn(async () => {
        controller.abort();
        return SAVED;
      }),
    });
    const outcome = await addPhotosForReview([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")], () => {}, d, controller.signal);
    expect(outcome.aborted).toBe(true);
    expect(outcome.stoppedBy).toBeNull();
    expect(outcome.states.map((s) => s.kind)).toEqual(["saved", "not_added", "not_added"]);
    expect(d.uploadPhotoForReview).toHaveBeenCalledTimes(1);
  });

  it("a link batch checks the signal before each link too", async () => {
    const controller = new AbortController();
    controller.abort();
    const d = deps();
    const outcome = await addLinksForReview(["https://a.example/p"], () => {}, d, controller.signal);
    expect(outcome.states.map((s) => s.kind)).toEqual(["not_added"]);
    expect(d.importLink).not.toHaveBeenCalled();
  });
});
