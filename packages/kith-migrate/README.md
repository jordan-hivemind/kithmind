# @repo/kith-migrate

Export, transform, COPY-load and parity harness for the PostgreSQL
consolidation (P2-39b). Reads a Convex export, maps every non-retired table
to the `kith` schema from one declarative mapping (`src/schema.ts`), loads it
into an isolated destination database, and checks parity against the export.

See [`docs/plans/2026-09-12-postgres-consolidation.md`](../../docs/plans/2026-09-12-postgres-consolidation.md)
for the design this package implements (sections 1.2, 2.2, 2.3, 3 steps 2-5,
and 6, row P2-39b).

## How this fits with `@repo/kith-store` (P2-39a)

`@repo/kith-store` (grown from `packages/postgres-proof`) owns the `kith`
schema bootstrap, the migration runner over `kith.schema_version`, the
preserved-text id convention (the `kith.kith_id` domain and `newKithId`), the
pool that pins `search_path`, the `SERIALIZABLE`-with-retry transaction
helper, and the space-predicate helper. This package does not restate any of
that:

- `src/ddl.ts` generates table content only (no `CREATE SCHEMA`, no version
  table, no recorded-version insert) and every id/space_id/reference column
  is typed `kith.kith_id`, kith-store's domain, not a bare `text`.
- The generated SQL is committed as
  [`packages/kith-store/migrations/004_kith_migrate_tables.sql`](../kith-store/migrations/004_kith_migrate_tables.sql)
  and registered in `KITH_MIGRATIONS` in `packages/kith-store/src/schema.ts`
  as version 4 — one more migration for kith-store's own runner to apply, not
  a second one. Regenerate it with `pnpm --filter @repo/kith-migrate
  generate:migration`; a test (`test/ddl.test.mjs`) fails if the checked-in
  file drifts from `src/schema.ts`.
