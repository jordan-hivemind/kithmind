// The two scope encodings, ported verbatim.
//
// `embeddingVectorScopeV2` is from packages/convex/convex/models/embeddings/
// targets.ts and `embeddingVectorSearchScope` from models/embeddings/model.ts.
// Both are pure fixed-position JSON encodings and both are copied character
// for character, because the strings they produce are *stored* in
// `kith.embedding_vectors.scope_v2` and `.search_scope`: a row written by
// Convex and a row written here have to encode the same scope identically or
// the reader's integrity recheck rejects a perfectly good row.
//
// On PostgreSQL `scope_v2` is no longer how a candidate scan finds rows --
// section 2.7 of docs/plans/2026-09-12-postgres-consolidation.md replaces the
// Convex filter field with an ordinary `WHERE` on
// `(space_id, embedding_fingerprint, target_kind)` and its index. What
// survives is the *recheck*: the ported resolvers recompute the scope from
// the row's own space, fingerprint and kind and drop a row whose stored
// `scope_v2` disagrees, exactly as `resolveAuthorizedThoughtVectorCandidates`
// and its chunk and card siblings do.

export type EmbeddingTargetKind = "thought" | "chunk" | "card";

/** I2: the generation-free vector scope, space first. */
export function embeddingVectorScopeV2(input: {
  spaceId: string;
  fingerprint: string;
  targetKind: EmbeddingTargetKind;
}): string {
  return JSON.stringify([
    "embedding-vector-scope-v2",
    String(input.spaceId),
    input.fingerprint,
    input.targetKind,
  ]);
}

/** The generation-pinned scope a write still records alongside the v2 one. */
export function embeddingVectorSearchScope(input: {
  spaceId: string;
  fingerprint: string;
  embeddingGenerationId: string;
  targetKind: EmbeddingTargetKind;
}): string {
  return JSON.stringify([
    "embedding-vector-scope-v1",
    String(input.spaceId),
    input.fingerprint,
    String(input.embeddingGenerationId),
    input.targetKind,
  ]);
}
