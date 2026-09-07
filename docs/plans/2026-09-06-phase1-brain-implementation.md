# Phase 1: trusted Brain foundation

**Date:** 2026-09-06

**Status:** P1-1 and P1-2 are implemented and deployed, including required ownership fields and scoped credentials. P1-3 source/evidence/job primitives and indexed read tools are implemented with synthetic integration tests. P1-4 versioned embeddings, semantic document reads, provider configuration, and keyword fallback are implemented with synthetic migration and lifecycle tests. P1-7 typed records and exact queries are implemented with synthetic fixtures. Family lifecycle, public ingestion, and installation acceptance remain pending.

**Parent:** [Kith Mind architecture](./2026-09-06-architecture.md)

**Scope:** Desktop-first family spaces, authorization, durable source and processing records, typed events and observations, deterministic queries with coverage, bounded inline-text ingestion, and embedding compatibility controls.

**Out of scope:** Real connector polling, URL fetching, OCR, model extraction, real-data backfill, bulk ingest, and native-mobile acceptance. Connector and backfill work begins in implementation Phase 2 after the contracts below work with synthetic records. Native-mobile validation is a separate P2-priority lane and does not gate the desktop phases.

This plan is public and self-contained. Contributors do not need `docs/private/`, owner accounts, or private fixtures to implement or verify it.

## 1. Phase 1 outcome

At the end of Phase 1, two independently authenticated users can create a shared family space, invite one another, hold different roles, and query the same space-scoped people and vehicles. Private data remains private across every read path. A caller or ingestion credential can act only where both its capability grant and the caller's current space membership permit it.

The system can accept a bounded inline-text source, compute its identity and content hash at the trusted boundary, create an immutable revision, stage pages, evidence spans, a document, and chunks, then expose them only after one activation mutation. Synthetic lab and vehicle-service records exercise the same staging and activation boundary. Repeated values on different dates remain distinct, an older record imported later does not become the newest event, and exact queries explain whether a negative or total is supported by source coverage.

Phase 1 keeps the current embedding model and 1,536-dimensional index. It records an embedding fingerprint and generation so a later benchmarked migration cannot mix incompatible vectors. Structured and text queries remain available when vector search is unavailable or incomplete.

## 2. Non-negotiable contracts

### 2.1 Spaces, identities, and authors

- `entities`, `facts`, `thoughts`, `events`, `observations`, documents, source records, evidence, chunks, and processing records are owned by exactly one `spaceId`. Cross-space references are rejected on write and treated as unavailable on read.
- `userId` on content is the author or actor for audit. It is never the authorization boundary and does not make a shared record private to its author.
- Every user has one personal space and an owner membership. Shared spaces have explicit memberships with role `owner`, `editor`, or `reader`.
- `me` resolves from the authenticated user's member profile or person-entity link in the selected space. It never resolves to the deployment owner by default.
- Entity keys are unique inside a space. Two family members use the same shared person or vehicle entity. A private-space entity is separate and is never silently linked in a result visible to another space.
- Existing user-owned entities, facts, and thoughts migrate to the author's personal space. Migration never puts legacy content into a shared space.

### 2.2 Authorization and write destination

Use one authorization library from all web, MCP, action, query, mutation, and worker-finalization entry points:

```ts
type SpaceRole = "owner" | "editor" | "reader";
type Capability = "read" | "write" | "ingest";

type Principal = {
  userId: Id<"users">;
  credentialId?: Id<"apiKeys">;
  capabilities: readonly Capability[];
  credentialSpaceIds?: readonly Id<"spaces">[];
  credentialSourceAccountIds?: readonly Id<"sourceAccounts">[];
};
```

Principal snapshots use arrays so they can cross Convex action boundaries. Actions
pass a `PrincipalRef` containing only the authenticated user and optional key ID;
final queries and mutations reload current grants and membership.

`requireSpaceAccess(ctx, principal, spaceId, operation)` enforces both controls:

| Operation                                        | Required role            | Required credential capability |
| ------------------------------------------------ | ------------------------ | ------------------------------ |
| Read, search, direct-ID get, history, evidence   | reader, editor, or owner | `read`                         |
| Create or change content                         | editor or owner          | `write`                        |
| Admit, claim, stage, or activate ingestion       | editor or owner          | `ingest`                       |
| Invite, remove, change roles, transfer ownership | owner                    | Web session only in Phase 1    |

For an API key, the permitted spaces are the intersection of its stored `spaceIds` and the user's current memberships. An `ingest` credential is also limited to its configured source-account IDs; a caller-supplied `source.accountId` must resolve to one of them in the selected space. Revocation, role changes, key deletion, or scope changes take effect on the next operation. Worker activation rechecks access; a job claimed before revocation cannot publish afterward. Legacy keys are migrated to `read` and `write` over the user's personal space only. New keys require explicit capabilities and space scopes, plus source-account scopes when they can ingest.

