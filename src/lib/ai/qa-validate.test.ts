/**
 * QA gap tests for callWithValidation (CLAUDE.md: "validate, retry once,
 * then fall back"). Pins the attempt count exactly and covers the failure
 * paths the builder's tests leave open.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RankingFinalOutputSchema,
  RankingShortlistOutputSchema,
  TaggingModelOutputSchema,
  checkRankedOutfits,
  type Category,
} from "@/contracts";
import { ITEM_IDS, shortlist, tagging } from "@/test/fixtures/model-output";
import { FakeTaggingProvider } from "./fakes";
import type { ModelCall } from "./types";
import { callWithValidation } from "./validate";

const IMAGE = { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" as const };

function counting(outputs: (unknown | Error)[]) {
  let calls = 0;
  const call = async (): Promise<ModelCall> => {
    const next = outputs[Math.min(calls++, outputs.length - 1)];
    if (next instanceof Error) throw next;
    return { raw: next, provider: "fake", model: "fake" };
  };
  return { call, calls: () => calls };
}

describe("callWithValidation retries exactly once", () => {
  it("makes exactly 2 calls when every output is bad, then reports both errors", async () => {
    const { call, calls } = counting([tagging.prose]);
    const result = await callWithValidation(TaggingModelOutputSchema, call);
    expect(calls()).toBe(2);
    expect(result).toMatchObject({ ok: false, attempts: 2 });
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors.every((e) => e.includes("not valid JSON"))).toBe(true);
    }
  });

  it("makes exactly 2 calls when the provider throws both times", async () => {
    const { call, calls } = counting([new Error("quota exceeded")]);
    const result = await callWithValidation(TaggingModelOutputSchema, call);
    expect(calls()).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(["Provider error: quota exceeded", "Provider error: quota exceeded"]);
  });

  it("handles a mix: throw, then bad output -> fail after 2", async () => {
    const { call, calls } = counting([new Error("timeout"), tagging.inventedColour, tagging.valid]);
    const result = await callWithValidation(TaggingModelOutputSchema, call);
    expect(calls()).toBe(2);
    expect(result.ok).toBe(false);
  });

  it("handles a non-Error throw", async () => {
    const result = await callWithValidation(TaggingModelOutputSchema, async () => {
      throw "plain string";
    });
    expect(result).toMatchObject({ ok: false, errors: ["Provider error: plain string", "Provider error: plain string"] });
  });

  it("makes exactly 1 call when the first output is valid", async () => {
    const { call, calls } = counting([tagging.valid, tagging.prose]);
    const result = await callWithValidation(TaggingModelOutputSchema, call);
    expect(calls()).toBe(1);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
  });

  it("returns the parsed data (trimmed, extra keys stripped), not the raw output", async () => {
    const raw = { ...tagging.valid, description: "  Navy slim-fit chinos  ", confidence: 0.4 };
    const result = await callWithValidation(TaggingModelOutputSchema, async () => ({ raw, provider: "fake", model: "fake" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.description).toBe("Navy slim-fit chinos");
      expect(result.data).not.toHaveProperty("confidence");
    }
  });

  // Updated by foundations (review item 5): a thrown attempt may still be
  // billed, so onCall reports it too, with no cost so the estimate is used.
  it("calls onCall for thrown attempts too, with no cost (so the estimate is recorded)", async () => {
    const seen: ModelCall[] = [];
    const { call } = counting([new Error("boom"), tagging.valid]);
    await callWithValidation(TaggingModelOutputSchema, call, { onCall: (c) => void seen.push(c), provider: "gemini" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ raw: undefined, costPence: undefined, provider: "gemini", error: "boom" });
  });

  it("awaits an async onCall before validating, so the cost is recorded first", async () => {
    const order: string[] = [];
    await callWithValidation(TaggingModelOutputSchema, async () => ({ raw: tagging.prose, provider: "fake", model: "fake" }), {
      onCall: async () => {
        await new Promise((r) => setTimeout(r, 1));
        order.push("recorded");
      },
    });
    expect(order).toEqual(["recorded", "recorded"]);
  });

  it("propagates an onCall failure (e.g. the usage table is down) instead of swallowing it", async () => {
    const promise = callWithValidation(TaggingModelOutputSchema, async () => ({ raw: tagging.valid, provider: "fake", model: "fake" }), {
      onCall: () => {
        throw new Error("couldn't record usage");
      },
    });
    await expect(promise).rejects.toThrow("couldn't record usage");
  });

  it("the fake tagging provider gives the fallback path: two bad replies then null tags", async () => {
    const provider = new FakeTaggingProvider([tagging.missingFields, tagging.formalityAsString]);
    const result = await callWithValidation(TaggingModelOutputSchema, () => provider.tagItem({ image: IMAGE }));
    // The caller's fallback per spec: show the user empty tags.
    const suggestedTags = result.ok ? result.data : null;
    expect(suggestedTags).toBeNull();
    expect(provider.calls).toHaveLength(2);
  });
});

describe("ranking: retrying on unknown IDs and broken composition", () => {
  // Spec pipeline step 4: "reject any outfit with an unknown item ID or a
  // broken composition rule, then retry once". callWithValidation only
  // retries on schema failure, so outfit-engine has to fold
  // checkRankedOutfits into the schema it passes. This shows the pattern
  // works with the current helper.
  const known = new Map<string, Category>([
    [ITEM_IDS.shirt, "top"],
    [ITEM_IDS.chinos, "bottom"],
    [ITEM_IDS.jeans, "bottom"],
    [ITEM_IDS.loafers, "shoes"],
    [ITEM_IDS.trainers, "shoes"],
    [ITEM_IDS.blazer, "outerwear"],
    [ITEM_IDS.dress, "dress_jumpsuit"],
  ]);
  const checked = RankingShortlistOutputSchema.superRefine((out, ctx) => {
    for (const { problem } of checkRankedOutfits(out.outfits, known).rejected) ctx.addIssue({ code: "custom", message: problem });
  });

  it("retries once when the first shortlist invents an item ID, and accepts a clean second one", async () => {
    const invented = { outfits: [{ itemIds: [ITEM_IDS.shirt, ITEM_IDS.chinos, "9f000000-0000-4000-8000-000000000000"] }] };
    const { call, calls } = counting([invented, shortlist.valid]);
    const result = await callWithValidation(checked, call);
    expect(calls()).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("fails (ai_failed) when both shortlists break the composition rule", async () => {
    const twoBottoms = { outfits: [{ itemIds: [ITEM_IDS.jeans, ITEM_IDS.chinos, ITEM_IDS.loafers] }] };
    const result = await callWithValidation(checked, counting([twoBottoms]).call);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/one top and one bottom/);
  });

  it("final pick with a fenced JSON string still validates", async () => {
    const final = { outfits: [{ itemIds: [ITEM_IDS.dress, ITEM_IDS.loafers], name: "Garden party", reason: "Florals and tan" }] };
    const raw = "```json\n" + JSON.stringify(final) + "\n```";
    const result = await callWithValidation(RankingFinalOutputSchema, async () => ({ raw, provider: "fake", model: "fake" }));
    expect(result.ok).toBe(true);
  });

  it("works with any schema (generic over T)", async () => {
    const result = await callWithValidation(z.object({ n: z.int() }), async () => ({ raw: '{"n": 2}', provider: "x", model: "x" }));
    expect(result).toEqual({ ok: true, data: { n: 2 }, attempts: 1 });
  });
});
