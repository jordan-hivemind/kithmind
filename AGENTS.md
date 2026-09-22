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
4. Follow [Verification and review](#verification-and-review). Run focused
   checks before draft review and use final CI as the authoritative release gate.

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
satisfied. Before marking a task `review`, record focused verification and any
pending final CI checks under the policy below.
Add tracker rows for discovered work with a `source` note identifying the task
that surfaced it.

Never commit, publish, or ask contributors to supply `docs/private/`; use a
public issue or plan for work that others can take on.

### Ingestion depth and priority

Follow the adopted
[document triage and priority plan](docs/plans/2026-09-21-document-triage-and-priority.md).
Depth and queue priority follow explicit owner goals and document value, not
backlog completion or folder membership. Keep low-value bulk histories at
metadata-only unless an explicit goal needs their contents. Preserve deferred
items so a later exact-identity selection can promote them safely.

Before a repair release, run a bounded candidate or acceptance probe against
the affected read path. A successful parse or publication is not acceptance.
Inspect every contributing source and current-generation proof. Reuse focused
checks and review evidence, and start final CI only after the review head is
stable. For scheduler changes, test the affected end-to-end state transitions
across mixed document types, queued work, legacy resume and deferred refresh.
Do not substitute helper-only checks or unrelated suites for those transitions.
Exercise newly queued selected items through publication, cleanup, next-item
selection and restart. Publication alone does not prove scheduler acceptance.
Before a finance repair, inspect both legacy unversioned scope proofs and the
active generation's versioned proofs. They are immutable and require a new
generation when corrected source evidence changes their payload or membership.
Clean disposable proof containers in a `finally` block or shell trap. If an
interrupted run leaves one behind, label it with the owner PID and mounts so
the orchestrator can verify and remove only the orphaned container.

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
| Finish cleanly | Record verification under the policy below. Remove containers and your own scratch files. Tell the owner the PR is ready. The orchestrator removes your worktree and branch at merge. |
| Do not read the owner's data | No document text, database values or files under the watched folders. Counts, enums and booleans only. Use synthetic fixtures. |

For a stacked change, commit at least one unique task change before opening its
draft PR. If the branch still equals its dependency, claim the work in the
task or issue until the first diff exists; GitHub can mark a zero-diff stacked
PR merged when the dependency lands.

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

## Verification and review

This policy supersedes generic instructions in older plans to run all four
commands before every review. Plan-specific acceptance tests still apply.
The purpose is to find defects early and ship verified changes, without
repeating unchanged work at each handoff.

| Stage or change | Required evidence |
| --- | --- |
| Development and draft review | Run the focused tests for changed behavior and affected consumers. Share the diff for review promptly; do not wait for a full repository build to begin review. State what remains unverified. |
| Final code release | Required CI must pass for the final merge candidate. CI runs `pnpm lint`, `pnpm check-types`, `pnpm test:once`, and `pnpm build`; its results satisfy those checks without another local full run. Run local checks for coverage or environments CI does not exercise. |
| Prose-only documentation | Check the diff, links and consistency of instructions. No local application build or database suite is needed. Required CI remains binding until the workflow itself changes. Executable examples, generated inputs and configuration changes need their relevant checks. |
| Review correction | Test the changed behavior and plausible regressions. Review the delta and verify earlier findings are resolved. Reopen unchanged areas only when the fix changes their assumptions. |
| Deployment or data repair | Verify the changed live behavior and the owner's acceptance condition. A green build, successful reparse or healthy endpoint alone does not prove the requested data or UI outcome. |

Record the tested commit, commands, results, database requirements and material
coverage gaps in the PR. Reuse author or CI evidence when the relevant source,
dependencies, configuration and test environment are unchanged. A prose-only
commit does not invalidate code evidence; a rebase requires checking what
changed in the base and rerunning checks affected by it. Required final-head
CI and branch protection must still pass. Never relabel earlier evidence as
having run against a later commit.

Copy a full commit hash for a handoff only from `git rev-parse HEAD` or
structured GitHub output. Never expand a short hash manually.

Use one accountable release owner. For code requiring independent review, use
one reviewer per risk area; prose-only edits do not need a new review lane.
Authors own focused verification; reviewers inspect behavior and test adequacy;
the orchestrator checks evidence and release acceptance. Do not have every role
repeat the same suite or commission another full review of unchanged code.
Collect related findings into a coherent repair before the final check batch.
Retain independent review for financial correctness, security and schema
changes, including the second-model security requirement below.

Choose tests by failure risk, not by how many commands can be run. Before an
expensive final batch, exercise parser boundaries, complete/partial/zero data,
replay and recovery transitions, or realistic query cardinality as applicable.
Performance regressions should distinguish the broken implementation from the
fix under the supported runtime budget, without fragile tiny timing thresholds.
Use synthetic fixtures; owner-authorized production diagnostics remain private.
A skipped database test is not passing database evidence. Separate integration
suites are not duplicates merely because they use the same database.

Broaden verification when changes cross shared contracts, dependencies, build
configuration or security boundaries, or when failures reveal wider impact.
Otherwise stop testing once relevant checks and acceptance pass. Do not add
unrelated cleanup, a new framework or another approval gate to a release fix.
Keep release blockers separate from follow-up improvements, give each active
lane a concrete next action, and reuse valid operational checkpoints rather
than restarting long jobs because of a handoff. If a gate fails, identify the
violated invariant before repeating the operation or weakening the gate.

## Orchestrator continuity and priorities

An active owner request continues through implementation, integration, release
and verification of the requested outcome. A worker handoff, completed reparse,
finished import or healthy deployment is an intermediate result. Keep moving
within existing authorization; do not wait for another owner prompt at each
checkpoint. Give every active lane a concrete next action and resolve dependency
waits directly. When work truly cannot continue, state the specific missing
input rather than implying that a saved checkpoint is active progress.

A final status reply ends the root orchestrator's current execution. It does
not leave the model running, subscribe it to child-agent completions or cause it
to consume later child replies automatically. While authorized work remains,
keep the root execution active and integrate required child results before
sending the final reply. If work will continue outside the model, name the
actual background process and establish a real continuation mechanism before
promising unattended progress. Distinguish that process from model
orchestration; a running child lane or queued reply alone is not continuation.

Before prioritizing a repair, trace its effect on the user-visible acceptance
condition. For example, fixing one statement may clear no stale accounts if
other incomplete sources contribute to the same snapshot. Count affected
accounts and remaining causes, not just successful documents or merged PRs.
Reconsider inherited plans when this evidence changes their expected benefit.
Preserve honest completeness and evidence requirements while correcting overly
broad or misplaced gates.

Changes to both sides of a shared protocol may need one integration candidate.
Keep ownership and review clear, combine the dependent commits, and use that
candidate's required CI instead of waiting for incompatible halves to pass
independently. Record which commits and reviews the combined release includes.
Do not duplicate a full review or test run when unchanged evidence applies.

## MCP server versions

Every release that changes an MCP server must bump its advertised server
version in the same PR. This includes tool definitions, descriptions, read or
write behavior, and changes to underlying code that alter MCP results. The
hosted gateway declares its version in `apps/web/src/lib/mcp/server.ts`; the
standalone finance server declares its version in
`packages/finance-archive/src/mcp/server.ts`. Bump each affected server.
Use a patch increment for compatible fixes, a minor increment for additive
capabilities, and a major increment for breaking contracts. Coordinate parallel
PRs against the latest merged version so a later release never reuses or lowers
an already released version. One coordinated release can share one bump.

Record the old and new versions in the PR. During the existing deployment
verification, confirm the MCP initialize response advertises the intended
version. A version bump does not guarantee that an already connected client
refreshes its cached tool manifest; verify tool discovery separately when the
release changes tools. Documentation-only edits outside the MCP surface do not
require a bump. Reuse existing checks rather than adding a full test run solely
for a version edit.

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

## Owner storage policy

On 2026-09-21 the owner explicitly confirmed that Dropbox is sufficient for
files and Neon is sufficient for Postgres. Do not create, schedule or require
separate file or database backups for this deployment. In particular, do not
gate ingestion on restic snapshots, redundant encrypted copies, database dumps
or a separate backup restore drill. This instruction supersedes older plans
and handoffs requiring those operations. Do not optimize or restart that
backup machinery as a substitute for removing the requirement.

Preserve source identity, content hashes, citations, access controls and
truthful source availability. Those checks do not authorize duplicate backup
storage. Reuse the provider-backed original. Preserve existing copies and
checkpoints while removing obsolete gates; deleting old backup data is a
separate action. Do not reintroduce separate backups without a new explicit
owner request.

## Archive writers

Before an archive-root relocation, or a change to an archive writer’s runtime
or dependencies, identify and quiesce the affected archive writers, including
ingestion workers and scheduled database backups. Root relocation affects all
writers that use that root. Verify no backup runner or child process remains active, preserve locks
and failure evidence, and resume schedules only after required checks pass.
