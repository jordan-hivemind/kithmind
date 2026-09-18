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
| 4    | Restart the watcher.                                                                                                                                                                                                        |

The next pass recomputes the parser fingerprint, matches the pasted one, and
proceeds. Nothing else has to be done: the server already treats a changed
parser fingerprint as a new processing identity (see below), so the existing
documents are re-parsed on their own and no row is orphaned.

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

No manual SQL, no migration and no quiescing is required for a parser change.

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
