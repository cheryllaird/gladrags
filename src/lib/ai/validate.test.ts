import { describe, expect, it } from "vitest";
import { RankingShortlistOutputSchema, TaggingModelOutputSchema } from "@/contracts";
import { shortlist, tagging } from "@/test/fixtures/model-output";
import { FakeRankingProvider, FakeTaggingProvider } from "./fakes";
import type { ModelCall } from "./types";
import { callWithValidation } from "./validate";

const IMAGE = { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" as const };

describe("callWithValidation", () => {
  it("returns valid output on the first try", async () => {
    const provider = new FakeTaggingProvider([tagging.valid]);
    const result = await callWithValidation(TaggingModelOutputSchema, () => provider.tagItem({ image: IMAGE }));
    expect(result).toEqual({ ok: true, data: tagging.valid, attempts: 1 });
  });

  it("retries once after bad output, and succeeds", async () => {
    const provider = new FakeTaggingProvider([tagging.invalidCategory, tagging.valid]);
    const result = await callWithValidation(TaggingModelOutputSchema, () => provider.tagItem({ image: IMAGE }));
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });

  it("gives up after the retry so the caller can fall back (empty tags)", async () => {
    const provider = new FakeTaggingProvider([tagging.truncatedJson, tagging.inventedColour, tagging.valid]);
    const result = await callWithValidation(TaggingModelOutputSchema, () => provider.tagItem({ image: IMAGE }));
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(2); // never a third call
    if (!result.ok) expect(result.errors).toHaveLength(2);
  });

  it("treats a provider error as a failed attempt", async () => {
    let calls = 0;
    const result = await callWithValidation(RankingShortlistOutputSchema, async (): Promise<ModelCall> => {
      calls++;
      if (calls === 1) throw new Error("503 from provider");
      return { raw: shortlist.valid, provider: "fake", model: "fake" };
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(2);
  });

  it("reports every call so its cost can be recorded, valid or not", async () => {
    const provider = new FakeRankingProvider({ shortlist: [shortlist.notUuids, shortlist.valid], final: [{}] });
    const seen: ModelCall[] = [];
    await callWithValidation(
      RankingShortlistOutputSchema,
      () =>
        provider.shortlist({
          request: { style: { kind: "preset", presetId: "work" } },
          avoidPairs: [],
          items: [],
          candidates: [],
          shortlistSize: 8,
        }),
      { onCall: (call) => void seen.push(call) },
    );
    expect(seen).toHaveLength(2);
  });
});
