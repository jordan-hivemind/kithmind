# PostgreSQL document publication proof

Status: isolated prototype. This package does not replace the deployed backend
or the finance archive.

The package it lives in is now `@repo/kith-store`, renamed from
`@repo/postgres-proof` by P2-39a, which grew it into the foundation the
[consolidation plan](plans/2026-09-12-postgres-consolidation.md) ports onto: the
`kith` schema bootstrap and migration runner over `kith.schema_version`, the id
convention, the pool, the transaction helper and the space predicate. The
lifecycle proof described below is unchanged. The CI job that runs it is still
named `postgres-proof`.

## Scope

`@repo/kith-store` exercises one bounded document lifecycle against a real
PostgreSQL 18 server. It demonstrates:

- opaque API-key authentication by a stored SHA-256 digest and an immediate
  revocation check;
- application-layer space scoping on every operation;
- staged document generations and one-transaction activation;
- immutable request receipts for stage, activation and forget retries;
- page-local evidence with SHA-256 text and quote hashes and Unicode-codepoint
  offsets;
- retrieval of the active generation and authorized historical citations after
  correction;
- a stale-generation fence, correction, forgetting and transaction rollback;
- an explicitly synthetic financial attachment using validated decimal strings
  and PostgreSQL `numeric`, including the exact fixture total `0.1 + 0.2 = 0.3`;
- an encrypted `pg_dump` round trip into a second isolated database with the
  retained citation, forgotten state and revoked key preserved;
- database-clock worker leases with atomic claims, opaque token hashes and
  increasing fence epochs, bounded expired-lease reclaim, and immutable
  idempotent enqueue and completion handling;
- recovery after the operating system kills a worker subprocess after its
  claim commits, including rejection of stale, cross-space and revoked clients.

The financial attachment is a cross-domain fixture. It is not a ledger,
financial importer, reconciliation model, or proof of financial query coverage.

## Boundaries

The durable schema starts in
[`001_init.sql`](../packages/kith-store/migrations/001_init.sql), with worker
state added by
[`002_worker_jobs.sql`](../packages/kith-store/migrations/002_worker_jobs.sql).
The database owner applies migrations and manages spaces and API-key lifecycle.
The application role is a non-owner without role or database creation
privileges. It receives read access plus write access only to document content,
request receipts and worker jobs. SQL identifiers are accepted only through a
strict role-name validator; data queries are parameterized.

The prototype API authenticates first, obtains one `space_id`, and includes it
in every subsequent join and mutation. The application database credential is
a trusted server credential and must never be exposed to a browser, MCP client,
or other untrusted SQL caller. This prototype does not yet add PostgreSQL row
level security, so direct arbitrary SQL through that role is not a tenant
boundary. Production adoption requires either a similarly closed service
surface or database-enforced scoping.

Each API transaction uses one checked-out `pg` client, `SERIALIZABLE` isolation,
a five-second statement and idle-transaction timeout, and a two-second lock
timeout. Activation locks the generation and document, rejects any generation
older than the latest staged source revision, supersedes the previous active
generation, and advances the document pointer in the same transaction. The
schema also requires that the active generation belong to that exact document
and space.

Input validation is closed and bounded. A stage request is at most 4 MiB, with
at most 64 pages, 256 evidence spans, 256 chunks and 256 synthetic financial
attachments. Page and citation hashes are recomputed. Citation ranges use
Unicode codepoints, must be nonempty and within the page, and each searchable
chunk must be an exact substring of its source page and contain its linked quote.
Decimal input uses the shared finance contract's 38-significant-digit,
18-decimal-place rules and rejects exponent, non-finite, over-precision and
noncanonical forms before SQL execution. Currency uses the same closed registry.
The database repeats the finite, magnitude, precision and scale bounds without
coercing values to a fixed-scale type.

## Worker recovery proof

Migration 2 adds a space-scoped `worker_jobs` table. Migration files are inputs
to `applyProofMigration`; they are not standalone commands. The runner holds a
transaction-scoped advisory lock, verifies that recorded versions are exactly
contiguous, applies only the next version, records it in the same transaction,
and refuses gaps or future versions. The integration test exercises both an
existing version 1 upgrade and a repeat version 2 invocation.

