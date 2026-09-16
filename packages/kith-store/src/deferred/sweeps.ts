// The three periodic Convex crons section 1.4 keeps as sweeps rather than
// retiring outright. Each is bounded, idempotent and safe to run twice in a
// row for nothing: "a missed tick must cost nothing" (section 2.6).
//
// A fourth cron, `detect missing filesystem workers`, is deliberately not
// here: section 2.6 turns it into a read-time predicate
// (`isWatcherOverdue` in `../workers/diagnostics.js`) plus one daily durable
// incident record (`recordMissingWorkerIncidents`, same file). It stops being
// a per-minute sweep entirely, so it is not one of the three functions below.

import { WORKER_MUTATION_RATE_WINDOW_MS } from "@repo/worker-protocol";

import { AUTH_RATE_LIMIT_SWEEP_WINDOW_MS } from "../identity/rateLimits.js";
import { removeExpired as removeExpiredOAuth } from "../identity/oauth.js";
import { at, rows, type DeferredCtx } from "./core.js";
import { schedule } from "./core.js";

export type SweepResult = { removed: number; remaining: boolean };
export type RecoverySweepResult = { recovered: number; remaining: boolean };

const INLINE_RECOVERY_BATCH_SIZE = 10;

/**
 * `models/ingestion/inlineWorker.ts` `recover`.
 *
 * The same candidate selection as `reserveRecoverableInlineWork` (bounded scan
 * of `kith.inline_work` for `queued`, `running` or `failed` rows whose
 * `next_attempt_at` is due, oldest due time first), and for each candidate, its
 * continuation enqueued as an `inline_ingestion` `kith.deferred_work` job keyed
 * by the work row's id. P2-39e2 registered the handler that runs it
 * (`inlineIngestionHandler` in `../ingestion/inlineWork.ts`, wired up in
 * `registry.ts`), so a stranded row is now resumed rather than merely tracked;
 * the payload shape the handler reads, `{ workId }`, is the one written below.
 *
 * Still not ported from `reserveRecoverableInlineWork`: the reservation itself
 * (Convex pushed a candidate's `next_attempt_at` out by one lease before
 * scheduling it), `requireWorkChain`'s validation, and the terminal-state and
 * revoked-authorization sync it did for each candidate. None is needed here for
 * correctness and each would duplicate a check the handler already makes:
 * `dedupeKey` keeps a candidate from being queued twice while it is pending, and
 * `processInlineWork` re-reads the whole chain, re-checks the recorded actor and
 * syncs the work row's state under the claim it takes.
 */
export async function recoverInlineIngestion(
  ctx: DeferredCtx,
  options: { limit?: number } = {},
): Promise<RecoverySweepResult> {
  const limit = options.limit ?? INLINE_RECOVERY_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Inline ingestion recovery limit is invalid");
  }
  const candidates = await rows<{
    id: string;
    space_id: string | null;
  }>(
    ctx,
    `SELECT id, space_id FROM kith.inline_work
       WHERE state IN ('queued', 'running', 'failed')
         AND next_attempt_at IS NOT NULL
         AND next_attempt_at <= $1
       ORDER BY next_attempt_at, id
       LIMIT $2`,
    [at(ctx.now), limit + 1],
  );
  const remaining = candidates.length > limit;
  let recovered = 0;
  for (const candidate of candidates.slice(0, limit)) {
    await schedule(ctx, {
      kind: "inline_ingestion",
      spaceId: candidate.space_id,
      payload: { workId: candidate.id },
      dedupeKey: candidate.id,
    });
    recovered += 1;
  }
  return { recovered, remaining };
}

/**
 * `models/oauth/cleanup.ts` `removeExpired`, unchanged: it was already ported
 * onto `kith.api_keys` and `kith.consumed_oauth_codes` in `src/identity/oauth.ts`
 * (deliverable item 6 of that row). This wraps it in the sweep result shape
 * the daemon's other two sweeps share.
 */
export async function removeExpiredOAuthGrants(
  ctx: DeferredCtx,
  options: { limit?: number } = {},
): Promise<SweepResult> {
  const result = await removeExpiredOAuth(ctx, options);
  return { removed: result.deleted, remaining: result.hasMore };
}

const WORKER_PROTOCOL_SWEEP_BATCH_SIZE = 200;

