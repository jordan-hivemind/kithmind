# PostgreSQL consolidation: parity proof before full migration

Date: 2026-09-12. Status: P2-39 design plan. No implementation lands with this
document.

Parent: [architecture](./2026-09-06-architecture.md).
Basis: [unified storage assessment](./2026-09-08-unified-storage-assessment.md),
which recommended one PostgreSQL database subject to a migration proof.
Related: [financial archive](./2026-09-07-financial-transaction-database.md),
[PostgreSQL document publication proof](../postgres-proof.md),
[finance read contract](./2026-09-08-finance-read-contract.md),
[index capacity](./2026-09-12-index-capacity.md),
[document cards](./2026-09-12-document-cards.md),
[dated database backups](./2026-09-08-dated-database-backups.md).

## Purpose and fixed direction

The deployment runs on two database vendors. The owner wants to pay for one. The hosted
PostgreSQL database that already holds the finance archive stays and becomes the
only database. Convex leaves.

That direction is fixed. What this plan decides is the target layout, the
sequence, the proof gates, and the honest size of the work. Three constraints
bound every choice below.

| Constraint           | Consequence                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| Pre-launch, no users | Cutover may take a maintenance window. Zero downtime is not a requirement.                       |
| Nothing may be lost  | Archives, provenance chains and retained text survive byte for byte, including their identities. |
| Auth may not weaken  | Space isolation, capability scoping, revocation and credential separation are regression gates.  |

One number sets expectations before anything else. The Convex backend is 61,606
lines of source and 39,898 lines of tests across 287 exported functions. This is
a platform port, not a connection-string change. Section 6 sizes it at about 400
agent hours. Section 7 states plainly that the money saved does not pay for
that, and what does.

## 1. Inventory of the Convex surface

Counted from the code at `ac3bac0`, not estimated.

| Surface                        | Count | Where                                                                                       |
| ------------------------------ | ----: | ------------------------------------------------------------------------------------------- |
| Tables                         |    77 | `schema.ts` plus 16 `*Tables.ts` modules plus 7 auth tables                                 |
| Secondary indexes              |   298 | Same                                                                                        |
| Full-text search indexes       |     3 | `thoughts`, `facts`, `chunks`                                                               |
| Vector indexes                 |     2 | `thoughts.by_embedding`, `embeddingVectors.by_embedding_1536`                               |
| Exported functions             |   287 | 39 query, 41 mutation, 13 action, 52 internalQuery, 128 internalMutation, 14 internalAction |
| Convex HTTP routes             |     0 | `http.ts` registers only the auth provider routes                                           |
| Cron jobs                      |     4 | `crons.ts`                                                                                  |
| Scheduled function calls       |    10 | 5 modules call `ctx.scheduler.runAfter`                                                     |
| Next.js route handlers         |    12 | `apps/web/src/app/**/route.ts`                                                              |
| MCP tools                      |    28 | `apps/web/src/lib/mcp/tools.ts`                                                             |
| Worker protocol operations     |    33 | `models/workers/mcp.ts`, one wire route                                                     |
| Web pages                      |    10 | `apps/web/src/app/**/page.tsx`                                                              |
| Files using Convex React hooks |    14 | `apps/web/src`                                                                              |

### 1.1 Row-count classes

Row counts are not read from the owner deployment. Agents do not read owner
data. Each class below is derived from the per-row cardinality in the schema
plus the two published corpus figures: the pilot holds 180 active embedding
targets, being 17 thoughts and 163 chunks, and the backfill corpus is about
10,000 files at 8,500 text-yielding documents.

| Class | Meaning                                                              | Today       | At the 10,000-file corpus |
| ----- | -------------------------------------------------------------------- | ----------- | ------------------------- |
| A     | One row per deployment, per space or per user                        | 1 to 10     | 1 to 10                   |
| B     | One row per account, credential, member, watcher or profile          | under 20    | under 100                 |
| C     | One row per source item, revision, generation, document, card or job | about 100   | 10,000 to 100,000         |
| D     | One row per page, chunk, evidence span, card field or scan entry     | about 1,000 | 100,000 to 1,000,000      |
| E     | Ephemeral, bounded by a `retireAt` or `expiresAt` sweep              | small       | small                     |

### 1.2 Tables and their PostgreSQL targets

Index column: `b` secondary indexes, `s` search, `v` vector. All target tables
live in one new `kith` schema beside `finance`, keyed by preserved text ids
(section 2.2). "Same shape" means one table, the same columns and the same
uniqueness, with Convex index tuples becoming btree indexes in the same column
order.

