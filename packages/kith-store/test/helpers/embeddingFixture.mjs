// P2-39g1 fixtures: the rows a space needs before the retrieval legs in
// `src/embeddings/search.ts` will look at it, plus hand-built vectors.
//
// Built on the memory fixture's migrated throwaway database, because the
// thought and fact legs are the memory domain's rows and the document legs
// need the same schema. Every row here is seeded with raw SQL: the writers
// that own these tables (the embedding build driver, the card extractor)
// belong to other slices, and a retrieval test that could only run after
// them would prove nothing about retrieval.
//
// P2-39g2 extended three things here rather than forking a second fixture.
// The profile insert reuses an existing row for its fingerprint and the
// target insert upserts, because migration 016 makes both identities unique
// and because that is what `ensureEmbeddingProfile` and
// `upsertEligibleTarget` do. `recountEmbeddingCounters` is new: a test that
// captures thoughts through `memory.captureThought` now has a real writer
// maintaining its counters, so the counts this fixture seeded up front are an
// opening balance rather than the final answer, and a test that wants them to
// agree with its rows asks for a recount instead of guessing an offset. A
// test that wants a shortfall still states one and does not recount.

import { newKithId } from "../../dist/index.js";
import { fingerprintEmbeddingConfig } from "../../dist/embeddings/index.js";

export const DIMENSIONS = 1536;

/** A distinct 64-hex external id hash per seeded item. */
let externalIdCounter = 0;
function externalIdHash() {
  externalIdCounter += 1;
  return externalIdCounter.toString(16).padStart(64, "0");
}

/**
 * A synthetic profile, deliberately not the baseline one: nothing in a test
 * should be able to pass by accidentally matching the production identity.
 */
export const SYNTHETIC_PROFILE = Object.freeze({
  protocol: "openai-embeddings-v1",
  providerId: "synthetic",
  model: "synthetic-embed-small",
  modelRevision: "synthetic-rev-1",
  dimensions: DIMENSIONS,
  normalization: "none-v1",
  preprocessing: "none-v1",
});

