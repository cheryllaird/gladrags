/**
 * Recorded image-model replies for tests (no network). Made by
 * scripts/make-preview-placeholders.mjs:
 * - GOOD: an 832 x 1248 PNG, the 2:3 portrait the checks expect.
 * - SQUARE: a 1024 x 1024 PNG, refused by the aspect-ratio check.
 * Plus hand-made bad replies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeImageReply } from "../fakes";

const read = (name: string) => new Uint8Array(readFileSync(join(__dirname, name)));

export const PREVIEW_REPLY_GOOD: FakeImageReply = { image: { data: read("preview-832x1248.png"), mimeType: "image/png" }, costPence: 3.1 };
export const PREVIEW_REPLY_SQUARE: FakeImageReply = { image: { data: read("preview-1024x1024.png"), mimeType: "image/png" } };
/** Bytes that claim to be a PNG but aren't an image. */
export const PREVIEW_REPLY_NOT_AN_IMAGE: FakeImageReply = { image: { data: new TextEncoder().encode("I can't draw that, but here's a description"), mimeType: "image/png" } };
export const PREVIEW_REPLY_BLOCKED: FakeImageReply = { blocked: "SAFETY" };
export const PREVIEW_REPLY_EMPTY: FakeImageReply = { noImage: true };
