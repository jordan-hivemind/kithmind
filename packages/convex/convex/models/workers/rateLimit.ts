import type { MutationCtx } from "../../_generated/server";
import type { requireWorkerSourceAccount } from "./auth";
import { workerProtocolError } from "./errors";

/**
 * Per (credential, sourceAccount) mutation budget for one fixed
 * `WORKER_MUTATION_RATE_WINDOW_MS` window (P2-80k). This is a full-source
 * backfill budget, not a steady-state one: a text-only pass of N files
 * issues, per packages/pipeline/src/runner.ts,
 *
 *   scan.begin + scan.seal + processing.assessBegin        =  3
 *   source.inventoryPage + scan.reconcile (maxItems 50)    =  2 * ceil(N/50)
 *   scan.appendPage + discovery.reserve   (maxItems 4)     =  2 * ceil(N/4)
 *   discovery.admitUtf8 + processing.assessPage (1/file)   =  2 * N
 *
 * total(N) = 3 + 2*ceil(N/50) + 2*ceil(N/4) + 2*N, so:
 *   total(108)   = 3 +  2*3  +  2*27  +   216 =    279
 *   total(1_000) = 3 + 2*20  + 2*250  + 2_000 =  2_543
 *
 * At the old budget of 60, a 108-file pass already needed ~4.7x its window
 * budget (279 / 60), which is why the client's 8-attempt backoff (see
 * `rateLimitBackoffMs` in packages/pipeline/src/runner.ts) was twice seen
 * retrying up to its last attempt on a 108-file pass: it had to wait out a
 * full window reset more than once, and one more retry would have failed
 * the run with `rate_limited`. 8_000 is >=3x the 1,000-file total (2_543 *
 * 3 = 7_629), giving a 1,000-file pass room to complete a burst phase (the
 * two N-sized phases above, `discovery.admitUtf8` and, absent client
 * pacing, `processing.assessPage`) inside one window without tripping the
 * limiter, while `processing.assessPage` is additionally paced by default
 * on the client (see `DEFAULT_ASSESSMENT_PACING_MS` in
 * packages/pipeline/src/runner.ts) so the largest phase doesn't depend on
 * the budget alone.
 */
export const WORKER_MUTATION_RATE_LIMIT = 8_000;
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
