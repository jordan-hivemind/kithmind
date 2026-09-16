// `kith.deferred_work`'s generic queue: schedule/claim/complete/fail, and the
// drain loop that runs jobs through a registry. See
// docs/plans/2026-09-12-postgres-consolidation.md section 2.6 for why this
// table exists at all, and packages/kith-store/src/deferred/core.ts for the
// design notes this file's tests pin.

import assert from "node:assert/strict";
import test from "node:test";

import { createKithPool, withKithTransaction } from "../dist/index.js";
import {
  claim,
  complete,
  createRegistry,
  deferredCtx,
  drain,
  fail,
  get,
  schedule,
} from "../dist/deferred/index.js";
import { identityDatabase, skip } from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-14T12:00:00Z");

async function poolFixture(t) {
  const database = await identityDatabase(t);
  const pool = createKithPool(database.databaseUrl, 5);
  // The throwaway database is dropped `WITH (FORCE)` in this same test's
  // cleanup, which forcibly terminates any connection still open on it,
  // including idle pooled ones. Without a listener, `pg.Pool` turns that into
  // an uncaught `error` event rather than a rejected promise; the single
  // adopted client in `pgDatabase.mjs` guards the same thing the same way.
  pool.on("error", () => {});
  t.after(() => pool.end());
  return { ...database, pool };
}

test("schedule dedupes while queued, and again while running", { skip }, async (t) => {
  const f = await poolFixture(t);
  const first = await withKithTransaction(f.pool, (client) =>
    schedule(deferredCtx(client, NOW), {
      kind: "inline_ingestion",
      payload: { workId: "w1" },
      dedupeKey: "w1",
    }),
  );
  assert.equal(first.deduped, false);

  const second = await withKithTransaction(f.pool, (client) =>
    schedule(deferredCtx(client, NOW + 1), {
      kind: "inline_ingestion",
      payload: { workId: "w1" },
      dedupeKey: "w1",
    }),
  );
  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id);

  const rowsAfter = await f.client.query(
    "SELECT count(*)::int AS n FROM kith.deferred_work WHERE dedupe_key = 'w1'",
  );
  assert.equal(rowsAfter.rows[0].n, 1);

  // Claim it (state becomes running) and dedupe again: still a no-op, because
  // the partial unique index covers `queued` and `running` alike.
  const claimed = await withKithTransaction(f.pool, (client) =>
    claim(deferredCtx(client, NOW + 1)),
  );
  assert.equal(claimed.id, first.id);
  const third = await withKithTransaction(f.pool, (client) =>
    schedule(deferredCtx(client, NOW + 2), {
      kind: "inline_ingestion",
      payload: { workId: "w1" },
      dedupeKey: "w1",
    }),
  );
  assert.equal(third.deduped, true);
  assert.equal(third.id, first.id);

  // Once the row is terminal, the key is free again.
  await withKithTransaction(f.pool, (client) =>
    complete(deferredCtx(client, NOW + 2), {
      id: first.id,
      leaseToken: claimed.leaseToken,
    }),
  );
  const fourth = await withKithTransaction(f.pool, (client) =>
    schedule(deferredCtx(client, NOW + 3), {
      kind: "inline_ingestion",
      payload: { workId: "w1" },
      dedupeKey: "w1",
    }),
  );
  assert.equal(fourth.deduped, false);
  assert.notEqual(fourth.id, first.id);
});

test("no dedupe key never collides, even scheduled twice", { skip }, async (t) => {
  const f = await poolFixture(t);
  const a = await withKithTransaction(f.pool, (client) =>
    schedule(deferredCtx(client, NOW), {
      kind: "card_queue_tick",
      payload: {},
    }),
  );
  const b = await withKithTransaction(f.pool, (client) =>
    schedule(deferredCtx(client, NOW), {
      kind: "card_queue_tick",
      payload: {},
    }),
  );
  assert.notEqual(a.id, b.id);
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, false);
});

