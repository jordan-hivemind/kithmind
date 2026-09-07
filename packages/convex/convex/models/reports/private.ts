import { internalMutation } from "../../_generated/server";
import { v } from "convex/values";
import { principalRefValidator } from "../apiKeys/validators";
import {
  ensurePersonalSpace,
  reloadPrincipal,
  requireSpaceAccess,
} from "../../lib/spaces";
import { insightCategory, projectActive } from "./validators";
import { _insertReport, _insertInsight, _deleteInsight } from "./model";

export const insertReport = internalMutation({
  args: {
    userId: v.id("users"),
    startDate: v.string(),
    endDate: v.string(),
    sessionsAnalyzed: v.number(),
    totalPrompts: v.number(),
    totalToolCalls: v.number(),
    projectsActive: v.array(projectActive),
    modelUsage: v.any(),
  },
  returns: v.id("reports"),
  handler: async (ctx, args) => {
    return await _insertReport(ctx, args);
  },
});

export const insertInsight = internalMutation({
  args: {
    reportId: v.id("reports"),
    userId: v.id("users"),
    category: insightCategory,
    observation: v.string(),
    recommendation: v.string(),
    evidence: v.string(),
    links: v.optional(
      v.array(v.object({ label: v.string(), url: v.string() })),
    ),
  },
  returns: v.id("insights"),
  handler: async (ctx, args) => {
    return await _insertInsight(ctx, {
      ...args,
      status: "new",
      dismissTag: undefined,
      dismissText: undefined,
      updatedAt: undefined,
    });
  },
});

export const deleteInsight = internalMutation({
  args: {
    insightId: v.id("insights"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await _deleteInsight(ctx, args.insightId);
    return null;
  },
});

export const insertReportWithInsightsAuthorized = internalMutation({
  args: {
    principal: principalRefValidator,
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
    const principal = await reloadPrincipal(ctx, args.principal);
    const personalSpaceId = await ensurePersonalSpace(ctx, principal.userId);
    await requireSpaceAccess(ctx, principal, personalSpaceId, "write");
    const { principal: _principal, insights, ...reportFields } = args;
    const reportId = await _insertReport(ctx, {
      ...reportFields,
      userId: principal.userId,
    });
    const insightIds = [];
    for (const insight of insights) {
      insightIds.push(
        await _insertInsight(ctx, {
          reportId,
          userId: principal.userId,
          ...insight,
          status: "new",
        }),
      );
    }
    return { reportId, insightIds };
  },
});
