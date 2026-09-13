// The context every identity function takes, and the query shapes they need.
//
// A Convex function receives `ctx` and reads `ctx.db`. Here it receives `ctx`
// and reads `ctx.client`: one checked-out client inside one `SERIALIZABLE`
// transaction, which is section 2.4's replacement for a mutation's atomicity.
// Callers get that from `withKithTransaction(pool, (client) => f(ctx(client), …))`
// so one ported mutation stays one transaction, retried on a serialization
// failure, exactly as the foundation row set up.
//
// `now` is on the context rather than read from the clock inside each function.
// Convex's `Date.now()` is stable enough within a mutation; a transaction here
// can span several statements and several reads of the clock, and an expiry that
// moves between two comparisons in one authorization decision is a bug that only
// shows up under load. One timestamp per transaction removes it, and it is what
// makes the expiry tests deterministic instead of slow.

import type { ClientBase } from "pg";

export type IdentityCtx = {
  readonly client: ClientBase;
  /** Epoch ms, fixed for the whole transaction. */
  readonly now: number;
};

/** The context for one transaction. `now` is injectable so expiry is testable. */
export function identityCtx(client: ClientBase, now = Date.now()): IdentityCtx {
  return { client, now };
}

/** Every row a statement returns. Only used where the row count is bounded. */
export async function rows<T extends object>(
  ctx: IdentityCtx,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await ctx.client.query<T>(sql, values as unknown[])).rows;
}

/** The first row, or null. */
export async function row<T extends object>(
  ctx: IdentityCtx,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T | null> {
  return (await rows<T>(ctx, sql, values))[0] ?? null;
}

/** Runs a statement for its effect. */
export async function exec(
  ctx: IdentityCtx,
  sql: string,
  values: readonly unknown[] = [],
): Promise<void> {
  await ctx.client.query(sql, values as unknown[]);
}

/** Epoch ms to a bind value. Convex stores these fields as numbers. */
export function at(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

/** A read timestamp back to epoch ms, the unit every comparison here uses. */
export function ms(value: Date | string | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
