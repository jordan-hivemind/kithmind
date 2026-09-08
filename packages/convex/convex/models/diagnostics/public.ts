import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";
import { requireSpaceAccess } from "../../lib/spaces";
import { requireWebPrincipal } from "../../lib/webAuth";
import { parseWorkerProtocolErrorData } from "../workers/protocol";
import { diagnosticsSummary, resetWorkerWatcher } from "./model";
import {
  ownerDiagnosticsStatusResultValidator,
  ownerResetWatcherResultValidator,
} from "./validators";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validUuid(value: string): boolean {
  return value.length <= 36 && UUID.test(value);
}

function publicError(error: unknown): never {
  const data =
    typeof error === "object" && error !== null && "data" in error
      ? error.data
      : undefined;
  const parsed = parseWorkerProtocolErrorData(data);
  const code = parsed?.code;
  if (code === "request_conflict" || code === "identity_review_required") {
    throw new ConvexError({ code, message: "Watcher update was rejected." });
  }
  throw new ConvexError({
    code: "diagnostics_unavailable",
    message: "Worker diagnostics are unavailable.",
  });
}

async function sourceForWeb(
  ctx: QueryCtx | MutationCtx,
  sourceAccountId: Id<"sourceAccounts">,
) {
  const principal = await requireWebPrincipal(ctx).catch(() => {
    throw new ConvexError({
      code: "not_authenticated",
      message: "Sign in to continue.",
    });
  });
  const account = await requireSourceAccountAccess(
    ctx,
    principal,
    sourceAccountId,
    "read",
  ).catch(() => {
    throw new ConvexError({
      code: "source_not_found",
      message: "Source account is not available.",
    });
  });
  return { principal, account };
}

export const status = query({
  args: { sourceAccountId: v.id("sourceAccounts") },
  returns: ownerDiagnosticsStatusResultValidator,
  handler: async (ctx, args) => {
    const { account } = await sourceForWeb(ctx, args.sourceAccountId);
    try {
      return await diagnosticsSummary(ctx, account, Date.now());
    } catch (error) {
      publicError(error);
    }
  },
});

export const resetWatcher = mutation({
  args: {
    sourceAccountId: v.id("sourceAccounts"),
    requestId: v.string(),
    expectedWatcherId: v.union(v.string(), v.null()),
    nextWatcherId: v.union(v.string(), v.null()),
  },
  returns: ownerResetWatcherResultValidator,
  handler: async (ctx, args) => {
    if (
      !validUuid(args.requestId) ||
      (args.expectedWatcherId !== null && !validUuid(args.expectedWatcherId)) ||
      (args.nextWatcherId !== null && !validUuid(args.nextWatcherId))
    ) {
      throw new ConvexError({
        code: "invalid_input",
        message: "Watcher request is invalid.",
      });
    }
    const { principal, account } = await sourceForWeb(
      ctx,
      args.sourceAccountId,
    );
    const membership = await requireSpaceAccess(
      ctx,
      principal,
      account.spaceId,
      "read",
    ).catch(() => {
      throw new ConvexError({
        code: "source_not_found",
        message: "Source account is not available.",
      });
    });
    if (membership.role !== "owner") {
      throw new ConvexError({
        code: "owner_required",
        message: "Only a space owner can manage the watcher.",
      });
    }
    try {
      return await resetWorkerWatcher(
        ctx,
        account,
        principal.userId,
        args,
        Date.now(),
      );
    } catch (error) {
      publicError(error);
    }
  },
});
