# Outfit engine

Owner: outfit-engine agent. Spec: `docs/SPEC.md` → "Outfit suggestions" and "Cost controls". Contracts: `docs/CONTRACTS.md` sections 4–7.

The model only chooses and explains. Code decides what's wearable, and no item ID outside the user's wardrobe ever reaches a response.

## Files

| File | What | Pure? |
| --- | --- | --- |
| `filter.ts` | Step 1: drop items that clearly don't fit the style or season | yes |
| `candidates.ts` | Step 2: wearable combinations, bounded for big wardrobes; "avoid" pairs from rejected outfits | yes (randomness passed in) |
| `validate.ts` | Step 4: check the model's picks (wardrobe, composition, anchor, kept items, repeats) | yes |
| `season.ts` | Today's UK season | yes |
| `pipeline.ts` | Steps 1–4 joined up, with the two ranking passes | no I/O of its own |
| `service.ts` | What routes call: caps, wardrobe loading, refinement, feedback, saving | |
| `repository.ts` | Storage interface; `supabase-repository.ts` (real) and `mock-repository.ts` (mock mode) | |
| `thumbnails.ts` | ~256 px pictures for pass 2, behind `ThumbnailSource` | |
| `mock-ranking.ts` | Mock mode's no-network "model" | |
| `config.ts` | The tuning numbers below | |
| `index.ts` | `getOutfitService()`: real or mock wiring | |

The Gemini provider for both passes is `src/lib/ai/gemini-ranking.ts`.

## Pipeline

1. **Missing categories.** If no outfit is possible at all (taking the anchor into account), answer `incomplete_wardrobe / missing_category` with what to add. No AI, not counted.
2. **Filter** (`filter.ts`):
   - Preset style: keep items inside the formality band, or one point outside it if they're tagged for that occasion.
   - **Custom (typed) style: no formality filter**, because it has no band. The model judges fit from the text, and candidates keep formality coherent (below). *Flagged for Cheryl.*
   - Season: today's UK season (meteorological). Holiday ignores the season.
   - The anchor and items kept in a swap always stay.
   - **Relaxing:** if the strict filter gives fewer candidates than the request's `count`, try again without the season, then also with any item one point outside the band. Use the strictest level that gives enough, otherwise the one that gives the most.
3. **Candidates** (`candidates.ts`): a top and a bottom, or a dress or jumpsuit; exactly one pair of shoes; no outerwear or one piece. Required items fix their slot. Two style heuristics (not validity rules): the most and least formal item in a candidate differ by at most 2 (`MAX_FORMALITY_SPREAD`), and candidates containing an "avoid" pair go to the back. Exact combinations the user rejected, or the outfit being refined, are left out. If none are left: `incomplete_wardrobe / nothing_fits`.
   Around required items (an anchor, items kept in a swap), each slot is first narrowed to items within `MAX_FORMALITY_SPREAD` of every required item. So the few coherent outfits around, say, formal shoes in a big casual wardrobe are listed rather than missed by sampling.
