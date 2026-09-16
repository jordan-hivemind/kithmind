// P2-39g2: the paged build, against a real PostgreSQL server.
//
// The scan, fill and audit phases with keyset cursors, the compare-and-set
// that makes a replayed page a no-op, the sweep that makes a rerun converge,
// and the audit's two named drift causes.
//
// The synthetic space is deliberately more than one page per kind at the page
// sizes these tests pass, because a build that fits in one page proves nothing
// about a cursor.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import * as embeddings from "../dist/embeddings/index.js";
import * as memory from "../dist/memory/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/memoryFixture.mjs";
import {
  SYNTHETIC_PROFILE,
  oneHot,
  seedActiveEmbeddingIndex,
  seedEmbeddingVector,
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

/**
 * Runs a job to `done`, one page at a time, honouring the cursor it returns.
 *
 * `now` is threaded through every page rather than left to default, because
 * the sweep stage retires anything whose `updated_at` predates the job's
 * `started_at`: in production those clocks advance between transactions, and
 * in one test transaction `ctx.now` does not, so a rerun started at a later
 * clock has to write its targets at that clock too.
 */
async function runToCompletion(ctx, jobId, batchSize, now) {
  let cursor = null;
  const pages = [];
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await embeddings.runEmbeddingBuildPage(ctx, {
      jobId,
      cursor,
      batchSize,
      ...(now === undefined ? {} : { now }),
    });
    assert.equal(page.accepted, true, "a page passed its own cursor is taken");
    pages.push(page);
    if (page.isDone) return pages;
    cursor = page.cursor;
  }
  throw new Error("the build did not finish inside its page guard");
}

async function counters(ctx, spaceId) {
  return (
    await ctx.client.query(
      `SELECT eligible_counts, covered_counts, counter_drift,
              counter_drift_reason, last_audit_at
         FROM kith.space_embedding_states WHERE space_id = $1`,
      [spaceId],
    )
  ).rows[0];
}

/** What a recount of the target rows says, independent of the counters. */
async function recount(ctx, spaceId, fingerprint) {
  const rows = (
    await ctx.client.query(
      `SELECT target_kind,
              count(*) FILTER (WHERE state = 'eligible')::int AS eligible,
              count(*) FILTER (WHERE state = 'eligible'
                                 AND covered_fingerprint = $2)::int AS covered
         FROM kith.embedding_targets WHERE space_id = $1 GROUP BY target_kind`,
      [spaceId, fingerprint],
    )
  ).rows;
  const eligible = { thought: 0, chunk: 0, card: 0 };
  const covered = { thought: 0, chunk: 0, card: 0 };
  for (const row of rows) {
    eligible[row.target_kind] = row.eligible;
    covered[row.target_kind] = row.covered;
  }
  return { eligible, covered };
}

/**
 * A space with five thoughts, one document of five chunks and one card, plus
 * an active index. Five per kind against a batch size of two is three pages
 * per scan stage, which is what exercises the cursor rather than the first
 * page of it.
 */
async function seedBuildableSpace(ctx, userId, options = {}) {
  const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
  const index = await seedActiveEmbeddingIndex(ctx, spaceId, {
    eligible: { thought: 0, chunk: 0, card: 0 },
  });
  const thoughtIds = [];
  for (let n = 0; n < 5; n += 1) {
    thoughtIds.push(
      await memory.captureThought(ctx, userId, spaceId, {
        content: `memory number ${n}`,
        metadata: metadata(`memory ${n}`),
      }),
    );
  }
  const chunkTexts = [0, 1, 2, 3, 4].map(
    (n) => `chunk number ${n} of the plan`,
  );
  const chain = await seedIndexableDocument(ctx, spaceId, {
    title: "The plan",
    chunks: chunkTexts,
    ...(options.itemOptedIn === undefined
      ? {}
      : { itemOptedIn: options.itemOptedIn }),
  });
  const card = await seedGenericCard(ctx, spaceId, chain, {
    fields: {
      card_kind: "note",
      card_title: "The plan",
      card_summary: "A plan with five chunks.",
    },
  });
  return { spaceId, index, thoughtIds, chain, card, chunkTexts };
}

