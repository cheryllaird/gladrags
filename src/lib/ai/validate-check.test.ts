/**
 * callWithValidation's semantic `check`: schema and semantic failures share
 * the single retry (at most 2 calls). The ranking pattern from
 * docs/CONTRACTS.md, section 6.
 */
import { describe, expect, it } from "vitest";
import { RankingFinalOutputSchema, checkRankedOutfits, type Category, type RankingFinalOutput } from "@/contracts";
import { ITEM_IDS, finalPick } from "@/test/fixtures/model-output";
import type { ModelCall } from "./types";
import { callWithValidation } from "./validate";

const known = new Map<string, Category>([
  [ITEM_IDS.shirt, "top"],
  [ITEM_IDS.chinos, "bottom"],
  [ITEM_IDS.dress, "dress_jumpsuit"],
  [ITEM_IDS.loafers, "shoes"],
]);

const dressOutfit = { outfits: [{ itemIds: [ITEM_IDS.dress, ITEM_IDS.loafers], name: "Garden party", reason: "Florals and tan" }] };

/** The pattern outfit-engine uses: reject the reply if any outfit is invalid. */
function rankingCheck(anchorItemId?: string) {
  return (data: RankingFinalOutput) => {
    const { rejected } = checkRankedOutfits(data.outfits, known, { anchorItemId });
    return rejected.length ? rejected.map((r) => r.problem).join("; ") : null;
  };
}

function replies(...raws: unknown[]) {
  let i = 0;
  const calls: number[] = [];
  const call = async (): Promise<ModelCall> => {
    calls.push(i);
    const raw = raws[Math.min(i++, raws.length - 1)];
    if (raw instanceof Error) throw raw;
    return { raw, provider: "fake", model: "fake" };
  };
  return { call, calls };
}

describe("callWithValidation with a semantic check", () => {
  it("passes when schema and check both pass", async () => {
    const { call } = replies(finalPick.valid);
    const result = await callWithValidation(RankingFinalOutputSchema, call, { check: rankingCheck() });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
  });

  it("retries once when the check fails (missing anchor), then succeeds", async () => {
    const { call, calls } = replies(finalPick.valid, dressOutfit);
    const result = await callWithValidation(RankingFinalOutputSchema, call, { check: rankingCheck(ITEM_IDS.dress) });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(calls).toHaveLength(2);
  });

  it("shares ONE retry between schema and semantic failures: never a third call", async () => {
    const { call, calls } = replies(finalPick.missingReason, finalPick.valid, dressOutfit);
    const result = await callWithValidation(RankingFinalOutputSchema, call, { check: rankingCheck(ITEM_IDS.dress) });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[1]).toMatch(/anchor/);
    }
  });

  it("rejects invented item IDs via the check", async () => {
    const invented = { outfits: [{ itemIds: [ITEM_IDS.shirt, ITEM_IDS.chinos, "9f000000-0000-4000-8000-000000000000"], name: "X", reason: "Y" }] };
    const { call } = replies(invented, invented);
    const result = await callWithValidation(RankingFinalOutputSchema, call, { check: rankingCheck() });
    expect(result.ok).toBe(false);
  });

  it("records a thrown attempt with no cost, so the estimate applies", async () => {
    const { call } = replies(new Error("timeout"), finalPick.valid);
    const costs: (number | undefined)[] = [];
    const result = await callWithValidation(RankingFinalOutputSchema, call, { onCall: (c) => void costs.push(c.costPence) });
    expect(result.ok).toBe(true);
    expect(costs).toEqual([undefined, undefined]);
  });
});
