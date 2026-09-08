# PostgreSQL document publication proof

Status: isolated prototype. This package does not replace the deployed backend
or the finance archive.

## Scope

`@repo/postgres-proof` exercises one bounded document lifecycle against a real
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
[`001_init.sql`](../packages/postgres-proof/migrations/001_init.sql), with worker
state added by
[`002_worker_jobs.sql`](../packages/postgres-proof/migrations/002_worker_jobs.sql).
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

## Verification

The default repository test remains independent of Docker:

```sh
pnpm --filter @repo/postgres-proof test:once
```

The explicit integration command requires Docker and fails if Docker or the
pinned image is unavailable:

```sh
pnpm --filter @repo/postgres-proof test:integration
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

| Command                                               | Result                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm --filter @repo/postgres-proof check-types`      | Passed                                                                                  |
| `pnpm --filter @repo/postgres-proof test:once`        | 3 passed                                                                                |
| `pnpm --filter @repo/postgres-proof test:integration` | 1 passed against two real isolated PostgreSQL 18 servers, including subprocess recovery |

## Remaining parity work

This prototype does not implement OAuth/session migration, the web query layer,
the real finance adapter and ledger, production worker orchestration or
scheduling, vector or full-text ranking parity, provider archive integration,
production recovery keys, observability, or deployment. Serializable
transactions retry at most three times, but a broader API retry/backoff policy
is not defined. It does not benchmark performance. Those remain explicit gates
before choosing or cutting over to PostgreSQL.
