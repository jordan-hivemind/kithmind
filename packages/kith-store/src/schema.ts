// The `kith` schema: where it lives, how it is applied, and how a caller opens
// a transaction on it.
//
// Section 2.1 of docs/plans/2026-09-12-postgres-consolidation.md puts the brain
// in a `kith` schema beside `finance` in the same database. Two schemas rather
// than one merged schema, because `documents`, `spaces` and `retained_texts`
// collide outright; and one database rather than two, because one transaction
// spanning a finance row and a brain row is the single benefit that motivated
// the move.
//
// The runner below mirrors the finance archive's `applyPgSchema`: a version
// table read schema-qualified, an advisory lock so a second creator waits
// rather than collides, one transaction for the whole apply, and additive
// migrations rather than edits to what an existing database already has. It is
// stricter in one way the prototype earned: the recorded versions must be
// contiguous from 1, so a half-rolled-back schema is refused loudly instead of
// being migrated from a version it is not actually at.
//
// The schema name is fixed rather than configurable. Every statement in this
// package is schema-qualified (`kith.documents`, never `documents`), which is
// what stops a co-located component's `documents` or `schema_version` from
// answering for the brain's. A test gets its isolation from a throwaway
// database, not from a throwaway schema name.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";
import {
  applyReaderRole,
  pinSchema,
  withSchemaTransaction,
  type ReaderRoleOptions,
  type ReaderRoleSummary,
} from "@repo/pg";

import { ProofError } from "./errors.js";

/** The schema every object in this package lives in. */
export const KITH_SCHEMA = "kith";

/** Domains the schema creates, whose USAGE is granted to PUBLIC by default. */
export const KITH_DOMAINS = ["kith_id"] as const;

/** One versioned, additive step. */
export type KithMigration = {
  readonly version: number;
  readonly name: string;
  readonly url: URL;
};

/** Every migration, in order. The last one's version is the current schema. */
export const KITH_MIGRATIONS: readonly KithMigration[] = Object.freeze([
  {
    version: 1,
    name: "initial kith schema: spaces, api keys, documents, generations, evidence",
    url: new URL("../migrations/001_init.sql", import.meta.url),
  },
  {
    version: 2,
    name: "worker_jobs: leased work with a fence epoch",
    url: new URL("../migrations/002_worker_jobs.sql", import.meta.url),
  },
  {
    version: 3,
    name: "kith_id: the preserved-text primary key convention",
    url: new URL("../migrations/003_kith_id.sql", import.meta.url),
  },
  {
    version: 4,
    name: "@repo/kith-migrate's Convex-mapped tables (P2-39b)",
    url: new URL("../migrations/004_kith_migrate_tables.sql", import.meta.url),
  },
  {
    version: 5,
    name: "provenance and documents: retire the synthetic proof tables, free documents/source_revisions/chunks (P2-39d)",
    url: new URL("../migrations/005_provenance_documents.sql", import.meta.url),
  },
  {
    version: 6,
    name: "identity: plain spaces and api_keys names, domain constraints, sessions (P2-39c)",
    url: new URL("../migrations/006_identity.sql", import.meta.url),
  },
  {
    version: 7,
    name: "source_items.card_doc_type and chunks.text_search: columns kith-migrate's snapshot lacked (P2-39d2)",
    url: new URL(
      "../migrations/007_parsed_staging_documents.sql",
      import.meta.url,
    ),
  },
  {
    version: 8,
    name: "worker protocol: scan, discovery and receipt constraints and indexes (P2-39e)",
    url: new URL("../migrations/008_worker_protocol.sql", import.meta.url),
  },
  {
    version: 9,
    name: "memory: entities, facts and thoughts domain constraints and indexes (P2-39h)",
    url: new URL("../migrations/009_memory.sql", import.meta.url),
  },
  {
    version: 10,
    name: "worker processing: parsed staging constraints and lease claim indexes (P2-39e)",
    url: new URL("../migrations/010_worker_processing.sql", import.meta.url),
  },
  {
    version: 11,
    name: "record staging: stable identity and generation lookup indexes (P2-39f2)",
    url: new URL("../migrations/011_record_staging.sql", import.meta.url),
  },
  {
    version: 12,
    name: "record query sessions: bounded active and visibility lookups (P2-39f4)",
    url: new URL(
      "../migrations/012_record_query_sessions.sql",
      import.meta.url,
    ),
  },
  {
    version: 13,
    name: "record coverage: validated windows, gaps and bounded lookup indexes (P2-39f5)",
    url: new URL("../migrations/013_record_coverage.sql", import.meta.url),
  },

  {
    version: 14,
    name: "record queries: bounded candidate scan indexes (P2-39f5)",
    url: new URL("../migrations/014_record_queries.sql", import.meta.url),
  },
  {
    version: 15,
    name: "embedding search: pgvector column, scope indexes, thought and fact tsvector columns (P2-39g1)",
    url: new URL("../migrations/015_embedding_search.sql", import.meta.url),
  },
]);

/** The version the schema reaches once every migration has been applied. */
export const KITH_SCHEMA_VERSION =
  KITH_MIGRATIONS[KITH_MIGRATIONS.length - 1]!.version;