| Table                                  | Class | b/s/v  | PostgreSQL target                                                                                       |
| -------------------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------- |
| `users`                                | A     | 2/0/0  | `kith.users`. Same shape.                                                                               |
| `authAccounts`                         | A     | 2/0/0  | `kith.auth_accounts`. Lucia Scrypt secret copied verbatim.                                              |
| `authSessions`                         | E     | 1/0/0  | Not migrated. New `kith.sessions`, owner signs in once after cutover.                                   |
| `authRefreshTokens`                    | E     | 2/0/0  | Not migrated.                                                                                           |
| `authVerificationCodes`                | E     | 2/0/0  | Not migrated.                                                                                           |
| `authVerifiers`                        | E     | 1/0/0  | Not migrated.                                                                                           |
| `authRateLimits`                       | E     | 1/0/0  | Not migrated. Rate limit at the route.                                                                  |
| `spaces`                               | A     | 1/0/0  | `kith.spaces`. The prototype already has this table.                                                    |
| `spaceMembers`                         | B     | 4/0/0  | `kith.space_members`. Same shape.                                                                       |
| `userSpaceSettings`                    | A     | 2/0/0  | `kith.user_space_settings`. Same shape.                                                                 |
| `apiKeys`                              | B     | 6/0/0  | `kith.api_keys` plus `kith.api_key_spaces` and `kith.api_key_source_accounts` for the two grant arrays. |
| `consumedOAuthCodes`                   | E     | 3/0/0  | `kith.consumed_oauth_codes`. Not migrated, recreated empty.                                             |
| `familyInvitations`                    | B     | 5/0/0  | `kith.family_invitations`. Same shape.                                                                  |
| `sourceAccounts`                       | B     | 2/0/0  | `kith.source_accounts`. Same shape.                                                                     |
| `sourceItems`                          | C     | 3/0/0  | `kith.source_items`. Same shape, active pointers as deferrable foreign keys.                            |
| `sourceRevisions`                      | C     | 3/0/0  | `kith.source_revisions`. Prototype table, plus the real columns.                                        |
| `sourceParserArtifacts`                | C     | 5/0/0  | `kith.source_parser_artifacts`. Same shape.                                                             |
| `sourceArtifactArchiveReceipts`        | C     | 7/0/0  | `kith.source_artifact_archive_receipts`. Ids preserved, see 2.2.                                        |
| `sourceArtifactArchiveBindings`        | C     | 3/0/0  | `kith.source_artifact_archive_bindings`. Same shape.                                                    |
| `sourceArtifactDeletionAcks`           | C     | 4/0/0  | `kith.source_artifact_deletion_acks`. Same shape.                                                       |
| `sourceProviderOriginalReferences`     | C     | 4/0/0  | `kith.source_provider_original_references`. Same shape.                                                 |
| `sourceProviderOriginalBindings`       | C     | 3/0/0  | `kith.source_provider_original_bindings`. Same shape.                                                   |
| `sourceProviderOriginalDetachAcks`     | C     | 4/0/0  | `kith.source_provider_original_detach_acks`. Same shape.                                                |
| `sourceTextVersions`                   | C     | 3/0/0  | `kith.source_text_versions`. Same shape.                                                                |
| `sourcePages`                          | D     | 3/0/0  | `kith.source_pages`. Retained text, hash verified on load.                                              |
| `evidenceSpans`                        | D     | 4/0/0  | `kith.evidence_spans`. Prototype `evidence` generalized.                                                |
| `documents`                            | C     | 5/0/0  | `kith.documents`. Prototype table, plus the real columns.                                               |
| `chunks`                               | D     | 5/1/0  | `kith.chunks`. Search index becomes a `tsvector` generated column with GIN.                             |
| `processingGenerations`                | C     | 5/0/0  | `kith.processing_generations`. Prototype `generations` generalized.                                     |
| `processingGenerationPayloadManifests` | C     | 2/0/0  | `kith.processing_generation_payload_manifests`. Same shape.                                             |
| `ingestRequests`                       | C     | 4/0/0  | `kith.ingest_requests`. Same shape.                                                                     |
| `ingestJobs`                           | C     | 12/0/0 | `kith.ingest_jobs`. Prototype `worker_jobs` lease model, generalized.                                   |
| `inlineWork`                           | E     | 3/0/0  | `kith.inline_work`. Drained before cutover, not migrated.                                               |
| `ingestRateLimits`                     | E     | 1/0/0  | `kith.ingest_rate_limits`. Recreated empty.                                                             |
| `sourceFetchRequests`                  | E     | 3/0/0  | `kith.source_fetch_requests`. Recreated empty.                                                          |
| `spaceProcessingState`                 | A     | 1/0/0  | `kith.space_processing_state`. Same shape.                                                              |
| `events`                               | C     | 4/0/0  | `kith.events`. Same shape.                                                                              |
| `eventVersions`                        | C     | 10/0/0 | `kith.event_versions`. Same shape.                                                                      |
| `observations`                         | D     | 13/0/0 | `kith.observations`. Money columns become `NUMERIC` under the finance domain.                           |
| `cardEntityBindings`                   | C     | 4/0/0  | `kith.card_entity_bindings`. Same shape.                                                                |
| `cardFieldDrops`                       | C     | 4/0/0  | `kith.card_field_drops`. Same shape.                                                                    |
| `cardExtractionAttempts`               | C     | 2/0/0  | `kith.card_extraction_attempts`. Same shape.                                                            |
| `cardExtractionQueueStates`            | A     | 1/0/0  | `kith.card_extraction_queue_states`. Same shape.                                                        |
| `recordQuerySessions`                  | E     | 3/0/0  | `kith.record_query_sessions`. Recreated empty.                                                          |
| `recordQuerySpaceState`                | A     | 1/0/0  | `kith.record_query_space_state`. Same shape.                                                            |
| `coverageWindows`                      | C     | 5/0/0  | `kith.coverage_windows`. Same shape.                                                                    |
| `coverageGaps`                         | C     | 6/0/0  | `kith.coverage_gaps`. Same shape.                                                                       |
| `sourceInventory`                      | C     | 6/0/0  | `kith.source_inventory`. Same shape.                                                                    |
| `embeddingProfiles`                    | A     | 1/0/0  | `kith.embedding_profiles`. Same shape.                                                                  |
| `spaceEmbeddingStates`                 | A     | 1/0/0  | `kith.space_embedding_states`. Same shape.                                                              |
| `embeddingGenerations`                 | A     | 3/0/0  | `kith.embedding_generations`. Same shape.                                                               |
| `embeddingTargets`                     | C     | 3/0/0  | `kith.embedding_targets`. Same shape. `inputHash` still the content fingerprint.                        |
| `embeddingBuildJobs`                   | A     | 2/0/0  | `kith.embedding_build_jobs`. Cursor becomes a keyset cursor, section 2.3.                               |
| `embeddingVectors`                     | D     | 8/1v   | `kith.embedding_vectors` with `vector(1536)`. Rows re-embedded, not migrated, section 5.2.              |
| `thoughts`                             | C     | 6/1/1  | `kith.thoughts` plus a `tsvector` GIN column. Vector moves to `embedding_vectors`.                      |
| `facts`                                | C     | 10/1/0 | `kith.facts` plus a `tsvector` GIN column.                                                              |
| `entities`                             | C     | 6/0/0  | `kith.entities`. Same shape.                                                                            |
| `workerParsedStages`                   | E     | 4/0/0  | `kith.worker_parsed_stages`. Drained, not migrated.                                                     |
| `workerCleanupState`                   | A     | 1/0/0  | `kith.worker_cleanup_state`. Same shape.                                                                |
| `workerSourceScans`                    | E     | 7/0/0  | `kith.worker_source_scans`. Drained, not migrated.                                                      |
| `workerScanPages`                      | E     | 4/0/0  | `kith.worker_scan_pages`. Drained, not migrated.                                                        |
| `workerScanEntries`                    | D     | 13/0/0 | `kith.worker_scan_entries`. Drained, not migrated.                                                      |
| `workerDiscoveryWork`                  | C     | 11/0/0 | `kith.worker_discovery_work`. Drained, not migrated.                                                    |
| `sourceAliasDigests`                   | C     | 2/0/0  | `kith.source_alias_digests`. Migrated, it is identity state not queue state.                            |
| `workerProtocolRateLimits`             | E     | 2/0/0  | `kith.worker_protocol_rate_limits`. Recreated empty.                                                    |
| `workerReservationReceipts`            | E     | 2/0/0  | `kith.worker_reservation_receipts`. Migrated, receipts are idempotency evidence.                        |
| `workerReservationTargets`             | E     | 5/0/0  | `kith.worker_reservation_targets`. Migrated with their receipts.                                        |
| `workerOperationReceipts`              | E     | 4/0/0  | `kith.worker_operation_receipts`. Migrated, idempotency evidence.                                       |
| `workerBinaryOperationReceipts`        | E     | 5/0/0  | `kith.worker_binary_operation_receipts`. Migrated, idempotency evidence.                                |
| `workerProcessingAssessments`          | E     | 6/0/0  | `kith.worker_processing_assessments`. Drained, not migrated.                                            |
| `workerWatcherStates`                  | B     | 2/0/0  | `kith.worker_watcher_states`. Migrated, holds coverage and cursors.                                     |
| `workerOperationalIncidents`           | B     | 2/0/0  | `kith.worker_operational_incidents`. Migrated.                                                          |
| `workerWatcherResetReceipts`           | E     | 1/0/0  | `kith.worker_watcher_reset_receipts`. Migrated, idempotency evidence.                                   |
| `lists`, `listItems`                   | B     | 4/0/0  | Recommended not migrated. Exported to JSONL and retired. Section 5.1.                                   |
| `reports`, `insights`                  | B     | 3/0/0  | Recommended not migrated. Exported to JSONL and retired. Section 5.1.                                   |

