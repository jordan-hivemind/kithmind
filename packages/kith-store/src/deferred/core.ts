// `kith.deferred_work`: the replacement for every `ctx.scheduler.runAfter`
// call site section 1.4 of the consolidation plan lists, and for the four
// periodic Convex crons `src/deferred/sweeps.ts` and `tick.ts` drive instead.
//
// A Convex `ctx.scheduler.runAfter(delay, fn, args)` becomes one row here,
// insertable in the same transaction as the write it follows -- section 2.4's
// "scheduled mutation is transactional with its scheduler" -- and drained
// under a lease the same shape `kith.worker_jobs` already claims ingestion
// work with: `FOR UPDATE SKIP LOCKED`, one fresh lease token per claim, a
// bounded number of attempts, and backoff on failure via `run_after`.
//
// One clock, one transaction, same as every other ported surface in this
// package: `DeferredCtx` is `{ client, now }`, and every function here assumes
// its caller opened one `SERIALIZABLE` transaction (`withKithTransaction`)
// around it.
//
// `attempts` increments in two places, not one: `fail` counts a handler that
// ran and threw, and `claim` itself counts a reclaim of a `running` row whose
// lease expired without either `complete` or `fail` ever being called -- the
// runner that held it died mid-handler (crashed, was killed, lost its
// connection) rather than failing cleanly. Without the second counter, a job
// that reliably crashes its runner reclaims forever: `max_attempts` never
// arrives, because nothing ever increments toward it. `claim` also fails a
// reclaim outright, without a further reclaim, once one more reclaim would
// put `attempts` at or past `max_attempts` -- the same exhaustion boundary
// `fail` itself applies -- so `deferred_work_attempts_check` (`attempts <=
// max_attempts`) is never at risk from the claim path either.

import { ProofError } from "../errors.js";
import { newKithId } from "../ids.js";
import { randomBytes } from "node:crypto";

import {
  at,
  exec,
  row,
  rows,
  workerCtx,
  type WorkerCtx as DeferredCtx,
} from "../workers/db.js";

export type { DeferredCtx };
export { workerCtx as deferredCtx, at, exec, row, rows };

/**
 * The closed set of job kinds `kith.deferred_work`'s CHECK constraint allows.
 * Keep this in step with `migrations/017_deferred_work.sql`: the two are one
 * convention written twice, the same relationship `KITH_ID` has with its own
 * domain CHECK.
 */
export const DEFERRED_WORK_KINDS = [
  "inline_ingestion",
  "embedding_fill",
  "card_queue_tick",
] as const;

export type DeferredWorkKind = (typeof DEFERRED_WORK_KINDS)[number];

export function isDeferredWorkKind(value: unknown): value is DeferredWorkKind {
  return (
    typeof value === "string" &&
    (DEFERRED_WORK_KINDS as readonly string[]).includes(value)
  );
}

export type DeferredWorkState = "queued" | "running" | "done" | "failed";

