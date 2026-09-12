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
 * What every archive connection shares: decoding pinned per connection.
 * `search_path` is deliberately not set here -- see the two functions below.
 */
function archiveConnectionConfig(url: string): pg.ClientConfig {
  return {
    connectionString: url,
    types: ARCHIVE_TYPES,
  };
}

/**
 * A single direct connection to the archive, decoding and schema both
 * pinned. Unlike `createArchivePool`, this puts `search_path` in the startup
 * packet: a direct connection is never a pooled endpoint, so a session-level
 * `SET` sticks for the connection's whole life, and provisioning scripts and
 * tests rely on exactly that to issue unqualified queries outside any
 * transaction.
 */
export function createArchiveClient(
  url: string = archiveDatabaseUrl(),
  schema: string = archiveSchemaName(),
): pg.Client {
  const name = assertSchemaName(schema);
  const client = new pg.Client({
    ...archiveConnectionConfig(url),
    options: `-c search_path=${name}`,
  });
  pinArchiveSchema(client, name);
  // F1-69. node-postgres emits 'error' on a Client whose connection died out
  // from under it (the server restarting, admin_shutdown, a dropped socket)
  // -- and an 'error' event with no listener is Node's own uncaught
  // exception, which crashes the whole process, not just this client. That
  // took a real run down mid-import (57P01 admin_shutdown from a Neon
  // compute restart), losing the in-flight document and the bridge session
  // together. Attach one here, on every client this package hands out, so
  // the failure is "this connection is dead" (markClientDead/isArchiveClientDead
  // below) rather than a crash; withReconnect is what actually notices and
  // reconnects.
  client.on("error", () => markClientDead(client));
  return client;
}

/**
 * A pool against the archive, decoding and schema both pinned, for the
 * archive's pooled endpoint (PgBouncer, transaction mode in production).
 *
 * No `options` startup parameter here: a transaction-pooled endpoint hands
 * back "unsupported startup parameter in options: search_path" and refuses
 * the connection outright, before a single query runs. `withArchiveTransaction`
 * and the read surface's own read-only transaction instead pin the path with
 * `SET LOCAL` as the first statement after `BEGIN`, which is scoped to one
 * transaction and so survives a pooler handing out a different backend
 * connection than the last transaction used.
 */
export function createArchivePool(
  url: string = archiveDatabaseUrl(),
  schema: string = archiveSchemaName(),
): pg.Pool {
  const name = assertSchemaName(schema);
  const pool = new pg.Pool(archiveConnectionConfig(url));
  pinArchiveSchema(pool, name);
  // Each client the pool opens is a separate object, and it is the client
  // `withArchiveTransaction` is handed, so the pin has to reach it too. This
  // is bookkeeping only -- a WeakMap entry, not a SQL statement -- so it
  // carries no session-level state a pooler could scramble.
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

/**
 * Postgres' hard limit on bind parameters in one extended-query message. A
 * multi-row INSERT past it is refused by the server ("extended query has too
 * many parameters"), so every batched insert in this package chunks against
 * it rather than assuming a document is small.
 */
const MAX_BIND_PARAMETERS = 65_535;

/**
 * One multi-row `INSERT` per chunk instead of one statement per row (F1-51).
 *
 * The archive is hosted, and against a ~50-100 ms round trip the cost of an
 * import is the number of round trips, not the number of rows: a statement
 * carrying two hundred holdings spent about ninety seconds almost entirely
 * waiting. Nothing about the rows changes here -- the caller still builds
 * every tuple itself, in the same order, with the same values -- only how
 * many messages carry them.
 *
 * `table` and `columns` are this package's own literals, never caller input,
 * so they are interpolated where a bind parameter is not allowed.
 */
export async function insertRows(
  client: ArchiveClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  if (rows.length === 0) return;
  const perChunk = Math.max(
    1,
    Math.floor(MAX_BIND_PARAMETERS / columns.length),
  );
  for (let start = 0; start < rows.length; start += perChunk) {
    const chunk = rows.slice(start, start + perChunk);
    const values: unknown[] = [];
    const tuples = chunk.map(
      (row) =>
        `(${row
          .map((value) => {
            values.push(value);
            return `$${values.length}`;
          })
          .join(", ")})`,
    );
    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
      values,
    );
  }
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
    // Pinned inside the transaction rather than relying on a startup packet
    // or a session-level `SET`, so a pooler handing this transaction a
    // different backend than the last one still resolves archive objects
    // correctly. The schema name is a validated identifier, which is why it
    // can be interpolated where a bind parameter is not allowed.
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

// --- reconnecting after a dropped connection (F1-69) ------------------------
//
// A connection an operator run was mid-way through can die from under it:
// the server restarts (Neon's admin_shutdown, 57P01/57P02), the network
// drops (ECONNRESET/EPIPE), or any other class-08 connection exception. An
// `'error'` event with no listener is what actually took a real run's whole
// process down (see `createArchiveClient` above) -- that listener turns the
// failure into "this client is dead" instead, and `withReconnect` below is
// what a caller uses to notice that and recover: end the dead client, open a
// fresh one on the same connection string and schema, and retry.

/** Clients whose connection died out from under them -- marked by the
 * `'error'` listener `createArchiveClient` attaches. Never removed: a dead
 * client is never reused, only replaced. */
const deadClients = new WeakSet<object>();

function markClientDead(client: object): void {
  deadClients.add(client);
}

/** True once `client`'s own `'error'` listener has fired. The primary signal
 * `withReconnect` acts on -- set synchronously by the same event that also
 * rejects whatever query was in flight, so it is already true by the time a
 * caller's `await` throws, whatever shape that rejection's error takes. */
export function isArchiveClientDead(client: object): boolean {
  return deadClients.has(client);
}

/** SQLSTATE/Node error codes that mean "the connection itself is gone," not
 * "this query was refused": 57P01/57P02 (server-initiated shutdown), the
 * whole class-08 connection-exception family, and the two Node socket codes
 * a dropped TCP connection surfaces as. A secondary signal to `isArchiveClientDead`
 * above -- useful when an error reaches a caller with no chance for the
 * client's own listener to have marked it dead first (a bare client object
 * in a test, say). */
export function isConnectionLostError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return false;
  return code === "57P01" || code === "57P02" || code === "ECONNRESET" || code === "EPIPE" ||
    code.startsWith("08");
}

