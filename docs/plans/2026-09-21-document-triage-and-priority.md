# Document triage and prioritized ingestion

Date: 2026-09-21
Status: owner-approved direction; implementation and rollout pending.

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

| Pass | Work | Honest result |
| --- | --- | --- |
| Discovery and triage | Reuse source identity, location, hash and observed metadata. Inspect a bounded opening-page preview, using existing text where available. Record provisional type, title/date when supported, preview coverage, method/version and confidence or uncertainty. | Discoverable metadata and explicit processing depth. No claim that uninspected pages were searched or understood. |
| Targeted ingestion | Extract pages and fields relevant to the selected goal, preserving original page numbers and evidence. | Queryable fields with stated coverage. Preview absence is never evidence that a field or document section does not exist. |
| Full ingestion when warranted | Convert and index the document when whole-document retrieval, a supported extractor or a user request needs it. | Full declared processing coverage, subject to explicit failures. |

A first-page preview is a classification aid, not a financial completeness
proof. A cover letter may precede a return, and a bundle may contain several
document types. Unknown or image-only previews remain unknown until a bounded
escalation supplies evidence. They must not silently disappear from discovery.
Do not copy guessed dates or monetary values into authoritative facts.

The first pass may enqueue deeper work when a document is relevant to an active
goal, a configured document policy, an explicit user request or a code acceptance
case. Metadata-only is a valid deferred state, distinct from failed, excluded,
fully indexed and complete. An assistant must surface that limitation when an
answer requires unprocessed content rather than treating it as absent.

## Goal-aware stopping for tax bundles

The owner explicitly prefers stopping when the needed information has been
established over converting every page or truncating at an arbitrary page count.
Separate bounded discovery previews from substantive extraction: two preview
pages can classify a candidate but cannot certify a complete tax result.

Define the requested field/form set before deeper extraction. Inspect opening
pages and available document navigation to locate the relevant return and
schedules. Continue only as needed to resolve missing fields, continuation
markers, conflicting candidate returns, or references to required schedules.
A cover letter mentioning a form is not proof that the form was inspected.

Stop after the selected result has grounded evidence for its required fields,
the relevant form boundaries are established, and detected conflicts or
continuations are resolved. Missing and blank fields remain distinct from zero;
optional fields do not require scanning unrelated appendices merely to invent
a value. Report unresolved required fields explicitly. Original page numbering
and exact retained evidence must survive selective parsing.

Supporting brokerage statements, worksheets and duplicate attachments can
remain deferred when they are unnecessary for that result. State exactly what
was extracted and which remainder was not inspected; completion of a requested
return summary is not a claim that the entire bundle is understood. A later
question can enqueue additional pages without repeating verified prior work.

CPU, memory, page and token limits remain operational safety budgets, not the
semantic stopping rule. Reaching a budget before the required evidence is
established yields incomplete/resumable coverage. Do not mark a result complete
because the first N pages were processed, and do not parse the whole PDF first
merely to select its opening forms afterward.

Acceptance uses synthetic long bundles with the same required front forms and
variable-length irrelevant appendices: adding appendix pages must not force
proportional parsing or model work. Also test front cover sheets, a required
schedule later in the bundle, a missing required field, competing return
versions and original-page citation preservation. A genuine unresolved need
must continue or report incomplete, not be hidden by the optimization.

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
