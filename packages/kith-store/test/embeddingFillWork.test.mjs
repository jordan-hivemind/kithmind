// P2-39j2: the `embedding_fill` deferred-work kind end to end, against a real
// PostgreSQL server.
//
// The gap this closes is the one the plan's row m depends on. A capture makes
// its thought an eligible, uncovered target; nothing scheduled the fill that
// covers it, and `defaultRegistry()` registered no handler for the kind, so
// `getActiveEmbeddingTarget` reported `thoughtStatus: "unavailable"` for the
// space from the first capture onwards and every search fell back to keyword.
// These tests pin the three links of the chain: the write schedules, the drain
// runs, and the vector leg answers afterwards.
//
// No test here calls a provider. The embedder is injected into
// `defaultRegistry` -- that seam is the point of the option -- and the two
// tests that exercise the daemon's own provider-backed embedder inject a
// `fetch` that throws instead.

import assert from "node:assert/strict";
import test from "node:test";

import { createKithPool, withKithTransaction } from "../dist/index.js";
import {
  createRegistry,
  defaultRegistry,
  drain,
  schedule,
  deferredCtx,
} from "../dist/deferred/index.js";
import * as embeddings from "../dist/embeddings/index.js";
import { identityCtx } from "../dist/identity/index.js";
import * as memory from "../dist/memory/index.js";
import { oneHot, seedActiveEmbeddingIndex } from "./helpers/embeddingFixture.mjs";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/memoryFixture.mjs";

const NOW = Date.parse("2026-09-16T09:00:00Z");

const metadata = (summary) => ({
  type: "reference",
  topics: ["synthetic"],
  people: [],
  actionItems: [],
  summary,
});

async function poolFixture(t) {
  const database = await identityDatabase(t);
  const pool = createKithPool(database.databaseUrl, 5);
  // Same reason `deferredWork.test.mjs` does it: the throwaway database is
  // dropped `WITH (FORCE)` in this test's cleanup, and a terminated pooled
  // connection with no listener is an uncaught `error` event.
  pool.on("error", () => {});
  t.after(() => pool.end());
  return { ...database, pool };
}

/** A user, a space, and an active index on the synthetic profile with every
 * counter at zero. A capture into it is the first owed target it has. */
async function seedCountedSpace(f, now = NOW) {
  return await withKithTransaction(f.pool, async (client) => {
    const ctx = identityCtx(client, now);
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
    const index = await seedActiveEmbeddingIndex(ctx, spaceId, {
      eligible: { thought: 0, chunk: 0, card: 0 },
    });
    return { userId, spaceId, index };
  });
}

async function capture(f, space, content, now = NOW) {
  return await withKithTransaction(f.pool, (client) =>
    memory.captureThought(
      identityCtx(client, now),
      space.userId,
      space.spaceId,
      { content, metadata: metadata(content) },
    ),
  );
}

/** One axis per text, chosen by the test rather than by call order, so the
 * query vector a search assertion uses is known in advance. */
function axisEmbedder(fingerprint, axisFor) {
  const calls = [];
  const embed = async (texts) => {
    calls.push([...texts]);
    return texts.map((text) => ({
      vector: oneHot(axisFor(text)),
      fingerprint,
    }));
  };
  embed.calls = calls;
  embed.texts = () => calls.flat();
  return embed;
}

async function fillJobs(f, spaceId) {
  const found = await f.client.query(
    `SELECT id, space_id, payload, dedupe_key, state, attempts, last_error,
            run_after
       FROM kith.deferred_work
      WHERE kind = 'embedding_fill'
        AND ($1::text IS NULL OR space_id = $1)
      ORDER BY created_at, id`,
    [spaceId ?? null],
  );
  return found.rows;
}

async function activeTarget(f, spaceId, now = NOW) {
  return await withKithTransaction(f.pool, (client) =>
    embeddings.getActiveEmbeddingTarget(identityCtx(client, now), spaceId),
  );
}

async function vectorCount(f, spaceId) {
  const found = await f.client.query(
    "SELECT count(*)::int AS n FROM kith.embedding_vectors WHERE space_id = $1",
    [spaceId],
  );
  return found.rows[0].n;
}

async function targetRows(f, spaceId) {
  const found = await f.client.query(
    `SELECT target_kind, target_id, state, covered_fingerprint
       FROM kith.embedding_targets WHERE space_id = $1 ORDER BY target_id`,
    [spaceId],
  );
  return found.rows;
}

