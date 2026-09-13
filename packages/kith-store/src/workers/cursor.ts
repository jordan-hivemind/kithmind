// Keyset cursors, which is what a Convex pagination cursor becomes.
//
// Section 2.3: "Convex `_creationTime` gives a total order per table. PostgreSQL
// does not order by insertion. Every paged read becomes a keyset cursor over
// `(created_at, id)` with a supporting index." Two operations page this way,
// `source.inventoryPage` and `scan.reconcile`, and both hand the cursor straight
// back to the worker, which stores it and returns it next call.
//
// Three properties the wire contract forces, none of them optional:
//
//   * A cursor is a non-empty string. `transport.ts` validates `continueCursor`
//     with `text(...)`, which refuses `""`, so the end of a walk is the sentinel
//     `END` rather than an empty string. Convex had the same constraint.
//   * A cursor is opaque and bounded to 8 KiB. Base64url of a two-element JSON
//     array is both, and it is short enough that the pipeline's journal keeps it
//     without a second thought.
//   * A cursor that does not decode is `scan_conflict`, not a silent restart. A
//     restart would re-walk items the scan has already accounted for and quietly
//     change what `reconcile` reports, which is worse than refusing.
//
// The scan row also stores the *expected next* cursor and compares it with what
// the worker sent, so replaying an older cursor is refused by the protocol
// regardless of what this module can decode. This module only has to be a
// faithful, total order.

import { KITH_ID } from "../ids.js";
import { workerProtocolError } from "./errors.js";

/** The cursor a completed walk returns. Non-empty, by contract. */
export const END_CURSOR = "END";

export type KeysetPosition = { createdAt: Date; id: string };

/** Encodes one position. Base64url so the cursor is safe in a JSON string. */
export function encodeCursor(position: KeysetPosition): string {
  return Buffer.from(
    JSON.stringify([position.createdAt.toISOString(), position.id]),
    "utf8",
  ).toString("base64url");
}

/**
 * Decodes a cursor the worker sent back, or refuses.
 *
 * `null` is "start at the beginning", which is what the worker sends on the
 * first page. `END_CURSOR` decodes to `null` as well rather than to a position:
 * the protocol refuses a continued walk past its end by its own `isDone` state,
 * and a caller that gets here with `END` has already been checked.
 */
export function decodeCursor(cursor: string | null): KeysetPosition | null {
  if (cursor === null || cursor === END_CURSOR) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    workerProtocolError("scan_conflict");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !KITH_ID.test(parsed[1])
  ) {
    workerProtocolError("scan_conflict");
  }
  const createdAt = new Date(parsed[0] as string);
  if (Number.isNaN(createdAt.getTime())) workerProtocolError("scan_conflict");
  return { createdAt, id: parsed[1] as string };
}

export type KeysetPage<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
};

/**
 * One page of a keyset walk, from `numItems + 1` rows fetched.
 *
 * Overfetching by one is how `isDone` becomes an observed fact rather than an
 * inference from `page.length < numItems`: a source whose item count is an exact
 * multiple of the page size would otherwise take one extra round trip to
 * discover it was finished, and the reconcile state machine treats "not done" as
 * "stay in `reconciling`", so that extra trip is a state the worker sits in.
 */
export function keysetPage<T extends KeysetPosition>(
  fetched: readonly T[],
  numItems: number,
): KeysetPage<T> {
  const isDone = fetched.length <= numItems;
  const page = isDone ? [...fetched] : fetched.slice(0, numItems);
  const last = page[page.length - 1];
  return {
    page,
    isDone,
    // A finished walk still returns a usable cursor, because the contract says
    // `continueCursor` is always a string. A non-empty page that ended the walk
    // returns its last position rather than the sentinel, so a worker that
    // ignores `isDone` and asks again gets an empty page instead of a restart.
    continueCursor:
      last === undefined
        ? END_CURSOR
        : encodeCursor({ createdAt: last.createdAt, id: last.id }),
  };
}

/**
 * The `WHERE`/`ORDER BY`/`LIMIT` tail every keyset walk shares.
 *
 * `($n, $n+1)` is a row constructor comparison, which PostgreSQL can satisfy
 * from a `(created_at, id)` btree index in one range scan. Written out as
 * `created_at > x OR (created_at = x AND id > y)` it cannot, which at a
 * 100,000-row source is the difference between a page and a sequential scan.
 */
export function keysetTail(
  position: KeysetPosition | null,
  firstParameterIndex: number,
): { sql: string; values: unknown[] } {
  if (position === null) {
    return {
      sql: `ORDER BY created_at, id LIMIT $${firstParameterIndex}`,
      values: [],
    };
  }
  return {
    sql:
      `AND (created_at, id) > ($${firstParameterIndex}, $${firstParameterIndex + 1}) ` +
      `ORDER BY created_at, id LIMIT $${firstParameterIndex + 2}`,
    values: [position.createdAt, position.id],
  };
}