`requireMcpPrincipal` derives `userId` and key ID from the signed identity, reloads that key on every operation, verifies that it still belongs to the subject, and then reads current capabilities and scopes. Capabilities are not copied into a long-lived token and trusted after a key change. Web-session principals likewise derive the user from `requireWebUserId`; neither surface accepts caller-supplied identity as authority.

Every public write accepts optional `spaceId`. `resolveWriteSpace` chooses, in order:

1. the explicit space after authorization;
2. the caller's configured default write space after authorization;
3. the caller's personal space.

If no default is configured, resolution falls back to the personal space. A configured default that is stale or no longer writable is an error until the user selects another destination; silently changing destinations would hide a permissions or configuration problem. Creating or joining a shared space never changes the default. No legacy or destination-less write is automatically shared.

### 2.3 Source identity, revisions, and evidence

A source item is unique by `(spaceId, connector, accountId, externalId)`. `externalId` is a connector-native stable ID where one exists. The bounded manual/MCP path requires an explicit stable source item ID as well as a separate request ID for transport retries; URI and file location are mutable metadata, not identity. Storage uses a source-account reference and SHA-256 of the external ID for this identity. Forgetting erases the raw external ID and source metadata while retaining this minimal identity tombstone to prevent automatic resurrection.

Each admitted payload is hashed at the trusted server boundary. Inline text hashes the exact UTF-8 bytes of the validated `text` value; a future binary fetch hashes the actual fetched bytes. Do not apply unspecified Unicode, newline, JSON, or file normalization before the source-revision hash. For request-ID conflict detection, MCP hashes a canonical validated argument envelope that preserves text exactly. The MCP SDK provides decoded arguments, not raw HTTP bytes. A future dedicated HTTP ingestion route may separately hash its raw bounded request bytes. A source revision is immutable and unique by `(sourceItemId, contentHash)`. An identical retry returns the existing revision and processing result. Changed content for the same source item creates a new revision. Admission uses an expected desired-processing epoch compare-and-swap (zero for a new item); a matching existing receipt is checked first. Provider-specific revision ordering remains a connector responsibility, rather than a generic lexical comparison. The same external item intentionally imported into two spaces creates two independently authorized source items.

Source-revision and processing idempotence are separate. A processing generation is unique by `(sourceRevisionId, processingFingerprint)`, where the fingerprint includes parser/text-extraction, extractor, record-schema, normalization, and chunker versions plus an explicit correction revision when a human fixes unchanged bytes. Reprocessing the same revision with the same fingerprint reuses the generation; a corrected extraction or changed processing contract creates another generation. Mutable location and original-link metadata live on the source item. The canonical archived-content reference, when available, lives only on the immutable source revision so an old citation cannot resolve to newer bytes.

Pages and evidence spans are separate from chunks:

- A `sourceTextVersion` belongs to an immutable revision and records the parser/OCR fingerprint. Correcting extraction text creates another text version without manufacturing another original revision.
- A source page belongs to one source-text version and stores page/section identity, text, and text hash. Re-chunking reuses that text version and those page IDs.
- An evidence span belongs to a page or source-text version and stores offsets, a quote hash, and optional human-readable locator data such as a sheet range.
- Events, observations, and document fields cite evidence-span IDs. Citations never depend on chunk ordinals or chunk IDs.
- Re-chunking or re-embedding therefore does not invalidate evidence. A corrected extraction creates a new processing generation while retaining the prior generation for audit.

The old free-text `sourceRef` stays readable. It is not parsed into a URI or promoted to structured evidence during migration because that would invent provenance.

### 2.4 Events and typed observations

Current facts and repeated observations have different semantics. The existing fact supersession path remains for state such as a current address. Extracted labs and vehicle service use these records:

```ts
type Event = {
  spaceId: Id<"spaces">;
  sourceItemId: Id<"sourceItems">;
  eventKey: string;
  createdBy: Id<"users">;
};

type EventVersion = {
  eventId: Id<"events">;
  entityId: Id<"entities">;
  eventType: string;
  occurrence:
    | { precision: "unknown" }
    | { precision: "date"; date: string }
    | { precision: "datetime"; instant: number; originalOffset: string };
  schemaVersion: number;
  processingGenerationId: Id<"processingGenerations">;
  userId: Id<"users">; // audit author/actor, not the authorization boundary
};

type ObservationValue =
  | { type: "decimal"; value: string; unitCode: string; originalUnit?: string }
  | { type: "money"; amount: string; currency: string }
  | { type: "integer"; value: string; unitCode?: string }
  | { type: "text"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "date"; value: string }
  | { type: "entity"; entityId: Id<"entities"> };
```

