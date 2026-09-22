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
  [--root-alias <alias>] [--bindings <state.json>] \
  [--depth full|glance|auto] [--full-match <regex>]...
```

| Flag                | Meaning                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `--root <dir>`       | The Dropbox-style folder to walk. Required.                                                   |
| `--source-account <id>` | The `kith.source_accounts` row (connector `fs`) every write attributes to. Required.       |
| `--space <id>`       | Optional. Cross-checked against the source account's own `space_id`; a mismatch is a hard error, not a silent override. |
| `--root-alias <alias>` | Names the root being walked. Optional on its own, but every ingested document's retrievable `uri` (`fs://<alias>/<relativePath>`, see "Depth policy" below) needs it, and so does the `dropbox-inbox` depth rule -- pass it on every real run. Required together with `--bindings`. |
| `--bindings <path>` | Optional, and requires `--root-alias`. Reuses the old filesystem worker's file identities for `<alias>` so a first run against a folder it already indexed does not register every file as new. See "Reusing the old worker's file identities" below. |
| `--limit N`          | Ingest at most N files this run (useful for a first, bounded pass over a large folder).       |
| `--dry-run`          | Walk and hash only. Prints what would be ingested; writes nothing, converts nothing, does not classify a file's kind or depth (see below). |
| `--concurrency N`    | Files processed in parallel. Default 2.                                                       |
| `--depth full\|glance\|auto` | Overrides the depth policy for every file this run. Default `auto`. See "Depth policy". |
| `--full-match <regex>` | Repeatable. A relative path matching any of these regular expressions is ingested in full, same as a `tax_return`/`k1` document or the `dropbox-inbox` root alias. |

Every run prints a one-line-per-count summary to stdout (`seen`, `new`,
`promoted`, `skipped-unchanged`, `failed`, unsupported-extension counts, and
counts by detected kind and by depth) and exits non-zero if any file failed,
with each failure's path and error on stderr.

The walker skips dotfiles/dot-directories and any path segment whose name
contains "archive" or "backup" (case-insensitive) — Dropbox's own
housekeeping copies and an owner's manual backup folders never get read.
Every other extension is counted and skipped; only `.pdf`, `.txt`, `.md` and
`.csv` are converted.

## Depth policy

Most of the owner's tax-support paperwork (receipts, 1099s, statements,
letters) doesn't need full-text indexing — just enough metadata for the MCP
to know the document exists and where to find it. Returns and K-1s do need
full text, indefinitely: "Go back as far as we have for the returns
themselves."

