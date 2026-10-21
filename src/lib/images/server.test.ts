import { describe, expect, it } from "vitest";
import { MAX_CUTOUT_BYTES, MAX_ORIGINAL_BYTES } from "@/contracts";
import { ANY_ACCEPTED_TYPE, checkImage, sniffImageType } from "./server";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("sniffImageType", () => {
  it("recognises JPEG, PNG and WebP from their first bytes", () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe1))).toBe("image/jpeg");
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
  });

  it("rejects everything else, whatever the file claims to be", () => {
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38))).toBeNull(); // GIF
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBeNull(); // WAV
    expect(sniffImageType(bytes())).toBeNull();
  });
});

describe("checkImage", () => {
  const original = { allowedTypes: ANY_ACCEPTED_TYPE, maxBytes: MAX_ORIGINAL_BYTES };
  const cutout = { allowedTypes: ["image/png"] as const, maxBytes: MAX_CUTOUT_BYTES };

  it("accepts a resized photo and a PNG cut-out", () => {
    expect(checkImage({ mimeType: "image/jpeg", width: 1200, height: 1600, bytes: 700_000 }, original)).toBeNull();
    expect(checkImage({ mimeType: "image/png", width: 1200, height: 1600, bytes: 2_000_000 }, cutout)).toBeNull();
  });

  it("rejects images that weren't resized", () => {
    expect(checkImage({ mimeType: "image/jpeg", width: 3024, height: 4032, bytes: 900_000 }, original)).toMatch(/1600 px/);
  });

  it("rejects oversize files and the wrong type", () => {
    expect(checkImage({ mimeType: "image/jpeg", width: 100, height: 100, bytes: MAX_ORIGINAL_BYTES + 1 }, original)).toMatch(/MB/);
    expect(checkImage({ mimeType: "image/jpeg", width: 100, height: 100, bytes: 1000 }, cutout)).toMatch(/PNG/);
  });

  it("rejects an empty image", () => {
    expect(checkImage({ mimeType: "image/png", width: 0, height: 10, bytes: 10 }, cutout)).toMatch(/empty/);
  });
});