/**
 * The key two concurrent creators contend on. Distinct from the finance
 * archive's own creation and write locks: applying one schema must not block
 * applying or writing the other.
 */
export const KITH_SCHEMA_LOCK_KEY = 4_119_239_002;

/**
 * The recorded version of the brain schema, or 0 when this database has none.
 * Qualified deliberately: another component's `schema_version` in the same
 * database must never answer this question.
 */
export async function kithSchemaVersion(
  client: pg.ClientBase,
): Promise<number> {
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${KITH_SCHEMA}.schema_version`],
  );
  if (!present.rows[0]?.present) return 0;
  const result = await client.query<{ version: string | null }>(
    `SELECT max(version)::text AS version FROM ${KITH_SCHEMA}.schema_version`,
  );
  return Number(result.rows[0]?.version ?? 0);
}

async function recordedVersions(client: pg.ClientBase): Promise<number[]> {
  const result = await client.query<{ version: number }>(
    `SELECT version::int AS version FROM ${KITH_SCHEMA}.schema_version ORDER BY version`,
  );
  return result.rows.map((row) => row.version);
}

/**
 * Creates the `kith` schema if it is absent, applies every migration the
 * recorded version says is missing, and records each one it applied. Running it
 * again is a no-op returning the recorded version.
 *
 * One transaction, so the schema arrives whole or not at all, and one advisory
 * lock, so a second creator waits rather than failing on a shared catalog row.
 */
export async function applyKithSchema(client: pg.ClientBase): Promise<number> {
  pinSchema(client, KITH_SCHEMA, "kith");
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      KITH_SCHEMA_LOCK_KEY,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${KITH_SCHEMA}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${KITH_SCHEMA}.schema_version (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      )`);
    const versions = await recordedVersions(client);
    // Contiguous from 1, or this database is not at any version this build can
    // migrate from. A gap means something deleted history or an apply was
    // interrupted outside a transaction, and guessing is how a schema gets
    // half-applied twice.
    if (versions.some((version, index) => version !== index + 1)) {
      throw new ProofError("schema_history_invalid");
    }
    let current = versions.at(-1) ?? 0;
    if (current > KITH_SCHEMA_VERSION) throw new ProofError("schema_too_new");
    for (const migration of KITH_MIGRATIONS) {
      if (migration.version <= current) continue;
      if (migration.version !== current + 1)
        throw new ProofError("schema_version_gap");
      await client.query(await readFile(fileURLToPath(migration.url), "utf8"));
      await client.query(
        `INSERT INTO ${KITH_SCHEMA}.schema_version (version, name) VALUES ($1, $2)`,
        [migration.version, migration.name],
      );
      current = migration.version;
    }
    const applied = await recordedVersions(client);
    if (
      current !== KITH_SCHEMA_VERSION ||
      applied.length !== KITH_MIGRATIONS.length ||
      applied.some((version, index) => version !== index + 1)
    ) {
      throw new ProofError("schema_version_incomplete");
    }
    await client.query("COMMIT");
    return KITH_SCHEMA_VERSION;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * A pool against the brain's pooled endpoint.
 *
 * No `search_path` in the startup packet: a transaction-pooled endpoint refuses
 * the connection outright with "unsupported startup parameter in options", and
 * a session-level `SET` can be gone by the next transaction because the pooler
 * may hand it a different backend. `withKithTransaction` pins the path with
 * `SET LOCAL` as the first statement after `BEGIN` instead, which is scoped to
 * the one transaction that needs it. `pinSchema` here is bookkeeping only -- a
 * WeakMap entry, not a statement -- so it carries no session state a pooler
 * could scramble.
 *
 * `max` defaults to 2: section 2.8 puts one to two connections per serverless
 * instance, because a hosted endpoint's connection budget is shared with the
 * finance archive and the worker host.
 */
export function createKithPool(connectionString: string, max = 2): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pinSchema(pool, KITH_SCHEMA, "kith");
  pool.on("connect", (client) => {
    pinSchema(client, KITH_SCHEMA, "kith");
  });
  return pool;
}

/** Wall clock one ported mutation may spend in a single statement. */
export const KITH_STATEMENT_TIMEOUT_MS = 5_000;
/** How long it waits on a lock before giving up rather than queueing. */
export const KITH_LOCK_TIMEOUT_MS = 2_000;
/** How long a transaction of ours may sit idle before the server ends it. */
export const KITH_IDLE_TRANSACTION_TIMEOUT_MS = 5_000;
/**
 * Attempts a serialization failure is retried before it becomes an error.
 *
 * Five, with the growing delay below, because the retry budget has to outlast
 * a contending transaction on a loaded machine. The two failures that sized
 * it: two writers colliding on every attempt with no delay between them, and
 * a writer whose conflicting transaction was still open through three
 * immediate retries on a CI runner where a commit round trip takes tens of
 * milliseconds. Three attempts with a 10 ms base gave at most about 30 ms of
 * total waiting, which is less than one such commit. Five attempts over the
 * schedule below wait up to about 750 ms in total, still far inside the lock
 * and statement timeouts, and only a conflicting request pays any of it.
 */
