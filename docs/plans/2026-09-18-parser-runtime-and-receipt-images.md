# Parser runtime relocation and receipt image intake

Date: 2026-09-18
Task: P2-104

Two operator problems, both in the way of bulk ingestion.

1. The production parser runs from whichever checkout the config points at, and
   every field that identifies it is transcribed by hand. A parser update meant
   editing eight values and left the watcher refusing to start until all eight
   were right.
2. A receipt handed over on paper and photographed is a jpg, png or heic.
   Intake admits PDF and xlsx only, so those files were inventoried and never
   parsed.

## Parser runtime

The parser belongs to the checkout that owns the config, not to the root
workspace. `scripts/parser-runtime-setup.mjs` builds it and prints the config
block for it:

```sh
node scripts/parser-runtime-setup.mjs
```

It creates the venv from the pinned `uv.lock`, downloads the locked model
assets and verifies them against the tracked `model-assets.lock.json`, asks the
launcher for its own `parserFingerprint` and
`extractionConfigurationFingerprint`, and prints `pdfDocQa.parser` and
`pdfDocQa.profile` with every value filled in. It writes nothing outside the
parser checkout: the config is printed for the operator to paste, never saved,
so no private file is read or touched.

`--skip-models` reuses model assets already present. `--parser-root` points at
a parser directory in another checkout.

### Switching production to a new parser

| Step | Command or action                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Pull and build the worker checkout that will own the parser.                                                                                                                                                                |
| 2    | `node scripts/parser-runtime-setup.mjs` in that checkout.                                                                                                                                                                   |
| 3    | Paste the printed `parser` and `profile` values into the private config, keeping the existing `extractorFingerprint`, `recordSchemaFingerprint`, `normalizationFingerprint`, `chunkerFingerprint` and `correctionRevision`. |
| 4    | Restart the watcher once the current pass has finished.                                                                                                                                                                     |

If the config sets `pdfDocQa.parser.tableStructure` or `tableStructureBypass`,
pass the same values to the setup script (`--table-structure off`,
`--table-structure-bypass '<json>'`). Both feed the parser fingerprint's
configuration and therefore the extraction configuration fingerprint derived
from it, so a run that omits them prints fingerprints the worker will refuse.
Measured: `on` and `off` give different fingerprints, and a bypass policy gives
a third. The script prints back whatever it was given, so the pasted block
stays whole.

Step 4 waits for the pass to finish because the journal adopts a changed
configuration only while it is quiescent (P2-104b). `doctor` names which it is:
`config_rebind_pending` means the next start adopts it, `config_rebind_blocked`
means work is still in flight. Restoring the previous config is always
available and reopens the journal the same way, so a bad paste is recoverable.

### What a profile transition does today

The parser fingerprint is part of the processing identity, and only of the
processing identity:

| Digest                     | Includes the parser fingerprint | Effect when it changes      |
| -------------------------- | ------------------------------- | --------------------------- |
| `inventoryMetadataDigest`  | No, only `parserProfileId`      | observation epoch unchanged |
| `processingIdentityDigest` | Yes                             | processing epoch advances   |

`packages/kith-store/src/workers/digests.ts:120-133` composes both.
`persistResolvedEntry` (`packages/kith-store/src/workers/entries.ts:872-884`)
raises `worker_processing_epoch` when the processing identity digest differs,
marks the entry `queued`, and creates new discovery work. On the client,
`matchingProcessingRows` (`packages/pipeline/src/runner.ts:1325-1337`) compares
the full fingerprint tuple, so no prior row matches and
`createArchivedIntents` starts a fresh processing row. Prior rows are retained,
never deleted, which is what keeps the archive catalog history intact.

No manual SQL and no migration is required for a parser change.

The client side has one more gate, and the first version of this document
missed it. `journalBindingForConfig` (`packages/pipeline/src/config.ts:944-973`)
hashes the whole `pdfDocQa` object into the journal's `configFingerprint`, so
the config edit above produces a binding the journal refused to open, and the
journal directory also holds the archive catalog. P2-104b makes the journal
adopt a changed configuration when the worker identity (endpoint, space,
account, credential slot) is unchanged and nothing is in flight, and rewrites
the stored binding. A changed identity is still refused.

### Re-processing without re-archiving the parser output (P2-104d)

A rebuilt runtime can move the extraction configuration fingerprint and leave
the parser fingerprint alone. That is the common case and it needed one more
change to work.

Where the mapping is applied decides this. The Python conversion emits two
files from one `convert` call: `lossless.json`, docling's own document export,
and `bundle.json`, the mapped pages. `evals/parser/src/parser_eval/convert_worker.py:459-462`
computes them side by side, and `_docling_normalized` is the mapping. Only
`lossless.json` is archived and only it is the parser artifact
(`packages/pipeline/src/runner.ts:3469-3478` archives
`parserOutput.rawArtifact`; `packages/pipeline/src/archivedRequestMapping.ts:134-138`
declares it). The parser fingerprint covers exactly the inputs that decide
those bytes; the extraction configuration fingerprint covers the mapper
(`evals/parser/src/parser_eval/production.py:662-676` and `714-728`).

