// The per-source mutation rate limit.
//
// Kept in lockstep with `models/workers/rateLimit.ts`: 8,000 mutations per
// credential/source in a 60-second fixed window. A 1,000-file pipeline pass
// has a measured upper bound of 2,543 worker calls, leaving the adopted 3x
// margin while retaining the same fixed-window policy and eight client retries.
//
// The window is fixed rather than sliding, which is what the original does: a
// window older than 60 seconds is replaced wholesale rather than decayed. That
// makes a burst of 120 possible across a window boundary, and that is the
// existing behaviour the pipeline's pacing was measured against.
//
// One statement rather than a read, a branch and a write. `ON CONFLICT` over the
// `(credential_id, source_account_id)` unique index migration 008 adds makes the
// whole decision atomic in the database: read-then-write under SERIALIZABLE would
// be correct too, but it would abort one of two concurrent workers on the same
// source instead of rate-limiting it, and a serialization abort is not the answer
// this operation is supposed to give.

import { newKithId } from "../ids.js";
import { at, exec, numOr0, row, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";

/**
 * The budget, as one named constant pair. P2-80k owns changing these; nothing
 * else in the package may inline either number.
 */
export const WORKER_MUTATION_RATE_BUDGET = {
  /** Mutations allowed per credential per source account per window. */
  limit: 8_000,
  /** The window length in milliseconds. */
  windowMs: 60_000,
} as const;

export const WORKER_MUTATION_RATE_LIMIT = WORKER_MUTATION_RATE_BUDGET.limit;
export const WORKER_MUTATION_RATE_WINDOW_MS =
  WORKER_MUTATION_RATE_BUDGET.windowMs;

type RateRow = { window_started_at: Date; count: string };

/**
 * Consumes one unit of the budget, or refuses with `rate_limited`.
 *
 * The refusal conditions are the original's, all four of them, because each is a
 * distinct way the row can be wrong and none of them may be resolved in the
 * caller's favour: a window that starts in the future, a count that is not a
 * whole number, a negative count, and a count at or past the limit.
 */
export async function consumeWorkerMutationRateLimit(
  ctx: WorkerCtx,
  credentialId: string,
  sourceAccountId: string,
): Promise<void> {
  const windowFloor = new Date(
    ctx.now - WORKER_MUTATION_RATE_BUDGET.windowMs,
  );
  // Insert a fresh window, or restart an expired one, or increment a live one,
  // in one statement. `count` comes back so the caller's decision is made on
  // what the database actually holds.
  const updated = await row<RateRow>(
    ctx,
    `INSERT INTO kith.worker_protocol_rate_limits
       (id, created_at, credential_id, source_account_id, window_started_at, count)
     VALUES ($1, transaction_timestamp(), $2, $3, $4, 1)
     ON CONFLICT (credential_id, source_account_id) DO UPDATE
       SET window_started_at =
             CASE WHEN kith.worker_protocol_rate_limits.window_started_at <= $5
                  THEN $4
                  ELSE kith.worker_protocol_rate_limits.window_started_at END,
           count =
             CASE WHEN kith.worker_protocol_rate_limits.window_started_at <= $5
                  THEN 1
                  ELSE kith.worker_protocol_rate_limits.count + 1 END
     RETURNING window_started_at, count`,
    [
      newKithId(),
      credentialId,
      sourceAccountId,
      at(ctx.now),
      windowFloor,
    ],
  );
  if (!updated) workerProtocolError("scan_conflict");
  const count = numOr0(updated.count);
  const startedAt = updated.window_started_at.getTime();
  if (
    startedAt > ctx.now ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > WORKER_MUTATION_RATE_BUDGET.limit
  ) {
    // The unit is already spent in the row. That is the original's shape too:
    // a refused request still counts, so a worker cannot make the limit softer
    // by retrying into it. The `SERIALIZABLE` transaction rolls this back with
    // the rest of the operation, which is what keeps a refusal from consuming
    // budget it did not use.
    workerProtocolError("rate_limited");
  }
}

/** Clears a source's window. Used only by the tests and by operator tooling. */
export async function resetWorkerMutationRateLimit(
  ctx: WorkerCtx,
  credentialId: string,
  sourceAccountId: string,
): Promise<void> {
  await exec(
    ctx,
    `DELETE FROM kith.worker_protocol_rate_limits
      WHERE credential_id = $1 AND source_account_id = $2`,
    [credentialId, sourceAccountId],
  );
}
