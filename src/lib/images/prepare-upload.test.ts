/**
 * The parts of the client upload helper that don't need a browser. The
 * canvas work (resize, JPEG re-encode, background removal) is covered in a
 * real browser by tests/e2e/background-removal.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { UPLOAD_FIELDS } from "@/contracts";
import { buildPhotoUploadForm, jpegFileName } from "./prepare-upload";

describe("jpegFileName", () => {
  it.each([
    ["IMG_1234.HEIC", "IMG_1234.jpg"],
    ["shirt-mock-no-tags.png", "shirt-mock-no-tags.jpg"],
    ["photo", "photo.jpg"],
    ["", "photo.jpg"],
    [".heic", "photo.jpg"],
    ["my.holiday.shirt.jpeg", "my.holiday.shirt.jpg"],
  ])("%j becomes %j (keeping the name, so mock markers still work)", (input, expected) => {
    expect(jpegFileName(input)).toBe(expected);
  });
});

describe("buildPhotoUploadForm", () => {
  const original = { blob: new Blob([Uint8Array.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), width: 10, height: 10 };

  it("sends the original, the cut-out and the link under the contract's field names", () => {
    const cutout = new Blob([Uint8Array.from([0x89, 0x50])], { type: "image/png" });
    const form = buildPhotoUploadForm({ original, cutout, fileName: "IMG_1.jpg" }, "https://shop.example.com/p/1");
    expect((form.get(UPLOAD_FIELDS.original) as File).name).toBe("IMG_1.jpg");
    expect((form.get(UPLOAD_FIELDS.cutout) as File).type).toBe("image/png");
    expect(form.get(UPLOAD_FIELDS.sourceUrl)).toBe("https://shop.example.com/p/1");
  });

  it("leaves the cut-out and link out when there aren't any", () => {
    const form = buildPhotoUploadForm({ original, cutout: null, fileName: "IMG_1.jpg" });
    expect(form.has(UPLOAD_FIELDS.cutout)).toBe(false);
    expect(form.has(UPLOAD_FIELDS.sourceUrl)).toBe(false);
  });
});
