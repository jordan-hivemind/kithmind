# Embedding index capacity and incremental generations

Date: 2026-09-12. Status: P2-6 design plan. No implementation lands with this
document.

Parent: [Phase 2 document pipeline](./2026-09-07-phase2-document-pipeline.md).
Related: [embedding contract](./2026-09-06-embedding-contract.md),
[PDF document capacity](./2026-09-07-pdf-document-capacity.md),
[pilot retrieval evaluation](./2026-09-08-pilot-retrieval-evaluation.md).
The document-card backfill model is specified separately as P2-70; this plan
covers index capacity only and does not restate it.

## Purpose

The semantic index is bounded at 256 targets per space, built whole-space in a
single transaction. A read-only preflight of a 108-file backfill sample
projected about 700 new chunks under per-page chunk targets. The owner has
since chosen the document-card model for backfill: one or two embedded targets
per document, with cards carried as records and retained text still searchable
by keyword.

That changes the required scale, not the shape of the problem.

| Horizon                           | Targets per space | Basis                                            |
| --------------------------------- | ----------------- | ------------------------------------------------ |
| First backfill                    | Low thousands     | The first admitted batch under the card model    |
| Whole owner corpus, card model    | 10,000 to 20,000  | About 10,000 files at one to two targets each    |
| Design ceiling, must not preclude | 50,000            | Headroom for re-chunking or a second target kind |

The first backfill is low thousands of targets. No constant, schema choice or
page bound in this design may preclude 50,000. Every stated invariant holds at
both ends of that range; only the page counts differ.

This is still not a constant bump. Above a few thousand targets the single-page
manifest scan, the whole-space eligibility rebuild, the all-or-nothing coverage
rule and the 2 MiB manifest budget all bind. Section 8.1 records which budgets
and which PRs get simpler at the card-model scale, and which do not.

## 1. Target scale and budgets

### 1.1 Scale targets

| Quantity                        | Today              | Design target                                             |
| ------------------------------- | ------------------ | --------------------------------------------------------- |
| Eligible targets per space      | 256                | No code constant below 50,000                             |
| Manifest construction           | One transaction    | Paged, resumable, unbounded in total                      |
| Vector rows read per generation | 256                | Paged, unbounded in total                                 |
| Admitting a new batch           | Re-embed all       | Embed only new or changed targets                         |
| Manifest byte budget            | 2 MiB per space    | Per page, not per space                                   |
| Retained vector generations     | All, never cleaned | Active plus one retired, cleanup after the first backfill |

Storage arithmetic: one 1,536-dimension float64 vector is 12,288 bytes, about
12.5 KiB per row with field overhead.

| Targets | Vectors per fingerprint | Two fingerprints | Provider requests for a full rebuild at 32 per request |
| ------: | ----------------------: | ---------------: | -----------------------------------------------------: |
|   2,000 |                 ~24 MiB |          ~49 MiB |                                                     63 |
|  20,000 |                ~244 MiB |         ~488 MiB |                                                    625 |
|  50,000 |                ~610 MiB |         ~1.2 GiB |                                                  1,563 |

The card model moves the first backfill to the top row and the whole corpus to
the middle row. The bottom row stays the design ceiling.

### 1.2 Convex per-request limits

Read from the Convex documentation on 2026-09-12.

