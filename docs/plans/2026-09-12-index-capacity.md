# Embedding index capacity and incremental generations

Date: 2026-09-12. Status: P2-6 design plan. No implementation lands with this
document.

Parent: [Phase 2 document pipeline](./2026-09-07-phase2-document-pipeline.md).
Related: [embedding contract](./2026-09-06-embedding-contract.md),
[PDF document capacity](./2026-09-07-pdf-document-capacity.md),
[pilot retrieval evaluation](./2026-09-08-pilot-retrieval-evaluation.md).

## Purpose

The semantic index is bounded at 256 targets per space, built whole-space in a
single transaction. A read-only preflight of a 108-file backfill sample
projected about 700 new chunks. The owner corpus is one to two decades of
documents. The realistic requirement is at least 50,000 targets per space, and
admitting a batch must embed only the new chunks.

This is not a constant bump. At 50,000 targets the single-page manifest scan,
the whole-space eligibility rebuild, the all-or-nothing coverage rule, the
2 MiB manifest budget and the absence of cleanup all bind. This plan describes
the design that removes each of them, the invariants that keep readers safe,
and the reviewed order of implementation.

## 1. Target scale and budgets

### 1.1 Scale targets

| Quantity                        | Today              | Design target                        |
| ------------------------------- | ------------------ | ------------------------------------ |
| Eligible targets per space      | 256                | 50,000, no code constant below that  |
| Manifest construction           | One transaction    | Paged, resumable, unbounded in total |
| Vector rows read per generation | 256                | Paged, unbounded in total            |
| Admitting a new batch           | Re-embed all       | Embed only new or changed targets    |
| Manifest byte budget            | 2 MiB per space    | Per page, not per space              |
| Retained vector generations     | All, never cleaned | Active plus one retired              |

At the sample rate of about 6.5 chunks per file, 50,000 targets is roughly
7,600 files. That is arithmetic from one sample, not a measured corpus size.

Storage arithmetic: one 1,536-dimension float64 vector is 12,288 bytes, about
12.5 KiB per row with field overhead. 50,000 rows is about 610 MiB per
fingerprint per space. Retaining two fingerprints is about 1.2 GiB. That number
is the reason retention is bounded in section 4.

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
| Target scan, thoughts |            64 | ~12.5 KiB legacy vector |      ~800 KiB |              0 |
| Target row upsert     |           128 | ~256 B                  |       ~32 KiB |        ~32 KiB |
| Manifest input fetch  |            32 | 8 KiB text              |      ~256 KiB |              0 |
| Vector insert         |            32 | ~12.5 KiB               |      ~400 KiB |       ~400 KiB |
| Vector audit read     |           128 | ~12.5 KiB               |      ~1.6 MiB |              0 |
| Vector delete         |           128 | ~12.5 KiB               |      ~1.6 MiB |       ~1.6 MiB |

The thought scan page is smaller because a thought row still carries the legacy
`embedding` field. That field is retained audit data under the embedding
contract; this plan does not delete it, and it is why a thought page costs more
than a chunk page.

Provider batching: 32 inputs per embeddings request, returning about 400 KiB,
well inside the 16 MiB argument limit for the mutation that stages them. Filling
50,000 targets is about 1,563 provider requests. Each scheduled action performs
at most 8 requests and then schedules its successor, so no action approaches the
10 minute Node limit and a crash loses at most 256 targets of in-flight work.
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

A vector row is identified by `(spaceId, embeddingFingerprint, targetKind,
targetId, inputHash)` and is immutable. It is no longer identified by a
generation.

The vector search scope becomes:

```
["embedding-vector-scope-v2", spaceId, fingerprint, targetKind]
```

The generation id leaves the filter value. This is the change that makes reuse
free. With the generation in the filter, reusing a vector means copying the row
into the new generation: 50,000 rows and about 610 MiB of writes per generation,
which is proportional to the space and not to the delta. With the generation
out of the filter, an unchanged target simply keeps its row and the new
generation inherits it at no cost.

The new scope is a second filter field, `scopeV2`. The existing `searchScope`
field is left in place and keeps working until every space has migrated, so the
cutover is reversible. One filter field of the 16 available is used today; two
after this change.

Space isolation is unchanged: `spaceId` is still the first discriminating
element of the filter value, the filter is still one equality comparison, and
hydration still rechecks authorization against the live space membership.

### 3.3 Invariants

| Id  | Invariant                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | A vector row is immutable and unique for `(spaceId, fingerprint, targetKind, targetId, inputHash)`.                                                                                                |
| I2  | `scopeV2` is a pure function of `(spaceId, fingerprint, targetKind)` and contains no generation identity.                                                                                          |
| I3  | A target whose `inputHash` is unchanged keeps its vector across generations of the same fingerprint. No copy, no re-embed.                                                                         |
| I4  | Eligible counters change only in the transaction that changes eligibility. Covered counters change only in the transaction that inserts or deletes a vector.                                       |
| I5  | A generation for fingerprint F is complete for a kind when `covered(F, kind) == eligible(kind)`, the drift flag is false, and the last audit watermark is at or after the last eligibility change. |
| I6  | Activation sets `activeFingerprint` and `activeEmbeddingGenerationId` in one mutation, under compare-and-set on the expected previous generation, and only when I5 holds for thoughts.             |
| I7  | Hydration rechecks the active fingerprint, the live target's content hash and the target's current eligibility. A row failing any check is dropped and never returned.                             |
| I8  | Cleanup never deletes a row whose fingerprint equals the active or retained fingerprint, checked by re-reading the space state inside each delete page.                                            |
| I9  | Narrative capture requires complete thought coverage. Chunk coverage never blocks capture.                                                                                                         |
| I10 | Incomplete chunk coverage is reported to the reader, not converted into unavailable semantic retrieval.                                                                                            |

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

