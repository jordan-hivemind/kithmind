// P2-39m1: cutover step 8, against a real PostgreSQL server.
//
// The state this repairs is what `kith-migrate` leaves behind: section 5.2 of
// the consolidation plan does not migrate vectors, but it does migrate
// `covered_fingerprint`, so a target claims coverage under the active
// fingerprint with no vector row behind it. It is not owed, so the provider
// fill never touches it and the vector leg never finds it.
//
// The seed says exactly that, one covered target with a real vector beside two
// covered targets without one, and the counters recounted so the space starts
// consistent and undrifted -- a migrated space is not a drifted space, which is
// why an audit alone cannot find this.

import assert from "node:assert/strict";
import test from "node:test";

import { argumentsFor } from "../dist/embeddings/cli.js";
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
  recountEmbeddingCounters,
  seedActiveEmbeddingIndex,
} from "./helpers/embeddingFixture.mjs";

const metadata = (summary) => ({
  type: "reference",
  topics: ["synthetic"],
  people: [],
  actionItems: [],
  summary,
});

async function counters(ctx, spaceId) {
  const state = (
    await ctx.client.query(
      `SELECT eligible_counts, covered_counts, counter_drift
         FROM kith.space_embedding_states WHERE space_id = $1`,
      [spaceId],
    )
  ).rows[0];
  return state;
}

/**
 * Empties the space's queue. Capture already queues a fill of its own, and
 * `schedule` dedupes per space, so counting rows only says what this step did
 * once the queue starts empty -- which after a drained cutover it is.
 */
async function clearQueue(ctx, spaceId) {
  await ctx.client.query("DELETE FROM kith.deferred_work WHERE space_id = $1", [
    spaceId,
  ]);
}

async function queuedFills(ctx, spaceId) {
  return (
    await ctx.client.query(
      `SELECT count(*)::int AS rows FROM kith.deferred_work
        WHERE space_id = $1 AND kind = 'embedding_fill'`,
      [spaceId],
    )
  ).rows[0].rows;
}

/**
 * Three thoughts on a counted space. The first is covered by a real vector;
 * the other two carry a migrated marker and no vector at all.
 */
async function seedMigratedSpace(ctx, userId) {
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
  await embeddings.insertThoughtEmbedding(ctx, {
    spaceId,
    thoughtId: thoughtIds[0],
    embeddingGenerationId: index.generationId,
    fingerprint: index.fingerprint,
    inputText: "alpha memory",
    vector: oneHot(1),
  });
  await ctx.client.query(
    `UPDATE kith.embedding_targets SET covered_fingerprint = $1
      WHERE space_id = $2 AND target_id = ANY($3::text[])`,
    [index.fingerprint, spaceId, [thoughtIds[1], thoughtIds[2]]],
  );
  // A migrated space is consistent with its own target rows and carries no
  // drift flag. That is what makes this failure invisible to the audit.
  await recountEmbeddingCounters(ctx, spaceId, index.fingerprint);
  await clearQueue(ctx, spaceId);
  return { spaceId, index, thoughtIds };
}

