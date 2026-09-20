// Scrypt and the session cookie. No database, so these always run.
//
// The Scrypt test is the one that decides whether the owner can sign in after
// cutover. Both vectors below were produced by the `lucia@3` `Scrypt` the Convex
// Password provider actually calls (`new Scrypt().hash(password)`), so they are
// the stored format, not a round trip of this implementation against itself. A
// round trip proves only that this file agrees with itself; these prove it agrees
// with the hashes already in `authAccounts.secret`.

import assert from "node:assert/strict";
import test from "node:test";

import {
  clearedSessionCookie,
  DEVELOPMENT_SESSION_COOKIE_NAME,
  hashPassword,
  parseSessionToken,
  readSessionCookie,
  SESSION_COOKIE_NAME,
  serializeSessionToken,
  sessionCookie,
  verifyPassword,
} from "../dist/identity/index.js";

// Captured from `new Scrypt().hash(...)` in lucia@3.2.2, the version
// @convex-dev/auth@0.0.94's Password provider depends on.
const LUCIA_VECTORS = [
  {
    password: "correct horse battery staple",
    stored:
      "744d3c0daf32bd7180a506da101a2077:bb13e55f8a40a7b6f41988f1b54f6c08d8a8e14911b5f12c4c2310b6566c1313b482daffe7c0a335f8acd1c943956a7fcc526e23e23245cf9b014409da7468bd",
  },
  {
    // Non-ASCII on purpose: the NFKC normalisation and the UTF-8 encoding are
    // both part of the format, and a vector of only ASCII would not notice if
    // either were dropped.
    password: "pässwörd ✓ 😀",
    stored:
      "7bb33a752eda4805df1c585a2b6e0329:b9e7aa4106549d2b269d6eacc593507caa281f7f7a607ca9850e6031d21e965f2cfb7478eddd9547708c884d56b7d73577803741c33aa2717024e40f5583802e",
  },
];

test("verifies the Scrypt hashes the current provider produced, and only those", async () => {
  for (const vector of LUCIA_VECTORS) {
    assert.equal(
      await verifyPassword(vector.stored, vector.password),
      true,
      `existing hash for ${JSON.stringify(vector.password)} must still verify`,
    );
    assert.equal(
      await verifyPassword(vector.stored, `${vector.password}x`),
      false,
    );
    assert.equal(await verifyPassword(vector.stored, ""), false);
  }
  // A hash for one password must not verify the other.
  assert.equal(
    await verifyPassword(LUCIA_VECTORS[0].stored, LUCIA_VECTORS[1].password),
    false,
  );
});

test("a fresh hash has the stored shape and verifies", async () => {
  const stored = await hashPassword("a new password");
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(await verifyPassword(stored, "a new password"), true);
  assert.equal(await verifyPassword(stored, "a new passwore"), false);
  // A different salt every time, so two accounts with the same password do not
  // share a hash.
  assert.notEqual(await hashPassword("a new password"), stored);
});

test("a malformed stored secret fails to verify rather than throwing", async () => {
  for (const stored of [
    null,
    undefined,
    "",
    "notahash",
    "deadbeef:cafe",
    // The right shape with the wrong lengths, and the LegacyScrypt three-part
    // form, which this build does not accept.
    `${"0".repeat(31)}:${"0".repeat(128)}`,
    `s2:${"0".repeat(32)}:${"0".repeat(128)}`,
    `${"0".repeat(32)}:${"0".repeat(128)}:extra`,
  ]) {
    assert.equal(
      await verifyPassword(stored, "anything"),
      false,
      String(stored),
    );
  }
});

const config = { secret: "k".repeat(64), secure: true };

test("a cookie round-trips, and a tampered or unsigned one does not", () => {
  const token = "a".repeat(64);
  const value = serializeSessionToken(config, token);
  assert.equal(parseSessionToken(config, value), token);

  // Wrong key, no signature, altered token, altered signature, wrong version.
  assert.equal(
    parseSessionToken({ secret: "j".repeat(64) }, value),
    null,
    "a cookie signed with another key must not verify",
  );
  assert.equal(parseSessionToken(config, token), null);
  assert.equal(
    parseSessionToken(config, value.replace(token, "b".repeat(64))),
    null,
  );
  assert.equal(parseSessionToken(config, `${value}x`), null);
  assert.equal(parseSessionToken(config, value.replace("v1.", "v2.")), null);
  for (const junk of [null, undefined, "", "v1..", "v1.a.b.c"]) {
    assert.equal(parseSessionToken(config, junk), null, String(junk));
  }
});

test("a short or missing signing key is refused rather than used", () => {
  for (const secret of [undefined, "", "short"]) {
    assert.throws(
      () => serializeSessionToken({ secret }, "a".repeat(64)),
      /Session secret is not configured/,
    );
  }
});

test("the Set-Cookie value is httpOnly, host-scoped and expiring", () => {
  const value = sessionCookie(config, "c".repeat(64), Date.UTC(2035, 0, 1));
  assert.match(value, new RegExp(`^${SESSION_COOKIE_NAME}=v1\\.c{64}\\.`));
  for (const attribute of ["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]) {
    assert.ok(value.includes(attribute), `${attribute} must be set`);
  }
  assert.ok(value.includes("Expires=Mon, 01 Jan 2035"));
  const cleared = clearedSessionCookie(config);
  assert.ok(cleared.startsWith(`${SESSION_COOKIE_NAME}=;`));
  assert.ok(cleared.includes("Max-Age=0"));
});

test("only the session cookie is read out of a Cookie header", () => {
  const value = serializeSessionToken(config, "d".repeat(64));
  assert.equal(
    readSessionCookie(
      `theme=dark; ${SESSION_COOKIE_NAME}=${value}; other=1`,
      config,
    ),
    value,
  );
  // A cookie whose name merely contains the session cookie's name is not it.
  assert.equal(
    readSessionCookie(`not_${SESSION_COOKIE_NAME}=${value}`, config),
    null,
  );
  assert.equal(
    readSessionCookie(`${SESSION_COOKIE_NAME}x=${value}`, config),
    null,
  );
  for (const header of [null, undefined, "", "novalue", "="]) {
    assert.equal(readSessionCookie(header, config), null, String(header));
  }
});

test("plain HTTP development uses a browser-accepted cookie name", () => {
  const development = { ...config, secure: false };
  const value = sessionCookie(
    development,
    "e".repeat(64),
    Date.UTC(2035, 0, 1),
  );
  assert.ok(value.startsWith(`${DEVELOPMENT_SESSION_COOKIE_NAME}=v1.`));
  assert.equal(value.includes("Secure"), false);
  assert.equal(value.includes("__Host-"), false);
  const header = value.split(";")[0];
  assert.notEqual(readSessionCookie(header, development), null);
  // Production never falls back to the development cookie, and development
  // never accepts a host-prefixed cookie that local HTTP could not set.
  assert.equal(readSessionCookie(header, config), null);
  assert.equal(
    readSessionCookie(`${SESSION_COOKIE_NAME}=forged`, development),
    null,
  );
  assert.ok(
    clearedSessionCookie(development).startsWith(
      `${DEVELOPMENT_SESSION_COOKIE_NAME}=;`,
    ),
  );
});
