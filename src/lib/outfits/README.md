# Outfit engine

Owner: outfit-engine agent. Spec: `docs/SPEC.md` → "Outfit suggestions" and "Cost controls". Contracts: `docs/CONTRACTS.md` sections 4–7.

The model only chooses and explains. Code decides what's wearable, and no item ID outside the user's wardrobe ever reaches a response.

## Files

| File | What | Pure? |
| --- | --- | --- |
| `filter.ts` | Step 1: drop items that clearly don't fit the style or season | yes |
| `candidates.ts` | Step 2: wearable combinations, bounded for big wardrobes; outfits with gaps; "avoid" pairs from rejected outfits | yes (randomness passed in) |
| `validate.ts` | Step 4: check the model's picks (wardrobe, composition, anchor, kept items, repeats) | yes |
| `season.ts` | Today's UK season | yes |
| `pipeline.ts` | Steps 1–4 joined up, with the two ranking passes | no I/O of its own |
| `service.ts` | What routes call: caps, wardrobe loading, refinement, feedback, saving | |
| `repository.ts` | Storage interface; `supabase-repository.ts` (real) and `mock-repository.ts` (mock mode) | |
| `thumbnails.ts` | ~256 px pictures for pass 2, behind `ThumbnailSource` | |
| `mock-ranking.ts` | Mock mode's no-network "model" (canned gap descriptions too) |
| `shop-search.ts` | "Find in my shops" and choosing a gap's product (`ShopSearchService`) | `candidatePages` is |
| `shop-pages.ts` | Confirms each candidate page through link-import's safe fetcher and parser | `productFromPage` is |
| `mock-shop-search.ts` | Mock mode's no-network shop search and page checker | | |
| `config.ts` | The tuning numbers below | |
| `index.ts` | `getOutfitService()` and `getShopSearchService()`: real or mock wiring | |

The Gemini provider for both passes is `src/lib/ai/gemini-ranking.ts`; the grounded shop search is `src/lib/ai/gemini-shop-search.ts`. Link-import's `src/lib/link-import/price.ts` reads a product page's price for shop products.

## Pipeline

1. **Empty wardrobe.** No items at all: `incomplete_wardrobe / empty_wardrobe`. No AI, not counted. (A missing category no longer stops anything: its slot becomes a gap. `missing_category` isn't returned any more.)
2. **Filter** (`filter.ts`):
   - Preset style: keep items inside the formality band, or one point outside it if they're tagged for that occasion.
   - **Custom (typed) style: no formality filter**, because it has no band. The model judges fit from the text, and candidates keep formality coherent (below). *Flagged for Cheryl.*
   - Season: today's UK season (meteorological). Holiday ignores the season.
   - The anchor and items kept in a swap always stay.
   - **Relaxing:** if the strict filter gives fewer candidates than the request's `count`, try again without the season, then also with any item one point outside the band. Use the strictest level that gives enough, otherwise the one that gives the most.
3. **Candidates** (`candidates.ts`): a top and a bottom, or a dress or jumpsuit; exactly one pair of shoes; no outerwear or one piece. Each slot is an owned item or a **gap** (below). Required items fix their slot. Two style heuristics (not validity rules): the most and least formal item in a candidate differ by at most 2 (`MAX_FORMALITY_SPREAD`), and candidates containing an "avoid" pair go to the back. Exact combinations the user rejected, or the outfit being refined, are left out. If none are left: `incomplete_wardrobe / nothing_fits`.
   **Gaps.** `generateGapCandidates` goes through every "slot pattern" (which slots are owned, which are gaps) and keeps the ones the shared `checkRankedOutfits` would accept with this request's `GapRules`: `fillableCategories` are the categories in the *filtered* wardrobe, and `includeShopItems` comes from the request. So a required slot the filtered wardrobe can't fill is always a gap; with "Include items from my shops", at most one other slot (outerwear included) may be. Every outfit has an owned item, the anchor is always owned, and fewer gaps come first. `generateOutfitCandidates` puts complete outfits first and keeps at least a quarter of the places (`GAP_CANDIDATE_SHARE`) for gap outfits when there are any, so a top without bottoms or the shop item asked for is still offered. A self-check throws if any candidate would fail `checkRankedOutfits`. The result's `missingCategories` is `missingCategoriesForOutfits` on the filtered wardrobe, around the anchor.
   **Filter level choice** prefers complete outfits: the strictest level with `count` complete candidates; else, among the levels with the most complete ones, the strictest with `count` in all. So off-season shoes are brought in rather than giving every outfit a shoes gap.
   Around required items (an anchor, items kept in a swap), each slot is first narrowed to items within `MAX_FORMALITY_SPREAD` of every required item. So the few coherent outfits around, say, formal shoes in a big casual wardrobe are listed rather than missed by sampling.
4. **Pass 1, tags only** (skipped when there are 8 candidates or fewer, since there's nothing to shortlist): the tags of the items that appear in a candidate (plus required items), the candidates, the request, guidance, avoid hints and any refinement. The model shortlists about 8.
   With gaps, candidates go to the model as `{ items, gaps }`, the JSON schema adds a `gaps` list (category limited to the gap slots on offer, optional subcategory, 1 to 3 palette colours, a description), and the prompt says to describe every listed gap, add none, and prefer complete outfits (or, with shop items on, to include at least one gap outfit). With no gaps on offer the prompt and schema are exactly as before.
5. **Pass 2, thumbnails:** ~256 px pictures of the shortlisted items' cut-outs (the original if there's no cut-out). Items waiting for a photo (`needsPhoto`: their original is a placeholder) get no picture; the model judges them by their tags. Each gap comes with pass 1's description as a `suggestion` to keep or improve. The model picks the best N, each with a name and a one-line reason. During a refinement, the whole previous outfit has refs too (the swapped-out item can't be chosen).
6. **Validate** after each pass, inside `callWithValidation`'s `check`, so a schema failure and a bad pick share **one** retry. Each outfit in a reply is judged **on its own**: the reply's envelope is parsed loosely, then each outfit against the contract's per-outfit schema, then the rules in `validate.ts`. Picks must be **exactly one of the outfits offered** (pass 1: the candidates; pass 2: the shortlist), so the formality-spread and avoid-hint guarantees always hold; candidates aren't just advice. A name or reason showing an item ref ("I3") is a bad pick.
   - A reply with **enough** valid outfits isn't retried: pass 2 needs `count`; pass 1 needs `count + 2` (at most 8), so pass 2 still has a choice. Bad outfits next to them are dropped.
   - Otherwise one retry. Afterwards the attempt with the most valid outfits is used; none at all is `502 ai_failed`.
   Picks must match an offered outfit's owned items *and* gap slots. A gap the request doesn't allow, a dropped gap, or an item ref in a gap description makes that outfit bad, like an invented item ID.