/** How many other backends on this database are sitting inside an open
 * transaction right now. Section 4.4's rule, observed from outside. */
async function idleInTransaction(f) {
  const found = await f.client.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'idle in transaction'`,
  );
  return found.rows[0].n;
}

test(
  "drain holds a transaction for a plain handler and none for a pooled one",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    for (const kind of ["inline_ingestion", "embedding_fill"]) {
      await withKithTransaction(f.pool, (client) =>
        schedule(deferredCtx(client, NOW), { kind, payload: {} }),
      );
    }
    const seen = {};
    const registry = createRegistry();
    registry.set("inline_ingestion", async () => {
      seen.transactionScoped = await idleInTransaction(f);
    });
    registry.set("embedding_fill", {
      scope: "pool",
      run: async () => {
        seen.pooled = await idleInTransaction(f);
      },
    });

    const summary = await drain(f.pool, registry, { now: NOW });
    assert.equal(summary.completed, 2);
    // The plain handler runs inside `withKithTransaction`, so its connection
    // is visibly held. The pooled one runs with nothing open, which is the
    // whole reason `embedding_fill` is registered in that scope: the provider
    // call happens where this count is zero.
    assert.equal(seen.transactionScoped, 1);
    assert.equal(seen.pooled, 0);
  },
);

test(
  "a capture schedules one fill per space, and a burst converges on it",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    const alpha = await seedCountedSpace(f);
    const beta = await seedCountedSpace(f);

    await capture(f, alpha, "alpha memory");
    const afterFirst = await fillJobs(f, alpha.spaceId);
    assert.equal(afterFirst.length, 1);
    assert.equal(
      afterFirst[0].dedupe_key,
      `embedding_fill:${alpha.spaceId}`,
    );
    assert.deepEqual(afterFirst[0].payload, { spaceId: alpha.spaceId });
    assert.equal(afterFirst[0].space_id, alpha.spaceId);
    assert.equal(afterFirst[0].state, "queued");

    // The second capture of a burst enqueues nothing: the key is still held by
    // the queued row. The one job that does run reads the owed index when it
    // runs, so it covers both thoughts rather than only the first.
    await capture(f, alpha, "beta memory", NOW + 1);
    await capture(f, alpha, "gamma memory", NOW + 2);
    const afterBurst = await fillJobs(f, alpha.spaceId);
    assert.equal(afterBurst.length, 1);
    assert.equal(afterBurst[0].id, afterFirst[0].id);

    // The key is per space, so another space's capture is its own job.
    await capture(f, beta, "delta memory", NOW + 3);
    const betaJobs = await fillJobs(f, beta.spaceId);
    assert.equal(betaJobs.length, 1);
    assert.notEqual(betaJobs[0].id, afterFirst[0].id);
    assert.equal(betaJobs[0].dedupe_key, `embedding_fill:${beta.spaceId}`);
  },
);

test(
  "concurrent captures in one space still converge on one job",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    const space = await seedCountedSpace(f);
    // The dedupe read and insert are now part of the capture's own
    // `SERIALIZABLE` transaction, so six captures racing into one space
    // contend on the same index range. `withKithTransaction`'s bounded retry
    // is what makes that converge rather than fail; this pins that it does,
    // because a capture that threw under concurrency would be a regression
    // the single-writer tests above could not see.
    const ids = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((n) =>
        capture(f, space, `memory ${n}`, NOW + n),
      ),
    );
    assert.equal(new Set(ids).size, 6);
    const jobs = await fillJobs(f, space.spaceId);
    assert.equal(jobs.length, 1);
  },
);

test(
  "the default registry drains the fill, and the vector leg answers afterwards",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    const space = await seedCountedSpace(f);
    const thoughtId = await capture(f, space, "alpha memory");

    // I9: until the fill runs, the space's covered and eligible thought counts
    // disagree and the index reports itself incomplete. This is the state a
    // capture used to leave behind permanently.
    const before = await activeTarget(f, space.spaceId);
    assert.equal(before.thoughtStatus, "unavailable");

    // Section 4.4: no `pg` connection may be held across the provider call.
    // The embedder asserts it from the outside, on its own connection, while
    // the fill is mid-page. The test above shows this count is not vacuously
    // zero.
    let heldConnections = null;
    const embed = axisEmbedder(space.index.fingerprint, () => 1);
    const watched = async (texts) => {
      heldConnections = await idleInTransaction(f);
      return await embed(texts);
    };

    const summary = await drain(f.pool, defaultRegistry({ embedder: watched }), {
      now: NOW,
    });
    assert.equal(summary.claimed, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.outcomes[0].kind, "embedding_fill");
    assert.equal(heldConnections, 0);
    assert.deepEqual(embed.texts(), ["alpha memory"]);

    const after = await activeTarget(f, space.spaceId);
    assert.equal(after.thoughtStatus, "ready");

    const candidates = await withKithTransaction(f.pool, (client) =>
      embeddings.searchThoughtVectorCandidates(
        identityCtx(client, NOW),
        [after],
        oneHot(1),
      ),
    );
    assert.deepEqual(
      candidates.map((candidate) => candidate.thoughtId),
      [thoughtId],
    );

    const job = await fillJobs(f, space.spaceId);
    assert.equal(job[0].state, "done");
  },
);

test(
  "a failing embedder fails the job through `fail`, and leaves it recoverable",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    const space = await seedCountedSpace(f);
    const thoughtId = await capture(f, space, "alpha memory");

    const failing = async () => {
      throw new Error("synthetic embedder failure");
    };
    const first = await drain(f.pool, defaultRegistry({ embedder: failing }), {
      now: NOW,
    });
    assert.equal(first.claimed, 1);
    assert.equal(first.retrying, 1);
    assert.equal(first.completed, 0);

    const [queued] = await fillJobs(f, space.spaceId);
    assert.equal(queued.state, "queued");
    assert.equal(Number(queued.attempts), 1);
    assert.equal(queued.last_error, "synthetic embedder failure");
    // Backoff is full jitter over a 2s cap on the first attempt, so the only
    // claim this can make is that the job is not due before it failed.
    assert.ok(queued.run_after.getTime() >= NOW);
    assert.equal(first.outcomes[0].status, "retrying");
    assert.ok(first.outcomes[0].nextAttemptAt >= NOW);

    // Nothing partial was stored. No vector was written, the target is still
    // eligible and uncovered, and the space still reports itself incomplete,
    // which is exactly the state the next run knows how to resume from.
    assert.equal(await vectorCount(f, space.spaceId), 0);
    assert.deepEqual(await targetRows(f, space.spaceId), [
      {
        target_kind: "thought",
        target_id: thoughtId,
        state: "eligible",
        covered_fingerprint: null,
      },
    ]);
    assert.equal(
      (await activeTarget(f, space.spaceId)).thoughtStatus,
      "unavailable",
    );

    // The retry, past the backoff, recovers with no operator step.
    const later = NOW + 60_000;
    const embed = axisEmbedder(space.index.fingerprint, () => 1);
    const second = await drain(f.pool, defaultRegistry({ embedder: embed }), {
      now: later,
    });
    assert.equal(second.completed, 1);
    assert.equal(await vectorCount(f, space.spaceId), 1);
    assert.equal(
      (await activeTarget(f, space.spaceId, later)).thoughtStatus,
      "ready",
    );
  },
);

test(
  "a fill for one space never covers another space's rows",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    const alpha = await seedCountedSpace(f);
    const beta = await seedCountedSpace(f);
    await capture(f, alpha, "alpha memory");
    const betaThoughtId = await capture(f, beta, "beta memory", NOW + 1);

    // Both captures queued their own job. Drop beta's so the drain below runs
    // exactly one fill and the assertion about the other space is about
    // isolation rather than about which job was claimed first.
    await f.client.query(
      "DELETE FROM kith.deferred_work WHERE kind = 'embedding_fill' AND space_id = $1",
      [beta.spaceId],
    );

    const embed = axisEmbedder(alpha.index.fingerprint, () => 1);
    const summary = await drain(f.pool, defaultRegistry({ embedder: embed }), {
      now: NOW + 2,
    });
    assert.equal(summary.completed, 1);

    // The provider was only ever shown alpha's text.
    assert.deepEqual(embed.texts(), ["alpha memory"]);
    assert.equal(await vectorCount(f, alpha.spaceId), 1);
    assert.equal(await vectorCount(f, beta.spaceId), 0);
    assert.equal(
      (await activeTarget(f, alpha.spaceId, NOW + 2)).thoughtStatus,
      "ready",
    );
    const betaTarget = await activeTarget(f, beta.spaceId, NOW + 2);
    assert.equal(betaTarget.thoughtStatus, "unavailable");
    assert.deepEqual(await targetRows(f, beta.spaceId), [
      {
        target_kind: "thought",
        target_id: betaThoughtId,
        state: "eligible",
        covered_fingerprint: null,
      },
    ]);
  },
);

test(
  "a payload whose space is not the job's space is refused",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    const alpha = await seedCountedSpace(f);
    const beta = await seedCountedSpace(f);
    await capture(f, alpha, "alpha memory");
    await f.client.query(
      `UPDATE kith.deferred_work SET payload = $2::jsonb
        WHERE kind = 'embedding_fill' AND space_id = $1`,
      [alpha.spaceId, JSON.stringify({ spaceId: beta.spaceId })],
    );

    const embed = axisEmbedder(alpha.index.fingerprint, () => 1);
    const summary = await drain(f.pool, defaultRegistry({ embedder: embed }), {
      now: NOW,
    });
    assert.equal(summary.retrying, 1);
    assert.deepEqual(embed.texts(), []);
    const [job] = await fillJobs(f, alpha.spaceId);
    assert.equal(job.last_error, "embedding_fill payload is not in the job's space");
    assert.equal(await vectorCount(f, beta.spaceId), 0);
  },
);

test(
  "a provider failure reaches `last_error` as a fixed string, never a provider message",
  { skip },
  async (t) => {
    const f = await poolFixture(t);
    const space = await seedCountedSpace(f);
    await capture(f, space, "alpha memory");

    // The daemon's own embedder, with the provider's transport replaced. The
    // rejection carries everything an error text must never carry.
    const fetchImpl = async () => {
      throw new Error(
        "401 from api.openai.com: Bearer sk-synthetic-not-a-real-key rejected",
      );
    };
    const registry = defaultRegistry({
      env: { OPENAI_API_KEY: "sk-synthetic-not-a-real-key" },
      fetchImpl,
    });
    const summary = await drain(f.pool, registry, { now: NOW });
    assert.equal(summary.retrying, 1);

    const [job] = await fillJobs(f, space.spaceId);
    assert.equal(
      job.last_error,
      embeddings.EMBEDDING_PROVIDER_REQUEST_ERROR,
    );
    assert.ok(!job.last_error.includes("sk-"));
    assert.ok(!job.last_error.includes("api.openai.com"));
  },
);

test("the daemon's embedder collapses every provider error", async () => {
  const leaky = async () => {
    throw new Error("sk-synthetic-not-a-real-key was refused by api.openai.com");
  };
  const embed = embeddings.providerBatchEmbedder(
    { OPENAI_API_KEY: "sk-synthetic-not-a-real-key" },
    leaky,
  );
  const failure = await embed(["alpha"]).then(
    () => null,
    (error) => error,
  );
  assert.equal(failure.message, embeddings.EMBEDDING_PROVIDER_REQUEST_ERROR);

  // A bad configuration is the other half, and it is reported when the first
  // batch runs rather than when the embedder is built, so the daemon starts.
  const misconfigured = embeddings.providerBatchEmbedder({
    BRAIN_EMBED_ENDPOINT: "not a url",
  });
  const unconfigured = await misconfigured(["alpha"]).then(
    () => null,
    (error) => error,
  );
  assert.equal(
    unconfigured.message,
    embeddings.EMBEDDING_PROVIDER_UNCONFIGURED_ERROR,
  );

  // An empty batch is not a provider call at all.
  assert.deepEqual(await misconfigured([]), []);
});

test("card_queue_tick has no handler to register yet", () => {
  const registry = defaultRegistry({ embedder: async () => [] });
  assert.equal(registry.has("inline_ingestion"), true);
  assert.equal(registry.has("embedding_fill"), true);
  // `models/records/cardQueue.ts` and its tables are not ported, so there is
  // nothing for a handler to run. `drain` fails such a job without consuming
  // an attempt, and nothing in this package schedules one.
  assert.equal(registry.has("card_queue_tick"), false);
});

test("a queued card_queue_tick is still inert", { skip }, async (t) => {
  const f = await poolFixture(t);
  await f.client.query(
    `INSERT INTO kith.deferred_work (id, kind, payload, run_after, max_attempts, state)
     VALUES ('cardqueuetickinertjob0001', 'card_queue_tick', '{}'::jsonb,
             to_timestamp($1 / 1000.0), 5, 'queued')`,
    [NOW],
  );
  const summary = await drain(
    f.pool,
    defaultRegistry({ embedder: async () => [] }),
    { now: NOW },
  );
  assert.equal(summary.unregisteredKind, 1);
  const found = await f.client.query(
    "SELECT state, attempts FROM kith.deferred_work WHERE kind = 'card_queue_tick'",
  );
  assert.equal(found.rows[0].state, "failed");
  assert.equal(Number(found.rows[0].attempts), 0);
});

test("the fill job is scheduled from the write, not from a read", { skip }, async (t) => {
  const f = await poolFixture(t);
  const space = await seedCountedSpace(f);
  await capture(f, space, "alpha memory");
  await drain(f.pool, defaultRegistry({ embedder: axisEmbedder(space.index.fingerprint, () => 1) }), {
    now: NOW,
  });
  const before = (await fillJobs(f, space.spaceId)).length;

  // Every read path the capture gate and the search legs use, run twice.
  for (let round = 0; round < 2; round += 1) {
    const target = await activeTarget(f, space.spaceId, NOW + round);
    await withKithTransaction(f.pool, (client) =>
      embeddings.searchThoughtVectorCandidates(
        identityCtx(client, NOW + round),
        [target],
        oneHot(1),
      ),
    );
  }
  assert.equal((await fillJobs(f, space.spaceId)).length, before);
});

test("a rolled-back capture leaves no fill queued", { skip }, async (t) => {
  const f = await poolFixture(t);
  const space = await seedCountedSpace(f);
  const failure = await withKithTransaction(f.pool, async (client) => {
    const ctx = identityCtx(client, NOW);
    await memory.captureThought(ctx, space.userId, space.spaceId, {
      content: "alpha memory",
      metadata: metadata("alpha memory"),
    });
    throw new Error("synthetic rollback");
  }).then(
    () => null,
    (error) => error,
  );
  assert.equal(failure.message, "synthetic rollback");
  // Section 2.4: the job row is transactional with the write it follows.
  assert.deepEqual(await fillJobs(f, space.spaceId), []);
  const thoughts = await f.client.query(
    "SELECT count(*)::int AS n FROM kith.thoughts WHERE space_id = $1",
    [space.spaceId],
  );
  assert.equal(thoughts.rows[0].n, 0);
});

test("a superseding transition schedules the fill too", { skip }, async (t) => {
  const f = await poolFixture(t);
  const space = await seedCountedSpace(f);
  const original = await capture(f, space, "alpha memory");
  await drain(
    f.pool,
    defaultRegistry({ embedder: axisEmbedder(space.index.fingerprint, () => 1) }),
    { now: NOW },
  );
  assert.equal(
    (await activeTarget(f, space.spaceId)).thoughtStatus,
    "ready",
  );

  const later = NOW + 1_000;
  const supersededId = await withKithTransaction(f.pool, (client) =>
    memory.transitionMemory(
      identityCtx(client, later),
      space.userId,
      space.spaceId,
      {
        content: "alpha memory, corrected",
        metadata: metadata("alpha memory, corrected"),
      },
      [original],
      "superseded",
      "synthetic correction",
      later,
    ),
  );
  const queued = (await fillJobs(f, space.spaceId)).filter(
    (job) => job.state === "queued",
  );
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].payload, { spaceId: space.spaceId });

  const embed = axisEmbedder(space.index.fingerprint, () => 2);
  const summary = await drain(f.pool, defaultRegistry({ embedder: embed }), {
    now: later,
  });
  assert.equal(summary.completed, 1);
  assert.deepEqual(embed.texts(), ["alpha memory, corrected"]);
  const target = await activeTarget(f, space.spaceId, later);
  assert.equal(target.thoughtStatus, "ready");
  const candidates = await withKithTransaction(f.pool, (client) =>
    embeddings.searchThoughtVectorCandidates(
      identityCtx(client, later),
      [target],
      oneHot(2),
    ),
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.thoughtId),
    [supersededId],
  );
});
