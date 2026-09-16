# Cutover runbook

Date: 2026-09-16. Status: operating instructions for
[`.github/workflows/cutover.yml`](../../.github/workflows/cutover.yml).

Parent: [PostgreSQL consolidation](./2026-09-12-postgres-consolidation.md).
This runbook covers section 3, steps 1 to 8 and the load half of step 9. The
rest of step 9 stays manual and is listed at the end.

## The two owner actions

| Action                             | What it is                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Add one repository secret       | `KITH_MIGRATION_DATABASE_URL`, pointing at the hosted archive database with a role that can create the `vector` extension and the `kith` schema. Needed for `live` only.                         |
| 2. Run the workflow, twice         | Actions, Cutover, Run workflow. First in `rehearsal`. Read the summary. Then in `live`, typing the confirmation string.                                                                          |

`CONVEX_DEPLOY_KEY` is already a repository secret; the Convex deploy workflow
uses the same one. Both modes need it. If either secret is missing, the first
step fails and names it, before anything is exported, transformed or loaded.

The confirmation string for `live` is exactly:

```
load into the live archive database
```

Anything else fails the first step. `rehearsal` ignores the field.

The role behind `KITH_MIGRATION_DATABASE_URL` needs `CREATE` on the database
(for the `kith` schema) and the right to run `CREATE EXTENSION vector`, which
migration 015 requires. It does not need any privilege on `finance`, and it is
not the application role. The application role's URL is a separate value, set on
the deployment as `KITH_DATABASE_URL` in the manual half below.

## What the workflow does

| Step               | Command                                                                     | Destination                |
| ------------------ | ----------------------------------------------------------------------------- | -------------------------- |
| Guard              | Confirmation string and secret presence                                     | none                       |
| Preflight          | `pnpm install --frozen-lockfile`, build, PostgreSQL 17 client               | runner                     |
| Export             | `convex export --prod --include-file-storage`, then `kith-migrate export`   | runner staging, mode 700   |
| Verify manifest    | `kith-migrate export --verify-manifest`                                     | runner staging             |
| Transform          | `kith-migrate transform`                                                    | runner staging             |
| Audit              | `kith-migrate audit`                                                        | throwaway service database |
| Isolated load      | `kith-migrate load`                                                         | throwaway service database |
| Isolated parity    | `kith-migrate parity`                                                       | throwaway service database |
| Backup rehearsal   | `scripts/cutover-rehearsal-proof.mjs` (`rehearsal` only)                    | throwaway service database |
| Host verification  | `scripts/cutover-host-check.mjs capture` (`live` only)                      | live database, read only   |
| Live load          | `kith-migrate load`                                                         | live database, `kith` only |
| Live parity        | `kith-migrate parity`                                                       | live database, read only   |
| Finance unchanged  | `scripts/cutover-host-check.mjs compare` (`live` only)                      | live database, read only   |
| Summary and upload | Markdown summary plus the JSON reports                                      | run summary and artifact   |

## What the workflow does not do

| Never                               | Why                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writes the `finance` schema         | No step runs a finance migration or import. `live` mode proves it: `finance.schema_version` and every `finance` row count are captured before and after.   |
| Writes Convex                       | `convex export` is the only Convex command in the file.                                                                                                   |
| Publishes rows                      | The export ZIP, the per-table JSONL and the CSV directory stay in the runner's mode-700 staging and die with the runner.                                   |
| Publishes an offending value        | The audit's violation details are redacted to table, row id, constraint and kind before anything is printed or uploaded.                                   |
| Retains the export                  | The runner is destroyed at the end of the job. The retained, dated, encrypted export stays the owner's backup recipe.                                      |
| Re-uses a previous run's export     | There is no `skip_export` input. The only places an export could survive between runs are an artifact and the Actions cache, and both are readable by anyone who can read this public repository. |

The uploaded artifact is named `cutover-<mode>-<run id>` and holds counts, byte
lengths, hashes, transform row counts, redacted audit violations, parity
verdicts and, in `live`, the finance comparison. No rows.

