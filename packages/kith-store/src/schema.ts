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
    url: new URL(
      "../migrations/004_kith_migrate_tables.sql",
      import.meta.url,
    ),
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
/** Attempts a serialization failure is retried before it becomes an error. */
export const KITH_SERIALIZATION_ATTEMPTS = 3;

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
 * client, retried a bounded number of times on a serialization failure.
 *
 * Section 2.4's replacement for a Convex mutation's atomicity. `SERIALIZABLE`
 * can abort a transaction Convex would have serialized for us, so the retry is
 * not optional -- and it is bounded, because past three attempts the honest
 * answer is a typed conflict rather than an unbounded wait. Every write path
 * behind this must therefore be idempotent, which the receipt tables are what
 * provide.
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
