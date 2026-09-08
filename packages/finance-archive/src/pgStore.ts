// Connecting to the hosted archive, and pinning how the driver decodes it.
//
// node-postgres decodes result columns by PostgreSQL type OID. Its current
// default for NUMERIC is already "hand back the text", which is correct, and
// that is exactly why it is pinned here rather than relied on: a default is a
// choice someone else can change in a minor release, and a driver that
// silently started returning a float for NUMERIC would reintroduce the
// failure the type was chosen to prevent, quietly and everywhere at once.
// `test/pgMoney.test.mjs` asserts the pin, with no database required.
//
// INT8 is pinned for the same reason: counts and sums of counts cross 2^53.
//
// DATE is pinned for the same shape of reason with a different hazard. The
// driver's default turns a DATE into a JavaScript Date at local midnight, and
// reading the day back out of one shifts by a day west of UTC. Every date in
// this archive is an ISO YYYY-MM-DD string end to end -- it is what the
// reconciliation gates pair periods on and compare, and what a locator cites
// -- so a Date object is the same class of silent damage for a date that a
// float is for an amount.

import pg from "pg";

/** Type OIDs whose decoding this package refuses to leave to a default. */
export const PINNED_TEXT_OIDS: readonly number[] = Object.freeze([
  pg.types.builtins.NUMERIC,
  pg.types.builtins.INT8,
  pg.types.builtins.DATE,
]);

/**
 * What the importer and both gates write through. Deliberately node-postgres'
 * own client type rather than an interface of this package's own: there is
 * exactly one implementation, and a one-implementation interface would buy
 * nothing but a layer to keep in sync. A `Client` and a pooled client both
 * satisfy it, which is all the substitution this package actually needs.
 */
export type ArchiveClient = pg.ClientBase;

/** Hands the wire text back untouched. Never `parseFloat`, never `Number`. */
const decodeAsText = (value: string): string => value;

/**
 * Installs the pinned decoders. Idempotent, and called at module load so
 * importing this package is enough; exported so a test can assert the pin
 * rather than trust it.
 */
export function pinNumericDecoding(): void {
  for (const oid of PINNED_TEXT_OIDS) {
    pg.types.setTypeParser(oid, decodeAsText);
  }
}

pinNumericDecoding();

/** True when the driver would hand this OID back as text, unparsed. */
export function decodesAsText(oid: number): boolean {
  return pg.types.getTypeParser(oid) === decodeAsText;
}

/**
 * The connection string, from the environment and nowhere else. There is no
 * default, the same rule `FINANCE_ARCHIVE_DB_PATH` and
 * `FINANCE_ARCHIVE_RAW_TREE_ROOT` already follow: a missing setting is a hard
 * error that names what is missing. A connection string never enters this
 * repository, and a guessed default would let a misconfigured client open
 * whatever database happens to answer.
 */
export function archiveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.FINANCE_ARCHIVE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "FINANCE_ARCHIVE_DATABASE_URL is not set. Point it at the archive database; " +
        "that connection string is never committed and this package never defaults to one.",
    );
  }
  return url;
}

/** A pool against the archive, with decoding pinned before the first query. */
export function createArchivePool(url: string = archiveDatabaseUrl()): pg.Pool {
  pinNumericDecoding();
  return new pg.Pool({ connectionString: url });
}

/**
 * The key every archive writer contends on. "Single writer by convention is
 * not a publication boundary" (the plan): a second import running against the
 * same archive is excluded by the database rather than by everyone
 * remembering that only the always-on machine imports. Transaction-scoped, so
 * it is released by COMMIT or ROLLBACK and never leaks past a crashed run.
 *
 * Distinct from `pgSchema.ts`'s creation lock: schema creation and an import
 * are different exclusions and must not block each other by accident.
 */
export const ARCHIVE_WRITE_LOCK_KEY = 4_119_205_002;

/** Takes the archive write lock for the rest of the current transaction. */
export async function lockArchiveForWrite(
  client: ArchiveClient,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [
    ARCHIVE_WRITE_LOCK_KEY,
  ]);
}

/** Clients currently inside a `withArchiveTransaction` block. */
const openTransactions = new WeakSet<object>();

/**
 * Runs `body` inside one archive transaction, and nests: an inner call on a
 * client already inside one joins it rather than opening a second.
 *
 * That reentrancy is the whole publication mechanism. An import and both
 * reconciliation gates each need to be atomic on their own -- a gate re-run
 * after a correction is a normal operation -- and they also need to be atomic
 * *together*, or a reader can see new transactions against the previous
 * verdict, which is exactly the confidently-wrong answer the gates exist to
 * prevent. Nesting gives both from one BEGIN, with no caller left to remember
 * a rule.
 */
export async function withArchiveTransaction<T>(
  client: ArchiveClient,
  body: (client: ArchiveClient) => Promise<T>,
): Promise<T> {
  if (openTransactions.has(client)) return body(client);
  openTransactions.add(client);
  await client.query("BEGIN");
  try {
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
