# Personal-space migration

P1-1 adds optional space ownership and internal migration tools. Existing web
and MCP reads and writes remain user-scoped. This migration does not enable
family sharing. API-key scopes and required space ownership belong to P1-2.

## Development procedure

Run from `packages/convex` using the installed dependencies. Verify that
`.env.local` selects the intended development deployment and that no shell
deployment key or self-hosted override selects a different target. The web
app's Convex URL is a separate setting and may point elsewhere.

Push the transitional schema to development:

```sh
npx convex dev --once
```

Process each stage fully before starting the next:

| Order | Migration                 | Audit                  |
| ----- | ------------------------- | ---------------------- |
| 1     | `bootstrapPersonalSpaces` | `auditPersonalSpaces`  |
| 2     | `backfillEntitySpaceIds`  | `auditEntitySpaceIds`  |
| 3     | `backfillFactSpaceIds`    | `auditFactSpaceIds`    |
| 4     | `backfillThoughtSpaceIds` | `auditThoughtSpaceIds` |

For each stage, first run all pages with `dryRun: true`, then all pages with
`dryRun: false`, then all audit pages. Example first-page calls:

```sh
npx convex run --deployment dev models/spaces/migrations:bootstrapPersonalSpaces '{"dryRun":true,"batchSize":100}'
npx convex run --deployment dev models/spaces/migrations:bootstrapPersonalSpaces '{"dryRun":false,"batchSize":100}'
npx convex run --deployment dev models/spaces/migrations:auditPersonalSpaces '{"batchSize":100}'
```

Replace the function name for subsequent stages. When `isDone` is false,
pass the returned `cursor` in the next call with the same stage and options.
Restart from the first page when changing between dry run, mutation and audit.
Sum counts across pages; the response only describes the current page.

`wouldChange`, `skipped` and `invalidCount` partition the examined rows into
valid rows needing a change, valid rows already migrated, and invalid rows.
`changed` counts only writes actually applied. It is zero in a dry run or
blocked page.

A mutating page with `blocked: true` writes nothing and returns the input
cursor. Stop that run and inspect the reported row IDs. Do not loop that cursor
or skip the invalid page. Dry runs and audits can continue through all pages
to inventory problems. Diagnostics are capped, so reduce `batchSize` to
inspect more individual failures. Resolve malformed data explicitly and
repeat the dry run. Do not automatically reassign shared or foreign records.

Fact and thought pages are capped at four rows, with a 1 MB initial-page read
budget and a shared budget of 13 unique content references. A reference-budget
diagnostic requires retrying with a smaller batch, down to one row. Histories
exceeding the supported ten-reference limit require explicit review; migration
never truncates history. These are migration limits, not a new product policy
for historical records. Diagnostic output includes at most 25 rows and eight
reasons per row.

Content dry runs require the preceding setup and entity stages to have
actually completed. Dry run does not create placeholder spaces or simulate
entity backfills for later stages.

## Acceptance and cutover

Every stage must finish with zero missing and invalid counts. Repeat the
mutating stages once; an idempotent rerun changes zero rows. Existing authors,
content, source references and vectors must be preserved. A configured default
write destination is preserved, including one that will require validation by
P1-2.

P1-1 deliberately leaves legacy writers unchanged, so new records can still
arrive without `spaceId`. Its audit is a point-in-time result, not proof that
the required-field cutover is ready. P1-2 must update writers, rerun the
migration and audit, and coordinate the cutover before making the field
required. Never enable shared-space writes while the legacy authorization
paths remain active.

Production migrations and deployments require the owner's explicit approval.
The current main-branch workflow deploys Convex when backend code changes, so
merging a backend PR is also a production deployment decision.