Receipts are migrated even though they expire. A receipt is what makes a worker
retry idempotent, and the always-on host's journal still holds the request ids
that index them. Queue and scan state is drained instead, because a quiesced
worker has no in-flight work to preserve.

### 1.3 Function groups and their PostgreSQL targets

| Group                            | Functions | PostgreSQL target                                                                                            |
| -------------------------------- | --------: | ------------------------------------------------------------------------------------------------------------ |
| `models/workers` (protocol)      |        44 | One service module behind the existing `/api/worker` route. 33 operations, one transaction each.             |
| `models/records` (cards, query)  |        19 | Typed record service. `query_records` becomes parameterized SQL with the same closed allowlist.              |
| `models/embeddings`              |        26 | Paged build service plus pgvector search. Same target and generation tables.                                 |
| `models/ingestion`               |        28 | Job, request and inline-work service. Lease claim is `FOR UPDATE SKIP LOCKED`.                               |
| `models/thoughts`                |        52 | Memory service. Recall blend unchanged, its two inputs become a GIN query and a pgvector query.              |
| `models/documents`               |         9 | Read-only document and inventory queries.                                                                    |
| `models/spaces`                  |        21 | Authorization module. `requireSpaceAccess` becomes one SQL predicate helper, section 2.5.                    |
| `models/facts`                   |        10 | Fact lifecycle service.                                                                                      |
| `models/family`                  |        11 | Invitation and membership service.                                                                           |
| `models/apiKeys`                 |        12 | Credential service, called directly by the Next.js routes instead of over a JWT hop.                         |
| `models/oauth`                   |         5 | OAuth authorization-code service.                                                                            |
| `models/diagnostics`             |         3 | Heartbeat, incident and watcher-reset service.                                                               |
| `models/sourceAccounts`          |         3 | Source account service.                                                                                      |
| `models/provenance`              |         2 | Internal provenance reads, folded into the document service. Coverage tables have no functions of their own. |
| `models/lists`, `models/reports` |        42 | Recommended retired, section 5.1.                                                                            |

The 128 `internalMutation` functions are the largest group and the cheapest to
port conceptually: each one is already a single atomic step with validated
arguments, which is exactly one SQL transaction. The expensive part is that
their tests use `convexTest`, and 57 of the 76 test files do.

### 1.4 Scheduled and background work

| Job                                    | Cadence | Purpose                                | Replacement                                                |
| -------------------------------------- | ------- | -------------------------------------- | ---------------------------------------------------------- |
| `recover inline ingestion`             | 1 min   | Retry stranded inline URL work         | Daemon tick, section 2.6                                   |
| `remove expired OAuth grants`          | 5 min   | Delete expired grants and codes        | Daemon tick, plus a delete-on-read guard                   |
| `remove expired worker protocol state` | 5 min   | Sweep `retireAt` rows                  | Daemon tick, plus bounded reclaim inside the claim query   |
| `detect missing filesystem workers`    | 1 min   | Flag a watcher whose heartbeat stopped | Read-time staleness predicate, plus a daily durable record |
| 10 `scheduler.runAfter` call sites     | ad hoc  | Card queue, embedding fill, reports    | Same daemon tick draining a `kith.deferred_work` table     |

### 1.5 Auth model

| Principal            | Today                                                                                                     | PostgreSQL target                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Web user             | Convex Auth `Password`, Lucia Scrypt secret, 10 year session, `users` and `authSessions`                  | Port `users` and `auth_accounts`, verify with the same Scrypt, own signed httpOnly cookie over `kith.sessions`. |
| MCP client           | Opaque key, SHA-256 `keyHash`, OAuth dynamic registration and code exchange, capability and space grants  | Same key and grant model in `kith.api_keys`. The route authenticates directly.                                  |
| Worker credential    | The same `apiKeys` row with `ingest` capability and `sourceAccountIds`                                    | Unchanged model, unchanged wire contract.                                                                       |
| Convex to MCP bridge | ES256 JWT minted by the web app, JWKS at `/.well-known/mcp-jwks.json`, `MCP_JWT_ISSUER`, `auth.config.ts` | Deleted. There is no second backend to authenticate to.                                                         |
| Finance reader       | PostgreSQL role `finance_reader`, `default_transaction_read_only`, 4 connections                          | Unchanged. A sibling `kith_reader` is added by the same code path.                                              |

Deleting the JWT bridge is the one place where consolidation makes auth simpler
rather than harder. Four files and one published key stop existing. Section 4
still gates the change behind an independent security review, because the web
session is the one credential whose implementation moves from a maintained
library into this repository.

## 2. Target design on the existing PostgreSQL database

### 2.1 Schema layout: one schema beside `finance`, not one shared schema

Recommendation: a second schema named `kith`, beside `finance`, in the same
database. Not one merged schema.

`kith` is the name the merged prototype already creates in
`packages/postgres-proof/migrations/001_init.sql`. Reusing it avoids a rename.

