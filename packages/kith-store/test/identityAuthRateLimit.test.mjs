// `kith.auth_rate_limits` and `consumeAuthAttempt`
// (`src/identity/rateLimits.ts`), the durable limiter section 8 question 2 of
// the web and MCP surface plan opened a row for. `deferredSweeps.test.mjs`
// covers the expiry sweep; this file covers the upsert itself.

import assert from "node:assert/strict";
import test from "node:test";

import { consumeAuthAttempt, identityCtx } from "../dist/identity/index.js";
import { identityDatabase, skip } from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const WINDOW_MS = 15 * 60 * 1000;

test(
  "the first attempt is allowed and reports the remaining budget",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const result = await consumeAuthAttempt(ctx, {
        scope: "auth_address",
        key: "203.0.113.9",
        windowMs: WINDOW_MS,
        limit: 3,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.remaining, 2);
      assert.equal(result.retryAfterMs, 0);

      const stored = await ctx.client.query(
        "SELECT scope, count FROM kith.auth_rate_limits",
      );
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].scope, "auth_address");
      assert.equal(stored.rows[0].count, 1);
    }, NOW);
  },
);

test(
  "the (limit + 1)th attempt in one window is denied, with a positive wait",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const attempt = () =>
        consumeAuthAttempt(ctx, {
          scope: "auth_account",
          key: "owner@example.test",
          windowMs: WINDOW_MS,
          limit: 3,
        });
      assert.equal((await attempt()).allowed, true);
      assert.equal((await attempt()).allowed, true);
      assert.equal((await attempt()).allowed, true);

      const refused = await attempt();
      assert.equal(refused.allowed, false);
      assert.equal(refused.remaining, 0);
      assert.ok(refused.retryAfterMs > 0);
      assert.ok(refused.retryAfterMs <= WINDOW_MS);

      // Hammering the refusal keeps counting rather than softening the
      // limit -- copied from the worker protocol limiter's own rule.
      const stillRefused = await attempt();
      assert.equal(stillRefused.allowed, false);
      const stored = await ctx.client.query(
        "SELECT count FROM kith.auth_rate_limits WHERE scope = 'auth_account'",
      );
      assert.equal(stored.rows[0].count, 5);
    }, NOW);
  },
);

test("a new window allows attempts again", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const attempt = (now) =>
      consumeAuthAttempt(identityCtx(ctx.client, now), {
        scope: "auth_address",
        key: "198.51.100.4",
        windowMs: WINDOW_MS,
        limit: 2,
      });
    assert.equal((await attempt(NOW)).allowed, true);
    assert.equal((await attempt(NOW)).allowed, true);
    assert.equal((await attempt(NOW)).allowed, false);

    // Still inside the same window: still refused.
    assert.equal((await attempt(NOW + WINDOW_MS - 1)).allowed, false);

    // The window has rolled over: the counter restarts at one rather than
    // continuing from wherever it left off.
    const rolledOver = await attempt(NOW + WINDOW_MS);
    assert.equal(rolledOver.allowed, true);
    assert.equal(rolledOver.remaining, 1);
    const stored = await ctx.client.query(
      "SELECT count FROM kith.auth_rate_limits WHERE scope = 'auth_address'",
    );
    assert.equal(stored.rows[0].count, 1);
  });
});

test(
  "two keys, or two scopes over the same key, have independent budgets",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const spend = (scope, key) =>
        consumeAuthAttempt(ctx, { scope, key, windowMs: WINDOW_MS, limit: 1 });

      assert.equal((await spend("auth_address", "10.0.0.1")).allowed, true);
      // A different key, same scope: its own budget, unaffected by the first.
      assert.equal((await spend("auth_address", "10.0.0.2")).allowed, true);
      // The first key's budget is spent.
      assert.equal((await spend("auth_address", "10.0.0.1")).allowed, false);

      // The same key text, but a different scope: also its own budget. This
      // is what lets one client address and one account email share a table
      // without the address budget and the account budget colliding just
      // because, for one request, the two strings happen to be equal.
      assert.equal((await spend("auth_account", "10.0.0.1")).allowed, true);

      const rows = await ctx.client.query(
        "SELECT scope, key_hash, count FROM kith.auth_rate_limits ORDER BY scope, key_hash",
      );
      assert.equal(rows.rows.length, 3);
      // The raw key never reaches the table -- only its hash.
      for (const row of rows.rows) {
        assert.match(row.key_hash, /^[0-9a-f]{64}$/);
      }
    }, NOW);
  },
);

test(
  "an invalid scope, key, window or limit is refused before any write",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const base = {
        scope: "auth_address",
        key: "1.2.3.4",
        windowMs: WINDOW_MS,
        limit: 5,
      };
      await assert.rejects(consumeAuthAttempt(ctx, { ...base, scope: "" }));
      await assert.rejects(
        consumeAuthAttempt(ctx, { ...base, scope: "a".repeat(65) }),
      );
      await assert.rejects(consumeAuthAttempt(ctx, { ...base, key: "" }));
      await assert.rejects(
        consumeAuthAttempt(ctx, { ...base, key: "a".repeat(321) }),
      );
      await assert.rejects(consumeAuthAttempt(ctx, { ...base, windowMs: 0 }));
      await assert.rejects(consumeAuthAttempt(ctx, { ...base, windowMs: -1 }));
      await assert.rejects(consumeAuthAttempt(ctx, { ...base, limit: 0 }));
      await assert.rejects(consumeAuthAttempt(ctx, { ...base, limit: 1.5 }));

      const stored = await ctx.client.query(
        "SELECT count(*)::int AS n FROM kith.auth_rate_limits",
      );
      assert.equal(stored.rows[0].n, 0);
    }, NOW);
  },
);
