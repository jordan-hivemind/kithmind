import { action } from "../../_generated/server";
import { internal as _internal } from "../../_generated/api";
import { v } from "convex/values";
import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { principalRef } from "../../lib/spaces";
import { insightCategory, projectActive } from "./validators";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internal = _internal as any;

export const createReport = action({
  args: {
    startDate: v.string(),
    endDate: v.string(),
    sessionsAnalyzed: v.number(),
    totalPrompts: v.number(),
    totalToolCalls: v.number(),
    projectsActive: v.array(projectActive),
    modelUsage: v.any(),
    insights: v.array(
      v.object({
        category: insightCategory,
        observation: v.string(),
        recommendation: v.string(),
        evidence: v.string(),
        links: v.optional(
          v.array(v.object({ label: v.string(), url: v.string() })),
        ),
      }),
    ),
  },
  returns: v.object({
    reportId: v.id("reports"),
    insightIds: v.array(v.id("insights")),
  }),
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    return await ctx.runMutation(
      internal.models.reports.private.insertReportWithInsightsAuthorized,
      { principal: principalRef(principal), ...args },
    );
  },
});
