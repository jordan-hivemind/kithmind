# Parser feasibility evaluation

Date: 2026-09-07. Task: P2-3. Status: evaluation design, before scored runs.

## Decision

Determine whether a pinned local Docling configuration is suitable for the next
synthetic ingestion adapter. Compare it with native PDF text extraction where
useful. Do not adopt it for owner records based on format support or this small
corpus alone. Original-byte archives, structured publication, operational
recovery, and the owner pilot retain their separate Phase 2 gates.

## Fixed corpus

Generate six wholly synthetic PDFs from structured fixture data: a multi-page
financial statement, a lab report, a vehicle receipt, a contract, a clear
image-only scan, and an image-only scan with an unavailable value. Include repeated
amounts, a refund, separate currencies, totals distinct from line items,
multiple people and dates, multi-page evidence, Unicode, and an unknown value.

Freeze expected strings, pages, table associations, and unknown fields before
running the parser. Record document hashes. Inspect every rendered page to
verify that the authored content and labels agree. If a fixture is objectively
wrong, record the correction, change its hash/version, and rerun it; do not
adjust labels to match parser mistakes.

## Measurements and thresholds

| Measurement                   | Rule fixed before the first scored run                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Critical values               | Every labeled amount, currency, date, person marker, lab value, and service value in a supported fixture class must be preserved exactly. Report each mismatch.                                                    |
| Page and evidence correctness | Every accepted span must resolve to the stated retained page and exact quote using page-relative UTF-16 offsets. Required rate: 100%. A bounding box alone is not an exact text span.                              |
| Repeated records and tables   | Preserve separately labeled repeated rows and their row/cell associations. A bag of matching words is insufficient. Required rate: 100% of labeled associations for the supported class.                           |
| Unknown values                | Never replace an intentionally unavailable value with a fabricated known value. Keep a reported gap; the fixture cannot establish complete record coverage.                                                        |
| Text-only baseline            | Record its observed successes and failures, including no native text in image-only PDFs. Baseline failure on a scan is expected, not a reason to remove the scan.                                                  |
| Resources                     | Measure elapsed time, peak process memory where available, CPU/accelerator, operating system, package versions, configuration and model assets. A timeout or resource failure is a result, not an omitted fixture. |
| Reproducibility               | Pin Python/dependencies and model assets, record fixture and output hashes, and supply an exact public command. Separate online setup from offline conversion.                                                     |

Acceptance is per configuration and fixture class. A failure on scans may
justify a narrower text-PDF experiment; it does not justify a general parser
adoption claim. All failures remain in the result report. The six fixtures
cannot measure real-world accuracy, OCR of degraded numeric pixels,
medical interpretation, financial classification, or family identity matching.
Those require later labeled pilot and playbook evaluations. Expected unknown
fields are ground truth, not evidence that the converter detected a gap. Report
observed text separately; copying an expected-gap label into a result does not
pass an unknown-field detection test.

## Adapter boundary

Retain lossless conversion JSON, source hashes, parser/configuration identity,
page text, and original parser locators. Build and verify explicit mappings
from parser items into retained page text. Keep Python code-point indices,
Docling-local character spans, and UTF-16 offsets distinct. Ambiguous mappings
must be reported as gaps rather than assigned a convenient matching occurrence.

Conversion does not publish records or infer family membership. No owner
files, cloud conversion credentials, or production writes are involved. Model
assets may be downloaded during explicit setup; scored conversion uses the
pinned local assets. The evaluation is bounded and treats document text as data.

## Archive decision

Assess Paperless as an optional separately deployed archive. Check its current
original-document, export and permission contracts against the provenance and
restore requirements. Do not make it mandatory merely because it supplies OCR
or a document UI. P2-9 and P2-5 still have to establish byte identity,
independent archive restoration and Kith Mind reference integrity.

The final report records measured outcomes, supported scope, unresolved gaps,
versions and licenses, and the selected next experiment. It must not promote
this feasibility evaluation to an owner-ingestion approval.
