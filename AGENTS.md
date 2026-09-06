# Agent guide for this repository

Read this first, whichever orchestrator you are (Claude Code, Codex, or a person). It is the hand-off: everything needed to resume work is in this file, the tracker, and the plan documents it points to.

## What this project is

Kith Mind: a personal and family knowledge system exposed over MCP, extended from the upstream `ai-brain` project by Peter Brown. Public design: `docs/plans/2026-09-06-architecture.md`.

The owner's own build plans, phase plans, and the work tracker live in `docs/private/`, which is gitignored because they name real people and accounts. On the owner's machines that directory exists; if it is missing, ask the owner for it before claiming work. When moving to a new machine, copy `docs/private/` by hand (or point it at a synced folder); it is the only state that is not in git.

## Orchestrator protocol

1. Read `docs/private/TRACKER.md`. Do not rely on chat history, memory files, or a previous session.
2. Claim one task: set `owner` to your orchestrator name and session id, set `status: in_progress`, set `updated`. The tracker is not in git, so the edit itself is the claim; save the file before starting work.
3. Work on the branch named in the task (`task/<id>`). Push the branch at the end of every session, finished or not, so the next orchestrator can continue from the remote.
4. Every state change (blocked, needs review, done) is a tracker edit with `next_action` written for someone who has no context. Record the PR URL and the verification command you ran.
5. Done means: PR merged, verification commands green, tracker row `done`, and the plan document's acceptance line satisfied.
6. Never delete tracker rows. Add rows for discovered work with a `source` note pointing at the task that surfaced it.

## Model tiers

The owner is on flat-rate plans for both vendors, so the cost that matters is tokens per completed task, not price per token. Pick the lowest tier that finishes the task without retries. Escalate one tier after two failed attempts, or immediately for tasks tagged `judgment`. Vendor rows are equivalents; use whichever vendor the orchestrator is running under. Verified 2026-09-06; re-check tier placement when new models ship.

| Tier | Anthropic | OpenAI | Use for |
|---|---|---|---|
| 0 mechanical | Haiku 4.5 (`claude-haiku-4-5`) | Luna | Renames, lookups, boilerplate, running tests, formatting docs, applying a reviewed diff |
| 1 implementation | Sonnet 5 (`claude-sonnet-5`) | Terra | Most PRs, tests, connectors, plan drafting against the code. Default tier. |
| 2 judgment | Opus 5 (`claude-opus-5`) | Sol | Schema and migration design, auth and space-isolation code, reviewing tier 1 output, debugging after tier 1 fails twice |
| 3 frontier | Fable 5.1 (`claude-fable-5-1`) | Astra | Orchestration when the owner is already in it; long autonomous runs where a wrong turn costs more than the tokens; tier 2 failures. Fable 5.1 and Opus 5 are close in capability, but Fable's thinking is always on and its turns run longer, so it spends several times the tokens per task. |

Rules:

- Subagents at tiers 0 and 1 run at `low` or `medium` effort unless the task says otherwise.
- The orchestrator routes, reviews, and updates the tracker. It does not implement unless the task is tier 2 or 3 by nature.
- Tokens per completed task is what counts. A cheaper model that needs three retries is not cheaper.
- Ingestion-pipeline extraction defaults to tier 0 for bulk documents and tier 1 for hard ones; agents that read user data may use any tier the task needs.

## Verification

```
pnpm lint
pnpm check-types
pnpm test:once
pnpm build
```

Run all four before marking any task `review`. Convex-side migrations are run by hand with `npx convex run` against the dev deployment first; record the command in the tracker.

## Conventions

- Plans live in `docs/plans/`, dated, one per phase. Update the plan when reality diverges; do not leave the tracker and plan disagreeing.
- Prose style for docs and PRs: no emojis, no em dashes, short sentences, tables for parallel facts.
- Commits: conventional prefix (`feat:`, `fix:`, `docs:`, `tracker:`), body explains why.
- Security-sensitive files (`packages/convex/convex/lib/*Auth.ts`, `lib/spaces.ts`, `apps/web/src/lib/mcp/*`) are tier 2 minimum and always get a second-model review before merge.