/** How many times `withReconnect` will still reconnect before giving up,
 * shared across every call for one run (`createReconnectBudget`). */
export type ReconnectBudget = { remaining: number; readonly max: number };

/** A fresh reconnect budget: 3 reconnects per run by default, matching the
 * bound F1-69 asks for -- past this many drops something structural is
 * broken (the database itself is down), and retrying forever would just
 * hang an operator run instead of stopping with a message they can act on. */
export function createReconnectBudget(max = 3): ReconnectBudget {
  return { remaining: max, max };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `attempt()`. On a connection-lost failure (`isArchiveClientDead` on
 * whatever `getClient()` currently returns, or `isConnectionLostError` on the
 * thrown error itself), ends that dead client, opens a fresh one on the same
 * connection string and schema (`createArchiveClient`/`connect`, the same
 * pinning every archive client gets), hands it to `setClient`, and retries
 * `attempt()` -- which the caller writes to read the client through whatever
 * closure `setClient` updates, so the retry runs against the fresh
 * connection automatically. Any other failure is rethrown as-is, not
 * retried.
 *
 * Safe to retry `attempt()` wholesale only because every caller in this
 * package wraps a single document's own import (or the whole-archive gate
 * pass), and both are idempotent: importing an already-imported document (by
 * content hash) or already-stored row (by row hash) is a no-op, and the gate
 * pass just re-derives verdicts from what is actually in the archive.
 *
 * `budget` bounds the whole run, not this one call: past `budget.max`
 * reconnects, this throws a clear error instead of trying forever against a
 * connection that keeps dropping.
 */
export async function withReconnect<T>(
  budget: ReconnectBudget,
  getClient: () => pg.Client,
  setClient: (client: pg.Client) => void,
  attempt: () => Promise<T>,
): Promise<T> {
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const client = getClient();
      if (!isArchiveClientDead(client) && !isConnectionLostError(error)) throw error;
      if (budget.remaining <= 0) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `archive connection lost and the reconnect budget (${budget.max} per run) is ` +
            `already spent; giving up rather than reconnecting again. Last error: ${message}`,
        );
      }
      budget.remaining -= 1;
      await closeArchiveClient(client);
      // A short, fixed backoff -- long enough that a server mid-restart has
      // a moment to come back, short enough that three of them is still a
      // matter of seconds, not minutes, against an operator run that can
      // already take tens of minutes.
      await sleep(250);
      const fresh = createArchiveClient(archiveDatabaseUrl(), archiveSchemaOf(client));
      await fresh.connect();
      setClient(fresh);
      const attemptNumber = budget.max - budget.remaining;
      console.error(
        `archive connection lost; reconnected on a fresh client (reconnect ${attemptNumber} of ` +
          `${budget.max} for this run)`,
      );
    }
  }
}

// --- keepalive during long non-database phases (F1-69b) ---------------------
//
// F1-69 reconnects once a query notices the connection is gone, but a phase
// with no query at all -- `discover()` walking a listing page by page for
// several minutes, all browser work, no SQL -- never gives it the chance:
// the hosted proxy in front of the archive closes a connection it has seen
// no traffic on for a while, and nothing on this side finds out until the
// next query lands on a socket that is already dead. A keepalive is the
// fix at the source: touch the connection often enough that the proxy never
// considers it idle, so there is no dead connection for the first
// post-discovery query to discover the hard way.

const KEEPALIVE_INTERVAL_MS = 60_000;

/**
 * The keepalive cadence: `FINANCE_ARCHIVE_KEEPALIVE_INTERVAL_MS` when set to
 * a positive number, 60s otherwise. Exists so a test can shrink the interval
 * to something it can actually wait out instead of proving the mechanism
 * against a real 60-second tick; nothing in this package reads it besides
 * `startKeepalive`'s own default below.
 */
function keepaliveIntervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FINANCE_ARCHIVE_KEEPALIVE_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : KEEPALIVE_INTERVAL_MS;
}

/**
 * Pings `SELECT 1` on whatever client `getClient()` currently returns, every
 * `intervalMs` (default 60s, see `keepaliveIntervalFromEnv`), until the
 * returned stop function is called. The timer is `unref`'d so it never by
 * itself keeps the process alive, and a failed ping is swallowed: the
 * keepalive's only job is to generate traffic, not to detect or recover a
 * dead connection -- `withReconnect` already owns that, against whatever
 * real query runs next. Read `getClient()` fresh on every tick (not a client
 * captured once) so a reconnect mid-phase keeps the new client alive too.
 */
export function startKeepalive(
  getClient: () => pg.Client,
  intervalMs = keepaliveIntervalFromEnv(),
): () => void {
  const timer = setInterval(() => {
    const client = getClient();
    if (isArchiveClientDead(client)) return;
    client.query("SELECT 1").catch(() => {
      // Swallowed: see doc comment above.
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
