# GladRags — build progress

Maintained by the orchestrator (main Claude Code session). Source of truth for scope: `docs/SPEC.md`.

**Current status:** Milestone 2 (Foundations) in progress.

Legend: ☐ not started · ◐ in progress · ☑ done · ⛔ blocked

## Milestones

| # | Milestone | Status | Checkpoint |
| --- | --- | --- | --- |
| 1 | Spec sign-off | ☑ | Done |
| 2 | Foundations | ◐ | Stop for Cheryl to approve contracts |
| 3 | Parallel build | ☐ | Preview build of screens part-way |
| 4 | Integration | ☐ | Journey tests green, Vercel preview, stop for Cheryl |
| 5 | Cheryl's test | ☐ | Her sign-off |
| 6 | Tester build | ☐ | Testers invited by Cheryl |

## Milestone 2 — Foundations (agent: `foundations`, branch `feat/foundations`)

| Task | Status | Notes |
| --- | --- | --- |
| Next.js App Router + TS strict + Tailwind + shadcn/ui scaffold, pnpm scripts | ☑ | Next 16.4, React 19.3, Tailwind 4.3, Zod 4.6. TypeScript 6.0 and ESLint 9 (TS 7 and ESLint 10 aren't supported by typescript-eslint / eslint-plugin-react yet). Button and Input as the shadcn pattern. |
| PWA manifest and service worker basics | ☑ | Manifest with share target `/add/link` (page belongs to wardrobe-ui); SW caches only static build assets plus an offline page; placeholder icons |
| Supabase migrations: users, items, outfits, outfit_feedback; RLS on all tables | ☑ | Plus `usage_events` and `allowed_emails`. Verified on local Postgres 16 with a Supabase stub (`pnpm db:verify`, also in CI). Not yet applied to a real Supabase project. |
| Private storage buckets for originals and cut-outs | ☑ | Per-user folder policies; cut-out optional (`items.cutout_image_key` nullable) |
| `src/contracts/`: item tags, preset styles + formality bands, outfit request/result, feedback, API types | ☑ | Includes model-output schemas (tagging, both ranking passes) and the composition rule |
| API route stubs validating with contracts, returning typed mocks | ☑ | Mock mode only (`GLADRAGS_MOCK_MODE=true`); `not_implemented` otherwise. Photo upload with optional cut-out; two-step link import. |
| AI and image provider interfaces; usage tracking for daily caps and £5/month cap | ☑ | Background removal is a browser-side interface. Cap counts Gemini only. |
| Magic-link auth restricted to email allowlist | ☑ | Link + typed code (for the iPhone home-screen app); allowlist enforced by a DB trigger. Unverified against a live Supabase project. |
| `.env.example`, GitHub Actions CI (lint, typecheck, test) | ☑ | New Supabase key names (publishable / secret). CI also runs build and the migration checks. |
| `docs/CONTRACTS.md` | ☑ | Decisions for Cheryl listed in section 10 |
| Review (`reviewer`) | ☐ | |
| Tests (`qa`) | ☐ | Playwright smoke test written but not run here (no browser download available) |
| Merge | ☐ | |
| **Checkpoint 2: Cheryl approves contracts** | ☐ | |

## Milestone 3 — Parallel build

| Task | Agent | Branch | Status | Depends on |
| --- | --- | --- | --- | --- |
| Photo upload, EXIF strip, background removal, Gemini tagging, item cap | ingestion | `feat/ingestion` | ☐ | Foundations |
| Filter, candidates, two-pass ranking, validation, refinement, feedback hints, outfit cap | outfit-engine | `feat/outfit-engine` | ☐ | Foundations |
| URL fetch, OG / JSON-LD parsing, screenshot fallback | link-import | `feat/link-import` | ☐ | Ingestion tagging merged |
| Sign-in, add-item flow, tag review, wardrobe grid + filters, item detail | wardrobe-ui | `feat/wardrobe-ui` | ☐ | Foundations (mocked APIs) |
| Style request + chips, results, canvas collages, swap/refine, saved outfits | outfit-ui | `feat/outfit-ui` | ☐ | Foundations (mocked APIs) |
| Preview build of screens for Cheryl | orchestrator | | ☐ | UI branches |

## Milestone 4 — Integration

| Task | Agent | Status |
| --- | --- | --- |
| Switch UIs from mocks to real APIs | orchestrator | ☐ |
| Journey tests 1–5 + add-by-link + missing-category | qa | ☐ |
| Security check (RLS, signed URLs, secrets, uploads, link fetching, deletion) | security | ☐ |
| Vercel preview deploy | orchestrator | ☐ |
| Tester privacy note | orchestrator | ☐ |

## Setup Cheryl owns

| Item | Needed by | Status |
| --- | --- | --- |
| Supabase project URL, publishable key (sb_publishable_…), secret key (sb_secret_…) | End-to-end check of foundations (auth, migrations) | ☐ Missing |
| Gemini API key (free tier OK for dev; paid before testers) | Milestone 3 (ingestion, outfit-engine live runs) | ☐ Missing |
| ~~Background-removal API key~~ | Not needed: removal now runs in the browser | n/a |
| Vercel project linked to repo, with the same env vars | Milestone 4 preview deploy | ☐ Missing |
| Tester email allowlist | Milestone 6 (and her own email for testing earlier) | ☐ Missing |

## Decisions log

- 2026-10-21: This session can only push to `claude/build-setup-68by4m`, so that branch acts as the integration branch ("main" in CLAUDE.md's merge rules) until Cheryl opens a PR into `main`. Feature branches are merged into it locally.

## Blockers

None yet.
