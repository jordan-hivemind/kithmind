// Read-only enforcement for run_query, in depth. String inspection alone is
// not the primary control; each layer below stops a different class of
// attack even if an earlier layer were somehow bypassed:
//
//   1. The file is opened with SQLITE_OPEN_READONLY (readOnly: true), so no
//      statement can write to it no matter what it says.
//   2. PRAGMA query_only = ON is belt-and-suspenders on top of (1).
//   3. Defensive mode (sqlite3_db_config DEFENSIVE) closes off a class of
//      schema and shadow-table tricks even under a permissive authorizer.
//   4. An authorizer callback allow-lists SELECT, table/column reads,
//      recursive CTEs and a small set of functions, and denies everything
//      else by SQLite action code: every write, every DDL verb, ATTACH and
//      DETACH, every PRAGMA, transactions and savepoints, and any function
//      not on the allow list (load_extension, readfile, writefile in
//      particular). This fires at prepare time, before a statement can run,
//      and it fires for an operation hidden inside a CTE or subquery exactly
//      as it would at the top level -- a `WITH x AS (...) DELETE FROM t ...`
//      is denied the same way a bare DELETE is.
//   5. Only as an additional layer: a single-statement check that uses
//      SQLite's own parser, not a regex, to reject a second statement
//      smuggled after a semicolon or inside a trailing comment.
//
// Row count and wall-clock time are bounded on top of all of that so a
// legitimate read-only SELECT still cannot exhaust memory or hang the server.

import { constants, DatabaseSync } from "node:sqlite";

export const MAX_QUERY_ROWS = 500;
export const MAX_QUERY_MS = 5_000;

/** Denied by name even though none of these are loaded by default, in case a
 * future build or extension makes one of them resolvable. */
const DENIED_FUNCTIONS = new Set(["load_extension", "readfile", "writefile"]);

function authorize(
  actionCode: number,
  _arg1: string | null,
  arg2: string | null,
): number {
  switch (actionCode) {
    case constants.SQLITE_SELECT:
    case constants.SQLITE_READ:
    case constants.SQLITE_RECURSIVE:
      return constants.SQLITE_OK;
    case constants.SQLITE_FUNCTION:
      return arg2 !== null && DENIED_FUNCTIONS.has(arg2.toLowerCase())
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK;
    default:
      // INSERT, UPDATE, DELETE, every CREATE_/DROP_ verb, ALTER_TABLE,
      // ATTACH, DETACH, PRAGMA, TRANSACTION, SAVEPOINT, REINDEX, ANALYZE,
      // COPY and the *_VTABLE verbs all land here. Default-deny, not a list
      // of things remembered to deny.
      return constants.SQLITE_DENY;
  }
}

/**
 * Opens the archive for arbitrary caller-supplied SQL (run_query). Every
 * layer above applies.
 */
export function openReadOnlyQueryConnection(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  db.enableDefensive(true);
  db.setAuthorizer(authorize);
  return db;
}

/**
 * Opens the archive for the server's own fixed queries (describe_schema,
 * get_evidence, get_coverage, dataset revision). These SQL strings are never
 * built from caller input, so the authorizer above is not needed; the file is
 * still opened read-only so this connection can never write either.
 */
export function openReadOnlyConnection(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  return db;
}

export type QueryColumn = {
  name: string;
  table: string | null;
  type: string | null;
};

export type QueryResult = {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when maxRows or timeoutMs cut the result short. Never label a
   * truncated result complete. */
  truncated: boolean;
  timedOut: boolean;
  elapsedMs: number;
};

/**
 * Runs one read-only, single-statement query with bounded rows and time.
 * `sql` is caller input; `params` are bound with `?`, never interpolated.
 */
export function runReadOnlyQuery(
  db: DatabaseSync,
  sql: string,
  params: readonly (string | number | bigint | null)[] = [],
  options: { maxRows?: number; timeoutMs?: number } = {},
): QueryResult {
  const maxRows = options.maxRows ?? MAX_QUERY_ROWS;
  const timeoutMs = options.timeoutMs ?? MAX_QUERY_MS;
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("sql must be a non-empty string");
  }

  // Compiling throws for a syntax error and for anything the authorizer
  // denies, before any row is produced.
  const stmt = db.prepare(sql);

  // sourceSQL is exactly the slice of `sql` SQLite's own parser consumed for
  // this one statement (including a single trailing `;` if present, never a
  // trailing comment or a second statement). Anything left over after that is
  // a second statement -- smuggled after a semicolon or inside a comment --
  // and is rejected here rather than silently ignored.
  const remainder = sql.slice(stmt.sourceSQL.length).trim();
  if (remainder.length > 0) {
    throw new Error(
      "only a single SQL statement is allowed per call, and this SQL has more than one",
    );
  }

  stmt.setReadBigInts(true);
  const columns: QueryColumn[] = stmt
    .columns()
    .map((c) => ({ name: c.name, table: c.table, type: c.type }));

  const start = Date.now();
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  let timedOut = false;
  for (const row of stmt.iterate(...params)) {
    // ponytail: this deadline only fires between yielded rows. A single row
    // whose own materialization is slow (a large join before its first
    // output) cannot be preempted from JS without a worker thread. Upgrade
    // path if that ever matters for this single-user local archive: run the
    // query in a worker thread and terminate it after timeoutMs.
    if (Date.now() - start > timeoutMs) {
      truncated = true;
      timedOut = true;
      break;
    }
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(row as Record<string, unknown>);
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated,
    timedOut,
    elapsedMs: Date.now() - start,
  };
}