test(
  "a paged build scans every kind across several pages and converges on a rerun",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const space = await seedBuildableSpace(ctx, userId);

      const started = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
      });
      assert.equal(started.reused, false);
      assert.equal(started.fingerprint, space.index.fingerprint);
      assert.equal(started.phase, "scan");
      assert.equal(started.cursor, null);
      // Every thought already has a target row: `captureThought` maintains
      // them. The build's job is to find the chunks and the card too.
      assert.equal(started.existingTargetRows, 5);

      // Rerunning the start is a no-op that hands back the job to resume.
      const again = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
      });
      assert.equal(again.reused, true);
      assert.equal(again.jobId, started.jobId);

      const pages = await runToCompletion(ctx, started.jobId, 2);
      const phases = [...new Set(pages.map((page) => page.phase))];
      assert.deepEqual(phases, ["scan", "fill", "audit", "done"]);
      assert.ok(
        pages.filter((page) => page.phase === "scan").length >= 6,
        "five rows per kind at two per page is several scan pages",
      );

      const targets = (
        await ctx.client.query(
          `SELECT target_kind, count(*)::int AS rows
             FROM kith.embedding_targets
            WHERE space_id = $1 AND state = 'eligible'
            GROUP BY target_kind ORDER BY target_kind`,
          [space.spaceId],
        )
      ).rows;
      assert.deepEqual(targets, [
        { target_kind: "card", rows: 1 },
        { target_kind: "chunk", rows: 5 },
        { target_kind: "thought", rows: 5 },
      ]);

      // The counters after a full build equal a recount of the rows.
      const stored = await counters(ctx, space.spaceId);
      const recounted = await recount(
        ctx,
        space.spaceId,
        space.index.fingerprint,
      );
      assert.deepEqual(stored.eligible_counts, recounted.eligible);
      assert.deepEqual(stored.eligible_counts, {
        thought: 5,
        chunk: 5,
        card: 1,
      });
      assert.equal(stored.counter_drift, false);
      assert.equal(stored.counter_drift_reason, null);
      assert.notEqual(stored.last_audit_at, null);

      // The historical buckets are counted by the thought stage, which is the
      // one place that visits every thought in the space exactly once.
      assert.deepEqual(
        (
          await ctx.client.query(
            "SELECT historical_thought_counts AS h FROM kith.space_embedding_states WHERE space_id = $1",
            [space.spaceId],
          )
        ).rows[0].h,
        { superseded: 0, retracted: 0 },
      );

      // A rerun converges: a chunk that left the live set is swept to retired
      // and a chunk that arrived is picked up, in one more build.
      await ctx.client.query(
        "UPDATE kith.chunks SET publication_state = 'superseded' WHERE id = $1",
        [space.chain.chunkIds[0]],
      );
      const rerun = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
        now: ctx.now + 1000,
      });
      assert.equal(
        rerun.reused,
        false,
        "the first job reached a terminal phase",
      );
      const rerunPages = await runToCompletion(
        ctx,
        rerun.jobId,
        2,
        ctx.now + 1000,
      );
      assert.ok(
        rerunPages.reduce((total, page) => total + page.retired, 0) >= 1,
        "the sweep retires what the scan no longer found",
      );
      const afterRerun = await recount(
        ctx,
        space.spaceId,
        space.index.fingerprint,
      );
      assert.deepEqual(afterRerun.eligible, { thought: 5, chunk: 4, card: 1 });
      assert.deepEqual(
        (await counters(ctx, space.spaceId)).eligible_counts,
        afterRerun.eligible,
        "the counters still equal a recount after a converging rerun",
      );
    });
  },
);

