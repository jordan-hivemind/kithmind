import type { MutationCtx } from "../../_generated/server";
import type { requireWorkerSourceAccount } from "./auth";
import { workerProtocolError } from "./errors";

export const WORKER_MUTATION_RATE_LIMIT = 60;
export const WORKER_MUTATION_RATE_WINDOW_MS = 60_000;

type LoadedWorkerSource = Awaited<
  ReturnType<typeof requireWorkerSourceAccount>
>;

export async function consumeWorkerMutationRateLimit(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  now: number,
): Promise<void> {
  const matches = await ctx.db
    .query("workerProtocolRateLimits")
    .withIndex("by_credentialId_and_sourceAccountId", (q) =>
      q
        .eq("credentialId", source.principal.credentialId)
        .eq("sourceAccountId", source.account._id),
    )
    .take(2);
  if (matches.length > 1) throw workerProtocolError("scan_conflict");
  const row = matches[0];
  if (!row || now - row.windowStartedAt >= WORKER_MUTATION_RATE_WINDOW_MS) {
    if (row) {
      await ctx.db.patch(row._id, { windowStartedAt: now, count: 1 });
    } else {
      await ctx.db.insert("workerProtocolRateLimits", {
        credentialId: source.principal.credentialId,
        sourceAccountId: source.account._id,
        windowStartedAt: now,
        count: 1,
      });
    }
    return;
  }
  if (
    now < row.windowStartedAt ||
    !Number.isSafeInteger(row.count) ||
    row.count < 0 ||
    row.count >= WORKER_MUTATION_RATE_LIMIT
  ) {
    throw workerProtocolError("rate_limited");
  }
  await ctx.db.patch(row._id, { count: row.count + 1 });
}
