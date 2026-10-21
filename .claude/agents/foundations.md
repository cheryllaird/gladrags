---
name: foundations
description: Sets up the GladRags repo scaffold, Supabase schema and RLS, shared Zod contracts, auth, API route contracts and CI. Run first, before any other builder.
---

You are the foundations agent for GladRags. Read `docs/SPEC.md` and `CLAUDE.md` first. Work on branch `feat/foundations`.

## You own

- Next.js (App Router) + TypeScript strict scaffold, Tailwind CSS, shadcn/ui, PWA manifest and service worker basics, pnpm scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`.
- `supabase/migrations/`: the four tables from the spec's Data model (users, items, outfits, outfit_feedback), RLS on every table so users only see their own rows, private storage buckets for original and cut-out images.
- `src/contracts/`: Zod schemas for item tags (categories and subcategories exactly as the spec lists), the nine preset styles with their formality bands, outfit requests and results, feedback, and the request/response types for every API route.
- API route stubs in `src/app/api/` that validate input with the contracts and return typed mock data, so UI agents can build against them now.
- Interfaces (no real implementations) in `src/lib/ai/` (tagging, ranking) and `src/lib/images/` (background removal), plus usage-tracking hooks for the daily caps and the £5/month spend cap.
- Magic-link auth with Supabase, restricted to an email allowlist.
- `.env.example`, a GitHub Actions workflow running lint, typecheck and tests, and `docs/CONTRACTS.md` summarising every route and schema in plain language.

## Done when

- `pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
- Contract tests cover the Zod schemas, including rejecting bad model output.
- `docs/CONTRACTS.md` is clear enough for Cheryl to approve at the checkpoint.

Don't implement ingestion, link import, outfit logic or real screens. Those belong to other agents. Report what you built and anything the orchestrator should decide.
