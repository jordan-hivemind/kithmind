// Connecting to the hosted archive, and pinning how the driver decodes it.
//
// node-postgres decodes result columns by PostgreSQL type OID. Its current
// default for NUMERIC is already "hand back the text", which is correct, and
// that is exactly why it is pinned here rather than relied on: a default is a
// choice someone else can change in a minor release, and a driver that
// silently started returning a float for NUMERIC would reintroduce the
// failure the type was chosen to prevent, quietly and everywhere at once.
//
// The pin is per connection, not per process. `pg.types.setTypeParser` is
// module-global state shared by every `pg` consumer in the process, so a
// package that sets it decides how *other* people's pools decode their own
// columns. That was tolerable while this package was the only `pg` consumer
// and stops being tolerable the moment archives and other components are
// co-hosted, which is the direction of travel. `ARCHIVE_TYPES` is handed to
// each archive `Client` and `Pool` through node-postgres' own `types` config
// instead, so the guarantee reaches every archive connection and nothing
// else. `test/pgMoney.test.mjs` asserts both halves -- that an archive
// connection decodes as text, and that the process-wide parser was left
// alone -- with no database required.
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
//
// Schema resolution is pinned for a third reason of the same shape. Archive
// objects live in one named schema, never in whatever the connection's
// `search_path` happens to be, so a co-located component's `documents` or
// `schema_version` can never answer for the archive's. See `pgSchema.ts`.

import pg from "pg";

/** Type OIDs whose decoding this package refuses to leave to a default. */
export const PINNED_TEXT_OIDS: readonly number[] = Object.freeze([
  pg.types.builtins.NUMERIC,
  pg.types.builtins.INT8,
  pg.types.builtins.DATE,
]);

/** Hands the wire text back untouched. Never `parseFloat`, never `Number`. */
const decodeAsText = (value: string): string => value;

/**
 * The decoding every archive connection is opened with. Passed as
 * node-postgres' `types` config, which is per client and per pool, so it
 * never reaches another component's pool the way `setTypeParser` would.
 */
export const ARCHIVE_TYPES: pg.CustomTypesConfig = Object.freeze({
  getTypeParser: (id: number, format?: unknown) =>
    PINNED_TEXT_OIDS.includes(id)
      ? decodeAsText
      : (pg.types.getTypeParser as (i: number, f?: unknown) => unknown)(
          id,
          format,
        ),
}) as pg.CustomTypesConfig;

/** True when an archive connection hands this OID back as text, unparsed. */
export function decodesAsText(oid: number): boolean {
  return ARCHIVE_TYPES.getTypeParser(oid) === decodeAsText;
}

/**
 * The schema archive objects live in when nothing says otherwise. A dedicated
 * name rather than `public`: co-locating databases is the plan of record, and
 * `public` is where every other component's tables land by default.
 */
export const DEFAULT_ARCHIVE_SCHEMA = "finance";

/**
 * Schema names are interpolated into DDL and into `SET LOCAL search_path`,
 * where a bind parameter is not allowed, so the name is validated to a plain
 * lowercase identifier rather than quoted. Anything else is a configuration
 * error, not something to escape and hope about.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The archive schema, from the environment. `FINANCE_ARCHIVE_SCHEMA` exists
 * so one database can host more than one archive (a throwaway per test, say),
 * not so the archive can be pointed at a shared `public`.
 */
export function archiveSchemaName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return assertSchemaName(env.FINANCE_ARCHIVE_SCHEMA ?? DEFAULT_ARCHIVE_SCHEMA);
}

