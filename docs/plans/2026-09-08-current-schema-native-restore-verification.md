# Current-schema native restore verification

**Status:** Passed on 2026-09-08 against schema commit `169da03140380ec6e44819a35a3a7e85d40e6f9e`.

## Purpose

P2-5 proved an isolated native restore before PDF evidence used the
`parser_page_v1` locator. P2-19 added that durable locator and higher bounded
PDF capacity without adding a table. P2-21 added indexes and bounded cleanup
phases without changing the stored cleanup-checkpoint shape. This focused
verification refreshes the document-Q&A restore gate for the current durable
shape. It does not replace the earlier archive-byte recovery drill or claim a
new recovery-time objective.

## Fixture and isolation

The fixture was a synthetic three-page Unicode PDF graph represented by
metadata. Each page produced one page-local chunk and one evidence span. The
three locators used `parser_page_v1` with an exact parser artifact ID, one-based
page number, and page text SHA-256. The fixture contained no owner document or
original byte payload.

Before creating it, the owner workflow verified the explicit development
deployment, owner role in the selected synthetic space, local worker endpoint,
and empty fixture namespace. A native snapshot including file storage was
taken before any fixture write. The live flow then exercised archived
admission, parsed begin, all four payload phases, seal, activation, retries,
three keyword searches, document read, and indexed processing-state queries.

The restore target used a bundle built only from the current `schema.ts`. It
ran a fresh local Convex backend with a new SQLite database, storage directory,
home directory, and admin key. Both listeners were bound to loopback. A macOS
sandbox denied outbound network access. The deployment contained no functions,
HTTP routes, auth configuration, or cron definitions. The backend was stopped
after export, and no listeners remained.

## Results

| Check | Result |
| --- | --- |
| Pre-fixture development snapshot | 69 document-table files and 276 rows |
| Current schema bundle | 262 inputs and 83,278 bytes; only `convex/server` and `convex/values` remained external |
| Fixture graph | 3 pages, 3 evidence spans, 1 document, and 3 chunks |
| Native restored snapshot | 137 entries, 69 document-table files, and 329 rows |
| Snapshot equality | All 329 decoded JSON rows matched; 68 other entries matched byte for byte; no entry was added or omitted |
| Locator and citation verification | All 3 `parser_page_v1` locators matched the restored parser artifact, page number, and page text hash |
| Text verification | Page hashes, UTF-16 quote slices, quote hashes, complete text hash, chunk coverage, and mapping-manifest digest matched |
| Recovery linkage | Active item/revision/generation pointers, ready ingest job, completed activation receipt, generation ID, and activation time matched |
| Live read linkage | Three pre-export keyword reads resolved to the same restored document and the exact restored chunks and evidence spans |
| P2-21 indexed state | Stage, binary receipt, and payload-manifest indexed reads matched before and after the native round trip |
| Isolation | Outbound access denied, zero application functions, backend stopped, and zero listeners remained |

The first private helper attempt stopped before archive admission because it
compared a descriptive chunker label with the current hashed chunking
fingerprint. That exact source item was forgotten, its key was revoked, and its
source was disabled before the successful fixture began. It published no
document, parser artifact, retained text, or citation. The successful helper
uses the current hashed fingerprint. Its activation retry received two HTTP
successes, but the original helper compared an absent response field. The
restore proof therefore does not rely on that comparison. It instead verifies
the persisted completed activation receipt, ready job and generation, active
item pointers, generation linkage, and identical activation time.

## Cleanup and final audit

Before cleanup, the successful fixture occupied 46 rows across 25 tables. The
forget flow paginated four archive targets in pages of two, acknowledged each
target with an exact retry, and completed in bounded calls. It then verified a
redacted forgotten tombstone, revoked key, disabled source, hidden search
result, and zero remaining rows for the hosted document graph, revisions,
parser artifacts, generations, parsed stages, binary operation receipts, and
payload manifests.

The original pre-write snapshot and final post-cleanup snapshot differed by 15
added rows and four changed rows. The additions are the two disabled synthetic
sources, two forgotten tombstones, two alias digests, two scan pages, two scan
records, three reservation receipts, and two rate-limit rows from the stopped
and successful attempts. The four pre-existing rows changed only the embedding
eligibility epoch, processing activation epoch/time, query visibility
epoch/time, and cleanup scheduler phase/checkpoints. No existing content row
was deleted or changed. These retained audit rows and operational epochs are
the expected result of activation and forget; the native snapshot was never
imported back into development.

## Commands and retained evidence

The owner verification used the exact development deployment on every Convex
command. Its bounded sequence was:

```text
convex export --deployment <exact-development-name> --include-file-storage
esbuild packages/convex/convex/schema.ts --bundle --platform=node --format=esm --external:convex/server --external:convex/values
convex deploy --typecheck disable --codegen disable
convex import --replace-all --yes <fixture-snapshot>
convex export --include-file-storage
```

Private evidence retains the three development snapshots, restored snapshot,
schema bundle and metafile, exact row comparison, restored graph verification,
fixture IDs, cleanup acknowledgements, failed-attempt cleanup, and final scope
audit. Directories use mode `0700`; files use mode `0600`. No private ID,
credential, or owner content is stored in the repository.

This satisfies the first document-Q&A trial's current-schema native restore
requirement for the `parser_page_v1` persisted shape. A later trial must rerun
the drill when it adds a durable table or a new persisted shape that its
restore acceptance depends on.
