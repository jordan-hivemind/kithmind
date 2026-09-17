# Cutover runbook

Date: 2026-09-16. Status: operating instructions for
[`.github/workflows/cutover.yml`](../../.github/workflows/cutover.yml).

Parent: [PostgreSQL consolidation](./2026-09-12-postgres-consolidation.md).
This runbook covers section 3, steps 1 to 8 and the load half of step 9. The
rest of step 9 stays manual and is listed at the end.

## The two owner actions

| Action                             | What it is                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Add two repository secrets      | `KITH_MIGRATION_DATABASE_URL`, pointing at the hosted archive database with a role that can create the `vector` extension and the `kith` schema. `KITH_APP_ROLE_PASSWORD`, at least 16 characters: either the password the workflow itself sets on the role, or, on a host whose migration role cannot `CREATE ROLE`, the password of the role created by hand in the provider's console. Both secrets are needed for `live`; `app-role` mode needs the same two. |
| 2. Run the workflow, twice         | Actions, Cutover, Run workflow. First in `rehearsal`. Read the summary. Then in `live`, typing the confirmation string.                                                                          |

`CONVEX_DEPLOY_KEY` is already a repository secret; the Convex deploy workflow
uses the same one. Both modes need it. If any required secret is missing, the
first step fails and names it, before anything is exported, transformed or
loaded.

`KITH_APP_ROLE_PASSWORD` belongs to the login role the `app_role` workflow
input names (default `kith_app`). In `live` mode the workflow creates that
role if it does not exist, or updates its password if it does, and grants it
exactly what `grantProofAppRole` in `packages/kith-store/src/index.ts` names.
`scripts/cutover-app-role.mjs` is the step that does it, and it runs in
`rehearsal` too, against the throwaway database, with a password generated for
that run only and never reused.

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
| App role (rehearsal) | `scripts/cutover-app-role.mjs` (`rehearsal` only)                         | throwaway service database |
| Host verification  | `scripts/cutover-host-check.mjs capture` (`live` and `app-role`)            | live database, read only   |
| Live load          | `kith-migrate load`                                                         | live database, `kith` only |
| Live parity        | `kith-migrate parity`                                                       | live database, read only   |
| Finance unchanged  | `scripts/cutover-host-check.mjs compare` (`live` only)                      | live database, read only   |
| App role (live or app-role) | `scripts/cutover-app-role.mjs` (`live` and `app-role`)               | live database, role only   |
| Summary and upload | Markdown summary plus the JSON reports                                      | run summary and artifact   |

`app-role` mode runs only three of the steps above: preflight, host
verification (without `--expect-empty-kith`, because `kith` is expected to
already hold the archive) and the app role step, plus the summary and the
upload. It needs no `CONVEX_DEPLOY_KEY` and no confirmation input, because it
exports nothing and loads nothing. See "If the live run stops at the app
role" below.

## What the workflow does not do

| Never                               | Why                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writes the `finance` schema         | No step runs a finance migration or import. `live` mode proves it: `finance.schema_version` and every `finance` row count are captured before and after.   |
| Writes Convex                       | `convex export` is the only Convex command in the file.                                                                                                   |
| Publishes rows                      | The export ZIP, the per-table JSONL and the CSV directory stay in the runner's mode-700 staging and die with the runner.                                   |
| Publishes an offending value        | The audit's violation details are redacted to table, row id, constraint and kind before anything is printed or uploaded.                                   |
| Retains the export                  | The runner is destroyed at the end of the job. The retained, dated, encrypted export stays the owner's backup recipe.                                      |
| Re-uses a previous run's export     | There is no `skip_export` input. The only places an export could survive between runs are an artifact and the Actions cache, and both are readable by anyone who can read this public repository. |
| `app-role` mode loads anything      | It runs no export, transform, audit or load step. It only reads the live host and provisions the login role and its grants.                               |

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
| Cleared references   | Two kinds only. Reason `target drained`: a pointer into a drained worker table, which is `source_accounts.active_worker_scan_id`, either `source_accounts.*_worker_assessment_id`, any `source_inventory.*_scan_id`, `ingest_jobs.worker_discovery_work_id`, any `*.discovery_work_id`, or `worker_binary_operation_receipts.stage_id`. Reason `referenced api key no longer exists in the export`: any `*_credential_id` column. Any other column in that table is a stop, because it means a reference was dropped that the load should have kept. |
| Audit                | `no violations`. If there are violations, fix the rows in Convex and rerun; every violation is reported in one pass, so there is no fix-one-rerun cycle. |
| Skipped constraints  | Empty, or each entry understood. A skipped constraint is a gap, not a pass.                   |
| Parity               | `pass`, with `counts`, `retained_text_hashes`, `provenance_chains_sample` and `space_isolation_data` all `pass` |
| Pending parity checks | `archive_references` and `auth_denial_and_space_isolation_read_api` report `pending` from the CLI. Pending is not passing. Run them separately before the cutover window. |
| Backup rehearsal     | A parity capture with zero unvalidated constraints, and a sampled cited answer that either matched its citation hash or names why it was unavailable |
| App role             | Verdict `ok`, "Can read kith" true, "Refused CREATE" true, and an empty problem list |

