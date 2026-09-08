# Unified database and managed archive assessment

Status: proposed architecture, not a migration authorization or completed implementation.
Assessed 2026-09-08 against main `3750ff1` and finance draft PR54 `898bc30`, with coordination amendments after `237ad23`.

## Decision being assessed

The owner wants one integrated knowledge system, a durable financial archive,
and a reproducible public implementation. Desktop usefulness comes first.
Multiple machines should use the same authoritative data. Family sharing and
mobile clients remain later delivery work, with identities and scopes reserved
now. Team boundaries are not a reason to introduce separate databases.

This assessment compares one Convex database, one PostgreSQL database, and a
permanent Convex/PostgreSQL split. It also specifies one managed Dropbox root.
Existing user filing folders remain in place and can be watched independently.

## Recommendation

Prefer one PostgreSQL database as the long-term target, subject to a small
migration proof before committing to the full port. Keep the deployed Convex
system working until that proof and a tested cutover are complete. Do not adopt
a permanent two-database design just to preserve the current division of work.

This is an architectural judgment, not a measured performance result. The main
benefits are a common relational model for accounts, documents, records and
provenance; exact database arithmetic; one consistent publication boundary;
and portable SQL export and analysis. Ordinary relational tables can express
both document metadata and financial records. Large original files stay in the
shared archive rather than being embedded in table rows.

All-Convex remains a credible lower-change alternative. If the migration proof
shows that recreating the application platform costs more ongoing maintenance
than application-level financial queries, choose it explicitly. The user's
requirement is answering financial questions, not exposing arbitrary SQL to an
assistant. SQL flexibility is an advantage, not an invented acceptance gate.

The proposed target is not “replace Convex with a connection string.” Convex is
also the current application backend. Removing it transfers those responsibilities
to our application. This is the strongest argument against the recommendation.

## Current implementation evidence

| Area | Implemented evidence | Consequence |
| --- | --- | --- |
| Shared application database | `packages/convex/convex/schema.ts`, including imported model table groups | Documents, records, jobs, membership, credentials and application data already share one database. |
| Authentication | `packages/convex/convex/auth.ts`, `lib/*Auth.ts`, `lib/spaces.ts`, and web MCP routes | User sessions, scoped credentials and revocation must survive or be deliberately replaced. A new database does not supply these automatically. |
| Publication and records | `models/ingestion`, `models/workers`, `models/records`, `models/provenance` | Generation activation, idempotency, evidence parents, leases and forgetting are domain behavior worth preserving. |
| Exact query behavior | `docs/plans/2026-09-06-record-query-contract.md` | Decimal strings, coverage, stable query snapshots and authorization on every page already have a contract. |
| Background work | `packages/convex/convex/crons.ts` and scheduler calls in ingestion/report code | Recovery, expiration and missing-worker detection need a durable scheduler replacement. |
| Search and UI | Convex search/vector indexes in schema/model tables; Convex client calls in web source | SQL search requires relevance testing. UI query hooks need an API/cache or subscription replacement. |
| Finance | `packages/finance-archive/src/schema.ts`, importer, reconciliation, MCP and raw tree | Currently SQLite-specific SQL and APIs exist. Neither proposed target is implemented for finance. |
| File processing | `packages/pipeline/src/runner.ts`, archive/catalog code and worker protocol package | Local parsing and the external worker protocol can remain, but backend identifiers and receipts must stay compatible. |
| Recovery | Native database export/restore plans and encrypted archive receipts | A PostgreSQL dump must restore the application relationships and archive references, not just equivalent row counts. |

## Options

