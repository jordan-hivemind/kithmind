import { v } from "convex/values";

import { internalQuery } from "../../_generated/server";

/**
 * Operator read for P2-39l. `lists`, `listItems`, `reports` and `insights` are
 * retired rather than ported to PostgreSQL (postgres consolidation plan,
 * section 5.1, owner question 1), so their rows are exported to JSONL before
 * the tables are dropped. Deleted in the same pull request that drops the
 * tables: this module cannot type-check against a schema without them.
 *
 * Driven by `scripts/export-retiring-tables.mjs`, which writes one JSONL file
 * per table and prints only counts.
 */
const RETIRING_TABLE = v.union(
  v.literal("lists"),
  v.literal("listItems"),
  v.literal("reports"),
  v.literal("insights"),
);

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 2_000;

export const exportPage = internalQuery({
  args: {
    spaceId: v.id("spaces"),
    table: RETIRING_TABLE,
    cursor: v.union(v.string(), v.null()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    rows: v.array(v.any()),
    scanned: v.number(),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // A missing space would otherwise produce a silently empty export.
    if ((await ctx.db.get(args.spaceId)) === null) {
      throw new Error("Space not found");
    }
    const members = await ctx.db
      .query("spaceMembers")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .collect();
    const userIds = new Set(members.map((member) => member.userId));

    const batchSize = Math.min(
      Math.max(Math.trunc(args.batchSize ?? DEFAULT_BATCH_SIZE), 1),
      MAX_BATCH_SIZE,
    );
    // These four tables are user-scoped, not space-scoped, so there is no
    // space index to walk. The tables are small and about to be dropped, so a
    // full paged scan filtered by membership is enough. `scanned` reports the
    // rows the page saw, so an operator can see rows owned by nobody in the
    // space rather than assume the export was complete.
    const page = await ctx.db
      .query(args.table)
      .paginate({ cursor: args.cursor, numItems: batchSize });

    return {
      rows: page.page.filter((row) => userIds.has(row.userId)),
      scanned: page.page.length,
      cursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});
