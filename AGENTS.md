# Agent guide for this repository

Kith Mind is a personal knowledge system built from the upstream `ai-brain`
foundation. Its public architecture is in
[`docs/plans/2026-09-06-architecture.md`](docs/plans/2026-09-06-architecture.md).

## Public contributor workflow

Do not require `docs/private/` to contribute. It is intentionally untracked
and is absent from public clones.

1. Read the public architecture and the issue or plan that defines the work.
2. Small docs-only changes may go straight to `main`. Everything else goes
   through a pull request on a short-lived branch named `task/<id>` (or
   `<topic>` when no task ID exists), deleted after merge.
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

## Parallel lanes

Several agents may work in this repository at once, each in its own worktree
and its own conversation. One of them is the orchestrator. The rest are side
lanes, started by the owner for out-of-band work such as UI polish, docs or
cleanup. Every agent reads this section before starting.

| Rule | Detail |
| --- | --- |
| One lane, one branch, one PR | Never commit to `main`. Open a draft PR early and list the files you expect to touch. That is your claim. |
| Look before you start | Run `gh pr list` and read open PRs. Do not edit a file another open PR is changing. Ask the owner if you must. |
| Only the orchestrator merges, migrates and deploys | A merge does not deploy. Migrations are positions in a list and the schema runner rejects gaps, so they go in series through one agent. |
| Side lanes stay out of | `packages/kith-store/migrations`, `packages/pipeline`, `packages/worker-protocol`, `packages/kith-store/src/workers`, `packages/kith-store/src/identity`, `apps/web/src/lib/mcp`, auth and MCP routes, `docs/private`. Need a change there? Say so in your PR and stop. |
| Shared UI components have one owner at a time | `apps/web/src/components/ui/*` is shared by every screen. Only one open PR may change it. Keep changes backward compatible. |
| Finish cleanly | Run the four checks. Remove containers and your own scratch files. Tell the owner the PR is ready. The orchestrator removes your worktree and branch at merge. |
| Do not read the owner's data | No document text, database values or files under the watched folders. Counts, enums and booleans only. Use synthetic fixtures. |

### Waiting costs tokens

Every model turn re-reads the whole conversation. An agent that checks
"is CI done yet?" twenty times pays for its context twenty times.

| Do | Do not |
| --- | --- |
| Wait inside ONE background shell command that loops and sleeps on its own (for example a script that polls `gh pr view` until the three checks finish, then merges). The model is woken once, when it exits. | Check status turn after turn, or run `sleep` in the foreground between model turns. |
| Sub-agents: push, open the PR, report, stop. The orchestrator gates CI. | Sub-agents waiting for CI or for another agent. |
| Hand long jobs (backfills, builds, deploys) to a background command and carry on with other work. | Scheduled wake-ups or loops "to see if anything changed". Act when a job finishes or the owner speaks. |
| Start a fresh orchestrator session every day or two. The tracker and handoff files carry the state. | One endless conversation that carries every topic. |

To get a side-lane PR shipped, the owner tells the orchestrator "ship PR <n>".

UI work follows [`docs/ui-style.md`](docs/ui-style.md).

## Cross-workstream coordination

Mainline and the financial archive workstream coordinate through
[GitHub Issue #57](https://github.com/jordan-hivemind/kithmind/issues/57).
Read its body and new comments before starting shared-boundary work, after
landing shared-contract changes, and when blocked on the other workstream.
There are no push notifications; check at those points rather than assuming
the other agent has received a message.

Post shared contract changes, cross-workstream defects, boundary questions,
and ownership changes there. Sign each entry with the workstream and date.
Keep ordinary implementation discussion in its own PR. Correct stale
mainline status in the issue body without overwriting the other workstream's
updates. The owner should not need to relay messages between agents.

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

`packages/kith-store/src/identity/*.ts` (especially `webAuth.ts`,
`authorization.ts`, `spaces.ts`, `apiKeys.ts`, and `oauth.ts`), and
`apps/web/src/lib/mcp/*` require tier 2 or above and a second-model review
before merge. Apply `kith` and `finance` schema migrations
(`packages/kith-store/migrations`, `applyKithSchema`) against the development
database first, then record the exact command in the owner tracker or a
public issue or plan.

Before any Vercel operation, verify the authenticated Vercel identity and the
intended team and project in that same credential context. State the intended
scope explicitly in the command or operation; do not infer it from the current
directory, a previous login, or a cached project link. The owner uses
separate personal and business accounts. Do not put personal
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

## Conventions

- Keep plans in `docs/plans/`, dated and consistent with implemented behavior.
- Use short sentences, no emojis or em dashes, and tables for parallel facts.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `tracker:`) with a body
  that explains why.

## Archive writers

Before an archive-root relocation, or a change to an archive writer’s runtime
or dependencies, identify and quiesce the affected archive writers, including
ingestion workers and scheduled database backups. Root relocation affects all
writers that use that root. Verify no backup runner or child process remains active, preserve locks
and failure evidence, and resume schedules only after required checks pass.
