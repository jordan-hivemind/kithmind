import { mutation } from "../../_generated/server";
import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { executeRecordQuery } from "./query";
import { recordQueryValidator } from "./queryValidators";

/** Read capability permits internal snapshot and cursor bookkeeping only. */
export const run = mutation({
  args: { query: recordQueryValidator },
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    return await executeRecordQuery(ctx, {
      principal,
      query: args.query,
      now: Date.now(),
    });
  },
});
