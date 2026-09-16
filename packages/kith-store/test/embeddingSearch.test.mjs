// P2-39g1: the vector column, the full-text indexes and the search legs,
// against a real PostgreSQL server with pgvector. Companion to memory.test.mjs
// (P2-39h) and parsedStagingAndDocuments.test.mjs (P2-39d2), same fixtures
// and conventions.
//
// What these tests are not: a ranking-parity proof. Section 4.2 of
// docs/plans/2026-09-12-postgres-consolidation.md owns that, with the frozen
// question set, and nothing here claims a PostgreSQL rank matches a Convex
// one. What they do prove is the shape a parity run needs to be trustworthy:
// the right rows come back, the wrong space's never do, an out-of-scope or
// stale candidate is dropped, fusion arithmetic is the ported arithmetic, and
// a vector outage degrades ranking instead of hiding retained evidence.

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
  DIMENSIONS,
  SYNTHETIC_PROFILE,
  mix,
  oneHot,
  scopeV2,
  seedActiveEmbeddingIndex,
  seedEmbeddingTarget,
  seedEmbeddingVector,
  seedThoughtVector,
  sha256Utf8,
} from "./helpers/embeddingFixture.mjs";

const metadata = (summary, type = "reference") => ({
  type,
  topics: ["synthetic"],
  people: [],
  actionItems: [],
  summary,
});

/** An embedder that never touches the network: it answers with what it is told. */
const embedderFor = (vector, fingerprint) => async () => ({
  vector,
  fingerprint,
});

async function seedDocumentChain(ctx, spaceId, input) {
  const sourceAccountId = newKithId();
  const sourceItemId = newKithId();
  const generationId = newKithId();
  const documentId = newKithId();
  const chunkId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
       VALUES ($1, $2, transaction_timestamp(), 'synthetic', true)`,
    [sourceAccountId, spaceId],
  );
  await ctx.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id_hash, title,
        lifecycle, original_link_available, desired_processing_epoch, active_generation_id)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, 'available', true, 0, $6)`,
    [
      sourceItemId,
      spaceId,
      sourceAccountId,
      "a".repeat(64),
      input.title,
      generationId,
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id,
        desired_processing_epoch, card_generation, state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 0, false, 'ready')`,
    [generationId, spaceId, sourceAccountId, sourceItemId],
  );
  await ctx.client.query(
    `INSERT INTO kith.documents
       (id, space_id, created_at, processing_generation_id, source_item_id,
        document_key, title, doc_type, captured_at, evidence_span_ids, publication_state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'doc-1', $5, 'note',
               transaction_timestamp(), '[]'::jsonb, 'active')`,
    [documentId, spaceId, generationId, sourceItemId, input.title],
  );
  await ctx.client.query(
    `INSERT INTO kith.chunks
       (id, space_id, created_at, processing_generation_id, document_id, ordinal,
        start, "end", text, evidence_span_ids, publication_state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 0, 0, $5, $6, '[]'::jsonb, 'active')`,
    [chunkId, spaceId, generationId, documentId, input.text.length, input.text],
  );
  return { sourceAccountId, sourceItemId, generationId, documentId, chunkId };
}

/**
 * The generic card of one source item: its own `card_generation`, the event,
 * the version that generation published, and the observations the composed
 * card text is built from.
 */
async function seedCard(ctx, spaceId, chain, input) {
  const cardGenerationId = input.cardGenerationId ?? newKithId();
  const eventId = newKithId();
  const eventVersionId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id,
        desired_processing_epoch, card_generation, state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 0, true, 'ready')`,
    [cardGenerationId, spaceId, chain.sourceAccountId, chain.sourceItemId],
  );
  await ctx.client.query(
    "UPDATE kith.source_items SET active_card_generation_id = $1 WHERE id = $2",
    [cardGenerationId, chain.sourceItemId],
  );
  await ctx.client.query(
    `INSERT INTO kith.events
       (id, space_id, created_at, source_account_id, source_item_id, event_key)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'card:document_card')`,
    [eventId, spaceId, chain.sourceAccountId, chain.sourceItemId],
  );
  await ctx.client.query(
    `INSERT INTO kith.event_versions
       (id, space_id, created_at, source_account_id, source_item_id,
        processing_generation_id, event_id, event_type, field_evidence)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'document_card', $7::jsonb)`,
    [
      eventVersionId,
      spaceId,
      chain.sourceAccountId,
      chain.sourceItemId,
      cardGenerationId,
      eventId,
      JSON.stringify({ occurrence: [], entity: [], eventType: [] }),
    ],
  );
  for (const [observationType, value] of Object.entries(input.fields)) {
    await ctx.client.query(
      `INSERT INTO kith.observations
         (id, space_id, created_at, source_account_id, source_item_id,
          processing_generation_id, event_id, event_version_id, event_type,
          observation_key, observation_type, value, value_evidence)
         VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7, 'document_card',
                 $8, $8, $9::jsonb, '[]'::jsonb)`,
      [
        newKithId(),
        spaceId,
        chain.sourceAccountId,
        chain.sourceItemId,
        cardGenerationId,
        eventId,
        eventVersionId,
        observationType,
        JSON.stringify({ type: "text", value }),
      ],
    );
  }
  return { cardGenerationId, eventId, eventVersionId };
}