`eventKey` is stable within a source item, for example a connector event ID or a reviewed evidence-local key such as `lab-panel:0`. Event identity is a reliable connector event ID when the connector supplies one; otherwise it is `(sourceItemId, eventKey)`. Source revisions, processing generations, and schema versions describe representations of that logical event and are excluded from its identity, so corrections and schema upgrades cannot manufacture duplicates. An observation is unique within its event by a stable `observationKey`. Values are not identities. Equal results on separate dates remain separate events and observations.

`events` holds that stable logical identity. Versioned occurrence, entity/type classification, evidence, and schema fields live on `eventVersions` under a processing generation. Observation rows carry `eventId`, `observationKey`, and processing generation; their logical identity is `(eventId, observationKey)` while each generation retains its immutable value representation. Queries return the stable event ID and the active event/observation version IDs. A correction activates new versions without overwriting audit history.

Phase 1 keeps events from different source items separate. Exact queries never collapse independent attachments based on matching names, dates, or values. Reviewed event links, shared external event identity resolution, general cross-source consolidation, and automated matching are deferred until real connectors supply representative identifiers. See the [typed-record contract](./2026-09-06-record-query-contract.md) for the implementation boundary.

Date-only values stay date-only and timezone-qualified datetimes retain their original offset alongside the sortable instant. Missing event dates remain `unknown`; ingestion must not substitute issue, capture, import, or current time. Deterministic ordering uses the occurrence date/instant and then record ID, never import or creation time. `latest` excludes undated events and reports their count. When date-only and datetime records cannot be strictly ordered without inventing a timezone, the result reports tied candidates rather than claiming false precision. The implementation uses the full possible date interval across supported offsets, so adjacent calendar dates may also be ambiguous. Stable pagination traversal is distinct from semantic recency across offsets.

Decimal and money values use canonical base-10 strings validated at entry. Calculations use exact decimal arithmetic. Money always carries an ISO 4217 currency and totals group by currency unless an explicit, sourced conversion is requested. Units use a controlled code and ingestion stores the original unit where normalization occurred. No extracted typed record or query filter uses `v.any()`.

Each supported event type has a versioned validator in code. Phase 1 must include schemas for repeated lab results and vehicle service. Workout data is optional example data and is not an acceptance gate.

Ingested observations enter through the validated staging API used by processing workers. They do not call conversational Smart Save or inherit its current-value deduplication, supersession, or hardcoded confidence behavior.

### 2.5 Processing generations and recovery

Jobs and processing generations use the same externally visible state vocabulary:

`queued → processing → staged → ready`, with `needs_review` and `failed` exception states.

- Admission creates or reuses the source revision and durably enqueues its job in one mutation.
- Admission records the item's desired revision and processing epoch, separate from its active pointers. A stale source notification must not roll this target backward: use a comparable provider revision or reconcile the current source before changing it. A future connector poll must use `advanceCursorAndEnqueue`: compare the stored cursor version, admit a bounded discovery page, enqueue all resulting jobs, and advance the cursor in one Convex transaction. A cursor never advances without durable jobs.
- `claimJob` increments a monotonic `leaseEpoch`, records a random lease token and `leaseExpiresAt`, and increments attempts. Renew, stage, fail, and activate require the current epoch and token. An expired worker is fenced from all later writes.
- Processing generation identity is `(sourceRevisionId, processingFingerprint)`, distinct from revision identity; the fingerprint includes source-text version and extraction/schema/chunk configuration. Processing writes only rows bearing its `processingGenerationId`. It records the extractor, schema, chunker, and embedding fingerprints used.
- `stageGeneration` validates expected page, evidence, document, event, and observation counts, schema versions, cross-space references, and evidence references, then marks the generation `staged`.
- `activateGeneration` is one mutation. It rechecks the worker credential and membership, verifies the current lease and staged generation, and requires the job to match the source item's desired revision and processing epoch, then updates `sourceItems.activeRevisionId` and `activeGenerationId` and marks the generation and job `ready`. Readers follow those pointers, so they see the complete prior generation or the complete new generation, never a partial mix. Exact records, evidence, and keyword text must be complete. Embeddings may be `pending` or `failed` under a separate `embeddingStatus`; in that case activation labels semantic search unavailable and schedules an idempotent embedding job rather than hiding valid exact records.
- Failed jobs record a bounded error, retry eligibility, and `nextAttemptAt`. Obsolete work that no longer matches the desired revision/epoch terminates with `obsolete_generation` and is not retried; it is not a coverage gap once its replacement is successfully indexed. Requeue is explicit and idempotent. Validation uncertainty goes to `needs_review` rather than publishing guessed data.
- A newer correction activates a new generation. Old generated records remain queryable only through authorized audit/history operations. Derived summaries must carry generation inputs and are invalidated or rebuilt after activation.
- Source disappearance marks the item unavailable and labels original-link access without erasing retained evidence. Explicit forget is an authorized workflow that removes active/derived content, queued payloads, indexes, and caches and leaves a minimal non-content tombstone so polling cannot resurrect it. A failed replacement keeps the prior validated generation visible but stale and exposes the failure.

