/**
 * Recorded-style Gemini image-model replies (the generateContent response
 * shape of @google/genai), for tests of GeminiImageGenerationProvider. No
 * network: image generation couldn't be recorded live (the free-tier key
 * has no image quota), so these follow the documented response shape, with
 * the 832 x 1248 PNG fixture as the image.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeminiImageResponse } from "../gemini-image";

const GOOD_PNG_BASE64 = readFileSync(join(__dirname, "preview-832x1248.png")).toString("base64");

/** A normal reply: one image part, with usage metadata split by modality. */
export const GEMINI_IMAGE_REPLY_OK = {
  candidates: [
    {
      content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: GOOD_PNG_BASE64 } }] },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: {
    promptTokenCount: 2_150,
    candidatesTokenCount: 1_290,
    candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1_290 }],
    totalTokenCount: 3_440,
  },
} as GeminiImageResponse;

/** A reply with a short text part before the image (models sometimes add one), and no per-modality counts. */
export const GEMINI_IMAGE_REPLY_TEXT_THEN_IMAGE = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ text: "Here is the outfit." }, { inlineData: { mimeType: "image/png", data: GOOD_PNG_BASE64 } }],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 2_150, candidatesTokenCount: 1_300 },
} as GeminiImageResponse;

/** The prompt itself was refused. */
export const GEMINI_IMAGE_REPLY_PROMPT_BLOCKED = {
  promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
  usageMetadata: { promptTokenCount: 2_150, totalTokenCount: 2_150 },
} as GeminiImageResponse;

/** The image was refused after generation (no parts, an image safety finish). */
export const GEMINI_IMAGE_REPLY_IMAGE_SAFETY = {
  candidates: [{ content: { role: "model", parts: [] }, finishReason: "IMAGE_SAFETY" }],
  usageMetadata: { promptTokenCount: 2_150, candidatesTokenCount: 0 },
} as GeminiImageResponse;

/** Text only, no image (the model answered in words). */
export const GEMINI_IMAGE_REPLY_TEXT_ONLY = {
  candidates: [{ content: { role: "model", parts: [{ text: "I can't draw that." }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 2_150, candidatesTokenCount: 12 },
} as GeminiImageResponse;

/** No image and a finish reason that isn't a block. */
export const GEMINI_IMAGE_REPLY_NO_IMAGE = {
  candidates: [{ content: { role: "model", parts: [] }, finishReason: "NO_IMAGE" }],
} as GeminiImageResponse;

/** Usage metadata with nonsense counts: no cost is reported, so the estimate stands. */
export const GEMINI_IMAGE_REPLY_BAD_USAGE = {
  ...GEMINI_IMAGE_REPLY_OK,
  usageMetadata: { promptTokenCount: Number.NaN, candidatesTokenCount: -5 },
} as GeminiImageResponse;