Every file gets classified from its filename and page-1 text alone (no model
call: `src/classify.ts`'s `detectKind`/`detectTaxYear`) into `tax_return`,
`k1`, `tax_support`, `statement` or `other`, and a tax year when one is
findable. `src/depthPolicy.ts`'s `decideDepth` then picks a depth:

| Depth | When | What is stored |
| --- | --- | --- |
| `full` | `kind` is `tax_return` or `k1`; the root alias is `dropbox-inbox`; the relative path matches a `--full-match` pattern; or `--depth full` | Every page, exactly as before this feature existed. |
| `glance` (default otherwise) | Everything else | Page 1 only (OCR'd the same way a full conversion would OCR a low-text page), read via `pdftotext -f 1 -l 1`; the document's real total page count comes from `pdfinfo`, cheaply, without extracting the rest. |

There is no year cutoff in either direction: an old return glanced at some
point is still promoted to full the same as a new one, and a new return is
never left at glance because it's recent.

`--depth full|glance|auto` overrides this policy outright for the whole run;
`auto` (the default) applies the table above per file. A document is never
automatically demoted: once ingested in full, it stays full even if a later
run's policy would now only glance it.

**Promotion.** Re-running with a policy that now calls for `full` on a
document currently at `glance` (a returns folder gets a `--full-match`
pattern, say, or the owner runs `--depth full` once over a chosen directory)
produces a **new** processing generation for the same source item, with the
same file bytes but the fuller extracted text — the old glance-depth
generation becomes historical, not deleted. This works because `glance` and
`full` extract different text (so `createOrGetRevision`'s
`sha256(extracted text)` identity differs) and because the depth is folded
into the extraction fingerprint (`depthPolicy.ts`'s
`withDepthFingerprint`/`depthFromFingerprint`), so even a document whose
extracted text happens to be identical at both depths (a one-page PDF, or any
non-PDF file — glance and full are the same conversion for those) still mints
a new generation when its depth changes. The run summary's `promoted` count
is exactly these cases, counted separately from `new`.

**Where the metadata lives.** Three of the fields the owner asked for map
onto real, already-read columns rather than a new one:

| Field | Column | Why it fits |
| --- | --- | --- |
| Detected kind | `kith.source_items.doc_type` / `kith.documents.doc_type` | This is already "the parser's own type" (`documents/model.ts`'s `effectiveDocType`, section 4.2 of `docs/plans/2026-09-12-document-cards.md`) — the field a later classification pass patches with a finer-grained kind. Writing our coarse kind here first is consistent with that contract, not a repurposing of it. |
| Relative path | `kith.source_items.uri` (only when `--root-alias` is given) | Written as `fs://<rootAlias>/<relativePath>` (`src/fsUri.ts`), the exact scheme `apps/web/src/lib/kith/document-content.ts`'s `documentDropboxPath` already parses back to serve the original file — this is the real "so the MCP knows where to find them" mechanism, not a label. |
| File modified time | `kith.source_revisions.captured_at` / `kith.documents.captured_at` | Previously the ingest wall-clock (`new Date()`); now the file's own `mtime`, which is what "captured at" should mean for a filesystem source and is deterministic across re-runs of an unchanged file. |

**Total page count, original byte size, and detected tax year have no
existing home.** `kith.documents` has no JSON/free-form column at all (it was
`kith.brain_documents` before migration 005 renamed it, and no migration
since has added one); the only JSON-ish columns near a document are
`kith.source_items.last_failure` (the old worker's own failure-tracking
contract), `kith.evidence_spans.locator` (citation locations shown to users —
writing metadata into it would fabricate a fake citation, exactly the "page
0" trick this package was told not to do), and `kith.source_triage_previews`
(the triage-and-priority plan's own machinery, which this package was told to
take only the *intent* from, not reuse). None of these are a safe place for
this data. This PR computes total page count, tax year and (implicitly) raw
byte size for policy decisions and logs them per file
(`glance (page 1 of N; kind ...; tax year ...)`), but does not persist them as
queryable per-document fields. A `kith.source_items.ingest_metadata jsonb`
column (nullable, additive) would let a future change store them properly;
until then, an MCP caller cannot query "how many pages does this glanced
document actually have" without opening it.

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
3. For each supported file: sha256 the bytes, and skip it entirely if the
   source item's active revision already carries that hash at a depth this
   run does not need to raise (`write.ts`'s `isUpToDate`).
4. Otherwise: read page 1 (`pdftotext -f 1 -l 1`, OCR'd the same way a
   low-text page would be) and the real total page count (`pdfinfo`),
   classify the document's kind and tax year from the filename and that page
   (`classify.ts`), and decide a depth for it (`depthPolicy.ts`, or
   `--depth`). At `glance` depth, that page-1 text is what gets staged; at
   `full`, the whole file is converted (`pdftotext`, OCR-ing any other
   low-text page). Either way, stage and activate it as a document in one
   transaction, through `@repo/kith-store`'s existing `createOrGetSourceItem`
   / `createOrGetRevision` / `createOrGetTextVersion` / `stagePages` /
   `stageEvidenceSpans` / `stageDocuments` / `stageChunks` /
   `activateSourceItemGeneration`, marking the new chunks eligible for
   embedding and enqueuing classification as part of the same transaction.
5. After the walk, drain queued classification jobs and run the embedding
   batch once, best-effort.

See "Depth policy" above for what `glance` actually stores, when a document
gets `full` depth instead, and where its detected kind, relative path and
file-modified-time end up.

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
pnpm --filter @repo/ingest-simple exec node --test test/walk.test.mjs test/chunker.test.mjs test/convert.test.mjs test/bindings.test.mjs test/classify.test.mjs test/depthPolicy.test.mjs test/fsUri.test.mjs
pnpm --filter @repo/ingest-simple exec node --test test/postgresIngest.test.mjs test/bindingsTransition.test.mjs
```

The first group is synthetic-fixture unit tests (no database, no network, no
real vendor SDK: OCR's `fetchImpl` is stubbed; `bindings.test.mjs` covers
`--bindings` parsing/validation against synthetic journal JSON;
`classify.test.mjs` and `depthPolicy.test.mjs` cover every detection pattern
and depth-policy branch; `fsUri.test.mjs` proves `toFsUri`'s output parses
back through `documentDropboxPath`'s own regex). The last two start and stop
their own throwaway local Postgres cluster (`initdb`/`pg_ctl`, under a scratch
temp directory, deleted when the test ends) and require `initdb` and `pg_ctl`
on `PATH` with the `pgvector` extension available (the same requirement
`kith` migration 015 has everywhere else in this repo).
`bindingsTransition.test.mjs` proves the `--bindings` transition end to end: a
source item registered the old worker's way (a UUID external id, an archived
revision) reuses that same item, not a second one, when this package's
`ingestFile` runs with that UUID bound. `postgresIngest.test.mjs` also proves
the depth policy end to end: a synthetic tax-support document ingests at
glance (one page, real `doc_type`/`uri`/`captured_at`), a same-policy re-run
is a no-op, and `--depth full` promotes it to a new full generation on the
same source item while the glance generation becomes historical.