Enqueue stores a canonical request digest under a unique space and request ID.
An exact concurrent retry resolves to one job ID; reuse with changed work input
fails. Claim first expires at most 25 exhausted jobs in the authenticated space,
then uses `FOR UPDATE SKIP LOCKED` to select at most one queued or expired job.
It increments the attempt counter and fence epoch and sets expiry from
`clock_timestamp()`. Lease duration is 1 through 300 seconds and attempts are 1
through 5. The caller receives a random 256-bit token; PostgreSQL stores only
its SHA-256 digest.

Completion first locks the exact job row, then evaluates the lease against a
fresh database clock. It requires the authenticated space and API-key owner,
token digest, fence epoch, running state, and unexpired lease. This ordering
also rejects completion that began before expiry but waited behind a row lock
until afterward. A committed completion records only a bounded output digest
and returns the actual `succeeded` job state. Its exact retry returns the same
state with `reused: true`, after authentication and revocation are checked
again. When the attempt limit is reached, the next bounded claim pass marks the
expired job `failed` with `attempts_exhausted`.

The recovery test forks a separate Node process. The child commits a claim and
reports it over IPC while remaining alive; the parent sends `SIGKILL` and waits
for the operating system exit before attempting recovery. Concurrent claimers
cannot take the live lease. After PostgreSQL's clock reaches expiry, exactly one
claimer receives a new epoch and the abandoned token cannot complete. Completed
and failed jobs survive the encrypted dump and restore with identical state.

Jobs in this slice carry an opaque synthetic work key and input/output digests.
They have no document foreign key, do not activate a document generation, and
are not coupled to document forgetting. There is no heartbeat or lease renewal,
delayed retry/backoff scheduler, worker capability routing, or background sweep;
expired work is reconciled only by a later claim in the same space. These are
deliberate remaining integration gates.

## Embedding and full-text search (P2-39g1)

Migration 015 adds the retrieval indexes section 2.7 of the
[consolidation plan](plans/2026-09-12-postgres-consolidation.md) specifies, and
`packages/kith-store/src/embeddings/` adds the legs that read them.

| Object                                                       | Purpose                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `CREATE EXTENSION vector` in `public`                        | pgvector, verified as a step rather than assumed. The migration fails loudly if it is absent or in another schema. |
| `kith.embedding_vectors.embedding vector(1536)`              | Dropped and re-added from `jsonb`. Section 5.2 does not migrate vector rows, so the table is empty on every target and nothing is rounded in place. |
| `embedding_vectors_scope_idx`                                | `(space_id, embedding_fingerprint, target_kind)`, the replacement for Convex's `scopeV2` filter field. |
| `embedding_vectors_generation_{thought,chunk,event}_idx`     | Convex's `by_generation_and_*` per-target lookups.                                        |
| `thoughts.content_search`, `facts.search_text_search`        | Generated stored `tsvector('english')` with GIN, named after their source columns like `chunks.text_search`. |

Four decisions the plan left open are settled in the migration header and
repeated here.

| Decision              | Choice                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension schema      | `public`, with every reference in code qualified (`public.vector`, `OPERATOR(public.<=>)`). `withKithTransaction` pins `search_path` to `kith` alone, so an unqualified name would not resolve. The writer role is granted `USAGE ON SCHEMA public` for the same reason it is granted the domains. |
| `real[]` fallback     | Deferred, not implemented. The hosted provider ships pgvector on every plan and CI now runs a pgvector image, so a second untested cosine path would be a claim of a known-good degraded mode that nothing exercises. |
| `scope_v2`            | Kept. It is no longer a filter, but the ported resolvers still recompute it from the row's own space, fingerprint and kind and drop a row that disagrees. Dropping the column would delete that check. |
| Vector index          | None. At the pilot's 180 active targets an exact scan behind the scope predicate is correct. HNSW is added when a space passes about 2,000 targets.  |

