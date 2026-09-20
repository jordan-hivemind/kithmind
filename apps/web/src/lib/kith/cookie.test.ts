// The middleware's cookie check, against the cookie the routes actually issue.
//
// `lib/kith/cookie.ts` is a second implementation of one security check, needed
// because middleware runs on the edge runtime and the store's
// `parseSessionToken` uses `node:crypto`. This file is the thing that keeps the
// two from drifting: it imports the real production and development cookie
// names, `serializeSessionToken` and `sessionCookie` from the identity package
// and asserts the edge verifier accepts exactly what they produce and nothing
// else.
//
// No database. This is arithmetic over a shared secret and it must stay runnable
// in a clone that has no Postgres.

import { randomBytes } from "node:crypto";

import {
  DEVELOPMENT_SESSION_COOKIE_NAME,
  parseSessionToken,
  serializeSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookie,
} from "@repo/kith-store/identity";
import { describe, expect, test } from "vitest";

import {
  KITH_DEVELOPMENT_SESSION_COOKIE_NAME,
  KITH_SESSION_COOKIE_NAME,
  readKithSessionCookie,
  verifyKithSessionCookie,
} from "./cookie";

const secret = randomBytes(32).toString("hex");
const config = { secret, secure: true };
const developmentConfig = { secret, secure: false };
const token = randomBytes(32).toString("hex");

describe("the edge session cookie check", () => {
  test("names the same cookie the routes set", () => {
    expect(KITH_SESSION_COOKIE_NAME).toBe(SESSION_COOKIE_NAME);
    const header = sessionCookie(config, token, Date.now() + 1000).split(
      ";",
    )[0];
    expect(readKithSessionCookie(header)).toBe(
      serializeSessionToken(config, token),
    );
  });

  test("uses a distinct plain-HTTP development cookie", () => {
    expect(KITH_DEVELOPMENT_SESSION_COOKIE_NAME).toBe(
      DEVELOPMENT_SESSION_COOKIE_NAME,
    );
    const header = sessionCookie(
      developmentConfig,
      token,
      Date.now() + 1000,
    ).split(";")[0];
    expect(readKithSessionCookie(header, true)).toBe(
      serializeSessionToken(developmentConfig, token),
    );
    expect(readKithSessionCookie(header)).toBeNull();
    expect(
      readKithSessionCookie(
        `${SESSION_COOKIE_NAME}=${serializeSessionToken(config, token)}`,
        true,
      ),
    ).toBeNull();
  });

  test("accepts exactly what the store signs", async () => {
    const value = serializeSessionToken(config, token);
    expect(await verifyKithSessionCookie(secret, value)).toBe(token);
    // And the store agrees, so the two implementations are checking one thing.
    expect(parseSessionToken(config, value)).toBe(token);
  });

  test("rejects a forged cookie", async () => {
    const value = serializeSessionToken(config, token);
    const forged = [
      // A token with no signature at all.
      `v1.${token}.`,
      `v1.${token}`,
      token,
      // A signature over a different token, which is what an attacker who saw
      // one valid cookie would have.
      `v1.${randomBytes(32).toString("hex")}.${value.split(".")[2]}`,
      // A signature made with a different key.
      serializeSessionToken({ secret: randomBytes(32).toString("hex") }, token),
      // A flipped character in the MAC, and in the token.
      value.replace(/.$/, (last) => (last === "A" ? "B" : "A")),
      `v1.${token.replace(/^./, (first) => (first === "f" ? "0" : "f"))}.${value.split(".")[2]}`,
      // A version this code does not issue.
      value.replace(/^v1\./, "v2."),
      // Not hex, the right length.
      `v1.${"g".repeat(64)}.${value.split(".")[2]}`,
      // Padding and separator games.
      `v1.${token}.${value.split(".")[2]}.extra`,
      "",
      null,
      undefined,
    ];
    for (const value of forged) {
      expect(await verifyKithSessionCookie(secret, value)).toBeNull();
      // The store refuses the same values, so neither is the lenient one.
      if (typeof value === "string" || value === null) {
        expect(parseSessionToken(config, value)).toBeNull();
      }
    }
  });

  test("rejects a non-canonical encoding of the real MAC bytes", async () => {
    // The last base64url character of a 32-byte MAC carries two padding
    // bits, so another character with the same top two bits decodes to the
    // same bytes. Find a token whose MAC ends in one of the four such
    // characters, then present the sibling encoding: same bytes, different
    // text. The store compares text and refuses it; the edge check must too.
    let sibling: string | null = null;
    let value = "";
    for (let attempt = 0; attempt < 512 && sibling === null; attempt += 1) {
      const candidate = randomBytes(32).toString("hex");
      value = serializeSessionToken(config, candidate);
      const last = value.at(-1)!;
      const group = "ABCD";
      if (group.includes(last)) {
        sibling = value.slice(0, -1) + (last === "A" ? "B" : "A");
      }
    }
    expect(sibling).not.toBeNull();
    expect(await verifyKithSessionCookie(secret, sibling!)).toBeNull();
    expect(parseSessionToken(config, sibling!)).toBeNull();
    expect(await verifyKithSessionCookie(secret, value)).not.toBeNull();
  });

  test("rejects every truncation of a valid cookie", async () => {
    const value = serializeSessionToken(config, token);
    for (let length = 0; length < value.length; length += 1) {
      const truncated = value.slice(0, length);
      expect(await verifyKithSessionCookie(secret, truncated)).toBeNull();
      expect(parseSessionToken(config, truncated)).toBeNull();
    }
    // The untruncated one still verifies, so the loop above proves something.
    expect(await verifyKithSessionCookie(secret, value)).toBe(token);
  });

  test("refuses to verify with an absent or short secret", async () => {
    const value = serializeSessionToken(config, token);
    for (const weak of ["", "short", "a".repeat(31), null, undefined]) {
      expect(
        await verifyKithSessionCookie(weak as unknown as string, value),
      ).toBeNull();
    }
  });

  test("reads only the exact cookie name out of a header", () => {
    const value = serializeSessionToken(config, token);
    expect(
      readKithSessionCookie(
        `other=1; ${SESSION_COOKIE_NAME}=${value}; another=2`,
      ),
    ).toBe(value);
    // A prefixed or suffixed name is a different cookie, and a subdomain that
    // could set one must not be able to answer for this one.
    expect(readKithSessionCookie(`x__Host-kith_session=${value}`)).toBeNull();
    expect(
      readKithSessionCookie(`${SESSION_COOKIE_NAME}_other=${value}`),
    ).toBeNull();
    // A repeated cookie takes the first, as browsers send it.
    expect(
      readKithSessionCookie(
        `${SESSION_COOKIE_NAME}=${value}; ${SESSION_COOKIE_NAME}=forged`,
      ),
    ).toBe(value);
    expect(readKithSessionCookie(null)).toBeNull();
    expect(readKithSessionCookie("")).toBeNull();
  });
});