So an extraction-configuration change re-parses to a byte-identical archived
artifact. The worker still has to re-run the parser, because the new
`bundle.json` only comes from the parser, but it must not archive the raw
artifact again and must not create a second one: one parser artifact per
(source revision, parser fingerprint) is the right identity, and
`createOrGetParserArtifact` is right to refuse a second
(`packages/kith-store/src/provenance/artifacts.ts:138-168`).

`discovery.lookupArchivedAdmission` now answers a processing lookup that sets
`lookup.reuseParserArtifact: true` with `existingParserArtifact` on a
not-found answer, naming the artifact and the two archive receipts currently
bound to its parser output. The worker records that on its checkpoint, skips
the parser-output copies in `parser_archive`, and admits with
`parserArtifact: { kind: "existing" }` and two `kind: "existing"` receipt
selections. Both shapes were already in the protocol and already handled
server side; what was missing was the lookup that hands the ids over.

The field is opt-in because a not-found answer is validated against an exact
key set on the client (`packages/pipeline/src/transport.ts`), so a server that
volunteered it would break every worker built before this change. A worker
that does not ask gets the answer it always got. The protocol version stays 1.

A changed parser fingerprint is unaffected: no artifact exists under the new
fingerprint, nothing is offered, and the worker archives and creates as before.

Two more walls sat behind that one, both found by driving the whole lane
rather than by reading it.

The original's archive receipts are immutable and bound to the admission that
created them, so a second processing generation cannot declare them again: a
fresh admission carries a fresh request digest and `createOrGetArchiveReceipt`
refuses it. `discovery.lookupArchivedAdmission` in `original` mode already
returns those receipt ids and their binding epochs, so the worker now records
them and selects them, exactly as it does for the parser output.

`preflightArchivedDiscovery` refused any work row holding a lease, while
`reserveArchivedDiscovery` has always treated an **expired** lease as
claimable, which is how a pass that died holding one is recovered. Preflight
is the gate reserve sits behind, so the one row the owner's deployment left
`leased` with an expired lease answered `stale_observation` at preflight on
every pass and failed the whole pass with it, and the reserve that would have
reclaimed it was never reached. Both now use one predicate. This grants
nothing: preflight hands out no lease and writes nothing, and it now
authorizes exactly the work reserve would claim in the next call.

### The rehearsal

`packages/kith-store/test/archivedRehearsal.test.mjs` drives the real
`PipelineRunner`, its real `Journal` and `ArchiveCatalog`, the real archive
commands and the real worker handlers against a real PostgreSQL. It publishes
several documents under one runtime, switches the runtime both ways, and
asserts every document is active under the new one, the old generations are
retired rather than deleted, no work row is stuck, attempts stay small, the
assessment completes and a further pass is a no-op. It includes the live
oddities: a work row left leased with an expired lease at one attempt, and
never-activated processing debris in the local catalog.

Two things are stood in for, and only two, because the real ones need
external binaries: the sandboxed Python parser, whose artifact pair is written
into the directory the catalog reserved so the real step validates and records
it, and `age`/`restic`, which are fake executables the real archive commands
drive. The lane is macOS-only (`requiredPlatform`), so this cannot run in CI,
and it spawns enough child processes that a fully loaded `pnpm test:once`
occasionally fails one. It is opt-in:

```
KITH_REHEARSAL=1 KITH_STORE_DATABASE_URL=postgres://... \
  node --test packages/kith-store/test/archivedRehearsal.test.mjs
```

### Operator steps after this lands

| Pass | Command                      | Expected                                                                                                                                  |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `pnpm brain:worker -- doctor --config <path>`           | `config_rebind_pending` or nothing pending. Not `config_rebind_blocked`.                                                                  |
| 1    | `pnpm brain:worker -- run --config <path>`              | `state: "complete"`, `published` equal to the number of re-queued documents. Each one re-parses, reuses its artifact, and activates.       |
| 2    | `pnpm brain:worker -- run --config <path>`              | `state: "complete"`, `published: 0`. Nothing left to do.                                                                                   |

Run the watcher again only after pass 2 reads `published: 0`.

Check after pass 1, in the development database first if the deployment
offers one:

```
SELECT state, count(*) FROM kith.processing_generations
 WHERE source_account_id = $1 GROUP BY state;
SELECT state, attempts, count(*) FROM kith.worker_discovery_work
 WHERE source_account_id = $1 GROUP BY state, attempts;
```

