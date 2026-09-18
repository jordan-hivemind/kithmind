// `clientAddress`, the key the authentication rate limit is spent against.
//
// No database and no timers: the limit's own arithmetic lives in
// `kith.auth_rate_limits` and is covered by `rate-limit-postgres-route.test.ts`.
// What is left here is the trust-boundary rule about which header entry may be
// believed, which is a pure function of the request.

import { describe, expect, test } from "vitest";

import { clientAddress } from "./rate-limit";

describe("clientAddress", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://brain.example.test/api/auth/sign-in", {
      method: "POST",
      headers,
    });

  test("takes the rightmost forwarded entry, never the client-controlled leftmost one", () => {
    // A single hop: whatever the client sent, plus the one entry the edge
    // itself appended after it. That last entry is the one this function must
    // trust, not the first.
    expect(
      clientAddress(request({ "x-forwarded-for": "9.9.9.9, 203.0.113.5" })),
    ).toBe("203.0.113.5");
    // A spoofed header can prepend as many entries as it likes; the answer is
    // still the last one, because that is the one entry a client cannot write.
    expect(
      clientAddress(
        request({
          "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9",
        }),
      ),
    ).toBe("203.0.113.9");
    // The old defect, named directly: the leftmost entry above (`1.1.1.1`) is
    // exactly what the previous version would have returned, and it must not
    // be what this version returns.
    expect(
      clientAddress(
        request({
          "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9",
        }),
      ),
    ).not.toBe("1.1.1.1");
  });

  test("falls back to x-real-ip, the platform header, when there is no x-forwarded-for", () => {
    expect(clientAddress(request({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  test("returns null, the shared-bucket fallback, when neither header is present", () => {
    // The missing-header case: nothing to spoof and nothing to trust either,
    // so this must return null rather than guessing. The caller is what turns
    // null into one shared bucket instead of no limit at all.
    expect(clientAddress(request({}))).toBeNull();
  });

  test("bounds the length of whatever it returns", () => {
    // A forged header buys a fresh bucket and nothing else, so its only
    // defence is a length bound that keeps one request from becoming a large
    // map key.
    expect(clientAddress(request({ "x-forwarded-for": "a".repeat(500) }))).toBe(
      "a".repeat(64),
    );
  });
});
