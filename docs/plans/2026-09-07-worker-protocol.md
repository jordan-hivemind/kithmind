# Worker protocol v1

**Date:** 2026-09-07

**Status:** Implementation in progress. This document describes the initial
worker gateway commands defined in the shared protocol. Discovery reservation,
text admission, deterministic text processing, and source processing assessment
are implemented. A complete filesystem worker and parsing remain in progress.

**Related plan:** [Phase 2 document pipeline](2026-09-07-phase2-document-pipeline.md)

## Purpose and boundary

`POST /api/worker` is a small authenticated transport for a remote worker. It
uses versioned JSON command envelopes. It is not JSON-RPC, does not select an
arbitrary Convex function, and does not accept a user ID or credential ID as
authority. The gateway authenticates the bearer credential, creates the scoped
principal, and the backend rechecks current source-specific access.

Every command includes:

```json
{
  "protocolVersion": 1,
  "operation": "...",
  "spaceId": "...",
  "sourceAccountId": "..."
}
```

`sourceAccountId` is the Convex `sourceAccounts` row ID, not the connector's
account identity string. Settings shows both IDs under **Worker identifiers**
for a filesystem source. A worker must be configured with an explicit space and
source-account row. It must not rely on a person's default destination.

The source account must be enabled, belong to the selected space, and be within
the credential's current ingest grants. A revoked key, removed membership, or
cross-source request fails at the server boundary.

## HTTP contract

Send one JSON object to `/api/worker` with `Content-Type: application/json` and
`Authorization: Bearer <API key>`. The gateway accepts only a bounded JSON body:
the existing shared HTTP reader limits it to 512 KiB before parsing. Redirects,
file reads, source scans, and provider calls are not performed by the gateway.

The gateway returns JSON. Success is HTTP 200 with one of the command results
defined below. Results contain only the listed fields.

Failures return:

```json
{
  "error": { "code": "...", "message": "..." }
}
```

The published safe error codes are:

| HTTP | Codes                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `invalid_json`, `invalid_request`                                                                                                                                                                          |
| 401  | `not_authenticated`                                                                                                                                                                                        |
| 403  | `not_authorized`                                                                                                                                                                                           |
| 404  | `not_found`                                                                                                                                                                                                |
| 409  | `source_unavailable`, `request_conflict`, `scan_conflict`, `scan_not_ready`, `identity_review_required`, `reservation_expired`, `stale_observation`, `desired_processing_epoch_conflict`, `lease_conflict` |
| 413  | `payload_too_large`                                                                                                                                                                                        |
| 415  | `unsupported_media_type`                                                                                                                                                                                   |
| 429  | `rate_limited`                                                                                                                                                                                             |
| 500  | `worker_failed`                                                                                                                                                                                            |
| 503  | `authentication_unavailable`, `worker_unavailable`                                                                                                                                                         |

Messages are safe gateway messages. The endpoint does not expose source paths,
raw backend messages, or arbitrary backend error data.

## Initial command set

Protocol version 1 currently defines these fifteen commands:

| Operation                | Purpose                                              | Important bound                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.status`          | Read current worker-visible status for one source.   | No command-specific collection.                                                                                                                                                    |
| `source.inventoryPage`   | Read a validated inventory page for a scan.          | A request ID and active recovery scan, inventory epoch, and manifest version bind a page retry; `paginationOpts.numItems` is 1–50 and cursor is null or at most 8,192 UTF-8 bytes. |
| `scan.begin`             | Start a normal or identity-recovery scan.            | Request, watcher, and connector version IDs are each bounded.                                                                                                                      |
| `scan.appendPage`        | Submit one bounded discovery page.                   | 1–4 entries per page and at most 64 pages per scan.                                                                                                                                |
| `scan.seal`              | Seal a scan with healthy or failed discovery health. | `expectedPageCount` is 0–64.                                                                                                                                                       |
| `scan.reconcile`         | Reconcile a sealed scan against current inventory.   | `maxItems` is 1–50 and `ordinal` fences each advancing request.                                                                                                                    |
| `discovery.reserve`      | Lease enumerated discovery work for upload.          | `maxItems` is 1–4; the lease lasts five minutes.                                                                                                                                   |
| `discovery.admitUtf8`    | Verify and retain one reserved text revision.        | At most 65,536 UTF-8 bytes; exact discovered hash and byte count.                                                                                                                  |
| `jobs.reserve`           | Lease admitted text-processing jobs.                 | `maxItems` is 1–4; each lease lasts five minutes.                                                                                                                                  |
| `jobs.renew`             | Renew a current processing lease.                    | Fixed five-minute server duration; exact retries preserve the returned expiry.                                                                                                     |
| `jobs.stageUtf8`         | Stage retained text and evidence.                    | No text or counts accepted; server batches contain at most 25 rows.                                                                                                                |
| `jobs.activate`          | Publish the staged generation.                       | Current source observation and lease must still match.                                                                                                                             |
| `jobs.fail`              | Record a bounded worker failure.                     | Four published failure codes; server chooses retry policy.                                                                                                                         |
| `processing.assessBegin` | Start an assessment of one terminal scan.            | One live assessment per source; current inventory and manifest required.                                                                                                           |
| `processing.assessPage`  | Advance the server-owned assessment cursor.          | `maxItems` is exactly 1; only the latest committed page can replay.                                                                                                                |

All commands require `protocolVersion: 1`. Envelopes use exact fields: unknown,
missing, malformed, empty, or invalid-Unicode values are rejected as
`invalid_request`. Request IDs are at most 128 UTF-8 bytes. IDs for spaces,
sources, and scans are bounded by the shared parser.

Recovery inventory pagination must reach its terminal page before a worker
submits discovery entries.

The source mutation limit is 60 new requests per minute for each credential
and source-account pair. It covers `source.inventoryPage`, `scan.begin`,
`scan.appendPage`, `scan.seal`, `scan.reconcile`, `discovery.reserve`,
`discovery.admitUtf8`, the five `jobs.*` commands, and both `processing.*` commands. A retry that exactly
matches a retained request receipt does not consume the limit. Reusing a
request ID with different inputs fails as `request_conflict`.

`scan.appendPage` discovery entries carry a URI, source modification time, and
either a bounded ready-content observation or an explicit gap. A ready
observation requires a lowercase SHA-256 and a byte length from 1 through
65,536. Gap observations use one of `empty`, `enumeration_interrupted`,
`oversized`, `permission_denied`, `unreadable`, `unstable`, or `unsupported`.

Filesystem URIs have the canonical form
`fs://<root-alias>/<encoded-relative-path>`. The root alias is 1–64 lowercase
ASCII letters, digits, dots, underscores, or hyphens, and must begin with a
letter or digit. Each nonempty path segment uses the canonical
`encodeURIComponent` spelling. Raw control characters, spaces, backslashes,
queries, fragments, empty segments, dot segments, and encoded path separators
are rejected. The complete URI is at most 2,048 UTF-8 bytes.

## Request and result shapes

The common fields shown above are omitted from this table for brevity. Every
request object and nested object rejects unknown fields.

