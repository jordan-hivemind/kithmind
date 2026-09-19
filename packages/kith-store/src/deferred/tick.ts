// `tick`: one call that runs every sweep once, then drains due jobs. This is
// what `src/deferred/cli.ts` calls on a launchd/systemd interval, and it is
// the whole of section 2.6's "one more launchd job and one
// `kith deferred-work drain` command" on the daemon side.
//
// Sweeps run first and unconditionally, before the drain loop, so a sweep
// that enqueues work (today, `recoverInlineIngestion`) has a chance to be
// drained in the same tick rather than waiting for the next one.

import type { Pool } from "pg";

import { withKithTransaction } from "../schema.js";
import { deferredCtx } from "./core.js";
import { drain, type DrainSummary } from "./drain.js";
import type { DeferredWorkRegistry } from "./registry.js";
import {
  recoverInlineIngestion,
  removeExpiredAuthRateLimits,
  removeExpiredChanges,
  removeExpiredOAuthGrants,
  removeExpiredWorkerProtocolState,
  type RecoverySweepResult,
  type SweepResult,
} from "./sweeps.js";

export type TickSweepSummary = {
  inlineIngestionRecovery: RecoverySweepResult;
  expiredOAuthGrants: SweepResult;
  expiredWorkerProtocolState: SweepResult;
  expiredAuthRateLimits: SweepResult;
  expiredChanges: SweepResult;
};

export type TickSummary = {
  sweeps: TickSweepSummary;
  drain: DrainSummary;
};

export type TickOptions = {
  now?: number;
  maxJobs?: number;
  sweepLimit?: number;
};

/** Runs one round: every sweep once, then the drain loop. A missed tick costs
 * nothing -- every sweep and every drained job is idempotent -- so calling
 * this twice back to back is safe and the second call typically does less
 * work than the first. */
export async function tick(
  pool: Pool,
  registry: DeferredWorkRegistry,
  options: TickOptions = {},
): Promise<TickSummary> {
  const now = options.now ?? Date.now();
  const sweepLimit = options.sweepLimit;
  const inlineIngestionRecovery = await withKithTransaction(pool, (client) =>
    recoverInlineIngestion(deferredCtx(client, now), { limit: sweepLimit }),
  );
  const expiredOAuthGrants = await withKithTransaction(pool, (client) =>
    removeExpiredOAuthGrants(deferredCtx(client, now), { limit: sweepLimit }),
  );
  const expiredWorkerProtocolState = await withKithTransaction(
    pool,
    (client) =>
      removeExpiredWorkerProtocolState(deferredCtx(client, now), {
        limit: sweepLimit,
      }),
  );
  const expiredAuthRateLimits = await withKithTransaction(pool, (client) =>
    removeExpiredAuthRateLimits(deferredCtx(client, now), {
      limit: sweepLimit,
    }),
  );
  const expiredChanges = await withKithTransaction(pool, (client) =>
    removeExpiredChanges(deferredCtx(client, now), { limit: sweepLimit }),
  );
  const drainSummary = await drain(pool, registry, {
    maxJobs: options.maxJobs,
    now,
  });
  return {
    sweeps: {
      inlineIngestionRecovery,
      expiredOAuthGrants,
      expiredWorkerProtocolState,
      expiredAuthRateLimits,
      expiredChanges,
    },
    drain: drainSummary,
  };
}