`test/embeddingSearch.test.mjs` proves the schema objects exist, that both
keyword legs stem and neither crosses a space, that vector candidates order by
cosine similarity with hand-built 1536-dimension vectors, that an identical
vector in another space or under another fingerprint never appears, that an
out-of-scope, retired or stale-generation candidate is dropped, that the
hybrid fusion matches a hand-computed reciprocal rank, that `vectorStatus`
reports "unavailable" on a fingerprint mismatch and on a provider failure
while keyword results still return, and that a 1535-dimension or non-finite
vector is refused before any statement is sent.

This is not ranking parity. Section 4.2 of the consolidation plan owns that
gate with its frozen question set, and it remains owed.

### The write side (P2-39g2)

Migration 016 and six more files in `packages/kith-store/src/embeddings/` add
the half that fills the index g1 reads: generations, profiles, target rows,
counters, the paged build, the provider fill, and the memory writes that keep
eligibility in step. The design is
[the index-capacity plan](plans/2026-09-12-index-capacity.md); the PostgreSQL
translation is sections 2.3 and 2.4 of the consolidation plan.

| Object                                                     | Purpose                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `embedding_profiles_fingerprint_key`                       | One profile row per fingerprint. A second is a collision or damage, never a tiebreak.                        |
| `space_embedding_states_space_idx`, now UNIQUE             | One state row per space. It is the row every reader derives its filter from, and two writers upsert it.       |
| `embedding_targets_space_kind_target_idx`, now UNIQUE      | `(space_id, target_kind, target_id)` is the target's identity and the key every upsert lands on.             |
| `embedding_targets_owed_idx`                               | Partial, `WHERE state = 'eligible' AND covered_fingerprint IS NULL`. The owed set is this index page.         |
| `embedding_generations` state CHECK, `(space_id, state)`   | The six states, and the lookups that refuse a second staging or staged generation.                           |
| `embedding_build_jobs` phase CHECK, terminal-cursor CHECK  | The five phases, and the rule that a `done` or `abandoned` job keeps no cursor for anything to resume.       |
| `embedding_targets_retired_coverage_check`                 | I4 as a constraint: a retired target covers nothing.                                                          |
| `thoughts_space_created_idx` and its chunk and event peers | The ascending `(created_at, id)` keysets the scan stages page over.                                           |

Four more decisions the plan left open are settled in the migration header.

| Decision                     | Choice                                                                                                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State row uniqueness         | UNIQUE. g1 left it plain so the read could report a duplicate as a fault. `SERIALIZABLE` would abort a concurrent second insert anyway, but that is a property of one isolation level rather than of the schema. The `LIMIT 2` fault path stays in code and becomes unreachable. |
| `numeric` counter columns    | Not retyped. `@repo/kith-migrate` renders a Convex number with `String(value)` and constrains nothing, so retyping would move a validation into a `COPY` that cannot say which row it refused. The domain is stated as CHECK constraints instead, which hold on every write. |
| Profile column nullability   | Only `fingerprint` is NOT NULL. `profileFromRow` already fails closed on a missing descriptive column, and the worker publish path legitimately writes a fingerprint-only row because it reads nothing else from a profile.            |
| Cursor encoding              | `JSON.stringify([stage, keyset])`, with `created_at` carried as `created_at::text` rather than the `Date` node-pg rounds to milliseconds. A rounded microsecond timestamp would repeat a row forever or skip its neighbours, silently. |

What the write side does, and where:

| Module           | What it owns                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `state.ts`       | The space state row, the profile row, the counter deltas (I4), and the per-space coverage a `list_spaces` row reports. |
| `eligibility.ts` | Target upsert and retire, the coverage marker, and the per-write touch for thoughts, chunks and cards.          |
| `write.ts`       | Vector insert, reuse, replace (I11) and delete, each with the coverage bookkeeping it owes.                     |
| `generations.ts` | The profile-transition lifecycle: create, stage vectors, stage, activate, fail.                                 |
| `build.ts`       | The paged scan, fill and audit with keyset cursors, plus `auditEmbeddingCounters` and the duplicate probe.      |
| `fill.ts`        | The owed page, the idempotent commit, and the driver that runs pages until nothing is owed.                     |