- `load.ts` applies the schema through kith-store's own `applyKithSchema` and
  `createKithPool`, and `parity.ts`'s checks all run through
  `createKithPool` + `withKithTransaction`. The one exception is the COPY
  step itself: `psql \copy` needs its own connection because COPY is a
  different wire protocol than the one `pg` (and therefore kith-store's pool)
  speaks — see "The COPY loader" below.

### Reconciling the table-name collision

Five of this row's tables collide by name with tables kith-store's own
prototype migrations (`migrations/001_init.sql`, `002_worker_jobs.sql`)
already created for its synthetic proof harness: `spaces`, `api_keys`,
`documents`, `source_revisions`, `chunks`. **The prototype's tables win the
bare name.** They are `uuid`-keyed, and kith-store's own passing test suite
(`validation.test.mjs`, the `postgres-proof` integration test) inserts real
hyphenated `randomUUID()` values into them — values the `kith.kith_id`
domain's character class refuses outright. Retyping those columns in place
would be real, invasive surgery on another row's already-merged, tested
schema, and the plan already assigns the real port of these five domains to
P2-39c (`spaces`, `api_keys`) and P2-39d (`documents`, `source_revisions`,
`chunks`) as part of their much larger scoped work (36 and 34 hours
respectively) — not to this row's 24.

So this row's Convex-mapped versions of the same five domains land under a
`brain_` prefix instead: `kith.brain_spaces`, `kith.brain_api_keys`,
`kith.brain_documents`, `kith.brain_source_revisions`, `kith.brain_chunks`.
Every other table and foreign key in the mapping is unaffected (`source_accounts`,
`processing_generations`, `evidence_spans`, `source_pages`, and so on were
never prototype names). This keeps the full 70-table pipeline provable
end-to-end without touching or risking kith-store's tested schema; P2-39c and
P2-39d should absorb or rename these into the final `kith.<name>` when they
land (verified non-breaking: `pnpm --filter @repo/kith-store test:once`
against a real database passes unchanged with migration 4 applied).

## Commands

All commands are run from this package with `pnpm --filter @repo/kith-migrate
<script>`, or via the built CLI: `node dist/cli.js <command> [options]`.

| Command | What it does |
| --- | --- |
| `ddl:generate --out <path>` | Writes the generated table-and-foreign-key SQL. Defaults to `../kith-store/migrations/004_kith_migrate_tables.sql`; a test fails if the checked-in file drifts from `src/schema.ts`. |
| `export --source <zip-or-dir> --out <dir> [--deployment-identity --schema-version --git-revision]` | Reads a Convex export into per-table JSONL plus a manifest (row counts, byte lengths, SHA-256 per table). |
| `export --verify-manifest --dir <dir>` | Recomputes each table file's hash, count and byte length and compares with the manifest. |
| `transform --export <dir> --out <dir> [--report-unmapped]` | Maps every table in `src/schema.ts` to COPY-ready CSV under `out`, plus `transform-report.json`. Without `--report-unmapped`, an unmapped Convex field is a hard failure, not a dropped column. |
| `load --csv <dir> --database-url <url>` | Applies every `kith` migration (via kith-store's runner, if not already applied) and COPY-loads every CSV into `<url>` in one transaction with every foreign key deferred until commit. Never point this at the live archive database. |
| `parity --database-url <url> --export <dir> [--manifest --transform-report]` | Runs the parity checks below against the loaded destination. |

## The declarative mapping (`src/schema.ts`)

One entry in `TABLES` per Postgres table: whether it is space-scoped,
whether it is `migrated` (loaded at all) or has DDL only (drained before
cutover, recreated empty, or re-embedded — plan section 1.2 and 5.1 name the
tables and the reason for each), and its columns. `ddl.ts` generates the
schema from this list and `transform.ts` maps rows from the same list, so the
two cannot drift on their own (a test enforces this directly).

Column rule, mechanically:

- `id`, `space_id` (if scoped) and `created_at` (from `_creationTime`) are
  structural and implicit; nothing in `TABLES` names them. All three are
  typed to kith-store's `kith.kith_id` domain except `created_at`, which is
  `timestamptz`.
- Every `v.id("X")` field becomes its own `kith.kith_id` foreign-key column
  typed to `X`, never jsonb, so the provenance and space-isolation checks
  below have real foreign keys to walk.
- Every scalar field (string, number, boolean, or a literal/union of
  literals) becomes its own nullable typed column.
- Every array or nested object becomes `jsonb`, unless the plan names a
  child table for it. Today that is only `apiKeys.spaceIds` and
  `apiKeys.sourceAccountIds`, which become `kith.api_key_spaces` and
  `kith.api_key_source_accounts`.
- `thoughts.embedding` is the one field the plan says to drop rather than
  store (section 5.1); it is declared in `excludedFields` so the unmapped-field
  check treats it as deliberate and exports it to a cold JSONL audit file
  under `_excluded/` instead of a column.

ponytail: every declared column beyond the three structural ones is nullable,
and there are no CHECK constraints or tsvector/pgvector columns here. Convex's
required/optional split, money-as-NUMERIC, and the search/vector index work
belong to the rows that own each domain (P2-39c through P2-39l); this row's
job is structural fidelity and the six parity checks, not the final
production schema.

## Foreign keys and space isolation

Every space-scoped table carries `space_id` and `UNIQUE (id, space_id)`
(plan 2.2). A reference to another space-scoped table is a composite foreign
key `(col, space_id) REFERENCES target(id, space_id)`, so a row that would
point across spaces cannot be loaded at all — `integration/load-parity.test.mjs`
proves this by corrupting one row's reference after the transform and
asserting the whole load is refused and rolled back, not partially applied.

Every foreign key is `DEFERRABLE INITIALLY DEFERRED`; the loader issues
`SET CONSTRAINTS ALL DEFERRED` so every table's CSV can load in one
transaction regardless of reference order, then every constraint is checked
once at COMMIT (plan section 3 step 4).

## The COPY loader

`load.ts` shells out to `psql \copy`, not `pg-copy-streams`: `pg` cannot speak
the COPY protocol on its own, and the workspace does not add a new dependency
for it. `packages/kith-store/integration/docker-postgres.mjs` already shells
out to `pg_dump`/`pg_restore` the same way. Everything else (applying the
migration, the parity queries) goes through `@repo/kith-store`'s pool and
transaction helper.

## Parity harness (plan section 3 step 5)

Six checks; four are real today, two are stubs whose interface is defined
for row P2-39c to fill in (the tracker's own instruction for this row):

| Check | Status | What it does |
| --- | --- | --- |
| Counts | real | Every migrated table's destination row count equals the export manifest's; every table marked `migrated: false` here (drained, recreated empty, or re-embedded) is exactly zero regardless of what the export held. |
| Retained text hashes | real | Recomputes the SHA-256 of every `source_pages.text` and `brain_chunks.text` in the destination, compares it with the hash recorded at transform time, and compares the recomputed set with that same set. |
| Provenance chains | real (sample) | For a sample of documents, walks document → source revision → processing generation → source pages → evidence spans in one query and asserts the chain resolves within one space. |
| Space isolation (data) | real | Every space-scoped row's `space_id` matches the export, and (as a second, independent check beyond the schema's own composite foreign keys) no row's reference crosses into a different space. |
| Archive references | **pending** | Needs the always-on host's archive catalog, which this harness never touches (synthetic fixtures only, per this row's instructions). `ArchiveCatalogLookup` in `parity.ts` is the interface a real cutover run (P2-39m) supplies. |
| Auth denial / space isolation (read API) | **pending** | Needs the session, credential and space-membership surface P2-39c builds. `AuthDenialSurface` in `parity.ts` is the interface; until it is supplied the check reports `pending`, not passing. |

## Tests

- `pnpm --filter @repo/kith-migrate test:once`: unit tests against a synthetic
  fixture (`test/fixtures/buildFixture.mjs`, two invented households, Rowan's
  and Sage's, no real people, ids derived deterministically from readable
  labels so they satisfy `kith.kith_id`) — export (directory and zip),
  transform, unmapped-field detection, the excluded-field audit file,
  retained-text hashing, and the DDL/mapping drift guard, plus a check that
  kith-store's `KITH_MIGRATIONS` really has this migration registered as
  version 4. No database required.
- `pnpm --filter @repo/kith-migrate test:integration`: the same fixture
  through export → transform → COPY load → parity against a throwaway
  Postgres 17, plus the cross-space-reference rejection test. Tries the CI
  `postgres-proof` job's Docker-managed cluster first
  (`packages/kith-store/integration/docker-postgres.mjs`), then a local
  throwaway database (this repo's own dev machine runs Postgres 17 on
  `127.0.0.1:5433`), and skips with a clear message if neither is reachable.
  Set `KITH_MIGRATE_TEST_DATABASE_URL` to point it at a specific database
  instead.
