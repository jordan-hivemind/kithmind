import { ConvexError, v } from "convex/values";
import { mutation, query } from "../../_generated/server";
import { requireWebPrincipal } from "../../lib/webAuth";
import { getAuthorizedReadSpaceIds, resolveWriteSpace } from "../../lib/spaces";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";

function boundedText(value: string, name: string, maximum: number) {
  if (
    !value.trim() ||
    new TextEncoder().encode(value).length > maximum ||
    new TextDecoder().decode(new TextEncoder().encode(value)) !== value
  ) {
    throw new ConvexError({
      code: "invalid_input",
      message: `${name} is empty, malformed or too long`,
    });
  }
}
function validateFreshness(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value < 60_000 ||
    value > 365 * 86_400_000
  ) {
    throw new ConvexError({
      code: "invalid_input",
      message: "Freshness must be between one minute and one year",
    });
  }
}

export const create = mutation({
  args: {
    spaceId: v.optional(v.id("spaces")),
    connector: v.string(),
    accountId: v.string(),
    name: v.string(),
    freshnessMs: v.optional(v.number()),
  },
  returns: v.id("sourceAccounts"),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    boundedText(args.connector, "Connector", 100);
    boundedText(args.accountId, "Account identity", 512);
    boundedText(args.name, "Name", 200);
    const freshnessMs = args.freshnessMs ?? 86_400_000;
    validateFreshness(freshnessMs);
    const spaceId = await resolveWriteSpace(ctx, principal, args.spaceId);
    const existing = await ctx.db
      .query("sourceAccounts")
      .withIndex("by_space_connector_account", (q) =>
        q
          .eq("spaceId", spaceId)
          .eq("connector", args.connector)
          .eq("accountId", args.accountId),
      )
      .unique();
    if (existing)
      throw new ConvexError({
        code: "source_account_exists",
        message: "Source account already exists",
      });
    return await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: args.connector,
      accountId: args.accountId,
      name: args.name,
      freshnessMs,
      enabled: true,
      cursorVersion: 0,
      createdBy: principal.userId,
    });
  },
});

export const update = mutation({
  args: {
    sourceAccountId: v.id("sourceAccounts"),
    name: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    freshnessMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    await requireSourceAccountAccess(
      ctx,
      principal,
      args.sourceAccountId,
      "write",
    );
    if (args.name !== undefined) boundedText(args.name, "Name", 200);
    if (args.freshnessMs !== undefined) validateFreshness(args.freshnessMs);
    await ctx.db.patch(args.sourceAccountId, {
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
      ...(args.freshnessMs === undefined
        ? {}
        : { freshnessMs: args.freshnessMs }),
    });
    return null;
  },
});

export const list = query({
  args: { spaceIds: v.optional(v.array(v.id("spaces"))) },
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const spaces = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    const accounts = [];
    for (const spaceId of spaces) {
      const rows = await ctx.db
        .query("sourceAccounts")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
        .take(101 - accounts.length);
      accounts.push(...rows);
      if (accounts.length > 100)
        throw new ConvexError({
          code: "source_account_limit",
          message: "Too many source accounts; filter spaces",
        });
    }
    return accounts.map(
      ({ _id, spaceId, name, connector, accountId, freshnessMs, enabled }) => ({
        _id,
        spaceId,
        name,
        connector,
        accountId,
        freshnessMs,
        enabled,
      }),
    );
  },
});