/** A unit vector with a single 1 at `index`. Cosine against itself is 1. */
export function oneHot(index) {
  const vector = new Array(DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

/** The normalized sum of several one-hot axes. Cosine against one axis is 1/sqrt(n). */
export function mix(...indexes) {
  const vector = new Array(DIMENSIONS).fill(0);
  const weight = 1 / Math.sqrt(indexes.length);
  for (const index of indexes) vector[index] = weight;
  return vector;
}

/** The text literal pgvector parses, which is how every vector is bound. */
export function vectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

export async function sha256Utf8(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** `embeddingVectorScopeV2`, restated so the fixture cannot be proven correct
 * by the code it is testing. It is a fixed-position JSON array. */
export function scopeV2(spaceId, fingerprint, targetKind) {
  return JSON.stringify([
    "embedding-vector-scope-v2",
    spaceId,
    fingerprint,
    targetKind,
  ]);
}

export function searchScope(
  spaceId,
  fingerprint,
  embeddingGenerationId,
  targetKind,
) {
  return JSON.stringify([
    "embedding-vector-scope-v1",
    spaceId,
    fingerprint,
    embeddingGenerationId,
    targetKind,
  ]);
}

/**
 * One space with an active embedding generation under `profile`, its counters
 * seeded and audited, so `getActiveEmbeddingTarget` returns a target whose
 * `thoughtStatus` is "ready".
 *
 * `eligible`/`covered` default to equal, which is what "ready" means. A test
 * that wants an incomplete chunk index passes them apart.
 */
export async function seedActiveEmbeddingIndex(ctx, spaceId, options = {}) {
  const profile = options.profile ?? SYNTHETIC_PROFILE;
  const fingerprint = await fingerprintEmbeddingConfig(profile);
  const profileId = newKithId();
  const generationId = newKithId();
  const stateId = newKithId();
  const eligible = options.eligible ?? { thought: 0, chunk: 0, card: 0 };
  const covered = options.covered ?? eligible;
  // One row per fingerprint, which is what migration 016 enforces: two spaces
  // on the same profile share the profile row, exactly as two spaces going
  // through `ensureEmbeddingProfile` would.
  const seededProfile = await ctx.client.query(
    `INSERT INTO kith.embedding_profiles
       (id, created_at, fingerprint, protocol, provider_id, model, model_revision,
        dimensions, normalization, preprocessing)
     VALUES ($1, transaction_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (fingerprint) DO NOTHING
     RETURNING id`,
    [
      profileId,
      fingerprint,
      profile.protocol,
      profile.providerId,
      profile.model,
      profile.modelRevision,
      profile.dimensions,
      profile.normalization,
      profile.preprocessing,
    ],
  );
  const usedProfileId =
    seededProfile.rows[0]?.id ??
    (
      await ctx.client.query(
        "SELECT id FROM kith.embedding_profiles WHERE fingerprint = $1",
        [fingerprint],
      )
    ).rows[0].id;
  await ctx.client.query(
    `INSERT INTO kith.embedding_generations
       (id, space_id, created_at, embedding_profile_id, fingerprint, state)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, 'active')`,
    [generationId, spaceId, usedProfileId, fingerprint],
  );
  await ctx.client.query(
    `INSERT INTO kith.space_embedding_states
       (id, space_id, created_at, eligibility_epoch, active_embedding_generation_id,
        active_fingerprint, eligible_counts, covered_counts, counter_drift, last_audit_at)
     VALUES ($1, $2, transaction_timestamp(), 1, $3, $4, $5::jsonb, $6::jsonb, false,
             transaction_timestamp())`,
    [
      stateId,
      spaceId,
      generationId,
      fingerprint,
      JSON.stringify(eligible),
      JSON.stringify([{ fingerprint, counts: covered }]),
    ],
  );
  return { fingerprint, profileId: usedProfileId, generationId, stateId };
}

/**
 * An eligible target row: the live eligibility record I7 rechecks against.
 *
 * An upsert, because `(space_id, target_kind, target_id)` is unique as of
 * migration 016 and because a target may already exist: `captureThought`
 * creates one for every new thought on a counted space. Seeding after it is
 * how a test says "and this is the vector that covers it".
 */
export async function seedEmbeddingTarget(ctx, input) {
  const id = newKithId();
  const written = await ctx.client.query(
    `INSERT INTO kith.embedding_targets
       (id, space_id, created_at, target_kind, target_id, input_hash,
        processing_generation_id, state, covered_fingerprint, updated_at)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7, $8,
             transaction_timestamp())
     ON CONFLICT (space_id, target_kind, target_id) DO UPDATE
       SET input_hash = EXCLUDED.input_hash,
           processing_generation_id = EXCLUDED.processing_generation_id,
           state = EXCLUDED.state,
           covered_fingerprint = EXCLUDED.covered_fingerprint,
           updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      id,
      input.spaceId,
      input.targetKind,
      input.targetId,
      input.inputHash,
      input.processingGenerationId ?? null,
      input.state ?? "eligible",
      input.coveredFingerprint ?? input.fingerprint,
    ],
  );
  return written.rows[0].id;
}

/**
 * Sets a space's counters to what its target rows actually say, which is what
 * a clean audit would leave behind.
 *
 * A test uses this when it seeded an opening balance, then wrote rows through
 * a real writer, and wants the two to agree before it reads a coverage-gated
 * surface. A test proving a shortfall states the shortfall instead.
 */
export async function recountEmbeddingCounters(ctx, spaceId, fingerprint) {
  const counted = await ctx.client.query(
    `SELECT target_kind,
            count(*) FILTER (WHERE state = 'eligible')::int AS eligible,
            count(*) FILTER (WHERE state = 'eligible'
                               AND covered_fingerprint = $2)::int AS covered
       FROM kith.embedding_targets WHERE space_id = $1
      GROUP BY target_kind`,
    [spaceId, fingerprint],
  );
  const eligible = { thought: 0, chunk: 0, card: 0 };
  const covered = { thought: 0, chunk: 0, card: 0 };
  for (const row of counted.rows) {
    eligible[row.target_kind] = row.eligible;
    covered[row.target_kind] = row.covered;
  }
  await ctx.client.query(
    `UPDATE kith.space_embedding_states
        SET eligible_counts = $2::jsonb, covered_counts = $3::jsonb,
            counter_drift = false, counter_drift_reason = NULL,
            last_audit_at = transaction_timestamp()
      WHERE space_id = $1`,
    [
      spaceId,
      JSON.stringify(eligible),
      JSON.stringify([{ fingerprint, counts: covered }]),
    ],
  );
  return { eligible, covered };
}

/** One vector row, with its two scope encodings written the way a fill would. */
export async function seedEmbeddingVector(ctx, input) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.embedding_vectors
       (id, space_id, created_at, embedding_generation_id, embedding_fingerprint,
        target_kind, search_scope, thought_id, chunk_id, event_id,
        processing_generation_id, input_hash, embedding, scope_v2)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12::public.vector, $13)`,
    [
      id,
      input.spaceId,
      input.embeddingGenerationId,
      input.fingerprint,
      input.targetKind,
      input.searchScope ??
        searchScope(
          input.spaceId,
          input.fingerprint,
          input.embeddingGenerationId,
          input.targetKind,
        ),
      input.thoughtId ?? null,
      input.chunkId ?? null,
      input.eventId ?? null,
      input.processingGenerationId ?? null,
      input.inputHash,
      vectorLiteral(input.vector),
      input.scopeV2 ??
        scopeV2(input.spaceId, input.fingerprint, input.targetKind),
    ],
  );
  return id;
}

/**
 * A thought plus the target and vector rows that make it reachable by the
 * vector leg. `input_hash` is the content hash the I7 recheck recomputes, so
 * it is derived rather than supplied.
 */
export async function seedThoughtVector(ctx, input) {
  const inputHash = await sha256Utf8(input.content);
  await seedEmbeddingTarget(ctx, {
    spaceId: input.spaceId,
    targetKind: "thought",
    targetId: input.thoughtId,
    inputHash,
    fingerprint: input.fingerprint,
  });
  return await seedEmbeddingVector(ctx, {
    spaceId: input.spaceId,
    embeddingGenerationId: input.embeddingGenerationId,
    fingerprint: input.fingerprint,
    targetKind: "thought",
    thoughtId: input.thoughtId,
    inputHash,
    vector: input.vector,
  });
}

// ---------------------------------------------------------------------------
// P2-39g2: the rows the *write* side reads before it will call something a
// target.
// ---------------------------------------------------------------------------

/**
 * One source item with the whole parent chain `resolveActiveChunkTarget`
 * validates: account, item, revision, sealed text version, ready generation,
 * active document and its chunks.
 *
 * `embeddingSearch.test.mjs` has a shorter `seedDocumentChain` of its own. It
 * stops before the revision and the text version because the retrieval legs
 * never read them; the build's chunk scan does, and a chain missing either is
 * a fault it reports rather than a chunk it skips. Both are kept: the shorter
 * one is the honest minimum for what it proves.
 */
export async function seedIndexableDocument(ctx, spaceId, input) {
  const ids = {
    sourceAccountId: input.sourceAccountId ?? newKithId(),
    sourceItemId: newKithId(),
    sourceRevisionId: newKithId(),
    sourceTextVersionId: newKithId(),
    generationId: newKithId(),
    documentId: newKithId(),
    chunkIds: [],
  };
  if (!input.sourceAccountId) {
    await ctx.client.query(
      `INSERT INTO kith.source_accounts
         (id, space_id, created_at, connector, enabled, embed_full_chunks)
       VALUES ($1, $2, transaction_timestamp(), 'synthetic', true, $3)`,
      [ids.sourceAccountId, spaceId, input.accountOptedIn ?? null],
    );
  }
  await ctx.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id_hash, title,
        lifecycle, original_link_available, desired_processing_epoch,
        active_revision_id, active_generation_id, embed_full_chunks)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, true, 0, $7, $8, $9)`,
    [
      ids.sourceItemId,
      spaceId,
      ids.sourceAccountId,
      externalIdHash(),
      input.title,
      input.lifecycle ?? "available",
      ids.sourceRevisionId,
      ids.generationId,
      input.itemOptedIn ?? null,
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.source_revisions
       (id, space_id, created_at, source_item_id, content_hash, representation)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, 'text')`,
    [ids.sourceRevisionId, spaceId, ids.sourceItemId, "b".repeat(64)],
  );
  await ctx.client.query(
    `INSERT INTO kith.source_text_versions
       (id, space_id, created_at, source_revision_id, representation, text,
        text_hash, evidence_sealed)
     VALUES ($1, $2, transaction_timestamp(), $3, 'text', $4, $5, true)`,
    [
      ids.sourceTextVersionId,
      spaceId,
      ids.sourceRevisionId,
      input.chunks.join("\n"),
      "c".repeat(64),
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id,
        source_revision_id, source_text_version_id, desired_processing_epoch,
        card_generation, state)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 0, false, 'ready')`,
    [
      ids.generationId,
      spaceId,
      ids.sourceAccountId,
      ids.sourceItemId,
      ids.sourceRevisionId,
      ids.sourceTextVersionId,
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.documents
       (id, space_id, created_at, processing_generation_id, source_item_id,
        source_revision_id, source_text_version_id, document_key, title,
        doc_type, captured_at, evidence_span_ids, publication_state)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7, $8, 'note',
             transaction_timestamp(), '[]'::jsonb, 'active')`,
    [
      ids.documentId,
      spaceId,
      ids.generationId,
      ids.sourceItemId,
      ids.sourceRevisionId,
      ids.sourceTextVersionId,
      `doc-${ids.documentId}`,
      input.title,
    ],
  );
  for (const [ordinal, text] of input.chunks.entries()) {
    const chunkId = newKithId();
    ids.chunkIds.push(chunkId);
    await ctx.client.query(
      `INSERT INTO kith.chunks
         (id, space_id, created_at, processing_generation_id, document_id,
          ordinal, source_text_version_id, start, "end", text,
          evidence_span_ids, publication_state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 0, $7, $8,
               '[]'::jsonb, 'active')`,
      [
        chunkId,
        spaceId,
        ids.generationId,
        ids.documentId,
        ordinal,
        ids.sourceTextVersionId,
        text.length,
        text,
      ],
    );
  }
  return ids;
}

