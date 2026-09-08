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
  retained citation, forgotten state and revoked key preserved.

The financial attachment is a cross-domain fixture. It is not a ledger,
financial importer, reconciliation model, or proof of financial query coverage.

## Boundaries

The durable schema is
[`001_init.sql`](../packages/postgres-proof/migrations/001_init.sql). The
database owner applies migrations and manages spaces and API-key lifecycle. The
application role is a non-owner without role or database creation privileges.
It receives read access plus write access only to document content and request
receipt tables. SQL identifiers are accepted only through a strict role-name
validator; data queries are parameterized.

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

| Command                                               | Result                                                   |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `pnpm --filter @repo/postgres-proof check-types`      | Passed                                                   |
| `pnpm --filter @repo/postgres-proof test:once`        | 2 passed                                                 |
| `pnpm --filter @repo/postgres-proof test:integration` | 1 passed against two real isolated PostgreSQL 18 servers |

## Remaining parity work

This prototype does not implement OAuth/session migration, the web query layer,
the real finance adapter and ledger, background leases or scheduling, vector or
full-text ranking parity, concurrent-request retry policy, provider archive
integration, production recovery keys, observability, or deployment. It does
not benchmark performance. Those remain explicit gates before choosing or
cutting over to PostgreSQL.