7. **Save** the outfits (status `suggested`, `parent_outfit_id` for refinements), complete ones first, with their `gaps` (no shop results yet).

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

- **Swap:** the swapped item is removed from the wardrobe for this request, and the outfit's other items are required. If nothing in the wardrobe can replace it (it was the only top, say), that slot becomes a gap and the other items stay. Only if the kept items can't make any outfit at all are they let go, keeping the anchor. Swapping out the wardrobe's only item answers `nothing_fits` (not counted). Only owned items can be swapped; a gap is changed with guidance. If the swapped item was the anchor, the anchor is dropped. Feedback row: `swap`, detail = the item ID.
- **Guidance:** new guidance is added to the earlier guidance (`"no heels; warmer"`) while it fits in 200 characters, otherwise it replaces it. The outfit being refined can't come back. Feedback row: `guidance`, detail = the text.
- Both send the previous outfit (its gaps too) and the feedback to the model (`RankingContext.refinement`), return 3 outfits with `parentOutfitId` set and the parent's `includeShopItems`, and count against the daily outfit cap. The outfit being refined, gaps included, can't come back.

## Feedback and avoid hints

`PATCH /api/outfits/:id` sets the status. Moving an outfit to `rejected` also writes one `reject` feedback row with the optional reason. Later requests send every pair of items from the 30 most recent rejected outfits as "avoid" hints, and never offer a rejected combination again. An outfit that's un-rejected (saved later) stops being a hint.

## Find in my shops (`shop-search.ts`)

`POST /api/outfits/:id/shop-search`, on an outfit with gaps (`bad_request` otherwise):