export const KITH_SERIALIZATION_ATTEMPTS = 5;

/** Base delay before the first retry. Doubles per attempt, with full jitter. */
export const KITH_SERIALIZATION_BACKOFF_BASE_MS = 25;

/**
 * Upper bound on the backoff delay. Well under `KITH_LOCK_TIMEOUT_MS` (2s) and
 * `KITH_STATEMENT_TIMEOUT_MS` (5s), so a retry's wait is never what turns a
 * conflict into a timeout.
 */
export const KITH_SERIALIZATION_BACKOFF_MAX_MS = 400;

/**
 * The delay before retrying after the attempt-th failure: full jitter (a
 * uniform draw over `[0, cap]`, not just the doubled value itself) over
 * `base * 2^(attempt - 1)`, capped at `KITH_SERIALIZATION_BACKOFF_MAX_MS`.
 *
 * Full jitter, specifically, because the failure this exists to fix was two
 * concurrent upserts retried in lockstep: equal delays put both attempts back
 * on the same clock tick, so they collided again on every retry. Spreading
 * the delay is what actually separates them.
 */
export function kithSerializationBackoffDelayMs(attempt: number): number {
  const cap = Math.min(
    KITH_SERIALIZATION_BACKOFF_MAX_MS,
    KITH_SERIALIZATION_BACKOFF_BASE_MS * 2 ** (attempt - 1),
  );
  return Math.random() * cap;
}

type Sleep = (ms: number) => Promise<void>;

const defaultKithSerializationSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let kithSerializationSleep: Sleep = defaultKithSerializationSleep;

/**
 * Test-only hook: replaces the delay `withKithTransaction` awaits between
 * retries, so a test can observe that a delay happened (or make it
 * instant) without a real timer. Returns a function that restores the
 * previous sleep, for a test to call in `t.after` and avoid leaking the
 * override into whatever runs next in the same process.
 */
export function setKithSerializationSleep(sleep: Sleep): () => void {
  const previous = kithSerializationSleep;
  kithSerializationSleep = sleep;
  return () => {
    kithSerializationSleep = previous;
  };
}

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "40001"
  );
}

/**
 * One ported mutation: one `SERIALIZABLE` transaction on one checked-out
 * client, retried a bounded number of times on a serialization failure, with
 * a randomized backoff between attempts.
 *
 * Section 2.4's replacement for a Convex mutation's atomicity. `SERIALIZABLE`
 * can abort a transaction Convex would have serialized for us, so the retry is
 * not optional -- and it is bounded, because past three attempts the honest
 * answer is a typed conflict rather than an unbounded wait. Every write path
 * behind this must therefore be idempotent, which the receipt tables are what
 * provide.
 *
 * The backoff (`kithSerializationBackoffDelayMs`) exists because two
 * concurrent writers retried with no delay at all just collide again: under
 * the full parallel test suite, two upserts on the same identity failed on
 * every one of the three attempts, each retry landing back on the other
 * transaction's snapshot. The delay is skipped on the final attempt, since
 * nothing retries after it, and it runs after the client is released, so a
 * retry's wait never holds a pool connection idle.
 *
 * A fresh client per attempt, from the pool: a rolled-back transaction's client
 * is reusable, but taking a fresh one keeps a retry from inheriting anything the
 * failed attempt left set.
 */
export async function withKithTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= KITH_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const client = await pool.connect();
    try {
      return await withSchemaTransaction(
        client,
        KITH_SCHEMA,
        (inner) => work(inner as pg.PoolClient),
        {
          isolation: "SERIALIZABLE",
          statementTimeoutMs: KITH_STATEMENT_TIMEOUT_MS,
          lockTimeoutMs: KITH_LOCK_TIMEOUT_MS,
          idleInTransactionTimeoutMs: KITH_IDLE_TRANSACTION_TIMEOUT_MS,
        },
      );
    } catch (error) {
      if (
        !isSerializationFailure(error) ||
        attempt === KITH_SERIALIZATION_ATTEMPTS
      )
        throw error;
    } finally {
      client.release();
    }
    // Only reached when the catch above found a serialization failure with
    // attempts left: the client is already back in the pool, so this wait
    // does not hold a connection idle while it runs.
    await kithSerializationSleep(kithSerializationBackoffDelayMs(attempt));
  }
  throw new ProofError("transaction_retry_exhausted");
}

/**
 * `kith_reader`: the read-only role for owner SQL exploration, created through
 * the same code path as `finance_reader` (`@repo/pg`). The privilege state, and
 * the seventeen attacks it has to refuse, are proven by the finance archive's
 * `test/pgReaderRole.test.mjs` against a real server over this same code.
 *
 * Re-running it is the documented step after a migration adds a table: nothing
 * new is readable until someone deliberately re-runs this.
 */
export async function applyKithReaderRole(
  client: pg.ClientBase,
  options: Omit<ReaderRoleOptions, "schema" | "domains">,
): Promise<ReaderRoleSummary> {
  return applyReaderRole(client, {
    ...options,
    schema: KITH_SCHEMA,
    domains: KITH_DOMAINS,
  });
}
