// P2-39g2: the embedding index's write side, generation lifecycle half.
//
// Profiles, generations, activation, the eligibility a memory write leaves
// behind, and the space isolation the chunk and card retrieval leg owes. Same
// fixtures and conventions as embeddingSearch.test.mjs (P2-39g1), against a
// real PostgreSQL server with pgvector.
//
// Every assertion here is about a row the write side leaves, or about a row
// the read side refuses to return. Nothing claims a ranking.

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
  mix,
  oneHot,
  recountEmbeddingCounters,
  seedActiveEmbeddingIndex,
  seedEmbeddingTarget,
  seedEmbeddingVector,
  seedGenericCard,
  seedIndexableDocument,
  sha256Utf8,
} from "./helpers/embeddingFixture.mjs";

const metadata = (summary, type = "reference") => ({
  type,
  topics: ["synthetic"],
  people: [],
  actionItems: [],
  summary,
});

/** A profile that is not the synthetic one, for the second fingerprint. */
const SECOND_PROFILE = Object.freeze({
  ...SYNTHETIC_PROFILE,
  modelRevision: "synthetic-rev-2",
});

const refusal = async (work) => {
  try {
    await work();
    return null;
  } catch (error) {
    return error.message;
  }
};

async function targetRows(ctx, spaceId) {
  return (
    await ctx.client.query(
      `SELECT target_kind, target_id, state, covered_fingerprint, input_hash
         FROM kith.embedding_targets WHERE space_id = $1
        ORDER BY target_kind, target_id`,
      [spaceId],
    )
  ).rows;
}

async function stateRow(ctx, spaceId) {
  return (
    await ctx.client.query(
      `SELECT eligibility_epoch::int AS eligibility_epoch, eligible_counts,
              covered_counts, active_embedding_generation_id, active_fingerprint,
              historical_thought_counts
         FROM kith.space_embedding_states WHERE space_id = $1`,
      [spaceId],
    )
  ).rows[0];
}

test(
  "migration 016 installs the write-side identities, the owed index and the phase checks",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);

    const indexes = await db.client.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'kith' AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [
        [
          "embedding_build_jobs_space_fingerprint_idx",
          "embedding_generations_space_state_idx",
          "embedding_profiles_fingerprint_key",
          "embedding_targets_owed_idx",
          "embedding_targets_space_kind_target_idx",
          "space_embedding_states_space_idx",
          "thoughts_space_created_idx",
        ],
      ],
    );
    assert.equal(indexes.rows.length, 7, "every P2-39g2 index exists");
    const byName = new Map(
      indexes.rows.map((row) => [row.indexname, row.indexdef]),
    );
    // The three identities the write side upserts on have to be unique, not
    // merely indexed: 015 created two of them non-unique for the reader.
    for (const name of [
      "embedding_profiles_fingerprint_key",
      "embedding_targets_space_kind_target_idx",
      "space_embedding_states_space_idx",
    ]) {
      assert.match(byName.get(name), /CREATE UNIQUE INDEX/, name);
    }
    // The owed set is a partial index, which is what makes the fill's page an
    // index range rather than a scan of the space's targets.
    assert.match(
      byName.get("embedding_targets_owed_idx"),
      /WHERE \(\(state = 'eligible'::text\) AND \(covered_fingerprint IS NULL\)\)/,
    );

    const checks = await db.client.query(
      `SELECT conname FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'kith' AND c.contype = 'c'
          AND c.conname = ANY($1::text[]) ORDER BY conname`,
      [
        [
          "embedding_build_jobs_phase_check",
          "embedding_generations_state_check",
          "embedding_targets_retired_coverage_check",
          "embedding_targets_state_check",
          "space_embedding_states_target_policy_check",
        ],
      ],
    );
    assert.equal(checks.rows.length, 5, "every P2-39g2 state check exists");

    // The six generation states, named. A seventh is not a state.
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const profileId = newKithId();
      const fingerprint = "d".repeat(64);
      await ctx.client.query(
        `INSERT INTO kith.embedding_profiles (id, created_at, fingerprint)
         VALUES ($1, transaction_timestamp(), $2)`,
        [profileId, fingerprint],
      );
      for (const state of [
        "staging",
        "staged",
        "active",
        "failed",
        "retired",
        "retired_cleaned",
      ]) {
        await ctx.client.query(
          `INSERT INTO kith.embedding_generations
             (id, space_id, created_at, embedding_profile_id, fingerprint, state)
           VALUES ($1, $2, transaction_timestamp(), $3, $4, $5)`,
          [newKithId(), spaceId, profileId, fingerprint, state],
        );
      }
      // A savepoint, because a refused statement aborts the transaction the
      // rest of this block still has to use.
      await ctx.client.query("SAVEPOINT bad_state");
      await assert.rejects(
        ctx.client.query(
          `INSERT INTO kith.embedding_generations
             (id, space_id, created_at, embedding_profile_id, fingerprint, state)
           VALUES ($1, $2, transaction_timestamp(), $3, $4, 'half_built')`,
          [newKithId(), spaceId, profileId, fingerprint],
        ),
        /embedding_generations_state_check/,
      );
      await ctx.client.query("ROLLBACK TO SAVEPOINT bad_state");

      // A terminal build job holds no cursor: nothing may resume it.
      await ctx.client.query("SAVEPOINT bad_cursor");
      await assert.rejects(
        ctx.client.query(
          `INSERT INTO kith.embedding_build_jobs
             (id, space_id, created_at, fingerprint, phase, cursor)
           VALUES ($1, $2, transaction_timestamp(), $3, 'done', 'resume-me')`,
          [newKithId(), spaceId, fingerprint],
        ),
        /embedding_build_jobs_terminal_cursor_check/,
      );
      await ctx.client.query("ROLLBACK TO SAVEPOINT bad_cursor");

      // A retired target covers nothing: I4, as a constraint.
      await ctx.client.query("SAVEPOINT bad_coverage");
      await assert.rejects(
        ctx.client.query(
          `INSERT INTO kith.embedding_targets
             (id, space_id, created_at, target_kind, target_id, input_hash,
              state, covered_fingerprint, updated_at)
           VALUES ($1, $2, transaction_timestamp(), 'thought', 'x', $3,
                   'retired', $3, transaction_timestamp())`,
          [newKithId(), spaceId, fingerprint],
        ),
        /embedding_targets_retired_coverage_check/,
      );
      await ctx.client.query("ROLLBACK TO SAVEPOINT bad_coverage");
    });
  },
);

