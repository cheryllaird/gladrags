// QA (milestone 5, C5): adversarial cases for pasted links and batch adds.
import { describe, expect, it, vi } from "vitest";
import type { BatchAddResponse, ItemDraft, WardrobeItem } from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { batchSummaryCopy } from "@/components/wardrobe/add/batch-copy";
import {
  MAX_BATCH_SIZE,
  addLinksForReview,
  addPhotosForReview,
  extractLinks,
  stopsBatch,
  summariseBatch,
  type BatchEntryState,
  type PipelineDeps,
} from "./add-item";
import { ApiClientError } from "./api";

const ITEM = { ...MOCK_ITEMS[0]!, needsReview: true } as WardrobeItem;
const DRAFT: ItemDraft = {
  source: "photo",
  sourceUrl: null,
  originalImageKey: "0a000000-0000-4000-8000-000000000001/x.jpg",
  cutoutImageKey: null,
  originalUrl: "/mock/items/uploaded.svg",
  cutoutUrl: null,
  suggestedTags: null,
};

const photo = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
const cap = () => new ApiClientError("daily_cap_reached", "Cap", { status: 429 });
const paused = () => new ApiClientError("ai_paused", "Paused", { status: 503 });
const offline = () => new ApiClientError("network", "Couldn't reach GladRags.");

/** Deps whose photo upload answers per file name: "bad" fails to prepare, "cap"/"paused"/"offline"/"draft" as named. */
function deps(): PipelineDeps {
  return {
    prepare: vi.fn(async (file: Blob) => {
      if ((file as File).name.includes("bad")) throw new ApiClientError("bad_request", "Couldn't read that photo");
      return file;
    }),
    uploadPhoto: vi.fn(),
    uploadPhotoForReview: vi.fn(async ({ original }: { original: { name: string } }): Promise<BatchAddResponse> => {
      if (original.name.includes("cap")) throw cap();
      if (original.name.includes("paused")) throw paused();
      if (original.name.includes("offline")) throw offline();
      if (original.name.includes("draft")) return { status: "draft", draft: DRAFT };
      return { status: "saved", item: ITEM };
    }),
    importLink: vi.fn(async (url: string) => {
      if (url.includes("blocked")) {
        return { status: "needs_screenshot", reason: "fetch_blocked", sourceUrl: url, message: "Blocked" } as const;
      }
      if (url.includes("cap")) throw cap();
      return {
        status: "ok",
        sourceUrl: url,
        originalImageKey: `k-${url}`,
        originalUrl: "/x",
        product: { title: "", brand: "", colour: "" },
      } as const;
    }),
    finishLink: vi.fn(),
    finishLinkForReview: vi.fn(async (key: string): Promise<BatchAddResponse> => {
      if (key.includes("step2cap")) throw cap();
      return { status: "saved", item: ITEM };
    }),
  } as unknown as PipelineDeps;
}

