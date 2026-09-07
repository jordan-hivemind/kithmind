# Synthetic parser evaluation

Date: 2026-09-07. Task: P2-3. Status: feasibility evaluation complete.

Docling passed all 19 labeled value, page, table-row and UTF-16 evidence checks
across six synthetic PDFs. It clears the fixture gate for the next synthetic
PDF adapter. This is not approval to ingest owner records or a real-world
accuracy estimate. The native-text baseline passed all 17 checks on the four
native PDFs and failed the two image-only checks because it extracted no text.

Retain Docling as the reference converter for the next adapter and retain
pdfplumber as a native-PDF fast-path candidate for the later quality pilot.
These results do not justify automatic routing based only on whether a PDF
contains some text; mixed scanned/native pages and harder layouts remain
untested. Keep Paperless optional.

The [preregistered plan](plans/2026-09-07-parser-evaluation.md) and corpus were
committed at `667f80e` before scoring. The independently reviewed evaluator was
frozen at `fb8d59f`. The first scored run is preserved in the
[machine-readable report](../evals/parser/results/2026-09-07/report.json), with
[retained normalized and lossless outputs](../evals/parser/results/2026-09-07/retained/).
No labels or thresholds were changed after scoring.

## Results

A passing labeled check requires the exact quote, correct retained page and
UTF-16 span, a valid original parser locator, and the labeled table association
where applicable. Each converter ran in a fresh process. RSS is the sampled
sum across that process tree, in MiB; it is not a guaranteed instantaneous peak.

| Fixture               | Docling checks | Native checks | Docling seconds | Native seconds | Docling RSS MiB | Native RSS MiB |
| --------------------- | -------------- | ------------- | --------------- | -------------- | --------------- | -------------- |
| financial-statement   | 4/4            | 4/4           | 8.74            | 0.131          | 2038.9          | 30.2           |
| lab-report-unicode    | 8/8            | 8/8           | 5.82            | 0.136          | 1448.9          | 35.2           |
| vehicle-receipt       | 3/3            | 3/3           | 5.33            | 0.137          | 1446.9          | 34.8           |
| contract-continuation | 2/2            | 2/2           | 5.71            | 0.136          | 1459.1          | 34.8           |
| image-clear           | 1/1            | 0/1           | 5.84            | 0.135          | 1485.7          | 34.7           |
| image-partial         | 1/1            | 0/1           | 6.79            | 0.135          | 1886.5          | 34.9           |

Docling completed all six conversions in 38.23 seconds, with a maximum sampled
RSS of 2,038.9 MiB. The baseline completed them in 0.81 seconds, with 35.2 MiB
maximum sampled RSS. These are single-run measurements, including process
startup but excluding dependency/model setup, on an Apple M1 Pro with 10
logical CPUs, arm64 Darwin 25.6.0, CPython 3.12.12, and four configured Docling
CPU threads. They are not stable performance benchmarks.

All 12 conversions completed without timeout or resource failure. The report's
`state: complete` means conversion completed; individual `score.passed` fields
retain the baseline's two failures. Neither baseline scan produced a quote,
so `amount` and `reference` failed with `exact_mapped_quote_missing`. No parser
mapping gaps were emitted on this corpus.

The financial fixture preserved both equal fee rows on page 1 and the EUR
refund on page 2. The lab fixture preserved both people and dates, units,
accented text, the non-BMP marker, and the later assertion whose UTF-16 offset
differs from its Python character offset.

The missing-value scan is not an OCR recovery test for degraded numeric pixels.
Docling retained `TOTAL: [value intentionally unavailable]`; the baseline
retained an empty page. All forbidden-string checks passed, but those checks
exclude only the listed strings. Neither parser implements automatic unknown
field or complete-record detection here. Expected-gap annotations are labels,
not a successful gap-detection result. That work remains P2-10.

## Reproduction and pins

Follow the [exact setup and evaluation commands](../evals/parser/README.md).
Scored conversion currently requires macOS with working `sandbox-exec`.
Lightweight evaluator tests and fixture regeneration run in Linux CI without
Docling or model downloads. Linux conversion isolation is not implemented.

