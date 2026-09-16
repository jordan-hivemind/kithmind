// Ported from `listAroundTimeAuthorized` in
// packages/convex/convex/models/thoughts/private.ts (P2-39i3).
//
// Section 1.5 of docs/plans/2026-09-16-web-mcp-postgres-surface.md listed the
// thought timeline as owed by nobody and assigned it here, because
// `timeline_thoughts` is one of the 14 read tools i3 moves onto PostgreSQL.
//
// The window is built the same way the Convex original built it: `before` rows
// strictly earlier than the anchor, newest first, then reversed; `after` rows
// strictly later, oldest first; the seed, when there is one, inserted in
// creation order. Each space is scanned separately and the merged set is cut
// back to `before` and `after`, so one busy space cannot crowd another out of
// the half of the window it belongs in and cannot be given more than its share.
//
// `spaceIds` must already be the caller's membership-checked authorized set.
// The seed is not a space selector: it is looked up and then checked against
// that set, so a seed in another space reads as a missing seed rather than as
// a denial that confirms it exists.

import type { IdentityCtx } from "../identity/db.js";
import { rows } from "../identity/db.js";
import { isMemoryRetrievable } from "./lifecycle.js";
import {
  getThoughtById,
  hydrateThoughtRows,
  THOUGHT_COLUMNS,
  type Thought,
  type ThoughtRow,
  type ThoughtType,
} from "./thoughts.js";

/** `timeline`'s own window bound, restated from the MCP tool's schema. */
export const MAX_TIMELINE_WINDOW = 50;

export type TimelineArgs = {
  seedId?: string;
  aroundMs?: number;
  before: number;
  after: number;
  type?: ThoughtType;
};

function ascending(left: Thought, right: Thought): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function descending(left: Thought, right: Thought): number {
  return right.createdAt - left.createdAt || left.id.localeCompare(right.id);
}

/**
 * Thoughts captured around one point in time, oldest first.
 *
 * Retracted, superseded and out-of-window memories are excluded in both
 * directions: the timeline is a view of what is current, and the Convex
 * original passed `includeHistorical: false` unconditionally for the same
 * reason. The seed is held to the same rule, so anchoring on a superseded
 * thought is a missing seed rather than a window built around a row the tool
 * would refuse to return.
 */
export async function listAroundTime(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  args: TimelineArgs,
): Promise<Thought[]> {
  if (
    !Number.isInteger(args.before) ||
    !Number.isInteger(args.after) ||
    args.before < 0 ||
    args.after < 0 ||
    args.before > MAX_TIMELINE_WINDOW ||
    args.after > MAX_TIMELINE_WINDOW
  ) {
    throw new Error(
      `Timeline windows must be integers from 0 to ${MAX_TIMELINE_WINDOW}`,
    );
  }
  if (
    (args.seedId === undefined) === (args.aroundMs === undefined) ||
    (args.aroundMs !== undefined && !Number.isFinite(args.aroundMs))
  ) {
    throw new Error("Provide exactly one of seedId or aroundMs");
  }

  const authorized = new Set(spaceIds);
  let seed: Thought | null = null;
  if (args.seedId !== undefined) {
    seed = await getThoughtById(ctx, args.seedId);
    if (
      !seed ||
      !authorized.has(seed.spaceId) ||
      !isMemoryRetrievable(seed, false, ctx.now)
    ) {
      throw new Error("Seed thought not found");
    }
  }
  const aroundMs = seed ? seed.createdAt : args.aroundMs!;
  const anchor = new Date(aroundMs);
  const activeAt = new Date(ctx.now);

  const earlier: Thought[] = [];
  const later: Thought[] = [];
  for (const spaceId of spaceIds) {
    // Every value is a bind parameter and the only interpolated text is the
    // comparison direction, which is chosen here from a closed set.
    for (const side of ["earlier", "later"] as const) {
      const limit = side === "earlier" ? args.before : args.after;
      if (limit === 0) continue;
      const values: unknown[] = [spaceId, anchor, activeAt];
      let where = `space_id = $1
        AND created_at ${side === "earlier" ? "<" : ">"} $2
        AND (memory_status IS NULL OR memory_status = 'current')
        AND (valid_from IS NULL OR valid_from <= $3)
        AND (valid_to IS NULL OR $3 < valid_to)`;
      if (args.type !== undefined) {
        values.push(args.type);
        where += ` AND metadata ->> 'type' = $${values.length}`;
      }
      values.push(limit);
      const found = await hydrateThoughtRows(
        ctx,
        await rows<ThoughtRow>(
          ctx,
          `SELECT ${THOUGHT_COLUMNS} FROM kith.thoughts
            WHERE ${where}
            ORDER BY created_at ${side === "earlier" ? "DESC" : "ASC"}, id ASC
            LIMIT $${values.length}`,
          values,
        ),
      );
      (side === "earlier" ? earlier : later).push(...found);
    }
  }

  const window = [
    ...earlier.sort(descending).slice(0, args.before).reverse(),
    ...later.sort(ascending).slice(0, args.after),
  ];
  if (!seed) return window;
  window.push(seed);
  return window.sort(ascending);
}
