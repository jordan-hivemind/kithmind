# @repo/ingest-simple

A stateless, idempotent document ingester for a Dropbox-style filesystem
folder. It walks a root directory, converts each new or changed `.pdf`,
`.txt`, `.md` or `.csv` file, and writes it into the same `kith` tables the
hosted product already reads (`kith.source_items`, `kith.documents`,
`kith.chunks`, ...) through `@repo/kith-store`'s existing provenance
functions. It replaces the durable filesystem worker
(`packages/kith-store/src/workers`, `packages/pipeline`): see
[`docs/plans/2026-09-22-simplification-and-feeds.md`](../../docs/plans/2026-09-22-simplification-and-feeds.md).

There is no journal, no lease, no retry budget and no receipt. A run that
fails partway through a file logs that file and moves on; the next run
(hourly, from a LaunchAgent, or by hand) simply tries every unconverted or
changed file again from scratch. Idempotency comes entirely from content
identity already in the schema: a file's sha256 is compared against the
active revision's `archive_ref` before anything is converted, so an unchanged
file is never re-read, re-OCR'd or re-staged.

## Do not run alongside the old worker

`packages/kith-store/src/workers` (the durable filesystem worker) and
`packages/pipeline` are frozen and must stay paused while this package runs
against the same source account. Both write into the same `kith.source_items`
/ `kith.processing_generations` rows; running both against the same root at
once is two writers racing the same identity, not two independent ingesters.

## Reusing the old worker's file identities

Without `--bindings`, this package uses each file's `relativePath` (relative
to `--root`) as its `kith.source_items.external_id`. The old filesystem
worker instead gave every file a random UUID `external_id`
(`packages/pipeline/src/runnerState.ts`'s `IdentityBinding`, journaled in its
`state.json`). Those two identities never match, so a first dry run against a
folder the old worker already indexed reports every file as new: running it
for real would create a second `kith.source_items` row per file instead of
picking up the existing one. `--bindings <state.json> --root-alias <alias>`
avoids that: it reads the old worker's journal (read-only -- this package
never writes to it), keeps the identity bindings for `<alias>`, and uses each
one's `externalId` in place of `relativePath` for the matching file, so the
transition reuses the existing source item and its history instead of
duplicating it. A file the old worker never saw still falls back to its
`relativePath`, exactly as before. Every run prints how many bindings loaded,
how many files matched one, and how many fell back to a path-derived id, so a
mismatched `--root-alias` (zero matches) or a stale journal is visible
immediately rather than discovered as duplicate source items later.

## Prerequisites

- Node 26+, this monorepo's usual toolchain (`pnpm install`, `pnpm --filter
  @repo/ingest-simple build`).
- [Poppler](https://poppler.freedesktop.org/) (`pdftotext`, `pdftoppm`, `pdfinfo`
  on `PATH`). On macOS: `brew install poppler`. PDF conversion shells out to
  these directly; there is no bundled PDF library.
- A Postgres connection string for the `kith` schema, already migrated
  (`applyKithSchema`).

## Usage

```
kith-ingest-simple --root <dir> --source-account <id> [--space <id>] \
  [--limit N] [--dry-run] [--concurrency 2] \
  [--bindings <state.json> --root-alias <alias>]
```

| Flag                | Meaning                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `--root <dir>`       | The Dropbox-style folder to walk. Required.                                                   |
| `--source-account <id>` | The `kith.source_accounts` row (connector `fs`) every write attributes to. Required.       |
| `--space <id>`       | Optional. Cross-checked against the source account's own `space_id`; a mismatch is a hard error, not a silent override. |
| `--bindings <path>` / `--root-alias <alias>` | Optional, and must be given together. Reuses the old filesystem worker's file identities for `<alias>` so a first run against a folder it already indexed does not register every file as new. See "Reusing the old worker's file identities" below. |
| `--limit N`          | Ingest at most N files this run (useful for a first, bounded pass over a large folder).       |
| `--dry-run`          | Walk and hash only. Prints what would be ingested; writes nothing, converts nothing.          |
| `--concurrency N`    | Files processed in parallel. Default 2.                                                       |

Every run prints a one-line-per-count summary to stdout (`seen`, `new`,
`skipped-unchanged`, `failed`, and unsupported-extension counts) and exits
non-zero if any file failed, with each failure's path and error on stderr.

The walker skips dotfiles/dot-directories and any path segment whose name
contains "archive" or "backup" (case-insensitive) — Dropbox's own
housekeeping copies and an owner's manual backup folders never get read.
Every other extension is counted and skipped; only `.pdf`, `.txt`, `.md` and
`.csv` are converted.

### Finding the source account ID

Open `/admin/sources` in the web app and find the connection whose type is
"Filesystem" (`connector = fs`) for the folder you want to ingest. The admin
UI does not currently print the raw id on that row; the reliable way to read
it is a direct query against the database:

```sql
SELECT id, name, space_id, enabled, created_by
  FROM kith.source_accounts
 WHERE connector = 'fs';