| Option                    | Cost                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One merged schema         | `documents` collides immediately: `finance.documents` is an acquired statement, `kith.documents` is an indexed extraction. So do `spaces`, `retained_texts` and the two evidence models. Every collision forces a rename of a table one workstream already ships. |
| Two schemas, one database | No renames. One connection, so one transaction can still span both. `pg_dump` can select or exclude a schema. The reader-role code in `pgReaderRole.ts` is already per-schema and produces `<schema>_reader`, so `kith_reader` costs one call, not a redesign.    |

Two schemas in one database keep the single benefit that motivated the whole
move: a transaction may write a finance row and a brain row and commit once.
Schema separation is an organizational and grant boundary, not a security
boundary, and the assessment already says so.

The finance archive already reads its version table schema-qualified and pins
`search_path` per transaction because the endpoint is pooled. `kith` uses the
same `pgStore.ts` helpers rather than a second copy. Extracting `pgStore.ts`,
`pgNumeric.ts` and `pgReaderRole.ts` into a shared `@repo/pg` package is a
shared-boundary change and belongs on GitHub Issue 57 before it lands.

### 2.2 Convex ids become preserved text keys

Recommendation: every primary key is `text`, and every migrated row keeps its
Convex id string verbatim. New rows get a fresh opaque id. No id-mapping table.

This is not a stylistic choice. The always-on host stores backend ids on disk.
`packages/pipeline/src/archiveCatalogTypes.ts` persists `sourceItemId`,
`sourceRevisionId`, `primaryReceiptId`, `providerReferenceId`, `jobId`,
`processingGenerationId` and `previousGenerationId` as opaque strings in the
archive catalog and the worker journal. Historical citations returned over MCP
carry the same strings. Renumbering to `uuid` would either dangle every one of
those references or require a mapping table consulted on every read forever.

| Property               | Decision                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Column type            | `text`, with a length and character-class `CHECK`                                                                                                      |
| Migrated rows          | The exact Convex id string                                                                                                                             |
| New rows               | A generated opaque id, lowercase base32 of 16 random bytes, distinguishable by length                                                                  |
| Cross-table uniqueness | Not assumed. Keys are per table and foreign keys are typed by column.                                                                                  |
| Space scoping          | Every space-scoped table carries `space_id` and a `UNIQUE (id, space_id)` so composite foreign keys can carry the space, exactly as the prototype does |
| `_creationTime`        | Becomes `created_at timestamptz NOT NULL`, taken from the export, not from the load                                                                    |

The finance archive already states that identities stay stable opaque text, so
this convention is shared, not invented for one side.

### 2.3 Ordering, cursors and paging

Convex `_creationTime` gives a total order per table. PostgreSQL does not order
by insertion. Every paged read becomes a keyset cursor over
`(created_at, id)` with a supporting index, which the index-capacity plan's
compare-and-set cursor guard already tolerates: the stored cursor is opaque to
the caller either way.

### 2.4 Atomicity replaces per-mutation atomicity

A Convex mutation is one transaction. One ported mutation is one
`SERIALIZABLE` transaction on one checked-out client, which the prototype
already implements and tests, including bounded retry.

| Convex property                                        | PostgreSQL replacement                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Mutation is atomic and isolated                        | `BEGIN ISOLATION LEVEL SERIALIZABLE`, one client, commit or rollback                                                             |
| Scheduled mutation is transactional with its scheduler | Insert a `kith.deferred_work` row in the same transaction. Committed together or not at all.                                     |
| Scheduled action runs at most once                     | Same. The daemon claims the row under a lease and the only durable effect stays idempotent.                                      |
| Transaction read and write limits force paging         | No platform limit, but keep the existing page sizes. They are already proven and they bound lock duration.                       |
| Optimistic concurrency on a document                   | `SELECT ... FOR UPDATE` on the generation and the document before activation, as the prototype does                              |
| Staged then atomically activated generation            | Unchanged design. The active pointer is a deferrable foreign key to `(generation, document, space)`.                             |
| Serialization failure                                  | Retry at most three times, then return a typed conflict. The prototype sets this policy; a broader backoff policy is still open. |

Two limits get better and one gets worse. Better: a stage no longer has to fit
16 MiB or 16,000 writes, and a 1 second query ceiling disappears. Worse:
`SERIALIZABLE` can abort a transaction that Convex would have serialized for
us, so every write path needs an idempotent retry, which the receipt tables
already provide.

### 2.5 Space isolation

Today `requireSpaceAccess` reloads the credential, intersects capability and
space grant with live membership, and every read rechecks the row's space.

The port keeps that shape in application code: one helper resolves the
authorized space set once per request, and every statement carries
`space_id = ANY($n)`. The composite `UNIQUE (id, space_id)` plus composite
foreign keys make a cross-space reference unrepresentable in the schema, which
is stronger than the current guarantee.

Row level security is deliberately deferred. The prototype's boundary note is
adopted as policy: the writer credential is a trusted server credential, all
access goes through the closed typed service surface, and no untrusted caller
ever gets SQL through it. The upgrade path is RLS policies on the space-scoped
tables keyed off a per-transaction `SET LOCAL` space set. That earns its cost
when a second human gets a database credential, which is not now.

### 2.6 Scheduled and cron work: the always-on Mac worker host daemon

Recommendation: run sweeps and deferred work from a launchd-managed daemon on
the always-on Mac worker host. Not Vercel cron, not a new cloud worker.

| Candidate                 | Verdict                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always-on Mac worker host | Recommended. The host already runs the pipeline worker and an installed daily backup service. Per-minute cadence costs nothing. One more launchd job and one `kith deferred-work drain` command.                                |
| Vercel cron               | Rejected as primary. Hobby accounts are limited to one run per day with up to 59 minutes of jitter. Two of the four sweeps run every minute today. Per-minute cadence requires Pro, which reintroduces a bill to remove a bill. |
| New small cloud worker    | Rejected. A new always-on process, a new deploy target and new credentials, to replace four idempotent sweeps.                                                                                                                  |
| `pg_cron` in the database | Not recommended, kept as a fallback. It removes the host dependency, but it puts application scheduling inside the database and must be verified on the host plan first.                                                        |

Two consequences make the daemon safe rather than merely cheap.

First, every sweep must be idempotent and a missed tick must cost nothing. That
is already true of three of the four: expired OAuth grants and expired worker
state are both `expiresAt` and `retireAt` deletes, and the prototype already
reclaims expired leases inside the claim query rather than waiting for a sweep.

Second, the one job that must not depend on the worker host is missing-worker
detection. It stops being a job. Staleness becomes a read-time predicate over
`worker_watcher_states.lastHeartbeatAt`, computed when the UI or `brain doctor`
asks, so a host that is down reports itself stale without needing to be up.
A single daily Vercel cron, which Hobby does allow, writes the durable incident
row for alerting. That is the whole cloud-side dependency.