| Class                                                          | Retention                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Vectors of the active fingerprint                              | Kept.                                                               |
| Vectors of the most recently retired fingerprint               | Kept as the rollback artifact until a newer retirement replaces it. |
| Vectors of any older fingerprint                               | Deleted in pages.                                                   |
| Vectors whose target row is `retired`                          | Deleted in pages, in any fingerprint.                               |
| Vectors whose `inputHash` no longer matches an eligible target | Deleted in pages, in any fingerprint.                               |
| `embeddingGenerations` and `embeddingProfiles` rows            | Never deleted.                                                      |

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

## 7. Test plan

| Test                 | Setup                                                  | Assertion                                                                                                                                  |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Pilot growth         | Synthetic space grown 256, 1,000, 5,000 targets        | Every phase completes. No transaction exceeds its page bound. Counters equal a recomputed audit. Wall time and page count recorded.        |
| Resume after crash   | Stop scheduling between pages at each phase boundary   | Rerun reaches the same final state. Replaying a page with a stale cursor writes nothing. Replaying with the current cursor changes no row. |
| Activation atomicity | Reader loop during a profile flip                      | No result ever carries a fingerprint other than the one the reader read. No mixed result. Degradation to keyword is allowed.               |
| Cleanup safety       | Three fingerprints: active, retained, old              | Active and retained row sets identical before and after. Covered counters unchanged. An active-fingerprint change mid-run aborts the job.  |
| Retrieval gate       | Frozen scorer, same 180-target corpus, after migration | Score does not move from 17/18 and MRR 0.758. Any movement blocks the migration.                                                           |

Public tests use synthetic fixtures only. The 5,000-target test demonstrates
that the paged design completes at 5,000; extrapolation to 50,000 is arithmetic
over constant page sizes, not a measured result. The growth test runs against a
development deployment, never production.

## 8. Implementation split

Each row is one reviewed PR and one tier 2 task. `scopeV2` is a space-isolation
boundary, so the schema and reader PRs require a second-model review before
merge.

| Order | PR                                          | Acceptance line                                                                                                                        |
| ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | P2-6a Target table and counters             | Counters equal a recomputed scan on synthetic fixtures. `scopeV2` exists and is unused. No behavior change.                            |
| 2     | P2-6b Resumable manifest builder            | A 5,000-target synthetic build completes across pages. Crash-resume and stale-cursor tests pass.                                       |
| 3     | P2-6c Incremental admission                 | Publishing one document does work proportional to that document at 5,000 targets. No whole-space scan remains in an eligibility write. |
| 4     | P2-6d Reader cutover and coverage semantics | Activation atomicity test passes. Frozen scorer unchanged on the 180-target corpus.                                                    |
| 5     | P2-6e Retention and cleanup                 | Cleanup safety test passes. Generation and profile rows are never deleted.                                                             |
| 6     | P2-6f Stats from counters                   | `get_stats` and `list_spaces` on a 5,000-target synthetic space read no vector row and no thought row for counting.                    |
| 7     | P2-6g Production migration                  | Steps 1 to 7 of section 5 executed development-first. The 180-target audit passes and the frozen score does not move.                  |

Order is strict. P2-6c depends on the counters from P2-6a and the builder from
P2-6b. P2-6d must not land before P2-6c, or readers would see a coverage number
that nothing maintains.

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

| Statement                                                                                                                                 | Which is right                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The embedding contract says the manifest is bounded at 128 targets and the thought scan stops after 128 rows. The code uses 256 for both. | The code. The contract paragraph is stale; the pilot evaluation already records 256. P2-6a updates the contract.                                                 |
| The contract says staging and activation recompute the manifest and compare its hash.                                                     | The contract is right today and wrong at the target scale. A hash over 50,000 targets cannot be computed in one transaction. I5 replaces it deliberately.        |
| The contract says a space with incomplete chunk coverage reports semantic retrieval unavailable for the whole request.                    | The architecture is right. Section 5.1 already requires labeled incomplete semantic results rather than hidden records. Chunk coverage becomes a reported ratio. |
| `bumpEmbeddingEligibilityEpoch` derives the whole-space manifest on every eligibility write.                                              | Correct today, unscalable. One publication would scan the space. P2-6c replaces it with per-target marking and counter deltas.                                   |
| The capacity plan says resumable manifest construction and historical cleanup remain P2-6 work.                                           | Consistent. This plan is that work.                                                                                                                              |

## 10. Unconfirmed limits and open questions

| Item                                                                      | State                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Maximum vectors in one Convex vector index                                | Not documented. The docs claim support for millions of vectors with no stated cap. Treat 50,000 as unproven until the growth test measures it. |
| Latency or availability while a vector index backfills a new filter field | Not documented. Step 3 of the migration is run development-first and the audit is rerun before the reader switch.                              |
| `.paginate()` inside a mutation                                           | Used in this repository already, not described in the pagination documentation. The compare-and-set cursor guard is required because of that.  |
| Limit on pending scheduled functions                                      | Not documented. The design schedules one successor at a time, so at most one pending job per space.                                            |
| Recall at 50,000 targets with a 32-candidate budget                       | Open. A capacity plan cannot answer it. It needs a new frozen evaluation after the corpus grows.                                               |

## Verification

Run `pnpm lint`, `pnpm check-types`, `pnpm test:once` and `pnpm build` for every
implementation PR. Run the frozen scorer before and after the production
migration on the unchanged 180-target corpus. Keep owner paths, space ids and
document descriptions out of this repository.