Phase 1 implements and tests the transaction, lease, fencing, retry, and activation primitives with the inline-text worker and synthetic records. Real pollers, expired-cursor reconciliation, full scans, notifications, and connector-specific recovery arrive in Phase 2.

### 2.6 Coverage-aware exact queries

`sourceAccounts`, `coverageWindows`, and `coverageGaps` record what an importer is known to cover. A coverage window names its space, account, record type, optional entity, inclusive start, exclusive end, last successful enumeration and processing times, discovered/indexed/skipped item counts, and freshness policy. A gap records a range, reason, detection time, and whether it has been resolved. Pending, skipped, and failed jobs count against completeness. A recent poll alone never proves historical coverage. Complete means complete within the named source inventory, record types and dates, not complete knowledge of every real-world event.

`query_records` is a discriminated union, not an arbitrary field map. Phase 1 operations are:

- `latest_observation`: entity, observation type, optional as-of time and unit;
- `observation_history`: entity, observation type, time range, ascending or descending order, and cursor;
- `latest_event`: entity, event type, optional as-of time;
- `list_events`: entity, event type, time range, order, and cursor;
- `sum_money`: entity or account, line-item type, time range, grouped by currency.

All time ranges are `[from, to)`. Results use deterministic occurrence ordering and opaque stable pagination cursors. Queries include contributing event/observation IDs, evidence citations, undated and other excluded ambiguous records, and:

```ts
type QueryCoverage = {
  state: "complete" | "partial" | "unknown" | "stale";
  asOf: number;
  windows: Array<{ from: number; to: number; sourceAccountId: string }>;
  knownGaps: Array<{ from?: number; to?: number; reason: string }>;
  pendingJobs: number;
  failedJobs: number;
};
```

A zero-row response is `no_match_complete` only when fresh windows completely cover the requested scope and there are no open gaps or relevant pending/failed jobs. Otherwise it is `no_match_incomplete`. A total is qualified as partial under the same rule. Semantic search is never used to compute latest, history, or totals.

Exact aggregation runs against an active-generation snapshot timestamp. Generation activation records immutable `activatedAt` and `deactivatedAt` bounds, allowing each page to reconstruct which generation was active at the snapshot even if a correction activates mid-query. A bounded `sum_money` call either completes or returns a server-bound resume cursor plus partial grouped decimal totals; every partial page is labeled incomplete. Cursor state binds the principal, normalized filter, snapshot, last stable record tuple, and accumulated exact totals. Every resume reloads current membership and credential scopes; an authorization change invalidates the cursor and accumulated totals rather than returning contributions from newly inaccessible records. Only the terminal page may claim a complete total. The default is snapshot consistency; if a caller explicitly requires current data and the space activation epoch changed during the run, discard the partial accumulator and retry from a new snapshot rather than combining generations.

## 3. Schema and indexes

P1-1, P1-3, and P1-7 add the following logical records. Validators live beside their models; shared enums and structured provenance live under `models/provenance/`.

| Table                                 | Required identity/indexes                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `spaces`                              | kind, name, `createdBy`; personal lookup by creator and kind                                                                                    |
| `spaceMembers`                        | `(spaceId,userId)` unique-by-mutation, by user; role and optional linked person entity                                                          |
| `spaceInvitations`                    | token hash, `(spaceId,normalizedEmail)`, role, expiry, pending-acceptance user ID, owner approval, accepted/revoked audit                       |
| `userSpaceSettings`                   | user ID, personal space ID, optional default write space ID                                                                                     |
| `apiKeys`                             | existing key hash plus capabilities, explicit space IDs, and explicit source-account IDs for ingest; legacy non-ingest keys may omit source IDs |
| `entities`                            | required `spaceId`; `(spaceId,key)` and `(spaceId,kind,normalizedName)`                                                                         |
| `facts`, `thoughts`                   | required `spaceId`, author `userId`, space-filterable search/vector indexes                                                                     |
| `sourceAccounts`                      | `(spaceId,connector,accountId)`, freshness and cursor version                                                                                   |
| `sourceItems`                         | `(spaceId,connector,accountId,externalId)`, mutable location/original-link metadata, authoritative active revision/generation pointers          |
| `sourceRevisions`                     | `(sourceItemId,contentHash)`, immutable capture metadata and canonical archived-content reference                                               |
| `sourceTextVersions`                  | revision and parser/OCR fingerprint; immutable extracted text identity                                                                          |
| `processingGenerations`               | unique `(sourceRevisionId,processingFingerprint)`, text version, generation number, activation interval and state                               |
| `sourcePages`, `evidenceSpans`        | by source-text version; spans by page and ordinal                                                                                               |
| `documents`, `chunks`                 | by generation/document; space-filtered text/vector indexes                                                                                      |
| Events, versions and observations     | event by `(sourceItemId,eventKey)`; immutable versions by generation/space/entity/type/time; cross-source links deferred                        |
| `ingestJobs`                          | by space/state/next attempt and source revision; lease fields and bounded error                                                                 |
| `coverageWindows`, `coverageGaps`     | by space/source account/record type and time range/status                                                                                       |
| Embedding profile/generation metadata | immutable fingerprint/profile, state, expected/completed counts; may be stored with space/config metadata rather than empty framework tables    |
| Exact-query resume state              | principal/filter/snapshot-bound cursor and exact accumulator when an aggregation exceeds one bounded page                                       |

