# Document triage and prioritized ingestion

Date: 2026-09-21
Status: metadata-first routing from PR #392 is merged and adopted, and live
preview processing is verified. Deferred-checkpoint and later-watch acceptance
remain rollout work. Targeted tax ingestion is the next bounded implementation
slice.

## Problem and outcome

The filesystem worker currently processes eligible PDFs serially through full
conversion before downstream extraction can use their text. Queue position and
publication counts do not establish useful coverage. Low-priority material can
delay the documents needed to validate a product feature, and a completed pass
can still leave encrypted, oversized or unsupported documents unresolved.

Adopt two passes. The first establishes what a document appears to be and
records useful discovery metadata quickly. The second performs deeper work
selectively, with an explicit reason and priority. Documents required for an
active user goal or code acceptance may move ahead of the background backlog.
Do not discard originals or erase already indexed content during this change.

## Processing policy

| Pass                          | Work                                                                                                                                                                                                                                                          | Honest result                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Discovery and triage          | Reuse source identity, location, hash and observed metadata. Inspect a bounded opening-page preview, using existing text where available. Record provisional type, title/date when supported, preview coverage, method/version and confidence or uncertainty. | Discoverable metadata and explicit processing depth. No claim that uninspected pages were searched or understood.         |
| Targeted ingestion            | Extract pages and fields relevant to the selected goal, preserving original page numbers and evidence.                                                                                                                                                        | Queryable fields with stated coverage. Preview absence is never evidence that a field or document section does not exist. |
| Full ingestion when warranted | Convert and index the document when whole-document retrieval, a supported extractor or a user request needs it.                                                                                                                                               | Full declared processing coverage, subject to explicit failures.                                                          |

A bounded opening-two-page preview is a classification aid, not a financial
completeness proof. The second page allows a return or Schedule K-1 behind a
cover letter to route immediately. A bundle may contain several document
types. Unknown or image-only previews remain unknown until a bounded
escalation supplies evidence. They must not silently disappear from discovery.
Do not copy guessed dates or monetary values into authoritative facts.

The first pass may enqueue deeper work when a document is relevant to an active
goal, a configured document policy, an explicit user request or a code acceptance
case. Metadata-only is a valid deferred state, distinct from failed, excluded,
fully indexed and complete. An assistant must surface that limitation when an
answer requires unprocessed content rather than treating it as absent.

Preview persistence happens before original-byte archival. A preview is bound
to the current source item, observed content hash and preview-method
fingerprint. It remains provisional until the same bytes receive a retained
source revision, and it cannot create facts, evidence or citations. The worker
rejects a preview recorded against a stale observation. Later retention may
link the immutable preview to the matching source revision exactly once.

The first supported worker entry point is an explicit selected-item command.
It accepts a private manifest containing exact root alias, relative path,
content hash and bounded original-page windows. It runs only for revision-bound
binary items after the active archived item, under the normal exclusive journal
lock and with no pending request. Each server write uses the complete archived
work identity and a deterministic request ID, so retry after a lost response is
idempotent. The command leaves the checkpoint byte-for-byte unchanged and does
not persist native text or workbook names.

Automatic two-pass routing uses the same preview store and archived discovery
work. A locked adoption command binds a private deep-selection manifest to
exact remaining source, observation, processing and content identities. The
manifest may select no items when automatic policy should route the remaining
inventory. The active item finishes unchanged. Selected priority items each receive their
bounded preview and then enter the existing deep pipeline immediately, in
queue order. Once selected work is exhausted, the worker previews the
unselected suffix without capturing, archiving or parsing it deeply.

Before reporting the deferred result, the worker drains ordinary UTF-8
discovery, pending processing jobs and assessment for the same sealed scan.
One deferred binary therefore cannot starve other publishable work. A preview
refusal caused by one document is retained as a typed gap for that exact
revision and the worker advances; executable, sandbox and resource failures
still fail the run.

The worker retains that suffix in an archived `metadata_only_deferred`
checkpoint instead of claiming a complete pass or discarding the queue. A
later locked selection may promote an unchanged identity already recorded in
the checkpoint's previewed set. Promotion reuses its preview and enters deep
work without a rescan, file reorder or repeated preview. After reporting that
deferred result once, the next watch pass opens a normal scan while carrying
only exact selected and previewed revision identities. Reconcile keeps carry
entries whose source item, observation epoch, processing epoch and content hash
still match the sealed inventory. New and changed binaries receive previews;
unchanged binaries reuse their recorded preview status. This keeps new files
discoverable without turning deferred work into success or losing later
promotion. Existing active checkpoints keep their prior behavior until the
supported adoption command records the routing policy. Fresh scan cycles carry
an explicit metadata-first marker. Its absence on an older serialized scan
preserves the legacy deep intent path.