/** The generic card of a seeded item: generation, event, version, fields. */
export async function seedGenericCard(ctx, spaceId, chain, input) {
  const cardGenerationId = input.cardGenerationId ?? newKithId();
  const eventId = input.eventId ?? newKithId();
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
  if (!input.eventId) {
    await ctx.client.query(
      `INSERT INTO kith.events
         (id, space_id, created_at, source_account_id, source_item_id, event_key)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'card:document_card')`,
      [eventId, spaceId, chain.sourceAccountId, chain.sourceItemId],
    );
  }
  await ctx.client.query(
    `INSERT INTO kith.event_versions
       (id, space_id, created_at, source_account_id, source_item_id,
        processing_generation_id, event_id, event_type, field_evidence)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'document_card',
             $7::jsonb)`,
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
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7,
               'document_card', $8, $8, $9::jsonb, '[]'::jsonb)`,
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

/**
 * A space whose embedding state exists and is counted but has no active
 * generation: what `startEmbeddingBuild` needs before a fingerprint is live.
 */
export async function seedUnactivatedIndex(ctx, spaceId, fingerprint) {
  await ctx.client.query(
    `INSERT INTO kith.space_embedding_states
       (id, space_id, created_at, eligibility_epoch)
     VALUES ($1, $2, transaction_timestamp(), 0)
     ON CONFLICT (space_id) DO NOTHING`,
    [newKithId(), spaceId],
  );
  return fingerprint;
}

/**
 * A deterministic stand-in for the provider: one distinct unit vector per
 * distinct text, recorded so a test can assert which texts were sent and how
 * many times. No network, and no dependence on an embedding model's output.
 */
export function recordingEmbedder(fingerprint) {
  const calls = [];
  const axes = new Map();
  const embed = async (texts) => {
    calls.push([...texts]);
    return texts.map((text) => {
      if (!axes.has(text)) axes.set(text, axes.size + 1);
      return { vector: oneHot(axes.get(text)), fingerprint };
    });
  };
  embed.calls = calls;
  embed.texts = () => calls.flat();
  return embed;
}
