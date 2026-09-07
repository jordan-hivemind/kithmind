import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";
import type { PrincipalRef } from "../../lib/spaces";
import { workerProtocolError } from "./errors";

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export type WorkerPrincipal = {
  userId: Id<"users">;
  credentialId: Id<"apiKeys">;
};

export function requireWorkerPrincipal(
  principal: PrincipalRef,
): WorkerPrincipal {
  if (!principal.credentialId) throw workerProtocolError("not_authenticated");
  return { userId: principal.userId, credentialId: principal.credentialId };
}

export async function requireWorkerSourceAccount(
  ctx: DbCtx,
  principal: PrincipalRef,
  args: { spaceId: string; sourceAccountId: string },
): Promise<{
  principal: WorkerPrincipal;
  spaceId: Id<"spaces">;
  account: Doc<"sourceAccounts">;
}> {
  const workerPrincipal = requireWorkerPrincipal(principal);
  const spaceId = ctx.db.normalizeId("spaces", args.spaceId);
  const sourceAccountId = ctx.db.normalizeId(
    "sourceAccounts",
    args.sourceAccountId,
  );
  if (!spaceId || !sourceAccountId) {
    throw workerProtocolError("invalid_request");
  }

  let account: Doc<"sourceAccounts">;
  try {
    account = await requireSourceAccountAccess(
      ctx,
      workerPrincipal,
      sourceAccountId,
      "ingest",
    );
  } catch {
    throw workerProtocolError("not_authorized");
  }
  if (account.spaceId !== spaceId) throw workerProtocolError("not_found");
  if (account.connector !== "fs" || !account.enabled) {
    throw workerProtocolError("source_unavailable");
  }
  return { principal: workerPrincipal, spaceId, account };
}