/**
 * One bounded pass deleting every worker-protocol row past its own
 * `retire_at` (or, for the reservation targets and rate-limit windows, its own
 * expiry column), across the tables `migrations/008_worker_protocol.sql` and
 * `migrations/010_worker_processing.sql` index for exactly this purpose.
 *
 * `models/workers/cleanup.ts` `removeExpired` did the equivalent sweep as a
 * ten-phase checkpointed state machine, one phase per Convex mutation call,
 * because a Convex mutation has a read/write budget that forces a scan across
 * many separate calls. That budget does not exist here (section 2.4: "no
 * platform limit, but keep the existing page sizes"), so this is one bounded
 * pass over every table instead: still capped per table so no single tick
 * holds a table's rows locked for long, but not checkpointed across ticks the
 * way the Convex version had to be.
 *
 * Two of Convex's cross-reference checks are ported after all, because they
 * are not merely a liveness convention this sweep can trust the write paths
 * to have already applied: they are `DEFERRABLE INITIALLY DEFERRED` foreign
 * keys with no `ON DELETE` clause (migration 004), so a delete that ignores
 * them does not fail loudly at the `DELETE` -- it fails silently until
 * `COMMIT`, at which point the whole sweep transaction aborts, every tick,
 * forever, until the referencing row itself goes away. `kith.source_inventory`
 * (`first_seen_scan_id`, `last_seen_scan_id`, `missing_since_scan_id`) and
 * `kith.ingest_jobs` (`worker_discovery_work_id`) both hold such references
 * into the tables below, and neither is a table this sweep drains, so a scan
 * or discovery-work row can age past `retire_at` while something durable
 * still points to it. `deleteByRetireAt` below excludes exactly those two
 * referenced sets with `NOT EXISTS` subqueries; every other cross-reference
 * Convex checked is still not ported, for the reason above.
 *
 * Delete order matters where a foreign key has no `ON DELETE CASCADE`
 * (migration 008): children before parents, so a scan's pages and entries are
 * gone before the scan itself is considered.
 */
