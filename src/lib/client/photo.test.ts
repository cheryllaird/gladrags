import { describe, expect, it } from "vitest";
import { MAX_IMAGE_DIMENSION_PX } from "@/contracts";
import { fitWithin, renameWithExtension } from "./photo";

describe("fitWithin", () => {
  it("scales a phone photo down so its longest side is 1600 px", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(MAX_IMAGE_DIMENSION_PX).toBe(1600);
  });

  it("never scales a small image up", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it("keeps very thin images at least 1 px wide", () => {
    expect(fitWithin(10000, 2)).toEqual({ width: 1600, height: 1 });
  });
});

describe("renameWithExtension", () => {
  it("swaps the extension and keeps the rest of the name", () => {
    expect(renameWithExtension("IMG_0042.HEIC", "jpg")).toBe("IMG_0042.jpg");
    expect(renameWithExtension("shirt-mock-no-tags.png", "jpg")).toBe("shirt-mock-no-tags.jpg");
    expect(renameWithExtension("my.photo.webp", "png")).toBe("my.photo.png");
  });

  it("adds an extension to a name without one, and names a nameless file", () => {
    expect(renameWithExtension("camera", "jpg")).toBe("camera.jpg");
    expect(renameWithExtension("", "jpg")).toBe("photo.jpg");
  });
});