| Limit                                 | Documented value        | Source                                                                        |
| ------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| Documents scanned, transaction        | 32,000                  | [Limits](https://docs.convex.dev/production/state/limits)                     |
| Data read, transaction                | 16 MiB                  | Limits                                                                        |
| Documents written, transaction        | 16,000                  | Limits                                                                        |
| Data written, transaction             | 16 MiB                  | Limits                                                                        |
| Query or mutation time                | 1 second                | Limits                                                                        |
| Action time, Node runtime             | 10 minutes              | Limits                                                                        |
| Action time, Convex runtime           | 30 minutes              | Limits                                                                        |
| Function argument or return           | 16 MiB                  | Limits                                                                        |
| Document size                         | 1 MiB                   | Limits                                                                        |
| Indexes per table                     | 32                      | Limits                                                                        |
| Functions scheduled from one function | 1000, 8 MB of arguments | [Scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions) |

A scheduled mutation is transactional with the mutation that scheduled it and
runs exactly once. A scheduled action runs at most once and is not retried.
Every provider-calling step is therefore an action whose only durable effect is
an idempotent vector insert, and every bookkeeping step is a mutation.

### 1.3 Vector index limits

| Limit                          | Documented value | Source                                                        |
| ------------------------------ | ---------------- | ------------------------------------------------------------- |
| Vector indexes per table       | 4                | [Vector search](https://docs.convex.dev/search/vector-search) |
| Vector field dimensions        | 2 to 4096        | Vector search                                                 |
| Filter fields per vector index | 16               | Vector search                                                 |
| Results per vector search      | 256, default 10  | Vector search                                                 |
| Vectors searched per call      | 1                | Limits                                                        |
| Maximum vectors per index      | Not documented   | Vector search states support for "millions of vectors today"  |

`by_embedding_1536` pins 1,536 dimensions and uses one filter field of the 16
available. Dimensions stay at 1,536: the active production profile is
`text-embedding-3-large` at 1,536 dimensions, and a dimension change is a new
index and a full rebuild, which this plan does not propose.

Vector search has no paging. Retrieval cost is therefore constant in corpus
size: the document path requests 32 candidates split across spaces and the
thought path requests a bounded cap. Growing the corpus from 180 to 50,000
targets changes recall at a fixed candidate budget; it does not change the
per-request read cost. Recall at scale is a retrieval-quality question for a
later evaluation, not a capacity question, and this plan makes no claim about
it.

### 1.4 Per-stage budgets

Page sizes are chosen so each transaction stays far inside the 16 MiB and
1 second limits, not merely under them.

| Stage                 | Rows per page | Dominant row size       | Read per page | Write per page |
| --------------------- | ------------: | ----------------------- | ------------: | -------------: |
| Target scan, chunks   |           128 | 8 KiB text              |        ~1 MiB |              0 |
| Target scan, cards    |           128 | ~2 KiB text             |      ~512 KiB |              0 |
| Target scan, thoughts |            64 | ~12.5 KiB legacy vector |      ~800 KiB |              0 |
| Target row upsert     |           128 | ~256 B                  |       ~32 KiB |        ~32 KiB |
| Manifest input fetch  |            32 | 8 KiB text              |      ~256 KiB |              0 |
| Vector insert         |            32 | ~12.5 KiB               |      ~400 KiB |       ~400 KiB |
| Vector audit read     |           128 | ~12.5 KiB               |      ~1.6 MiB |              0 |
| Vector delete         |           128 | ~12.5 KiB               |      ~1.6 MiB |       ~1.6 MiB |

Page sizes are set by the largest target kind a space can hold, not by the kind
the current backfill produces. A space keeps its existing chunk targets after
the card model lands, so the chunk row keeps the budget.

The card scan row doubled when P2-70j implemented it. A card target is one
`events` row, its `eventVersions` row for the active card generation and that
version's observations, so composing one card's input reads about twice the
~2 KiB the plan first assumed. 128 rows is still ~512 KiB, well inside the
16 MiB read budget, so the page size is unchanged.

The thought scan page is smaller because a thought row still carries the legacy
`embedding` field. That field is retained audit data under the embedding
contract; this plan does not delete it, and it is why a thought page costs more
than a chunk page.

Provider batching: 32 inputs per embeddings request, returning about 400 KiB,
well inside the 16 MiB argument limit for the mutation that stages them. A full
rebuild is 63 requests at 2,000 targets and 1,563 at 50,000. Each scheduled
action performs at most 8 requests and then schedules its successor, so no
action approaches the 10 minute Node limit and a crash loses at most 256 targets
of in-flight work.
Elapsed provider time is not estimated here; the pilot recorded request counts
and token counts, not a rate.

## 2. Durable resumable manifest construction

The manifest becomes a table instead of a value computed in one transaction.

### 2.1 `embeddingTargets`

One row per eligible target per space.

| Field                    | Meaning                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `spaceId`                | Owning space.                                                                     |
| `targetKind`             | `thought` or `chunk`.                                                             |
| `targetId`               | Stringified thought or chunk id.                                                  |
| `inputHash`              | SHA-256 of the exact embedded text. The content fingerprint.                      |
| `processingGenerationId` | Present for chunks only. Parent-chain binding.                                    |
| `state`                  | `eligible` or `retired`.                                                          |
| `coveredFingerprint`     | Optional. The profile fingerprint whose vector exists for this exact `inputHash`. |
| `updatedAt`              | Last transition time.                                                             |

Indexes: `by_space_kind_target` for identity and upsert, `by_space_and_state`
for paging the eligible set, `by_space_and_coveredFingerprint` for paging the
targets a build still owes.

Identity is `(spaceId, targetKind, targetId)`. The row is created or patched in
the same mutation that makes the target eligible and moved to `retired` in the
same mutation that makes it ineligible. The content fingerprint is `inputHash`:
an unchanged chunk keeps the same hash, so it keeps its vector.

### 2.2 `embeddingBuildJobs`

One row per build, holding the cursor.

| Field                                                     | Meaning                                              |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `spaceId`                                                 | Owning space.                                        |
| `fingerprint`                                             | Profile the build is filling.                        |
| `embeddingGenerationId`                                   | Generation this build belongs to.                    |
| `phase`                                                   | `scan`, `fill`, `audit`, `done`, `abandoned`.        |
| `cursor`                                                  | Opaque page cursor, or null at a phase boundary.     |
| `pageIndex`                                               | Monotonic page counter, for operator reporting only. |
| `scannedCount`, `filledCount`                             | Progress counters for reporting only.                |
| `startedAt`, `updatedAt`, `failureCode`, `failureMessage` | Operator evidence.                                   |

At most one non-terminal job per `(spaceId, fingerprint)`.

### 2.3 Paging and idempotent resume

Each page is one mutation. The caller passes the cursor it last received. The
mutation compares it with the stored cursor and refuses to act if they differ,
returning the stored cursor instead. This is the same compare-and-set shape as
`expectedPreviousGenerationId` at activation.

| Failure                                  | Result on resume                                                  |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Crash before the page mutation commits   | Cursor unchanged. The page is retried and produces the same rows. |
| Crash after commit, before the next call | Cursor advanced. The next call continues from it.                 |
| Duplicate call with the previous cursor  | Refused as a stale cursor. Nothing is written twice.              |
| Duplicate call with the current cursor   | Upserts recompute the same values. No new rows.                   |
| Provider action lost, at most once       | The target stays uncovered. The next fill page re-embeds it.      |

Page writes are upserts keyed by target identity, so replay is a no-op when the
content is unchanged. `backfillBaselineThoughtVectors` already runs
`.paginate()` inside an `internalMutation` in this repository, so the pattern is
proven here. The Convex pagination documentation does not describe cursor use
inside mutations, so the compare-and-set guard is required rather than optional:
if a cursor is ever rejected by the platform, the job restarts its phase from
null and the upserts make the repeat harmless.

## 3. Incremental generations

### 3.1 Two kinds of change

The current design treats every index change as a whole-space rebuild. It has
two different changes underneath.

| Change                           | Mechanism                                                    | Cost        |
| -------------------------------- | ------------------------------------------------------------ | ----------- |
| Profile change, new fingerprint  | New generation staged under its own fingerprint, atomic flip | All targets |
| Content change, same fingerprint | Incremental admission into the active generation             | Delta only  |

Only a profile change re-embeds the corpus, because a different model cannot
reuse a vector. A content change embeds the new or changed targets and nothing
else.

### 3.2 Content-addressed vectors

A vector row is immutable: its content is fixed by `(spaceId,
embeddingFingerprint, targetKind, targetId, inputHash)` and is never patched.
Its place in the index is exclusive: at most one row exists per `(spaceId,
embeddingFingerprint, targetKind, targetId)`, so a target has exactly one
vector under a fingerprint at any time. A row is no longer identified by a
generation.

Immutability and exclusivity are different properties and both are needed.
Immutability is what makes reuse safe. Exclusivity is what keeps a superseded
vector out of the candidate set, and it is enforced by I11: re-embedding a
target deletes its previous row in the same transaction.

A chunk target's `targetId` is its chunk row id, so anything that gives
unchanged content a new chunk row id retires and recreates its target and
forces a re-embed. Publishing a document card never does: a card generation is
a sibling of the text generation and creates no chunk row, per section 4.6 of
the [document-card plan](./2026-09-12-document-cards.md). This is what keeps
I3 and I11 satisfied while cards are published over an indexed corpus.

The vector search scope becomes:

```
["embedding-vector-scope-v2", spaceId, fingerprint, targetKind]
```

The generation id leaves the filter value. This is the change that makes reuse
free. With the generation in the filter, reusing a vector means copying the row
into the new generation: about 244 MiB of writes at 20,000 targets and 610 MiB
at 50,000, proportional to the space and not to the delta. With the generation
out of the filter, an unchanged target simply keeps its row and the new
generation inherits it at no cost. The card model shrinks that copy cost without
removing it; decision D1 in section 11 states the alternative and the
recommendation.

The new scope is a second filter field, `scopeV2`. The existing `searchScope`
field is left in place and keeps working until every space has migrated, so the
cutover is reversible. One filter field of the 16 available is used today; two
after this change.

Space isolation is unchanged: `spaceId` is still the first discriminating
element of the filter value, the filter is still one equality comparison, and
hydration still rechecks authorization against the live space membership.

### 3.3 Invariants

| Id  | Invariant                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | A vector row is immutable. Its content is fixed by `(spaceId, fingerprint, targetKind, targetId, inputHash)` and is never patched.                                                                                                           |
| I2  | `scopeV2` is a pure function of `(spaceId, fingerprint, targetKind)` and contains no generation identity.                                                                                                                                    |
| I3  | A target whose `inputHash` is unchanged keeps its vector across generations of the same fingerprint. No copy, no re-embed.                                                                                                                   |
| I4  | Eligible counters change only in the transaction that changes eligibility. Covered counters change only in the transaction that inserts or deletes a vector.                                                                                 |
| I5  | A generation for fingerprint F is complete for a kind when `covered(F, kind) == eligible(kind)`, the drift flag is false, and the last audit watermark is at or after the last eligibility change.                                           |
| I6  | Activation sets `activeFingerprint` and `activeEmbeddingGenerationId` in one mutation, under compare-and-set on the expected previous generation, and only when I5 holds for thoughts.                                                       |
| I7  | Hydration rechecks the active fingerprint, the live target's content hash and the target's current eligibility. A row failing any check is dropped and never returned.                                                                       |
| I8  | Cleanup never deletes a row whose fingerprint equals the active or retained fingerprint, checked by re-reading the space state inside each delete page.                                                                                      |
| I9  | Narrative capture requires complete thought coverage. Chunk coverage never blocks capture.                                                                                                                                                   |
| I10 | Incomplete chunk coverage is reported to the reader, not converted into unavailable semantic retrieval.                                                                                                                                      |
| I11 | The transaction that inserts a vector for `(target, new inputHash)` deletes that target's rows under the same fingerprint with any other `inputHash`. At most one row per `(spaceId, fingerprint, targetKind, targetId)` exists at any time. |

### 3.3.1 Why I11 is required, and what I7 still does

Removing the generation id from the filter means a target's old and new vectors
share one `scopeV2` value. Without I11 both rows are searchable. Hydration drops
the stale one under I7, but the damage is already done: the stale row consumed a
candidate slot in a fixed 32-candidate budget, so a real match can be pushed out
of top-k and no recheck can recover it. Two rows for one target can also reach
hydration together, which the candidate path should never have to reason about.

I11 makes the exclusion structural rather than corrective. The insert path
already looks the target up by index to detect a duplicate; that lookup becomes
delete-then-insert in the same transaction, so the swap is atomic and no window
exists where a target has two rows or none. A re-embed is therefore one delete
plus one insert, and the covered counters net to zero across it. I4 still
applies to each half.

| Property                  | Enforced by | Failure it prevents                             |
| ------------------------- | ----------- | ----------------------------------------------- |
| One row per target        | I11         | A superseded vector taking a candidate slot     |
| Row content never changes | I1          | A reused vector silently meaning something else |
| Stale row never returned  | I7          | A row whose target changed since the last embed |

I7 stays, and is not made redundant by I11. It covers the window between an
eligibility change and its re-embed: a target whose text changes has a stale
vector until the fill reaches it, and during that window I11 has nothing to
delete because no new row exists yet. I7 drops that row from results while I5
reports the space as incompletely covered. I11 governs the moment of re-embed;
I7 governs everything before it.

Where a content change produces a new target id, as chunk replacement does, the
old target is retired by its eligibility write and its vector is removed by the
existing per-target cleanup. I11 binds where a target id is stable across a
content change, which is the normal case for thoughts and for document cards.

### 3.4 Why activation is still atomic for the reader

A reader derives its filter value from one row: the space state. That row names
one fingerprint. Activation changes it in one transaction. Therefore:

1. Every request filters on exactly one fingerprint, so two profiles can never
   appear in one ranked result.
2. A build under a new fingerprint is invisible to readers for its whole
   lifetime, because no reader ever names that fingerprint until the flip.
3. If the flip happens between the reader's scope read and its hydration read,
   hydration rechecks the active target and drops the stale rows. The request
   degrades to fewer candidates or to keyword only. It never mixes.
4. Within one fingerprint the index only grows, and every added row belongs to a
   currently eligible target with a matching content hash. A reader therefore
   sees a subset of exactly one manifest.

"Complete" is I5: the counters agree and the audit watermark is not behind the
last eligibility change. The counters are exact because I4 makes each one a
transactional side effect of the fact it counts, so completeness is an O(1)
check rather than a full scan.

This changes one rule in the embedding contract. Today an incomplete chunk index
makes semantic retrieval unavailable for the whole request. At 50,000 targets
that means one newly published document disables semantic search for the space
until it is embedded. The architecture is right and the contract paragraph is
wrong: section 5.1 of the architecture already states that pending embeddings do
not hide validated records, that the idempotent retry fills the compatible index
and that incomplete semantic results are labeled. Chunk coverage becomes a
reported ratio on the existing `vectorStatus` and `partial` fields. Thought
coverage stays strict, because narrative capture uses the thought index for
duplicate detection and a missing thought vector would weaken that check.

### 3.5 Abandoning a failed build

| Case                                     | Action                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Build under a new fingerprint fails      | Job phase `abandoned`, generation `failed` via the existing `failGeneration`, fingerprint queued for orphan cleanup.    |
| Build under the active fingerprint fails | Job phase `abandoned`. No vector is deleted. Its inserted vectors are valid coverage of the active index and remain.    |
| Build abandoned after activation         | Not possible. A job reaching `done` is the precondition for activation, and activation is a separate reviewed mutation. |

A partial build under a new fingerprint is unreachable by construction, so
abandoning it is bookkeeping plus deferred cleanup. It never needs a rollback
of reader-visible state.

## 4. Historical generation cleanup

Retention rule:

| Class                                                           | Retention                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vectors of the active fingerprint                               | Kept.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Vectors of the most recently retired fingerprint                | Kept as the rollback artifact until a newer retirement replaces it.                                                                                                                                                                                                                                                                                                                                                |
| Vectors of any older fingerprint                                | Deleted in pages.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Vectors whose target row is `retired`                           | Deleted in pages, in any fingerprint.                                                                                                                                                                                                                                                                                                                                                                              |
| Vectors whose `inputHash` no longer matches an eligible target  | Deleted in pages, in any fingerprint. A backstop only: I11 removes these at re-embed time, so a row in this class means the bookkeeping failed and the audit should have flagged it.                                                                                                                                                                                                                               |
| Vectors of the active fingerprint outside the active generation | Deleted in pages. Added after P2-6d measured the cost on production: I11 binds from the moment it lands and cannot reach a row an earlier generation already wrote, so a space built twice under one fingerprint returns two rows per target and halves the distinct targets a fixed candidate budget yields. `deleteNonActiveGenerationVectors` is the operator page for it and lands ahead of the rest of P2-6e. |
| `embeddingGenerations` and `embeddingProfiles` rows             | Never deleted.                                                                                                                                                                                                                                                                                                                                                                                                     |

Generation and profile rows stay forever. They are small, and the embedding
contract requires that cleanup preserve profile-use evidence: the legacy
baseline copy path refuses a space whose generation history contains a
non-baseline profile, and deleting that history would silently unblock it.

Deletion runs 128 rows per mutation under a cleanup job row with its own cursor,
the same compare-and-set resume as section 2.3.

Evidence that cleanup never touches the active generation:

1. The job records the active fingerprint at start. Every page re-reads the
   space state inside its own transaction and aborts the job if it changed.
2. Every page asserts, per row, that the row's fingerprint is neither the active
   nor the retained one. The assertion reads the state row, not a job argument,
   so a stale argument cannot authorize a delete.
3. Covered counters for the active fingerprint are recorded before the run and
   asserted unchanged after it.
4. The cleanup safety test in section 7 seeds three fingerprints and asserts
   that the active and retained row sets are byte-identical before and after.

## 5. Migration from the current state

Production has one active generation of 180 targets: 17 thoughts and 163 chunks,
built by the fixed-target profile-transition driver under the weighted large
profile.

| Step | Action                                                                                                                                                    | Reversible                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1    | Deploy the schema: new tables, new optional fields, the `scopeV2` filter field. No behavior change.                                                       | Yes                         |
| 2    | Run the paged target backfill. It seeds `embeddingTargets` and the counters from the existing eligible set. Dry run first.                                | Yes                         |
| 3    | Run the paged `scopeV2` backfill over the 180 vector rows. `searchScope` is untouched.                                                                    | Yes                         |
| 4    | Run the coverage audit. It must report 17 thoughts and 163 chunks covered, zero drift.                                                                    | Yes                         |
| 5    | Set `scopeVersion: 2` on the space state. Readers switch filter field on that row, not on an environment variable, so the switch is per space and atomic. | Yes, by resetting the field |
| 6    | Rerun the frozen scorer on the same 180-target corpus. The score must not move.                                                                           | n/a                         |
| 7    | Build the first incremental generation: same fingerprint, all 180 targets reused by content address, new chunks embedded as they publish.                 | n/a                         |

Step 7 does no provider work for the existing 180 targets. Their `inputHash`
values are unchanged and their fingerprint is the active one, so I3 applies.

Amended by P2-6d: run step 3 before step 2. The reader switched to `scopeV2`
unconditionally and reports an unseeded space as failed closed, so the window
that matters is the one where a space is counted but its existing vector rows
carry no `scopeV2`. Backfilling `scopeV2` first closes it, and the two steps
are independent: step 3 writes only the `scopeV2` field on vector rows and step
2 writes only target rows and counters. Every vector written after P2-6ab
already carries `scopeV2`, so no new gap opens between them. The per-space
`scopeVersion` switch of step 5 is not built; the fail-closed counter check is
what gates a space instead, and it is reversible by clearing the counters.

What the transition driver's artifacts no longer guarantee:

| Artifact                                                     | What it guaranteed                                          | After this change                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Staged small-profile rollback generation                     | A complete, activatable rollback index                      | Complete only for the 180-target era. After any growth it is not activatable and must be rebuilt. The pilot plan already says it would be regenerated fresh. |
| `manifestHash` on historical generations                     | A whole-space snapshot comparable at staging and activation | Audit evidence only. It is not recomputable once the single-transaction scan is gone.                                                                        |
| `expectedThoughtCount`, `expectedChunkCount`                 | Derived by one transaction from the whole space             | Accurate for their era, not replayable. Live counts come from the counters.                                                                                  |
| Whole-space manifest recomputation at staging and activation | Equality of a recomputed hash                               | Replaced by I5. Equality of a hash over 50,000 targets cannot be computed in one transaction.                                                                |
| Legacy baseline copy path                                    | Available where history is baseline-only                    | Already permanently blocked for this space by the large profile, and cleanup must keep generation rows so the block check keeps its evidence.                |

## 6. Stats without full scans, P1-12 overlap

`get_stats` loads up to 10,000 thought rows per space today. Each thought row
carries the legacy 1,536-float `embedding` field, so a row costs about 12.5 KiB
and the 16 MiB read budget binds at roughly 1,300 rows, well before the declared
10,000-row bound. The declared bound is not the real one.

| Value                                  | Source after this change                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| Total, historical and retracted counts | Counters on the space state, maintained under I4.                                     |
| Index coverage per space               | `eligible` and `covered` counters plus `lastAuditAt`, one row read.                   |
| `list_spaces` coverage labels          | One space-state read per space. No vector read.                                       |
| `byType`, `topTopics`, `topPeople`     | A stored digest refreshed by a bounded resumable job, returned with its `computedAt`. |

No stats path reads `embeddingVectors`, and no stats path reads a thought row
for counting. Drift is a first-class value: the audit job recomputes counters in
pages and records the result, and a drift flag is reported rather than hidden.

The counters are one row per space, written by every ingestion mutation. That is
a write-conflict hotspot under a bulk backfill. Ingestion is serial per space
today, so the plan starts unsharded and records the ceiling: if optimistic
concurrency retries appear in the growth test, split the counters into a small
fixed number of shards summed on read. Sharding is not built before it is
needed.

As implemented in P2-6f:

| Detail                  | Decision                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which counters          | The current total is `eligibleCounts.thought`, because a thought target is eligible exactly when its thought is lifecycle-current. Only the superseded and retracted buckets needed a counter of their own. |
| Where they are seeded   | The scan phase, which already visits every thought in the space once. A space counted before P2-6f keeps the bounded scan until its next backfill scan seeds the historical buckets.                        |
| What the total means    | Lifecycle-current memories. A counter cannot apply a business-time validity window, which no write touches, so a scheduled or lapsed memory now counts toward the total.                                    |
| The remaining scan      | The digest only, bounded at 128 thought rows on a counted space, reported as `partial` when the bound binds rather than failing the read. P1-12 replaces it.                                                |
| Convex has no row count | There is no index-only count and no projection: any read of a thought row loads its legacy vector. A counter is the only bounded means, so unseeded spaces keep the legacy bounded scan until P2-6g.        |

## 7. Test plan

| Test                       | Setup                                                                  | Assertion                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pilot growth               | Synthetic space grown 256, 1,000, 5,000 targets                        | Every phase completes. No transaction exceeds its page bound. Counters equal a recomputed audit. Wall time and page count recorded.                                                                                                                                                         |
| Resume after crash         | Stop scheduling between pages at each phase boundary                   | Rerun reaches the same final state. Replaying a page with a stale cursor writes nothing. Replaying with the current cursor changes no row.                                                                                                                                                  |
| Activation atomicity       | Reader loop during a profile flip                                      | No result ever carries a fingerprint other than the one the reader read. No mixed result. Degradation to keyword is allowed.                                                                                                                                                                |
| Single row per target, I11 | A target re-embedded after its content changes, repeated several times | Exactly one row per `(space, fingerprint, kind, targetId)` after every re-embed. A vector search for the old text returns no stale row. Covered counters unchanged across the swap. Between the content change and the re-embed, I7 drops the stale row and coverage reports the shortfall. |
| Cleanup safety             | Three fingerprints: active, retained, old                              | Active and retained row sets identical before and after. Covered counters unchanged. An active-fingerprint change mid-run aborts the job.                                                                                                                                                   |
| Retrieval gate             | Frozen scorer, same 180-target corpus, after migration                 | Score does not move from 17/18 and MRR 0.758. Any movement blocks the migration.                                                                                                                                                                                                            |

Public tests use synthetic fixtures only. The growth test stays at 5,000 targets
even though the first backfill is smaller, because a test at the size of the
first batch would prove nothing about headroom. Extrapolation from 5,000 to
50,000 is arithmetic over constant page sizes, not a measured result. The growth
test runs against a development deployment, never production.

## 8. Implementation split

Each row is one reviewed PR and one tier 2 task. `scopeV2` is a space-isolation
boundary, so the schema and reader PRs require a second-model review before
merge.

| Order | PR                                                  | Acceptance line                                                                                                                                                                          |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | P2-6ab Target table, counters and resumable builder | Counters equal a recomputed scan on synthetic fixtures. A 5,000-target synthetic build completes across pages. Crash-resume and stale-cursor tests pass. `scopeV2` exists and is unused. |
| 2     | P2-6c Incremental admission                         | Publishing one document does work proportional to that document at 5,000 targets. No whole-space scan remains in an eligibility write.                                                   |
| 3     | P2-6d Reader cutover and coverage semantics         | Activation atomicity test passes. The I11 single-row test passes. Frozen scorer unchanged on the 180-target corpus.                                                                      |
| 4     | P2-6f Stats from counters                           | `get_stats` and `list_spaces` on a 5,000-target synthetic space read no vector row and no thought row for counting.                                                                      |
| 5     | P2-6g Production migration                          | Steps 1 to 7 of section 5 executed development-first. The 180-target audit passes and the frozen score does not move.                                                                    |
| Later | P2-6e Retention and cleanup                         | Cleanup safety test passes. Generation and profile rows are never deleted.                                                                                                               |

I11 lands no later than P2-6d. It may land earlier with the insert path, but it
must not land after the first reader reads `scopeV2`, or a superseded vector is
searchable for the length of one PR.

Order is strict. P2-6c depends on the counters and the builder from P2-6ab.
P2-6d must not land before P2-6c, or readers would see a coverage number that
nothing maintains.

### 8.1 What the card-model scale changes

The first backfill is low thousands of targets rather than tens of thousands.
That changes page counts and urgency. It does not change any invariant, because
the design ceiling stays at 50,000.

| Item                                          | At low thousands                                                                                                                                          | Verdict                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Single-transaction manifest                   | 2,000 targets at ~2 KiB of text is ~4 MiB, inside the 16 MiB read budget, but the 256-target constant binds first and a chunk-bearing space is far larger | Still must be paged               |
| Whole-space derive on every eligibility write | Runs on every publish and every capture, so it pays the full-space cost per write                                                                         | Still the first thing that breaks |
| Vector audit                                  | 2,000 rows is 16 pages instead of 391                                                                                                                     | Simpler, same code                |
| Storage                                       | ~49 MiB for two fingerprints instead of ~1.2 GiB                                                                                                          | Cleanup is not urgent             |
| Full rebuild for a profile change             | 63 provider requests instead of 1,563                                                                                                                     | Rollback by rebuild is now cheap  |
| Counter contention                            | Low thousands of writes over a backfill                                                                                                                   | Sharding stays unbuilt            |
| Recall at a 32-candidate budget               | One or two targets per document rather than tens                                                                                                          | Better, still unmeasured          |

Merged and deferred work:

| Change                                      | Reason                                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-6a and P2-6b merge into P2-6ab           | The builder is a cursor and a page mutation over the table the same PR introduces. Splitting them means reviewing a table with no writer. Keep them split only if the merged diff stops being reviewable in one sitting.              |
| P2-6e defers until after the first backfill | Two retained fingerprints cost about 49 MiB at this scale. Cleanup earns its review time only after a second profile transition or a measured storage concern. Until it lands, no cleanup path exists at all, which is the safe half. |
| P2-6f shrinks                               | The counters arrive with P2-6ab. The remaining work is reporting them and not reading thought rows for counting. The `byType`, `topTopics` and `topPeople` digest defers to P1-12, where it belongs.                                  |
| P2-6c, P2-6d, P2-6g unchanged               | The eligibility-write scan, the reader cutover and the migration are all required before any backfill of any size.                                                                                                                    |

Nothing here is deleted from the design. Deferred work keeps its acceptance line
and its row in the tracker.

### Migration commands

Run against the development deployment first, then with `--prod`. Record the
exact command in the owner tracker. Deployment names and space ids stay out of
this file.

```
npx convex run models/embeddings/migrations:startTargetBackfill '{"spaceId":"<SPACE_ID>","dryRun":true}'
npx convex run models/embeddings/migrations:runTargetBackfillPage '{"jobId":"<JOB_ID>","cursor":null,"batchSize":128}'
npx convex run models/embeddings/migrations:backfillVectorScopeV2 '{"spaceId":"<SPACE_ID>","cursor":null,"batchSize":64}'
npx convex run models/embeddings/migrations:auditSpaceCoverage '{"spaceId":"<SPACE_ID>"}'
npx convex run models/embeddings/migrations:setSpaceScopeVersion '{"spaceId":"<SPACE_ID>","scopeVersion":2,"expectedScopeVersion":1}'
```

Each page command returns the next cursor and is rerun until it reports done.
The audit is rerun after every step. `setSpaceScopeVersion` takes the expected
current value so a concurrent change cannot be overwritten.

## 9. Where the code and the plans disagree

| Statement                                                                                                                                 | Which is right                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The embedding contract said the manifest is bounded at 128 targets and the thought scan stops after 128 rows. The code uses 256 for both. | The code. The contract paragraph was stale and is corrected to 256 in this change; the pilot evaluation already recorded 256. P2-6ab replaces the paragraph when it raises the bounds. |
| The contract says staging and activation recompute the manifest and compare its hash.                                                     | The contract is right today and wrong at the target scale. A hash over 50,000 targets cannot be computed in one transaction. I5 replaces it deliberately.                              |
| The contract says a space with incomplete chunk coverage reports semantic retrieval unavailable for the whole request.                    | The architecture is right. Section 5.1 already requires labeled incomplete semantic results rather than hidden records. Chunk coverage becomes a reported ratio.                       |
| `bumpEmbeddingEligibilityEpoch` derives the whole-space manifest on every eligibility write.                                              | Correct today, unscalable. One publication would scan the space. P2-6c replaces it with per-target marking and counter deltas.                                                         |
| The capacity plan says resumable manifest construction and historical cleanup remain P2-6 work.                                           | Consistent. This plan is that work.                                                                                                                                                    |

## 10. Unconfirmed limits and open questions

| Item                                                                      | State                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Maximum vectors in one Convex vector index                                | Not documented. The docs claim support for millions of vectors with no stated cap. Treat 50,000 as unproven until the growth test measures it. |
| Latency or availability while a vector index backfills a new filter field | Not documented. Step 3 of the migration is run development-first and the audit is rerun before the reader switch.                              |
| `.paginate()` inside a mutation                                           | Used in this repository already, not described in the pagination documentation. The compare-and-set cursor guard is required because of that.  |
| Limit on pending scheduled functions                                      | Not documented. The design schedules one successor at a time, so at most one pending job per space.                                            |
| Recall at 50,000 targets with a 32-candidate budget                       | Open. A capacity plan cannot answer it. It needs a new frozen evaluation after the corpus grows.                                               |

## 11. Open decisions

Three choices in this plan are judgment calls rather than consequences of a
documented limit. Each is stated as alternatives with a recommendation. The
card-model scale weakens the case for the first one and leaves the other two
unchanged.

### D1. Does the vector search filter keep the generation id?

| Option                                         | Cost of a new generation                                                                                               | Reader guarantee                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A. Keep the generation in the filter           | Copy every reused row: ~244 MiB at 20,000 targets, ~610 MiB at 50,000, and double storage while both generations exist | Filter-enforced. A reader physically cannot see two generations.                                            |
| B. Drop it, content-address the row (accepted) | Zero for unchanged targets                                                                                             | Invariant-enforced. Fingerprint in the filter, one row per target under I11, plus the I7 hydration recheck. |

Recommendation: B, accepted in review. Cost proportional to the delta was the
requirement that opened this task, and A does not meet it at any scale. The card
model makes A survivable, not correct: A still pays 625 rows of copying to admit
one new document. The honest cost of B is that atomicity moves from the storage
engine into I2, I6, I7 and I11, so those four invariants need the second-model
review and a direct test, which section 7 specifies. Review added I11: without
it, B keeps a superseded vector searchable until cleanup runs, and a dropped
candidate cannot be recovered by a later recheck.

### D2. Completeness by counters or by a recomputed manifest hash?

| Option                                                   | Works at scale                                                                                                                  | Detects a bug in its own bookkeeping           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A. Recompute and compare a hash                          | No. A hash over the whole space cannot be computed in one transaction above roughly 1,300 vector rows of the 16 MiB read budget | Yes, by construction                           |
| B. Transactional counters plus a bounded audit (planned) | Yes                                                                                                                             | Only at audit time, and only if the audit runs |

Recommendation: B, accepted in review, with the audit treated as a required part
of the design rather than an operational nicety. A is strictly safer and simply
cannot exist above a few thousand targets. The mitigation is that the audit is
paged, runs on a schedule, and reports a drift flag that section 6 surfaces
instead of hiding. The named upgrade path, kept open by review, is a per-page
hash chain over the target table: it costs a rolling hash write per page and
detects manifest tampering, but still cannot validate vector presence in one
transaction. Build it if the audit ever reports drift it cannot explain.

### D3. Is incomplete chunk coverage fatal or reported?

| Option                                          | Behavior when one target of many is unembedded                  | Risk                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| A. Fatal, as the embedding contract says today  | Semantic retrieval unavailable for the whole space              | One new document silently disables semantic search            |
| B. Reported, as the architecture says (planned) | Semantic retrieval continues, the response labels the shortfall | A caller that ignores the label over-trusts a partial ranking |

Recommendation: B for chunk and card targets, A retained for thought targets.
Accepted in review on that split.
Architecture section 5.1 already requires labeled incomplete semantic results,
and narrative capture depends on a complete thought index for duplicate
detection, so the split follows what each consumer actually needs. The residual
risk in B is a reader that ignores the label; the existing `vectorStatus` and
`partial` fields already carry that contract, so no new reader concept is
introduced.

## Verification

Run `pnpm lint`, `pnpm check-types`, `pnpm test:once` and `pnpm build` for every
implementation PR. Run the frozen scorer before and after the production
migration on the unchanged 180-target corpus. Keep owner paths, space ids and
document descriptions out of this repository.
