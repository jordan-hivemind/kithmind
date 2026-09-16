// The durable counterpart to `rate-limit.ts`'s per-process token bucket, and
// the seam that picks between the two per `KITH_POSTGRES_SURFACE`.
//
// Section 8 question 2 of the web and MCP surface plan shipped i1 with the
// token bucket and opened a row for `kith.auth_rate_limits`, "where the real
// limit lands". This is that row: under `KITH_POSTGRES_SURFACE=postgres` the
// sign-in and sign-up routes spend from the durable table
// (`@repo/kith-store/identity` `consumeAuthAttempt`) instead of the
// in-process bucket, so a burst spread across a serverless deployment's
// instances hits one shared counter rather than the per-instance budget
// `rate-limit.ts`'s own header comment describes as multiplied by however
// many instances are live. Under `convex` nothing changes: there is no kith
// pool to spend against there, and the token bucket is kept exactly as i1
// shipped it.
//
// The limiter's transaction is deliberately its own `withKithTransaction`,
// opened and closed before the credential check ever runs, and never the same
// transaction `signIn`/`signUp` run in: a denied attempt must not reach the
// Scrypt verify, and a limiter that shared a transaction with the credential
// check could not be denied before the check started.
//
// A limiter failure -- the database is unreachable, or the transaction
// otherwise throws -- is not treated as "allowed". The caller (the two auth
// routes) maps `"unavailable"` to `limiterUnavailable()`, a 503 that fails
// closed rather than letting the attempt through as though nothing had
// refused it.

import { withKithTransaction } from "@repo/kith-store";
import { consumeAuthAttempt, identityCtx } from "@repo/kith-store/identity";
import type pg from "pg";

import { kithPool } from "@/lib/kith/pool";
import { kithPostgresSurface } from "@/lib/kith/surface";

import {
  AUTH_RATE_LIMIT_ATTEMPTS_PER_ACCOUNT,
  AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS,
  AUTH_RATE_LIMIT_WINDOW_MS,
  authRateLimiter,
  clientAddress,
} from "./rate-limit";

/** Same fallback key the in-memory limiter uses for an unattributable
 * request (see `AuthRateLimiter.check`): counted under one shared budget,
 * never exempt. `clientAddress` returning null must not be the cheapest way
 * past either limiter. */
const UNATTRIBUTED = "unattributed";

function retryAfterSecondsFromMs(retryAfterMs: number): number {
  // At least one second even when the window's remainder rounds to zero, so a
  // client that reads `Retry-After` literally never gets told to retry
  // immediately.
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/**
 * One attempt from `address` against `account`, spent against
 * `kith.auth_rate_limits` in its own short transaction.
 *
 * Address checked before account, same order and same reason as the in-memory
 * limiter: a refusal on the address bucket returns before the account bucket
 * is touched, so one address cannot drain a victim's account budget faster
 * than it drains its own.
 *
 * Throws when the transaction fails; the caller must treat that as a denial.
 */
async function durableAuthRateLimitDecision(
  pool: pg.Pool,
  input: { address: string | null; account: string | null },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const address = input.address ?? UNATTRIBUTED;
  const account = (input.account ?? UNATTRIBUTED).toLowerCase();
  return withKithTransaction(pool, async (client) => {
    const ctx = identityCtx(client);
    const byAddress = await consumeAuthAttempt(ctx, {
      scope: "auth_address",
      key: address,
      windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
      limit: AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS,
    });
    if (!byAddress.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: retryAfterSecondsFromMs(byAddress.retryAfterMs),
      };
    }
    const byAccount = await consumeAuthAttempt(ctx, {
      scope: "auth_account",
      key: account,
      windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
      limit: AUTH_RATE_LIMIT_ATTEMPTS_PER_ACCOUNT,
    });
    if (!byAccount.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: retryAfterSecondsFromMs(byAccount.retryAfterMs),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  });
}

export type AuthRateLimitOutcome =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly retryAfterSeconds: number }
  /** The durable limiter's own transaction failed. Fail closed: the caller
   * must refuse the request, not proceed as though this were "allowed". */
  | { readonly kind: "unavailable" };

/**
 * The one call the sign-in and sign-up routes make: picks the token bucket or
 * the durable table by `KITH_POSTGRES_SURFACE`, spends one attempt from it,
 * and reports the outcome in a shape neither backend needs the caller to
 * branch on any further.
 */
export async function checkAuthRateLimit(
  request: Request,
  account: string,
): Promise<AuthRateLimitOutcome> {
  const address = clientAddress(request);
  if (kithPostgresSurface() === "postgres") {
    try {
      const decision = await durableAuthRateLimitDecision(kithPool(), {
        address,
        account,
      });
      return decision.allowed
        ? { kind: "allowed" }
        : { kind: "denied", retryAfterSeconds: decision.retryAfterSeconds };
    } catch (error) {
      // The database dump/connection-string rule applies here too: log the
      // real error, tell the client nothing beyond "unavailable".
      console.error("kith durable auth rate limiter failed", error);
      return { kind: "unavailable" };
    }
  }
  const decision = authRateLimiter().check({ address, account });
  return decision.allowed
    ? { kind: "allowed" }
    : { kind: "denied", retryAfterSeconds: decision.retryAfterSeconds };
}