The first automatic policy is deliberately narrow. A strong Form 1040, income
tax return or Schedule K-1 heading adds that exact revision to the selected
FIFO immediately after its own preview. Folder names and incidental form
mentions do not select deep work. A Morgan Stanley bulk trade history needs a
positive history or all-trades heading and remains metadata-only with generic
provisional metadata. Individual trade confirmations also remain metadata-only
and keep an accurate generic title. Account and portfolio statements, holdings
or positions reports, annual Form 1099 material and tax-reporting summaries are
never classified as low-value trade histories from those words alone. An
explicit exact-identity selection can promote any still-current deferred item.
The automatic policy records its version digest and selected identity digest in
the journal; native preview text and private paths are not persisted.

Preview execution reuses the existing parser sandbox boundary but grants no
model-asset access and does not run Docling or OCR. A separate locked adoption
command may change only the configured launcher digest, verifies the installed
launcher bytes and requires an archived checkpoint with no pending request.
This makes the preview-capable launcher an intentional dependency transition
rather than an incidental consequence of changing a checkout.

## Goal-aware stopping for tax bundles

The owner explicitly prefers stopping when the needed information has been
established over converting every page or truncating at an arbitrary page count.
Separate bounded discovery previews from substantive extraction: two preview
pages can classify a candidate but cannot certify a complete tax result.

### Current boundary

PR #392 classifies a strong tax heading as `deep_priority`, but that selection
still enters the ordinary archived-document path. The worker converts the whole
PDF before typed extraction runs. The PDF converter, parsed-text declaration
and staging path accept at most 64 pages. A longer PDF therefore fails before
the existing tax selector can inspect its front forms.

For an admitted document, `selectTaxFrontForms` finds Form 1040 within the first
12 parsed pages, takes one contiguous front section, stops at a supporting
attachment and applies a 48-page and 300,000-character bound. The typed model
gets one initial request and at most one wider request. The kind-level ceiling
is 60 pages. Those bounds are useful safety limits, but none proves that a
requested return result is complete. An attachment boundary currently counts as
intentional rather than truncated, even when a referenced schedule or requested
total has not been resolved. Only `tax_year` is required in the shipped 1040
catalog, and omission of a required field from a model reply is not a coverage
proof.

The first goal-aware slice must run before whole-document conversion. It does
not raise the global page cap. It converts only selected original pages, records
exact partial coverage, and leaves full ingestion available for retrieval goals
that actually need the entire bundle.

### Closed goals and requested fields

The first version supports exactly two goals. The goal and its version are part
of the durable request digest. A later field-set change is a new goal version,
not a silent reinterpretation of a completed result.

| Goal | Form instances | Requested field set |
| --- | --- | --- |
| `form_1040_totals_v1` | One Form 1040 filing version and each applicable front Schedule 1, 2, 3, A, D or E | Form identity and every semantic total in `FEDERAL_INDIVIDUAL_RETURN`. Identity is `tax_year`, `return_version`, `filing_status` and `jurisdiction`. The total set is the checked-in Form 1040 and schedule total catalog. Names, preparer, signature and filing channel remain optional descriptive fields and do not keep page discovery alive. |
| `schedule_k1_key_fields_v1` | One Schedule K-1 form instance, identified by form family, tax year, entity and recipient | Parts I and II identity; amended, final, PTP, partner type, domestic/foreign and K-3 flags; beginning and ending profit, loss and capital percentages; nonrecourse, qualified nonrecourse and recourse liabilities; all six Part L capital movements; Part III boxes 1, 2, 3, 4a-c, 5, 6a-b, 7, 8, 9a-c and 10; and coded values in boxes 11-15 and 17-20. |

The K-1 seed currently has only partnership, tax year, recipient and eight
optional financial fields. The K-1 implementation extends that one kind with
the field set above. It does not create one document kind per filing year.
Printed labels and box codes remain evidence; semantic keys remain stable.

A requested field has one of four outcomes: `cited`, `source_blank`,
`not_applicable` or `unresolved`. A printed zero is `cited`, never blank.
`source_blank` requires an inspected, readable form region and the supported
form/year layout; model omission alone cannot establish it. `not_applicable`
requires a printed form choice or a closed form rule. Fields on an applicable
form are all classified, but an optional schedule does not become applicable
merely because its name appears in generic 1040 instructions.

### Page discovery and semantic completion

Start from the exact observed item, epochs and content hash selected by PR #392.
Use native-text header and navigation windows to locate candidate form headings,
form year, page or attachment sequence, and instance boundaries. Header
discovery remains non-authoritative. Exact values and completion require the
same bytes to become a retained source revision, selectively converted pages and
retained evidence. Admission may bind that revision and its first targeted
parser artifact atomically; preview metadata alone never becomes evidence.

