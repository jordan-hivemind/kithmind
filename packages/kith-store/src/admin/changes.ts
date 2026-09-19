// The read side of the change feed (section 4 of
// docs/plans/2026-09-18-admin-panel-and-ingestion.md).
//
// One function, and it is deliberately the narrowest thing that can answer
// "what changed since the cursor I hold": a space set, a cursor, a bound, and
// four scalars per row. It never joins to the table a row names and never
// returns row content, so the route over it (`/api/kith/changes`) cannot leak
// a row the caller could not already read -- there is nothing in a change row
// to leak.
//
// The space set is the caller's *resolved authorized* set, produced by
// `getAuthorizedReadSpaceIds` at the route, not a set the request named. It
// reaches the statement through `spacePredicate`, which refuses an empty set
// rather than matching everything.

import type { IdentityCtx } from "../identity/db.js";
import { rows } from "../identity/db.js";
import { ProofError } from "../errors.js";
import { spacePredicate } from "../spaces.js";

/** One change: which table, which row, what happened. Never the row itself. */
export type ChangeRow = {
  id: string;
  table: string;
  rowId: string;
  op: "insert" | "update" | "delete";
};

/** The most rows one poll or one stream tick returns. */
export const MAX_CHANGES_PER_READ = 500;

/**
 * Every change past `sinceId` in the given spaces, oldest first.
 *
 * `id` is returned as a string: it is a `bigint` and the cursor round-trips
 * through a URL and an SSE `id:` field, so it is never parsed into a JavaScript
 * number. `sinceId` is a `bigint` too and is bound as text with an explicit
 * cast, so a caller cannot widen the range by sending something that is not a
 * cursor.
 */
export async function listChangesSince(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  sinceId: string,
  limit = MAX_CHANGES_PER_READ,
): Promise<ChangeRow[]> {
  if (!/^\d{1,19}$/.test(sinceId)) throw new ProofError("invalid_cursor");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGES_PER_READ) {
    throw new ProofError("invalid_limit");
  }
  const predicate = spacePredicate(spaceIds, 1);
  const records = await rows<{
    id: string;
    table_name: string;
    row_id: string;
    op: ChangeRow["op"];
  }>(
    ctx,
    `SELECT id::text AS id, table_name, row_id, op
       FROM kith.changes
      WHERE ${predicate.sql} AND id > $2::bigint
      ORDER BY id
      LIMIT $3`,
    [predicate.value, sinceId, limit],
  );
  return records.map((record) => ({
    id: record.id,
    table: record.table_name,
    rowId: record.row_id,
    op: record.op,
  }));
}

/**
 * The newest change id across the given spaces, or `"0"`.
 *
 * A first connection with no cursor starts here rather than at 0, so the
 * client is not handed three days of backlog it would only use to invalidate
 * queries it is about to fetch anyway.
 */
export async function latestChangeId(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
): Promise<string> {
  const predicate = spacePredicate(spaceIds, 1);
  const record = await rows<{ id: string | null }>(
    ctx,
    `SELECT max(id)::text AS id FROM kith.changes WHERE ${predicate.sql}`,
    [predicate.value],
  );
  return record[0]?.id ?? "0";
}
