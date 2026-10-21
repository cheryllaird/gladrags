# GladRags

A mobile web app that turns photos or product links of your clothes into a tagged wardrobe, then suggests outfits for whatever you're dressing for.

**Status:** spec approved; build not started.

## Building with Claude Code

This repo is set up for an agent-swarm build in Claude Code:

- `docs/SPEC.md`: the v1 spec, the source of truth.
- `CLAUDE.md`: instructions for the main session, which acts as the orchestrator.
- `.claude/agents/`: the builder, reviewer, QA and security agents.

To start, open this repo in Claude Code and say:

> Follow CLAUDE.md and start the build.

It will set up the foundations, then stop for you to approve the data contracts before the parallel build begins. Progress is tracked in `docs/PROGRESS.md`.