test(
  "migration 015 installs pgvector, the vector column, the scope index and both tsvector columns",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    const extension = await db.client.query(
      `SELECT n.nspname FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`,
    );
    // `public`, and asserted rather than assumed: every vector read in
    // src/embeddings/search.ts names `public.vector` and
    // `OPERATOR(public.<=>)` because `withKithTransaction` pins search_path
    // to `kith` alone.
    assert.deepEqual(
      extension.rows.map((row) => row.nspname),
      ["public"],
    );

    const columns = await db.client.query(
      `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull, a.attgenerated
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kith'
          AND ((c.relname = 'embedding_vectors' AND a.attname = 'embedding')
            OR (c.relname = 'thoughts' AND a.attname = 'content_search')
            OR (c.relname = 'facts' AND a.attname = 'search_text_search'))
        ORDER BY c.relname, a.attname`,
    );
    assert.deepEqual(
      columns.rows.map((row) => [
        row.relname,
        row.attname,
        row.type,
        row.attnotnull,
        row.attgenerated,
      ]),
      [
        // Generated and stored, so the index can never drift from its text.
        ["embedding_vectors", "embedding", "vector(1536)", true, ""],
        ["facts", "search_text_search", "tsvector", false, "s"],
        ["thoughts", "content_search", "tsvector", false, "s"],
      ],
    );

    const indexes = await db.client.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'kith' AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [
        [
          "embedding_targets_space_kind_target_idx",
          "embedding_vectors_generation_thought_idx",
          "embedding_vectors_scope_idx",
          "facts_search_text_search_idx",
          "space_embedding_states_space_idx",
          "thoughts_content_search_idx",
        ],
      ],
    );
    assert.equal(indexes.rows.length, 6, "every P2-39g1 index exists");
    for (const name of [
      "facts_search_text_search_idx",
      "thoughts_content_search_idx",
    ]) {
      const definition = indexes.rows.find((row) => row.indexname === name);
      assert.match(definition.indexdef, /USING gin/);
    }
    // Section 2.7: no HNSW at this corpus size. An exact scan filtered by
    // space and fingerprint is the design, not an omission.
    const vectorIndexes = await db.client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'kith' AND tablename = 'embedding_vectors'
          AND (indexdef LIKE '%hnsw%' OR indexdef LIKE '%ivfflat%')`,
    );
    assert.deepEqual(vectorIndexes.rows, []);
  },
);

test(
  "the keyword legs stem, and neither one crosses a space boundary",
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

      const thoughtId = await memory.captureThought(ctx, userId, spaceId, {
        content: "Rowan is drafting the quarterly migration plan",
        metadata: metadata("migration plan", "decision"),
      });
      const otherThoughtId = await memory.captureThought(
        ctx,
        userId,
        otherSpaceId,
        {
          content: "Rowan is drafting the quarterly migration plan",
          metadata: metadata("migration plan", "decision"),
        },
      );
      const fact = await memory.rememberFact(ctx, userId, spaceId, {
        subject: { kind: "person", name: "Rowan" },
        predicate: "home_city",
        value: { type: "text", value: "Oakland" },
        sourceType: "user_stated",
      });
      await memory.rememberFact(ctx, userId, otherSpaceId, {
        subject: { kind: "person", name: "Rowan" },
        predicate: "home_city",
        value: { type: "text", value: "Oakland" },
        sourceType: "user_stated",
      });

      // "migrations" stems to "migrat", which matches the stored "migration".
      // Convex's index was prefix matching; PostgreSQL stems. This asserts
      // the stem, not that the two rank alike.
      assert.deepEqual(
        (
          await embeddings.searchThoughtsByText(ctx, [spaceId], "migrations")
        ).map((thought) => thought.id),
        [thoughtId],
      );
      // "cities" stems to "citi", which the fact's `home city` predicate
      // label produced.
      assert.deepEqual(
        (await embeddings.searchFacts(ctx, [spaceId], "cities")).map(
          (found) => found.id,
        ),
        [fact.factId],
      );

      // The other space's identical rows are not reachable from this one, and
      // are reachable from their own.
      assert.deepEqual(
        (
          await embeddings.searchThoughtsByText(
            ctx,
            [otherSpaceId],
            "migrations",
          )
        ).map((thought) => thought.id),
        [otherThoughtId],
      );
      assert.equal(
        (await embeddings.searchThoughtsByText(ctx, [], "migrations")).length,
        0,
      );

      // The `type` filter and the retrievability filter are the ported ones.
      assert.equal(
        (
          await embeddings.searchThoughtsByText(ctx, [spaceId], "migrations", {
            type: "idea",
          })
        ).length,
        0,
      );
      await ctx.client.query(
        "UPDATE kith.thoughts SET memory_status = 'retracted' WHERE id = $1",
        [thoughtId],
      );
      assert.equal(
        (
          await embeddings.searchThoughtsByText(ctx, [spaceId], "migrations", {
            includeHistorical: true,
          })
        ).length,
        0,
        "a retracted memory is withheld in both modes",
      );
    });
  },
);

test(
  "vector candidates rank by cosine similarity and never cross a space or a fingerprint",
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
        eligible: { thought: 3, chunk: 0, card: 0 },
      });
      const otherIndex = await seedActiveEmbeddingIndex(ctx, otherSpaceId, {
        eligible: { thought: 1, chunk: 0, card: 0 },
      });

      const exact = await memory.captureThought(ctx, userId, spaceId, {
        content: "exact axis",
        metadata: metadata("exact"),
      });
      const half = await memory.captureThought(ctx, userId, spaceId, {
        content: "half axis",
        metadata: metadata("half"),
      });
      const orthogonal = await memory.captureThought(ctx, userId, spaceId, {
        content: "orthogonal axis",
        metadata: metadata("orthogonal"),
      });
      await seedThoughtVector(ctx, {
        spaceId,
        embeddingGenerationId: index.generationId,
        fingerprint: index.fingerprint,
        thoughtId: exact,
        content: "exact axis",
        vector: oneHot(0),
      });
      await seedThoughtVector(ctx, {
        spaceId,
        embeddingGenerationId: index.generationId,
        fingerprint: index.fingerprint,
        thoughtId: half,
        content: "half axis",
        vector: mix(0, 1),
      });
      await seedThoughtVector(ctx, {
        spaceId,
        embeddingGenerationId: index.generationId,
        fingerprint: index.fingerprint,
        thoughtId: orthogonal,
        content: "orthogonal axis",
        vector: oneHot(2),
      });

      // The isolation control: the same one-hot vector, in another space,
      // under another fingerprint. It is the nearest possible row and it must
      // never appear in this space's results.
      const foreign = await memory.captureThought(ctx, userId, otherSpaceId, {
        content: "exact axis",
        metadata: metadata("foreign"),
      });
      await seedThoughtVector(ctx, {
        spaceId: otherSpaceId,
        embeddingGenerationId: otherIndex.generationId,
        fingerprint: otherIndex.fingerprint,
        thoughtId: foreign,
        content: "exact axis",
        vector: oneHot(0),
      });

      const target = await embeddings.getActiveEmbeddingTarget(ctx, spaceId);
      assert.equal(target.thoughtStatus, "ready");
      assert.equal(target.fingerprint, index.fingerprint);

      const candidates = await embeddings.searchThoughtVectorCandidates(
        ctx,
        [target],
        oneHot(0),
      );
      assert.deepEqual(
        candidates.map((candidate) => candidate.thoughtId),
        [exact, half, orthogonal],
      );
      // Cosine similarity, exposed as `1 - distance`: 1, 1/sqrt(2), 0.
      assert.ok(Math.abs(candidates[0].similarity - 1) < 1e-6);
      assert.ok(Math.abs(candidates[1].similarity - Math.SQRT1_2) < 1e-6);
      assert.ok(Math.abs(candidates[2].similarity - 0) < 1e-6);
      assert.equal(
        candidates.some((candidate) => candidate.thoughtId === foreign),
        false,
        "an identical vector in another space is never a candidate here",
      );

      // A row whose fingerprint no longer matches the active one is out of
      // scope even inside its own space.
      await ctx.client.query(
        "UPDATE kith.embedding_vectors SET embedding_fingerprint = $1 WHERE thought_id = $2",
        ["f".repeat(64), exact],
      );
      assert.equal(
        (
          await embeddings.searchThoughtVectorCandidates(
            ctx,
            [target],
            oneHot(0),
          )
        ).some((candidate) => candidate.thoughtId === exact),
        false,
      );
      await ctx.client.query(
        "UPDATE kith.embedding_vectors SET embedding_fingerprint = $1 WHERE thought_id = $2",
        [index.fingerprint, exact],
      );

      // A row whose stored scope does not recompute is dropped, which is the
      // integrity half `scope_v2` still earns its place with.
      await ctx.client.query(
        "UPDATE kith.embedding_vectors SET scope_v2 = $1 WHERE thought_id = $2",
        [scopeV2(otherSpaceId, index.fingerprint, "thought"), exact],
      );
      assert.equal(
        (
          await embeddings.searchThoughtVectorCandidates(
            ctx,
            [target],
            oneHot(0),
          )
        ).some((candidate) => candidate.thoughtId === exact),
        false,
      );
      await ctx.client.query(
        "UPDATE kith.embedding_vectors SET scope_v2 = $1 WHERE thought_id = $2",
        [scopeV2(spaceId, index.fingerprint, "thought"), exact],
      );

      // A retired target drops its vector even though the vector is intact.
      await ctx.client.query(
        "UPDATE kith.embedding_targets SET state = 'retired' WHERE target_id = $1",
        [half],
      );
      assert.deepEqual(
        (
          await embeddings.searchThoughtVectorCandidates(
            ctx,
            [target],
            oneHot(0),
          )
        ).map((candidate) => candidate.thoughtId),
        [exact, orthogonal],
      );

      // An incomplete thought index is strict (I9): no thought candidates.
      await ctx.client.query(
        "UPDATE kith.space_embedding_states SET covered_counts = $1::jsonb WHERE space_id = $2",
        [
          JSON.stringify([
            {
              fingerprint: index.fingerprint,
              counts: { thought: 1, chunk: 0, card: 0 },
            },
          ]),
          spaceId,
        ],
      );
      const degraded = await embeddings.getActiveEmbeddingTarget(ctx, spaceId);
      assert.equal(degraded.thoughtStatus, "unavailable");
      assert.deepEqual(
        await embeddings.searchThoughtVectorCandidates(
          ctx,
          [degraded],
          oneHot(0),
        ),
        [],
      );
    });
  },
);

test(
  "a malformed query vector is refused before any SQL runs",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const index = await seedActiveEmbeddingIndex(ctx, spaceId);
      const target = await embeddings.getActiveEmbeddingTarget(ctx, spaceId);
      assert.equal(target.fingerprint, index.fingerprint);

      const short = new Array(DIMENSIONS - 1).fill(0);
      short[0] = 1;
      assert.throws(
        () => embeddings.assertSearchVector(short),
        /1536 dimensions/,
      );
      assert.throws(
        () =>
          embeddings.assertSearchVector(new Array(DIMENSIONS).fill(Number.NaN)),
        /finite/,
      );
      const infinite = oneHot(0);
      infinite[5] = Number.POSITIVE_INFINITY;
      assert.throws(() => embeddings.assertSearchVector(infinite), /finite/);
      assert.equal(
        embeddings.assertSearchVector(oneHot(0)).startsWith("[1,0"),
        true,
      );

      // The refusal happens inside the search leg too, before a statement is
      // sent: a rejected transaction would leave the connection unusable for
      // the assertions that follow, and this one does not.
      await assert.rejects(
        embeddings.searchThoughtVectorCandidates(ctx, [target], short),
        /1536 dimensions/,
      );
      const stillUsable = await ctx.client.query("SELECT 1 AS ok");
      assert.equal(stillUsable.rows[0].ok, 1);
    });
  },
);

test(
  "hybrid fusion matches the hand-computed reciprocal rank and reports every unavailable path",
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
        eligible: { thought: 2, chunk: 0, card: 0 },
      });

      // `keywordOnly` is the only row the query text matches. `vectorOnly` is
      // the only row the query vector is near. `both` is matched by neither
      // leg alone but appears in both, which is what the fusion is for.
      const keywordOnly = await memory.captureThought(ctx, userId, spaceId, {
        content: "quarterly migration plan",
        metadata: metadata("keyword"),
      });
      const vectorOnly = await memory.captureThought(ctx, userId, spaceId, {
        content: "unrelated wording entirely",
        metadata: metadata("vector"),
      });
      await seedThoughtVector(ctx, {
        spaceId,
        embeddingGenerationId: index.generationId,
        fingerprint: index.fingerprint,
        thoughtId: vectorOnly,
        content: "unrelated wording entirely",
        vector: oneHot(0),
      });
      await seedThoughtVector(ctx, {
        spaceId,
        embeddingGenerationId: index.generationId,
        fingerprint: index.fingerprint,
        thoughtId: keywordOnly,
        content: "quarterly migration plan",
        vector: mix(0, 1),
      });

      const ready = await embeddings.searchThoughtsHybrid(
        ctx,
        [spaceId],
        "migration",
        { embedQuery: embedderFor(oneHot(0), index.fingerprint) },
      );
      assert.equal(ready.vectorStatus, "ready");
      // Hand computed, K = 60. Vector ranks: vectorOnly 0, keywordOnly 1.
      // Keyword ranks: keywordOnly 0. So
      //   keywordOnly = 1/62 + 1/61 = 0.0325317...
      //   vectorOnly  = 1/61        = 0.0163934...
      const keywordScore = 1 / 62 + 1 / 61;
      const vectorScore = 1 / 61;
      assert.deepEqual(
        ready.results.map((thought) => thought.id),
        [keywordOnly, vectorOnly],
      );
      assert.ok(Math.abs(ready.results[0].score - keywordScore) < 1e-12);
      assert.ok(Math.abs(ready.results[1].score - vectorScore) < 1e-12);

      // A provider whose fingerprint disagrees with the active target.
      const mismatched = await embeddings.searchThoughtsHybrid(
        ctx,
        [spaceId],
        "migration",
        { embedQuery: embedderFor(oneHot(0), "d".repeat(64)) },
      );
      assert.equal(mismatched.vectorStatus, "unavailable");
      assert.deepEqual(
        mismatched.results.map((thought) => thought.id),
        [keywordOnly],
        "keyword evidence survives a vector outage",
      );

      // A provider that fails outright.
      const failed = await embeddings.searchThoughtsHybrid(
        ctx,
        [spaceId],
        "migration",
        {
          embedQuery: async () => {
            throw new Error("Embedding request failed");
          },
        },
      );
      assert.equal(failed.vectorStatus, "unavailable");
      assert.deepEqual(
        failed.results.map((thought) => thought.id),
        [keywordOnly],
      );

      // No embedder at all is the `searchMode: "keyword"` path.
      const keyword = await embeddings.searchThoughtsHybrid(
        ctx,
        [spaceId],
        "migration",
      );
      assert.equal(keyword.vectorStatus, "unavailable");
      assert.deepEqual(
        keyword.results.map((thought) => thought.id),
        [keywordOnly],
      );

      // Two spaces whose active fingerprints disagree turn the vector leg off
      // for the whole request rather than searching a subset of them.
      const secondSpaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      await seedActiveEmbeddingIndex(ctx, secondSpaceId, {
        profile: { ...SYNTHETIC_PROFILE, modelRevision: "synthetic-rev-2" },
      });
      const split = await embeddings.searchThoughtsHybrid(
        ctx,
        [spaceId, secondSpaceId],
        "migration",
        { embedQuery: embedderFor(oneHot(0), index.fingerprint) },
      );
      assert.equal(split.vectorStatus, "unavailable");
      assert.deepEqual(
        split.results.map((thought) => thought.id),
        [keywordOnly],
      );
    });
  },
);

test(
  "chunk and card candidates resolve, and a stale card generation is dropped",
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
        eligible: { thought: 0, chunk: 1, card: 1 },
      });
      const chain = await seedDocumentChain(ctx, spaceId, {
        title: "Quarterly plan",
        text: "The quarterly migration plan names two owners.",
      });
      const card = await seedCard(ctx, spaceId, chain, {
        fields: {
          card_kind: "note",
          card_title: "Quarterly plan",
          card_summary: "Two owners named for the quarterly migration.",
        },
      });

      const chunkText = "The quarterly migration plan names two owners.";
      await seedEmbeddingTarget(ctx, {
        spaceId,
        targetKind: "chunk",
        targetId: chain.chunkId,
        inputHash: await sha256Utf8(chunkText),
        processingGenerationId: chain.generationId,
        fingerprint: index.fingerprint,
      });
      await seedEmbeddingVector(ctx, {
        spaceId,
        embeddingGenerationId: index.generationId,
        fingerprint: index.fingerprint,
        targetKind: "chunk",
        chunkId: chain.chunkId,
        processingGenerationId: chain.generationId,
        inputHash: await sha256Utf8(chunkText),
        vector: oneHot(0),
      });

      const composed = await embeddings.composeCardTargetInput(
        ctx,
        spaceId,
        chain.sourceItemId,
      );
      assert.equal(composed.cardGenerationId, card.cardGenerationId);
      assert.deepEqual(composed.documentIds, [chain.documentId]);
      const cardHash = await embeddings.cardTargetInputHash(composed);
      await seedEmbeddingTarget(ctx, {
        spaceId,
        targetKind: "card",
        targetId: card.eventId,
        inputHash: cardHash,
        fingerprint: index.fingerprint,
      });
      await seedEmbeddingVector(ctx, {
        spaceId,
        embeddingGenerationId: index.generationId,
        fingerprint: index.fingerprint,
        targetKind: "card",
        eventId: card.eventId,
        inputHash: cardHash,
        vector: mix(0, 1),
      });

      const targets = await embeddings.getActiveTargets(ctx, [spaceId]);
      const semantic = await embeddings.searchChunkAndCardVectorCandidates(
        ctx,
        [spaceId],
        targets,
        oneHot(0),
      );
      assert.equal(semantic.vectorStatus, "ready");
      assert.deepEqual(semantic.chunkIds, [chain.chunkId]);
      assert.deepEqual(
        semantic.cardHits.map((hit) => [
          hit.eventId,
          hit.documentId,
          hit.summary,
        ]),
        [
          [
            card.eventId,
            chain.documentId,
            "Two owners named for the quarterly migration.",
          ],
        ],
      );
      // Coverage is reported, never a gate: eligible equals covered here.
      assert.equal(semantic.coverageIncomplete, false);

      // A card whose live generation has moved on recomposes to a different
      // hash, so the vector written against the old one is dropped. The chunk
      // leg is untouched by it.
      const newerCardGenerationId = newKithId();
      await seedCard(ctx, spaceId, chain, {
        cardGenerationId: newerCardGenerationId,
        fields: {
          card_kind: "note",
          card_title: "Quarterly plan, revised",
          card_summary: "Three owners named for the quarterly migration.",
        },
      });
      const stale = await embeddings.searchChunkAndCardVectorCandidates(
        ctx,
        [spaceId],
        targets,
        oneHot(0),
      );
      assert.equal(stale.vectorStatus, "ready");
      assert.deepEqual(stale.chunkIds, [chain.chunkId]);
      assert.deepEqual(stale.cardHits, []);

      // An incomplete chunk index reports, it does not withhold.
      await ctx.client.query(
        "UPDATE kith.space_embedding_states SET covered_counts = $1::jsonb WHERE space_id = $2",
        [
          JSON.stringify([
            {
              fingerprint: index.fingerprint,
              counts: { thought: 0, chunk: 0, card: 0 },
            },
          ]),
          spaceId,
        ],
      );
      const partial = await embeddings.searchChunkAndCardVectorCandidates(
        ctx,
        [spaceId],
        await embeddings.getActiveTargets(ctx, [spaceId]),
        oneHot(0),
      );
      assert.equal(partial.vectorStatus, "ready");
      assert.equal(partial.coverageIncomplete, true);
      assert.deepEqual(partial.chunkIds, [chain.chunkId]);

      // A space with no active target at all turns the leg off.
      const bareSpaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const none = await embeddings.searchChunkAndCardVectorCandidates(
        ctx,
        [spaceId, bareSpaceId],
        await embeddings.getActiveTargets(ctx, [spaceId, bareSpaceId]),
        oneHot(0),
      );
      assert.equal(none.vectorStatus, "unavailable");
      assert.deepEqual(none.chunkIds, []);
    });
  },
);

test(
  "the embedding fingerprint is the value Convex computes for the same profile",
  { skip: false },
  async () => {
    // Derived, not guessed. `fingerprintEmbeddingConfig` in
    // packages/convex/convex/lib/embeddingProvider.ts is
    // `sha256Hex(JSON.stringify(["embedding-profile-v1", protocol, providerId,
    // model, modelRevision, dimensions, normalization, preprocessing]))`. The
    // two literals below were produced by running exactly that expression
    // over Node's crypto for the baseline profile and for the fixture profile:
    //
    //   node -e 'const c=require("node:crypto");
    //     console.log(c.createHash("sha256").update(JSON.stringify([
    //       "embedding-profile-v1","openai-embeddings-v1","openai",
    //       "text-embedding-3-small","legacy-openai-small-1536-v1",1536,
    //       "none-v1","none-v1"]),"utf8").digest("hex"))'
    //
    // If this assertion ever fails, a vector written on one side stopped
    // being findable from the other, which is the whole reason the port is
    // byte-identical.
    const baseline = embeddings.loadEmbeddingConfig({
      OPENAI_API_KEY: "synthetic-key",
    });
    assert.equal(baseline.model, "text-embedding-3-small");
    assert.equal(baseline.dimensions, 1536);
    assert.equal(
      await embeddings.fingerprintEmbeddingConfig(
        embeddings.embeddingProfile(baseline),
      ),
      "500b53cd5fb3cd9e7f69b31a339307d162ca159149b86e6bdd2f77144b9fbdfb",
    );
    assert.equal(
      await embeddings.fingerprintEmbeddingConfig(SYNTHETIC_PROFILE),
      "8d73d7cc3d5135b248aa1902eaf138771328e4a5558dfcefc9e11c868f299732",
    );

    // The profile deliberately excludes endpoint and credentials, so two
    // configurations that differ only there are the same index.
    const viaKey = embeddings.loadEmbeddingConfig({
      BRAIN_EMBED_API_KEY: "other-key",
    });
    assert.deepEqual(
      embeddings.embeddingProfile(viaKey),
      embeddings.embeddingProfile(baseline),
    );
    assert.equal(viaKey.apiKey, "other-key");

    // A custom endpoint must declare its own identity rather than inherit the
    // baseline one, which is what keeps a fingerprint honest.
    assert.throws(
      () =>
        embeddings.loadEmbeddingConfig({
          BRAIN_EMBED_ENDPOINT: "https://example.invalid/v1/embeddings",
        }),
      /BRAIN_EMBED_PROVIDER_ID must be explicitly configured/,
    );
    assert.throws(
      () => embeddings.loadEmbeddingConfig({ BRAIN_EMBED_DIMENSIONS: "768" }),
      /must be 1536/,
    );
  },
);

test(
  "requestEmbedding stays bounded and never leaks provider detail",
  { skip: false },
  async () => {
    const config = embeddings.loadEmbeddingConfig({
      OPENAI_API_KEY: "synthetic-key",
    });
    const vector = oneHot(3);
    let seen;
    const ok = await embeddings.requestEmbedding(
      "a query",
      config,
      async (url, init) => {
        seen = { url, init };
        return new Response(
          JSON.stringify({
            model: config.model,
            data: [{ embedding: vector }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    assert.deepEqual(ok.vector, vector);
    assert.equal(
      ok.fingerprint,
      await embeddings.fingerprintEmbeddingConfig(config),
    );
    assert.equal(seen.url, "https://api.openai.com/v1/embeddings");
    assert.equal(seen.init.headers.Authorization, "Bearer synthetic-key");
    assert.deepEqual(JSON.parse(seen.init.body), {
      model: config.model,
      input: "a query",
      dimensions: 1536,
    });

    // A wrong-length vector, a wrong model and a failure status are all the
    // same generic error: a caller never learns what the provider said.
    for (const respond of [
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
          status: 200,
        }),
      async () =>
        new Response(
          JSON.stringify({ model: "other", data: [{ embedding: vector }] }),
          {
            status: 200,
          },
        ),
      async () => new Response("nope", { status: 500 }),
    ]) {
      await assert.rejects(
        embeddings.requestEmbedding("a query", config, respond),
        /^Error: Embedding request failed$/,
      );
    }
    await assert.rejects(
      embeddings.requestEmbedding("", config, async () => new Response("{}")),
      /Embedding input must not be empty/,
    );
  },
);
