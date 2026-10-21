# GladRags

A mobile web app that turns photos or product links of your clothes into a tagged wardrobe, then suggests outfits for whatever you're dressing for.

**Status:** foundations built (scaffold, schema, contracts); see `docs/PROGRESS.md`.

## Run it locally

Needs Node 22+ and pnpm.

```sh
pnpm install
GLADRAGS_MOCK_MODE=true pnpm dev   # no accounts needed: mock data, sign-in skipped
```

For the real thing, copy `.env.example` to `.env.local` and fill in the Supabase and Gemini values.

| Command | What |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Checks run in CI |
| `pnpm build` | Production build (needs no secrets) |
| `pnpm test:e2e` | Playwright journeys on a 390 px phone viewport, in mock mode (run `pnpm exec playwright install chromium` once). Uses the dev server; set `PLAYWRIGHT_USE_BUILD=true` after `pnpm build` to test the production build, as CI does. |
| `DATABASE_URL=… pnpm db:verify` | Apply the migrations to a throwaway Postgres database and run the RLS checks |

`docs/CONTRACTS.md` explains the data model and every API route in plain language.

## Building with Claude Code

This repo is set up for an agent-swarm build in Claude Code:

- `docs/SPEC.md`: the v1 spec, the source of truth.
- `CLAUDE.md`: instructions for the main session, which acts as the orchestrator.
- `.claude/agents/`: the builder, reviewer, QA and security agents.

To start, open this repo in Claude Code and say:

> Follow CLAUDE.md and start the build.

It will set up the foundations, then stop for you to approve the data contracts before the parallel build begins. Progress is tracked in `docs/PROGRESS.md`.
