# Provider reference rebind and per-item parking (P2-31)

Status: proposed. Supersedes nothing. Written after the 2026-09-18 incident and
the P2-31a and P2-31b fixes.

## 1. How the live state arises

The provider reference and the discovery work row are keyed differently. That is
the whole of it.

| Row                                     | Key                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `source_provider_original_references`    | `(source_account_id, client_reference_id)`, bound to one `source_revision_id`               |
| `source_provider_original_bindings`      | `source_revision_id`                                                                        |
| `worker_discovery_work`                  | `(source_item_id, observation_epoch)` where state is not `obsolete`                         |
| `source_parser_artifacts`                | `(source_account_id, client_artifact_id)`                                                   |

`createAndBindProviderOriginal` runs inside `admitArchivedDiscovery`
(`packages/kith-store/src/workers/archivedDiscovery.ts:1613`), in the same
serializable transaction that sets the work row to `admitted`
(`archivedDiscovery.ts:1685`). So a reference and its own work row's admission
always commit together. The apparent contradiction is that they are not the same
work row.

A reference belongs to the revision. A work row belongs to an observation epoch.
An earlier epoch admitted the revision, bound the reference, and created the
ingest job. Publication then did not finish, so no document exists. A later scan
created a new work row and, because the earlier processing row never activated,
`reusableProcessingRow` did not reuse it, so a new processing row was created
with a new `client_artifact_id`
(`packages/pipeline/src/runner.ts:1454`).

The two lookups then disagree, correctly:

| Lookup mode  | Resolves against                                     | Result here |
| ------------ | ---------------------------------------------------- | ----------- |
| `original`   | the revision and its recovery (`archivedDiscovery.ts:943`) | found       |
| `processing` | this epoch's `client_artifact_id` (`archivedDiscovery.ts:956`) | not found   |

So `driveArchivedLookupOriginal` records `cloud` and continues
(`packages/pipeline/src/runner.ts:3708`), `lookup_processing` sends the pass to
`parser_archive` (`runner.ts:4172`), and `admit` rebuilds a declaration for a
reference that already exists. P2-31b now refuses that before it spends a lease.

### Counts to confirm from production

Code cannot tell whether the earlier work row was admitted or obsoleted. These
are counts and enum values only, no text columns.

| Table                                   | Query                                                                        | Decides                                    |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `kith.worker_discovery_work`            | `count(*)` grouped by `state` where `source_item_id` is the item              | whether an earlier epoch reached `admitted` |
| `kith.source_parser_artifacts`          | `count(*)` where `source_account_id` is the account and the revision matches  | whether an earlier artifact exists          |
| `kith.ingest_jobs`                      | `count(*)` grouped by `state` for that revision                               | whether publication started and stalled     |

If the first shows an `admitted` or `obsolete` row and the third shows a job,
the account above is confirmed.

## 2a. Per-item parking

Today one unprovable item throws out of `driveCheckpoint` and fails the pass for
every other file. The parse-failure convention already solves this shape.

Design, following `parseFailure` (`packages/pipeline/src/archiveCatalog.ts:2188`):

1. Add `admissionBlock?: { code: string; blockedAt: number }` to the original
   catalog row. One code, no free text.
2. Record it where the runner throws a terminal per-item code, starting with
   `provider_original_reference_already_bound`.
3. Skip a blocked row in `pdfNeedsArchivedWork` (`runner.ts:1311` is where
   `parseAttemptsSpent` already does this), and move to the next PDF exactly as
   `recordArchivedParseFailure` does.
4. Clear it when the block's cause changes: a new content hash, a new provider
   revision, or an operator release.

| Surface      | Shows                                                             |
| ------------ | ----------------------------------------------------------------- |
| doctor       | a per-source count of parked items and the distinct block codes    |
| review queue | one entry per parked item with its code and blocked time           |
| release      | an operator op that clears `admissionBlock` for one catalog row    |