## What to check in the summary before going live

Run `rehearsal` first and read the run summary. Proceed only when all of these
hold.

| Check                | Expected                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Export manifest      | One row per Convex table, with a count, a byte length and a SHA-256 for each                  |
| Manifest verification | `ok`, with an empty problem list                                                             |
| Transform            | `Unmapped fields: none`. Any unmapped field is a hard failure and the step will have failed.  |
| Audit                | `no violations`. If there are violations, fix the rows in Convex and rerun; every violation is reported in one pass, so there is no fix-one-rerun cycle. |
| Skipped constraints  | Empty, or each entry understood. A skipped constraint is a gap, not a pass.                   |
| Parity               | `pass`, with `counts`, `retained_text_hashes`, `provenance_chains_sample` and `space_isolation_data` all `pass` |
| Pending parity checks | `archive_references` and `auth_denial_and_space_isolation_read_api` report `pending` from the CLI. Pending is not passing. Run them separately before the cutover window. |
| Backup rehearsal     | A parity capture with zero unvalidated constraints, and a sampled cited answer that either matched its citation hash or names why it was unavailable |

Then run `live` with the confirmation string. In `live` the summary adds the
host verification table and the finance before and after comparison. The run
fails if the comparison is not `unchanged`, if `kith` already held rows before
the load, or if the live parity rerun is not `pass`.

## Local rehearsal

The workflow cannot run from a developer machine, so the command sequence has a
local twin that runs the same commands with the same flags against the synthetic
fixture `@repo/kith-migrate` ships:

```
KITH_STORE_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
  bash scripts/cutover-local.sh
```

It creates and drops two throwaway databases, writes the same report set, and is
covered by `scripts/cutover-local.test.mjs` in `pnpm test:once`. It never touches
a hosted database and uses no secret.

## What stays manual: the rest of step 9

The workflow stops after the live load and its parity rerun. The rest of the
cutover window is the owner's, in this order.

1. Quiesce the writers. Stop the pipeline worker and every scheduled writer,
   including the database backup schedule, and verify no child process remains.
   Preserve locks and failure evidence. Resume schedules only after the
   post-cutover checks pass.
2. Confirm the Convex queues are empty: no queued or running ingest job, no open
   scan, no pending inline work.
3. Rerun the workflow in `live` if anything was written to Convex after the run
   that loaded the archive.
4. Set the Convex deployment read-only by revoking the web and worker
   credentials it accepts.
5. Set the deployment variables, then redeploy:

   | Variable                 | Value                                                        |
   | ------------------------ | ------------------------------------------------------------ |
   | `KITH_POSTGRES_SURFACE`  | `postgres`                                                   |
   | `KITH_DATABASE_URL`      | The application role's connection string, not the migration role's |
   | `KITH_SESSION_SECRET`    | A fresh secret                                               |
   | `MCP_PUBLIC_ORIGIN`      | The deployment's public origin                               |
   | Provider keys            | The model and embedding provider keys the deployment needs   |

   Before any deployment operation, verify the authenticated identity and the
   intended team and project in that same credential context, and state the
   scope explicitly rather than inferring it from the current directory or a
   previous login.

6. Sign in once. Sessions were not migrated, so the owner re-authenticates.
7. Restart the worker against the same `/api/worker` endpoint and confirm it
   resumes from its existing on-disk journal with no re-enumeration.
8. Re-embed, then run the post-cutover checks: one full scan and one document
   publication without re-acquiring bytes, one MCP query returning a historical
   citation minted before the migration, and `pnpm brain:doctor` green.
9. Run the backup proof on the new shape (plan step 10) once every writer is
   quiesced. The workflow's rehearsal covers the parity capture and the sampled
   cited answer only; the dated encrypted dump and the isolated restore need
   `age`, `restic` and the owner's protected backup configuration.

Convex teardown and the point billing stops are plan step 11, not this runbook.