test(
  "a page whose cursor is not the stored one is refused, and a replay writes nothing",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const space = await seedBuildableSpace(ctx, userId);
      const started = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
      });

      const first = await embeddings.runEmbeddingBuildPage(ctx, {
        jobId: started.jobId,
        cursor: null,
        batchSize: 2,
      });
      assert.equal(first.accepted, true);
      assert.notEqual(first.cursor, null);

      // The cursor the first page was called with is now stale. Calling again
      // with it is refused, and the refusal hands back the stored cursor so
      // the caller can resume from the right place.
      const stale = await embeddings.runEmbeddingBuildPage(ctx, {
        jobId: started.jobId,
        cursor: null,
        batchSize: 2,
      });
      assert.equal(stale.accepted, false);
      assert.equal(stale.cursor, first.cursor);
      assert.equal(stale.pageIndex, first.pageIndex);
      assert.equal(stale.scanned, 0, "a refused page scans nothing");

      // A cursor nobody issued is refused the same way.
      const invented = await embeddings.runEmbeddingBuildPage(ctx, {
        jobId: started.jobId,
        cursor: JSON.stringify(["thoughts", ["2020-01-01 00:00:00+00", "zz"]]),
        batchSize: 2,
      });
      assert.equal(invented.accepted, false);
      assert.equal(invented.cursor, first.cursor);

      // Replaying the *current* cursor is accepted and idempotent: the upserts
      // recompute the same values, so no target row's content moves.
      const snapshot = async () =>
        (
          await ctx.client.query(
            `SELECT target_kind, target_id, input_hash, state, covered_fingerprint
               FROM kith.embedding_targets WHERE space_id = $1
              ORDER BY target_kind, target_id`,
            [space.spaceId],
          )
        ).rows;
      const before = await snapshot();
      const replay = await embeddings.runEmbeddingBuildPage(ctx, {
        jobId: started.jobId,
        cursor: first.cursor,
        batchSize: 2,
      });
      assert.equal(replay.accepted, true);
      const afterReplay = await snapshot();
      assert.deepEqual(
        afterReplay.filter((row) =>
          before.some((prior) => prior.target_id === row.target_id),
        ),
        before,
        "replaying a page changes no row it already wrote",
      );

      // A cursor that is not a cursor at all is a fault, not a fresh start.
      await assert.rejects(
        embeddings
          .runEmbeddingBuildPage(ctx, {
            jobId: started.jobId,
            cursor: replay.cursor,
            batchSize: 2,
          })
          .then(async (page) => {
            await ctx.client.query(
              "UPDATE kith.embedding_build_jobs SET cursor = $2 WHERE id = $1",
              [started.jobId, "not-json"],
            );
            return await embeddings.runEmbeddingBuildPage(ctx, {
              jobId: started.jobId,
              cursor: "not-json",
              batchSize: 2,
            });
          }),
        /Unexpected token|is malformed|JSON/,
      );
    });
  },
);

