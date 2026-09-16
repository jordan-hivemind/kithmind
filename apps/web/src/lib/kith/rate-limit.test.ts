// The authentication rate limit, driven by a fake clock.
//
// No database and no timers. The limiter takes its clock as an argument for
// exactly this reason: a test that proved a fifteen minute window by waiting
// fifteen minutes would not be run.

import { describe, expect, test } from "vitest";

import {
  AUTH_RATE_LIMIT_ATTEMPTS_PER_ACCOUNT,
  AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS,
  AUTH_RATE_LIMIT_WINDOW_MS,
  AuthRateLimiter,
  clientAddress,
  TokenBucket,
} from "./rate-limit";

/** A clock the test moves by hand. */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("TokenBucket", () => {
  test("allows the capacity and refuses the next attempt", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      capacity: 3,
      windowMs: 1000,
      now: clock.now,
    });
    expect([bucket.take("a"), bucket.take("a"), bucket.take("a")]).toEqual([
      true,
      true,
      true,
    ]);
    expect(bucket.take("a")).toBe(false);
    // A different key has its own budget.
    expect(bucket.take("b")).toBe(true);
  });

  test("refills continuously rather than in one step at the window edge", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      capacity: 4,
      windowMs: 1000,
      now: clock.now,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) bucket.take("a");
    expect(bucket.take("a")).toBe(false);

    // A quarter of the window is one token, not four and not zero. A fixed
    // window counter would give the whole budget back at the edge, which is
    // twice the limit across the boundary.
    clock.advance(250);
    expect(bucket.take("a")).toBe(true);
    expect(bucket.take("a")).toBe(false);

    // A long absence refills to the ceiling and no further.
    clock.advance(AUTH_RATE_LIMIT_WINDOW_MS * 10);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(bucket.take("a")).toBe(true);
    }
    expect(bucket.take("a")).toBe(false);
  });

  test("a refusal does not spend a token", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      capacity: 1,
      windowMs: 1000,
      now: clock.now,
    });
    expect(bucket.take("a")).toBe(true);
    // Hammering while limited must not push recovery further away.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(bucket.take("a")).toBe(false);
    }
    clock.advance(1000);
    expect(bucket.take("a")).toBe(true);
  });

  test("bounds how many keys it remembers", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      capacity: 1,
      windowMs: 1000,
      maxKeys: 8,
      now: clock.now,
    });
    for (let key = 0; key < 100; key += 1) bucket.take(`address-${key}`);
    expect(bucket.size).toBe(8);
    // The least recently used key was evicted, so it starts fresh. Eviction
    // favours the attacker on purpose: a limiter must not be what exhausts the
    // process's memory.
    expect(bucket.take("address-0")).toBe(true);
  });

  test("refuses a nonsensical configuration", () => {
    expect(() => new TokenBucket({ capacity: 0, windowMs: 1000 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1.5, windowMs: 1000 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1, windowMs: 0 })).toThrow();
  });
});

describe("AuthRateLimiter", () => {
  test("refuses the attempt after the per-account limit", () => {
    const clock = fakeClock();
    const limiter = new AuthRateLimiter(clock.now);
    for (
      let attempt = 0;
      attempt < AUTH_RATE_LIMIT_ATTEMPTS_PER_ACCOUNT;
      attempt += 1
    ) {
      expect(
        limiter.check({ address: `1.2.3.${attempt}`, account: "owner@x.test" })
          .allowed,
      ).toBe(true);
    }
    const refused = limiter.check({
      address: "9.9.9.9",
      account: "owner@x.test",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.limit).toBe("account");
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);

    // Another account from the same fresh address is unaffected.
    expect(
      limiter.check({ address: "9.9.9.9", account: "other@x.test" }).allowed,
    ).toBe(true);
  });

  test("refuses the attempt after the per-address limit", () => {
    const clock = fakeClock();
    const limiter = new AuthRateLimiter(clock.now);
    for (
      let attempt = 0;
      attempt < AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS;
      attempt += 1
    ) {
      expect(
        limiter.check({ address: "1.2.3.4", account: `a${attempt}@x.test` })
          .allowed,
      ).toBe(true);
    }
    const refused = limiter.check({
      address: "1.2.3.4",
      account: "fresh@x.test",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.limit).toBe("address");

    // The account bucket was not touched by the refused attempt, so one address
    // cannot drain a victim's budget faster than it drains its own.
    expect(
      limiter.check({ address: "5.6.7.8", account: "fresh@x.test" }).allowed,
    ).toBe(true);
  });

  test("treats one email address as one budget however it is spelled", () => {
    const clock = fakeClock();
    const limiter = new AuthRateLimiter(clock.now);
    for (
      let attempt = 0;
      attempt < AUTH_RATE_LIMIT_ATTEMPTS_PER_ACCOUNT;
      attempt += 1
    ) {
      limiter.check({
        address: `1.2.3.${attempt}`,
        account: attempt % 2 === 0 ? "Owner@X.test" : "owner@x.test",
      });
    }
    expect(
      limiter.check({ address: "9.9.9.9", account: "OWNER@X.TEST" }).allowed,
    ).toBe(false);
  });

  test("an unattributable request is limited rather than exempt", () => {
    const clock = fakeClock();
    const limiter = new AuthRateLimiter(clock.now);
    for (
      let attempt = 0;
      attempt < AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS;
      attempt += 1
    ) {
      expect(
        limiter.check({ address: null, account: `a${attempt}@x.test` }).allowed,
      ).toBe(true);
    }
    expect(limiter.check({ address: null, account: "b@x.test" }).allowed).toBe(
      false,
    );
  });

  test("recovers after the window", () => {
    const clock = fakeClock();
    const limiter = new AuthRateLimiter(clock.now);
    for (
      let attempt = 0;
      attempt < AUTH_RATE_LIMIT_ATTEMPTS_PER_ACCOUNT;
      attempt += 1
    ) {
      limiter.check({ address: "1.2.3.4", account: "owner@x.test" });
    }
    expect(
      limiter.check({ address: "1.2.3.4", account: "owner@x.test" }).allowed,
    ).toBe(false);
    clock.advance(AUTH_RATE_LIMIT_WINDOW_MS);
    expect(
      limiter.check({ address: "1.2.3.4", account: "owner@x.test" }).allowed,
    ).toBe(true);
  });
});

describe("clientAddress", () => {
  test("takes the leftmost forwarded entry, then x-real-ip, then nothing", () => {
    const request = (headers: Record<string, string>) =>
      new Request("https://brain.example.test/api/auth/sign-in", {
        method: "POST",
        headers,
      });
    expect(
      clientAddress(request({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })),
    ).toBe("1.2.3.4");
    expect(clientAddress(request({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientAddress(request({}))).toBeNull();
    // A forged header buys a fresh bucket and nothing else, so its only defence
    // is a length bound that keeps one request from becoming a large map key.
    expect(clientAddress(request({ "x-forwarded-for": "a".repeat(500) }))).toBe(
      "a".repeat(64),
    );
  });
});
