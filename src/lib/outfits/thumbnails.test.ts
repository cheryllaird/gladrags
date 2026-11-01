import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageInput } from "@/lib/ai/types";
import { FakeSupabase } from "@/test/fake-supabase";
import { COLOUR_RGB, swatchPng } from "@/test/fixtures/swatch-png";
import { entry } from "@/test/outfit-helpers";
import { RANKING_THUMBNAIL_PX } from "@/lib/images/server";
import { PlaceholderThumbnailSource, ResizingThumbnailSource, SupabaseImageStore, type ImageStore } from "./thumbnails";

const png = (): ImageInput => ({ data: swatchPng(COLOUR_RGB.navy), mimeType: "image/png" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResizingThumbnailSource", () => {
  it("never downloads a picture for an item waiting for a photo (image null): ranking uses its tags", async () => {
    const items = [entry(1, "top"), { ...entry(2, "shoes"), image: null }];
    const downloads: string[] = [];
    const store: ImageStore = {
      download: async (ref) => {
        downloads.push(ref.key);
        return png();
      },
    };
    const thumbs = await new ResizingThumbnailSource(store, async (image) => image).getThumbnails(items);
    expect([...thumbs.keys()]).toEqual([items[0]!.id]);
    expect(downloads).toEqual([items[0]!.image!.key]);
  });

  it("downloads each item's picture and shrinks it to ~256 px", async () => {
    const items = [entry(1, "top"), entry(2, "shoes")];
    const downloads: string[] = [];
    const store: ImageStore = {
      download: async (ref) => {
        downloads.push(ref.key);
        return png();
      },
    };
    const sizes: number[] = [];
    const source = new ResizingThumbnailSource(store, async (image, maxPx) => {
      sizes.push(maxPx);
      return { ...image, data: image.data.subarray(0, 8) };
    });
    const thumbs = await source.getThumbnails(items);
    expect([...thumbs.keys()]).toEqual(items.map((i) => i.id));
    expect(downloads).toEqual(items.map((i) => i.image!.key));
    expect(sizes).toEqual([RANKING_THUMBNAIL_PX, RANKING_THUMBNAIL_PX]);
    expect(RANKING_THUMBNAIL_PX).toBe(256);
    expect(thumbs.get(items[0]!.id)!.data).toHaveLength(8);
  });

  it("leaves out an item whose picture fails, and never sends the full-size image", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const items = [entry(1, "top"), entry(2, "shoes"), entry(3, "bottom")];
    const undecodable = new Uint8Array([0]);
    const store: ImageStore = {
      download: async (ref) => {
        if (ref.key === items[1]!.image!.key) throw new Error("gone"); // download fails
        if (ref.key === items[2]!.image!.key) return { data: undecodable, mimeType: "image/png" }; // resize fails
        return png();
      },
    };
    const resize = async (image: ImageInput) => {
      if (image.data === undecodable) throw new Error("decoder failed");
      return image;
    };
    const thumbs = await new ResizingThumbnailSource(store, resize).getThumbnails(items);
    expect([...thumbs.keys()]).toEqual([items[0]!.id]);
  });

  it("downloads a few at a time", async () => {
    const items = Array.from({ length: 20 }, (_, i) => entry(i + 1, "top"));
    let active = 0;
    let peak = 0;
    const store: ImageStore = {
      download: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        return png();
      },
    };
    const thumbs = await new ResizingThumbnailSource(store, async (i) => i).getThumbnails(items);
    expect(thumbs.size).toBe(20);
    expect(peak).toBeLessThanOrEqual(6);
  });
});

describe("SupabaseImageStore", () => {
  it("downloads from the private bucket and checks the real image type", async () => {
    const db = new FakeSupabase();
    db.objects.set("cutouts/u/a.png", swatchPng(COLOUR_RGB.red));
    db.objects.set("originals/u/b.jpg", new Uint8Array([1, 2, 3]));
    const store = new SupabaseImageStore(db.asClient());
    expect((await store.download({ bucket: "cutouts", key: "u/a.png" })).mimeType).toBe("image/png");
    await expect(store.download({ bucket: "originals", key: "u/b.jpg" })).rejects.toThrow("isn't JPEG, PNG or WebP");
    await expect(store.download({ bucket: "cutouts", key: "u/missing.png" })).rejects.toThrow("Object not found");
  });
});

describe("PlaceholderThumbnailSource", () => {
  it("returns a small PNG for every item", async () => {
    const thumbs = await new PlaceholderThumbnailSource().getThumbnails([entry(1, "top")]);
    expect(thumbs.get(entry(1, "top").id)!.mimeType).toBe("image/png");
  });
});
