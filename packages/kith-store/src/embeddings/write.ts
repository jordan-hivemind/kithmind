// P2-39g2: the vector rows themselves. Insert, reuse, replace and delete, with
// the coverage bookkeeping each one owes.
//
// Ported from the vector half of `models/embeddings/model.ts`: `insertVector`,
// `insertThoughtEmbedding`, `insertChunkEmbedding`, `insertCardEmbedding`,
// `releaseVectorCoverage`, `deleteChunkEmbeddingVectors`,
// `deleteThoughtEmbeddingVectors`, `deleteActiveThoughtEmbeddingVectors` and
// `requireActiveEmbeddingTarget`.
//
// I11 is the rule this module exists to enforce. The exclusive slot is
// `(space_id, fingerprint, target_kind, target_id)`, with no generation in it:
// a row an older generation staged under this fingerprint occupies the same
// slot and encodes the same `scope_v2`, so leaving it would put two rows of one
// target in the candidate set and spend two slots of a fixed candidate budget
// on one answer. At most one row survives one of these transactions, and it is
// the one whose `input_hash` matches the text being embedded. Rows under
// another fingerprint are untouched, because a retired fingerprint is the
// rollback artifact.
//
// The vector is bound as the text literal pgvector parses, cast with
// `$n::public.vector`, exactly as the read legs bind a query vector.
// `validateVector` runs before anything is bound, so a malformed vector never
// reaches the server, and `public.` qualification is required because
// `withKithTransaction` pins `search_path` to `kith` alone.

import { exec, row, rows, type IdentityCtx } from "../identity/db.js";
import { newKithId } from "../ids.js";
import { sha256Utf8 } from "../provenance/sql.js";
import {
  CARD_TARGET_EVENT_KEY,
  composeCardTargetInput,
} from "./cardTargets.js";
import {
  bumpEmbeddingEligibilityEpoch,
  isCurrentThought,
  recordVectorCoverageChange,
} from "./eligibility.js";
import { BASELINE_EMBEDDING_DIMENSIONS } from "./provider.js";
import {
  embeddingVectorScopeV2,
  embeddingVectorSearchScope,
  type EmbeddingTargetKind,
} from "./scope.js";
import { uniqueSpaceState } from "./state.js";
import {
  getActiveEmbeddingTarget,
  requireGenerationProfile,
  type ActiveEmbeddingTarget,
} from "./targets.js";

/** A target holds one vector per fingerprint; the spare slots catch a bug. */
const MAX_TARGET_VECTOR_ROWS = 16;

/** The per-target delete page, matching the Convex default and its cap. */
const MAX_VECTOR_DELETE_PAGE = 25;

export type EmbeddingVectorRow = {
  id: string;
  space_id: string;
  embedding_generation_id: string;
  embedding_fingerprint: string;
  target_kind: string;
  search_scope: string | null;
  thought_id: string | null;
  chunk_id: string | null;
  event_id: string | null;
  processing_generation_id: string | null;
  input_hash: string;
  scope_v2: string;
  /** The vector itself, read back as pgvector's text literal. */
  embedding: string;
};

const VECTOR_COLUMNS = `id, space_id, embedding_generation_id,
  embedding_fingerprint, target_kind, search_scope, thought_id, chunk_id,
  event_id, processing_generation_id, input_hash, scope_v2,
  embedding::text AS embedding`;

type WritableGenerationRow = {
  id: string;
  space_id: string;
  embedding_profile_id: string | null;
  fingerprint: string | null;
  state: string | null;
  deactivated_at: Date | null;
};

/** Ported from `validateVector`, then rendered as pgvector's literal. */
export function embeddingVectorLiteral(vector: readonly number[]): string {
  if (
    !Array.isArray(vector) ||
    vector.length !== BASELINE_EMBEDDING_DIMENSIONS ||
    !vector.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) ||
    !vector.some((value) => value !== 0)
  ) {
    throw new Error(
      `Embedding vector must contain ${BASELINE_EMBEDDING_DIMENSIONS} finite numbers and must not be all zero`,
    );
  }
  return `[${vector.join(",")}]`;
}