4. **Pass 1, tags only** (skipped when there are 8 candidates or fewer, since there's nothing to shortlist): the tags of the items that appear in a candidate (plus required items), the candidates, the request, guidance, avoid hints and any refinement. The model shortlists about 8.
5. **Pass 2, thumbnails:** ~256 px pictures of the shortlisted items' cut-outs (the original if there's no cut-out). The model picks the best N, each with a name and a one-line reason. During a refinement, the whole previous outfit has refs too (the swapped-out item can't be chosen).
6. **Validate** after each pass, inside `callWithValidation`'s `check`, so a schema failure and a bad pick share **one** retry. Each outfit in a reply is judged **on its own**: the reply's envelope is parsed loosely, then each outfit against the contract's per-outfit schema, then the rules in `validate.ts`. Picks must be **exactly one of the outfits offered** (pass 1: the candidates; pass 2: the shortlist), so the formality-spread and avoid-hint guarantees always hold; candidates aren't just advice. A name or reason showing an item ref ("I3") is a bad pick.
   - A reply with **enough** valid outfits isn't retried: pass 2 needs `count`; pass 1 needs `count + 2` (at most 8), so pass 2 still has a choice. Bad outfits next to them are dropped.
   - Otherwise one retry. Afterwards the attempt with the most valid outfits is used; none at all is `502 ai_failed`.
7. **Save** the outfits (status `suggested`, `parent_outfit_id` for refinements).

## Bounds (config.ts)

| Setting | Value | Why |
| --- | --- | --- |
| `MAX_CANDIDATES_SENT` | 60 | Candidates in the pass 1 prompt: well under 1,000 tokens |
| `ENUMERATE_LIMIT` | 5,000 | Up to this many combinations are all listed and shuffled. Above it (200 items can make millions), random combination numbers are drawn, so generation never lists them all. A 200-item wardrobe takes a few milliseconds (tested) |
| `SAMPLE_ATTEMPTS_PER_CANDIDATE` | 40 | Draws allowed per candidate wanted when sampling |
| `SHORTLIST_SIZE` | 8 | Pass 1 output ("about 8") |
| `MAX_FORMALITY_SPREAD` | 2 | Style coherence inside one candidate |
| `REFINE_COUNT` | 3 | Outfits per refinement (refine requests have no count) |
| `MAX_REJECTED_OUTFITS_FOR_HINTS` / `MAX_AVOID_PAIRS` | 30 / 60 | Avoid hints per prompt |
| `THUMBNAIL_CONCURRENCY` | 6 | Downloads at a time for pass 2 |

Pass 1 sends the tags (about 60 tokens each) of items that appear in the 60 candidates, at most 240 items' worth and usually far fewer.

**Time budget.** Each Gemini call times out after 12 s, and the SDK's own retries are off (`retryOptions: { attempts: 1 }`), so the engine's single retry is the only one and every attempt is costed. Worst case: 2 passes × 2 attempts × 12 s + headroom, which a test keeps under the routes' `maxDuration` of 60 s. Pass 2 sends at most 8 outfits × 4 items = 32 thumbnails, usually far fewer because items repeat.

## Refinement

- **Swap:** the swapped item is removed from the wardrobe for this request, and the outfit's other items are required. If nothing can replace it that way (it was the only top, say), the other items are let go, keeping the anchor. If the swapped item was the anchor, the anchor is dropped. Feedback row: `swap`, detail = the item ID.
- **Guidance:** new guidance is added to the earlier guidance (`"no heels; warmer"`) while it fits in 200 characters, otherwise it replaces it. The outfit being refined can't come back. Feedback row: `guidance`, detail = the text.
- Both send the previous outfit and the feedback to the model (`RankingContext.refinement`), return 3 outfits with `parentOutfitId` set, and count against the daily outfit cap.

## Feedback and avoid hints

`PATCH /api/outfits/:id` sets the status. Moving an outfit to `rejected` also writes one `reject` feedback row with the optional reason. Later requests send every pair of items from the 30 most recent rejected outfits as "avoid" hints, and never offer a rejected combination again. An outfit that's un-rejected (saved later) stops being a hint.

## Caps and cost

- `UsageGuard.assertCanStart(user, "outfit_request")` runs first on new requests and refinements: `429 daily_cap_reached` or `503 ai_paused`.
- The request is counted just before the first model call, so an `incomplete_wardrobe` answer isn't counted.
- Every model call's cost is recorded (`ranking_shortlist`, `ranking_final`), including retries and calls that threw. Gemini's cost isn't computed yet, so the estimates in `src/lib/usage/config.ts` are used.

## Mock mode

`GLADRAGS_MOCK_MODE=true` runs this same pipeline on the in-memory mock wardrobe, with `MockRankingProvider` (no network, canned names) and placeholder thumbnails. The `mock-ai-paused` and `mock-daily-cap` markers in guidance or custom style text still work (routes only, mock mode only).

## Tests

All without network: `*.test.ts` here, `src/lib/ai/gemini-ranking.test.ts` (prompts, and recorded Gemini replies in `src/test/fixtures/gemini-ranking/`) and `src/app/api/outfits/outfits-live.test.ts` (routes with mock mode off, fake Supabase). `src/lib/ai/gemini-ranking.live.test.ts` re-records the Gemini replies and is skipped unless `GEMINI_RECORD=1`:

```sh
GEMINI_RECORD=1 NODE_USE_ENV_PROXY=1 pnpm vitest run src/lib/ai/gemini-ranking.live.test.ts
```

**Not yet recorded live.** The Gemini key's free-tier quota (20 requests per model per day) ran out before a real reply could be recorded, so the reply fixtures are hand-written in Gemini's format and marked `"synthetic": true`. Run the command above (4 calls) to replace them. The two `editedFrom` fixtures (an invented item ref, an omitted anchor) stay hand-edited on purpose.