export function assertSchemaName(name: string): string {
  if (!SCHEMA_NAME.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a usable archive schema name; ` +
        "use lowercase letters, digits and underscores, starting with a letter or underscore",
    );
  }
  return name;
}

/** The schema each connection was opened against. */
const pinnedSchemas = new WeakMap<object, string>();

/** Records the schema a connection resolves archive objects in. */
export function pinArchiveSchema(client: object, schema: string): string {
  const name = assertSchemaName(schema);
  pinnedSchemas.set(client, name);
  return name;
}

/** The schema a connection resolves archive objects in. */
export function archiveSchemaOf(client: object): string {
  return pinnedSchemas.get(client) ?? archiveSchemaName();
}

/**
 * The connection string, from the environment and nowhere else. There is no
 * default, the same rule `FINANCE_ARCHIVE_READER_DATABASE_URL` and
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

/**
 * What the importer and both gates write through. Deliberately node-postgres'
 * own client type rather than an interface of this package's own: there is
 * exactly one implementation, and a one-implementation interface would buy
 * nothing but a layer to keep in sync. A `Client` and a pooled client both
 * satisfy it, which is all the substitution this package actually needs.
 */
export type ArchiveClient = pg.ClientBase;

/**
 * How every archive connection is opened: decoding pinned per connection, and
 * `search_path` set in the startup packet so even a statement issued outside a
 * transaction resolves archive objects in the archive schema.
 *
 * The startup packet is not the whole answer, because the archive's default
 * endpoint is a pooled one, where a `SET` outside a transaction may land on a
 * backend the next transaction never sees. `withArchiveTransaction` and
 * `applyPgSchema` therefore re-pin the path with `SET LOCAL` inside their own
 * transaction, which is the part a pooler cannot take away.
 */
function archiveConnectionConfig(url: string, schema: string): pg.ClientConfig {
  return {
    connectionString: url,
    types: ARCHIVE_TYPES,
    options: `-c search_path=${schema}`,
  };
}

/** A single connection to the archive, decoding and schema both pinned. */
export function createArchiveClient(
  url: string = archiveDatabaseUrl(),
  schema: string = archiveSchemaName(),
): pg.Client {
  const name = assertSchemaName(schema);
  const client = new pg.Client(archiveConnectionConfig(url, name));
  pinArchiveSchema(client, name);
  return client;
}

/** A pool against the archive, decoding and schema both pinned. */
export function createArchivePool(
  url: string = archiveDatabaseUrl(),
  schema: string = archiveSchemaName(),
): pg.Pool {
  const name = assertSchemaName(schema);
  const pool = new pg.Pool(archiveConnectionConfig(url, name));
  pinArchiveSchema(pool, name);
  // Each client the pool opens is a separate object, and it is the client
  // `withArchiveTransaction` is handed, so the pin has to reach it too.
  pool.on("connect", (client) => {
    pinArchiveSchema(client, name);
  });
  return pool;
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
    // Re-pinned inside the transaction, so a pooler cannot hand the next
    // statement a backend that never saw the startup packet's path. The
    // schema name is a validated identifier, which is why it can be
    // interpolated where a bind parameter is not allowed.
    await client.query(`SET LOCAL search_path TO ${archiveSchemaOf(client)}`);
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

/**
 * Ends an archive connection the way a CLI's own `finally` block must: never
 * hanging, whatever state the connection is actually in.
 *
 * node-postgres' own `client.end()` resolves once the connection emits its
 * `end` event -- correct when the connection is still alive, but a
 * connection the server already closed, or one an earlier query error tore
 * down, does not reliably emit a second one. `end()` then waits forever, and
 * because a caller's `finally` block is awaiting it, whatever the caller was
 * about to do next -- print the real error, set an exit code -- never runs
 * either. That is exactly what left a real run (F1-36) idle for 26 minutes
 * with its actual transaction error never printed: the hang was silent, not
 * loud, because it happened *inside* cleanup, after the interesting error
 * had already been thrown and was simply waiting its turn.
 *
 * This races `client.end()` against `timeoutMs` instead of trusting it to
 * always settle. A connection that closes normally resolves this almost
 * immediately, same as calling `end()` directly; a connection already gone
 * resolves it about as fast (node-postgres itself short-circuits `end()`
 * once it has seen the connection's own `end`/`error` event); a connection
 * that is neither is bounded rather than open-ended. Never rejects -- a
 * failure or timeout during cleanup must not overwrite or delay whatever
 * real error the caller is already propagating.
 *
 * Takes an `EndableClient` rather than `ArchiveClient`: `pg.ClientBase`'s own
 * type declares no `end` (it belongs to `pg.Client`, which every concrete
 * archive connection this package hands out actually is), and this function
 * only ever needs the one method anyway.
 */
export type EndableClient = { end(): unknown };

export async function closeArchiveClient(
  client: EndableClient,
  timeoutMs = 5_000,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    Promise.resolve(client.end())
      .catch(() => {
        // A failure to close cleanly is not the caller's problem to
        // surface; the connection is going away either way.
      })
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}