These are logical records, not a requirement to create an otherwise empty table for every label. Closely related metadata may be colocated where that preserves the same identities, indexes, retention, and authorization behavior. Convex does not enforce unique constraints, so every create/upsert mutation performs an indexed lookup and is covered by an idempotent-concurrency test. Denormalized `spaceId` fields are validated against their parents on write; they exist to make authorization filters indexable.

Documents use state from their processing generation rather than a second conflicting lifecycle. Chunks include `spaceId`, `processingGenerationId`, document ID, ordinal, text, and evidence-span IDs. Canonical vectors live in a separate `embeddingVectors` table with fingerprint, embedding generation, target ID, and input hash. This lets profile generations coexist without overwriting active vectors. Text chunks may cross page boundaries only by citing every covered span.

## 4. Migration strategy

P1-1 implements optional ownership, space-aware indexes, personal-space bootstrap,
content backfills and paginated audits. Its operator procedure is in
[Personal-space migration](../migrations/personal-spaces.md). It does not
enable shared reads or writes. Existing writers can still create unscoped
rows until P1-2 changes them, so a successful P1-1 audit must be repeated at
cutover.

The P1-2 scope rollout and required-field cutover are documented in
[Scoped credentials and space authorization](../migrations/scoped-credentials.md).

The migration follows the existing `models/thoughts/migrations.ts` pattern: optional field, compatible indexes, paginated dry-run mutation, count query, idempotent rerun, then a later PR makes the field required. Ordinary indexes can coexist by user and space. Convex requires one vector index per embedding field, so the existing vector index gains `spaceId` as an additional filter while retaining its name and `userId` filter for legacy queries.

1. Create a personal space, owner membership, and settings row for every user. Idempotency uses the personal-space lookup and membership lookup.
2. Add optional `spaceId` to entities, facts, and thoughts. Backfill entities first, then facts and thoughts to the author's personal space. Validate that every fact's subject and entity value are in the same space.
3. Add space indexes beside current user indexes, or extend the existing index's filter fields when Convex requires one index per field. Switch all reads and writes to authorized spaces only after missing counts reach zero in a copy of the deployment.
4. Make `spaceId` required. Keep author indexes only where an audit or author-filtered feature actually uses them; do not use them for authorization.
5. Extend API keys with capabilities and space scopes. Backfill existing keys to the owner's personal space with `read` and `write`; do not grant shared spaces or `ingest` implicitly.
6. Backfill the current embedding fingerprint and generation metadata without changing or recomputing vectors. A later benchmarked model change uses the migration in section 7.

Migration tooling reports examined, changed, skipped, and invalid-reference counts. It stops before patching cross-space or missing-entity inconsistencies and emits IDs for review. `sourceRef` is left untouched.

## 5. Complete read and write inventory

P1-2 is not complete until every row below uses the shared authorization helpers. Search filtering alone is insufficient; hydrate and direct-ID paths must check the loaded row's space before returning it.

| Surface                    | Paths to inventory and test                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facts and entities         | fact search, core facts, current/history lists, subject resolution, object-entity hydration, direct-ID and internal seed/update helpers                                         |
| Thoughts                   | keyword search, vector search, hybrid merge, core, recent, stats, direct IDs, around-time/timeline, capture classification candidates, transitions and report-triggered capture |
| Recall                     | `recall_context`, `recallBlend`, all fact/thought hydration, optional caller-supplied space filters                                                                             |
| Sources and documents      | search, direct document/page get, chunk results, source/revision/evidence history, `list_sources`                                                                               |
| Structured records         | event/observation exact queries, direct-ID evidence expansion, audit history                                                                                                    |
| Ingestion                  | admission, claim, lease renewal, staging, activation, fail/retry/review transitions, cursor transaction                                                                         |
| Existing personal features | lists, reports, insights, and API-key management remain user-scoped in Phase 1; confirm they cannot hydrate a newly shared row without a space check                            |
| Evaluation/internal APIs   | fixture seeding, recall evaluation, migrations, scheduled/internal actions; no public function accepts a caller-supplied `userId` as authority                                  |