export async function removeExpiredWorkerProtocolState(
  ctx: DeferredCtx,
  options: { limit?: number } = {},
): Promise<SweepResult> {
  const limit = options.limit ?? WORKER_PROTOCOL_SWEEP_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("Worker protocol sweep limit is invalid");
  }
  const now = at(ctx.now);
  let removed = 0;
  let remaining = false;

  // `guard`, when given, is a `NOT EXISTS (...)` clause (referencing the
  // candidate row as `t`) that excludes a row still referenced by a durable
  // table this sweep does not itself drain -- see the module comment above.
  const deleteByRetireAt = async (table: string, guard?: string) => {
    const guardClause = guard ? ` AND ${guard}` : "";
    const doomed = await rows<{ id: string }>(
      ctx,
      `WITH doomed AS (
         SELECT t.id FROM kith.${table} t
          WHERE t.retire_at <= $1${guardClause}
          ORDER BY t.retire_at, t.id
          LIMIT $2
       )
       DELETE FROM kith.${table} w USING doomed d
        WHERE w.id = d.id
        RETURNING w.id`,
      [now, limit],
    );
    removed += doomed.length;
    if (doomed.length === limit) remaining = true;
  };

  const deleteByLeaseExpiresAt = async (table: string) => {
    const doomed = await rows<{ id: string }>(
      ctx,
      `WITH doomed AS (
         SELECT id FROM kith.${table}
          WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= $1
          ORDER BY lease_expires_at, id
          LIMIT $2
       )
       DELETE FROM kith.${table} w USING doomed d
        WHERE w.id = d.id
        RETURNING w.id`,
      [now, limit],
    );
    removed += doomed.length;
    if (doomed.length === limit) remaining = true;
  };

  // Children before parents: worker_discovery_work references
  // worker_scan_entries, which references worker_scan_pages, which
  // references worker_source_scans (migration 008's FKs, none cascading).
  //
  // Two of those parents are also referenced from outside this table set,
  // by durable rows this sweep never deletes (migration 004's FKs, also
  // none cascading): a discovery-work row an `ingest_jobs` row still points
  // to via `worker_discovery_work_id`, and a scan a `source_inventory` row
  // still points to via `first_seen_scan_id`, `last_seen_scan_id` or
  // `missing_since_scan_id`. Deleting either past its own `retire_at`
  // regardless would leave the referencing row dangling, which Postgres
  // only catches at `COMMIT` (both FKs are `DEFERRABLE INITIALLY DEFERRED`)
  // -- aborting this sweep's whole transaction, every tick, for as long as
  // the reference exists. The guards below keep a referenced row past its
  // own retirement instead; it becomes collectible the moment the reference
  // is gone.
  await deleteByRetireAt(
    "worker_discovery_work",
    `NOT EXISTS (
       SELECT 1 FROM kith.ingest_jobs ij
        WHERE ij.worker_discovery_work_id = t.id
     )`,
  );
  await deleteByRetireAt("worker_scan_entries");
  await deleteByRetireAt("worker_scan_pages");
  await deleteByRetireAt(
    "worker_source_scans",
    `NOT EXISTS (
       SELECT 1 FROM kith.source_inventory si
        WHERE si.first_seen_scan_id = t.id
           OR si.last_seen_scan_id = t.id
           OR si.missing_since_scan_id = t.id
     )`,
  );

  // Independent tables: no other ported table's FK references these.
  await deleteByLeaseExpiresAt("worker_reservation_targets");
  await deleteByRetireAt("worker_reservation_receipts");
  await deleteByRetireAt("worker_operation_receipts");
  await deleteByRetireAt("worker_parsed_stages");
  await deleteByRetireAt("worker_processing_assessments");
  await deleteByRetireAt("worker_binary_operation_receipts");

  // The rate-limit window table has no `retire_at`; Convex's sweep expired it
  // by its own `windowStartedAt` against the current rate window instead.
  const rateLimitCutoff = at(ctx.now - WORKER_MUTATION_RATE_WINDOW_MS);
  const doomedRateLimits = await rows<{ id: string }>(
    ctx,
    `WITH doomed AS (
       SELECT id FROM kith.worker_protocol_rate_limits
        WHERE window_started_at <= $1
        ORDER BY window_started_at, id
        LIMIT $2
     )
     DELETE FROM kith.worker_protocol_rate_limits w USING doomed d
      WHERE w.id = d.id
      RETURNING w.id`,
    [rateLimitCutoff, limit],
  );
  removed += doomedRateLimits.length;
  if (doomedRateLimits.length === limit) remaining = true;

  return { removed, remaining };
}

const AUTH_RATE_LIMIT_SWEEP_BATCH_SIZE = 200;

/**
 * `kith.auth_rate_limits`'s own expiry sweep, wired into `tick` beside the
 * worker protocol state sweep above rather than into that function itself,
 * because the two tables are unrelated domains that happen to share the same
 * "fixed window, no `retire_at`" shape.
 *
 * The table has no `retire_at` (migration 019): a row is doomed once its own
 * `window_started_at` is far enough in the past that no caller could still be
 * inside that window, the same test `removeExpiredWorkerProtocolState` applies
 * to `kith.worker_protocol_rate_limits` a few lines up. `windowMs` defaults to
 * `AUTH_RATE_LIMIT_SWEEP_WINDOW_MS`, which the comment on that constant says
 * must be kept in lockstep with the auth routes' own window; a caller sweeping
 * rows written with a different window may pass one explicitly.
 */
export async function removeExpiredAuthRateLimits(
  ctx: DeferredCtx,
  options: { limit?: number; windowMs?: number } = {},
): Promise<SweepResult> {
  const limit = options.limit ?? AUTH_RATE_LIMIT_SWEEP_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("Auth rate limit sweep limit is invalid");
  }
  const windowMs = options.windowMs ?? AUTH_RATE_LIMIT_SWEEP_WINDOW_MS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("Auth rate limit sweep window is invalid");
  }
  const cutoff = at(ctx.now - windowMs);
  const doomed = await rows<{ id: string }>(
    ctx,
    `WITH doomed AS (
       SELECT id FROM kith.auth_rate_limits
        WHERE window_started_at <= $1
        ORDER BY window_started_at, id
        LIMIT $2
     )
     DELETE FROM kith.auth_rate_limits w USING doomed d
      WHERE w.id = d.id
      RETURNING w.id`,
    [cutoff, limit],
  );
  return { removed: doomed.length, remaining: doomed.length === limit };
}
