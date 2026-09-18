// The authentication rate limit's shared values, and the client address it is
// keyed by.
//
// The limit itself is `durable-rate-limit.ts`, spending from
// `kith.auth_rate_limits`. i1 shipped a per-process token bucket here while
// question 2 of the surface plan left the durable table open; i7b deleted the
// bucket, because the `convex` surface was the last thing that selected it.
//
// Nothing here is a lockout. It sheds load and slows guessing; the thing that
// actually stops a guessed password is the Scrypt cost in `scrypt.ts` and the
// password itself.

/** How long the limit takes to refill from empty. */
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
 * The client address a request came from, or null.
 *
 * Trust boundary, fixed by review of i1: a request header is attacker-supplied
 * unless something between the attacker and this process is known to strip or
 * overwrite it, and the previous version of this function did not honour that
 * -- it took `x-forwarded-for`'s *leftmost* entry, which on a real deployment
 * is exactly the entry a client gets to write. A client that wants a fresh
 * bucket, or wants to pin its budget onto an address it does not control,
 * could simply set the header.
 *
 * What is actually trustworthy, and what this function relies on:
 *
 *   - On Vercel, the edge network is a proxy the app does not control and the
 *     client cannot reach past. Vercel's own docs on request headers, and the
 *     Next.js docs on reading a client IP behind a proxy, describe
 *     `x-forwarded-for` as a hop chain a proxy *appends* the connecting
 *     address to rather than a value it replaces: a client may prepend
 *     whatever entries it likes, but the last hop is the address of whoever
 *     connected to the edge itself, because that is the one entry the client
 *     never gets to write. Vercel also sets `x-real-ip` directly from the
 *     edge, as a single value rather than a chain. Vercel's request-headers
 *     documentation (https://vercel.com/docs/headers/request-headers) states
 *     that on Vercel `x-real-ip` is identical to `x-forwarded-for`: the
 *     platform sets both from the connecting client's address, so the
 *     rightmost `x-forwarded-for` entry this function reads and the
 *     `x-real-ip` value it falls back to are the same platform-set fact,
 *     read two ways.
 *   - Locally (`pnpm dev`, a bare `node` process, this file's own tests)
 *     there is no proxy in front of the app at all, so neither header is
 *     trustworthy and a present one is exactly as attacker-controlled as an
 *     absent one is common. This function cannot tell "no proxy" apart from
 *     "a proxy that is not Vercel and does not append", and does not try to:
 *     it trusts the shape Vercel is documented to produce, and produces the
 *     safe fallback (see below) whenever that shape is not confirmable any
 *     other way.
 *
 * So: the *rightmost* `x-forwarded-for` entry, never the first, because the
 * first is exactly the entry a client controls and the previous version's
 * defect. `x-real-ip` next, because the docs describe it as a single value
 * the edge sets rather than a chain. Neither is validated as an IP address --
 * the far end of a chain a client cannot append to does not need to look like
 * one to be trustworthy, because it is trustworthy for where it came from, not
 * its shape.
 *
 * When neither header is present at all, this returns null rather than
 * guessing, and the caller (`AuthRateLimiter.check`, and the durable limiter
 * in `durable-rate-limit.ts`) must fall back to one shared bucket for every
 * such request rather than skipping the limit for it -- "no address" must
 * never be the cheapest way past a rate limit. It is never used for
 * authorization, logging as identity, or SQL.
 */
export function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const segments = forwarded.split(",");
    const rightmost = segments[segments.length - 1]?.trim();
    if (rightmost !== undefined && rightmost !== "") {
      return rightmost.slice(0, 64);
    }
  }
  const real = request.headers.get("x-real-ip")?.trim();
  return real !== undefined && real !== "" ? real.slice(0, 64) : null;
}
