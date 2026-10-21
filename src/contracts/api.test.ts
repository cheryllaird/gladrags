import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  CreateItemRequestSchema,
  ItemListQuerySchema,
  MagicLinkRequestSchema,
  ReturnPathSchema,
  VerifyCodeRequestSchema,
} from "@/contracts";
import { MOCK_SUGGESTED_TAGS } from "@/lib/mocks/fixtures";

const USER = "0a000000-0000-4000-8000-000000000001";
const KEY = (n: number, ext: string) => `${USER}/1a000000-0000-4000-8000-00000000000${n}.${ext}`;

describe("auth contracts", () => {
  it("normalises the email", () => {
    expect(MagicLinkRequestSchema.parse({ email: "  Cheryl@Example.COM " }).email).toBe("cheryl@example.com");
  });

  it("rejects a bad email", () => {
    expect(MagicLinkRequestSchema.safeParse({ email: "cheryl" }).success).toBe(false);
  });

  it.each(["/", "/wardrobe", "/outfits?style=work", "/items/abc#top"])("accepts return path %s", (path) => {
    expect(ReturnPathSchema.safeParse(path).success).toBe(true);
  });

  it.each(["https://evil.example.com", "//evil.example.com", "/\\evil.example.com", "wardrobe", "javascript:alert(1)"])(
    "rejects return path %s (open redirect)",
    (path) => {
      expect(ReturnPathSchema.safeParse(path).success).toBe(false);
    },
  );

  it("accepts a 6-digit code and rejects anything else", () => {
    expect(VerifyCodeRequestSchema.safeParse({ email: "a@example.com", code: "123456" }).success).toBe(true);
    expect(VerifyCodeRequestSchema.safeParse({ email: "a@example.com", code: "12345" }).success).toBe(false);
    expect(VerifyCodeRequestSchema.safeParse({ email: "a@example.com", code: "abcdef" }).success).toBe(false);
  });
});

describe("item routes", () => {
  const create = {
    source: "photo",
    sourceUrl: null,
    originalImageKey: KEY(1, "jpg"),
    cutoutImageKey: KEY(2, "png"),
    tags: MOCK_SUGGESTED_TAGS,
    tagsEdited: false,
  };

  it("accepts a photo item", () => {
    expect(CreateItemRequestSchema.safeParse(create).success).toBe(true);
  });

  it("requires link items to keep their URL", () => {
    expect(CreateItemRequestSchema.safeParse({ ...create, source: "link" }).success).toBe(false);
    expect(
      CreateItemRequestSchema.safeParse({ ...create, source: "link", sourceUrl: "https://shop.example.com/p" }).success,
    ).toBe(true);
  });

  it("rejects incomplete tags", () => {
    expect(CreateItemRequestSchema.safeParse({ ...create, tags: { category: "top" } }).success).toBe(false);
  });

  it("parses list filters and rejects unknown values", () => {
    expect(ItemListQuerySchema.parse({ category: "shoes", q: " loafers " })).toEqual({ category: "shoes", q: "loafers" });
    expect(ItemListQuerySchema.safeParse({ category: "bags" }).success).toBe(false);
  });
});

describe("error codes", () => {
  it("each have an HTTP status", () => {
    for (const code of API_ERROR_CODES) expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });
});