| Criterion | One Convex database | One PostgreSQL database | Convex plus PostgreSQL |
| --- | --- | --- | --- |
| Financial exactness | Canonical strings/integer coefficients and application arithmetic; existing helpers provide a starting point | Native NUMERIC with validated decimal-string input/output; currency and rounding rules still application policy | Postgres finance arithmetic plus cross-store serialization |
| New analytical questions | Implement indexed queries and bounded aggregation operations; no SQL surface in the current Convex API | SQL joins, grouping and aggregates under validated service operations | Finance SQL works; combined questions need orchestration across stores |
| Publication consistency | Existing Convex transaction and generation model | Explicit SQL transactions, generation boundaries and retry handling | Separate revisions and lag policy; no implicit atomic commit across both |
| Search and application services | Existing indexes, scheduler, auth integration and reactive UI | Build/choose replacements and verify parity | Keep existing services, plus second database operations |
| Reproducibility | Convex has a documented self-hosted backend; not cloud-only | Standard Postgres plus the chosen application/auth/job runtime | More setup, credentials and restore instructions |
| Migration burden | Port finance storage and queries; retain main backend | Port finance and main backend; preserve worker/public contracts | Port finance and implement a versioned integration boundary |
| Ongoing operations | One application platform and archive recovery | One database plus application services and archive recovery | Two database recovery paths, integration monitoring and archive recovery |
| Best reason to choose | Fastest coherent single-store delivery with existing application services | Unified relational data and analysis with standard database tooling | Independent deployment requirements that actually outweigh integration costs |

