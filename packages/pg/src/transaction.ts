// One transaction, with the schema pinned inside it.
//
// Extracted from the finance archive's `pgStore.ts` (P2-39a) because the brain
// schema needs the same three guarantees and a second copy of them is a second
// place for them to drift:
//
//   - A schema name is interpolated into DDL and into `SET LOCAL search_path`,
//     where a bind parameter is not allowed, so it is validated to a plain
//     lowercase identifier rather than quoted and hoped about.
//   - `search_path` is pinned *inside* the transaction. Both schemas live
//     behind a pooled endpoint, where a `SET search_path` issued outside a
//     transaction can be gone by the next one, and a pooler may hand the next
//     transaction a different backend connection entirely.
//   - The helper nests: an inner call on a client already inside one of these
//     transactions joins it rather than opening a second. That reentrancy is
//     what lets two operations each be atomic on their own and atomic
//     together, from one BEGIN, with no caller left to remember a rule.
//
// Nothing here is finance- or brain-specific. The schema name is the only
// difference between the two callers.

import type pg from "pg";

/** Any connection a transaction can run on: a `Client` or a pooled client. */
export type SchemaClient = pg.ClientBase;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Validates a schema name to a plain lowercase identifier. Anything else is a
 * configuration error, not something to escape.
 *
 * `label` only names the caller in the message ("archive", "kith"), so each
 * component's failure still reads as its own.
 */
export function assertPgSchemaName(name: string, label = "Postgres"): string {
  if (!SCHEMA_NAME.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a usable ${label} schema name; ` +
        "use lowercase letters, digits and underscores, starting with a letter or underscore",
    );
  }
  return name;
}

/** The schema each connection was opened against. */
const pinnedSchemas = new WeakMap<object, string>();

/** Records the schema a connection resolves unqualified objects in. */
export function pinSchema(
  client: object,
  schema: string,
  label?: string,
): string {
  const name = assertPgSchemaName(schema, label);
  pinnedSchemas.set(client, name);
  return name;
}

/** The schema a connection was pinned to, or undefined when nothing pinned it. */
export function pinnedSchemaOf(client: object): string | undefined {
  return pinnedSchemas.get(client);
}

/** Clients currently inside a `withSchemaTransaction` block. */
const openTransactions = new WeakSet<object>();

/**
 * Per-transaction settings a caller may add to the `BEGIN`. All optional, and
 * omitting every one of them emits exactly `BEGIN` plus the `search_path`
 * pin, which is what the finance archive has always issued.
 *
 * `SERIALIZABLE` is the brain's replacement for a Convex mutation's atomicity
 * (the consolidation plan, section 2.4), and the timeouts bound how long one
 * ported mutation may hold locks. They are `SET LOCAL`, so they die with the
 * transaction rather than leaking into the next one the pooler hands out.
 */
export type SchemaTransactionOptions = {
  isolation?: "SERIALIZABLE" | "REPEATABLE READ" | "READ COMMITTED";
  /**
   * Adds `READ ONLY` to the `BEGIN`, so the *server* refuses a write in this
   * transaction with SQLSTATE 25006 rather than the application promising not
   * to issue one.
   *
   * That distinction is the whole point. A read path is read-only because a
   * reviewer can see the `BEGIN`, not because every statement under it was
   * audited, and the refusal arrives at the statement that broke the rule
   * instead of as a row that should not exist.
   */
  readOnly?: boolean;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
};

function positiveInteger(value: number, setting: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${setting} must be a positive whole number of milliseconds`,
    );
  }
  return value;
}

/**
 * Runs `body` inside one transaction with `schema` pinned, and nests: an inner
 * call on a client already inside one joins it rather than opening a second.
 *
 * A nested call ignores `options`: the outer transaction has already begun, so
 * its isolation level and timeouts are the ones in force. Anything else would
 * silently claim a stronger guarantee than the transaction actually has.
 *
 * `readOnly` nests the same way and in the same direction. An inner read-only
 * block inside an outer read-write transaction does not become read-only, so a
 * caller must not treat nesting as a sandbox that takes write access away from
 * the work inside it; only the outermost `BEGIN` decides. The reverse cannot
 * happen, because the server refuses every write under a read-only transaction
 * whether or not the code issuing it knew it was there.
 */
export async function withSchemaTransaction<T>(
  client: SchemaClient,
  schema: string,
  body: (client: SchemaClient) => Promise<T>,
  options: SchemaTransactionOptions = {},
): Promise<T> {
  const name = assertPgSchemaName(schema);
  if (openTransactions.has(client)) return body(client);
  openTransactions.add(client);
  // `BEGIN [ISOLATION LEVEL <level>] [READ ONLY]`: both modes are closed
  // allowlists in this file, never caller text, so neither is interpolated
  // from anything a request can reach.
  const modes = [
    options.isolation ? `ISOLATION LEVEL ${options.isolation}` : "",
    options.readOnly ? "READ ONLY" : "",
  ]
    .filter((mode) => mode !== "")
    .join(" ");
  await client.query(modes === "" ? "BEGIN" : `BEGIN ${modes}`);
  try {
    // The schema name is a validated identifier, which is why it can be
    // interpolated where a bind parameter is not allowed.
    await client.query(`SET LOCAL search_path TO ${name}`);
    if (options.statementTimeoutMs !== undefined) {
      await client.query(
        `SET LOCAL statement_timeout = '${positiveInteger(options.statementTimeoutMs, "statement_timeout")}ms'`,
      );
    }
    if (options.lockTimeoutMs !== undefined) {
      await client.query(
        `SET LOCAL lock_timeout = '${positiveInteger(options.lockTimeoutMs, "lock_timeout")}ms'`,
      );
    }
    if (options.idleInTransactionTimeoutMs !== undefined) {
      await client.query(
        `SET LOCAL idle_in_transaction_session_timeout = '${positiveInteger(options.idleInTransactionTimeoutMs, "idle_in_transaction_session_timeout")}ms'`,
      );
    }
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    openTransactions.delete(client);
  }
}

/** True while `client` is inside a `withSchemaTransaction` block. */
export function inSchemaTransaction(client: object): boolean {
  return openTransactions.has(client);
}