Three differences from the Convex originals are deliberate.

1. No scheduler. Convex's fill commit scheduled its own successor inside its
   transaction. `runEmbeddingFill` is a plain async driver instead, and each
   page is its own `withKithTransaction`. The daemon that calls it on a
   schedule is separate work.
2. The provider is injected. The driver takes an embedder rather than reaching
   for a Convex action, so a test needs no network and no transaction is held
   open across an HTTP call.
3. `captureThought` and `transitionMemory` never write a vector. They mark
   eligibility, bump the epoch, and delete a superseded memory's active
   vectors, which is where `_insertOne` and `_transitionMemory` made those same
   three calls. Their fourth and fifth calls, the inline vector insert and its
   completeness check, have no PostgreSQL branch: one ported mutation is one
   `SERIALIZABLE` transaction on one checked-out client, and holding that open
   across a provider call is not something a capture may do. The new thought is
   an owed target and the fill covers it, which is section 3.1's incremental
   admission. I9 still holds, because a covered-versus-eligible shortfall is
   exactly what makes `getActiveEmbeddingTarget` report `thoughtStatus:
   "unavailable"`.

`test/embeddingLifecycle.test.mjs`, `test/embeddingBuild.test.mjs` and
`test/embeddingFill.test.mjs` prove, against a real server: that ensuring a
profile is idempotent and a fingerprint names one row; that a generation is
created, filled, staged and activated, that a second activation retires the
first and leaves exactly one active, and that the read side sees the new one;
that a manifest whose epoch moved refuses to stage and a failed generation
keeps its evidence and cannot activate; that capturing a thought creates an
eligible, owed target and bumps the epoch, and that a superseding transition
retires the old target, deletes its active vector and counts the superseded
bucket; that `setCoreStatus` spends no epoch because it changes no
eligibility; that a build over a space of more than one page per kind pages
through every stage, that a page whose cursor is not the stored one is refused
with the stored cursor and writes nothing, and that replaying the current
cursor changes no row; that the counters after a full build equal an
independent recount, and still do after a converging rerun and a target-policy
flip; that the audit names a counter mismatch and a duplicate row separately
and that a repair fixes only the counters; that the fill covers only owed
targets, skips a target whose live text hash has moved, and that a replayed
commit writes nothing; and that two concurrent commits of the same page
converge on one vector per target with counters that still match a recount.

The chunk and card retrieval leg gained the isolation control it was missing:
an identical nearest-possible chunk vector and card vector in another space,
and the same pair in this space under a retired fingerprint, none of which ever
appears in `chunkIds` or `cardHits`. The thought leg already had that control;
this is the same proof for the other two kinds.

Which Convex `migrations.ts` functions were ported, and which were not:

| Function                                                                                      | Ported | Why                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `startTargetBackfill`, `runTargetBackfillPage`, `abandonTargetBackfill`                       | Yes    | A fresh PostgreSQL space needs them to seed its counters and target rows at all. They are `startEmbeddingBuild`, `runEmbeddingBuildPage` and `abandonEmbeddingBuild`. |
| `auditSpaceCoverage`                                                                          | Yes    | The recount an operator runs after any step, as `auditEmbeddingCounters`.                                             |
| `prepareBaselineGeneration`, `backfillBaselineThoughtVectors`, `stageBaselineGeneration`, `activateBaselineGeneration`, `auditBaselineGeneration`, `ensureBaselineProfileAndState` | No | A one-time copy of a legacy `thoughts.embedding` field into vector rows. Section 5.1 exports that field to a cold audit file and does not create a column for it, so there is nothing to copy from. |
| `backfillVectorScopeV2`                                                                       | No     | Backfills `scope_v2` onto rows written before it existed. Vector rows are not migrated, and every row this code writes carries it. |
| `deleteNonActiveGenerationVectors`, `cleanupEmbeddingGenerations`                             | No     | Retention and cleanup, which the capacity plan defers past the first backfill (P2-6e). Nothing here deletes a historical generation's rows. |
| `setChunkEmbeddingOptIn`, `setSpaceTargetPolicy`                                              | No     | Operator switches over columns this slice reads and constrains but does not need a writer for. The policy's effect is proven by a test that sets the column directly. |