test(
  "ensuring a profile is idempotent, and a fingerprint names exactly one row",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const fingerprint =
        await embeddings.fingerprintEmbeddingConfig(SYNTHETIC_PROFILE);
      const first = await embeddings.ensureEmbeddingProfile(ctx, {
        profile: SYNTHETIC_PROFILE,
        fingerprint,
      });
      const second = await embeddings.ensureEmbeddingProfile(ctx, {
        profile: SYNTHETIC_PROFILE,
        fingerprint,
      });
      assert.equal(second.id, first.id, "the same profile is the same row");

      // A fingerprint that is not the profile's own is refused before any row
      // is read: the fingerprint is the profile's identity, not a label on it.
      assert.match(
        await refusal(() =>
          embeddings.ensureEmbeddingProfile(ctx, {
            profile: SYNTHETIC_PROFILE,
            fingerprint: "e".repeat(64),
          }),
        ),
        /fingerprint does not match its identity/,
      );

      // A row filed under this fingerprint whose fields are someone else's is
      // a collision or damage, never a value to return.
      await ctx.client.query(
        "UPDATE kith.embedding_profiles SET model = $1 WHERE id = $2",
        ["tampered", first.id],
      );
      assert.match(
        await refusal(() =>
          embeddings.ensureEmbeddingProfile(ctx, {
            profile: SYNTHETIC_PROFILE,
            fingerprint,
          }),
        ),
        /fingerprint collision or damaged row/,
      );
      await ctx.client.query(
        "UPDATE kith.embedding_profiles SET model = $1 WHERE id = $2",
        [SYNTHETIC_PROFILE.model, first.id],
      );

      // A second row under one fingerprint is unrepresentable.
      await assert.rejects(
        ctx.client.query(
          `INSERT INTO kith.embedding_profiles
             (id, created_at, fingerprint, protocol, provider_id, model,
              model_revision, dimensions, normalization, preprocessing)
           VALUES ($1, transaction_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            newKithId(),
            fingerprint,
            SYNTHETIC_PROFILE.protocol,
            SYNTHETIC_PROFILE.providerId,
            SYNTHETIC_PROFILE.model,
            SYNTHETIC_PROFILE.modelRevision,
            SYNTHETIC_PROFILE.dimensions,
            SYNTHETIC_PROFILE.normalization,
            SYNTHETIC_PROFILE.preprocessing,
          ],
        ),
        /embedding_profiles_fingerprint_key/,
      );
    });
  },
);

test(
  "a generation is created, filled, staged and activated, and a second activation retires the first",
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

      const thoughtId = await memory.captureThought(ctx, userId, spaceId, {
        content: "the first memory",
        metadata: metadata("first"),
      });

      const generation = await embeddings.createEmbeddingGeneration(ctx, {
        spaceId,
        profile: SYNTHETIC_PROFILE,
        fingerprint,
      });
      assert.equal(generation.state, "staging");
      assert.equal(Number(generation.expected_thought_count), 1);
      assert.equal(Number(generation.expected_chunk_count), 0);

      // A space may hold one unfinished generation at a time.
      const secondFingerprint =
        await embeddings.fingerprintEmbeddingConfig(SECOND_PROFILE);
      assert.match(
        await refusal(() =>
          embeddings.createEmbeddingGeneration(ctx, {
            spaceId,
            profile: SECOND_PROFILE,
            fingerprint: secondFingerprint,
          }),
        ),
        /already has a staging embedding generation/,
      );

      // A batch whose fingerprint is not the generation's is refused: the
      // fingerprint is what binds a vector to the profile that made it.
      assert.match(
        await refusal(() =>
          embeddings.stageEmbeddingVectorBatch(ctx, {
            embeddingGenerationId: generation.id,
            fingerprint: "f".repeat(64),
            vectors: [{ targetKind: "thought", thoughtId, vector: oneHot(0) }],
          }),
        ),
        /batch fingerprint does not match/,
      );

      await embeddings.stageEmbeddingVectorBatch(ctx, {
        embeddingGenerationId: generation.id,
        fingerprint,
        vectors: [{ targetKind: "thought", thoughtId, vector: oneHot(0) }],
      });
      await embeddings.stageEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation.id,
        stagedAt: ctx.now + 1,
      });
      assert.equal(
        (await embeddings.getEmbeddingGeneration(ctx, generation.id)).state,
        "staged",
      );

      // Activation is compare-and-set: this space has no active generation, so
      // naming one is a refusal rather than a no-op.
      assert.match(
        await refusal(() =>
          embeddings.activateEmbeddingGeneration(ctx, {
            embeddingGenerationId: generation.id,
            expectedPreviousGenerationId: newKithId(),
            activatedAt: ctx.now + 2,
          }),
        ),
        /Active embedding generation changed before activation/,
      );

      await embeddings.activateEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation.id,
        activatedAt: ctx.now + 2,
      });

      const active = await embeddings.getActiveEmbeddingTarget(ctx, spaceId);
      assert.equal(active.embeddingGenerationId, generation.id);
      assert.equal(active.fingerprint, fingerprint);
      // Activation seeds the targets and the counters from the manifest it
      // just validated, so the space is counted and complete immediately.
      assert.equal(active.thoughtStatus, "ready");
      assert.deepEqual(await targetRows(ctx, spaceId), [
        {
          target_kind: "thought",
          target_id: thoughtId,
          state: "eligible",
          covered_fingerprint: fingerprint,
          input_hash: await sha256Utf8("the first memory"),
        },
      ]);

      // The second generation: a new fingerprint, staged alongside the live
      // index and invisible to a reader for its whole lifetime.
      const second = await embeddings.createEmbeddingGeneration(ctx, {
        spaceId,
        profile: SECOND_PROFILE,
        fingerprint: secondFingerprint,
      });
      await embeddings.stageEmbeddingVectorBatch(ctx, {
        embeddingGenerationId: second.id,
        fingerprint: secondFingerprint,
        vectors: [{ targetKind: "thought", thoughtId, vector: mix(0, 1) }],
      });
      assert.equal(
        (await embeddings.getActiveEmbeddingTarget(ctx, spaceId)).fingerprint,
        fingerprint,
        "a staged generation never moves the reader's fingerprint",
      );

      await embeddings.stageEmbeddingGeneration(ctx, {
        embeddingGenerationId: second.id,
        stagedAt: ctx.now + 3,
      });
      await embeddings.activateEmbeddingGeneration(ctx, {
        embeddingGenerationId: second.id,
        expectedPreviousGenerationId: generation.id,
        activatedAt: ctx.now + 4,
      });

      const generations = (
        await ctx.client.query(
          `SELECT id, state, deactivated_at FROM kith.embedding_generations
            WHERE space_id = $1 ORDER BY created_at, id`,
          [spaceId],
        )
      ).rows;
      const retired = generations.find((row) => row.id === generation.id);
      assert.equal(retired.state, "retired");
      assert.notEqual(retired.deactivated_at, null);
      assert.equal(
        generations.filter((row) => row.state === "active").length,
        1,
        "exactly one generation is active",
      );

      const afterFlip = await embeddings.getActiveEmbeddingTarget(ctx, spaceId);
      assert.equal(afterFlip.embeddingGenerationId, second.id);
      assert.equal(afterFlip.fingerprint, secondFingerprint);
      // Both fingerprints' rows survive: the retired one is the rollback
      // artifact, and the reader names only the active one.
      assert.deepEqual(
        (
          await ctx.client.query(
            `SELECT embedding_fingerprint, count(*)::int AS rows
               FROM kith.embedding_vectors WHERE space_id = $1
              GROUP BY embedding_fingerprint ORDER BY embedding_fingerprint`,
            [spaceId],
          )
        ).rows.map((row) => row.rows),
        [1, 1],
      );

      // Staging a third generation under the fingerprint that is now active is
      // refused: the incremental fill owns that index.
      assert.match(
        await refusal(() =>
          embeddings.createEmbeddingGeneration(ctx, {
            spaceId,
            profile: SECOND_PROFILE,
            fingerprint: secondFingerprint,
          }),
        ),
        /Staging a generation under the active fingerprint is retired/,
      );
    });
  },
);

test(
  "a stale manifest refuses to stage, and a failed generation keeps its evidence",
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
      const thoughtId = await memory.captureThought(ctx, userId, spaceId, {
        content: "the only memory",
        metadata: metadata("only"),
      });
      const generation = await embeddings.createEmbeddingGeneration(ctx, {
        spaceId,
        profile: SYNTHETIC_PROFILE,
        fingerprint,
      });
      await embeddings.stageEmbeddingVectorBatch(ctx, {
        embeddingGenerationId: generation.id,
        fingerprint,
        vectors: [{ targetKind: "thought", thoughtId, vector: oneHot(0) }],
      });

      // A capture after the manifest was derived moves the epoch, and a
      // manifest derived under one epoch may not be staged under another.
      await memory.captureThought(ctx, userId, spaceId, {
        content: "a later memory",
        metadata: metadata("later"),
      });
      assert.match(
        await refusal(() =>
          embeddings.stageEmbeddingGeneration(ctx, {
            embeddingGenerationId: generation.id,
            stagedAt: ctx.now + 1,
          }),
        ),
        /eligibility changed during generation staging/,
      );

      // The failure path: the generation records why, and stops being a
      // candidate for activation.
      await embeddings.failEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation.id,
        code: "manifest_moved",
        message: "a capture landed between derive and stage",
        failedAt: ctx.now + 2,
      });
      const failed = (
        await ctx.client.query(
          `SELECT state, failure_code, failure_message, failed_at
             FROM kith.embedding_generations WHERE id = $1`,
          [generation.id],
        )
      ).rows[0];
      assert.equal(failed.state, "failed");
      assert.equal(failed.failure_code, "manifest_moved");
      assert.notEqual(failed.failed_at, null);
      assert.match(
        await refusal(() =>
          embeddings.activateEmbeddingGeneration(ctx, {
            embeddingGenerationId: generation.id,
            activatedAt: ctx.now + 3,
          }),
        ),
        /Only a staged embedding generation can activate/,
      );
      // Failing twice is refused too: a failed generation is terminal.
      assert.match(
        await refusal(() =>
          embeddings.failEmbeddingGeneration(ctx, {
            embeddingGenerationId: generation.id,
            code: "again",
            message: "again",
            failedAt: ctx.now + 4,
          }),
        ),
        /Only an inactive embedding generation can fail/,
      );
    });
  },
);

test(
  "capturing a thought creates its target and bumps the epoch, and a supersede retires the old one",
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
      await ctx.client.query(
        `UPDATE kith.space_embedding_states
            SET historical_thought_counts = '{"superseded":0,"retracted":0}'::jsonb
          WHERE space_id = $1`,
        [spaceId],
      );
      const before = await stateRow(ctx, spaceId);

      const original = await memory.captureThought(ctx, userId, spaceId, {
        content: "the original claim",
        metadata: metadata("original"),
      });
      const afterCapture = await stateRow(ctx, spaceId);
      assert.equal(
        afterCapture.eligibility_epoch,
        before.eligibility_epoch + 1,
        "a capture bumps the eligibility epoch",
      );
      assert.deepEqual(afterCapture.eligible_counts, {
        thought: 1,
        chunk: 0,
        card: 0,
      });
      assert.deepEqual(await targetRows(ctx, spaceId), [
        {
          target_kind: "thought",
          target_id: original,
          state: "eligible",
          covered_fingerprint: null,
          input_hash: await sha256Utf8("the original claim"),
        },
      ]);
      // The new target is owed: it is eligible and uncovered, which is exactly
      // what the fill's partial index selects.
      assert.equal(
        (await embeddings.owedTargetsPage(ctx, spaceId)).length,
        1,
        "a captured thought is owed a vector",
      );

      // Cover it by hand, the way a fill would, so the supersede below has an
      // active vector to delete.
      await seedEmbeddingVector(ctx, {
        spaceId,
        embeddingGenerationId: index.generationId,
        fingerprint: index.fingerprint,
        targetKind: "thought",
        thoughtId: original,
        inputHash: await sha256Utf8("the original claim"),
        vector: oneHot(0),
      });
      await ctx.client.query(
        `UPDATE kith.embedding_targets SET covered_fingerprint = $1
          WHERE space_id = $2 AND target_id = $3`,
        [index.fingerprint, spaceId, original],
      );
      await recountEmbeddingCounters(ctx, spaceId, index.fingerprint);

      const replacement = await memory.transitionMemory(
        ctx,
        userId,
        spaceId,
        {
          content: "the corrected claim",
          metadata: metadata("corrected"),
        },
        [original],
        "superseded",
        "the first one was wrong",
        ctx.now,
      );

      const rows = await targetRows(ctx, spaceId);
      const oldTarget = rows.find((row) => row.target_id === original);
      const newTarget = rows.find((row) => row.target_id === replacement);
      assert.equal(
        oldTarget.state,
        "retired",
        "a superseded target is retired",
      );
      assert.equal(oldTarget.covered_fingerprint, null);
      assert.equal(newTarget.state, "eligible");
      assert.equal(
        newTarget.covered_fingerprint,
        null,
        "the replacement is owed a vector of its own",
      );

      // The superseded memory's vector is gone, in every generation under the
      // active fingerprint: leaving it would spend a candidate slot on a
      // memory the reader is going to drop anyway.
      assert.deepEqual(
        (
          await ctx.client.query(
            "SELECT id FROM kith.embedding_vectors WHERE thought_id = $1",
            [original],
          )
        ).rows,
        [],
      );

      const after = await stateRow(ctx, spaceId);
      assert.deepEqual(
        after.eligible_counts,
        { thought: 1, chunk: 0, card: 0 },
        "one retired and one created nets to one eligible thought",
      );
      assert.deepEqual(after.covered_counts, [
        {
          fingerprint: index.fingerprint,
          counts: { thought: 0, chunk: 0, card: 0 },
        },
      ]);
      assert.deepEqual(
        after.historical_thought_counts,
        { superseded: 1, retracted: 0 },
        "the superseded bucket is counted where the target was retired",
      );
      assert.equal(
        after.eligibility_epoch,
        afterCapture.eligibility_epoch + 1,
        "one transition bumps the epoch once",
      );

      // `setCoreStatus` changes no eligibility, so it spends no epoch.
      await memory.setCoreStatus(ctx, spaceId, replacement, true);
      assert.equal(
        (await stateRow(ctx, spaceId)).eligibility_epoch,
        after.eligibility_epoch,
      );
    });
  },
);

test(
  "the chunk and card leg never returns another space's row, or another fingerprint's",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const otherSpaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const index = await seedActiveEmbeddingIndex(ctx, spaceId, {
        eligible: { thought: 0, chunk: 1, card: 1 },
      });
      const otherIndex = await seedActiveEmbeddingIndex(ctx, otherSpaceId, {
        eligible: { thought: 0, chunk: 1, card: 1 },
      });
      // A fingerprint that is well formed and is not any space's active one.
      const retiredFingerprint = "a".repeat(64);

      const text = "The quarterly migration plan names two owners.";
      const hashOf = await sha256Utf8(text);

      /** One covered chunk and one covered card, in whichever space. */
      const seedPair = async (space, generationId, fingerprint, vector) => {
        const chain = await seedIndexableDocument(ctx, space, {
          title: "Quarterly plan",
          chunks: [text],
        });
        const card = await seedGenericCard(ctx, space, chain, {
          fields: {
            card_kind: "note",
            card_title: "Quarterly plan",
            card_summary: "Two owners named for the quarterly migration.",
          },
        });
        const composed = await embeddings.composeCardTargetInput(
          ctx,
          space,
          chain.sourceItemId,
        );
        const cardHash = await embeddings.cardTargetInputHash(composed);
        await seedEmbeddingTarget(ctx, {
          spaceId: space,
          targetKind: "chunk",
          targetId: chain.chunkIds[0],
          inputHash: hashOf,
          processingGenerationId: chain.generationId,
          fingerprint,
        });
        await seedEmbeddingVector(ctx, {
          spaceId: space,
          embeddingGenerationId: generationId,
          fingerprint,
          targetKind: "chunk",
          chunkId: chain.chunkIds[0],
          processingGenerationId: chain.generationId,
          inputHash: hashOf,
          vector,
        });
        await seedEmbeddingTarget(ctx, {
          spaceId: space,
          targetKind: "card",
          targetId: card.eventId,
          inputHash: cardHash,
          fingerprint,
        });
        await seedEmbeddingVector(ctx, {
          spaceId: space,
          embeddingGenerationId: generationId,
          fingerprint,
          targetKind: "card",
          eventId: card.eventId,
          inputHash: cardHash,
          vector,
        });
        return { chain, card };
      };

      // The rows this space is supposed to find.
      const mine = await seedPair(
        spaceId,
        index.generationId,
        index.fingerprint,
        oneHot(0),
      );

      // Control 1: the same nearest-possible vector, in another space, under
      // that space's own active fingerprint and its own generation.
      const foreign = await seedPair(
        otherSpaceId,
        otherIndex.generationId,
        otherIndex.fingerprint,
        oneHot(0),
      );

      // Control 2: the same nearest-possible vector, in *this* space, under a
      // fingerprint that is not the active one. This is the rollback artifact
      // a profile transition leaves behind, and it is the control the thought
      // leg already has and this leg did not.
      const staleGenerationId = newKithId();
      const staleProfileId = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.embedding_profiles (id, created_at, fingerprint)
         VALUES ($1, transaction_timestamp(), $2)`,
        [staleProfileId, retiredFingerprint],
      );
      await ctx.client.query(
        `INSERT INTO kith.embedding_generations
           (id, space_id, created_at, embedding_profile_id, fingerprint, state,
            deactivated_at)
         VALUES ($1, $2, transaction_timestamp(), $3, $4, 'retired',
                 transaction_timestamp())`,
        [staleGenerationId, spaceId, staleProfileId, retiredFingerprint],
      );
      const stale = await seedPair(
        spaceId,
        staleGenerationId,
        retiredFingerprint,
        oneHot(0),
      );

      const targets = await embeddings.getActiveTargets(ctx, [spaceId]);
      const semantic = await embeddings.searchChunkAndCardVectorCandidates(
        ctx,
        [spaceId],
        targets,
        oneHot(0),
      );
      assert.equal(semantic.vectorStatus, "ready");
      assert.deepEqual(
        semantic.chunkIds,
        [mine.chain.chunkIds[0]],
        "only this space's active-fingerprint chunk is a candidate",
      );
      assert.deepEqual(
        semantic.cardHits.map((hit) => hit.eventId),
        [mine.card.eventId],
        "only this space's active-fingerprint card is a candidate",
      );
      for (const [label, leaked] of [
        ["another space's chunk", foreign.chain.chunkIds[0]],
        ["a retired fingerprint's chunk", stale.chain.chunkIds[0]],
      ]) {
        assert.equal(
          semantic.chunkIds.includes(leaked),
          false,
          `${label} is never a candidate here`,
        );
      }
      for (const [label, leaked] of [
        ["another space's card", foreign.card.eventId],
        ["a retired fingerprint's card", stale.card.eventId],
      ]) {
        assert.equal(
          semantic.cardHits.some((hit) => hit.eventId === leaked),
          false,
          `${label} is never a candidate here`,
        );
      }
    });
  },
);