describe("extractLinks: messy pasted text", () => {
  it("handles tabs, commas, quotes, markdown links, brackets and trailing punctuation", () => {
    const text = [
      "Order:\thttps://a.example/1, https://b.example/2;",
      'He said "https://c.example/3" and \'https://d.example/4\'.',
      "[Shirt](https://e.example/5) [https://f.example/6] {https://g.example/7}",
      "Wow https://h.example/8!!! and https://i.example/9?... and `https://j.example/10`",
    ].join("\n");
    expect(extractLinks(text).links).toEqual([
      "https://a.example/1",
      "https://b.example/2",
      "https://c.example/3",
      "https://d.example/4",
      "https://e.example/5",
      "https://f.example/6",
      "https://g.example/7",
      "https://h.example/8",
      "https://i.example/9",
      "https://j.example/10",
    ]);
  });

  // Fixed after review: a comma-separated list with no spaces ("a,b") used to read as one link.
  it("splits links joined by a comma with no space", () => {
    expect(extractLinks("https://a.example/1,https://b.example/2").links).toEqual(["https://a.example/1", "https://b.example/2"]);
  });

  it("keeps query strings and balanced brackets in the path", () => {
    expect(extractLinks("(see https://a.example/p_(red)?size=10&c=2)").links).toEqual(["https://a.example/p_(red)?size=10&c=2"]);
  });

  it("removes exact duplicates even with the same tracking parameters", () => {
    const link = "https://shop.example/p/1?utm_source=insta&utm_medium=social";
    expect(extractLinks(`${link}\n${link}\n${link}.`).links).toEqual([link]);
  });

  it("treats links that differ only in tracking parameters or a #fragment as one, keeping the first as pasted", () => {
    // Fixed after review: the same product pasted from an email and from a browser used to run twice.
    expect(
      extractLinks("https://shop.example/p/1\nhttps://shop.example/p/1?utm_source=email&fbclid=x#reviews\nhttps://shop.example/p/1?gclid=y").links,
    ).toEqual(["https://shop.example/p/1"]);
    // Other parameters still make a different page.
    expect(extractLinks("https://shop.example/p/1?size=10\nhttps://shop.example/p/1?size=12").links).toHaveLength(2);
  });

  it("never returns a non-http(s) scheme", () => {
    const text = [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "chrome://settings",
      "about:blank",
      "vbscript:msgbox",
      "blob:https://a.example/uuid",
      "ftp://a.example/x",
      "ws://a.example",
      "hxxps://a.example/x",
      "https://",
      "http://",
    ].join("\n");
    const { links } = extractLinks(text);
    for (const link of links) expect(link).toMatch(/^https?:\/\//i);
    // The only link-shaped text is the https URL inside the blob: one, which is an ordinary link.
    expect(links).toEqual(["https://a.example/uuid"]);
  });

  it("accepts upper-case schemes", () => {
    expect(extractLinks("HTTPS://A.EXAMPLE/P").links).toHaveLength(1);
  });

  it("1,000 links: takes the first 40 in order and counts the rest, quickly", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `item ${i}: https://shop.example/p/${i}?ref=x.`).join(" ");
    const started = performance.now();
    const { links, extra } = extractLinks(text);
    expect(performance.now() - started).toBeLessThan(500);
    expect(links).toHaveLength(MAX_BATCH_SIZE);
    expect(links[0]).toBe("https://shop.example/p/0?ref=x");
    expect(links[39]).toBe("https://shop.example/p/39?ref=x");
    expect(extra).toBe(960);
  });

  it("1,000 copies of 10 links are 10 links, no extra", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `https://shop.example/p/${i}`);
    const { links, extra } = extractLinks(Array.from({ length: 100 }, () => ten.join("\n")).join("\n"));
    expect(links).toEqual(ten);
    expect(extra).toBe(0);
  });

  it("drops links over 2,048 characters rather than sending them", () => {
    expect(extractLinks(`https://a.example/${"x".repeat(2100)}`).links).toEqual([]);
  });

  // Phones autocorrect quotes to curly ones and Notes adds an ellipsis
  // character; these end up glued to the link. Fixed after review.
  it("drops curly quotes and an ellipsis character after a link", () => {
    expect(extractLinks("“https://a.example/p” and https://b.example/q… and https://c.example/r’").links).toEqual([
      "https://a.example/p",
      "https://b.example/q",
      "https://c.example/r",
    ]);
  });
});