test(
  "the audit names a counter mismatch and a duplicate row, and a repair fixes only the counters",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const space = await seedBuildableSpace(ctx, userId);
      const started = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
      });
      await runToCompletion(ctx, started.jobId, 4);

      const clean = await embeddings.auditEmbeddingCounters(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
      });
      assert.equal(clean.complete, true);
      assert.equal(clean.counterDrift, false);
      assert.equal(clean.counterDriftReason, undefined);
      assert.deepEqual(clean.recountedEligible, clean.storedEligible);

      // Drift cause one: the counters disagree with the rows.
      await ctx.client.query(
        `UPDATE kith.space_embedding_states
            SET eligible_counts = '{"thought":99,"chunk":5,"card":1}'::jsonb
          WHERE space_id = $1`,
        [space.spaceId],
      );
      const mismatch = await embeddings.auditEmbeddingCounters(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
      });
      assert.equal(mismatch.counterDrift, true);
      assert.equal(mismatch.counterDriftReason, "counter_recount_mismatch");
      assert.deepEqual(mismatch.storedEligible.thought, 99);
      assert.deepEqual(mismatch.recountedEligible.thought, 5);
      assert.equal(
        mismatch.repaired,
        false,
        "an audit reports before it repairs",
      );
      assert.equal(
        (await counters(ctx, space.spaceId)).counter_drift,
        true,
        "the flag is recorded, not only returned",
      );

      // Drift cause two: one target holding two rows under one fingerprint.
      // The counters cannot see it -- both rows mark the target covered once.
      const coveredChunk = space.chain.chunkIds[0];
      const chunkHash = await sha256Utf8(space.chunkTexts[0]);
      await ctx.client.query(
        `UPDATE kith.embedding_targets SET covered_fingerprint = $1
          WHERE space_id = $2 AND target_kind = 'chunk' AND target_id = $3`,
        [space.index.fingerprint, space.spaceId, coveredChunk],
      );
      for (const axis of [1, 2]) {
        await seedEmbeddingVector(ctx, {
          spaceId: space.spaceId,
          embeddingGenerationId: space.index.generationId,
          fingerprint: space.index.fingerprint,
          targetKind: "chunk",
          chunkId: coveredChunk,
          processingGenerationId: space.chain.generationId,
          inputHash: chunkHash,
          vector: oneHot(axis),
        });
      }
      const duplicated = await embeddings.auditEmbeddingCounters(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
      });
      assert.equal(duplicated.duplicateTargets, 1);
      assert.equal(duplicated.counterDrift, true);
      assert.deepEqual(
        duplicated.counterDriftReason.split(",").sort(),
        ["counter_recount_mismatch", "duplicate_active_fingerprint_rows"],
        "both causes are named, not just the first",
      );
      assert.equal(duplicated.duplicateProbeComplete, true);

      // A repair fixes the counters and leaves the duplicate flag standing,
      // because a recount removes no row.
      const repaired = await embeddings.auditEmbeddingCounters(ctx, {
        spaceId: space.spaceId,
        fingerprint: space.index.fingerprint,
        repair: true,
      });
      assert.equal(repaired.repaired, true);
      const afterRepair = await counters(ctx, space.spaceId);
      assert.deepEqual(afterRepair.eligible_counts, {
        thought: 5,
        chunk: 5,
        card: 1,
      });
      assert.equal(afterRepair.counter_drift, true);
      assert.equal(
        afterRepair.counter_drift_reason,
        "duplicate_active_fingerprint_rows",
        "a repaired counter stops being a drift cause; the duplicate does not",
      );
    });
  },
);

test(
  "a build under a fingerprint that is not active fails its generation when abandoned",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const fingerprint =
        await embeddings.fingerprintEmbeddingConfig(SYNTHETIC_PROFILE);
      await memory.captureThought(ctx, userId, spaceId, {
        content: "a memory to index",
        metadata: metadata("one"),
      });
      const generation = await embeddings.createEmbeddingGeneration(ctx, {
        spaceId,
        profile: SYNTHETIC_PROFILE,
        fingerprint,
      });
      const started = await embeddings.startEmbeddingBuild(ctx, {
        spaceId,
        fingerprint,
      });
      // The job belongs to no generation: the space has no active pointer yet,
      // so nothing links them and abandoning fails no generation.
      assert.equal(
        (await embeddings.getEmbeddingBuildJob(ctx, started.jobId))
          .embedding_generation_id,
        null,
      );
      await ctx.client.query(
        "UPDATE kith.embedding_build_jobs SET embedding_generation_id = $2 WHERE id = $1",
        [started.jobId, generation.id],
      );

      const abandoned = await embeddings.abandonEmbeddingBuild(ctx, {
        jobId: started.jobId,
        code: "provider_down",
        message: "the provider stopped answering",
      });
      assert.equal(abandoned.phase, "abandoned");
      assert.equal(abandoned.generationFailed, true);
      assert.equal(
        (await embeddings.getEmbeddingGeneration(ctx, generation.id)).state,
        "failed",
      );
      // An abandoned job keeps no cursor and takes no further page.
      const job = await embeddings.getEmbeddingBuildJob(ctx, started.jobId);
      assert.equal(job.cursor, null);
      const page = await embeddings.runEmbeddingBuildPage(ctx, {
        jobId: started.jobId,
        cursor: null,
      });
      assert.equal(page.isDone, true);
      assert.equal(page.phase, "abandoned");

      // Abandoning twice is a no-op, not a second failure.
      const twice = await embeddings.abandonEmbeddingBuild(ctx, {
        jobId: started.jobId,
        code: "provider_down",
        message: "again",
      });
      assert.equal(twice.generationFailed, false);
    });
  },
);