Space filters supplied by a client are intersected with the principal's authorized space set. Unknown or inaccessible explicit space IDs return the same not-found/unauthorized shape and never reveal existence. Empty filters mean all currently authorized spaces for reads. Each merged read applies a global limit and deterministic ordering after combining per-space results.

## 6. Family lifecycle API and UI

Phase 1 adds a deliberately small desktop workflow:

- Create shared space: authenticated web user chooses a name; the mutation creates the space and owner membership atomically.
- Invite member: owner enters email and role `editor` or `reader`; store normalized email, hashed random token, expiry, and inviter audit. Do not create a shadow user. The UI provides the secret invite link for the owner to deliver out of band; Phase 1 does not require an email service.
- Accept invite: the current Password provider does not prove email ownership, so email match is a routing hint rather than authorization. The logged-in invitee submits the secret invite token, which records that server-derived user ID as a pending acceptance. An owner then approves that concrete account in the members UI before membership becomes active. The client never nominates a user ID. A future provider may remove the approval step only when the server can verify the same normalized email claim.
- Members page: show active members, pending invitations, roles, and the current user's access. Owners can change editor/reader roles, revoke invitations, and remove members.
- Person mapping: explicitly link a member to a same-space person entity, including initial Personal setup. Never infer identity from matching names. Until linked, `me` returns a clear setup error. Members can manage their own Personal link; shared-space owners manage family member links.
- Ownership: at least one owner must remain. Transfer adds the new owner before demoting the old one in one mutation. A last owner cannot leave or be removed.
- Default destination: settings show Personal plus current memberships. The user can choose a default write space; joining a family space does not select it automatically.

MCP and ingestion credentials are created in the existing API-key UI with explicit capability checkboxes and space selection. Family management itself is web-session-only in Phase 1. Enterprise groups, directory sync, custom roles, and delegated administrators are out of scope.

## 7. Embedding compatibility and migration

Keep `text-embedding-3-small` and 1,536 dimensions during Phase 1. Do not switch to `text-embedding-3-large` until the real-corpus benchmark in Phase 2 identifies a better configuration.

Define the fingerprint as a canonical hash of provider protocol, an explicitly configured immutable `providerId`, model name, an explicitly configured immutable `modelRevision`, dimensions, normalization, and preprocessing version. The concrete API key and endpoint URL are excluded. Two endpoints may share a fingerprint only when their operator explicitly declares the same provider/model revision compatibility; matching model display names are insufficient. Every vector row carries this fingerprint and an embedding-generation ID. Vector indexes filter by space and fingerprint; results are post-filtered to active processing generations before hydration.

P1-4 exposes this configuration through `BRAIN_EMBED_ENDPOINT`, `BRAIN_EMBED_PROVIDER_ID`, `BRAIN_EMBED_MODEL`, `BRAIN_EMBED_MODEL_REVISION`, `BRAIN_EMBED_DIMENSIONS`, and optional bearer authentication. The checked-in defaults describe the existing OpenAI `text-embedding-3-small`/1,536 deployment and assign its baseline revision explicitly. Changing provider, model, declared revision, dimensions, or preprocessing always creates a new fingerprint and staged generation; an operator never edits the identity of an existing profile.

P1-4 centralizes embedding calls behind the existing helper and adds strict response length/type checks, but keeps current default behavior. Keyword document search and `query_records` never depend on embeddings. Hybrid recall catches embedding unavailability and returns exact/keyword results with `vectorStatus: unavailable` rather than failing the whole answer.

A later migration creates a staged embedding profile and generation, embeds every currently active eligible row, checks expected versus completed counts, and only then flips the space's active embedding profile in one mutation. Queries never combine fingerprints. Failed or partial generations remain inactive; the old profile remains queryable until the flip succeeds. Cleanup happens after validation and does not delete source pages or evidence.

The concrete provider, vector storage, bounded operator rebuild, baseline migration,
and fallback behavior are documented in the [embedding contract](./2026-09-06-embedding-contract.md).

## 8. Bounded Phase 1 ingest

`POST /api/ingest` reuses `/api/mcp` bearer authentication and short-lived Convex identity. The body is limited before parsing and accepts one inline UTF-8 text source:

```ts
{
  spaceId?: string;
  requestId: string;
  source: {
    connector: "mcp-client";
    accountId: string;
    externalId: string;
    kind: "file" | "web" | "message" | "other";
    uri?: string;
    href?: string;
    capturedAt: string;
  };
  title: string;
  text: string;
  docType?: string;
}
```

The route enforces content type, byte limit, title/request-ID/source-ID limits, and rate limit, then derives the principal and destination space. It resolves `source.accountId` to a configured source account permitted by the credential. The Convex action hashes the exact UTF-8 text bytes, admits the source revision and job, claims a lease, creates one source-text version, one text page, evidence spans, a generic document, and bounded chunks, stages, and activates. Chunking is a simple Phase 1 implementation with explicit maximum input, page, chunk, and chunk-count limits. Its size is configuration recorded in the chunker fingerprint, not a corpus-wide recommendation.

