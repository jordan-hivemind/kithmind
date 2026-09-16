// P2-39g2: the provider fill, against a real PostgreSQL server.
//
// The owed page, the I7 recheck that skips a target whose live text has moved,
// the idempotent commit, and the driver that runs page after page until
// nothing is owed. The provider is injected, so nothing here touches a
// network: `recordingEmbedder` answers with one distinct axis per distinct
// text and records what it was asked for, which is what makes "the fill sent
// exactly these texts" an assertion rather than a hope.
//
// The last test is the only one in this file that uses a real pool rather than
// the shared rolled-back transaction, because two concurrent `SERIALIZABLE`
// commits cannot be simulated inside one.

import assert from "node:assert/strict";
import test from "node:test";

import { createKithPool, withKithTransaction } from "../dist/index.js";
import { identityCtx } from "../dist/identity/index.js";
import * as embeddings from "../dist/embeddings/index.js";
import * as memory from "../dist/memory/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/memoryFixture.mjs";
import {
  oneHot,
  recordingEmbedder,
  seedActiveEmbeddingIndex,
  seedGenericCard,
  seedIndexableDocument,
  sha256Utf8,
} from "./helpers/embeddingFixture.mjs";

const metadata = (summary) => ({
  type: "reference",
  topics: ["synthetic"],
  people: [],
  actionItems: [],
  summary,
});

const refusal = async (work) => {
  try {
    await work();
    return null;
  } catch (error) {
    return error.message;
  }
};

/** Three thoughts, one document of two chunks and one card, all owed. */
async function seedOwedSpace(ctx, userId) {
  const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
  const index = await seedActiveEmbeddingIndex(ctx, spaceId, {
    eligible: { thought: 0, chunk: 0, card: 0 },
  });
  const thoughtIds = [];
  for (const content of ["alpha memory", "beta memory", "gamma memory"]) {
    thoughtIds.push(
      await memory.captureThought(ctx, userId, spaceId, {
        content,
        metadata: metadata(content),
      }),
    );
  }
  const chunkTexts = ["first chunk text", "second chunk text"];
  const chain = await seedIndexableDocument(ctx, spaceId, {
    title: "A plan",
    chunks: chunkTexts,
  });
  const card = await seedGenericCard(ctx, spaceId, chain, {
    fields: {
      card_kind: "note",
      card_title: "A plan",
      card_summary: "Two chunks and a title.",
    },
  });
  // The chunks and the card become targets through the build's scan, which is
  // the writer that owns them; the thoughts already have theirs from capture.
  const started = await embeddings.startEmbeddingBuild(ctx, { spaceId });
  let cursor = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await embeddings.runEmbeddingBuildPage(ctx, {
      jobId: started.jobId,
      cursor,
    });
    if (page.isDone) break;
    cursor = page.cursor;
  }
  return { spaceId, index, thoughtIds, chain, card, chunkTexts };
}

async function coveredCount(ctx, spaceId, fingerprint) {
  return (
    await ctx.client.query(
      `SELECT count(*)::int AS rows FROM kith.embedding_targets
        WHERE space_id = $1 AND covered_fingerprint = $2`,
      [spaceId, fingerprint],
    )
  ).rows[0].rows;
}

async function vectorCount(ctx, spaceId) {
  return (
    await ctx.client.query(
      "SELECT count(*)::int AS rows FROM kith.embedding_vectors WHERE space_id = $1",
      [spaceId],
    )
  ).rows[0].rows;
}

test(
  "the owed page holds every eligible uncovered target and nothing else",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const space = await seedOwedSpace(ctx, userId);

      const page = await embeddings.nextEmbeddingFillPage(ctx, space.spaceId);
      assert.equal(page.counted, true);
      assert.equal(page.fingerprint, space.index.fingerprint);
      assert.deepEqual(page.targets.map((target) => target.targetKind).sort(), [
        "card",
        "chunk",
        "chunk",
        "thought",
        "thought",
        "thought",
      ]);
      // Each target carries the live text, and its hash is the target row's,
      // which is the whole of the I7 contract the commit rechecks.
      for (const target of page.targets) {
        assert.equal(await sha256Utf8(target.inputText), target.inputHash);
      }
      assert.deepEqual(
        page.targets
          .filter((target) => target.targetKind === "chunk")
          .map((target) => target.inputText)
          .sort(),
        [...space.chunkTexts].sort(),
      );

      // Covering one target removes it from the page. No cursor is involved:
      // the owed set is the partial index and coverage leaves it.
      await ctx.client.query(
        `UPDATE kith.embedding_targets SET covered_fingerprint = $1
          WHERE space_id = $2 AND target_id = $3`,
        [space.index.fingerprint, space.spaceId, space.thoughtIds[0]],
      );
      const smaller = await embeddings.nextEmbeddingFillPage(
        ctx,
        space.spaceId,
      );
      assert.equal(smaller.targets.length, page.targets.length - 1);
      assert.equal(
        smaller.targets.some(
          (target) => target.targetId === space.thoughtIds[0],
        ),
        false,
      );

      // A space whose counters were never seeded owes nothing until a build
      // seeds them: an uncounted space has no source of coverage truth.
      const bareSpaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const bare = await embeddings.nextEmbeddingFillPage(ctx, bareSpaceId);
      assert.deepEqual(bare, {
        fingerprint: null,
        counted: false,
        targets: [],
      });
    });
  },
);