test(
  "the re-embed step owes back exactly the covered targets with no vector",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const space = await seedMigratedSpace(ctx, userId);

      const seeded = await counters(ctx, space.spaceId);
      assert.deepEqual(seeded.eligible_counts, {
        thought: 3,
        chunk: 0,
        card: 0,
      });
      assert.equal(seeded.counter_drift, false);
      assert.equal(
        (await embeddings.owedTargetsPage(ctx, space.spaceId)).length,
        0,
        "the fill considers this space done, which is the bug",
      );

      // The dry run counts and writes nothing.
      const dry = await embeddings.recoverEmbeddingCoverage(ctx, {
        spaceId: space.spaceId,
      });
      assert.deepEqual(dry, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
        vectorless: 2,
        invalidated: 0,
        complete: true,
        scheduled: false,
      });
      assert.deepEqual(await counters(ctx, space.spaceId), seeded);
      assert.equal(await queuedFills(ctx, space.spaceId), 0);

      const applied = await embeddings.recoverEmbeddingCoverage(ctx, {
        spaceId: space.spaceId,
        apply: true,
      });
      assert.deepEqual(applied, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
        vectorless: 2,
        invalidated: 2,
        complete: true,
        scheduled: true,
      });
      const owed = await embeddings.owedTargetsPage(ctx, space.spaceId);
      assert.deepEqual(
        owed.map((record) => record.target_id).sort(),
        [space.thoughtIds[1], space.thoughtIds[2]].sort(),
        "the target with a real vector is left alone",
      );
      assert.equal(await queuedFills(ctx, space.spaceId), 1);

      // The counters lost exactly the two targets, and a recount agrees, so
      // nothing here is drift.
      const afterApply = await counters(ctx, space.spaceId);
      assert.deepEqual(afterApply.covered_counts, [
        {
          fingerprint: space.index.fingerprint,
          counts: { thought: 1, chunk: 0, card: 0 },
        },
      ]);
      assert.deepEqual(afterApply.eligible_counts, {
        thought: 3,
        chunk: 0,
        card: 0,
      });
      const audit = await embeddings.auditEmbeddingCounters(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
      });
      assert.equal(audit.counterDrift, false);
      assert.deepEqual(audit.recountedCovered, audit.storedCovered);
      assert.deepEqual(audit.recountedEligible, audit.storedEligible);

      // The fill the step queued then covers them for real.
      const embed = recordingEmbedder(space.index.fingerprint);
      const page = await embeddings.nextEmbeddingFillPage(ctx, space.spaceId);
      const results = await embed(page.targets.map((one) => one.inputText));
      const committed = await embeddings.commitEmbeddingFillPage(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
        vectors: page.targets.map((target, at) => ({
          targetKind: target.targetKind,
          targetId: target.targetId,
          inputHash: target.inputHash,
          vector: results[at].vector,
        })),
      });
      assert.equal(committed.embedded, 2);
      assert.equal(committed.remaining, false);
      assert.deepEqual(embed.texts().sort(), ["beta memory", "gamma memory"]);
      const filled = await counters(ctx, space.spaceId);
      assert.deepEqual(filled.covered_counts, [
        {
          fingerprint: space.index.fingerprint,
          counts: { thought: 3, chunk: 0, card: 0 },
        },
      ]);
      assert.equal(
        (
          await ctx.client.query(
            "SELECT count(*)::int AS rows FROM kith.embedding_vectors WHERE space_id = $1",
            [space.spaceId],
          )
        ).rows[0].rows,
        3,
      );

      // And a second run on the now-healthy space is a no-op.
      await clearQueue(ctx, space.spaceId);
      const again = await embeddings.recoverEmbeddingCoverage(ctx, {
        spaceId: space.spaceId,
        apply: true,
      });
      assert.deepEqual(again, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
        vectorless: 0,
        invalidated: 0,
        complete: true,
        scheduled: false,
      });
      assert.deepEqual(await counters(ctx, space.spaceId), filled);
      assert.equal(await queuedFills(ctx, space.spaceId), 0);
    });
  },
);

test(
  "a space with no active index or no seeded counters is left alone",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const bareSpaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      assert.deepEqual(
        await embeddings.recoverEmbeddingCoverage(ctx, {
          spaceId: bareSpaceId,
          apply: true,
        }),
        {
          spaceId: bareSpaceId,
          fingerprint: null,
          vectorless: 0,
          invalidated: 0,
          complete: true,
          scheduled: false,
        },
      );
      assert.equal(await queuedFills(ctx, bareSpaceId), 0);
    });
  },
);

// `kith-reembed`'s parser needs no database, so it runs in every clone. The
// default is the dry run: a step run against a live deployment should have to
// be asked twice before it writes.
test("kith-reembed defaults to a dry run over every space", () => {
  assert.deepEqual(argumentsFor([]), { spaceId: null, apply: false });
  assert.deepEqual(argumentsFor(["--apply"]), { spaceId: null, apply: true });
  const spaceId = "s".repeat(26);
  assert.deepEqual(argumentsFor(["--space", spaceId, "--apply"]), {
    spaceId,
    apply: true,
  });
});