/**
 * Section 3.4 point 2 holds only for a *new* fingerprint: a staged generation
 * is invisible to readers because no reader names its fingerprint. Under the
 * active fingerprint there is no such window. I11 would make a staging driver's
 * inserts delete and replace live rows before activation, and I3 means a second
 * generation of the same fingerprint is the same row set anyway. The
 * incremental fill is the only writer under the active fingerprint.
 */
export function assertStagingFingerprintIsNew(
  state: { active_fingerprint: string | null },
  fingerprint: string,
): void {
  if (state.active_fingerprint === fingerprint) {
    throw new Error(
      "Staging a generation under the active fingerprint is retired; the incremental fill owns that index",
    );
  }
}

/**
 * Ported from `requireActiveEmbeddingTarget`. Write paths still pin the
 * generation; readers pin the fingerprint.
 */
export async function requireActiveEmbeddingTarget(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    embeddingGenerationId?: string;
    fingerprint: string;
  },
): Promise<ActiveEmbeddingTarget> {
  const active = await getActiveEmbeddingTarget(ctx, input.spaceId);
  if (
    !active ||
    active.fingerprint !== input.fingerprint ||
    (input.embeddingGenerationId !== undefined &&
      active.embeddingGenerationId !== input.embeddingGenerationId)
  ) {
    throw new Error("Embedding target is no longer active");
  }
  return active;
}

/**
 * Every vector row a target holds, in any space, fingerprint or generation.
 * Bounded: a target holds one row per fingerprint and a space keeps an active
 * plus a retained one, so the spare slots only ever catch a bug.
 */
async function targetVectorRows(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    kind: EmbeddingTargetKind;
    targetId: string;
    limit?: number;
    forUpdate?: boolean;
  },
): Promise<EmbeddingVectorRow[]> {
  const column =
    input.kind === "thought"
      ? "thought_id"
      : input.kind === "card"
        ? "event_id"
        : "chunk_id";
  const limit = input.limit ?? MAX_TARGET_VECTOR_ROWS + 1;
  const found = await rows<EmbeddingVectorRow>(
    ctx,
    `SELECT ${VECTOR_COLUMNS} FROM kith.embedding_vectors
      WHERE ${column} = $1 AND space_id = $3
      ORDER BY created_at, id LIMIT $2${input.forUpdate ? " FOR UPDATE" : ""}`,
    [input.targetId, limit, input.spaceId],
  );
  if (input.limit === undefined && found.length > MAX_TARGET_VECTOR_ROWS) {
    throw new Error("Embedding target exceeds its vector row budget");
  }
  return found;
}

function vectorTargetId(record: EmbeddingVectorRow): string | null {
  return record.target_kind === "thought"
    ? record.thought_id
    : record.target_kind === "card"
      ? record.event_id
      : record.chunk_id;
}

/**
 * I4, delete half: drops the coverage marker the deleted row was holding.
 *
 * It is a no-op unless the target's marker still names this row's fingerprint,
 * so releasing twice for one target cannot drive a counter negative. A caller
 * deleting a duplicate rather than the last row of a target must not call it.
 */
export async function releaseVectorCoverage(
  ctx: IdentityCtx,
  record: EmbeddingVectorRow,
): Promise<void> {
  const targetId = vectorTargetId(record);
  if (!targetId) return;
  if (
    record.target_kind !== "thought" &&
    record.target_kind !== "chunk" &&
    record.target_kind !== "card"
  ) {
    return;
  }
  await recordVectorCoverageChange(ctx, {
    spaceId: record.space_id,
    targetKind: record.target_kind,
    targetId,
    fingerprint: record.embedding_fingerprint,
    inputHash: record.input_hash,
    covered: false,
  });
}

/**
 * Space-scoped by predicate, not only by the caller's check: section 2.5 of
 * the consolidation plan wants every statement on a space-scoped table to
 * carry its own space predicate, so a future caller that forgets the check
 * cannot reach another space's row.
 */
async function deleteVectorRow(
  ctx: IdentityCtx,
  spaceId: string,
  id: string,
): Promise<void> {
  await exec(
    ctx,
    "DELETE FROM kith.embedding_vectors WHERE id = $1 AND space_id = $2",
    [id, spaceId],
  );
}

/** Two pgvector literals are equal exactly when their texts are. */
function sameVectorLiteral(stored: string, supplied: string): boolean {
  return stored === supplied;
}