test(
  "a target whose live text moved is skipped rather than embedded against a stale hash",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const space = await seedOwedSpace(ctx, userId);

      // The thought's text moves without going through `captureThought`, which
      // is the window I7 exists for: the target row still names the old hash.
      await ctx.client.query(
        "UPDATE kith.thoughts SET content = $2 WHERE id = $1",
        [space.thoughtIds[0], "alpha memory, rewritten elsewhere"],
      );
      const page = await embeddings.nextEmbeddingFillPage(ctx, space.spaceId);
      assert.equal(
        page.targets.some((target) => target.targetId === space.thoughtIds[0]),
        false,
        "the read page skips a target whose hash no longer matches its text",
      );

      // And so does the commit, even when a caller supplies a vector for it.
      const committed = await embeddings.commitEmbeddingFillPage(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
        vectors: [
          {
            targetKind: "thought",
            targetId: space.thoughtIds[0],
            inputHash: await sha256Utf8("alpha memory"),
            vector: oneHot(1),
          },
        ],
      });
      assert.equal(committed.embedded, 0);
      assert.equal(committed.skipped, 1);
      assert.equal(await vectorCount(ctx, space.spaceId), 0);

      // A retired target is skipped too, and so is one whose hash the caller
      // has wrong.
      await ctx.client.query(
        `UPDATE kith.embedding_targets
            SET state = 'retired', covered_fingerprint = NULL
          WHERE space_id = $1 AND target_id = $2`,
        [space.spaceId, space.thoughtIds[1]],
      );
      const more = await embeddings.commitEmbeddingFillPage(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
        vectors: [
          {
            targetKind: "thought",
            targetId: space.thoughtIds[1],
            inputHash: await sha256Utf8("beta memory"),
            vector: oneHot(2),
          },
          {
            targetKind: "thought",
            targetId: space.thoughtIds[2],
            inputHash: "f".repeat(64),
            vector: oneHot(3),
          },
        ],
      });
      assert.equal(more.embedded, 0);
      assert.equal(more.skipped, 2);
      assert.equal(await vectorCount(ctx, space.spaceId), 0);
    });
  },
);