The controller converts the smallest exact page set that can close the goal,
then repeats only for a concrete unresolved reason:

1. a requested form page or terminal page is missing;
2. an inspected form references an applicable requested schedule;
3. a requested coded K-1 box references a continuation statement;
4. two candidate filing versions or form instances conflict; or
5. a required region is image-only or unreadable and needs targeted OCR.

Form 1040 is complete when its form boundary and the boundaries of every
applicable requested front schedule are closed, and every requested field on
those forms has one of the three resolved outcomes. A K-1 is complete when
Parts I, II and III are closed for one identified instance, every requested
field is resolved, and continuation statements referenced by requested coded
boxes are closed. A contents-page mention, cover letter, first-page heading or
model assertion cannot close a form.

Supporting brokerage statements, worksheets, duplicate attachments and K-1
continuations unrelated to the requested boxes remain deferred. CPU, memory,
page and token limits are operational budgets. Reaching one before semantic
completion records `incomplete_resumable` with closed unresolved codes. It does
not record complete. A later attempt resumes from retained page coverage and
does not reconvert already verified pages under the same source and parser
fingerprints.

### Retained partial-text and result contract

Sparse pages cannot use the current full-document contract unchanged. Parsed
PDF pages are currently numbered densely from 1 through the parsed page count,
and typed extraction renumbers the pages shown to the model. Publishing selected
pages 137 and 138 as pages 1 and 2 would create false citations. Activating them
as ordinary parsed text would also make uninspected pages look searchable.

Reuse the existing source revision, provider reference, parser artifact,
parsed-staging, text-version, page, evidence, event, observation and deferred
work tables. Add only the following persisted fields and table:

| Change | Contract |
| --- | --- |
| `source_text_versions.coverage_kind` | Closed to `full_document` and `targeted_tax_v1`. Existing rows backfill to `full_document`. |
| `source_text_versions.source_unit_count` and `inspected_original_units` | The PDF page count and, for a targeted version, a strictly increasing bounded list of exact original pages. A full version has `source_unit_count = page_count` and does not need to enumerate every unit. |
| `source_pages.original_unit_number` | One-based original PDF page number. Dense staging ordinal remains internal ordering. Evidence and user-facing citations use this number. |
| `kith.targeted_extraction_results` | One revision-bound result per goal version, opaque instance key and request digest. Status is closed to `running`, `complete`, `incomplete_resumable` or `conflict`; the only in-place lifecycle is `running` to one terminal state. The row stores source item/revision/text version/generation, requested fields, discovered forms, inspected original units, unresolved codes, event and observation keys, parser/extractor fingerprints and timestamps. Payloads are closed and bounded. |
| `deferred_work.kind` | Add only `targeted_tax_extraction`. Its payload names space, source item, source revision, processing generation and goal digest. The existing lease, retry and dedupe behavior remains unchanged. |

The separate result table is necessary because `document_extractions` is unique
on `source_item_id`. One assembled source can yield a Form 1040 result and
several K-1 form-instance results. Reusing that row would either overwrite one
goal with another or collapse distinct counterparties into one extraction.

The targeted generation is sealed and auditable but does not produce a
whole-document retrieval or embedding claim and is never written to
`source_items.active_generation_id`. If no full generation exists, document
reads may expose its cited tax result and explicit partial coverage, but search
and full-document retrieval report that the remainder is unprocessed. A later
full generation can become active without deleting the targeted result or its
evidence. Revision change makes the old result historical and queues a new
goal; matching request replay is idempotent.

Do not put private paths, native preview text or taxpayer values in goal payloads
or error messages. Forget cascades the targeted result, its dedicated partial
text/evidence and observations through the same source item/revision lifecycle.
An incomplete result retains its evidence and coverage so it can resume, but it
is not queryable as a complete tax answer.

### Minimum API changes

Extend the selected-item manifest with the closed tax goal and optional opaque
K-1 instance discriminator. Extend `ParsedTextDeclaration` and parsed page
input with the closed coverage descriptor and original unit number. The existing
archived admission and parsed staging operations continue to carry the parser
artifact, pages and evidence. Their terminal operation gains a closed targeted
completion arm that seals the generation without setting the source item's
active generation. No second ingestion service or queue is added.

Targeted completion queues the existing deferred worker with
`targeted_tax_extraction`. The handler writes the result row, event,
observations and cited statements in one transaction after rechecking current
source revision, goal digest, parser fingerprint and evidence. `get_document`
adds the goal status, resolved/unresolved coverage, inspected original pages and
cited statements. This read-contract change bumps the advertised standalone and
hosted MCP server versions under the repository version policy. No new MCP tool
or UI is part of this slice.

