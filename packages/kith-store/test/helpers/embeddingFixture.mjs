// P2-39g1 fixtures: the rows a space needs before the retrieval legs in
// `src/embeddings/search.ts` will look at it, plus hand-built vectors.
//
// Built on the memory fixture's migrated throwaway database, because the
// thought and fact legs are the memory domain's rows and the document legs
// need the same schema. Every row here is seeded with raw SQL: the writers
// that own these tables (the embedding build driver, the card extractor)
// belong to other slices, and a retrieval test that could only run after
// them would prove nothing about retrieval.

import { newKithId } from "../../dist/index.js";
import { fingerprintEmbeddingConfig } from "../../dist/embeddings/index.js";

export const DIMENSIONS = 1536;

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
  await ctx.client.query(
    `INSERT INTO kith.embedding_profiles
       (id, created_at, fingerprint, protocol, provider_id, model, model_revision,
        dimensions, normalization, preprocessing)
     VALUES ($1, transaction_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9)`,
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
  await ctx.client.query(
    `INSERT INTO kith.embedding_generations
       (id, space_id, created_at, embedding_profile_id, fingerprint, state)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, 'active')`,
    [generationId, spaceId, profileId, fingerprint],
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
  return { fingerprint, profileId, generationId, stateId };
}

/** An eligible target row: the live eligibility record I7 rechecks against. */
export async function seedEmbeddingTarget(ctx, input) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.embedding_targets
       (id, space_id, created_at, target_kind, target_id, input_hash,
        processing_generation_id, state, covered_fingerprint, updated_at)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7, $8,
             transaction_timestamp())`,
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
  return id;
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