test(
  "a committed page covers its targets, and replaying it writes nothing",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const space = await seedOwedSpace(ctx, userId);

      const page = await embeddings.nextEmbeddingFillPage(ctx, space.spaceId);
      const vectors = page.targets.map((target, index) => ({
        targetKind: target.targetKind,
        targetId: target.targetId,
        inputHash: target.inputHash,
        vector: oneHot(index + 1),
      }));
      const first = await embeddings.commitEmbeddingFillPage(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
        vectors,
      });
      assert.equal(first.embedded, vectors.length);
      assert.equal(first.skipped, 0);
      assert.equal(first.remaining, false, "the space owes nothing now");
      assert.equal(
        await coveredCount(ctx, space.spaceId, space.index.fingerprint),
        vectors.length,
      );
      const vectorsAfterFirst = await vectorCount(ctx, space.spaceId);
      assert.equal(vectorsAfterFirst, vectors.length);

      const countersAfterFirst = (
        await ctx.client.query(
          "SELECT eligible_counts, covered_counts FROM kith.space_embedding_states WHERE space_id = $1",
          [space.spaceId],
        )
      ).rows[0];
      assert.deepEqual(countersAfterFirst.covered_counts, [
        {
          fingerprint: space.index.fingerprint,
          counts: { thought: 3, chunk: 2, card: 1 },
        },
      ]);
      assert.deepEqual(
        countersAfterFirst.eligible_counts,
        { thought: 3, chunk: 2, card: 1 },
        "covered equals eligible once the fill has run",
      );

      // The replay. Every target is already covered by this fingerprint, so
      // every one is skipped and no row is written or changed.
      const rowsBefore = (
        await ctx.client.query(
          `SELECT id, input_hash, embedding::text AS embedding
             FROM kith.embedding_vectors WHERE space_id = $1 ORDER BY id`,
          [space.spaceId],
        )
      ).rows;
      const replay = await embeddings.commitEmbeddingFillPage(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
        vectors,
      });
      assert.equal(replay.embedded, 0);
      assert.equal(replay.skipped, vectors.length);
      const rowsAfter = (
        await ctx.client.query(
          `SELECT id, input_hash, embedding::text AS embedding
             FROM kith.embedding_vectors WHERE space_id = $1 ORDER BY id`,
          [space.spaceId],
        )
      ).rows;
      assert.deepEqual(
        rowsAfter,
        rowsBefore,
        "a replayed commit writes nothing",
      );
      assert.deepEqual(
        (
          await ctx.client.query(
            "SELECT covered_counts FROM kith.space_embedding_states WHERE space_id = $1",
            [space.spaceId],
          )
        ).rows[0].covered_counts,
        countersAfterFirst.covered_counts,
      );

      // A page naming the same target twice is a caller bug, not a duplicate
      // to absorb.
      assert.match(
        await refusal(() =>
          embeddings.commitEmbeddingFillPage(ctx, {
            spaceId: space.spaceId,
            fingerprint: space.index.fingerprint,
            vectors: [vectors[0], vectors[0]],
          }),
        ),
        /contains a duplicate target/,
      );

      // A page committed under a fingerprint the space is not active on covers
      // nothing, so it is refused outright rather than written and ignored.
      assert.match(
        await refusal(() =>
          embeddings.commitEmbeddingFillPage(ctx, {
            spaceId: space.spaceId,
            fingerprint: "a".repeat(64),
            vectors,
          }),
        ),
        /fingerprint is no longer active/,
      );
    });
  },
);