Convex has integer, floating-point and string values rather than a native
arbitrary-precision decimal type. That does not make accurate finance impossible.
Its transaction limits require bounded ingestion and query work, which the main
system already implements. See [types](https://docs.convex.dev/database/types),
[limits](https://docs.convex.dev/production/state/limits), and
[self-hosting](https://docs.convex.dev/self-hosting).

PostgreSQL offers [NUMERIC](https://www.postgresql.org/docs/current/datatype-numeric.html),
[transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
and [full-text search](https://www.postgresql.org/docs/current/textsearch.html).
Vector search can use [pgvector](https://github.com/pgvector/pgvector), subject to
host extension support and our retrieval tests. These features do not provide
our auth gateway, query coverage rules, durable jobs or reactive UI automatically.
No cost, throughput or migration-duration claim has been benchmarked here.

## Proposed shared database boundary

Use one application database with modules or schemas for core identity, source
and document evidence, finance, jobs, and other life records. Schema names are
organizational boundaries, not sufficient permission enforcement.

- Share owner/space, source, document/revision and evidence identities. Finance
  owns transaction, position, balance, reconciliation and review semantics.
- Keep domain-specific financial tables. Do not force holdings or tax lots into
  the existing generic financial_transaction event shape.
- Preserve stable public IDs or retain an explicit old-to-new ID mapping.
  Existing citations, worker journals and immutable receipts must resolve.
- Return canonical finite decimal strings with currency/units. Keep rounding,
  significant-digit limits, deduplication preimages and unknown values explicit.
- Expose typed bounded service operations. An optional owner SQL analysis tool
  is a separate capability, not the standard MCP authorization mechanism.
- Use separate acquisition/import and read roles. Keep credentials out of
  clients and archives. Recheck application scope on every operation/page.
- Publish ledger, reconciliation result and document revision together through
  a completed generation. Long imports stage before activation.
- Keep the authenticated remote gateway so client reachability does not depend
  on a laptop database file. A hosted database alone does not enable mobile MCP.

Neon is a possible Postgres host, not an architectural requirement. Host selection
must verify extensions, connection limits, region, backup/export support and
operating cost for the actual workload. Avoid introducing another provider just
for authentication without comparing its operational burden.

## Migration proof and cutover

The proof has not been run as part of this assessment. Finance can supply its
isolated component now: F1-20 (store/schema) and F1-22 (importer/reconciliation)
use only synthetic fixtures and an isolated development database. This work
produces evidence for the decision; it does not authorize a production cutover,
real acquisition, permanent split or independently deployed financial gateway.

The finance-only component is necessary but insufficient for the whole-system
proof. Mainline owns the worker/gateway/auth/search/recovery portion below.
F1-21 gateway integration waits for the shared typed contract. F1-23 (closed
credential-free projection) and F1-24 (capture provenance) can proceed independently
and both block first real acquisition/shared capture publication. Do not duplicate
those fixes in a competing mainline writer.

Before changing stored denominations, the finance slice pins canonical decimal
strings and a versioned identity/hash policy in its schema and conversion tests.
Equivalent decimal spellings normalize before identity calculation. Preserve
stable record identity across a representation change; if hash preimages change,
use explicit versioning/mapping rather than silently treating existing records as
new. No real data is needed to test this invariant.

1. Implement one isolated PostgreSQL-backed vertical slice using synthetic
   data: document revision, retained citation, financial transaction, holding,
   reconciliation publication, and a scoped exact query through the gateway.
2. Verify rejection of unauthorized/revoked requests, mixed-currency totals,
   incomplete coverage, non-finite/rounded input, concurrent imports and stale
   generations. Exercise a correction, pagination and forgetting.
3. Reuse the existing worker wire contract for a staged document; demonstrate
   that idempotent retry and old citations still work. Test search quality on
   the existing synthetic corpus rather than assuming equivalent ranking.
4. Demonstrate job recovery after process death, frontend query refresh, and
   database plus archive restore. Select auth/session migration or explicit
   reauthentication with a bounded interruption and recovery procedure.
5. Review resulting code and required operational services against all-Convex.
   Proceed only if the unified target preserves the contracted behavior without
   an unjustified maintenance increase. Publish findings before full migration.

For a full migration: export a consistent baseline; preserve IDs and references;
import into an isolated destination; run contract tests and read-only shadow
comparisons; pause writers for final transfer; validate; switch the gateway and
workers together. Preserve a rollback snapshot. After writes begin on Postgres,
rollback requires reconciliation of those writes, not a blind switch to stale
Convex. Remove Convex only after acceptance. Temporary coexistence is a migration
phase, not a commitment to permanent dual writes.

## One managed Dropbox root

Use a configurable `KITH_ARCHIVE_ROOT`, with the suggested owner location
`Dropbox/Kith Mind`. This already accommodates the trial Inbox. Both workstreams
use the same root and layout version. Absolute machine paths stay in private
configuration. Runtime state remains under a separate protected local state root.

```text
Kith Mind/
  archive-layout.v1.json
  archive/v1/<space-id>/
    documents/<hh>/<hh>/<sha256>
    text/<hh>/<hh>/<sha256>.txt
    captures/<source-id>/<yyyy>/<mm>/<capture-id>-<manifest-sha256>.json
  backups/
    processing-artifacts/restic-v1/
    database/<engine>/restic-v1/
  Inbox/                         existing trial input, not required intake
```

`documents` contains retained acquisition payloads, including PDF, JSON and CSV.
Media type and original filename live in a manifest; filenames do not need
extensions. Hash fan-out keeps directories bounded and deduplicates exact bytes
within a space. It does not deduplicate financial events by identical amounts.
`text` is optional retained extraction evidence, addressed by its own hash.
Encrypted processing recovery repositories can retain richer parser output.
Do not add a second plaintext mirror of the same artifact just for another team.

Each immutable capture manifest uses canonical serialization and its own content
hash. Reuse of a capture ID with conflicting content requires explicit reconciliation;
a first-writer sidecar must not silently discard another acquisition association.
The manifest records schema version, opaque source/capture
identity, acquisition time, source period if known, media type, byte count,
SHA-256, artifact references, transformation versions and provenance. Multiple
captures may reference the same object: byte equality is not source identity.
Relative paths are archive locators, not cloud-accessible URLs. The database
stores stable references and indexed evidence for ordinary questions.

The existing finance writer already implements the proposed `documents` and
`text` hash layout. Use that implementation as the starting point rather than
create another content-addressed writer. Its current single sidecar per document
must be reconciled with multiple capture associations before shared use. The
current generic bytes interface also does not establish that a bank JSON payload
is credential-free. These are implementation follow-ups, not properties already
provided by the raw writer.

### Write, processing and recovery rules

- Stage and validate locally outside watched/synced roots. Persist final objects
  and immutable manifests with retry-safe identities. Dropbox multi-file sync
  is not a transaction; readers verify referenced objects and defer incomplete
  captures. A durable completed capture requires bounded Dropbox verification
  for its manifest and every referenced object, including JSON/CSV/text: bind
  remote file identity, revision, byte count and provider content hash, and verify
  retained SHA-256 through independent byte readback. Local existence or the
  sync client reporting completion is insufficient. Publication stays pending
  until these recovery receipts are present.
- Retain bank business-response JSON, not browser profiles, cookies, authorization
  headers or session tokens. Bank adapters must project a closed, allowlisted
  business payload before hashing or writing, with negative credential-leak tests.
  Acquisition adapters separate credentials from evidence. If a payload needs sanitization, record that transformation and
  the hash of the retained artifact; do not claim it is the untouched response.
- Managed originals uploaded to Dropbox need verified remote identity/revision
  and byte evidence before they satisfy provider-backed recovery requirements.
  Existing locally curated originals stay where they are and are referenced.
- Generated backups are encrypted. A second copy of an existing Dropbox source
  PDF in another Dropbox folder is not a separate recovery boundary.
- Do not recursively watch the managed root. Consumers read explicit completed
  captures or designated narrow input roots. Exclude backups and generated
  outputs to prevent ingestion loops.
- Keep journals, sockets, credentials, lock files and scratch data local. One
  designated archive writer handles acquisition initially. Dropbox conflict
  copies are errors to reconcile, not new authoritative revisions.
- Routine reprocessing never overwrites originals. Detaching an indexed source
  and deleting a managed original are separate operations. Cross-module shared
  references must be checked before any explicitly authorized deletion.
- Preserve manifests so the archive can be identified after loss of the database.
  Preserve database backups too: corrections and review decisions are not
  necessarily reconstructible from statement bytes.

### Transition from current paths

The mainline equivalent today is local archive/catalog storage plus encrypted
Dropbox processing and database backup repositories. It does not yet expose a
shared acquisition archive for other subsystems. The target above unifies those
roles without pretending that a backup repository is a raw-file intake folder.

The current `Kith Mind Backups` location is a legacy root to consolidate, not a
second permanent root in this proposal. Do not move its live repositories with
Finder: receipts/configuration pin remote paths, directory and repository
identities. First implement supported relocation or new-repository migration;
stop the worker while idle; preserve old receipts; verify readback and restore;
rebind configuration; resume and verify an unchanged pass. Retire the old root
only after all referenced recovery data is accounted for. Until that migration
is complete, the old path remains a documented temporary exception.

This assessment creates no new Dropbox folders and moves no existing artifacts.
The shared layout must be wired into both writers, verified with synthetic PDF
and JSON captures, and then configured on the owner machine.

## Ownership and acceptance

The architecture owner coordinates identity, archive layout, auth and cutover.
The finance workstream owns institution adapters and ledger correctness. The
mainline workstream owns worker compatibility, integrated queries and recovery.
PR54 should link this assessment and describe finance as the isolated component
of the shared proof. PR55 remains a proposal for the eventual platform cutover.
Finance F1-20/F1-22 may proceed within the synthetic boundary above; mainline
P2-39 owns the remaining parity proof. The shared archive task P2-38 consumes
F1-23/F1-24 rather than implementing them twice. Agreement to run the proof is
not agreement that the proof has passed.

Acceptance for the shared archive is one synthetic PDF/JSON acquisition and
mainline extraction under the same root; duplicate-byte reuse with distinct
capture provenance; successful lookup after database loss; verified remote
availability; and no new copy of an already provider-backed original. Acceptance
for database consolidation is the migration proof and cutover gates above.
