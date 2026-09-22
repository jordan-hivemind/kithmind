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
  [--depth full|glance|auto] [--full-match <regex>]... \
  [--pdf-password <value>]... [--env-from-keychain]
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
| `--pdf-password <value>` | Repeatable. Candidate passwords for an encrypted PDF, tried in order (after no password) via poppler's `-upw`. See "Encrypted PDFs" below. Never logged. |
| `--env-from-keychain` | Reads the model-provider environment (`OPENAI_API_KEY`, `BRAIN_EMBED_MODEL`, `BRAIN_EMBED_MODEL_REVISION`) from the same macOS Keychain items the deferred-work daemon's wrapper script uses, for any of them left unset. See "Running from a shell with no provider configured" below. |

Every run (other than `--dry-run`) also retries any of this source account's
chunks that are registered as eligible for embedding but not yet covered by a
vector -- see "Embedding" below.

### One-off embedding backfill

```
kith-ingest-simple --backfill-embeddings --source-account <id> [--env-from-keychain]
```

Takes no `--root`: it walks nothing. For every source item on the account
with an active generation, it re-registers that generation's chunks as
embedding targets (a no-op for one already fully covered) and then runs the
same inline fill an ordinary run does. Use it once after fixing a provider
configuration issue to cover documents that were already ingested while the
provider was unconfigured or unreachable -- see "Embedding" below for why a
document can otherwise stay uncovered indefinitely.

Every run prints a one-line-per-count summary to stdout (`seen`, `new`,
`promoted`, `skipped-unchanged`, `failed`, `encrypted`, `ocr-skipped-pages`,
`retried`, `revision-conflicts`, unsupported-extension counts, and counts by
detected kind and by depth) and exits non-zero if any file failed, with each
failure's path and error on stderr. `encrypted`, `revision-conflicts`, a
retried-but-eventually-succeeded file, and a promotion are none of them
counted in `failed` -- each is a distinct, expected outcome with its own
count; see "Encrypted PDFs", "Revision conflicts" and "Serialization
retries" below.

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

**Total page count, original byte size and detected tax year** had no
existing home: `kith.documents` has no JSON/free-form column at all (it was
`kith.brain_documents` before migration 005 renamed it, and no migration
since had added one until now), and the near-document JSON-ish columns that
do exist (`kith.source_items.last_failure`, the old worker's own
failure-tracking contract; `kith.evidence_spans.locator`, citation locations
shown to users — writing metadata into it would fabricate a fake citation,
exactly the "page 0" trick this package was told not to do; and
`kith.source_triage_previews`, the triage-and-priority plan's own machinery,
which this package was told to take only the *intent* from, not reuse) were
not a safe place for it. Migration 046 adds
`kith.source_items.ingest_metadata jsonb` (nullable, additive — no CHECK on
shape, since this is provisional ingester-owned data, not a fact or
evidence). Every ingest and every depth promotion writes it in place
(`write.ts`'s `setSourceItemIngestMetadata`, a plain `UPDATE` inside the same
transaction as activation, outside the immutable provenance chain's own
rules) as one object:

```json
{
  "pageCount": 3,
  "byteLength": 214980,
  "taxYear": 2022,
  "kind": "tax_support",
  "depth": "glance",
  "converter": "pdftotext-poppler@25.09.0"
}
```

An encrypted PDF no `--pdf-password` opened (see "Encrypted PDFs" above)
carries an unknown `pageCount` (`null`) and an `encrypted` flag instead,
omitted (not `false`) for every ordinary document:

```json
{
  "pageCount": null,
  "byteLength": 88412,
  "taxYear": 2022,
  "kind": "tax_support",
  "depth": "glance",
  "converter": "encrypted-pdf-unreadable-v1",
  "encrypted": true
}
```

`pageCount` is the document's real total page count (from `pdfinfo` at glance
depth, from the actual converted page array at full depth) — for a
glance-depth document this is the number the stored single page does *not*
speak for. `taxYear` is `null` when `detectTaxYear` found none. `converter`
is the raw converter identity (`convert.ts`'s `converterFingerprint`, before
`depthPolicy.ts` folds in the depth); `depth` names the depth separately.
There is no reader for this column yet — an MCP change to expose it is
follow-up work — but it is now a real, queryable column rather than a log
line.