The response reports source item, revision, generation, job, and document IDs plus `ready`, `needs_review`, or `failed`. Retrying the same request ID and canonical validated arguments is a no-op that returns the same authorized result. Reusing a request ID with different validated arguments is a conflict. A new request ID for the same source external ID and changed text creates a new immutable revision and activates it only after complete staging.

`ingest_url` may enqueue a URL-shaped source for compatibility, but Phase 1 does not fetch it and must return `queued` with `workerRequired: true`. URL fetching, redirect and private-network defenses, file downloads, OCR, portal automation, and connector credentials belong to Phase 2. Tests must not make network requests.

Synthetic event fixtures call the same internal stage/activate contract used by future extractors. There is no Phase 1 model extractor. This proves the record boundary without shipping a fake parser that would later become production behavior.

## 9. MCP and query surface

Add these tools to the memory profile and tool policy:

| Tool               | Phase 1 behavior                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `search_documents` | Space-authorized keyword-first search with optional doc type and time range; vector contribution only when compatible and available |
| `get_document`     | Authorized direct get with pages/evidence and active-generation check                                                               |
| `query_records`    | The exact discriminated operations in section 2.6                                                                                   |
| `list_sources`     | Authorized source accounts/items with freshness, job counts, coverage, and gaps                                                     |
| `ingest_url`       | Enqueue only; clearly reports that a Phase 2 worker is required                                                                     |

Existing read tools gain optional space filters. Existing write tools gain optional `spaceId` and use `resolveWriteSpace`. Returned records include space ID, immutable citation identifiers, and the author separately. Original-source availability is a separate field; membership in Kith Mind does not imply permission to open an external file or portal.

## 10. Tests and acceptance

Use synthetic people, lab panels, and vehicle records only. No owner data or credentials are required.

1. **Migration:** dry run, pagination, rerun, zero-missing counts, invalid cross-space reference report, legacy keys limited to personal space, and no shared-space assignment.
2. **T8 - Family identity and authorization:** two web identities complete invite acceptance and explicit owner approval, resolve the same shared person and vehicle, and resolve `me` to different member-linked people.
3. **Roles and capabilities:** reader writes fail; editor content writes pass; editor membership changes fail; key scope and capability intersect live membership; deleting a key or revoking membership prevents activation by an already-claimed job.
4. **Read isolation:** private facts, thoughts, entities, history, direct IDs, core, recent, timeline, hybrid/keyword/vector results, documents, pages, sources, observations, citations, and hydration never cross space boundaries.
5. **T8 - Destination:** explicit authorized space wins, a writable configured default is used, no configured default uses Personal, an invalid configured default errors, and joining or creating a shared space never redirects a legacy write.
6. **T12 - Repeated lab:** two lab events with the same measured value on different dates remain two observations; `latest_observation` returns the later event.
7. **T12 - Out-of-order and unknown dates:** importing an older lab after a newer one does not change the latest result; history orders by occurrence time; undated events are preserved, excluded from latest, and disclosed.
8. **Vehicle service:** `latest_event` selects the latest service for the requested vehicle, not another vehicle or the most recently imported document, and returns field evidence.
9. **Exact values:** decimal round-trip and sum are exact; money does not add unlike currencies; unsupported or ambiguous units are excluded and reported.
10. **Coverage and resumable totals:** complete no-match, incomplete no-match, stale coverage, known gap, pending job, failed job, and partial total produce distinct results; a correction during a resumed sum does not change its snapshot.
11. **T13 - Scoped idempotency:** identical source URI/hash in two accounts or spaces remains independent; identical retry creates no duplicate; reused request ID with changed body conflicts; a new request ID plus changed bytes for the same source creates a revision.
12. **T15 - Source lifecycle:** correction retains the logical event ID, replaces active versioned views, and preserves authorized evidence/history; source disappearance labels availability; explicit forget removes derived/index/cache/queued content and prevents automatic resurrection; a failed replacement leaves the prior generation stale and visible.
13. **Lease primitive:** crash after claim, stale lease, overlapping claim, stale worker write, retry, and crash after staging produce no duplicate observation or partial active generation. The real-worker/cursor recovery gate is T17 in Phase 2.
14. **Bounded text:** authorized text POST creates a ready, searchable document; oversized or malformed input fails before admission; cross-space or unbound-account post fails; no network is used.
15. **T14 - Embedding compatibility:** current fingerprint is backfilled without vector changes; mismatched fingerprints never merge; failed staged migration leaves the active profile unchanged; exact/keyword fallback works with embedding calls disabled.
16. **T16 - Desktop without worker/source:** after activation, the desktop MCP returns the stored value and evidence while worker execution is disabled and the original URI is marked unavailable; original-link availability is reported separately.