## Source accounts for the settings page (P2-39i)

`packages/kith-store/src/sources/model.ts` ports `models/sourceAccounts/public.ts`'s
`create`, `update` and `list`, the row
[the web/MCP surface plan](plans/2026-09-16-web-mcp-postgres-surface.md) section 1.5
and question 1 of section 8 asked for: the settings page's owner-facing editor for
`kith.source_accounts`, which `008_worker_protocol.sql` already migrates rows into
but leaves without a UNIQUE index. `create` therefore enforces
`(space_id, connector, account_id)` uniqueness with a `SELECT ... LIMIT 2` count
check rather than a constraint, `update` writes only the fields it was given
through `COALESCE`, and both route through `resolveWriteSpace` and
`requireSpaceAccess` exactly as `../identity/apiKeys.ts` does, so a cross-space
write and a missing row are refused with the same non-enumerating message. Two
Convex side effects on `update` -- `advanceSourceAssessmentEpoch` and
`onSourceEnabledChanged`, both fired only when `enabled` changes -- are not
ported here: they reach into the worker-diagnostics and ingestion-assessment
domains, which are separate, concurrently developed PostgreSQL work, and neither
Convex test for `sourceAccounts/public.ts` exercises them. `test/sourceAccounts.test.mjs`
proves create-then-list returns the Convex fields including the default and an
explicit freshness, that a duplicate `(space, connector, account)` is refused,
that update changes only the field it was given, that a stranger, a
read-only member and an unknown id are all refused "Source account not found",
that the same malformed connector, account id, name and freshness Convex
refused are refused here, and that list is space-isolated, empty rather than an
error for a principal with no readable space, and refused past the 100-row
bound Convex enforced.

## Verification

The default repository test remains independent of Docker:

```sh
pnpm --filter @repo/kith-store test:once
```

P2-39a added a schema suite to it that does need a server. It skips cleanly when
`KITH_STORE_DATABASE_URL` is unset, creates and drops its own throwaway database
when it is set, and fails to load rather than skipping when
`KITH_STORE_REQUIRE_DATABASE=1` says a server was supposed to be there. CI sets
both on the `verify` job, beside the archive's own pair.

The explicit integration command requires Docker and fails if Docker or the
pinned image is unavailable:

```sh
pnpm --filter @repo/kith-store test:integration
```

The harness ignores ambient database URLs. It starts only randomly named,
uniquely labeled containers from the pinned PostgreSQL 18 image digest, publishes
PostgreSQL only on an ephemeral `127.0.0.1` port, and uses generated synthetic
passwords. PostgreSQL data lives in a bounded 512 MiB container tmpfs. The
harness checks its ownership label before stopping a container and does not
inspect, stop, or prune other databases, containers, images, or volumes.

The dump proof uses a random in-memory AES-256-GCM test key, verifies tamper
rejection, and restores into the second disposable server. This encryption is
test evidence for restore fidelity, not the production recovery-key or `age`
archive design.

Focused verification on 2026-09-08:

| Command                                           | Result                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm --filter @repo/kith-store check-types`      | Passed                                                                                  |
| `pnpm --filter @repo/kith-store test:once`        | 3 passed                                                                                |
| `pnpm --filter @repo/kith-store test:integration` | 1 passed against two real isolated PostgreSQL 18 servers, including subprocess recovery |

## Remaining parity work

This prototype does not implement OAuth/session migration, the web query layer,
the real finance adapter and ledger, production worker orchestration or
scheduling, vector or full-text ranking parity, provider archive integration,
production recovery keys, observability, or deployment. Serializable
transactions retry at most three times, but a broader API retry/backoff policy
is not defined. It does not benchmark performance. Those remain explicit gates
before choosing or cutting over to PostgreSQL.
