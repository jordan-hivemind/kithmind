import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  reloadPrincipal,
  requireSpaceAccess,
  type Principal,
  type PrincipalRef,
  type SpaceOperation,
} from "./spaces";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/** Source ingest grants are additional to current space access, never a substitute. */
export async function requireSourceAccountAccess(
  ctx: ReadCtx,
  principalOrRef: Principal | PrincipalRef,
  sourceAccountId: Id<"sourceAccounts">,
  operation: SpaceOperation = "ingest",
) {
  const principal = await reloadPrincipal(ctx, principalOrRef);
  const account = await ctx.db.get(sourceAccountId);
  if (!account) throw new Error("Source account not found");
  try {
    await requireSpaceAccess(ctx, principal, account.spaceId, operation);
  } catch {
    throw new Error("Source account not found");
  }
  if (
    operation === "ingest" &&
    (!account.enabled ||
      (principal.credentialId !== undefined &&
        !principal.credentialSourceAccountIds?.includes(sourceAccountId)))
  ) {
    throw new Error("Source account not found");
  }
  return account;
}
