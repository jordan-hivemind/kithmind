// `memory.listAroundTime`, the thought timeline P2-39i3 ported from
// `listAroundTimeAuthorized`.
//
// Synthetic thoughts only, on a throwaway database, with creation times set
// explicitly so the window is deterministic rather than dependent on how fast
// the inserts ran.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import * as memory from "../dist/memory/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/memoryFixture.mjs";

const BASE = 1_760_000_000_000;

function metadata(summary, type = "reference") {
  return { type, topics: ["synthetic"], people: [], actionItems: [], summary };
}

/** A thought row at an exact creation time. `captureThought` uses the
 * transaction clock, and this suite needs the anchor to be a known value. */
async function seedThought(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.thoughts
       (id, space_id, created_at, content, metadata, user_id, memory_status,
        valid_from, valid_to)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [
      id,
      fields.spaceId,
      new Date(fields.createdAt),
      fields.content,
      JSON.stringify(metadata(fields.content, fields.type)),
      fields.userId,
      fields.memoryStatus ?? "current",
      fields.validFrom === undefined ? null : new Date(fields.validFrom),
      fields.validTo === undefined ? null : new Date(fields.validTo),
    ],
  );
  return id;
}

async function refusal(work) {
  try {
    await work();
    return null;
  } catch (error) {
    return error.message;
  }
}

test(
  "the timeline window is bounded, ordered oldest first, and anchored on a seed or a time",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

      const ids = [];
      for (let index = 0; index < 7; index += 1) {
        ids.push(
          await seedThought(ctx, {
            spaceId,
            userId,
            createdAt: BASE + index * 1_000,
            content: `synthetic ${index}`,
            type: index === 3 ? "decision" : "reference",
          }),
        );
      }

      // Anchored on a time between rows 2 and 3, two each side.
      const around = await memory.listAroundTime(ctx, [spaceId], {
        aroundMs: BASE + 2_500,
        before: 2,
        after: 2,
      });
      assert.deepEqual(
        around.map((thought) => thought.content),
        ["synthetic 1", "synthetic 2", "synthetic 3", "synthetic 4"],
      );

      // Anchored on a seed, which is included in creation order.
      const seeded = await memory.listAroundTime(ctx, [spaceId], {
        seedId: ids[3],
        before: 1,
        after: 1,
      });
      assert.deepEqual(
        seeded.map((thought) => thought.content),
        ["synthetic 2", "synthetic 3", "synthetic 4"],
      );

      // A zero-width side returns nothing from that side.
      const oneSided = await memory.listAroundTime(ctx, [spaceId], {
        aroundMs: BASE + 2_500,
        before: 0,
        after: 3,
      });
      assert.deepEqual(
        oneSided.map((thought) => thought.content),
        ["synthetic 3", "synthetic 4", "synthetic 5"],
      );

      // A type filter narrows both sides, and the seed is still returned.
      const typed = await memory.listAroundTime(ctx, [spaceId], {
        seedId: ids[3],
        before: 2,
        after: 2,
        type: "decision",
      });
      assert.deepEqual(
        typed.map((thought) => thought.content),
        ["synthetic 3"],
      );
    });
  },
);

test(
  "the timeline refuses an absent anchor, both anchors, and an out-of-range window",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      const seedId = await seedThought(ctx, {
        spaceId,
        userId,
        createdAt: BASE,
        content: "anchor",
      });

      assert.match(
        await refusal(() =>
          memory.listAroundTime(ctx, [spaceId], { before: 1, after: 1 }),
        ),
        /exactly one of seedId or aroundMs/,
      );
      assert.match(
        await refusal(() =>
          memory.listAroundTime(ctx, [spaceId], {
            seedId,
            aroundMs: BASE,
            before: 1,
            after: 1,
          }),
        ),
        /exactly one of seedId or aroundMs/,
      );
      assert.match(
        await refusal(() =>
          memory.listAroundTime(ctx, [spaceId], {
            aroundMs: BASE,
            before: 51,
            after: 1,
          }),
        ),
        /Timeline windows must be integers from 0 to 50/,
      );
      assert.match(
        await refusal(() =>
          memory.listAroundTime(ctx, [spaceId], {
            aroundMs: Number.NaN,
            before: 1,
            after: 1,
          }),
        ),
        /exactly one of seedId or aroundMs/,
      );
    });
  },
);