Repository checks for each PR are `pnpm lint`, `pnpm check-types`, `pnpm test:once`, and `pnpm build`, plus `git diff --check`. Lint warnings already present in the base are recorded rather than silently attributed to a Phase 1 change.

## 11. PR and tracker sequence

The existing P1 tracker IDs remain stable, but their scope and dependencies change as follows. P1-7 and P1-8 are new because exact records and the family lifecycle are too large to hide inside the original schema/auth rows.

| Tracker ID | Revised contents                                                                                                                                                                                                                | Depends on          | Acceptance focus                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| **P1-1**   | Spaces, memberships, settings, optional `spaceId` on entities/facts/thoughts, personal-space backfills and count queries                                                                                                        | P0 repository setup | Migration tests; no legacy sharing                                                             |
| **P1-2**   | Required `spaceId`; principal/capability/role guards; API-key capability/space scopes; write destination; complete existing read/write inventory                                                                                | P1-1                | Isolation, revocation, reader/editor/owner, hydration and direct-ID tests                      |
| **P1-3**   | Source accounts and ingest-key source scopes; source items/revisions/text versions, generations, pages/evidence, documents/chunks, jobs, coverage, lifecycle, cursor and lease primitives; read tools backed by synthetic seeds | P1-2                | Immutable provenance, fencing, logical activation, forget/unavailable behavior, coverage reads |
| **P1-4**   | Current-model embedding fingerprint/profile/generation; compatibility filters and exact/keyword fallback; no model switch                                                                                                       | P1-3                | Existing vectors unchanged; incompatible vectors never mix                                     |
| **P1-7**   | Versioned lab and vehicle event/observation schemas plus deterministic `query_records` and coverage semantics                                                                                                                   | P1-3                | Repeated/out-of-order labs, latest service, exact decimal/money/unit behavior                  |
| **P1-5**   | Authenticated bounded inline-text `POST /api/ingest`, inline worker using lease/stage/activate, enqueue-only `ingest_url`                                                                                                       | P1-3, P1-4, P1-7    | Ready searchable text, idempotency, crash recovery, no network                                 |
| **P1-8**   | Minimal shared-space create/invite/pending-acceptance/owner-approval/members/roles/default-space/API-key-scope desktop UI and web API                                                                                           | P1-2, P1-3          | Two logged-in identities complete family workflow                                              |
| **P1-6**   | Public self-hosting and contributor docs, environment/config limits, synthetic demo and Phase 2 boundary                                                                                                                        | P1-5, P1-8          | Clean clone can run tests/demo without private files                                           |

P1-2 and P1-3 are authorization and durability boundaries and require second-model review. P1-7 requires schema/semantics review. Each PR updates this plan if implementation reveals a contract change; a tracker `next_action` must name any migration command actually run and its result.

## 12. Phase 2 entry gate

Phase 2 can add real connectors, OCR, model extraction, heartbeat/notifications, expired-cursor full reconciliation, and real-corpus embedding/chunk benchmarks after T8 and T12-T16 pass. Native-mobile validation remains an independent P2-priority lane with its own M1 test and does not gate Phase 2.

Before bulk or owner-data ingestion, Phase 2 must also pass T17 for real-worker crash/cursor recovery and T18 by proving backup/export plus full connector restore into an isolated deployment. Start from the upstream export at pinned commit `0534744fdb7f366d38e89e44c82f3da22ae4c958` and assess how to extend it for the records below; do not build a second generic exporter by default. The restore includes spaces and memberships, structured records, source identities and immutable revisions, evidence, active-generation pointers, coverage/gaps, configuration fingerprints, and credential-recovery instructions. Cloud sync alone is not the restore test.

## 13. Critical existing files

- `packages/convex/convex/schema.ts`
- `packages/convex/convex/lib/mcpAuth.ts`
- `packages/convex/convex/lib/webAuth.ts`
- `packages/convex/convex/models/apiKeys/`
- `packages/convex/convex/models/facts/model.ts`
- `packages/convex/convex/models/facts/validators.ts`
- `packages/convex/convex/models/thoughts/actions.ts`
- `packages/convex/convex/models/thoughts/helpers.ts`
- `packages/convex/convex/models/thoughts/memoryLifecycle.ts`
- `packages/convex/convex/models/thoughts/private.ts`
- `packages/convex/convex/models/thoughts/mcpActions.ts`
- `packages/convex/convex/models/thoughts/mcpQueries.ts`
- `apps/web/src/app/api/mcp/route.ts`
- `apps/web/src/lib/mcp/auth.ts`
- `apps/web/src/lib/mcp/convex-auth.ts`
- `apps/web/src/lib/mcp/server.ts`
- `apps/web/src/lib/mcp/tools.ts`
- `apps/web/src/lib/mcp/tool-policy.ts`
