// The `embedding_fill` deferred-work kind: what schedules it, and what the
// daemon runs when it drains one.
//
// P2-39j2. Migration 017 has allowed this kind since it was written, and
// `defaultRegistry()` registered no handler for it, so the fill driver
// (`fill.ts`) had no production caller at all. The consequence was visible on
// every capture: a new thought is an eligible, uncovered target, which makes
// `getActiveEmbeddingTarget` report `thoughtStatus: "unavailable"` for the
// space, which turns the vector leg of every search off and degrades the
// capture gate to keyword until someone ran the fill by hand. This module is
// the missing half.
//
// Two decisions, both taken from `fill.ts`'s own module comment.
//
// 1. No transaction around the job. `fill.ts` says the read page and the
//    commit are separate transactions on purpose, "because the provider call
//    sits between them and a transaction may not be held open across it", and
//    section 4.4 of docs/plans/2026-09-16-web-mcp-postgres-surface.md gives
//    the same rule its teeth: `KITH_IDLE_TRANSACTION_TIMEOUT_MS` is five
//    seconds and a provider round trip is bounded at fifteen, so a fill run
//    inside `drain`'s ordinary handler transaction would be killed by the
//    server rather than merely be impolite. So this job is registered as a
//    pooled handler (`../deferred/registry.ts`): `drain` hands it the pool and
//    opens nothing, and `runEmbeddingFill` opens one short transaction per
//    read page and one per commit, as it already did.
//
// 2. No successor to schedule. Convex's commit mutation scheduled its own
//    continuation inside its own transaction (`models/embeddings/fill.ts` line
//    256, which is what migration 017's comment on this kind names). The
//    ported driver replaced that with a loop -- "the default runs the space to
//    completion, which is what the daemon wants" -- so the handler passes no
//    `maxPages` and the job ends when the space owes nothing. A page that
//    embeds nothing already ends the run, so a space whose owed targets are
//    all unfillable cannot spin.
//
// The fill has no per-kind dimension: `nextEmbeddingFillPage` pages the space's
// owed targets of every kind through one index, and the page size is the
// provider batch. So the payload and the dedupe key are per space, and a
// payload that names a `targetKind` is refused rather than silently widened to
// the whole space.

import type { Pool } from "pg";

import {
  schedule,
  type DeferredCtx,
  type DeferredWorkRow,
  type ScheduleResult,
} from "../deferred/core.js";
import { KITH_ID } from "../ids.js";
import { runEmbeddingFill, type FillEmbedder } from "./fill.js";

/**
 * One queued fill per space. A burst of captures in one space converges on
 * this key: `schedule` dedupes against any `queued` or `running` row with the
 * same kind and key, so the second capture of a burst enqueues nothing and the
 * one job that does run covers every target the burst made eligible, because
 * it reads the owed index when it runs rather than a list fixed at schedule
 * time.
 */
export function embeddingFillDedupeKey(spaceId: string): string {
  return `embedding_fill:${spaceId}`;
}

/**
 * Enqueues the fill for a space. Call it inside the same transaction as the
 * write that changed eligibility, which is section 2.4's replacement for
 * `ctx.scheduler.runAfter`: the job row commits with the write or not at all,
 * so a rolled-back capture never leaves a fill queued for a thought that does
 * not exist.
 *
 * Never call it from a read path. A read that enqueued work would make every
 * search a writer.
 */
export async function scheduleEmbeddingFill(
  ctx: DeferredCtx,
  spaceId: string,
): Promise<ScheduleResult> {
  return await schedule(ctx, {
    kind: "embedding_fill",
    spaceId,
    payload: { spaceId },
    dedupeKey: embeddingFillDedupeKey(spaceId),
  });
}

/**
 * The job body. `pool`, not a `DeferredCtx`: see decision 1 above.
 *
 * `embed` is injected all the way from `defaultRegistry`, so the daemon runs
 * the provider-backed one and a test runs a recording one. Nothing here reads
 * the provider configuration itself and nothing here can log a key: the
 * embedder it is handed is the only thing that talks to a provider, and the
 * daemon's own (`providerBatchEmbedder`) already collapses every provider
 * error to a fixed string before it can reach `fail`.
 */
export async function runEmbeddingFillJob(
  pool: Pool,
  payload: Record<string, unknown>,
  job: DeferredWorkRow,
  embed: FillEmbedder,
): Promise<void> {
  const spaceId = payload.spaceId;
  if (typeof spaceId !== "string" || !KITH_ID.test(spaceId)) {
    throw new Error("embedding_fill payload requires a spaceId");
  }
  if (payload.targetKind !== undefined) {
    // The fill is whole-space by construction. Refusing rather than ignoring
    // keeps a future per-kind scheduler from silently getting a whole-space
    // fill and believing it got the kind it asked for.
    throw new Error("embedding_fill payload does not support targetKind");
  }
  if (job.spaceId !== null && job.spaceId !== spaceId) {
    throw new Error("embedding_fill payload is not in the job's space");
  }
  // Every statement below this line is space-scoped: `owedTargetsPage`,
  // `liveTargetText` and `commitEmbeddingFillPage` all carry `spaceId` and
  // recheck the row's own space, so a fill for one space can neither read nor
  // cover another's rows.
  await runEmbeddingFill(pool, spaceId, embed);
}