test(
  "the driver runs page after page until nothing is owed, and sends each text once",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    const pool = createKithPool(db.databaseUrl, 2);
    // The pool closes before the throwaway database is dropped: dropping
    // it terminates whatever is still connected, and a terminated
    // node-postgres client raises over whatever the test was reporting.
    try {
      // A committed space, because the driver opens its own transactions.
      const spaceId = await withKithTransaction(pool, async (client) => {
        const ctx = identityCtx(client);
        const userId = await makeUser(ctx);
        const space = await seedOwedSpace(ctx, userId);
        return space.spaceId;
      });
      const fingerprint = await withKithTransaction(pool, async (client) => {
        const target = await embeddings.getActiveEmbeddingTarget(
          identityCtx(client),
          spaceId,
        );
        return target.fingerprint;
      });

      const embed = recordingEmbedder(fingerprint);
      const result = await embeddings.runEmbeddingFill(pool, spaceId, embed, {
        // Two per page over six owed targets, so the driver has to page.
        limit: 2,
      });
      assert.equal(result.embedded, 6);
      assert.equal(result.skipped, 0);
      assert.equal(result.remaining, false);
      assert.ok(
        result.pages >= 3,
        "six targets at two per page is three pages",
      );
      assert.equal(
        embed.texts().length,
        6,
        "each owed text is sent exactly once",
      );
      assert.equal(
        new Set(embed.texts()).size,
        6,
        "and no text is sent twice across pages",
      );

      await withKithTransaction(pool, async (client) => {
        const ctx = identityCtx(client);
        assert.equal(await vectorCount(ctx, spaceId), 6);
        assert.equal(await coveredCount(ctx, spaceId, fingerprint), 6);
        const target = await embeddings.getActiveEmbeddingTarget(ctx, spaceId);
        assert.equal(
          target.thoughtStatus,
          "ready",
          "a fully filled index reports itself complete",
        );
        assert.deepEqual(target.chunkCoverage, { eligible: 2, covered: 2 });
      });

      // A second run has nothing to do and asks the provider nothing.
      const again = await embeddings.runEmbeddingFill(pool, spaceId, embed, {
        limit: 2,
      });
      assert.deepEqual(again, {
        pages: 0,
        requested: 0,
        embedded: 0,
        skipped: 0,
        remaining: false,
      });
      assert.equal(embed.texts().length, 6, "an idle run sends no text");

      // A provider whose profile is not the one the space is active on is a
      // refusal, not a page of vectors that cover nothing.
      await withKithTransaction(pool, async (client) => {
        const ctx = identityCtx(client);
        await ctx.client.query(
          `UPDATE kith.embedding_targets SET covered_fingerprint = NULL
            WHERE space_id = $1`,
          [spaceId],
        );
        await ctx.client.query(
          `UPDATE kith.space_embedding_states
              SET covered_counts = $2::jsonb WHERE space_id = $1`,
          [
            spaceId,
            JSON.stringify([
              { fingerprint, counts: { thought: 0, chunk: 0, card: 0 } },
            ]),
          ],
        );
      });
      await assert.rejects(
        embeddings.runEmbeddingFill(
          pool,
          spaceId,
          recordingEmbedder("c".repeat(64)),
          { limit: 2 },
        ),
        /provider profile does not match the active fingerprint/,
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "two concurrent commits of the same page converge on one vector per target",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    const pool = createKithPool(db.databaseUrl, 2);
    // The pool closes before the throwaway database is dropped: dropping
    // it terminates whatever is still connected, and a terminated
    // node-postgres client raises over whatever the test was reporting.
    try {
      const seeded = await withKithTransaction(pool, async (client) => {
        const ctx = identityCtx(client);
        const userId = await makeUser(ctx);
        const space = await seedOwedSpace(ctx, userId);
        return { spaceId: space.spaceId, fingerprint: space.index.fingerprint };
      });

      const page = await withKithTransaction(pool, (client) =>
        embeddings.nextEmbeddingFillPage(identityCtx(client), seeded.spaceId),
      );
      const vectors = page.targets.map((target, index) => ({
        targetKind: target.targetKind,
        targetId: target.targetId,
        inputHash: target.inputHash,
        vector: oneHot(index + 1),
      }));

      // Two callers commit the same page at the same time, which is the shape a
      // lost provider response and its retry produce. `SERIALIZABLE` plus the
      // bounded retry in `withKithTransaction` makes one of them the writer and
      // the other a replay; both return, and neither leaves a duplicate.
      const [left, right] = await Promise.all([
        withKithTransaction(pool, (client) =>
          embeddings.commitEmbeddingFillPage(identityCtx(client), {
            spaceId: seeded.spaceId,
            fingerprint: seeded.fingerprint,
            vectors,
          }),
        ),
        withKithTransaction(pool, (client) =>
          embeddings.commitEmbeddingFillPage(identityCtx(client), {
            spaceId: seeded.spaceId,
            fingerprint: seeded.fingerprint,
            vectors,
          }),
        ),
      ]);
      assert.equal(
        left.embedded + right.embedded,
        vectors.length,
        "between them the two commits embed each target exactly once",
      );
      assert.equal(left.skipped + right.skipped, vectors.length);

      await withKithTransaction(pool, async (client) => {
        const ctx = identityCtx(client);
        assert.equal(await vectorCount(ctx, seeded.spaceId), vectors.length);
        // One row per target under this fingerprint: I11, after a race.
        const perTarget = (
          await ctx.client.query(
            `SELECT count(*)::int AS rows FROM kith.embedding_vectors
              WHERE space_id = $1 AND embedding_fingerprint = $2
              GROUP BY target_kind, coalesce(thought_id, chunk_id, event_id)`,
            [seeded.spaceId, seeded.fingerprint],
          )
        ).rows.map((row) => row.rows);
        assert.deepEqual(new Set(perTarget), new Set([1]));
        // And the counters agree with the rows rather than double counting.
        assert.deepEqual(
          (
            await ctx.client.query(
              "SELECT covered_counts FROM kith.space_embedding_states WHERE space_id = $1",
              [seeded.spaceId],
            )
          ).rows[0].covered_counts,
          [
            {
              fingerprint: seeded.fingerprint,
              counts: { thought: 3, chunk: 2, card: 1 },
            },
          ],
        );
        const audit = await embeddings.auditEmbeddingCounters(ctx, {
          spaceId: seeded.spaceId,
          fingerprint: seeded.fingerprint,
        });
        assert.equal(audit.counterDrift, false);
        assert.equal(audit.duplicateTargets, 0);
        assert.deepEqual(audit.recountedCovered, audit.storedCovered);
      });
    } finally {
      await pool.end();
    }
  },
);