| Operation              | Additional request fields                                                                                      | Result fields                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.status`        | None.                                                                                                          | `{ operation, sourceAccountId, inventoryEpoch, completedInventoryEpoch, manifestVersion, enumeration, processing: { state, ...assessmentStatus }, recordCoverage: "not_established" }` |
| `source.inventoryPage` | `{ scanId, requestId, expectedInventoryEpoch, expectedManifestVersion, paginationOpts: { cursor, numItems } }` | `{ operation, page, isDone, continueCursor }`                                                                                                                                          |
| `scan.begin`           | `{ requestId, watcherId, connectorVersion, hostAffinity?, mode, expectedInventoryEpoch }`                      | `{ operation, scanId, inventoryEpoch, manifestVersion, state, reused }`                                                                                                                |
| `scan.appendPage`      | `{ scanId, requestId, ordinal, entries }`                                                                      | `{ operation, scanId, ordinal, reused, entries: [{ state, sourceItemId?, observationEpoch?, processingEpoch? }] }`                                                                     |
| `scan.seal`            | `{ scanId, requestId, expectedPageCount, health }`                                                             | `{ operation, scanId, state, reused }`                                                                                                                                                 |
| `scan.reconcile`       | `{ scanId, requestId, expectedInventoryEpoch, ordinal, maxItems }`                                             | `{ operation, scanId, state, inspected, unavailable, done, reused }`                                                                                                                   |
| `discovery.reserve`    | `{ requestId, maxItems }`                                                                                      | `{ operation, receiptId, expiresAt, reused, targets }`                                                                                                                                 |
| `discovery.admitUtf8`  | `{ requestId, workId, leaseEpoch, leaseToken, text }`                                                          | `{ operation, workId, sourceItemId, sourceRevisionId, processingGenerationId, ingestJobId, desiredProcessingEpoch, state: "admitted", reused }`                                        |

The processing commands use these additional request and result fields:

| Operation        | Additional request fields                                   | Result fields                                                                                                                    |
| ---------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `jobs.reserve`   | `{ requestId, maxItems }`                                   | `{ operation, receiptId, expiresAt, reused, targets }`                                                                           |
| `jobs.renew`     | `{ requestId, jobId, leaseEpoch, leaseToken }`              | `{ operation, jobId, state, leaseExpiresAt, reused }`                                                                            |
| `jobs.stageUtf8` | `{ requestId, jobId, leaseEpoch, leaseToken }`              | `{ operation, jobId, state: "staged", actualPageCount, actualEvidenceSpanCount, actualDocumentCount, actualChunkCount, reused }` |
| `jobs.activate`  | `{ requestId, jobId, leaseEpoch, leaseToken }`              | `{ operation, jobId, state: "ready", activatedAt, previousGenerationId?, reused }`                                               |
| `jobs.fail`      | `{ requestId, jobId, leaseEpoch, leaseToken, failureCode }` | `{ operation, jobId, state, retryable, nextAttemptAt?, failureCode, reused }`                                                    |

The assessment commands use these request and result fields:

| Operation                | Additional request fields                                                | Result fields                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `processing.assessBegin` | `{ requestId, scanId, expectedInventoryEpoch, expectedManifestVersion }` | `{ operation, assessmentId, scanId, inventoryEpoch, manifestVersion, state, nextOrdinal, counts?, completedAt?, reused, staleReason? }` |
| `processing.assessPage`  | `{ requestId, assessmentId, ordinal, maxItems: 1 }`                      | `{ operation, assessmentId, state, phase, ordinal, inspected, nextOrdinal, counts?, completedAt?, reused, staleReason? }`               |

Assessment states are `running`, `complete`, `incomplete`, or `stale`. Page
phases are `items`, `unresolved_entries`, or `done`. Only complete or incomplete
results contain counts and a completion time. Stale reasons are `source_changed`,
`detail_unavailable`, and `expired`.

A processing reservation target is
`{ jobId, workId, sourceItemId, observationEpoch, processingEpoch, state, leaseEpoch, leaseToken, leaseExpiresAt }`.
Its state is `processing` or `staged`. Reservation never selects legacy inline
ingestion jobs. A discovery reservation target is
`{ workId, sourceItemId, observationEpoch, processingEpoch, leaseEpoch, leaseToken, leaseExpiresAt, uri, contentHash, byteLength }`.
Lease tokens belong to the credential that reserved them and must be treated
as secrets. Another ingest credential cannot use or replay that lease.

`enumeration` is one of `{ state: "never" }`,
`{ state: "in_progress", scanId }`,
`{ state: "complete", scanId?, completedAt }`,
`{ state: "needs_review", scanId, completedAt? }`, or
`{ state: "failed", scanId?, completedAt?, failureCode? }`. A pruned scan
summary never invents a failure cause. An observed expiry reports
`enumeration_interrupted`.

An inventory page item is either
`{ lifecycle: "available" | "unavailable", sourceItemId, externalId, uri?, observationEpoch, processingEpoch, inventoryMetadataDigest? }`
or `{ lifecycle: "tombstone", externalIdHash, uriAliasDigests }`.
`forgetting` and `forgotten` rows deliberately share the stable `tombstone`
projection, so a lifecycle transition cannot change an identity-recovery page
under the same manifest fence.

Normal scans require `externalId` on every discovery entry. It is a lowercase
UUID with a valid version and variant. Identity-recovery scans may omit it.
`title` is at most 200 UTF-16 code units and `docType` is at most 100. A ready
content observation is `{ status: "ready", sha256, byteLength }`; a gap is
`{ status: "gap", code }`.

Reconciliation starts at ordinal 0. Each new request must supply the scan's
next ordinal, and a committed page increments it. An exact retry of the latest
request returns its stored result with `reused: true`. An older or out-of-order
ordinal cannot advance the cursor and fails with `scan_conflict` or
`scan_not_ready` after the scan becomes terminal.

`scan.begin.mode` is `normal` or `identity_recovery`. `scan.seal.health` is
`{ status: "healthy" }` or `{ status: "failed", code }`. Scan states are
`open`, `sealed`, `reconciling`, `enumerated`, `needs_review`, and `failed`;
the narrower seal result uses `sealed`, `needs_review`, or `failed`, and the
reconcile result uses `reconciling`, `enumerated`, or `needs_review`.
Per-entry append states are `unchanged`, `queued`, `gap`, `ignored_forgotten`,
and `needs_review`.

## Identity recovery and coverage limits

Normal discovery requires a stable external UUID. Identity-recovery scans may
omit that UUID so the server can require review instead of silently treating a
rename or journal loss as a new source. A worker cannot approve an ambiguous
identity mapping itself. `identity_review_required` is an operational result,
not permission to create a replacement identity.

Tombstones and source lifecycle state remain authoritative. Healthy
rediscovery can restore availability where the lifecycle permits it. A worker
must not resurrect a `forgetting` or `forgotten` source by retrying, changing a
request ID, or creating a lookalike external ID.

Completing or sealing a scan does not assert cloud coverage. Enumeration,
processing, parser classification, gaps, review, and date/type coverage have
separate states in the [Phase 2 plan](2026-09-07-phase2-document-pipeline.md).
In particular, a healthy folder scan does not prove complete financial or
record/date coverage.

## Discovery reservation and admission

Only work from a successfully enumerated scan is eligible for reservation.
The server checks the current source grant, original actor, file identity,
observation epoch, and processing identity inside the same transaction as the
lease. Retries return the same ordered targets and do not consume another
attempt. An expired, invalidated, or partially missing reservation fails and
returns no token. Generate unique request IDs and never intentionally reuse
them after receipt retention ends. Use a new request ID after the five-minute
lease expires.

Admission accepts text and the lease identity only. The server verifies the
text hash and byte length, derives the processing plan and fingerprints, and
uses the previously frozen discovery metadata. Worker-supplied authority,
capture timestamps, expected counts, and processing profiles are rejected.
An exact admission retry returns the same revision, generation, and job even
after successful admission has cleared the discovery lease. Reusing its
request ID with different text fails.

Admission retains a queued revision and job. It does not publish a searchable
document. Run a separate processing assessment to summarize the source after
publication; admission alone does not prove that processing is complete.

## Processing retained text

After admission, reserve the queued job, stage it, and activate it. Renew the
lease when needed. A reservation may return a previously staged job after a
worker crash; that job can proceed to activation with its new lease. Reservations
validate at most sixteen candidates per request. Invalid or exhausted jobs,
including jobs whose original actor lost access, move to review without being
leased. This queue classification requires the executing credential's current
source grant; it does not authorize processing under the revoked actor. Later
valid jobs can then make progress. Other job operations still reject revoked
authority before changing processing state.

`jobs.stageUtf8` reads the admitted revision inside the server. The server
verifies its bytes and hash and derives text, pages, evidence spans, document,
and chunks using the deterministic inline-text plan. It accepts no worker text,
metadata, processing profile, expected counts, or capture timestamp. Every
staging batch rechecks the full source, scan, work, revision, generation, and
lease chain. A new observation or revoked executing or original credential
prevents further writes and activation.

The first staging mutation saves a pending operation receipt before inserting
provenance rows. An exact retry resumes that intent under the same current
lease. A different job or body with the same request ID fails before staging
writes. After lease expiry, reserve again and use new operation request IDs.
Existing compatible staged rows are reused. Once a document exists, its frozen
metadata remains immutable even if a later observation changes its path or
title. Recovery after a gap follows the item's exact desired processing job,
not the latest scan-detail row. It remains valid when gap details have been
pruned or another scan was interrupted before admission. A resumed attempt uses
a new correction generation while reusing compatible immutable evidence.

Activation publishes the complete staged generation atomically. Exact renewal,
staging, activation, and failure retries return the committed result after
current authorization and parent checks. They do not extend a lease twice or
publish twice. Old receipts cannot authorize a newer observation or lease.

`jobs.fail` accepts `worker_interrupted`, `worker_resource_exhausted`,
`source_bytes_invalid`, or `staging_invalid`. The server supplies a safe message,
retryability, backoff, and attempt limit. The worker cannot submit an arbitrary
error message or retry timestamp. Exhausted or invalid jobs require review.
The existing web actor-replacement operation rejects worker-linked jobs;
explicit owner-authorized worker provenance recovery is planned before pilot
use.

## Source processing assessment

After a terminal scan, call `processing.assessBegin` with `requestId`, `scanId`,
`expectedInventoryEpoch`, and `expectedManifestVersion`. The server records the
current source and scan state and initializes its counters. A different start
request cannot replace an unexpired running assessment. An exact start retry
returns the same assessment under the original live credential.

Call `processing.assessPage` with `requestId`, `assessmentId`, `ordinal`, and
`maxItems: 1`. The server owns the cursor and performs two walks: source items,
then unresolved scan entries. The result contains `assessmentId`, `state`,
`phase`, `ordinal`, `inspected`, `nextOrdinal`, and `reused`. Terminal results
include counts; running results do not expose partial counts. The client cannot
supply a cursor, timestamps, counters, or classification.

Only the most recently committed page request has a replay guarantee. Retry
that exact request after a lost response. Once the next page commits, an older
page cannot replay or advance the assessment. The terminal page remains
replayable while its assessment and source state remain valid. A new assessment
recounts the source from the beginning.

A source change during either walk invalidates the assessment. The server also
checks generic revision admissions and availability changes, so a document
counted earlier cannot silently become unfinished before completion. Missing or
pruned required scan detail produces `stale` with `detail_unavailable`; a new
scan is required. Source changes and expiry have separate bounded stale reasons.
A running assessment expires after thirty minutes without a new page. Cleanup
retains its required scan detail while it is active and unexpired.

The item counts are `ready`, `pending`, `failed`, `needsReview`, `explicitGap`,
`unavailable`, and `ignoredForgotten`. Unresolved entries separately count
`needsReview` and `ignoredForgotten`. Each item or unresolved entry contributes
once. A terminal result is `complete` only when no pending, failed, review, gap,
or unavailable category remains. A terminal scan needing review always yields
`incomplete`. Empty sources and valid forgotten tombstones do not block completion.

Ready means the item's exact desired revision and generation have been
published. Historical failed jobs do not block a newer ready generation.
Revoking a historical ingestion credential does not unpublish ready evidence;
unfinished work with revoked original authority needs review. The credential
performing an assessment must remain authorized on every request.

`source.status.processing` reports `not_assessed`, `assessing`, `complete`, or
`incomplete`. A terminal status includes its assessment and scan IDs, inventory
and manifest versions, `completedAt`, and counts. Counts are a snapshot from
that assessment, not live queue totals. Later processing can leave a conservative
`incomplete` snapshot until the next assessment. A changed source fence suppresses
old results, and publication-time changes also suppress old snapshots when detected.
Assessment results contain no source paths, document text, or item-level IDs.

Enumeration, processing, and record coverage remain distinct. Neither a healthy
scan nor a `complete` processing assessment proves that every financial record,
medical test, or date range has been captured.

## Deferred operations

Parsing, binary archives, and generic job execution remain unavailable. A ready
text document can be searched and read through the authorized hosted document
tools. A completed processing assessment does not establish record or date
coverage. `recordCoverage` remains `not_established`.

## Upgrading queued admissions

Deploy the schema and functions before starting a B2 worker. An installation
that retained queued admissions from the discovery-only release must backfill
the processing-queue marker. This internal migration preserves content, actors,
leases, and processing identity. It skips unrelated inline jobs and reports
stale, revoked, or inconsistent admissions as blocked.

Start with a development dry run:

```sh
pnpm --filter @repo/db exec convex run models/workers/migrations:backfillManagedJobs '{"cursor":null,"maxItems":10,"dryRun":true}'
```

Follow `continueCursor` until `isDone` is true. After reviewing the totals,
restart from `cursor: null` with `dryRun: false`, and follow every page again.
Rerun to verify that `eligible` and `updated` are zero. Resolve any `blocked`
rows explicitly; this migration cannot replace revoked worker authority.
Use the same development-verified command with `--prod` for the intended
production deployment. Each invocation inspects at most ten jobs. A fresh
installation needs no backfill.

## Retention and forgetting

Cleanup uses a bounded native page and a separate saved cursor and cutoff for
each category. It rotates between categories, so retained rows cannot prevent
later eligible rows from being inspected. The internal cron runs every five
minutes and inspects at most 25 primary rows per invocation. Cleanup progress is
ephemeral and may restart safely after a restore or protocol upgrade.

Unreferenced detail rows become eligible for cleanup after 30 days. Scan
summaries become eligible after 90 days. These are eligibility times, not exact
deletion deadlines. Rows still needed by work or child records remain retained.
Queued work whose scan failed or requires review is quarantined. Processing
must also check scan eligibility directly; it cannot rely on cleanup having run.

Forgetting hides an item immediately and removes its history in bounded steps.
It removes linked and unresolved identity metadata, including candidates found
by a known path alias or external identity hash. If a scan page included the
item, its metadata-derived request digest is erased. That page can no longer
replay its original receipt, even if it also contained other items. The other
items are preserved. Minimal tombstone and path-alias digests remain to prevent
accidental reimport through known identities.

Reservation targets become eligible for cleanup when their leases expire.
Reservation headers and operation receipts retain request identity
for 30 days; headers are removed only after their targets are gone. Expired
rate-limit windows are also cleaned up without resetting a live window.
Forgetting removes item-specific operation receipts and reservation targets.
It invalidates a shared reservation header so it cannot replay a partial list,
while leaving other items' independent leases intact.