test("claim under two concurrent drains processes each job exactly once", { skip }, async (t) => {
  const f = await poolFixture(t);
  const jobCount = 12;
  for (let index = 0; index < jobCount; index += 1) {
    await withKithTransaction(f.pool, (client) =>
      schedule(deferredCtx(client, NOW), {
        kind: "card_queue_tick",
        payload: { index },
      }),
    );
  }

  const seen = [];
  const registry = createRegistry();
  registry.set("card_queue_tick", async (_ctx, payload) => {
    seen.push(payload.index);
  });

  const [left, right] = await Promise.all([
    drain(f.pool, registry, { maxJobs: jobCount, now: NOW }),
    drain(f.pool, registry, { maxJobs: jobCount, now: NOW }),
  ]);

  assert.equal(left.claimed + right.claimed, jobCount);
  assert.equal(seen.length, jobCount);
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    Array.from({ length: jobCount }, (_, index) => index),
  );
  const remaining = await f.client.query(
    "SELECT count(*)::int AS n FROM kith.deferred_work WHERE state = 'queued'",
  );
  assert.equal(remaining.rows[0].n, 0);
});

test("a lost lease is reclaimed after it expires", { skip }, async (t) => {
  const f = await poolFixture(t);
  const scheduled = await withKithTransaction(f.pool, (client) =>
    schedule(deferredCtx(client, NOW), {
      kind: "embedding_fill",
      payload: {},
    }),
  );
  const firstClaim = await withKithTransaction(f.pool, (client) =>
    claim(deferredCtx(client, NOW), { leaseMs: 1_000 }),
  );
  assert.equal(firstClaim.id, scheduled.id);

  // Before the lease expires, a second claim finds nothing due.
  const tooSoon = await withKithTransaction(f.pool, (client) =>
    claim(deferredCtx(client, NOW + 500)),
  );
  assert.equal(tooSoon, null);

  // Past the lease's expiry, the same row is claimable again, under a new
  // lease token.
  const reclaimed = await withKithTransaction(f.pool, (client) =>
    claim(deferredCtx(client, NOW + 1_001)),
  );
  assert.equal(reclaimed.id, scheduled.id);
  assert.notEqual(reclaimed.leaseToken, firstClaim.leaseToken);

  // The original lease token no longer completes the job.
  const staleComplete = await withKithTransaction(f.pool, (client) =>
    complete(deferredCtx(client, NOW + 1_001), {
      id: scheduled.id,
      leaseToken: firstClaim.leaseToken,
    }),
  );
  assert.equal(staleComplete.status, "lease_lost");

  const freshComplete = await withKithTransaction(f.pool, (client) =>
    complete(deferredCtx(client, NOW + 1_001), {
      id: scheduled.id,
      leaseToken: reclaimed.leaseToken,
    }),
  );
  assert.equal(freshComplete.status, "completed");
});

test(
  "a runner that dies mid-handler (not just throws) is reclaimed as one consumed attempt",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    const scheduled = await withKithTransaction(f.pool, (client) =>
      schedule(deferredCtx(client, NOW), {
        kind: "card_queue_tick",
        payload: {},
      }),
    );
    const firstClaim = await withKithTransaction(f.pool, (client) =>
      claim(deferredCtx(client, NOW), { leaseMs: 100 }),
    );
    assert.equal(firstClaim.id, scheduled.id);
    assert.equal(firstClaim.attempts, 0);

    // The runner crashes: no complete, no fail. Once the lease expires, the
    // next claim reclaims the row under a fresh lease token, and that
    // reclaim itself counts as a consumed attempt -- a crash must cost the
    // same retry budget a thrown error handled by `fail` would.
    const reclaimed = await withKithTransaction(f.pool, (client) =>
      claim(deferredCtx(client, NOW + 200), { leaseMs: 100 }),
    );
    assert.equal(reclaimed.id, scheduled.id);
    assert.equal(reclaimed.attempts, 1);
    assert.notEqual(reclaimed.leaseToken, firstClaim.leaseToken);

    // Crash again; the second reclaim counts a second attempt.
    const reclaimedAgain = await withKithTransaction(f.pool, (client) =>
      claim(deferredCtx(client, NOW + 400), { leaseMs: 100 }),
    );
    assert.equal(reclaimedAgain.id, scheduled.id);
    assert.equal(reclaimedAgain.attempts, 2);
  },
);