Risks: a parked item is silent until someone reads the doctor, so the count must
be surfaced, not just stored. A block that outlives its cause hides real work,
so the clearing rules matter more than the marker.

Tests: a blocked row is skipped and the pass completes over the others; a block
survives a restart; a changed content hash clears it; release restores it; the
pass result stays `complete` rather than `failed`.

## 2b. Completing admission against a bound reference

| Option                              | Attack or bug surface                                                                                                     | Property weakened                                              | Migration        | Wire         | Size   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------- | ------------ | ------ |
| (i) `providerOriginal: { kind: "existing", providerReferenceId }` | A client naming another row's reference; the server must re-check space, source account, source item, revision and content hash against the work being admitted | None. The reference stays immutable and the audit row unchanged | None             | Additive     | Medium |
| (ii) Relax the match rule to accept an identical declaration                | A client that re-declares with fresh timestamps every pass; the row's `verified_at` then no longer means what it says       | Immutability by request digest, and the meaning of `verified_at` | None             | None         | Small  |
| (iii) Operator op that releases an unreferenced bound reference             | An operator releasing a reference a document still depends on, silently detaching the only pointer to the original bytes    | The reference's durability guarantee                            | None             | None         | Small  |

Recommendation: **(i)**.

It is the only option that leaves the reference immutable, keeps the audit row
exactly as first written, and needs no migration. It mirrors
`ArchiveReceiptSelection`'s existing `kind: "existing"` shape
(`packages/pipeline/src/archivedRequestMapping.ts:172`), which the protocol
already carries for receipts and which the runner has never had a reason to
send. The client supplies only `providerReferenceId`, and the server verifies it
belongs to the same space, source account, source item and source revision, and
that its `source_content_hash` and `source_byte_length` equal the work row's.
A mismatch is `stale_observation`. Nothing about the recorded proof is
re-asserted, because nothing about it changed.

Option (ii) is smallest but buys the size by making `verified_at` a value the
client can refresh without the row changing, which is the property the freshness
window exists to enforce. Option (iii) turns a durability record into something
an operator can delete, which is the wrong direction for the one pointer to an
original this system does not hold a copy of.

Tests for (i): an existing selection admits and reuses the recorded reference; a
reference from another space, source account, item or revision is refused; a
reference whose content hash differs from the work row is refused; a declaration
and an existing selection in the same request is refused; replay of an existing
selection is idempotent; a never-admitted original still takes the declaration
path unchanged.

## 3. Order for the live incident

2a first. It is client-only, needs no protocol change and no server review, and
it is what stops one item from failing the pass over every other file. The
watcher can then run normally while 2b is designed and reviewed.

2b second, because it is the only thing that publishes this document, and it
changes the wire contract and the server.

Operator sequence after 2b lands:

1. Confirm the counts in section 1.
2. Reset attempts only if the row is at the cap: `kith-discovery-reset --space <id>` then `--apply`.
3. Update the worker checkout and rebuild.
4. Expected first pass: `lookup_original` found, `lookup_processing` not found,
   one reserve, an admit carrying the existing selection, then the parsed legs.

## 4. Security review per AGENTS.md

| Piece                          | Tier | Review                                                            |
| ------------------------------ | ---- | ----------------------------------------------------------------- |
| 2a parking marker and skip     | 1    | Ordinary PR review. No auth or space isolation surface             |
| 2b protocol and server change  | 2    | Tier 2 or above and a second-model review before merge             |
| 2b server identity checks      | 2    | The space and source account checks are the review's main subject  |
| Operator release op (2a)       | 2    | It writes a row the pipeline reads as permission to retry          |

No migration is expected for either piece. If 2a's marker is added to the local
catalog only, no Convex-side or Postgres-side migration command is needed. If a
server-side parked state is added later, record the exact `npx convex run`
equivalent in the tracker or a public issue as the guide requires.
