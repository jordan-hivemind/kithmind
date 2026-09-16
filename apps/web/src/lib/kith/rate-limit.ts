// Rate limiting for the authentication routes.
//
// THIS IS WEAKER THAN WHAT IT REPLACES, AND SAYING SO IS THE POINT.
//
// Convex Auth kept an `authRateLimits` table, so a limit was durable and shared
// by every process that served a request. Plan 1.2 of the consolidation does
// not migrate that table and says "rate limit at the route". Question 2 of the
// surface plan asked whether to ship i1 with a per-process token bucket or block
// on a durable `kith.auth_rate_limits` table, and the owner adopted the
// recommendation: ship the bucket, open a row for the table.
//
// What that concedes, plainly:
//
//   - The counters live in one process's memory. A serverless deployment runs
//     several instances, so an attacker who spreads attempts across them gets
//     roughly the limit multiplied by the number of live instances.
//   - An instance that is recycled forgets every counter, which resets the
//     limit for whoever was being limited.
//   - Nothing here is a lockout. It sheds load and slows guessing; the thing
//     that actually stops a guessed password is the Scrypt cost in
//     `scrypt.ts` and the password itself.
//
// A durable `kith.auth_rate_limits` row is open and is where the real limit
// lands. Until then this is honest about being a speed bump, and it is still
// worth having, because an unauthenticated endpoint that runs a KDF per request
// with no ceiling at all is a free way to burn the deployment's CPU.

/** How long a bucket takes to refill from empty. */
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Attempts one client address may make in a window, across all accounts.
 *
 * Thirty, because the owner's own browser can legitimately retry a mistyped
 * password several times and a household shares one public address, while a
 * script guessing passwords wants orders of magnitude more than this.
 */
export const AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS = 30;

/**
 * Attempts against one account identifier in a window, from any address.
 *
 * Ten. Lower than the address limit because the address limit cannot see an
 * attacker spread across a proxy pool and this can. It is also the limit an
 * attacker can deliberately exhaust to keep a victim out, which is inherent to
 * limiting per account; ten is high enough that a real person mistyping a
 * password does not reach it and low enough to matter.
 */
export const AUTH_RATE_LIMIT_ATTEMPTS_PER_ACCOUNT = 10;

/**
 * How many distinct keys one bucket set remembers.
 *
 * A map keyed by client address grows with the number of addresses seen, which
 * an attacker chooses. Bounded, with the least recently touched key evicted,
 * so the worst case is a limiter that forgets rather than a process that runs
 * out of memory. Eviction favours the attacker, which is the correct trade: a
 * rate limiter must never be the thing that takes the service down.
 */
export const AUTH_RATE_LIMIT_MAX_KEYS = 4096;

type Bucket = { tokens: number; updatedAt: number };

export type TokenBucketOptions = {
  /** Attempts allowed from cold, and the ceiling the bucket refills to. */
  readonly capacity: number;
  /** How long a full refill takes. */
  readonly windowMs: number;
  readonly maxKeys?: number;
  /** Injectable clock. Tests pass a fake one; nothing else passes anything. */
  readonly now?: () => number;
};

/**
 * A token bucket per key, refilled continuously rather than in steps.
 *
 * Continuous refill rather than a fixed window counter, because a fixed window
 * lets an attacker spend the whole budget at the end of one window and the
 * whole budget again at the start of the next, which is twice the limit in an
 * instant. A bucket spreads the same budget.
 */
export class TokenBucket {
  readonly capacity: number;
  readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: TokenBucketOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error("Token bucket capacity must be a positive whole number");
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error("Token bucket window must be a positive duration");
    }
    this.capacity = options.capacity;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? AUTH_RATE_LIMIT_MAX_KEYS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Spends one token for `key`, returning false when the bucket is empty.
   *
   * A refusal spends nothing, so a caller that is already being limited does
   * not push its own recovery further away with every retry.
   */
  take(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? {
      tokens: this.capacity,
      updatedAt: now,
    };
    const refilled = Math.min(
      this.capacity,
      bucket.tokens +
        ((now - bucket.updatedAt) / this.windowMs) * this.capacity,
    );
    const allowed = refilled >= 1;
    // `updatedAt` moves on a refusal too, so the elapsed time it represents is
    // never counted twice into the refill.
    const next: Bucket = {
      tokens: allowed ? refilled - 1 : refilled,
      updatedAt: now,
    };
    // Re-inserting moves the key to the end of the Map's insertion order, which
    // is what makes the eviction below least-recently-used.
    this.buckets.delete(key);
    this.buckets.set(key, next);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done === true) break;
      this.buckets.delete(oldest.value);
    }
    return allowed;
  }

  /** Test-only: how many keys are currently remembered. */
  get size(): number {
    return this.buckets.size;
  }
}

export type AuthRateLimitDecision = {
  readonly allowed: boolean;
  /** Which limit refused, for the log. Never returned to the client. */
  readonly limit?: "address" | "account";
  /** Seconds a client may wait before one token is back. */
  readonly retryAfterSeconds: number;
};

/**
 * The two buckets the authentication routes share, keyed by client address and
 * by account identifier.
 *
 * Module scoped, so one instance's buckets are shared by every request that
 * instance serves and by no other instance. That is the weakness the header
 * comment describes.
 */
export class AuthRateLimiter {
  private readonly byAddress: TokenBucket;
  private readonly byAccount: TokenBucket;

  constructor(now?: () => number) {
    this.byAddress = new TokenBucket({
      capacity: AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS,
      windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
      now,
    });
    this.byAccount = new TokenBucket({
      capacity: AUTH_RATE_LIMIT_ATTEMPTS_PER_ACCOUNT,
      windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
      now,
    });
  }

  /**
   * One attempt from `address` against `account`.
   *
   * The address bucket is checked first and a refusal there returns before the
   * account bucket is touched, so one address cannot drain a victim's account
   * budget faster than it drains its own.
   *
   * `account` is lowercased so that two spellings of one email address are one
   * budget. It is a key in a local map and never reaches SQL or a response.
   */
  check(input: {
    address: string | null;
    account: string | null;
  }): AuthRateLimitDecision {
    const retryAfterSeconds = Math.ceil(
      AUTH_RATE_LIMIT_WINDOW_MS / AUTH_RATE_LIMIT_ATTEMPTS_PER_ACCOUNT / 1000,
    );
    // An unattributable request still counts, under one shared key, rather than
    // being exempt: "no address" must not be the cheapest way past the limit.
    const address = input.address ?? "unattributed";
    if (!this.byAddress.take(address)) {
      return { allowed: false, limit: "address", retryAfterSeconds };
    }
    const account = (input.account ?? "unattributed").toLowerCase();
    if (!this.byAccount.take(account)) {
      return { allowed: false, limit: "account", retryAfterSeconds };
    }
    return { allowed: true, retryAfterSeconds };
  }
}

const shared = new AuthRateLimiter();

/** The process-wide limiter the four authentication routes use. */
export function authRateLimiter(): AuthRateLimiter {
  return shared;
}

/**
 * The client address a request came from, or null.
 *
 * `x-forwarded-for`'s leftmost entry is the client as the first proxy saw it.
 * It is attacker-controlled when the deployment is not behind a proxy that
 * rewrites it, which is why it keys a rate limit and nothing else: a forged
 * value buys a fresh bucket, which is the same thing a new IP address buys, and
 * it is never used for authorization, logging as identity, or SQL.
 */
export function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") return first.slice(0, 64);
  const real = request.headers.get("x-real-ip")?.trim();
  return real !== undefined && real !== "" ? real.slice(0, 64) : null;
}
