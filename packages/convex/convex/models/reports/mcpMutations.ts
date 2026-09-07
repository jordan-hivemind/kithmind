import { v } from "convex/values";

import { mutation } from "../../_generated/server";
import { requireMcpUserId } from "../../lib/mcpAuth";
import { _deleteInsight, _findInsightById, _findReportById } from "./model";

export const deleteInsight = mutation({
  args: { insightId: v.id("insights") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireMcpUserId(ctx, "write");
    const insight = await _findInsightById(ctx, args.insightId);

    if (!insight || insight.userId !== userId) {
      throw new Error("Insight not found");
    }
    const report = await _findReportById(ctx, insight.reportId);
    if (!report || report.userId !== userId) {
      throw new Error("Insight not found");
    }

    await _deleteInsight(ctx, args.insightId);
    return null;
  },
});