export type DeferredWorkRow = {
  id: string;
  spaceId: string | null;
  kind: DeferredWorkKind;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  runAfter: Date;
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  state: DeferredWorkState;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function camelRow(raw: Record<string, unknown>): DeferredWorkRow {
  return {
    id: raw.id as string,
    spaceId: (raw.space_id as string | null) ?? null,
    kind: raw.kind as DeferredWorkKind,
    payload: (raw.payload as Record<string, unknown>) ?? {},
    dedupeKey: (raw.dedupe_key as string | null) ?? null,
    runAfter: raw.run_after as Date,
    attempts: Number(raw.attempts),
    maxAttempts: Number(raw.max_attempts),
    leaseToken: (raw.lease_token as string | null) ?? null,
    leaseExpiresAt: (raw.lease_expires_at as Date | null) ?? null,
    state: raw.state as DeferredWorkState,
    lastError: (raw.last_error as string | null) ?? null,
    createdAt: raw.created_at as Date,
    updatedAt: raw.updated_at as Date,
  };
}

const MAX_DEDUPE_KEY_BYTES = 200;
const DEFAULT_MAX_ATTEMPTS = 5;

export type ScheduleInput = {
  kind: DeferredWorkKind;
  spaceId?: string | null;
  payload?: Record<string, unknown>;
  /** Epoch ms this job first becomes claimable. Defaults to `ctx.now`. */
  runAfter?: number;
  /**
   * De-duplicates against any other `queued` or `running` row of the same
   * `kind` and key: scheduling the same job twice while it is still pending
   * is a no-op, which is what makes a missed tick, or a sweep that runs
   * twice, cost nothing rather than double-enqueue.
   */
  dedupeKey?: string;
  maxAttempts?: number;
};

export type ScheduleResult = { id: string; deduped: boolean };

/**
 * Enqueues one job. Section 2.4's replacement for
 * `ctx.scheduler.runAfter(delay, fn, args)`: call this inside the same
 * transaction as the write it follows, and the row commits or rolls back with
 * it, never separately.
 */
export async function schedule(
  ctx: DeferredCtx,
  input: ScheduleInput,
): Promise<ScheduleResult> {
  if (!isDeferredWorkKind(input.kind)) {
    throw new ProofError("deferred_work_invalid_kind");
  }
  if (
    input.dedupeKey !== undefined &&
    (typeof input.dedupeKey !== "string" ||
      input.dedupeKey.length === 0 ||
      Buffer.byteLength(input.dedupeKey, "utf8") > MAX_DEDUPE_KEY_BYTES)
  ) {
    throw new ProofError("deferred_work_invalid_dedupe_key");
  }
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20
  ) {
    throw new ProofError("deferred_work_invalid_max_attempts");
  }
  const runAfter = input.runAfter ?? ctx.now;
  if (!Number.isSafeInteger(runAfter)) {
    throw new ProofError("deferred_work_invalid_run_after");
  }

  if (input.dedupeKey !== undefined) {
    const existing = await row<{ id: string }>(
      ctx,
      `SELECT id FROM kith.deferred_work
         WHERE kind = $1 AND dedupe_key = $2 AND state IN ('queued', 'running')`,
      [input.kind, input.dedupeKey],
    );
    if (existing) return { id: existing.id, deduped: true };
  }

  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.deferred_work
       (id, space_id, kind, payload, dedupe_key, run_after, max_attempts,
        state, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'queued', $8, $8)
       ON CONFLICT DO NOTHING`,
    [
      id,
      input.spaceId ?? null,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey ?? null,
      at(runAfter),
      maxAttempts,
      at(ctx.now),
    ],
  );
  const inserted = await row<{ id: string }>(
    ctx,
    "SELECT id FROM kith.deferred_work WHERE id = $1",
    [id],
  );
  if (inserted) return { id, deduped: false };
  // The unique dedupe index raced us: another transaction committed a
  // matching queued row between our read and our insert. Its row is the
  // canonical one now.
  if (input.dedupeKey !== undefined) {
    const winner = await row<{ id: string }>(
      ctx,
      `SELECT id FROM kith.deferred_work
         WHERE kind = $1 AND dedupe_key = $2 AND state IN ('queued', 'running')`,
      [input.kind, input.dedupeKey],
    );
    if (winner) return { id: winner.id, deduped: true };
  }
  throw new ProofError("deferred_work_schedule_conflict");
}

export type ClaimedDeferredWork = DeferredWorkRow & {
  state: "running";
  leaseToken: string;
  leaseExpiresAt: Date;
};

const DEFAULT_LEASE_MS = 60_000;

/**
 * How many expired-lease `running` rows one `claim` call fails outright, per
 * call, before it does its own claim scan. Bounded the same way
 * `claimWorkerJob`'s own `exhausted` CTE (`src/index.ts`) bounds its
 * equivalent pass: this runs on every claim, so it must never hold more than
 * a small page of rows locked.
 */
const RECLAIM_EXHAUSTION_BATCH_LIMIT = 25;

/**
 * Claims at most one due job under `FOR UPDATE SKIP LOCKED`, the same
 * concurrency shape `kith.worker_jobs` already uses: two concurrent drains
 * racing this statement each get a different row, or one gets none, never the
 * same row twice.
 *
 * A row is due when it is `queued` with `run_after <= now`, or `running` with
 * an expired lease -- a drain that crashed mid-job leaves its row reclaimable
 * rather than stuck, with no separate sweep required. Reclaiming a `running`
 * row is not free, though: it is scored as a consumed attempt the same way a
 * handler that ran and called `fail` would be, via the `CASE` in the
 * `UPDATE`'s `attempts` assignment below (only a `running` row's old state
 * matches it; a freshly claimed `queued` row's attempts are untouched). Before
 * that scan runs, a first pass moves any expired-lease `running` row that a
 * further reclaim would push to or past `max_attempts` straight to `failed`
 * with `last_error = 'lease expired'`, bounded by
 * `RECLAIM_EXHAUSTION_BATCH_LIMIT` -- the same exhaustion check `fail` makes,
 * applied here so the claim path can increment `attempts` without ever
 * violating `deferred_work_attempts_check`.
 */
export async function claim(
  ctx: DeferredCtx,
  options: { leaseMs?: number } = {},
): Promise<ClaimedDeferredWork | null> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = at(ctx.now);

  // A reclaim of these rows would put `attempts` at or past `max_attempts`:
  // fail them now, without reclaiming, so the claim below never has to.
  await exec(
    ctx,
    `WITH exhausted AS (
       SELECT id FROM kith.deferred_work
        WHERE state = 'running' AND lease_expires_at <= $1
          AND attempts + 1 >= max_attempts
        ORDER BY lease_expires_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${RECLAIM_EXHAUSTION_BATCH_LIMIT}
     )
     UPDATE kith.deferred_work w
        SET state = 'failed', attempts = attempts + 1, lease_token = NULL,
            lease_expires_at = NULL, last_error = 'lease expired',
            updated_at = $1
       FROM exhausted e
      WHERE w.id = e.id`,
    [now],
  );

  const leaseToken = randomBytes(24).toString("base64url");
  const leaseExpiresAt = ctx.now + leaseMs;
  const claimed = await row<Record<string, unknown>>(
    ctx,
    `WITH candidate AS (
       SELECT id FROM kith.deferred_work
        WHERE (state = 'queued' AND run_after <= $1)
           OR (state = 'running' AND lease_expires_at <= $1)
        ORDER BY run_after, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE kith.deferred_work w
        SET state = 'running', lease_token = $2, lease_expires_at = $3,
            attempts = CASE WHEN w.state = 'running'
                            THEN w.attempts + 1 ELSE w.attempts END,
            updated_at = $1
       FROM candidate c
      WHERE w.id = c.id
      RETURNING w.*`,
    [now, leaseToken, at(leaseExpiresAt)],
  );
  if (!claimed) return null;
  return camelRow(claimed) as ClaimedDeferredWork;
}

export type CompleteResult = { status: "completed" | "lease_lost" };

/** Marks a claimed job `done`. A lost lease (reclaimed by another drain, or
 * already completed) is reported rather than thrown: a handler that raced a
 * reclaim should not treat that as its own failure. */
export async function complete(
  ctx: DeferredCtx,
  args: { id: string; leaseToken: string },
): Promise<CompleteResult> {
  const updated = await rows<{ id: string }>(
    ctx,
    `UPDATE kith.deferred_work
        SET state = 'done', lease_token = NULL, lease_expires_at = NULL,
            last_error = NULL, updated_at = $1
      WHERE id = $2 AND state = 'running' AND lease_token = $3
      RETURNING id`,
    [at(ctx.now), args.id, args.leaseToken],
  );
  return { status: updated.length === 1 ? "completed" : "lease_lost" };
}

export type FailResult =
  | { status: "retrying"; nextAttemptAt: number }
  | { status: "exhausted" }
  | { status: "lease_lost" };

const FAIL_BACKOFF_BASE_MS = 2_000;
const FAIL_BACKOFF_MAX_MS = 15 * 60_000;

/** Full-jitter backoff, the same shape `kithSerializationBackoffDelayMs`
 * (`schema.ts`) uses, so two failing jobs of the same kind do not retry in
 * lockstep against whatever they are contending on. */
function failBackoffDelayMs(attempts: number): number {
  const cap = Math.min(
    FAIL_BACKOFF_MAX_MS,
    FAIL_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
  );
  return Math.round(Math.random() * cap);
}

/**
 * Records a claimed job's failure: bounded attempts, then a typed terminal
 * state rather than an unbounded retry, mirroring `withKithTransaction`'s own
 * "past three attempts the honest answer is a typed conflict" policy
 * (`schema.ts`). Below `maxAttempts` the job goes back to `queued` with
 * `run_after` pushed out by backoff; at `maxAttempts` it becomes `failed` and
 * stays there for an operator to inspect.
 */
export async function fail(
  ctx: DeferredCtx,
  args: { id: string; leaseToken: string; error: string },
): Promise<FailResult> {
  const current = await row<{
    attempts: string | number;
    max_attempts: string | number;
    state: string;
    lease_token: string | null;
  }>(
    ctx,
    `SELECT attempts, max_attempts, state, lease_token
       FROM kith.deferred_work WHERE id = $1 FOR UPDATE`,
    [args.id],
  );
  if (
    !current ||
    current.state !== "running" ||
    current.lease_token !== args.leaseToken
  ) {
    return { status: "lease_lost" };
  }
  const attempts = Number(current.attempts) + 1;
  const maxAttempts = Number(current.max_attempts);
  if (attempts >= maxAttempts) {
    await exec(
      ctx,
      `UPDATE kith.deferred_work
          SET state = 'failed', attempts = $1, lease_token = NULL,
              lease_expires_at = NULL, last_error = $2, updated_at = $3
        WHERE id = $4`,
      [attempts, args.error.slice(0, 2000), at(ctx.now), args.id],
    );
    return { status: "exhausted" };
  }
  const nextAttemptAt = ctx.now + failBackoffDelayMs(attempts);
  await exec(
    ctx,
    `UPDATE kith.deferred_work
        SET state = 'queued', attempts = $1, run_after = $2,
            lease_token = NULL, lease_expires_at = NULL, last_error = $3,
            updated_at = $4
      WHERE id = $5`,
    [attempts, at(nextAttemptAt), args.error.slice(0, 2000), at(ctx.now), args.id],
  );
  return { status: "retrying", nextAttemptAt };
}

/**
 * Fails a job without consuming an attempt: the one case that is not the
 * handler's fault. `drain` uses this when a job's `kind` has no registered
 * handler -- an operational gap, not a bad job -- so the row is marked
 * `failed` for visibility without eating into the retry budget a real
 * handler failure would.
 */
export async function failWithoutAttempt(
  ctx: DeferredCtx,
  args: { id: string; leaseToken: string; error: string },
): Promise<CompleteResult> {
  const updated = await rows<{ id: string }>(
    ctx,
    `UPDATE kith.deferred_work
        SET state = 'failed', lease_token = NULL, lease_expires_at = NULL,
            last_error = $1, updated_at = $2
      WHERE id = $3 AND state = 'running' AND lease_token = $4
      RETURNING id`,
    [args.error.slice(0, 2000), at(ctx.now), args.id, args.leaseToken],
  );
  return { status: updated.length === 1 ? "completed" : "lease_lost" };
}

/** Read-only lookup, for tests and operator tooling. */
export async function get(
  ctx: DeferredCtx,
  id: string,
): Promise<DeferredWorkRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.deferred_work WHERE id = $1",
    [id],
  );
  return found ? camelRow(found) : null;
}
