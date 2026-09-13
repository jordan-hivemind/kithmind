// The context every worker operation takes, and the four plumbing decisions the
// rest of this directory depends on.
//
// 1. One client, one transaction. A Convex mutation is atomic; section 2.4's
//    replacement is one `SERIALIZABLE` transaction on one checked-out client
//    with a bounded retry, which `withKithTransaction` already provides. Nothing
//    in this directory calls `BEGIN`, `COMMIT` or `pool.connect()`: the service
//    boundary in `index.ts` opens the transaction and every function below runs
//    inside it. That is what makes "one operation is one transaction" a property
//    of one place rather than a rule 33 call sites must remember.
//
// 2. One clock. `now` is on the context rather than read inside each function.
//    A Convex mutation's `Date.now()` is effectively frozen; a transaction here
//    spans many statements, and a lease expiry that moves between two
//    comparisons in one operation is a bug that only appears under load. It is
//    also what makes the expiry tests deterministic instead of slow.
//
// 3. Epoch milliseconds at the edges, `Date` at the driver. The wire contract
//    speaks numbers (`leaseExpiresAt`, `observedAt`, `expiresAt`) and migration
//    004 made every such column `timestamptz`, so the conversion happens here,
//    once each way, rather than in every statement.
//
// 4. `numeric`, not `integer`. Migration 004 typed every Convex `v.number()` as
//    `numeric`, and node-pg deliberately returns `numeric` as a string because
//    the finance schema in this same database needs exact decimals. So a count,
//    an ordinal or an epoch read back from a row is converted explicitly.

import type { ClientBase } from "pg";

import { sha256Utf8 } from "../provenance/sql.js";

export type WorkerCtx = {
  readonly client: ClientBase;
  /** Epoch ms, fixed for the whole transaction. */
  readonly now: number;
};

/** The context for one operation. `now` is injectable so expiry is testable. */
export function workerCtx(client: ClientBase, now = Date.now()): WorkerCtx {
  return { client, now };
}

/** Every row a statement returns. Used only where the row count is bounded. */
export async function rows<T extends object>(
  ctx: WorkerCtx,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await ctx.client.query<T>(sql, values as unknown[])).rows;
}

/** The first row, or null. */
export async function row<T extends object>(
  ctx: WorkerCtx,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T | null> {
  return (await rows<T>(ctx, sql, values))[0] ?? null;
}

/** Runs a statement for its effect. */
export async function exec(
  ctx: WorkerCtx,
  sql: string,
  values: readonly unknown[] = [],
): Promise<void> {
  await ctx.client.query(sql, values as unknown[]);
}

/** Epoch ms to a bind value. */
export function at(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

/** A `timestamptz` back to epoch ms, the unit the wire contract uses. */
export function ms(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** A `timestamptz` that must be present, as epoch ms. */
export function msRequired(value: Date | string): number {
  const result = ms(value);
  if (result === null) throw new Error("Expected a timestamp");
  return result;
}

/** A `numeric` column back to a JS number, or null. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** A `numeric` column back to a JS number, defaulting an absent one to 0. */
export function numOr0(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * `now + duration`, clamped the way the Convex code clamps it.
 *
 * The clamp is not decoration: `Number.MAX_SAFE_INTEGER` ms is the point past
 * which an added expiry stops being comparable, and a retention window of 90
 * days added to a clock that has been set wrong must produce a refusable value
 * rather than an unordered one.
 */
export function nowPlus(now: number, duration: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + duration);
}

/**
 * The request digest, byte for byte as Convex computes it.
 *
 * `sha256Utf8(`${domain}\0${JSON.stringify(value)}`)` with the same domain
 * string and the same array shape, because a digest is what makes a replay a
 * replay: a worker that retried a request against Convex and then retries the
 * same request against Postgres must hit the same stored receipt, not a
 * `request_conflict`. Every call site keeps the Convex domain label verbatim for
 * that reason, including the `:v1` suffixes.
 */
export async function digest(domain: string, value: unknown): Promise<string> {
  return sha256Utf8(`${domain}\0${JSON.stringify(value)}`);
}

/** A whole non-negative number, or the operation is refused by the caller. */
export function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
