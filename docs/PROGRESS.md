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
| Next.js App Router + TS strict + Tailwind + shadcn/ui scaffold, pnpm scripts | ◐ | |
| PWA manifest and service worker basics | ◐ | |
| Supabase migrations: users, items, outfits, outfit_feedback; RLS on all tables | ◐ | |
| Private storage buckets for originals and cut-outs | ◐ | |
| `src/contracts/`: item tags, preset styles + formality bands, outfit request/result, feedback, API types | ◐ | |
| API route stubs validating with contracts, returning typed mocks | ◐ | |
| AI and image provider interfaces; usage tracking for daily caps and £5/month cap | ◐ | |
| Magic-link auth restricted to email allowlist | ◐ | |
| `.env.example`, GitHub Actions CI (lint, typecheck, test) | ◐ | |
| `docs/CONTRACTS.md` | ◐ | |
| Review (`reviewer`) | ☐ | |
| Tests (`qa`) | ☐ | |
| Merge | ☐ | |
| **Checkpoint 2: Cheryl approves contracts** | ☐ | |

## Milestone 3 — Parallel build

| Task | Agent | Branch | Status | Depends on |
| --- | --- | --- | --- | --- |
| Photo upload, EXIF strip, in-browser background removal, Gemini tagging, item cap | ingestion | `feat/ingestion` | ☐ | Foundations |
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
| Supabase project URL, publishable key, secret key | End-to-end check of foundations (auth, migrations) | ☐ Missing |
| Gemini API key (free tier OK for dev; paid before testers) | Milestone 3 (ingestion, outfit-engine live runs) | ☐ Missing |
| Vercel project linked to repo, with the same env vars | Milestone 4 preview deploy | ☐ Missing |
| Tester email allowlist | Milestone 6 (and her own email for testing earlier) | ☐ Missing |

## Decisions log

- 2026-10-21: This session can only push to `claude/build-setup-68by4m`, so that branch acts as the integration branch ("main" in CLAUDE.md's merge rules) until Cheryl opens a PR into `main`. Feature branches are merged into it locally.
- 2026-10-21: Cheryl chose in-browser background removal instead of Replicate. No background-removal key is needed; the spend cap covers Gemini only; `cutout_image_key` is nullable (the original is used if removal fails); add-by-link becomes two steps (the server stores the product image, then the client uploads the cut-out). SPEC.md, CLAUDE.md and the ingestion agent are updated, and the foundations agent has been told.

## Blockers

None yet.