The evaluated runtime uses Docling 2.126.0, docling-core 2.95.0,
docling-ibm-models 4.0.2, docling-parse 7.17.0, RapidOCR 3.9.2,
ONNX Runtime 1.23.2, pdfplumber 0.11.7, and psutil 7.0.0. The
[dependency lock](../evals/parser/uv.lock) pins the remaining packages.
The report fingerprints the lock, evaluator source files, configuration, and
model manifest. Fixtures and every retained output have SHA-256 hashes.

A fresh normal setup reproduced all 18 pinned model/metadata files totaling
561,752,239 bytes. The [model manifest](../evals/parser/model-assets.lock.json)
records exact source revisions, download URLs, hashes, and license sources:
Heron declares Apache-2.0; the Docling model bundle declares
CDLA-Permissive-2.0; the RapidOCR-selected PaddleOCR assets declare Apache-2.0.
Those are separate from Docling's MIT code license. The vendored fixture fonts
retain their [OFL licenses and source hashes](../evals/parser/assets/FONT-SOURCE.md).

Online setup is separate from conversion. Each converter's network access was
OS-denied, verified with a negative socket probe. Input is local PDF bytes,
limited to 16 MiB and 64 pages, with remote services/plugins disabled. The
runner imposes 210 seconds wall time, CPU/file/descriptor limits, a sampled
4 GiB process-tree RSS cutoff, and a 64 MiB limit per output file. Sampling can
miss brief peaks, and macOS has no enforced address-space limit here. This
synthetic harness is not a hostile-document sandbox or the production worker.

## Next gate

P2-9 must retain original-byte identity, encrypted archive receipts, parser
artifacts and immutable extracted-text versions. P2-5 must prove independent
restoration against that schema. P2-10 supplies field extraction and review;
P2-4 supplies monitoring and recovery. The
[Phase 2 plan](plans/2026-09-07-phase2-document-pipeline.md) keeps the labeled
owner pilot and controlled backfill after those gates. Medical interpretation,
financial classification, family identity matching, real scans, larger
statements and automatic completeness remain unverified.

## Evidence boundary

The evaluation compares local Docling conversion with a native PDF text
baseline. A successful conversion is different from accurate values or usable
evidence. Results must report failed cases and ambiguous mappings.

Docling's item-local character spans cannot be used directly as Kith Mind's
page-relative UTF-16 spans. The adapter must retain item identities, assemble
page text deterministically, translate offset boundaries and verify each quote.
Table row and cell structure must come from the lossless document model.
Bounding boxes and flattened Markdown do not prove exact quote spans. See the
[Docling document reference](https://docling-project.github.io/docling/reference/docling_document/)
and [serialization guidance](https://docling-project.github.io/docling/concepts/serialization/).

## Optional Paperless archive

Keep Paperless optional. Static review of release 3.1.3 found it can supply a
separately operated archive and document UI. No Paperless installation or
account was used in this evaluation. A future connector should pin its API version and retrieve the
specific original file version, checking metadata and hashing the downloaded
bytes. A document ID identifies an instance-local logical document; it is not
immutable byte identity. The
[Paperless API](https://github.com/paperless-ngx/paperless-ngx/blob/v3.1.3/docs/api.md#document-versions) exposes versioned file,
metadata and download operations.

Use a dedicated account with only the document permissions required for that
connector. Permission loss and incomplete enumeration must remain source gaps.
Paperless permissions do not replace Kith Mind's family-space authorization.
See [Paperless permissions](https://github.com/paperless-ngx/paperless-ngx/blob/v3.1.3/docs/usage.md#permissions).

Paperless's exporter can assist restoration of its own installation. It does
not establish a consistent Kith Mind snapshot, complete export encryption, or
restoration of Kith identities, evidence, active revisions and tombstones.
Its backup guidance also requires compatible versions and distinguishes
incremental comparison options. An independent encrypted backup and a tested
restore remain required. See the
[Paperless exporter documentation](https://github.com/paperless-ngx/paperless-ngx/blob/v3.1.3/docs/administration.md#document-exporter).

That makes Paperless a useful optional archive adapter, not a prerequisite for
the initial local folder pipeline. Its extracted text and generated archive
PDF remain derivatives; neither silently replaces the original bytes or the
page evidence contract.