### 2.7 Vector search: pgvector at 1536 dimensions

The hosted provider supports `pgvector` on every plan with no add-on, and HNSW
indexes up to 2,000 dimensions for the `vector` type, so 1,536 fits.

| Property  | Decision                                                                                                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension | `CREATE EXTENSION IF NOT EXISTS vector`, verified as step 1 of the proof, not assumed                                                                                                                                                                                                                                        |
| Column    | `embedding vector(1536)` on `kith.embedding_vectors`, alongside the existing `scopeV2`, fingerprint and `inputHash`                                                                                                                                                                                                          |
| Distance  | Cosine, `vector_cosine_ops`, matching the current normalized-profile assumption                                                                                                                                                                                                                                              |
| Index     | None at first. At 180 active targets an exact scan filtered by `space_id` and fingerprint is correct and fast. Add HNSW when a space exceeds about 2,000 targets, which is the card-model first backfill.                                                                                                                    |
| Precision | Convex stores float64, `vector` stores float32. Vectors are re-derived, not converted, so nothing is rounded in place.                                                                                                                                                                                                       |
| Filtering | The Convex filter field `scopeV2` becomes an ordinary `WHERE` on `(space_id, embedding_fingerprint)`. The 16 filter-field limit disappears.                                                                                                                                                                                  |
| Paging    | Convex vector search cannot page. PostgreSQL can. The existing fixed candidate budget is kept so retrieval cost stays constant in corpus size.                                                                                                                                                                               |
| Fallback  | If the extension were unavailable, keep the column as `real[]`, compute cosine in SQL over the space-filtered and fingerprint-filtered subset, and label semantic results degraded. Exact and keyword retrieval already must work during an embedding outage under T14, so the fallback is a known-good mode, not a new one. |

Full-text search is the other index kind. The three Convex search indexes become
`tsvector` generated columns with GIN indexes and `websearch_to_tsquery`. This is
not equivalent: Convex search is typo tolerant and prefix matching, PostgreSQL
full-text search stems instead. `pg_trgm` covers fuzzy matching where the
measured recall drops. Ranking parity is a measurement, not an assumption, and
section 4 pins the instrument.

### 2.8 How the app, MCP and worker reach PostgreSQL

| Caller                               | Path                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js routes and server components | `pg` Pool against the provider's pooled endpoint, `max` of 1 to 2 per serverless instance, no session-level state, `search_path` pinned inside each transaction           |
| MCP tool calls                       | Same pool, through the same typed service modules. No JWT hop, no second backend.                                                                                         |
| Worker protocol                      | Unchanged wire contract at `/api/worker`. The route authenticates the key and calls the service directly.                                                                 |
| Owner SQL exploration                | `kith_reader` and `finance_reader`, `default_transaction_read_only`, statement and lock timeouts, connection limit 4, created by the existing `pgReaderRole.ts` code path |
| Backups                              | `pg_dump` of both schemas, encrypted, into the existing restic repository. Section 3 step 10.                                                                             |

The finance archive's `pgStore.ts` already handles the pooled endpoint's two
traps: a `SET search_path` issued outside a transaction can vanish before the
next transaction, and advisory locks must be transaction scoped. Reuse it.
Reaching for the provider's HTTP driver is deferred until a measured cold-start
connection cost justifies a second client library.

## 3. Migration and cutover sequence

Every command below is a shape, not an existing script. Steps 1 through 8 touch
no production writer. The maintenance window is step 9 only.

### Step 1. Verify the host and create the schema

Confirm the extension and the role machinery on the real host before any code
assumes them. Create `kith` and apply migration 1.

- Acceptance: `vector` is installed, `kith` exists at version 1, `kith_reader`
  exists with `default_transaction_read_only` on, and `finance` is untouched at
  its current version.
- Verification shape: `pnpm --filter @repo/kith-store migrate:status` and
  `pnpm --filter @repo/finance-archive verify:schema`.

### Step 2. Export Convex

Take a dated native export with file storage, and a per-table JSONL export, in
the same preflighted credential context the backup recipe already requires.

- Acceptance: one export manifest recording date, deployment identity, schema
  version, Git revision, per-table row counts, byte lengths and hashes, staged
  at mode 700 with files at 600.
- Verification shape: `node scripts/convex-export.mjs --verify-manifest`.

### Step 3. Transform

One typed transform per table, from Convex JSONL to a `COPY`-ready stream. Ids
pass through unchanged. Numbers that are money become decimal strings validated
by the existing finance decimal rules before they reach `NUMERIC`.

- Acceptance: the transform is pure and rerunnable, every output row carries the
  input row's id, and any unmapped field is a hard failure rather than a
  silently dropped column.
- Verification shape: `pnpm --filter @repo/kith-store test:once` covering one
  synthetic fixture per table, plus `--dry-run --report-unmapped`.

### Step 4. Load into an isolated destination

Load into a throwaway database or branch, never the live archive database.

- Acceptance: every foreign key, `CHECK` and `UNIQUE` holds with constraints
  enabled, and no id was generated during load.
- Verification shape: `node scripts/kith-load.mjs --target isolated --strict`.

### Step 5. Parity checks

Five checks, all mechanical, all run against the isolated destination.

| Check                | Method                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Counts               | Per-table row count equals the export manifest, with the deliberately-not-migrated tables listed explicitly and expected to be zero                                                                                                                  |
| Retained text hashes | Recompute the SHA-256 of every `source_pages.text` and `chunks.text` and compare with the stored hash, then compare the set of hashes with the export                                                                                                |
| Provenance chains    | For every source item, walk item to revision to text version to page to evidence span to chunk to card observation, and assert the chain resolves and stays inside one space. Spot check is not enough where the walk is cheap, so walk all of them. |
| Archive references   | Every archive receipt and provider reference in the destination matches a row in the always-on host's archive catalog by id, and every catalog `sourceItemId` resolves                                                                               |
| Auth denial          | Revoked key denied, key without `write` denied a write, key scoped to space A denied space B, removed member denied every read path, stale session denied                                                                                            |
| Space isolation      | For every space-scoped table, assert no row references a parent in a different space, and assert the read API returns nothing cross-space for a two-space synthetic fixture                                                                          |

- Acceptance: all six tables of results green, with the exact command output
  recorded in the PR.
- Verification shape: `node scripts/kith-parity.mjs --all --expect-manifest`.

### Step 6. Behavioral parity on synthetic data

