// `memory.computeSpaceStats`, the thought space stats digest P2-39i3 ported
// from `_computeSpaceStats` (question 4 of the web and MCP surface plan).
//
// The point of the digest is which rows it does and does not read: a counted
// space's totals come from one space-state row and a scan of its thoughts must
// not change them. These cases seed a counter that deliberately disagrees with
// the rows, so a total that came from the scan is visible as a wrong number
// rather than as a coincidence.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import * as memory from "../dist/memory/index.js";
import { seedActiveEmbeddingIndex } from "./helpers/embeddingFixture.mjs";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/memoryFixture.mjs";

const BASE = 1_760_000_000_000;

function metadata(fields) {
  return {
    type: fields.type ?? "reference",
    topics: fields.topics ?? [],
    people: fields.people ?? [],
    actionItems: [],
    summary: fields.summary ?? "synthetic",
  };
}

async function seedThought(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.thoughts
       (id, space_id, created_at, content, metadata, user_id, memory_status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      id,
      fields.spaceId,
      new Date(fields.createdAt ?? BASE),
      fields.content ?? "synthetic thought",
      JSON.stringify(metadata(fields)),
      fields.userId,
      fields.memoryStatus ?? "current",
    ],
  );
  return id;
}

let factSubjects = 0;

/** One fact through the real writer, then its lifecycle set directly. The
 * writer owns the entity and statement rows; only the status matters here. */
async function seedFact(ctx, fields) {
  factSubjects += 1;
  const written = await memory.rememberFact(
    ctx,
    fields.userId,
    fields.spaceId,
    {
      subject: { kind: "person", name: `Synthetic ${factSubjects}` },
      predicate: "home_city",
      value: { type: "text", value: "Oakland" },
      sourceType: "user_stated",
    },
  );
  if (fields.status !== undefined) {
    await ctx.client.query("UPDATE kith.facts SET status = $2 WHERE id = $1", [
      written.factId,
      fields.status,
    ]);
  }
  return written.factId;
}

/** The counter shape `readSpaceCounters` calls counted: an audited state row
 * plus a historical bucket. Without the historical bucket the space reads as
 * uncounted, which is the other branch under test. */
async function seedCounters(ctx, spaceId, counts) {
  const seeded = await seedActiveEmbeddingIndex(ctx, spaceId, {
    eligible: { thought: counts.current, chunk: 0, card: 0 },
    covered: { thought: counts.current, chunk: 0, card: 0 },
  });
  await ctx.client.query(
    `UPDATE kith.space_embedding_states
        SET historical_thought_counts = $2::jsonb WHERE space_id = $1`,
    [
      spaceId,
      JSON.stringify({
        superseded: counts.superseded,
        retracted: counts.retracted,
      }),
    ],
  );
  return seeded;
}

test(
  "a counted space reports its totals from the counters and never from a thought scan",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      await seedCounters(ctx, spaceId, {
        current: 41,
        superseded: 7,
        retracted: 3,
      });
      // One row, and counters that say 41. A total of 42 would mean the scan
      // contributed; a total of 1 would mean the counters were ignored.
      await seedThought(ctx, { spaceId, userId, type: "decision" });

      const stats = await memory.computeSpaceStats(ctx, [spaceId]);
      assert.equal(stats.totalThoughts, 41);
      assert.equal(stats.historicalThoughts, 7);
      assert.equal(stats.retractedThoughts, 3);
      assert.equal(stats.partial, false);
      assert.deepEqual(stats.coverage.map((row) => row.spaceId), [spaceId]);
      assert.equal(stats.coverage[0].status, "complete");
      // The digest is still a scan, so it still sees the one row.
      assert.deepEqual(stats.byType, [{ type: "decision", count: 1 }]);
    });
  },
);

test(
  "an uncounted space falls back to the bounded scan and reports its coverage as unknown",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

      await seedThought(ctx, { spaceId, userId, type: "decision" });
      await seedThought(ctx, { spaceId, userId, type: "idea" });
      await seedThought(ctx, {
        spaceId,
        userId,
        memoryStatus: "superseded",
      });
      await seedThought(ctx, { spaceId, userId, memoryStatus: "retracted" });

      const stats = await memory.computeSpaceStats(ctx, [spaceId]);
      assert.equal(stats.totalThoughts, 2);
      assert.equal(stats.historicalThoughts, 1);
      assert.equal(stats.retractedThoughts, 1);
      assert.deepEqual(stats.coverage, [
        { spaceId, status: "unknown", drift: false },
      ]);
    });
  },
);