test(
  "the chunk scan honours the space's target policy and the per-item opt-in",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const space = await seedBuildableSpace(ctx, userId);

      // Under `all_chunks`, which is what an absent policy means, every active
      // chunk is a target.
      const first = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
      });
      await runToCompletion(ctx, first.jobId, 8);
      assert.equal(
        (await recount(ctx, space.spaceId, space.index.fingerprint)).eligible
          .chunk,
        5,
      );

      // Flipping the space to the card policy makes the un-opted-in chunks
      // ineligible. The scan stops upserting them and the sweep retires them,
      // which is one rerun of the same build rather than a separate migration.
      await ctx.client.query(
        `UPDATE kith.space_embedding_states
            SET target_policy = 'cards_and_opted_in_chunks' WHERE space_id = $1`,
        [space.spaceId],
      );
      const second = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
        now: ctx.now + 1000,
      });
      await runToCompletion(ctx, second.jobId, 8, ctx.now + 1000);
      const afterFlip = await recount(
        ctx,
        space.spaceId,
        space.index.fingerprint,
      );
      assert.deepEqual(afterFlip.eligible, { thought: 5, chunk: 0, card: 1 });
      assert.deepEqual(
        (await counters(ctx, space.spaceId)).eligible_counts,
        afterFlip.eligible,
      );

      // The opt-in brings that item's chunks back, without changing the space.
      await ctx.client.query(
        "UPDATE kith.source_items SET embed_full_chunks = true WHERE id = $1",
        [space.chain.sourceItemId],
      );
      const third = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
        now: ctx.now + 2000,
      });
      await runToCompletion(ctx, third.jobId, 8, ctx.now + 2000);
      assert.deepEqual(
        (await recount(ctx, space.spaceId, space.index.fingerprint)).eligible,
        { thought: 5, chunk: 5, card: 1 },
      );
    });
  },
);