Run the ported service against the synthetic corpus and compare against the
Convex answers for the frozen question set. Section 4 defines the gates.

- Acceptance: section 4's table passes in full.
- Verification shape: `pnpm test:once` plus
  `pnpm --filter @repo/kith-store test:integration`.

### Step 7. No dual write, and no shadow period

Recommendation: skip both.

A shadow read period compares two backends under live traffic. There is no live
traffic. Dual writes would need every one of the 41 mutations and 33 worker
operations implemented twice and reconciled, which is the entire port plus a
reconciliation layer, to protect a deployment with no users. The assessment
already warns that coexistence is a migration phase, not a commitment.

What replaces it is cheaper and stronger: the export is immutable, the Convex
deployment is left intact and read-only after step 9, and a rollback is a
redeploy of the previous web build against Convex plus a replay of whatever was
written to PostgreSQL in the interim. Step 9 keeps that interim short and
observable.

- Acceptance: the rollback procedure is written down and its Convex-side
  read-only state is verified before step 9 begins.

### Step 8. Load into the live archive database

Apply `kith` migrations and load the same transformed output into the real
database, beside `finance`, with the worker quiesced.

- Acceptance: step 5 reruns green against the live database, and
  `finance.schema_version` and every `finance` row count are unchanged before
  and after.
- Verification shape: `node scripts/kith-parity.mjs --all --target live` and
  `pnpm --filter @repo/finance-archive verify:unchanged`.

### Step 9. Cutover

Ordered, in one window.

1. Stop the pipeline worker and every scheduled writer, including the backup
   service, and verify no child process remains.
2. Confirm the Convex queues are empty: no `queued` or `running` ingest job, no
   open scan, no pending inline work.
3. Take the final Convex export and rerun steps 3 through 5 on the delta.
4. Set the Convex deployment read-only by revoking the web and worker
   credentials it accepts.
5. Deploy the web build that talks to PostgreSQL, with the daemon's launchd job
   installed.
6. Sign in once. The owner re-authenticates; sessions were not migrated.
7. Restart the worker against the same `/api/worker` endpoint and confirm it
   resumes from its existing on-disk journal with no re-enumeration.
8. Re-embed, then run section 4's post-cutover subset.

- Acceptance: the worker completes one full scan and one document publication
  without re-acquiring bytes, one MCP query returns a historical citation minted
  before the migration, and `brain doctor` is green.
- Verification shape: `pnpm brain:doctor` and
  `node scripts/kith-parity.mjs --post-cutover`.

### Step 10. Backups on the new shape

The dated-backup recipe currently exports a native Convex ZIP. It becomes a
`pg_dump` of both schemas with the same preflight, protected staging, manifest,
encryption, restic repository identity checks and separate-process byte
comparison. This is the tracker's P2-27 work, and it is a cutover gate, not a
follow-up: a database with no proven restore is not a place to put the only copy
of the provenance chain.

- Acceptance: one dated encrypted dump published and verified by separate-process
  byte equality, plus one isolated restore that satisfies step 5's parity checks
  and returns a sampled cited answer.
- Verification shape: `node scripts/db-backup.mjs --engine postgres --verify`
  and `node scripts/db-restore-proof.mjs --isolated`.

### Step 11. Convex teardown and the point billing stops

1. Keep the read-only Convex deployment for 14 days after step 9 as the
   rollback source. Nothing writes to it.
2. After the 14 days, confirm the encrypted Convex export is in the restic
   repository and independently restorable.
3. Delete the deployment, remove `packages/convex`, `legacySchema.ts`,
   `auth.config.ts`, the JWKS route, `MCP_JWT_ISSUER` and the Convex deploy
   workflow.
4. Remove the Convex project from the vendor account.

Billing stops at step 11.4, not at step 9. On the free plan the monthly saving
at that moment is zero, and section 7 says so plainly. What stops at step 9 is
the risk of exceeding the free quota, and what stops at step 11.4 is the second
vendor relationship.

- Acceptance: no Convex dependency in `pnpm-lock.yaml`, no `NEXT_PUBLIC_CONVEX_URL`
  in any deployment environment, the four required checks green, and the vendor
  account shows no project.
- Verification shape: `pnpm lint && pnpm check-types && pnpm test:once && pnpm build`
  and `node scripts/check-self-hosting.mjs --web`.

## 4. Proof gates before any cutover

The prototype in `packages/postgres-proof` already closes part of this. The
column below records what it proved on 2026-09-08 against two real PostgreSQL 18
servers, and what P2-39 still owes.

| Gate                              | Proven by the prototype                                                | Still owed                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| API-key auth and revocation       | Yes. Stored SHA-256 digest, revocation rechecked on every operation    | OAuth code exchange, dynamic registration, the capability and grant arrays                                         |
| Web session auth                  | No                                                                     | Scrypt verification, session table, cookie, independent security review                                            |
| Space scoping                     | Yes, at the application layer, on every join and mutation              | The same over 77 tables, plus the two-space isolation suite                                                        |
| Staged publication and activation | Yes. One transaction, row locks, deferrable active pointer             | The real generation shape: pages, spans, chunks, cards, coverage in one activation                                 |
| Stale generation fence            | Yes                                                                    | The desired-revision and processing-epoch checks the live contract adds                                            |
| Idempotency                       | Yes. Immutable receipts for stage, activate and forget                 | The other 30 worker operations' receipts                                                                           |
| Historical citations              | Yes. Retained after correction, authorized                             | Citations minted before the migration, resolved after it                                                           |
| Correction and forget             | Yes, including tombstone and rollback                                  | Archive receipt and provider-reference forget paths                                                                |
| Worker lease                      | Yes. Atomic claim, fence epoch, expired reclaim, `SIGKILL` recovery    | Heartbeat and renewal, backoff, host affinity, and coupling the lease to publication, which is the tracker's P2-42 |
| Exact money                       | Yes. `NUMERIC` with validated decimal strings, the `0.1 + 0.2` fixture | The real observation and card money columns under the finance domain                                               |
| Encrypted dump and restore        | Yes, into a second isolated server, with tamper rejection              | Both schemas, the production key design, restic identity checks                                                    |
| Search ranking parity             | No                                                                     | Section 4.2                                                                                                        |
| Vector retrieval parity           | No                                                                     | Section 4.2                                                                                                        |
| Row level security                | No, and deliberately so                                                | Nothing now. Section 2.5 records the upgrade path.                                                                 |
| Performance                       | Not benchmarked                                                        | Nothing now. One user, one worker. Measure if a page gets slow.                                                    |

