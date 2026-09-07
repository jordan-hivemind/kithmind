# Agent guide for this repository

Kith Mind is a personal knowledge system built from the upstream `ai-brain`
foundation. Its public architecture is in
[`docs/plans/2026-09-06-architecture.md`](docs/plans/2026-09-06-architecture.md).

## Public contributor workflow

Do not require `docs/private/` to contribute. It is intentionally untracked
and is absent from public clones.

1. Read the public architecture and the issue or plan that defines the work.
2. Work on a focused branch named `task/<id>` (or `codex/<topic>` when no task
   ID exists).
3. Do not add real personal, family, health, financial, account, credential,
   or production data to the repository. Use synthetic fixtures.
4. Run the relevant checks. Before requesting review for a code change, run:

   ```
   pnpm lint
   pnpm check-types
   pnpm test:once
   pnpm build
   ```

5. Open a pull request that explains the behavior change and the checks run.
   Update a public plan when the implementation changes an adopted design.

## Owner workflow

On an owner machine where `docs/private/TRACKER.md` exists, it is the local
work tracker. Read it before starting and do not rely on chat history, memory
files, or a previous session. Claim one task by setting `owner` to the
orchestrator name and session ID, `status` to `in_progress`, and `updated` to
the current date, then save the tracker before work begins. Work on the branch
named in the task and push it at the end of every session.

For every state change (`blocked`, `review`, or `done`), update the tracker
with a next action that stands on its own, the verification command, and the PR
URL where applicable. Never delete tracker rows. A task is done only after its
PR is merged, required checks are green, and the plan's acceptance line is
satisfied. Run all four verification commands before marking a task `review`.
Add tracker rows for discovered work with a `source` note identifying the task
that surfaced it.

Never commit, publish, or ask contributors to supply `docs/private/`; use a
public issue or plan for work that others can take on.

## Model tiers

The owner is on flat-rate plans for both vendors, so the cost that matters is
tokens per completed task, not price per token. Pick the lowest tier that
finishes the task without retries. Escalate one tier after two failed attempts,
or immediately for tasks tagged `judgment`. Vendor rows are equivalents; use
the vendor available to the orchestrator. Recheck tier placement when new
models ship.

| Tier             | Anthropic                      | OpenAI | Use for                                                                                                                            |
| ---------------- | ------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0 mechanical     | Haiku 4.5 (`claude-haiku-4-5`) | Luna   | Renames, lookups, boilerplate, running tests, formatting docs, applying a reviewed diff                                            |
| 1 implementation | Sonnet 5 (`claude-sonnet-5`)   | Terra  | Most PRs, tests, connectors, plan drafting against the code. Default tier.                                                         |
| 2 judgment       | Opus 5 (`claude-opus-5`)       | Sol    | Schema and migration design, auth and space-isolation code, reviewing tier 1 output, debugging after tier 1 fails twice            |
| 3 frontier       | Fable 5.1 (`claude-fable-5-1`) | Astra  | Orchestration when the owner is already in it; long autonomous runs where a wrong turn costs more than the tokens; tier 2 failures |

- Subagents at tiers 0 and 1 run at `low` or `medium` effort unless the task
  says otherwise.
- The orchestrator routes, reviews, and updates the tracker. It does not
  implement tier 1 work unless the task is tier 2 or tier 3 by nature.
- Ingestion-pipeline extraction defaults to tier 0 for bulk documents and tier
  1 for hard documents; agents that read user data may use any tier the task
  needs.

## Security-sensitive work

`packages/convex/convex/lib/*Auth.ts`, `lib/spaces.ts`, and
`apps/web/src/lib/mcp/*` require tier 2 or above and a second-model review
before merge. Run Convex-side migrations with `npx convex run` against the
development deployment first, then record the exact command in the owner
tracker or a public issue or plan.

Before any Vercel operation, verify the authenticated Vercel identity and the
intended team and project in that same credential context. State the intended
scope explicitly in the command or operation; do not infer it from the current
directory, a previous login, or a cached project link. Do not put personal
emails, team names, or project IDs in public files.

### Standing pre-launch deployment approval

On 2026-09-06, the owner explicitly pre-approved production deployments and
the migrations needed to implement this project. The owner reports that the
deployment has no active users yet. During this pre-launch build, agents may
merge reviewed changes, deploy, migrate, and verify the owner's Kith Mind
environments without asking again. This approval remains effective until the
owner revokes it or declares the system live. Keep development-first migration
checks, required tests, independent security review, and deployment verification.
This approval does not apply to upstream or other contributors' deployments.

The required verification commands are:

```
pnpm lint
pnpm check-types
pnpm test:once
pnpm build
```

## Conventions

- Keep plans in `docs/plans/`, dated and consistent with implemented behavior.
- Use short sentences, no emojis or em dashes, and tables for parallel facts.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `tracker:`) with a body
  that explains why.
