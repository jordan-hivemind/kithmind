// The one `pg.Pool` this instance uses to reach the `kith` schema.
//
// The shape is the one `lib/mcp/finance.ts` already uses for the archive: one
// module-scoped variable, created on first use, keyed on nothing, because a
// serverless instance reads its environment once and never changes it.
//
// It is deliberately a *second* pool rather than a share of the archive's.
// Section 4.1 of the web and MCP surface plan says why: the two connections are
// different roles against different schemas. The archive connects as
// `finance_reader` with `default_transaction_read_only`; `kith` connects as the
// writer. One `pg.Pool` would mean one of the two ran under the wrong role, and
// the failure would be silent in the direction that matters -- a finance read
// running with write authority.
//
// `createKithPool` bounds it to two connections, which is section 2.8's budget
// for one serverless instance, and pins `search_path` inside each transaction
// rather than in the startup packet, because a transaction-pooled endpoint may
// hand the next transaction a different backend.

import { createKithPool } from "@repo/kith-store";
import type pg from "pg";

import { requireEnvironmentVariable } from "@/lib/mcp/environment";

let pool: pg.Pool | undefined;

/**
 * The pool, created on first use.
 *
 * `KITH_DATABASE_URL` is read here and nowhere else, has no `NEXT_PUBLIC_`
 * prefix, and is never returned, logged or interpolated into a message: a
 * missing one is reported by `requireEnvironmentVariable` as a name only.
 */
export function kithPool(): pg.Pool {
  pool ??= createKithPool(requireEnvironmentVariable("KITH_DATABASE_URL"));
  return pool;
}

/**
 * Test-only: replaces the pool, returning a function that restores the previous
 * one. Nothing in the app calls it; a route test that stands up a throwaway
 * database uses it instead of reaching into module state.
 */
export function setKithPool(next: pg.Pool | undefined): () => void {
  const previous = pool;
  pool = next;
  return () => {
    pool = previous;
  };
}