describe("photo batches", () => {
  it("one photo, two photos and 45 photos all run in order, one at a time", async () => {
    for (const n of [1, 2, 45]) {
      const d = deps();
      let inFlight = 0;
      let max = 0;
      const upload = d.uploadPhotoForReview;
      d.uploadPhotoForReview = vi.fn(async (arg) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight--;
        return upload(arg);
      });
      const files = Array.from({ length: n }, (_, i) => photo(`p${i}.jpg`));
      const { states, stoppedBy } = await addPhotosForReview(files, () => {}, d);
      expect(stoppedBy).toBeNull();
      expect(summariseBatch(states)).toMatchObject({ total: n, saved: n, finished: n });
      expect(max).toBe(1);
      expect(vi.mocked(d.uploadPhotoForReview).mock.calls.map((c) => c[0].original.name)).toEqual(files.map((f) => f.name));
    }
  });

  it("HEIC is renamed to .jpg for upload (the bytes were re-encoded)", async () => {
    const d = deps();
    await addPhotosForReview([new File([new Uint8Array([1])], "IMG_0001.HEIC", { type: "image/heic" })], () => {}, d);
    expect(vi.mocked(d.uploadPhotoForReview).mock.calls[0]![0].original.name).toBe("IMG_0001.jpg");
  });

  it("an unreadable file in the middle fails alone", async () => {
    const d = deps();
    const { states, stoppedBy } = await addPhotosForReview([photo("a.jpg"), photo("bad.jpg"), photo("c.jpg")], () => {}, d);
    expect(stoppedBy).toBeNull();
    expect(states.map((s) => s.kind)).toEqual(["saved", "failed", "saved"]);
    const copy = batchSummaryCopy("photo", states, stoppedBy);
    expect(copy.title).toBe("Done");
    expect(copy.lines).toContain("2 items are in your wardrobe, marked to review.");
    expect(copy.lines).toContain("1 couldn't be added (see below).");
  });

  it("the cap mid-batch: counts are right with a draft and a failure before it", async () => {
    const d = deps();
    const files = ["a.jpg", "draft.jpg", "bad.jpg", "b.jpg", "cap.jpg", "c.jpg", "e.jpg"].map(photo);
    const { states, stoppedBy } = await addPhotosForReview(files, () => {}, d);
    expect(stoppedBy).toBeInstanceOf(ApiClientError);
    expect(states.map((s) => s.kind)).toEqual(["saved", "draft", "failed", "saved", "not_added", "not_added", "not_added"]);
    // Nothing is sent after the cap.
    expect(d.uploadPhotoForReview).toHaveBeenCalledTimes(4);
    const copy = batchSummaryCopy("photo", states, stoppedBy);
    expect(copy.stopped).toBe("cap");
    expect(copy.lines[0]).toBe("2 were added before it stopped; the other 3 photos weren't.");
    expect(copy.lines).toContain("1 couldn't be tagged automatically: fill in the tags in the review list.");
    expect(copy.lines).toContain("1 couldn't be added (see below).");
  });

  it("the cap on the very first photo", async () => {
    const { states, stoppedBy } = await addPhotosForReview([photo("cap.jpg"), photo("b.jpg")], () => {}, deps());
    expect(batchSummaryCopy("photo", states, stoppedBy).lines[0]).toBe("0 were added before it stopped; the other 2 photos weren't.");
  });

  it("the cap on the last photo leaves one 'not added'", async () => {
    const { states } = await addPhotosForReview([photo("a.jpg"), photo("cap.jpg")], () => {}, deps());
    expect(summariseBatch(states)).toMatchObject({ saved: 1, notAdded: 1 });
  });

  // Copy bug, fixed after review: it used to say "the other 1 photo weren't."
  it("says 'wasn't' when one photo wasn't added", async () => {
    const { states, stoppedBy } = await addPhotosForReview([photo("a.jpg"), photo("cap.jpg")], () => {}, deps());
    expect(batchSummaryCopy("photo", states, stoppedBy).lines[0]).not.toMatch(/1 photo weren't/);
  });

  it("AI paused and going offline stop the batch too", async () => {
    for (const name of ["paused.jpg", "offline.jpg"]) {
      const d = deps();
      const { states, stoppedBy } = await addPhotosForReview([photo("a.jpg"), photo(name), photo("c.jpg")], () => {}, d);
      expect(stopsBatch(stoppedBy)).toBe(true);
      expect(states.map((s) => s.kind)).toEqual(["saved", "not_added", "not_added"]);
      expect(d.uploadPhotoForReview).toHaveBeenCalledTimes(2);
    }
  });

  it("an invalid response or a server error doesn't stop the batch", async () => {
    const d = deps();
    let n = 0;
    d.uploadPhotoForReview = vi.fn(async () => {
      n++;
      if (n === 1) throw new ApiClientError("invalid_response", "odd");
      if (n === 2) throw new ApiClientError("internal", "500");
      return { status: "saved", item: ITEM } as BatchAddResponse;
    });
    const { states } = await addPhotosForReview([photo("a"), photo("b"), photo("c")], () => {}, d);
    expect(states.map((s) => s.kind)).toEqual(["failed", "failed", "saved"]);
  });

  it("reports every row change in order, ending with the final state", async () => {
    const changes: [number, BatchEntryState["kind"]][] = [];
    await addPhotosForReview([photo("a.jpg"), photo("cap.jpg"), photo("c.jpg")], (i, s) => changes.push([i, s.kind]), deps());
    expect(changes.at(-1)).toEqual([2, "not_added"]);
    expect(changes.filter(([i]) => i === 0).at(-1)).toEqual([0, "saved"]);
  });
});

describe("link batches", () => {
  it("screenshot-fallback rows don't stop the batch and are counted", async () => {
    const d = deps();
    const { states, stoppedBy } = await addLinksForReview(
      ["https://a.example/1", "https://blocked.example/2", "https://c.example/3"],
      () => {},
      d,
    );
    expect(stoppedBy).toBeNull();
    expect(states.map((s) => s.kind)).toEqual(["saved", "needs_screenshot", "saved"]);
    // No step 2 for the blocked one.
    expect(d.finishLinkForReview).toHaveBeenCalledTimes(2);
    const copy = batchSummaryCopy("link", states, stoppedBy);
    expect(copy.lines).toContain("1 link needs a screenshot: the site couldn't be read. Add them below.");
  });

  it("the cap at step 1 or at step 2 stops the batch and nothing more is fetched", async () => {
    const d = deps();
    const { states } = await addLinksForReview(["https://a.example/1", "https://cap.example/2", "https://c.example/3"], () => {}, d);
    expect(states.map((s) => s.kind)).toEqual(["saved", "not_added", "not_added"]);
    expect(d.importLink).toHaveBeenCalledTimes(2);

    const d2 = deps();
    const r2 = await addLinksForReview(["https://a.example/step2cap", "https://c.example/3"], () => {}, d2);
    expect(r2.states.map((s) => s.kind)).toEqual(["not_added", "not_added"]);
    expect(d2.importLink).toHaveBeenCalledTimes(1);
  });

  it("a stopped link batch with screenshot rows still lists them", async () => {
    const { states, stoppedBy } = await addLinksForReview(
      ["https://blocked.example/1", "https://cap.example/2"],
      () => {},
      deps(),
    );
    const copy = batchSummaryCopy("link", states, stoppedBy);
    expect(summariseBatch(states)).toMatchObject({ saved: 0, needsScreenshot: 1, notAdded: 1 });
    expect(copy.lines).toContain("1 link needs a screenshot: the site couldn't be read. Add them below.");
  });
});