test(
  "a runner that keeps dying is failed, with 'lease expired', once max_attempts is reached, and is not claimed again",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    const scheduled = await withKithTransaction(f.pool, (client) =>
      schedule(deferredCtx(client, NOW), {
        kind: "card_queue_tick",
        payload: {},
        maxAttempts: 3,
      }),
    );

    let now = NOW;
    const claimed = await withKithTransaction(f.pool, (client) =>
      claim(deferredCtx(client, now), { leaseMs: 100 }),
    );
    assert.equal(claimed.id, scheduled.id);

    // Two crashes reclaim normally, each consuming one attempt.
    now += 200;
    const secondClaim = await withKithTransaction(f.pool, (client) =>
      claim(deferredCtx(client, now), { leaseMs: 100 }),
    );
    assert.equal(secondClaim.attempts, 1);

    now += 200;
    const thirdClaim = await withKithTransaction(f.pool, (client) =>
      claim(deferredCtx(client, now), { leaseMs: 100 }),
    );
    assert.equal(thirdClaim.attempts, 2);

    // A further reclaim would push attempts to 3, at max_attempts: the row
    // is failed instead of reclaimed a third time, so `claim` never has to
    // write an `attempts` value the `deferred_work_attempts_check`
    // constraint (attempts <= max_attempts) would reject.
    now += 200;
    const noCandidate = await withKithTransaction(f.pool, (client) =>
      claim(deferredCtx(client, now)),
    );
    assert.equal(noCandidate, null);

    const failed = await withKithTransaction(f.pool, (client) =>
      get(deferredCtx(client, now), scheduled.id),
    );
    assert.equal(failed.state, "failed");
    assert.equal(failed.attempts, 3);
    assert.equal(failed.lastError, "lease expired");
    assert.equal(failed.leaseToken, null);
    assert.equal(failed.leaseExpiresAt, null);

    // A failed, exhausted row is never claimed again.
    const again = await withKithTransaction(f.pool, (client) =>
      claim(deferredCtx(client, now + 10_000)),
    );
    assert.equal(again, null);
  },
);

test("a failing handler backs off and stops at max attempts", { skip }, async (t) => {
  const f = await poolFixture(t);
  const scheduled = await withKithTransaction(f.pool, (client) =>
    schedule(deferredCtx(client, NOW), {
      kind: "card_queue_tick",
      payload: {},
      maxAttempts: 3,
    }),
  );

  let calls = 0;
  const registry = createRegistry();
  registry.set("card_queue_tick", async () => {
    calls += 1;
    throw new Error(`synthetic failure ${calls}`);
  });

  const first = await drain(f.pool, registry, { maxJobs: 1, now: NOW });
  assert.equal(first.retrying, 1);
  const afterFirst = await withKithTransaction(f.pool, (client) =>
    get(deferredCtx(client, NOW), scheduled.id),
  );
  assert.equal(afterFirst.attempts, 1);
  assert.equal(afterFirst.state, "queued");
  assert.ok(afterFirst.runAfter.getTime() >= NOW);

  // Drain again far enough in the future that the backoff has elapsed.
  const farFuture = afterFirst.runAfter.getTime() + 1;
  const second = await drain(f.pool, registry, { maxJobs: 1, now: farFuture });
  assert.equal(second.retrying, 1);

  const third = await withKithTransaction(f.pool, (client) =>
    get(deferredCtx(client, farFuture), scheduled.id),
  );
  const farFuture2 = third.runAfter.getTime() + 1;
  const final = await drain(f.pool, registry, { maxJobs: 1, now: farFuture2 });
  assert.equal(final.exhausted, 1);
  assert.equal(calls, 3);

  const afterFinal = await withKithTransaction(f.pool, (client) =>
    get(deferredCtx(client, farFuture2), scheduled.id),
  );
  assert.equal(afterFinal.state, "failed");
  assert.equal(afterFinal.attempts, 3);
  assert.match(afterFinal.lastError, /synthetic failure 3/);
});

test("an unregistered kind fails typed without consuming an attempt", { skip }, async (t) => {
  const f = await poolFixture(t);
  const scheduled = await withKithTransaction(f.pool, (client) =>
    schedule(deferredCtx(client, NOW), {
      kind: "embedding_fill",
      payload: {},
    }),
  );
  const summary = await drain(f.pool, createRegistry(), {
    maxJobs: 1,
    now: NOW,
  });
  assert.equal(summary.unregisteredKind, 1);
  assert.equal(summary.outcomes[0].status, "unregistered_kind");

  const after = await withKithTransaction(f.pool, (client) =>
    get(deferredCtx(client, NOW), scheduled.id),
  );
  assert.equal(after.state, "failed");
  assert.equal(after.attempts, 0);
  assert.match(after.lastError, /no handler registered/);
});

test("schedule refuses a kind outside the closed list", { skip }, async (t) => {
  const f = await poolFixture(t);
  await assert.rejects(
    withKithTransaction(f.pool, (client) =>
      schedule(deferredCtx(client, NOW), {
        kind: "not_a_real_kind",
        payload: {},
      }),
    ),
  );
});