1. `assertCanStart(user, "shop_search")`, read the favourite shops (`user_settings`), make the provider (a missing key fails before counting), then `reserveAction(user, "shop_search")`: one search per outfit, however many gaps.
2. One Gemini call with Google Search grounding for all the gaps (`GeminiShopSearchProvider`), through `callWithValidation` with `ShopSearchModelOutputSchema` and `meterAiCalls(user, "shop_grounding")`. Entries for gaps the outfit doesn't have are ignored; a reply with none for its real gaps is retried (one retry in all). Two failures: `502 ai_failed`, and the search stays counted (the calls cost money; the daily cap bounds it). AI paused after counting: the count is given back.
3. `candidatePages`: links on a favourite shop only (`shopForUrl`: https, the shop's domain or a subdomain, no credentials or port, so no lookalikes), no repeats, at most 5 per gap (`SHOP_PAGE_CHECKS_PER_GAP`).
4. Each page through link-import's `safeFetch` (SSRF checks) and `parseProductPage`, plus `parseProductPrice`: kept only if it loads, is still on the same shop after redirects, and is a product with a title. Title, price and picture come from the page (an https picture only). Six at a time, all within 12 s (`SHOP_PAGE_BUDGET_MS`); late pages are dropped.
5. Up to 3 products per gap are stored on the outfit (`shopResults`, `searchedAt`), replacing earlier results; a chosen `shopProduct` is kept.

Time: two grounded attempts of at most 18 s each (`GEMINI_SHOP_SEARCH_TIMEOUT_MS`, SDK retries off) plus the 12 s page budget stay inside the route's 60 s.

`PUT /api/outfits/:id/gaps/:category` copies the product from that gap's own stored results (`bad_request` for any other link, `not_found` for a slot without a gap), or clears it with `{ productUrl: null }`. No AI, nothing counted. Shop pictures are for the product cards only (decision 6b); the collage keeps the placeholder.

Mock mode runs the same service with `MockShopSearchProvider` (three made-up links per gap over the favourite shops, plus one off-site link that's dropped) and `MockShopPageChecker` (no fetch; the third product has no picture).

## Caps and cost

- `UsageGuard.assertCanStart(user, "outfit_request")` runs first on new requests and refinements: `429 daily_cap_reached` or `503 ai_paused`.
- The request is counted just before the first model call, so an `incomplete_wardrobe` answer isn't counted.
- Every model call's cost is recorded (`ranking_shortlist`, `ranking_final`, `shop_grounding`), including retries and calls that threw. Gemini's cost isn't computed yet, so the estimates in `src/lib/usage/config.ts` are used.

## Mock mode

`GLADRAGS_MOCK_MODE=true` runs this same pipeline on the in-memory mock wardrobe, with `MockRankingProvider` (no network, canned names and gap descriptions) and placeholder thumbnails. The route still answers `includeShopItems` (without an anchor) and the `mock-gaps` marker with the canned gap outfits from `src/lib/mocks/store.ts`, which the UI work relies on; outfits with gaps from the real pipeline appear in mock mode when the wardrobe is missing a category (delete the shoes, say) or around an anchor. The `mock-ai-paused` and `mock-daily-cap` markers in guidance or custom style text still work (routes only, mock mode only).

## Tests

All without network: `*.test.ts` here, `src/lib/ai/gemini-ranking.test.ts` (prompts, and recorded Gemini replies in `src/test/fixtures/gemini-ranking/`) and `src/app/api/outfits/outfits-live.test.ts` (routes with mock mode off, fake Supabase). `src/lib/ai/gemini-ranking.live.test.ts` re-records the Gemini replies and is skipped unless `GEMINI_RECORD=1`:

```sh
GEMINI_RECORD=1 NODE_USE_ENV_PROXY=1 pnpm vitest run src/lib/ai/gemini-ranking.live.test.ts
```

**Not yet checked against live Gemini (quota).** All of these are hand-written fixtures (`"synthetic": true`) until real recordings are made:
- Ranking with gaps: `no-shoes-shortlist` and `shop-items-final` (the `-bad` ones stay hand-made). The live recorder includes them.
- The grounded shop search (`src/test/fixtures/gemini-shop-search/`): whether Gemini returns clean product page links on the named shops with `site:` searches, how often it wraps the JSON in prose, its real cost per search (3p estimate), and its latency against the 18 s timeout. The request asks for JSON in the prompt with **no** `responseJsonSchema`, because structured output together with the Google Search tool couldn't be checked and a refused combination would fail every search. There is no live recorder for it yet.
- Fetching real shop pages: the shops' bot protection may refuse the fetcher, in which case searches find nothing. The domains in `SHOPS` weren't checked live either.

**Not yet recorded live (before milestone 5).** The Gemini key's free-tier quota (20 requests per model per day) ran out before a real reply could be recorded, so the reply fixtures are hand-written in Gemini's format and marked `"synthetic": true`. Run the command above (4 calls) to replace them. The two `editedFrom` fixtures (an invented item ref, an omitted anchor) stay hand-edited on purpose.
