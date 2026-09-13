import type { PrincipalRef } from "../identity/authorization.js";
import { camelizeSourceItem, type SourceItemRow } from "../provenance/index.js";
import { sha256Hex } from "../ingestion/inline.js";
import { KITH_ID } from "../ids.js";
import { requireWorkerSourceAccount, type LoadedWorkerSource } from "./auth.js";
import { row, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";

export async function requireForgettingItem(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: {
    spaceId: string;
    sourceAccountId: string;
    sourceItemId: string;
    expectedForgetEpoch: number;
  },
): Promise<{ source: LoadedWorkerSource; item: SourceItemRow }> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  if (!KITH_ID.test(request.sourceItemId))
    workerProtocolError("invalid_request");
  const raw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_items WHERE id = $1 FOR UPDATE",
    [request.sourceItemId],
  );
  const item = raw ? camelizeSourceItem(raw) : null;
  if (
    !item ||
    item.spaceId !== source.spaceId ||
    item.sourceAccountId !== source.account.id
  )
    workerProtocolError("not_found");
  if (
    item.lifecycle !== "forgetting" ||
    item.desiredProcessingEpoch !== request.expectedForgetEpoch
  )
    workerProtocolError("stale_observation");
  if (
    item.externalId === null ||
    (await sha256Hex(item.externalId)) !== item.externalIdHash
  )
    workerProtocolError("scan_conflict");
  return { source, item };
}