### 4.1 Synthetic end-to-end parity

One run, synthetic fixtures only, no owner data.

1. Two spaces, two members with different roles, one scoped API key each.
2. Ingest one synthetic PDF and one synthetic JSON capture through the real
   worker protocol at `/api/worker`, staged and activated.
3. Extract cards, publish records, build coverage.
4. Answer the frozen question set over MCP: `search_documents`, `get_document`,
   `query_records`, `list_sources`, `recall_context`.
5. Correct one document, forget another, revoke one key, remove one member.
6. Kill the worker mid-publication and let it recover.
7. Dump, restore into an isolated database, and answer the same questions.

Acceptance: every answer matches the Convex answer for the same fixture, every
citation resolves to the same retained text hash, and every denial in step 5
denies.

### 4.2 Retrieval parity instrument

The repository already has the instrument. `models/thoughts/memoryEval.ts` holds
18 answerable questions and 3 corpus-scoped unavailable controls, and the pilot
evaluation records the corpus as 180 active targets, 17 thoughts and 163 chunks.

Acceptance: rerun the same frozen question set and controls against PostgreSQL.
Semantic recall at the same candidate budget must not regress, the three
unavailable controls must still report unavailable, and any keyword-recall
change must be explained by stemming rather than by a lost row. A regression is
reported, not absorbed: the fallback is to add `pg_trgm` or to adjust the blend,
not to lower the bar.

### 4.3 Independent security review

Per the repository's security-sensitive rule, the session implementation, the
space-scoping helper and the MCP route changes are tier 2 work and require a
second-model review before merge. The review scope is fixed in advance:

| Area               | Question the review must answer                                                       |
| ------------------ | ------------------------------------------------------------------------------------- |
| Session            | Can a forged or replayed cookie authenticate, and does logout revoke server side      |
| Credential scoping | Can a client-supplied space widen authority rather than narrow it                     |
| Space isolation    | Is there any read, count, export, history or hydration path without a space predicate |
| SQL construction   | Is every identifier from a closed allowlist and every value a bind parameter          |
| Revocation         | Does a revoked key or removed member lose access within one request                   |
| Secret handling    | Is the writer credential absent from the browser bundle, logs and exports             |

### 4.4 The four required checks

`pnpm lint`, `pnpm check-types`, `pnpm test:once` and `pnpm build` must pass on
every row, plus `pnpm --filter @repo/kith-store test:integration` which requires
Docker and is already wired into CI by the prototype's job.

## 5. What not to migrate, and risks

### 5.1 Recommended not migrated