```

The account must have `enabled = true` and a non-null `created_by` (the
`kith.users` row every write this package makes is attributed to) before this
CLI can use it.

## Required environment

| Variable | Purpose | Required? |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string for the `kith` schema. | One of `DATABASE_URL` or the Keychain item below. |
| Keychain item `com.kithmind.deferred-work.database-url` (macOS, `security find-generic-password -s ... -w`) | Same connection string, read when `DATABASE_URL` is unset -- the same item the deferred-work daemon's wrapper script exports as `KITH_STORE_DATABASE_URL` (`docs/worker-service.md`, "Deferred work daemon"), mirroring how `packages/plaid-feed/src/config.ts` reads it. | |
| `KITH_EXTRACT_ENDPOINT` / `KITH_EXTRACT_MODEL` / `KITH_EXTRACT_API_KEY` (falls back to `OPENAI_API_KEY` on the default endpoint) | The OpenAI-compatible provider used both for OCR (a scanned PDF page with fewer than 40 non-whitespace characters) and for post-ingest classification. Same variables `packages/kith-store/src/extraction/provider.ts` already reads. | No. Missing config is logged once per run and that page/document is left unclassified; the document still appears. |
| `BRAIN_EMBED_*` (`packages/kith-store/src/embeddings/provider.ts`) | The embedding provider used for semantic search over newly ingested chunks. | No. Missing config is logged and embedding is skipped; the document still appears, just not in semantic search until a later run with the provider configured re-embeds it. |

Set `DATABASE_URL` directly, or provision the Keychain item once:

```
security add-generic-password -a "$USER" -s com.kithmind.deferred-work.database-url -w <postgres-url>
```

## What one run does

1. Resolve `--source-account` (and cross-check `--space` when given).
2. Walk `--root`, skipping dotfiles/archive/backup subtrees.
3. For each supported file: sha256 the bytes, and skip converting it if the
   source item's active revision already carries that hash.
4. Otherwise: convert to page text (`pdftotext`, OCR-ing any low-text page
   with `pdftoppm` + the extraction provider), then stage and activate it as
   a document in one transaction, through `@repo/kith-store`'s existing
   `createOrGetSourceItem` / `createOrGetRevision` / `createOrGetTextVersion`
   / `stagePages` / `stageEvidenceSpans` / `stageDocuments` / `stageChunks` /
   `activateSourceItemGeneration`, marking the new chunks eligible for
   embedding and enqueuing classification as part of the same transaction.
5. After the walk, drain queued classification jobs and run the embedding
   batch once, best-effort.

## Running hourly (LaunchAgent)

Copy `com.kithmind.ingest-simple.plist.example` into a real `.plist` under
`~/Library/LaunchAgents/`, replacing every `ABSOLUTE/PATH/...` placeholder
with a real path, then:

```
launchctl load ~/Library/LaunchAgents/com.kithmind.ingest-simple.plist
```

No owner path, account name or credential value belongs in the checked-in
template; only the loaded copy on the owner's own machine names them.

## Tests

```
pnpm --filter @repo/ingest-simple build
pnpm --filter @repo/ingest-simple exec node --test test/walk.test.mjs test/chunker.test.mjs test/convert.test.mjs test/bindings.test.mjs
pnpm --filter @repo/ingest-simple exec node --test test/postgresIngest.test.mjs test/bindingsTransition.test.mjs
```

The first four files are synthetic-fixture unit tests (no database, no
network, no real vendor SDK: OCR's `fetchImpl` is stubbed; `bindings.test.mjs`
covers `--bindings` parsing/validation against synthetic journal JSON). The
last two start and stop their own throwaway local Postgres cluster
(`initdb`/`pg_ctl`, under a scratch temp directory, deleted when the test
ends) and require `initdb` and `pg_ctl` on `PATH` with the `pgvector`
extension available (the same requirement `kith` migration 015 has everywhere
else in this repo). `bindingsTransition.test.mjs` proves the `--bindings`
transition end to end: a source item registered the old worker's way (a UUID
external id, an archived revision) reuses that same item, not a second one,
when this package's `ingestFile` runs with that UUID bound.