One `active` generation per document, the old ones retired rather than
deleted, and no work row left `queued` or `leased`.

If a document parks, the pass says so: `parked`, `parkedCodes` and
`parkedOldestAgeMs` are on the result. Read the code before acting.

| Code                                        | What it means                                                  | What to do                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `original_receipt_revision_conflict`        | Two admissions name different revisions for one file.          | A person decides which bytes are the document. Do not clear it automatically.          |
| `original_receipt_unknown_to_server`        | The receipt names a deployment that no longer serves this.     | `pnpm brain:worker -- run --retry-parked --operator-clear --max-clears 1` once, then a normal pass.                              |
| `provider_original_reference_already_bound` | The provider reference is already recorded server side.        | Nothing; the next pass walks past it. Escalate only if it repeats past its retry budget. |

`pnpm brain:worker -- run --retry-parked` drops every marker and tries all of them once
more. Reach for it only after the underlying cause is understood: the marker
carries the attempt count that bounds the automatic retries.

## Receipt images

`scripts/receipt-images-to-pdf.mjs` turns each image in a folder into a one
page PDF beside it:

```sh
node scripts/receipt-images-to-pdf.mjs --in /path/to/receipts/inbox
```

jpg, jpeg, png, heic, heif, tif and tiff are converted with `sips`, which ships
with macOS, applies EXIF orientation, and produces byte-identical output for
the same input. `receipt.jpg` becomes `receipt.jpg.pdf`, so two images with the
same stem stay two documents. The original image is never modified or removed.
Re-running is safe and skips what is already normalized, so this suits a folder
action or a scheduled run over a Dropbox inbox.

From there the existing `pdf_docqa_v1` lane does the rest. Docling already runs
with `do_ocr: True` and RapidOCR
(`evals/parser/src/parser_eval/convert_worker.py:415-416`), so an image-only
page comes back as OCR text.

### Evidence on an OCR-only page

Measured against the synthetic scanned fixtures with the pinned runtime:

| Fixture                                                   | Pages | Segments | Locator kind   | Mapping gaps |
| --------------------------------------------------------- | ----- | -------- | -------------- | ------------ |
| `fixtures/image-clear.pdf`                                | 1     | 1        | `docling_item` | none         |
| `fixtures/vehicle-receipt.pdf`                            | 1     | 1        | `docling_item` | none         |
| `assets/image-clear-raster.png` normalized through `sips` | 1     | 1        | `docling_item` | none         |

An OCR page produces one citable `docling_item` per recognized text block, with
an ordinary `page_no` and `bbox` in the raw artifact, exactly like a native
text item. Citations are therefore block-granular rather than line-granular on
these pages, and the retained page text is the OCR transcription. There is no
separate evidence model for OCR: nothing in the bundle distinguishes a
recognized character from a native one, so an OCR reading error is retained as
if it were the document's own text. The source image stays the backup.

### What is not covered

- One page per image. A multi page paper invoice becomes several documents,
  each ingested and each citable. Merging them needs a PDF writer; add it only
  if reading them separately turns out to be annoying.
- Mirrored EXIF orientations (2, 4, 5, 7) are left as `sips` renders them.
  They do not occur in phone camera output.

## Page and size limits

`MAX_PAGES` is 64 and `MAX_INPUT_BYTES` is 16 MiB. Both are arbitrary in
origin: 16 MiB is recorded as "unchanged from the original-byte contract's
first binary class" (`packages/worker-protocol/src/index.ts:417`). They are not
independently adjustable, because a document large enough to need them also
exceeds the rest of the budget family:

| Constant                      | Value  | Where                                                                                              |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `MAX_PAGES`                   | 64     | `production.py:41`, `convert_worker.py:19`, `parsedStaging.ts:128`, `request.ts:1606`              |
| `MAX_INPUT_BYTES`             | 16 MiB | `convert_worker.py:18`, `production_launcher.py:21`, `BINARY_CLASSES`, `MAX_ARCHIVED_BINARY_BYTES` |
| `MAX_RETAINED_UTF8_BYTES`     | 1 MiB  | `production.py:42`, `parsedStaging.ts:123`                                                         |
| `MAX_SERIALIZED_BUNDLE_BYTES` | 4 MiB  | `production.py:43`                                                                                 |
| `MAX_EVIDENCE_SPANS`          | 256    | `parsedStaging.ts:129`                                                                             |
| `MAX_PARSED_CHUNKS`           | 256    | `parsedStaging.ts:132`                                                                             |

Raising only the page count moves the failure from `page_limit_exceeded` to
`retained_text_too_large` or `bundle_too_large`. Raising the set coherently is
its own change, on both the worker and the server, and it is not attempted
here. Until then a fund report or a long medical record past either bound is
recorded as an `oversized` gap: inventoried and visible, not silently dropped.