Then run `live` with the confirmation string. In `live` the summary adds the
host verification table and the finance before and after comparison. The run
fails if the comparison is not `unchanged`, if `kith` already held rows before
the load, if a `kith` schema exists at any version other than the current one
(the host check accepts absent or current, nothing between), or if the live
parity rerun is not `pass`.

## If the live run stops at the app role

If a `live` run's load, its parity rerun and the finance comparison all
succeeded and only the app role step failed, the archive is already loaded.
Do not dispatch `live` again: `kith` now holds rows, and a second `live` run's
host check would refuse to proceed for that reason, as it should.

The app role step fails this way when the role behind
`KITH_MIGRATION_DATABASE_URL` is a hosted provider's project-owner role
without `CREATEROLE`. `scripts/cutover-app-role.mjs` cannot create the login
role there, and it says so in the failed report rather than throwing:
`app_role_create_forbidden:42501`, with a hint naming the fix.

To finish:

1. In the provider's console, create a role named exactly what the `app_role`
   input names (default `kith_app`), with `LOGIN` and no other attribute: no
   `CREATEDB`, no `CREATEROLE`, no `SUPERUSER`.
2. Set that role's password as the repository secret `KITH_APP_ROLE_PASSWORD`,
   replacing whatever was there before.
3. Dispatch the workflow again with `mode: app-role`. It needs no confirmation
   input. It runs no export, transform, audit or load; it reads the live host,
   then grants the role exactly what `grantProofAppRole` names and verifies
   the grant from a connection opened as that role, using the password from
   the secret.

Because the console, not this workflow, owns the password in this case, the
step does not attempt `ALTER ROLE ... PASSWORD` a second time. It records
`passwordManaged: "provider"` in the report and proves the secret is correct
by connecting as the role and reading `kith`: a wrong password fails that
connection and the report says `app_role_login_failed:<code>` rather than
reporting success.

Read the run summary and confirm it shows:

| Fact                | Expected  |
| -------------------- | --------- |
| `appRoleCanRead`     | `true`    |
| `appRoleCannotCreate` | `true`   |
| `passwordManaged`    | `provider` |

If the migration role also cannot `GRANT`/`REVOKE` on the `kith` schema (it
must own that schema), the report says `app_role_grant_forbidden:42501`
instead, with its own hint. That is a different, rarer problem: the migration
role's own privileges need fixing in the provider's console before `app-role`
mode can do anything.

Once the summary shows the table above, continue with "What stays manual: the
rest of step 9" below; the archive load and the role are both done.

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

   `KITH_DATABASE_URL` is composed, not copied from anywhere: the migration
   URL's host, port and database name, with the `app_role` input's value
   (default `kith_app`) as the user and `KITH_APP_ROLE_PASSWORD` as the
   password. The workflow's `live` run already created or updated that role
   and granted it what `grantProofAppRole` names, so the value only needs
   assembling:

   ```
   postgres://<app_role>:<KITH_APP_ROLE_PASSWORD>@<host>:<port>/<database>?sslmode=require
   ```

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