async function insertVector(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    embeddingGenerationId: string;
    fingerprint: string;
    kind: EmbeddingTargetKind;
    thoughtId?: string;
    chunkId?: string;
    eventId?: string;
    processingGenerationId?: string | null;
    inputText: string;
    vector: readonly number[];
  },
): Promise<{
  id: string;
  inserted: boolean;
  generationState: "staging" | "active";
  activeTarget: ActiveEmbeddingTarget | null;
}> {
  const literal = embeddingVectorLiteral(input.vector);
  const generation = await row<WritableGenerationRow>(
    ctx,
    `SELECT id, space_id, embedding_profile_id, fingerprint, state, deactivated_at
       FROM kith.embedding_generations WHERE id = $1 FOR UPDATE`,
    [input.embeddingGenerationId],
  );
  if (
    !generation ||
    generation.space_id !== input.spaceId ||
    generation.fingerprint !== input.fingerprint ||
    (generation.state !== "staging" && generation.state !== "active")
  ) {
    throw new Error("Embedding vector generation is not writable");
  }
  await requireGenerationProfile(ctx, generation);
  if (generation.state === "staging") {
    const state = await uniqueSpaceState(ctx, input.spaceId);
    if (state) assertStagingFingerprintIsNew(state, input.fingerprint);
  }
  const activeTarget =
    generation.state === "active"
      ? await requireActiveEmbeddingTarget(ctx, {
          spaceId: input.spaceId,
          embeddingGenerationId: generation.id,
          fingerprint: input.fingerprint,
        })
      : null;
  const targetId =
    input.kind === "thought"
      ? input.thoughtId
      : input.kind === "card"
        ? input.eventId
        : input.chunkId;
  if (!targetId) throw new Error("Embedding vector target is missing");
  const inputHash = await sha256Utf8(input.inputText);
  const scopeV2 = embeddingVectorScopeV2({
    spaceId: input.spaceId,
    fingerprint: input.fingerprint,
    targetKind: input.kind,
  });
  // I11, in full. See the module comment.
  const siblings = (
    await targetVectorRows(ctx, {
      spaceId: input.spaceId,
      kind: input.kind,
      targetId,
      forUpdate: true,
    })
  ).filter(
    (record) =>
      record.space_id === input.spaceId &&
      record.embedding_fingerprint === input.fingerprint &&
      record.target_kind === input.kind,
  );
  // I3: an unchanged target keeps its row across generations of one
  // fingerprint. Prefer this generation's row so a replay is a plain no-op.
  const existing =
    siblings.find(
      (record) =>
        record.input_hash === inputHash &&
        record.embedding_generation_id === generation.id,
    ) ?? siblings.find((record) => record.input_hash === inputHash);
  for (const record of siblings) {
    if (existing && record.id === existing.id) continue;
    await releaseVectorCoverage(ctx, record);
    await deleteVectorRow(ctx, record.space_id, record.id);
  }
  const parent = input.processingGenerationId ?? null;
  if (existing) {
    if (
      (existing.processing_generation_id ?? null) !== parent ||
      existing.search_scope !==
        embeddingVectorSearchScope({
          spaceId: existing.space_id,
          fingerprint: existing.embedding_fingerprint,
          embeddingGenerationId: existing.embedding_generation_id,
          targetKind: input.kind,
        }) ||
      !sameVectorLiteral(existing.embedding, literal)
    ) {
      throw new Error("Conflicting immutable embedding vector");
    }
    // A row written before the scope_v2 backfill is invisible to the reader.
    // Naming its own slot is derived identity, not content, so I1 holds.
    if (existing.scope_v2 !== scopeV2) {
      await exec(
        ctx,
        "UPDATE kith.embedding_vectors SET scope_v2 = $2 WHERE id = $1",
        [existing.id, scopeV2],
      );
    }
    await recordVectorCoverageChange(ctx, {
      spaceId: input.spaceId,
      targetKind: input.kind,
      targetId,
      fingerprint: input.fingerprint,
      inputHash,
      covered: true,
    });
    return {
      id: existing.id,
      inserted: false,
      generationState: generation.state,
      activeTarget,
    };
  }
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.embedding_vectors
       (id, space_id, created_at, embedding_generation_id, embedding_fingerprint,
        target_kind, search_scope, thought_id, chunk_id, event_id,
        processing_generation_id, input_hash, embedding, scope_v2)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12::public.vector, $13)`,
    [
      id,
      input.spaceId,
      generation.id,
      input.fingerprint,
      input.kind,
      embeddingVectorSearchScope({
        spaceId: input.spaceId,
        fingerprint: input.fingerprint,
        embeddingGenerationId: generation.id,
        targetKind: input.kind,
      }),
      input.thoughtId ?? null,
      input.chunkId ?? null,
      input.eventId ?? null,
      parent,
      inputHash,
      literal,
      scopeV2,
    ],
  );
  await recordVectorCoverageChange(ctx, {
    spaceId: input.spaceId,
    targetKind: input.kind,
    targetId,
    fingerprint: input.fingerprint,
    inputHash,
    covered: true,
  });
  return {
    id,
    inserted: true,
    generationState: generation.state,
    activeTarget,
  };
}

export async function insertThoughtEmbedding(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    thoughtId: string;
    embeddingGenerationId: string;
    fingerprint: string;
    inputText: string;
    vector: readonly number[];
    bumpEligibility?: boolean;
  },
): Promise<string> {
  const thought = await row<{
    id: string;
    space_id: string;
    content: string;
  }>(ctx, "SELECT id, space_id, content FROM kith.thoughts WHERE id = $1", [
    input.thoughtId,
  ]);
  if (
    !thought ||
    thought.space_id !== input.spaceId ||
    thought.content !== input.inputText
  ) {
    throw new Error(
      "Thought embedding target does not match its content or space",
    );
  }
  const result = await insertVector(ctx, { ...input, kind: "thought" });
  if (input.bumpEligibility ?? true) {
    await bumpEmbeddingEligibilityEpoch(ctx, input.spaceId);
  }
  return result.id;
}

export async function insertChunkEmbedding(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    chunkId: string;
    embeddingGenerationId: string;
    fingerprint: string;
    inputText: string;
    vector: readonly number[];
    bumpEligibility?: boolean;
  },
): Promise<string> {
  const chunk = await row<{
    id: string;
    space_id: string;
    text: string | null;
    processing_generation_id: string | null;
  }>(
    ctx,
    `SELECT id, space_id, text, processing_generation_id
       FROM kith.chunks WHERE id = $1`,
    [input.chunkId],
  );
  if (
    !chunk ||
    chunk.space_id !== input.spaceId ||
    chunk.text !== input.inputText ||
    chunk.processing_generation_id === null
  ) {
    throw new Error(
      "Chunk embedding target does not match its content or space",
    );
  }
  const result = await insertVector(ctx, {
    ...input,
    kind: "chunk",
    processingGenerationId: chunk.processing_generation_id,
  });
  if (
    (input.bumpEligibility ?? true) &&
    result.generationState === "active" &&
    result.inserted
  ) {
    await bumpEmbeddingEligibilityEpoch(ctx, input.spaceId);
  }
  return result.id;
}

/**
 * Section 8.1: one vector per accepted generic card. The card target's identity
 * is its `events` row, so this insert never depends on which card generation
 * published the text, and a re-extraction over unchanged fields finds its own
 * vector already present (I3).
 */
export async function insertCardEmbedding(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    eventId: string;
    embeddingGenerationId: string;
    fingerprint: string;
    inputText: string;
    vector: readonly number[];
    bumpEligibility?: boolean;
  },
): Promise<string> {
  const event = await row<{
    id: string;
    space_id: string;
    source_item_id: string | null;
    event_key: string | null;
  }>(
    ctx,
    "SELECT id, space_id, source_item_id, event_key FROM kith.events WHERE id = $1",
    [input.eventId],
  );
  if (
    !event ||
    event.space_id !== input.spaceId ||
    event.event_key !== CARD_TARGET_EVENT_KEY ||
    !event.source_item_id
  ) {
    throw new Error("Card embedding target is not a generic card event");
  }
  const composed = await composeCardTargetInput(
    ctx,
    input.spaceId,
    event.source_item_id,
    event,
  );
  if (!composed || composed.text !== input.inputText) {
    throw new Error("Card embedding target does not match its composed input");
  }
  const result = await insertVector(ctx, { ...input, kind: "card" });
  if (
    (input.bumpEligibility ?? true) &&
    result.generationState === "active" &&
    result.inserted
  ) {
    await bumpEmbeddingEligibilityEpoch(ctx, input.spaceId);
  }
  return result.id;
}

async function deleteTargetVectors(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    kind: "thought" | "chunk";
    targetId: string;
    limit?: number;
  },
): Promise<{ deleted: number; done: boolean }> {
  const limit = Math.min(
    Math.max(input.limit ?? MAX_VECTOR_DELETE_PAGE, 1),
    MAX_VECTOR_DELETE_PAGE,
  );
  const found = await targetVectorRows(ctx, {
    spaceId: input.spaceId,
    kind: input.kind,
    targetId: input.targetId,
    limit: limit + 1,
    forUpdate: true,
  });
  for (const record of found.slice(0, limit)) {
    if (
      record.space_id !== input.spaceId ||
      record.target_kind !== input.kind
    ) {
      throw new Error(
        `${input.kind === "thought" ? "Thought" : "Chunk"} embedding cleanup found an invalid vector parent`,
      );
    }
    await releaseVectorCoverage(ctx, record);
    await deleteVectorRow(ctx, record.space_id, record.id);
  }
  return {
    deleted: Math.min(found.length, limit),
    done: found.length <= limit,
  };
}

export async function deleteChunkEmbeddingVectors(
  ctx: IdentityCtx,
  input: { spaceId: string; chunkId: string; limit?: number },
): Promise<{ deleted: number; done: boolean }> {
  return await deleteTargetVectors(ctx, {
    spaceId: input.spaceId,
    kind: "chunk",
    targetId: input.chunkId,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

export async function deleteThoughtEmbeddingVectors(
  ctx: IdentityCtx,
  input: { spaceId: string; thoughtId: string; limit?: number },
): Promise<{ deleted: number; done: boolean }> {
  return await deleteTargetVectors(ctx, {
    spaceId: input.spaceId,
    kind: "thought",
    targetId: input.thoughtId,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

/**
 * Removes a no-longer-current thought's rows under the active fingerprint, in
 * every generation.
 *
 * Since the generation left the reader's filter, those rows share one
 * `scope_v2` with the active generation's, so leaving one behind leaves a
 * superseded memory's vector in the candidate set until I7 drops it at
 * hydration, after it has already spent a candidate slot. Rows of another
 * fingerprint are left alone: the retired fingerprint is the rollback artifact.
 */
export async function deleteActiveThoughtEmbeddingVectors(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    embeddingGenerationId: string;
    fingerprint: string;
    thoughtIds: readonly string[];
  },
): Promise<number> {
  if (input.thoughtIds.length < 1 || input.thoughtIds.length > 10) {
    throw new Error("Active thought embedding cleanup requires 1-10 targets");
  }
  await requireActiveEmbeddingTarget(ctx, input);
  let deleted = 0;
  for (const thoughtId of [...new Set(input.thoughtIds)]) {
    const thought = await row<{
      id: string;
      space_id: string;
      memory_status: string | null;
    }>(
      ctx,
      "SELECT id, space_id, memory_status FROM kith.thoughts WHERE id = $1",
      [thoughtId],
    );
    if (
      !thought ||
      thought.space_id !== input.spaceId ||
      isCurrentThought(thought)
    ) {
      throw new Error(
        "Active thought embedding cleanup target is still current",
      );
    }
    const found = (
      await targetVectorRows(ctx, {
        spaceId: input.spaceId,
        kind: "thought",
        targetId: thoughtId,
        forUpdate: true,
      })
    ).filter(
      (record) =>
        record.space_id === input.spaceId &&
        record.embedding_fingerprint === input.fingerprint,
    );
    for (const record of found) {
      if (
        record.target_kind !== "thought" ||
        record.chunk_id !== null ||
        record.processing_generation_id !== null ||
        record.search_scope !==
          embeddingVectorSearchScope({
            spaceId: input.spaceId,
            fingerprint: input.fingerprint,
            // The row names its own generation, which is the point: a row of
            // an older generation is exactly what this has to remove.
            embeddingGenerationId: record.embedding_generation_id,
            targetKind: "thought",
          })
      ) {
        throw new Error("Active thought embedding vector has invalid identity");
      }
      await releaseVectorCoverage(ctx, record);
      await deleteVectorRow(ctx, record.space_id, record.id);
      deleted += 1;
    }
  }
  return deleted;
}