test(
  "the fill phase marks covered exactly the targets that already hold a matching vector",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const space = await seedBuildableSpace(ctx, userId);

      // Two thought vectors written before the build, one of which no longer
      // matches its thought's text. The fill covers the first and not the
      // second, and the second stays owed.
      const matching = space.thoughtIds[0];
      const moved = space.thoughtIds[1];
      await seedEmbeddingVector(ctx, {
        spaceId: space.spaceId,
        embeddingGenerationId: space.index.generationId,
        fingerprint: space.index.fingerprint,
        targetKind: "thought",
        thoughtId: matching,
        inputHash: await sha256Utf8("memory number 0"),
        vector: oneHot(1),
      });
      await seedEmbeddingVector(ctx, {
        spaceId: space.spaceId,
        embeddingGenerationId: space.index.generationId,
        fingerprint: space.index.fingerprint,
        targetKind: "thought",
        thoughtId: moved,
        inputHash: await sha256Utf8("something else entirely"),
        vector: oneHot(2),
      });

      const started = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
      });
      const pages = await runToCompletion(ctx, started.jobId, 4);
      assert.equal(
        pages.reduce((total, page) => total + page.filled, 0),
        1,
        "one target held a vector whose hash matched its live text",
      );

      const covered = (
        await ctx.client.query(
          `SELECT target_id FROM kith.embedding_targets
            WHERE space_id = $1 AND covered_fingerprint = $2
            ORDER BY target_id`,
          [space.spaceId, space.index.fingerprint],
        )
      ).rows.map((row) => row.target_id);
      assert.deepEqual(covered, [matching]);

      const owed = await embeddings.owedTargetsPage(ctx, space.spaceId, 32);
      assert.equal(
        owed.some((row) => row.target_id === moved),
        true,
        "a target whose vector does not match its text is still owed",
      );
      assert.deepEqual((await counters(ctx, space.spaceId)).covered_counts, [
        {
          fingerprint: space.index.fingerprint,
          counts: { thought: 1, chunk: 0, card: 0 },
        },
      ]);

      // A marker naming a fingerprint this build is not filling is cleared,
      // which is what puts the row back on the owed index.
      const foreignFingerprint = "b".repeat(64);
      await ctx.client.query(
        `UPDATE kith.embedding_targets SET covered_fingerprint = $1
          WHERE space_id = $2 AND target_id = $3`,
        [foreignFingerprint, space.spaceId, space.thoughtIds[2]],
      );
      // The counter goes with the marker. A marker with no counter behind it
      // is a state I4 does not produce -- a marker is only ever set in the
      // transaction that inserted the vector, which also counts it -- and
      // clearing one would drive the counter below zero, which the commit
      // refuses rather than absorbs.
      await ctx.client.query(
        `UPDATE kith.space_embedding_states
            SET covered_counts = covered_counts || $2::jsonb WHERE space_id = $1`,
        [
          space.spaceId,
          JSON.stringify([
            {
              fingerprint: foreignFingerprint,
              counts: { thought: 1, chunk: 0, card: 0 },
            },
          ]),
        ],
      );
      const rerun = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: space.spaceId,
        now: ctx.now + 1000,
      });
      await runToCompletion(ctx, rerun.jobId, 4, ctx.now + 1000);
      assert.equal(
        (
          await ctx.client.query(
            `SELECT covered_fingerprint FROM kith.embedding_targets
              WHERE space_id = $1 AND target_id = $2`,
            [space.spaceId, space.thoughtIds[2]],
          )
        ).rows[0].covered_fingerprint,
        null,
      );
    });
  },
);

test(
  "a build needs a fingerprint, and a space with no active one must be given it",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      await assert.rejects(
        embeddings.startEmbeddingBuild(ctx, { spaceId }),
        /no active embedding fingerprint/,
      );
      const fingerprint = "c".repeat(64);
      const dry = await embeddings.startEmbeddingBuild(ctx, {
        spaceId,
        fingerprint,
        dryRun: true,
      });
      assert.equal(dry.dryRun, true);
      assert.equal(dry.jobId, undefined);
      assert.equal(
        (
          await ctx.client.query(
            "SELECT count(*)::int AS rows FROM kith.embedding_build_jobs WHERE space_id = $1",
            [spaceId],
          )
        ).rows[0].rows,
        0,
        "a dry run writes no job row",
      );

      // The scan seeds the counters at zero, which is what marks an empty
      // space as counted rather than leaving it failing closed forever.
      const started = await embeddings.startEmbeddingBuild(ctx, {
        spaceId,
        fingerprint,
      });
      await runToCompletion(ctx, started.jobId, 8);
      const stored = await counters(ctx, spaceId);
      assert.deepEqual(stored.eligible_counts, {
        thought: 0,
        chunk: 0,
        card: 0,
      });
      assert.notEqual(stored.last_audit_at, null);
      assert.equal(stored.counter_drift, false);
    });
  },
);

test(
  "two spaces build independently and neither one's scan reaches the other",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const mine = await seedBuildableSpace(ctx, userId);
      const theirs = await seedBuildableSpace(ctx, userId);
      // One more thought in the other space, so an assertion about the wrong
      // one would read a different number rather than the same one twice.
      await memory.captureThought(ctx, userId, theirs.spaceId, {
        content: "a sixth memory, only over there",
        metadata: metadata("sixth"),
      });

      const started = await embeddings.startEmbeddingBuild(ctx, {
        spaceId: mine.spaceId,
      });
      await runToCompletion(ctx, started.jobId, 4);

      assert.deepEqual(
        (await recount(ctx, mine.spaceId, mine.index.fingerprint)).eligible,
        { thought: 5, chunk: 5, card: 1 },
      );
      // The other space has its capture-made thought targets and nothing the
      // first space's build put there.
      assert.deepEqual(
        (await recount(ctx, theirs.spaceId, theirs.index.fingerprint)).eligible,
        { thought: 6, chunk: 0, card: 0 },
      );
      assert.equal(
        (
          await ctx.client.query(
            `SELECT count(*)::int AS rows FROM kith.embedding_targets
              WHERE space_id = $1 AND target_kind <> 'thought'`,
            [theirs.spaceId],
          )
        ).rows[0].rows,
        0,
      );
    });
  },
);

