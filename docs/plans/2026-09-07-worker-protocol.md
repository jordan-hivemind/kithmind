# Worker protocol v1

**Date:** 2026-09-07

**Status:** Implementation in progress. This document describes the initial
worker gateway commands currently defined in the shared protocol. It does not
claim a complete filesystem worker, parser, reservation queue, or acceptance
result.

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

Protocol version 1 currently defines exactly these six commands:

| Operation              | Purpose                                              | Important bound                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.status`        | Read current worker-visible status for one source.   | No command-specific collection.                                                                                                                                                    |
| `source.inventoryPage` | Read a validated inventory page for a scan.          | A request ID and active recovery scan, inventory epoch, and manifest version bind a page retry; `paginationOpts.numItems` is 1–50 and cursor is null or at most 8,192 UTF-8 bytes. |
| `scan.begin`           | Start a normal or identity-recovery scan.            | Request, watcher, and connector version IDs are each bounded.                                                                                                                      |
| `scan.appendPage`      | Submit one bounded discovery page.                   | 1–4 entries per page and at most 64 pages per scan.                                                                                                                                |
| `scan.seal`            | Seal a scan with healthy or failed discovery health. | `expectedPageCount` is 0–64.                                                                                                                                                       |
| `scan.reconcile`       | Reconcile a sealed scan against current inventory.   | `maxItems` is 1–50 and `ordinal` fences each advancing request.                                                                                                                    |

All commands require `protocolVersion: 1`. Envelopes use exact fields: unknown,
missing, malformed, empty, or invalid-Unicode values are rejected as
`invalid_request`. Request IDs are at most 128 UTF-8 bytes. IDs for spaces,
sources, and scans are bounded by the shared parser.

Recovery inventory pagination must reach its terminal page before a worker
submits discovery entries.

The source mutation limit is 60 new requests per minute for each credential
and source-account pair. It covers `source.inventoryPage`, `scan.begin`,
`scan.appendPage`, `scan.seal`, and `scan.reconcile`. A retry that exactly
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

| Operation              | Additional request fields                                                                                      | Result fields                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.status`        | None.                                                                                                          | `{ operation, sourceAccountId, inventoryEpoch, completedInventoryEpoch, manifestVersion, enumeration, processing: { state: "not_assessed" }, recordCoverage: "not_established" }` |
| `source.inventoryPage` | `{ scanId, requestId, expectedInventoryEpoch, expectedManifestVersion, paginationOpts: { cursor, numItems } }` | `{ operation, page, isDone, continueCursor }`                                                                                                                                     |
| `scan.begin`           | `{ requestId, watcherId, connectorVersion, hostAffinity?, mode, expectedInventoryEpoch }`                      | `{ operation, scanId, inventoryEpoch, manifestVersion, state, reused }`                                                                                                           |
| `scan.appendPage`      | `{ scanId, requestId, ordinal, entries }`                                                                      | `{ operation, scanId, ordinal, reused, entries: [{ state, sourceItemId?, observationEpoch?, processingEpoch? }] }`                                                                |
| `scan.seal`            | `{ scanId, requestId, expectedPageCount, health }`                                                             | `{ operation, scanId, state, reused }`                                                                                                                                            |
| `scan.reconcile`       | `{ scanId, requestId, expectedInventoryEpoch, ordinal, maxItems }`                                             | `{ operation, scanId, state, inspected, unavailable, done, reused }`                                                                                                              |

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

## Deferred operations

This initial protocol has no public reservation, due-job, lease renewal,
staging, activation, parser, archive, or generic job command. Those operations
remain unavailable until separately implemented and documented. Do not invent
their request or result shapes from internal models.

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
