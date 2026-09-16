// `kith.auth_rate_limits`: the durable rate limiter section 8 question 2 of the
// web and MCP surface plan opened a row for.
//
// Slice i1 shipped the sign-in and sign-up routes with a per-process token
// bucket (`apps/web/src/lib/kith/rate-limit.ts`), keyed by client address and
// by account, and said plainly why that is weaker than the Convex table it
// replaced: "the counters live in one process's memory ... an attacker who
// spreads attempts across [instances] gets roughly the limit multiplied by the
// number of live instances", and "an instance that is recycled forgets every
// counter". This module is the fix: one shared counter every instance reads
// and writes, so a burst spread across a serverless deployment's instances
// hits one budget instead of one budget per instance.
//
// The shape is copied from `kith.worker_protocol_rate_limits`
// (`../workers/rateLimit.ts`): a fixed window per key, one row per key, and an
// `ON CONFLICT ... DO UPDATE` that either restarts an expired window or
// increments a live one in a single statement, so the decision is atomic in
// the database rather than a read, a branch and a write that a concurrent
// request could race. Also copied: a refused attempt still counts. Retrying
// into a refusal must not make the limit softer, which is the same property
// the worker limiter's own comment states.
//
// `consumeAuthAttempt` is deliberately generic -- `scope`, `windowMs` and
// `limit` are the caller's, not a constant this module bakes in -- because the
// two budgets the auth routes spend from (per address, per account) already
// have their numbers defined once, in `apps/web/src/lib/kith/rate-limit.ts`,
// and a second copy of those numbers here is a second place for them to
// disagree. The caller passes them in.

import { sha256 } from "../hash.js";
import { newKithId } from "../ids.js";
import { at, row, type IdentityCtx } from "./db.js";

/** How far back a row's own window is certainly over, for the sweep. Must be
 * kept in lockstep with `AUTH_RATE_LIMIT_WINDOW_MS` in
 * `apps/web/src/lib/kith/rate-limit.ts` -- the same relationship
 * `WORKER_MUTATION_RATE_WINDOW_MS` already has with
 * `removeExpiredWorkerProtocolState`'s own rate-limit cleanup. A caller
 * sweeping rows written with a different window may pass one explicitly. */
export const AUTH_RATE_LIMIT_SWEEP_WINDOW_MS = 15 * 60 * 1000;

const MAX_SCOPE_LENGTH = 64;
/** An email's own practical bound (RFC 5321) is long enough for a truncated
 * client address too; both are what `scope` may hold as `key`. */
const MAX_KEY_LENGTH = 320;

export type AuthRateLimitAttempt = {
  /** Which budget this spends from, e.g. `"auth_address"` or
   * `"auth_account"`. Two calls with the same `scope` and `key` share one
   * counter; two calls with the same `key` but a different `scope` do not. */
  readonly scope: string;
  /** The caller-chosen identity being limited, e.g. a client address or an
   * account email. Never stored in the clear -- see the module comment on
   * migration 019 for why -- and never reaches SQL except as a bind
   * parameter. */
  readonly key: string;
  /** How long a window lasts before it restarts. */
  readonly windowMs: number;
  /** Attempts allowed in one window. */
  readonly limit: number;
};

export type AuthRateLimitConsumption = {
  readonly allowed: boolean;
  /** Attempts left in the current window, 0 when refused. */
  readonly remaining: number;
  /** Milliseconds until the window restarts, 0 when allowed. */
  readonly retryAfterMs: number;
};

type RateRow = { window_started_at: Date; count: number };

/**
 * Spends one unit of `attempt`'s budget, restarting an expired window or
 * incrementing a live one, and reports whether this attempt is within the
 * limit.
 *
 * Unlike the in-process token bucket, a refused attempt still increments the
 * stored count -- copied from the worker protocol limiter's own rule, so that
 * hammering a refusal cannot make it soften.
 *
 * Throws on an invalid `attempt` (a caller bug) rather than on the database
 * being unreachable, which surfaces as a rejected promise the same way any
 * other query failure does; the caller (the auth routes, under
 * `KITH_POSTGRES_SURFACE=postgres`) is responsible for treating that as a
 * denial and failing closed rather than proceeding to the credential check.
 */
export async function consumeAuthAttempt(
  ctx: IdentityCtx,
  attempt: AuthRateLimitAttempt,
): Promise<AuthRateLimitConsumption> {
  if (attempt.scope.length < 1 || attempt.scope.length > MAX_SCOPE_LENGTH) {
    throw new Error("Auth rate limit scope is invalid");
  }
  if (attempt.key.length < 1 || attempt.key.length > MAX_KEY_LENGTH) {
    throw new Error("Auth rate limit key is invalid");
  }
  if (!Number.isFinite(attempt.windowMs) || attempt.windowMs <= 0) {
    throw new Error("Auth rate limit window is invalid");
  }
  if (!Number.isInteger(attempt.limit) || attempt.limit < 1) {
    throw new Error("Auth rate limit limit is invalid");
  }

  const windowFloor = new Date(ctx.now - attempt.windowMs);
  const updated = await row<RateRow>(
    ctx,
    `INSERT INTO kith.auth_rate_limits
       (id, created_at, scope, key_hash, window_started_at, count)
     VALUES ($1, transaction_timestamp(), $2, $3, $4, 1)
     ON CONFLICT (scope, key_hash) DO UPDATE
       SET window_started_at =
             CASE WHEN kith.auth_rate_limits.window_started_at <= $5
                  THEN $4
                  ELSE kith.auth_rate_limits.window_started_at END,
           count =
             CASE WHEN kith.auth_rate_limits.window_started_at <= $5
                  THEN 1
                  ELSE kith.auth_rate_limits.count + 1 END
     RETURNING window_started_at, count`,
    [newKithId(), attempt.scope, sha256(attempt.key), at(ctx.now), windowFloor],
  );
  if (updated === null) {
    throw new Error("Auth rate limit upsert returned no row");
  }

  const allowed = updated.count <= attempt.limit;
  const remaining = Math.max(0, attempt.limit - updated.count);
  const retryAfterMs = allowed
    ? 0
    : Math.max(
        0,
        updated.window_started_at.getTime() + attempt.windowMs - ctx.now,
      );
  return { allowed, remaining, retryAfterMs };
}