test(
  "the digest ranks types, topics and people by count and reports its own bound",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      await seedCounters(ctx, spaceId, {
        current: 3,
        superseded: 0,
        retracted: 0,
      });

      await seedThought(ctx, {
        spaceId,
        userId,
        type: "decision",
        topics: ["ledger", "budget"],
        people: ["Rowan"],
        createdAt: BASE,
      });
      await seedThought(ctx, {
        spaceId,
        userId,
        type: "decision",
        topics: ["ledger"],
        people: ["Rowan", "Wren"],
        createdAt: BASE + 1_000,
      });
      await seedThought(ctx, {
        spaceId,
        userId,
        type: "idea",
        topics: ["budget"],
        people: [],
        createdAt: BASE + 2_000,
      });
      // A superseded row never reaches the digest, only the counters.
      await seedThought(ctx, {
        spaceId,
        userId,
        type: "task",
        topics: ["never"],
        people: ["Nobody"],
        memoryStatus: "superseded",
      });

      const stats = await memory.computeSpaceStats(ctx, [spaceId]);
      assert.deepEqual(stats.byType, [
        { type: "decision", count: 2 },
        { type: "idea", count: 1 },
      ]);
      assert.deepEqual(stats.topTopics, [
        { topic: "budget", count: 2 },
        { topic: "ledger", count: 2 },
      ]);
      assert.deepEqual(stats.topPeople, [
        { person: "Rowan", count: 2 },
        { person: "Wren", count: 1 },
      ]);
      assert.deepEqual(stats.dateRange, {
        earliest: BASE,
        latest: BASE + 2_000,
      });
      assert.equal(stats.partial, false);

      // The bound binding is reported rather than silently sampled.
      const bounded = await memory.computeSpaceStats(ctx, [spaceId], {
        maxDigestRows: 1,
      });
      assert.equal(bounded.partial, true);
      assert.equal(bounded.totalThoughts, 3, "counters are not resampled");
    });
  },
);

test("facts are counted by lifecycle from their own bounded scan", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

    await seedFact(ctx, { spaceId, userId });
    await seedFact(ctx, { spaceId, userId });
    await seedFact(ctx, { spaceId, userId, status: "superseded" });
    await seedFact(ctx, { spaceId, userId, status: "retracted" });

    const stats = await memory.computeSpaceStats(ctx, [spaceId]);
    assert.equal(stats.totalFacts, 2);
    assert.equal(stats.historicalFacts, 1);
    assert.equal(stats.retractedFacts, 1);

    const bounded = await memory.computeSpaceStats(ctx, [spaceId], {
      maxFactRows: 2,
    });
    assert.equal(bounded.partial, true);
  });
});

test(
  "stats never count a space the caller is not authorized for",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceA = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      const spaceB = await makeSpace(ctx, { createdBy: userId, role: "owner" });

      await seedThought(ctx, {
        spaceId: spaceA,
        userId,
        type: "decision",
        topics: ["a"],
        people: ["Rowan"],
      });
      await seedFact(ctx, { spaceId: spaceA, userId });
      for (let index = 0; index < 3; index += 1) {
        await seedThought(ctx, {
          spaceId: spaceB,
          userId,
          type: "idea",
          topics: ["b"],
          people: ["Wren"],
        });
        await seedFact(ctx, { spaceId: spaceB, userId });
      }

      const onlyA = await memory.computeSpaceStats(ctx, [spaceA]);
      assert.equal(onlyA.totalThoughts, 1);
      assert.equal(onlyA.totalFacts, 1);
      assert.deepEqual(onlyA.byType, [{ type: "decision", count: 1 }]);
      assert.deepEqual(onlyA.topTopics, [{ topic: "a", count: 1 }]);
      assert.deepEqual(onlyA.topPeople, [{ person: "Rowan", count: 1 }]);
      assert.deepEqual(onlyA.coverage.map((row) => row.spaceId), [spaceA]);

      const both = await memory.computeSpaceStats(ctx, [spaceA, spaceB]);
      assert.equal(both.totalThoughts, 4);
      assert.equal(both.totalFacts, 4);
    });
  },
);

test("an empty authorized set reports nothing rather than everything", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
    await seedThought(ctx, { spaceId, userId });

    const stats = await memory.computeSpaceStats(ctx, []);
    assert.equal(stats.totalThoughts, 0);
    assert.equal(stats.totalFacts, 0);
    assert.deepEqual(stats.coverage, []);
    assert.equal(stats.dateRange, undefined);
  });
});
