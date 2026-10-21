# GladRags — build instructions for Claude Code

GladRags is a mobile web app (PWA) that turns photos or product links of a user's clothes into a tagged wardrobe and suggests outfits for a chosen style or occasion. **`docs/SPEC.md` is the source of truth.** Read it in full before doing anything else, and re-read the relevant section before each task.

The owner is Cheryl (a software developer). She will read the code and may take over parts of it, so favour clear, conventional code over clever code.

## Your role: orchestrator

In this repo the main session is the orchestrator from the spec's build plan. You:

1. Break each milestone into tasks and track them in `docs/PROGRESS.md`.
2. Delegate building to the subagents in `.claude/agents/`, each on its own branch, using git worktree isolation so parallel agents don't collide.
3. Send every finished branch to the `reviewer` and `qa` agents (never the agent that wrote it).
4. Merge only branches that pass the merge rules below.
5. Stop at each checkpoint and report to Cheryl.

Do the build yourself only for small glue work (merges, config fixes, wiring). Anything bigger goes to the owning agent.

## When Cheryl says "follow CLAUDE.md" (first run)

1. Read `docs/SPEC.md`.
2. Create `docs/PROGRESS.md` with the milestones and an initial task list.
3. Check what she needs to provide before foundations can be verified end to end, and list it for her (see Setup she owns). Don't block on it: scaffold first and use `.env.example` with placeholders.
4. Run the `foundations` agent. When its branch passes review and tests, merge it.
5. **Checkpoint 2: stop.** Summarise the schema, shared types and API contracts for Cheryl and wait for her approval before starting the parallel build.

## Milestones and checkpoints

| # | Milestone | Agents | Ends with |
| --- | --- | --- | --- |
| 2 | Foundations | foundations → reviewer, qa | **Stop for Cheryl** to approve contracts |
| 3 | Parallel build | ingestion, link-import, wardrobe-ui, outfit-engine, outfit-ui, in parallel; each → reviewer, qa | Part-way: give Cheryl a preview build of the screens |
| 4 | Integration | orchestrator, qa, security | Full journey tests green, Vercel preview deploy, **stop for Cheryl** |
| 5 | Cheryl's test | fixes from her notes | Her sign-off |
| 6 | Tester build | security re-check | Testers invited (by Cheryl) |

Order inside milestone 3: ingestion and outfit-engine can start immediately; link-import waits for ingestion's tagging step to merge; the two UI agents start at once against mocked APIs and switch to real ones when the backend branches merge.

## Repo layout (set up by foundations)

```
src/app/            Next.js App Router pages and route handlers
src/contracts/      Shared Zod schemas and API request/response types (foundations owns)
src/lib/            Server-side modules: ai/, images/, ingestion/, link-import/, outfits/
src/components/     UI components (shadcn/ui based)
supabase/           Migrations, RLS policies, seed data
tests/              Playwright journey tests
docs/               SPEC.md, PROGRESS.md, CONTRACTS.md
```

## Merge rules

A branch merges into `main` only when all of these hold:

- `reviewer` has approved it against the spec.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` pass; journey tests pass once they exist.
- It changes no file in `src/contracts/` or `supabase/migrations/` unless its agent owns that file. A needed contract change comes back to you; you decide it, apply it on `main`, and tell the affected agents.
- `docs/PROGRESS.md` is updated.

## Engineering rules

- TypeScript strict mode. Validate every external input (requests, model output, scraped pages) with Zod from `src/contracts/`.
- AI providers sit behind interfaces in `src/lib/ai/` and `src/lib/images/`, so Gemini and the in-browser background remover can be swapped. Model output is never trusted: validate, retry once, then fall back as the spec says.
- No real AI or network calls in unit tests. Use recorded fixtures. Journey tests run against mocked providers by default.
- Enforce the per-user daily caps and the £5/month AI spend cap in code (spec: Cost controls).
- Mobile first: design and test at a 390 px wide viewport.
- Use pnpm.

## Secrets and safety

- Never commit secrets. Real values live in `.env.local` (gitignored) and Vercel environment variables. Keep `.env.example` up to date with names and placeholder values only.
- Don't create accounts, enter credentials, change billing, or deploy to production. Preview deploys only, and only once Cheryl has set up the Vercel project.
- Don't push to `main` without passing the merge rules. Don't force-push.

## Setup Cheryl owns

List any of these that are still missing when you reach a step that needs them:

- Supabase project URL, anon key and service role key.
- Gemini API key (free tier is fine for development; switch to paid before testers join).
- Vercel project linked to this repo, with the same environment variables.
- Tester email allowlist.

## Reporting to Cheryl

At each checkpoint, give a short summary: what merged, what's next, anything blocked on her, and how to try it (command or preview URL). Keep `docs/PROGRESS.md` current so she can check status without asking.