**Title.** When both a kind and a tax year are detected, the document's
title (`kith.documents.title` / `kith.source_items.title`, already read by
`getDocument` and search — no read-path change needed) becomes `<kind label>
<taxYear> · <filename>` (`src/title.ts`'s `buildTitle`, e.g. `Tax return 2018
· 2018-1040.pdf`, `K-1 2021 · acme-partners.pdf`, `Tax support 2019 · W-2
2019.pdf`), so a glance-depth document is findable by year in an ordinary
document list without opening it. With no detected tax year the title stays
the filename with its extension stripped, exactly as before this feature.

### Encrypted PDFs

A password-protected PDF fails poppler's `pdftotext`/`pdfinfo` with "Command
Line Error: Incorrect password" rather than partial output. Without a working
password, this package does not fail the file: it registers the file at
`glance` depth with no page text at all -- `kind` and any tax year come from
the filename alone -- and `full` metadata otherwise (byte size, and
`encrypted: true` in `kith.source_items.ingest_metadata`; page count is
unknown, `null`, since it is never opened). The document is still findable by
title and path, just not by content. Counted separately as `encrypted` in the
run summary, not `failed`.

`--pdf-password <value>` (repeatable) gives candidate passwords to try, in
order, via poppler's own `-upw`, after trying with no password. A password
that works is used for every poppler call that file needs (`pdftotext`,
`pdfinfo`, and `pdftoppm` if a page still needs OCR); no password is ever
logged. Because an already-registered encrypted file's `active_generation_id`
already carries `glance` depth, a later run supplying the right password only
retries conversion when this run's depth policy would otherwise raise it
(`--depth full`, a `--full-match` pattern, or the `dropbox-inbox` alias) --
`isUpToDate` (write.ts) has no way to know a newly-supplied password changes
anything about an unchanged file at an already-satisfied depth.

### Revision conflicts

`@repo/kith-store`'s `createOrGetRevision` treats a source item's revision as
immutable once inserted: a second call with the same extracted text
(`content_hash`) but a different `archive_ref` (this package's own file byte
hash) or `captured_at` (the file's `mtime`) is refused with "Conflicting
immutable source revision" rather than silently overwriting the earlier facts.
In practice this happens when a file already ingested is re-saved with
different bytes -- a metadata-only PDF rewrite, a linearization pass,
permissions added or removed -- that happen to extract to the exact same
text: this package's own unchanged-file skip check only compares the file's
own byte hash, so it cannot see this coming.

This is the store's immutability check doing its job, not a bug, and it is
not weakened here. This package catches it specifically and counts the file
under `revision-conflicts` in the run summary instead of `failed`; the
document already safely stored under the original bytes/mtime is left as is.
A file that keeps landing here on every run needs a person to look at why its
bytes keep changing without its extracted text changing.

### Serialization retries

`@repo/kith-store`'s own `withKithTransaction` already retries a
`SERIALIZABLE` transaction once on a `40001`/`40P01` Postgres error; this
package adds one more independent retry layer at the call site (`src/retry.ts`'s
`withSerializationRetry`, up to three attempts with a short randomized
backoff) around each file's own transaction, since the first real run over
522 files at `--concurrency 2` still reported "could not serialize access due
to read/write dependencies among transactions" as a hard per-file failure. A
file that needed at least one retry (whether it went on to succeed or still
exhausted the budget) is counted under `retried` in the run summary; one that
exhausts the retry budget is still counted as `failed`, same as before.

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

### Running from a shell with no provider configured

The first real run over the owner's folders was started from a plain shell,
which has none of `KITH_EXTRACT_*`/`OPENAI_API_KEY`/`BRAIN_EMBED_*`
configured -- only the deferred-work daemon's own LaunchAgent environment
does (`docs/worker-service.md`, "Deferred work daemon", and
`examples/worker-service/macos-keychain-watch.sh`'s wrapper pattern). The
run still completed, but every page that needed OCR logged "a page needs OCR
but no extraction provider is configured" (98 pages) and every embedding
attempt logged "Embedding provider request failed".

`--env-from-keychain` reads the same Keychain items that daemon's wrapper
script reads and fills in `OPENAI_API_KEY`, `BRAIN_EMBED_MODEL` and
`BRAIN_EMBED_MODEL_REVISION` for any of them the shell left unset (an
already-set value is never overwritten). `BRAIN_EMBED_MODEL`/
`BRAIN_EMBED_MODEL_REVISION` default to the daemon's own active embedding
generation, not `embeddings/provider.ts`'s baseline -- a mismatched profile
fails the request outright rather than writing a vector under the wrong
identity (see `src/providerEnv.ts`). No value is ever printed; only whether
the Keychain item was found. See
`com.kithmind.ingest-simple.plist.example` for an hourly LaunchAgent using
this flag.

### Embedding

`write.ts`'s `stageOneFile` marks every activated generation's chunks
eligible for embedding in the same transaction as activation
(`@repo/kith-store`'s `workers.touchWorkerPublicationEmbedding`, the same
function every other publisher uses) -- but only once the space already has
an active embedding generation/profile (its own doc comment calls this
"counted"; a space reaches it once, through an operator bootstrap, before any
publisher's touch does anything). Given that, `runIngest` retries the actual
embedding fill (`providerBatchEmbedder` + `runEmbeddingFill`,
`postProcess.ts`) on every non-dry run, not only a run that ingested
something new: a chunk can be eligible but not yet covered by a vector from
an earlier run (the provider was unconfigured then, as in the plain-shell run
above, or its scheduled `embedding_fill` job for the space exhausted its
retry budget) and a later, otherwise-uneventful run (every file
`skippedUnchanged`) is exactly what has to retry it, or it stays uncovered
until someone notices. `--backfill-embeddings` (see "Usage" above) is the
explicit, one-off version of the same retry for a source account's entire
already-ingested backlog.

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
pnpm --filter @repo/ingest-simple exec node --test test/walk.test.mjs test/chunker.test.mjs test/convert.test.mjs test/convertEncryptedPdf.test.mjs test/bindings.test.mjs test/classify.test.mjs test/depthPolicy.test.mjs test/fsUri.test.mjs test/title.test.mjs test/retry.test.mjs test/providerEnv.test.mjs
pnpm --filter @repo/ingest-simple exec node --test test/postgresIngest.test.mjs test/bindingsTransition.test.mjs
```

The first group is synthetic-fixture unit tests (no database, no network, no
real vendor SDK: OCR's `fetchImpl` is stubbed; `bindings.test.mjs` covers
`--bindings` parsing/validation against synthetic journal JSON;
`classify.test.mjs` and `depthPolicy.test.mjs` cover every detection pattern
and depth-policy branch; `fsUri.test.mjs` proves `toFsUri`'s output parses
back through `documentDropboxPath`'s own regex; `title.test.mjs` covers
`buildTitle`'s composed and fallback forms; `convertEncryptedPdf.test.mjs`
drives `EncryptedPdfError`/`--pdf-password` against a fake `pdftotext`/
`pdfinfo` placed first on `PATH` -- no `qpdf`/`pdftk` to build a real
encrypted fixture was available when this was written, so it also covers
`isIncorrectPasswordStderr`'s classification directly against real poppler
error text; `retry.test.mjs` covers `withSerializationRetry` with a fake that
throws a `40001`/`40P01`-shaped error; `providerEnv.test.mjs` covers
`applyProviderEnvFromKeychain`'s unset-only defaulting on a plain object, no
Keychain access). The last two start and stop their own throwaway local
Postgres cluster (`initdb`/`pg_ctl`, under a scratch temp directory, deleted
when the test ends) and require `initdb` and `pg_ctl` on `PATH` with the
`pgvector` extension available (the same requirement `kith` migration 015 has
everywhere else in this repo, and this package's own migration 046 -- see
"Depth policy" -- needs `applyKithSchema` at version 46 or later).
`bindingsTransition.test.mjs` proves the `--bindings` transition end to end: a
source item registered the old worker's way (a UUID external id, an archived
revision) reuses that same item, not a second one, when this package's
`ingestFile` runs with that UUID bound. `postgresIngest.test.mjs` also proves
the depth policy end to end: a synthetic tax-support document ingests at
glance (one page, real `doc_type`/`uri`/`captured_at`/`ingest_metadata`/
composed title), a same-policy re-run is a no-op, and `--depth full` promotes
it to a new full generation on the same source item -- `ingest_metadata`
updated in place, title unchanged -- while the glance generation becomes
historical; the encrypted-PDF registration path end to end, with and without
a working `--pdf-password`, through a fake `pdftotext`/`pdfinfo` on `PATH`
(`ingest.ts`'s `encryptedFallback` handling); write.ts's
`RevisionConflictError` directly against real Postgres -- two `ingestFile`
calls for the same source item whose extracted text matches but whose file
facts (byte hash, `capturedAt`) do not, proving the store's own immutability
check still refuses the write and that this package classifies the refusal
distinctly rather than treating it as an ordinary failure; and the "Embedding"
section above end to end, against a fake OpenAI-compatible embeddings
endpoint (a real `node:http` server, no network, no vendor SDK): a synthetic
document's chunks get real `embedding_targets`/`embedding_vectors` rows once
the space has an active embedding generation and the provider is configured;
a steady-state re-run (no new files) still covers a chunk left uncovered by
an earlier run once the provider becomes configured, proving `runIngest` no
longer skips the fill just because nothing activated this run; and
`--backfill-embeddings` covers a document ingested before the space had an
embedding generation active, and is idempotent -- a second run embeds nothing
and calls the provider zero more times.