### Implementation slices and ownership

| Slice | Owner | Deliverable |
| --- | --- | --- |
| 1. Selective PDF artifact | Pipeline/parser | Accept an exact bounded set of original PDF pages, bind it into the parser fingerprint, preserve the original-page map in normalized output, and checkpoint only revision-bound tax goals. |
| 2. Partial coverage admission | Worker protocol and Kith store | Apply the migration above, extend existing archived admission and parsed staging, reject stale/cross-source/mismatched coverage, and keep targeted text out of whole-document search claims. Apply the migration development-first. |
| 3. Goal controller and extraction | Pipeline and Kith extraction | Discover form boundaries, request additional pages only for closed continuation reasons, extend the K-1 catalog, gate field outcomes, and atomically store the result with existing evidence and observations. |
| 4. Read and recovery proof | Document read and focused integration tests | Expose partial coverage through `get_document`; prove restart, same-request replay, revision invalidation, forget and later full-generation coexistence. |

These are implementation PRs with one final acceptance, not research phases.
Schema and worker-protocol work require the repository's independent tier-2
review. Pipeline and schema owners coordinate migration numbering and shared
files before implementation.

### Final acceptance

Use synthetic PDFs with invented values:

1. A 1040 with the same front forms and either 20 or 500 irrelevant appendix
   pages yields identical fields, evidence and original page numbers. Selective
   conversion and model page counts are identical.
2. Covers and contents may precede Form 1040. A referenced requested schedule
   later in the bundle is found; an unreferenced attachment remains deferred.
3. A missing requested total, unresolved continuation, unreadable required
   page, competing return version or exhausted budget yields
   `incomplete_resumable`, never complete.
4. Original pages 137 and 138 remain 137 and 138 in stored evidence after
   conversion, restart and replay. General retrieval reports partial coverage.
5. A late K-1 closes Parts I-III and one requested continuation while unrelated
   appendices add no conversion or model work.
6. Blank, absent and printed zero remain distinct. Optional descriptive fields
   and non-applicable schedules do not prolong extraction.
7. A changed source hash or observation epoch cannot reuse the prior result.
   Exact replay creates no duplicate pages, evidence, observations or facts.
8. Forget removes targeted results and evidence without disturbing another
   source. A later full generation coexists and becomes the whole-document read.

## Priority and recovery

Keep one durable queue with priority, reason and revision-bound identity for
deep work, or adapt the existing scheduler if it can express these semantics.
Do not add a second independent worker that can race the same source item.
The triage pass and deep-work queue are logically separate; reuse existing
source and job tables where their contracts fit.

Urgent goal/code-acceptance items run before ordinary backlog. Maintain FIFO
within a priority and an aging policy for background work. Complete or safely
checkpoint the current operation before switching items. Changes in priority
must not change a document's content or extraction identity, lose pending
requests, duplicate publication or abandon deferred documents.

For the active import, do not edit a live journal, reset the catalog or mutate
its file array outside a supported journal transition. First establish process
liveness and terminal result, then settle pending responses through normal
replay. Implement a bounded priority control if the current worker has none.
Preserve the original request, completed publications and failure evidence.

## Boundaries and delivery order

1. Audit existing inventory with private, bounded previews. Publish only
   synthetic examples and aggregate results. Record diagnostic labels as
   provisional until the supported persistence contract is implemented.
2. Add and verify safe priority control for documents needed by active goals.
   The immediate acceptance is a prioritized document completing ahead of the
   ordinary backlog without losing or reprocessing completed work.
3. Persist preview metadata and processing depth through the existing source
   lifecycle or a small additive contract. Keep preview generation separate
   from a full extraction generation; do not counterfeit active full coverage.
4. Route selected items to targeted or full ingestion. Verify the user-visible
   result with cited fields or retrieval, not merely a finished queue.

Finance adapters continue to own canonical account balances, positions and
reconciliation. Filesystem triage must not create a competing financial ledger.
This plan refines the ingestion scheduling and coverage policy in the canonical
architecture; it does not relax evidence, authorization or archive invariants.

## Verification

Use focused synthetic tests for priority changes with an answered pending
request, restart before/after publication, stable same-priority ordering,
background retention and unchanged source/extraction identity. Verify that
metadata-only documents cannot masquerade as fully searched or extracted.
Cover image-only previews, cover sheets, mixed bundles, encrypted documents,
source revision changes, and idempotent promotion from triage to deeper work.

Apply the verification policy in AGENTS.md. Report goal coverage, unresolved
classes, processing depth and actual worker liveness. A saved checkpoint alone
is not evidence that a worker is running.