test(
  "the timeline withholds retracted and superseded memories, including as a seed",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

      await seedThought(ctx, {
        spaceId,
        userId,
        createdAt: BASE,
        content: "current",
      });
      const supersededId = await seedThought(ctx, {
        spaceId,
        userId,
        createdAt: BASE + 1_000,
        content: "superseded",
        memoryStatus: "superseded",
      });
      await seedThought(ctx, {
        spaceId,
        userId,
        createdAt: BASE + 2_000,
        content: "retracted",
        memoryStatus: "retracted",
      });
      // Business-time windows are respected the same way every other read
      // respects them: a memory that is not yet effective is not in the window.
      await seedThought(ctx, {
        spaceId,
        userId,
        createdAt: BASE + 3_000,
        content: "not yet true",
        validFrom: Date.now() + 86_400_000,
      });

      const window = await memory.listAroundTime(ctx, [spaceId], {
        aroundMs: BASE - 1,
        before: 0,
        after: 10,
      });
      assert.deepEqual(
        window.map((thought) => thought.content),
        ["current"],
      );

      assert.match(
        await refusal(() =>
          memory.listAroundTime(ctx, [spaceId], {
            seedId: supersededId,
            before: 1,
            after: 1,
          }),
        ),
        /Seed thought not found/,
      );
    });
  },
);

test(
  "a timeline never crosses into a space the caller is not authorized for",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceA = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
        name: "A",
      });
      const spaceB = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
        name: "B",
      });

      await seedThought(ctx, {
        spaceId: spaceA,
        userId,
        createdAt: BASE,
        content: "in A",
      });
      const inB = await seedThought(ctx, {
        spaceId: spaceB,
        userId,
        createdAt: BASE + 500,
        content: "in B",
      });

      const window = await memory.listAroundTime(ctx, [spaceA], {
        aroundMs: BASE - 1,
        before: 0,
        after: 10,
      });
      assert.deepEqual(
        window.map((thought) => thought.content),
        ["in A"],
      );

      // A seed in the other space reads as a missing seed, not as a denial
      // that would confirm the row exists.
      assert.match(
        await refusal(() =>
          memory.listAroundTime(ctx, [spaceA], {
            seedId: inB,
            before: 5,
            after: 5,
          }),
        ),
        /Seed thought not found/,
      );

      const both = await memory.listAroundTime(ctx, [spaceA, spaceB], {
        aroundMs: BASE - 1,
        before: 0,
        after: 10,
      });
      assert.deepEqual(
        both.map((thought) => thought.content),
        ["in A", "in B"],
      );
    });
  },
);

test(
  "each space contributes at most its share and the merged window keeps the bound",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceA = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      const spaceB = await makeSpace(ctx, { createdBy: userId, role: "owner" });

      // Interleaved in time, so a merge that simply concatenated the two
      // per-space pages would return the wrong two rows.
      for (let index = 0; index < 4; index += 1) {
        await seedThought(ctx, {
          spaceId: index % 2 === 0 ? spaceA : spaceB,
          userId,
          createdAt: BASE + index * 1_000,
          content: `row ${index}`,
        });
      }

      const window = await memory.listAroundTime(ctx, [spaceA, spaceB], {
        aroundMs: BASE + 3_500,
        before: 2,
        after: 0,
      });
      assert.deepEqual(
        window.map((thought) => thought.content),
        ["row 2", "row 3"],
      );
    });
  },
);