| Item                                                            | Size                                                                     | Recommendation                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lists`, `listItems`, `reports`, `insights`                     | 4 tables, 7 indexes, 42 of 287 functions, 1,605 lines of source, 0 tests | Export to JSONL, retire the 11 MCP tools, delete. These are upstream features, user-scoped rather than space-scoped, and the architecture already says user-private lists and reports can stay private for now. Retiring them removes 15% of the function count for none of the value. Owner question 1. |
| `embeddingVectors` row contents                                 | 180 rows today                                                           | Do not migrate vectors. They are derived and content-addressed by `inputHash`. Re-embed after cutover. 180 targets is a few cents and it avoids a float64 to float32 conversion argument entirely.                                                                                                       |
| `thoughts.embedding` legacy field                               | 17 rows                                                                  | Export to a cold JSONL audit file. Do not create a column for retained audit data that nothing queries.                                                                                                                                                                                                  |
| Queue and scan state                                            | 6 tables                                                                 | Drain to empty before cutover. A quiesced worker has nothing in flight, and re-enumeration is cheap and idempotent.                                                                                                                                                                                      |
| Session, refresh token, verifier, verification code, rate limit | 5 auth tables                                                            | Recreate empty. One human re-authenticates once.                                                                                                                                                                                                                                                         |
| `legacySchema.ts`                                               | 159 lines                                                                | Delete with Convex. It is a transitional test fixture schema.                                                                                                                                                                                                                                            |
| Convex reactivity                                               | 14 files                                                                 | Do not rebuild subscriptions. Server components plus a 10 second poll on the two live surfaces, worker heartbeat and queue depth. One user does not need a websocket.                                                                                                                                    |

### 5.2 Risks

| Risk                                                                       | Likelihood | Mitigation                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The port is abandoned half done, leaving two backends and two bills        | High       | Sequence by vertical slice, not by layer. Every row in section 6 lands behind the same wire contracts, so a pause is a pause rather than a broken deployment. Nothing is deleted until step 11. |
| Home-grown session auth is weaker than the library it replaces             | Medium     | Tier 2, independent review with the fixed scope in 4.3, Scrypt reused rather than reimplemented, one account, short cookie lifetime with server-side revocation                                 |
| A space predicate is forgotten on one of hundreds of statements            | Medium     | Composite `UNIQUE (id, space_id)` and composite foreign keys make cross-space references unrepresentable. One helper builds the predicate, and a test asserts every read path denies.           |
| Search ranking regresses silently                                          | Medium     | 4.2 is a gate with a frozen question set, not a spot check                                                                                                                                      |
| Id collision or dangling archive catalog reference                         | Low        | Ids are preserved verbatim, and step 5 reconciles the destination against the host's archive catalog both ways                                                                                  |
| `SERIALIZABLE` aborts under the worker's concurrent claims                 | Medium     | `FOR UPDATE SKIP LOCKED` for claims, bounded retry, receipts make retries idempotent. Already exercised by the prototype's concurrent claim test.                                               |
| The always-on host is off when a sweep is due                              | Medium     | Every sweep idempotent, expired leases reclaimed inside the claim query, worker staleness computed at read time                                                                                 |
| Provider free-tier storage exceeded once brain and vectors join finance    | Medium     | Size before loading. The card model caps vectors at one or two per document, and originals stay in the archive, not in rows. Section 7.                                                         |
| Both databases end up holding the only copy of something during the window | Low        | Step 10 lands before step 9, and the Convex export stays in the restic repository past teardown                                                                                                 |
| Finance workstream broken by a shared-package extraction                   | Medium     | Coordinate the `@repo/pg` extraction on GitHub Issue 57 before it lands, and assert `finance` unchanged in step 8                                                                               |

## 6. Effort and implementation rows

The estimate assumes a tier 1 agent moves about 300 lines of backend source and
its tests per agent hour where the domain logic survives and only the data
access and the function wrapper change, and a tier 2 agent about 200 on the
security and concurrency surfaces. That rate is an assumption, not a
measurement. The line counts it is applied to are counted.

| Row       | Scope                                                                                                                                                                                                                                                                              | Tier |   Hours | Depends on |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------: | ---------- |
| P2-39a    | Foundation. Grow `packages/postgres-proof` into `@repo/kith-store`. Shared `@repo/pg` extraction of `pgStore`, `pgNumeric`, `pgReaderRole`, coordinated on Issue 57. Migration runner, `kith` schema, id convention, pool, transaction and space-predicate helpers, `kith_reader`. | 2    |      16 | none       |
| P2-39b    | Export, transform, load and parity harness. Per-table transforms, `COPY` loader, the six parity checks of step 5.                                                                                                                                                                  | 1    |      24 | a          |
| P2-39c    | Identity and authorization. `users`, `auth_accounts`, `sessions`, cookie, Scrypt verification, `api_keys` with grant tables, OAuth exchange, spaces, members, invitations, `requireSpaceAccess` equivalent. 5,539 lines.                                                           | 2    |      36 | a          |
| P2-39d    | Provenance and documents. 14 tables, receipts, provider references, text versions, pages, spans, documents, chunks, inventory, source accounts. 9,167 lines.                                                                                                                       | 1    |      34 | a          |
| P2-39e    | Ingestion and worker protocol. 33 operations behind the unchanged `/api/worker` contract, jobs, leases, heartbeat, backoff, staging, activation, and coupling the lease to staged publication, which is the tracker's P2-42. 20,626 lines.                                         | 2    |     100 | c, d       |
| P2-39f    | Records, cards, coverage and the typed record query contract. 11,282 lines.                                                                                                                                                                                                        | 1    |      44 | d          |
| P2-39g    | Embeddings. pgvector column and search, `tsvector` GIN columns for the three search indexes, paged build with keyset cursors, retrieval parity rerun against the frozen question set. 6,009 lines.                                                                                 | 2    |      30 | d, f, h    |
| P2-39h    | Memory. Thoughts, facts, entities, recall blend over the two new index kinds. 6,105 lines.                                                                                                                                                                                         | 1    |      28 | c          |
| P2-39i    | Web and MCP surface. 12 route handlers, 28 tools, 10 pages, 14 files off Convex React hooks, server components plus a poll for the two live surfaces.                                                                                                                              | 1    |      30 | c to h     |
| P2-39j    | Deferred work, sweeps and diagnostics. `kith.deferred_work`, the daemon command, the launchd job, read-time worker staleness, incidents and watcher resets, one daily durable incident record. 787 lines.                                                                          | 1    |      14 | e, f, g    |
| P2-39k    | Backups and restore for both schemas, replacing the native Convex export in the dated-backup recipe. The tracker's P2-27.                                                                                                                                                          | 1    |      16 | b, d       |
| P2-39l    | Retire `lists`, `listItems`, `reports`, `insights`. Export to JSONL, remove 11 MCP tools, delete 1,605 lines. Subject to owner question 1.                                                                                                                                         | 0    |       8 | none       |
| P2-39m    | Parity run, independent security review, cutover, teardown and the cost line closed out.                                                                                                                                                                                           | 2    |      22 | all        |
| **Total** |                                                                                                                                                                                                                                                                                    |      | **402** |            |

Sequencing notes for the orchestrator. Rows a, b and l can start immediately and
in parallel. Row e is the critical path and is more than a quarter of the work;
it should not be split further across agents, because the 33 operations share one
lease and receipt model and two agents would converge on the same files. Row m
cannot be claimed until every other row is merged, because its acceptance is the
whole-system parity run.

## 7. Cost, honestly

List prices read from the vendor pricing pages on 2026-09-12. The deployment's
actual plan on each vendor is private configuration and must be read there
before anyone quotes a saving.

| Vendor          | Free tier                                                                    | First paid tier                                                               |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Convex          | 0.5 GB database, 1 GB file storage, 1 GB egress, 1M function calls per month | 25 USD per developer per month, 50 GB database, 25M function calls            |
| PostgreSQL host | 0.5 GB storage per project, 100 compute-unit-hours per project               | Pay as you go, 0.35 USD per GB-month storage, 0.106 USD per compute-unit-hour |
| Vercel          | Hobby, cron limited to one run per day with up to 59 minutes of jitter       | Pro at 20 USD per month, per-minute cron                                      |

Three honest statements follow.

First, if the deployment is on the free tier of both databases today, the monthly
saving on the day Convex is deleted is 0.00 USD. About 400 agent hours does not
pay for itself out of the bill. Anyone selling this work on cost is selling it
wrong.

Second, the free tiers do not survive the backfill. A 10,000-file corpus does not
fit in 0.5 GB of Convex database storage once retained text, pages, spans, chunks
and card observations exist, and it will not fit in 1M function calls a month
while a worker publishes it. At that point one of the two databases has to be
paid for, and the choice is 25 USD per developer per month for Convex against
0.35 USD per GB-month added to a PostgreSQL instance that is already running. The
consolidated shape is cheaper at every corpus size in the sizing table, but the
crossover arrives with the backfill, not today.

Third, the real return is not the invoice. It is one storage engine, one backup
and restore path instead of two, exact decimal arithmetic in the same transaction
as the document that supports it, one vendor to audit and one credential model to
review. Vectors add little: at 180 targets the pgvector column is about 1 MiB, and
at 20,000 card-model targets about 120 MiB, because originals stay in the archive
and never enter a row.

Two costs are outside this plan and should not be confused with it. The card
extraction backfill is 285.60 USD one-time for the 10,000-file corpus under the
document-cards sizing. Re-embedding the current 180 targets after cutover is
cents.

## Owner questions

Only these five change the work materially.

1. Retire `lists`, `listItems`, `reports` and `insights`, or port them? Retiring
   removes 42 of 287 functions, 11 MCP tools and 1,605 lines that have no tests.
   Porting costs about 10 agent hours and keeps the tools.
2. Which plan is each vendor on today, and is Vercel on Hobby or Pro? This
   decides whether section 7's saving is 0.00 USD or 25 USD per month, and
   whether cloud scheduling is available at all.
3. Accept one maintenance window with a single re-login, no dual write and no
   shadow read period? The alternative roughly doubles rows e, f and h.
4. Accept the always-on Mac host as the scheduler for sweeps and deferred work?
   That makes the deployment depend on that host for background progress,
   although not for answering questions. The alternative is Vercel Pro.
5. Accept deferring row level security, with the closed typed service surface as
   the only tenant boundary until a second person holds a database credential?
   Adding RLS now across the space-scoped tables is roughly 40 more agent hours.