test(
  "a job row is scoped to its space, and an unknown job is a fault",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      await assert.rejects(
        embeddings.runEmbeddingBuildPage(ctx, {
          jobId: newKithId(),
          cursor: null,
        }),
        /Embedding build job not found/,
      );
    });
  },
);

// P2-39j follow-up: `runFillPage` only matches an eligible target to a vector
// that already exists under the build's fingerprint; it never calls a
// provider. A target it cannot match stays eligible and uncovered on purpose,
// "so the provider fill can find it" -- which means something has to queue
// that fill once the build is done, or the target sits owed until an
// unrelated write in the same space happens to schedule one.

test(
  "a build that completes with uncovered targets schedules a fill for the space",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      await seedActiveEmbeddingIndex(ctx, spaceId, {
        eligible: { thought: 0, chunk: 0, card: 0 },
      });
      // No thoughts, and no vector in `kith.embedding_vectors`: the scan
      // discovers the chunk fresh and the fill phase has nothing to match it
      // to, exactly the shape a first backfill of a document-heavy space has.
      await seedIndexableDocument(ctx, spaceId, {
        title: "Uncovered",
        chunks: ["a chunk nothing has embedded yet"],
      });

      const started = await embeddings.startEmbeddingBuild(ctx, { spaceId });
      await runToCompletion(ctx, started.jobId, 4);

      const jobs = (
        await ctx.client.query(
          `SELECT dedupe_key, space_id, payload, state FROM kith.deferred_work
            WHERE kind = 'embedding_fill' AND space_id = $1`,
          [spaceId],
        )
      ).rows;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].dedupe_key, `embedding_fill:${spaceId}`);
      assert.deepEqual(jobs[0].payload, { spaceId });
      assert.equal(jobs[0].state, "queued");
    });
  },
);

test(
  "a build that fully covers its targets schedules no fill",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const index = await seedActiveEmbeddingIndex(ctx, spaceId, {
        eligible: { thought: 0, chunk: 0, card: 0 },
      });
      const text = "a chunk that is already embedded";
      const chain = await seedIndexableDocument(ctx, spaceId, {
        title: "Covered",
        chunks: [text],
      });
      // A vector already under the active fingerprint, matching the chunk's
      // live text hash: what a fresh PostgreSQL space's imported vectors look
      // like before the build reconciles the target table against them.
      await seedEmbeddingVector(ctx, {
        spaceId,
        embeddingGenerationId: index.generationId,
        fingerprint: index.fingerprint,
        targetKind: "chunk",
        chunkId: chain.chunkIds[0],
        processingGenerationId: chain.generationId,
        inputHash: await sha256Utf8(text),
        vector: oneHot(1),
      });

      const started = await embeddings.startEmbeddingBuild(ctx, { spaceId });
      await runToCompletion(ctx, started.jobId, 4);

      assert.deepEqual(await recount(ctx, spaceId, index.fingerprint), {
        eligible: { thought: 0, chunk: 1, card: 0 },
        covered: { thought: 0, chunk: 1, card: 0 },
      });

      const jobs = (
        await ctx.client.query(
          `SELECT id FROM kith.deferred_work
            WHERE kind = 'embedding_fill' AND space_id = $1`,
          [spaceId],
        )
      ).rows;
      assert.deepEqual(jobs, []);
    });
  },
);
