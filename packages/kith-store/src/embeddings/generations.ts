// P2-39g2: the generation lifecycle. Create, stage vectors, stage, activate,
// fail.
//
// Ported from `models/embeddings/model.ts` (`deriveEmbeddingManifest`,
// `createEmbeddingGeneration`, `getStagingEmbeddingManifestInputs`,
// `stageEmbeddingGeneration`, `activateEmbeddingGeneration`,
// `failEmbeddingGeneration`) and the operator entry points in
// `models/embeddings/operator.ts` that drive them (`stageVectorBatch` becomes
// `stageEmbeddingVectorBatch` below; the rest were one-line wrappers whose
// bodies are already these functions).
//
// This is the *profile-transition* path: one new fingerprint, staged whole and
// flipped atomically. It keeps the Convex manifest bounds verbatim (256
// targets, 2 MiB, 256 vector rows) rather than paging, because section 2.4 of
// the consolidation plan says to keep the proven page sizes and because a
// new-fingerprint rebuild above that size is what the paged builder in
// `build.ts` is for. The bound is a refusal, not a truncation: a manifest that
// does not fit throws `EmbeddingManifestLimitError` rather than returning a
// partial one that staging would then call complete.
//
// Activation is one transaction and it carries the real generation shape, not
// a synthetic pointer flip: it revalidates the manifest, checks every staged
// vector against it target by target, retires the previous generation under
// compare-and-set on `expectedPreviousGenerationId`, moves the active pointer,
// and seeds the target table and counters from the manifest it just validated.
// A second activation therefore leaves exactly one `active` generation and the
// read side sees the new one.

import { at, exec, row, rows, type IdentityCtx } from "../identity/db.js";
import { newKithId } from "../ids.js";
import { sha256Utf8 } from "../provenance/sql.js";
import {
  newChunkTargetCaches,
  resolveActiveChunkTarget,
  type ChunkRow,
} from "./chunkTargets.js";
import { isCurrentThought, seedTargetsFromManifest } from "./eligibility.js";
import { utf8ByteLength, type EmbeddingProfile } from "./provider.js";
import { embeddingVectorSearchScope } from "./scope.js";
import {
  countOf,
  ensureEmbeddingProfile,
  ensureSpaceEmbeddingState,
  uniqueSpaceState,
} from "./state.js";
import { requireGenerationProfile } from "./targets.js";
import {
  assertStagingFingerprintIsNew,
  embeddingVectorLiteral,
  insertChunkEmbedding,
  insertThoughtEmbedding,
} from "./write.js";

/**
 * Whole-space manifest bounds, ported verbatim. They bind the
 * profile-transition driver and the baseline audit; an ordinary eligibility
 * write pays no scan and cannot fail on them.
 */
export const MAX_EMBEDDING_MANIFEST_TARGETS = 256;
export const MAX_EMBEDDING_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_EMBEDDING_VECTOR_ROWS = 256;
export const MAX_EMBEDDING_MANIFEST_SCAN_ROWS = 256;

const MAX_FAILURE_CODE_LENGTH = 100;
const MAX_FAILURE_MESSAGE_LENGTH = 1_000;

/** One staged batch, matching the operator's 1-10 targets per call. */
const MAX_STAGED_VECTOR_BATCH = 10;

export class EmbeddingManifestLimitError extends Error {}

export type ManifestTargetKind = "thought" | "chunk";

export type ManifestTarget = {
  kind: ManifestTargetKind;
  targetId: string;
  inputHash: string;
  processingGenerationId?: string;
};

export type EmbeddingManifest = {
  hash: string;
  thoughtCount: number;
  chunkCount: number;
  targets: ManifestTarget[];
};

export type EmbeddingManifestInput =
  | {
      targetKind: "thought";
      thoughtId: string;
      inputText: string;
      inputHash: string;
    }
  | {
      targetKind: "chunk";
      chunkId: string;
      processingGenerationId: string;
      inputText: string;
      inputHash: string;
    };

export type EmbeddingGenerationRecord = {
  id: string;
  space_id: string;
  embedding_profile_id: string | null;
  fingerprint: string | null;
  state: string | null;
  eligibility_epoch: string | number | null;
  manifest_hash: string | null;
  expected_thought_count: string | number | null;
  expected_chunk_count: string | number | null;
  completed_thought_count: string | number | null;
  completed_chunk_count: string | number | null;
  created_at_field: Date | null;
  staged_at: Date | null;
  activated_at: Date | null;
  deactivated_at: Date | null;
};

const GENERATION_COLUMNS = `id, space_id, embedding_profile_id, fingerprint,
  state, eligibility_epoch, manifest_hash, expected_thought_count,
  expected_chunk_count, completed_thought_count, completed_chunk_count,
  created_at_field, staged_at, activated_at, deactivated_at`;

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite timestamp`);
  }
}

function targetKey(target: { kind: string; targetId: string }): string {
  return `${target.kind}:${target.targetId}`;
}

export async function getEmbeddingGeneration(
  ctx: IdentityCtx,
  id: string,
  forUpdate = false,
): Promise<EmbeddingGenerationRecord | null> {
  return await row<EmbeddingGenerationRecord>(
    ctx,
    `SELECT ${GENERATION_COLUMNS} FROM kith.embedding_generations
      WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
}

/** Millisecond epoch of a generation clock column, or undefined. */
function msOf(value: Date | null): number | undefined {
  return value === null ? undefined : value.getTime();
}

/**
 * Derives the complete active target set inside fixed global row and byte
 * budgets. It throws instead of returning a partial manifest.
 */
export async function deriveEmbeddingManifest(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<EmbeddingManifest> {
  const thoughts = await rows<{
    id: string;
    space_id: string;
    content: string;
    memory_status: string | null;
  }>(
    ctx,
    `SELECT id, space_id, content, memory_status FROM kith.thoughts
      WHERE space_id = $1 ORDER BY created_at, id LIMIT $2`,
    [spaceId, MAX_EMBEDDING_MANIFEST_SCAN_ROWS + 1],
  );
  if (thoughts.length > MAX_EMBEDDING_MANIFEST_SCAN_ROWS) {
    throw new EmbeddingManifestLimitError(
      "Embedding target manifest exceeds its global scan budget",
    );
  }

  const targets: ManifestTarget[] = [];
  let estimatedBytes = 0;
  for (const thought of thoughts) {
    if (!isCurrentThought(thought)) continue;
    // The Convex original added the thought's retained legacy vector to this
    // estimate. Section 5.1 of the consolidation plan exports that field to a
    // cold audit file rather than creating a column for it, so the only bytes
    // a thought target costs here are its text.
    estimatedBytes += utf8ByteLength(thought.content);
    targets.push({
      kind: "thought",
      targetId: thought.id,
      inputHash: await sha256Utf8(thought.content),
    });
  }

  if (targets.length > MAX_EMBEDDING_MANIFEST_TARGETS) {
    throw new EmbeddingManifestLimitError(
      "Embedding target manifest exceeds its global row budget",
    );
  }

  const remaining = MAX_EMBEDDING_MANIFEST_TARGETS - targets.length;
  const chunks = await rows<ChunkRow>(
    ctx,
    `SELECT id, space_id, processing_generation_id, document_id, text,
            publication_state
       FROM kith.chunks
      WHERE space_id = $1 AND publication_state = 'active'
      ORDER BY created_at, id LIMIT $2`,
    [spaceId, remaining + 1],
  );
  if (chunks.length > remaining) {
    throw new EmbeddingManifestLimitError(
      "Embedding target manifest exceeds its global row budget",
    );
  }

  const caches = newChunkTargetCaches();
  for (const chunk of chunks) {
    estimatedBytes += utf8ByteLength(chunk.text ?? "");
    const resolved = await resolveActiveChunkTarget(
      ctx,
      spaceId,
      chunk,
      caches,
    );
    if (!resolved) continue;
    targets.push({
      kind: "chunk",
      targetId: chunk.id,
      inputHash: await sha256Utf8(chunk.text ?? ""),
      processingGenerationId: resolved.processingGenerationId,
    });
  }
  if (estimatedBytes > MAX_EMBEDDING_MANIFEST_BYTES) {
    throw new EmbeddingManifestLimitError(
      "Embedding target manifest exceeds its global byte budget",
    );
  }

  targets.sort((left, right) =>
    targetKey(left).localeCompare(targetKey(right)),
  );
  const hash = await sha256Utf8(
    JSON.stringify([
      "embedding-target-manifest-v1",
      ...targets.map((target) => [
        target.kind,
        target.targetId,
        target.inputHash,
        target.processingGenerationId ?? null,
      ]),
    ]),
  );
  return {
    hash,
    thoughtCount: targets.filter((target) => target.kind === "thought").length,
    chunkCount: targets.filter((target) => target.kind === "chunk").length,
    targets,
  };
}

export async function createEmbeddingGeneration(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    profile: EmbeddingProfile;
    fingerprint: string;
    createdAt?: number;
  },
): Promise<EmbeddingGenerationRecord> {
  const createdAt = input.createdAt ?? ctx.now;
  assertFiniteTime(createdAt, "Embedding generation creation time");
  const state = await ensureSpaceEmbeddingState(ctx, input.spaceId);
  assertStagingFingerprintIsNew(state, input.fingerprint);
  const profile = await ensureEmbeddingProfile(ctx, { ...input, createdAt });
  const manifest = await deriveEmbeddingManifest(ctx, input.spaceId);
  const unfinished = await rows<{ id: string }>(
    ctx,
    `SELECT id FROM kith.embedding_generations
      WHERE space_id = $1 AND state = 'staging' LIMIT 1`,
    [input.spaceId],
  );
  if (unfinished.length > 0) {
    throw new Error("Space already has a staging embedding generation");
  }
  const staged = await rows<{ id: string }>(
    ctx,
    `SELECT id FROM kith.embedding_generations
      WHERE space_id = $1 AND state = 'staged' LIMIT 1`,
    [input.spaceId],
  );
  if (staged.length > 0) {
    throw new Error("Space already has a staged embedding generation");
  }
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.embedding_generations
       (id, space_id, created_at, embedding_profile_id, fingerprint, state,
        eligibility_epoch, manifest_hash, expected_thought_count,
        expected_chunk_count, completed_thought_count, completed_chunk_count,
        coverage_invalid, created_at_field)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, 'staging', $5, $6, $7, $8,
             0, 0, false, $9)`,
    [
      id,
      input.spaceId,
      profile.id,
      input.fingerprint,
      countOf(state.eligibility_epoch, "Eligibility epoch"),
      manifest.hash,
      manifest.thoughtCount,
      manifest.chunkCount,
      at(createdAt),
    ],
  );
  const created = await getEmbeddingGeneration(ctx, id);
  if (!created) throw new Error("Embedding generation not found");
  return created;
}

async function requireUnchangedManifest(
  ctx: IdentityCtx,
  generation: EmbeddingGenerationRecord,
): Promise<EmbeddingManifest> {
  const state = await uniqueSpaceState(ctx, generation.space_id);
  if (
    !state ||
    countOf(state.eligibility_epoch, "Eligibility epoch") !==
      countOf(generation.eligibility_epoch, "Generation eligibility epoch")
  ) {
    throw new Error("Embedding eligibility changed during generation staging");
  }
  const manifest = await deriveEmbeddingManifest(ctx, generation.space_id);
  if (
    manifest.hash !== generation.manifest_hash ||
    manifest.thoughtCount !==
      countOf(generation.expected_thought_count, "Expected thought count") ||
    manifest.chunkCount !==
      countOf(generation.expected_chunk_count, "Expected chunk count")
  ) {
    throw new Error(
      "Embedding target manifest changed during generation staging",
    );
  }
  return manifest;
}

async function validateManifestVectors(
  ctx: IdentityCtx,
  generation: EmbeddingGenerationRecord,
  manifest: EmbeddingManifest,
  rejectExtras: boolean,
): Promise<{ thoughtCount: number; chunkCount: number }> {
  const found = await rows<{
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
    dimensions: number;
    zero: boolean;
  }>(
    ctx,
    `SELECT id, space_id, embedding_generation_id, embedding_fingerprint,
            target_kind, search_scope, thought_id, chunk_id, event_id,
            processing_generation_id, input_hash,
            public.vector_dims(embedding) AS dimensions,
            public.vector_norm(embedding) = 0 AS zero
       FROM kith.embedding_vectors WHERE embedding_generation_id = $1
      ORDER BY created_at, id LIMIT $2`,
    [generation.id, MAX_EMBEDDING_VECTOR_ROWS + 1],
  );
  if (found.length > MAX_EMBEDDING_VECTOR_ROWS) {
    throw new EmbeddingManifestLimitError(
      "Embedding generation exceeds its vector row budget",
    );
  }
  const byTarget = new Map<string, (typeof found)[number]>();
  for (const record of found) {
    const id =
      record.target_kind === "thought" ? record.thought_id : record.chunk_id;
    const wrongShape =
      !id ||
      (record.target_kind === "thought" &&
        (record.chunk_id !== null ||
          record.processing_generation_id !== null)) ||
      (record.target_kind === "chunk" &&
        (record.thought_id !== null ||
          record.processing_generation_id === null)) ||
      (record.target_kind !== "thought" && record.target_kind !== "chunk");
    if (
      wrongShape ||
      record.space_id !== generation.space_id ||
      record.embedding_generation_id !== generation.id ||
      record.embedding_fingerprint !== generation.fingerprint ||
      record.search_scope !==
        embeddingVectorSearchScope({
          spaceId: record.space_id,
          fingerprint: record.embedding_fingerprint,
          embeddingGenerationId: record.embedding_generation_id,
          targetKind: record.target_kind as "thought" | "chunk",
        })
    ) {
      throw new Error(
        "Embedding vector has an invalid generation or target shape",
      );
    }
    // The dimension is pinned by the column type; the all-zero case is not, so
    // it is the one half of `validateVector` still worth asserting here.
    if (record.zero) {
      throw new Error("Embedding vector must not be all zero");
    }
    const key = `${record.target_kind}:${id}`;
    if (byTarget.has(key)) {
      throw new Error("Duplicate embedding generation target");
    }
    byTarget.set(key, record);
  }

  let thoughtCount = 0;
  let chunkCount = 0;
  const manifestKeys = new Set<string>();
  for (const target of manifest.targets) {
    const key = targetKey(target);
    manifestKeys.add(key);
    const record = byTarget.get(key);
    if (
      !record ||
      record.input_hash !== target.inputHash ||
      (record.processing_generation_id ?? undefined) !==
        target.processingGenerationId
    ) {
      continue;
    }
    if (target.kind === "thought") thoughtCount += 1;
    else chunkCount += 1;
  }
  if (
    rejectExtras &&
    [...byTarget.keys()].some((key) => !manifestKeys.has(key))
  ) {
    throw new Error(
      "Embedding generation contains targets outside its manifest",
    );
  }
  return { thoughtCount, chunkCount };
}

/**
 * The manifest inputs a staging generation still owes, each rechecked against
 * its live row. A target whose text moved since the manifest was derived is a
 * refusal, not a silent skip.
 */
export async function getStagingEmbeddingManifestInputs(
  ctx: IdentityCtx,
  embeddingGenerationId: string,
): Promise<{
  generation: EmbeddingGenerationRecord;
  inputs: EmbeddingManifestInput[];
}> {
  const generation = await getEmbeddingGeneration(ctx, embeddingGenerationId);
  if (!generation) throw new Error("Embedding generation not found");
  if (generation.state !== "staging") {
    throw new Error("Embedding generation is not accepting staged vectors");
  }
  await requireGenerationProfile(ctx, generation);
  const manifest = await requireUnchangedManifest(ctx, generation);
  const inputs: EmbeddingManifestInput[] = [];
  for (const target of manifest.targets) {
    if (target.kind === "thought") {
      const thought = await row<{
        id: string;
        space_id: string;
        content: string;
        memory_status: string | null;
      }>(
        ctx,
        "SELECT id, space_id, content, memory_status FROM kith.thoughts WHERE id = $1",
        [target.targetId],
      );
      if (
        !thought ||
        thought.space_id !== generation.space_id ||
        !isCurrentThought(thought) ||
        (await sha256Utf8(thought.content)) !== target.inputHash
      ) {
        throw new Error("Embedding thought manifest input changed");
      }
      inputs.push({
        targetKind: "thought",
        thoughtId: thought.id,
        inputText: thought.content,
        inputHash: target.inputHash,
      });
      continue;
    }
    const chunk = await row<ChunkRow>(
      ctx,
      `SELECT id, space_id, processing_generation_id, document_id, text,
              publication_state
         FROM kith.chunks WHERE id = $1`,
      [target.targetId],
    );
    if (
      !chunk ||
      chunk.space_id !== generation.space_id ||
      chunk.processing_generation_id !== target.processingGenerationId ||
      chunk.publication_state !== "active" ||
      (await sha256Utf8(chunk.text ?? "")) !== target.inputHash
    ) {
      throw new Error("Embedding chunk manifest input changed");
    }
    inputs.push({
      targetKind: "chunk",
      chunkId: chunk.id,
      processingGenerationId: chunk.processing_generation_id,
      inputText: chunk.text ?? "",
      inputHash: target.inputHash,
    });
  }
  return { generation, inputs };
}

/**
 * Ported from `operator.ts:stageVectorBatch`: 1 to 10 targets, each of which
 * must be in the staged manifest, inserted through the same `insertVector`
 * every other writer uses.
 */
export async function stageEmbeddingVectorBatch(
  ctx: IdentityCtx,
  input: {
    embeddingGenerationId: string;
    fingerprint: string;
    vectors: ReadonlyArray<
      | { targetKind: "thought"; thoughtId: string; vector: readonly number[] }
      | { targetKind: "chunk"; chunkId: string; vector: readonly number[] }
    >;
  },
): Promise<{ insertedOrReused: number }> {
  if (
    input.vectors.length < 1 ||
    input.vectors.length > MAX_STAGED_VECTOR_BATCH
  ) {
    throw new Error("Embedding vector batch must contain 1-10 targets");
  }
  // Rendered before anything is read, so a malformed vector refuses the batch
  // rather than half of it.
  for (const vector of input.vectors) embeddingVectorLiteral(vector.vector);
  const { generation, inputs } = await getStagingEmbeddingManifestInputs(
    ctx,
    input.embeddingGenerationId,
  );
  if (generation.fingerprint !== input.fingerprint) {
    throw new Error("Embedding vector batch fingerprint does not match");
  }
  const inputByTarget = new Map(
    inputs.map((manifestInput) => [
      manifestInput.targetKind === "thought"
        ? `thought:${manifestInput.thoughtId}`
        : `chunk:${manifestInput.chunkId}`,
      manifestInput,
    ]),
  );
  const supplied = new Set<string>();
  for (const vector of input.vectors) {
    const key =
      vector.targetKind === "thought"
        ? `thought:${vector.thoughtId}`
        : `chunk:${vector.chunkId}`;
    if (supplied.has(key)) {
      throw new Error("Embedding vector batch contains a duplicate target");
    }
    supplied.add(key);
    const manifestInput = inputByTarget.get(key);
    if (!manifestInput || manifestInput.targetKind !== vector.targetKind) {
      throw new Error("Embedding vector target is outside the staged manifest");
    }
    if (vector.targetKind === "thought") {
      await insertThoughtEmbedding(ctx, {
        spaceId: generation.space_id,
        thoughtId: vector.thoughtId,
        embeddingGenerationId: generation.id,
        fingerprint: input.fingerprint,
        inputText: manifestInput.inputText,
        vector: vector.vector,
        bumpEligibility: false,
      });
    } else {
      await insertChunkEmbedding(ctx, {
        spaceId: generation.space_id,
        chunkId: vector.chunkId,
        embeddingGenerationId: generation.id,
        fingerprint: input.fingerprint,
        inputText: manifestInput.inputText,
        vector: vector.vector,
      });
    }
  }
  return { insertedOrReused: input.vectors.length };
}

export async function stageEmbeddingGeneration(
  ctx: IdentityCtx,
  input: { embeddingGenerationId: string; stagedAt?: number },
): Promise<void> {
  const stagedAt = input.stagedAt ?? ctx.now;
  assertFiniteTime(stagedAt, "Embedding staging time");
  const generation = await getEmbeddingGeneration(
    ctx,
    input.embeddingGenerationId,
    true,
  );
  if (!generation) throw new Error("Embedding generation not found");
  if (generation.state === "staged") return;
  if (generation.state !== "staging") {
    throw new Error("Only a staging embedding generation can be staged");
  }
  const createdAt = msOf(generation.created_at_field);
  if (createdAt !== undefined && stagedAt < createdAt) {
    throw new Error("Embedding staging time precedes generation creation");
  }
  await requireGenerationProfile(ctx, generation);
  const manifest = await requireUnchangedManifest(ctx, generation);
  const completed = await validateManifestVectors(
    ctx,
    generation,
    manifest,
    true,
  );
  if (
    completed.thoughtCount !== manifest.thoughtCount ||
    completed.chunkCount !== manifest.chunkCount
  ) {
    throw new Error("Embedding generation is missing eligible target vectors");
  }
  await exec(
    ctx,
    `UPDATE kith.embedding_generations
        SET state = 'staged', completed_thought_count = $2,
            completed_chunk_count = $3, coverage_invalid = false,
            thought_coverage_invalid = false, chunk_coverage_invalid = false,
            staged_at = $4
      WHERE id = $1`,
    [generation.id, completed.thoughtCount, completed.chunkCount, at(stagedAt)],
  );
}

/**
 * One transaction: validate, retire the previous generation, flip the active
 * pointer, and seed the targets and counters from the manifest just validated.
 */
export async function activateEmbeddingGeneration(
  ctx: IdentityCtx,
  input: {
    embeddingGenerationId: string;
    expectedPreviousGenerationId?: string;
    activatedAt?: number;
  },
): Promise<void> {
  const activatedAt = input.activatedAt ?? ctx.now;
  assertFiniteTime(activatedAt, "Embedding activation time");
  const generation = await getEmbeddingGeneration(
    ctx,
    input.embeddingGenerationId,
    true,
  );
  if (!generation) throw new Error("Embedding generation not found");
  if (generation.state !== "staged") {
    throw new Error("Only a staged embedding generation can activate");
  }
  const state = await uniqueSpaceState(ctx, generation.space_id, true);
  if (!state) throw new Error("Space embedding state not found");
  const createdAt = msOf(generation.created_at_field);
  const stagedAt = msOf(generation.staged_at);
  const stateActivatedAt = msOf(state.activated_at ?? null);
  if (
    stagedAt === undefined ||
    (createdAt !== undefined && activatedAt < createdAt) ||
    activatedAt < stagedAt ||
    (stateActivatedAt !== undefined && activatedAt <= stateActivatedAt)
  ) {
    throw new Error("Embedding activation time is not monotonic");
  }
  if (
    (state.active_embedding_generation_id ?? undefined) !==
    input.expectedPreviousGenerationId
  ) {
    throw new Error("Active embedding generation changed before activation");
  }
  await requireGenerationProfile(ctx, generation);
  const manifest = await requireUnchangedManifest(ctx, generation);
  const completed = await validateManifestVectors(
    ctx,
    generation,
    manifest,
    true,
  );
  if (
    completed.thoughtCount !==
      countOf(generation.expected_thought_count, "Expected thought count") ||
    completed.chunkCount !==
      countOf(generation.expected_chunk_count, "Expected chunk count")
  ) {
    throw new Error("Embedding generation is incomplete at activation");
  }
  const previousId = state.active_embedding_generation_id;
  if (previousId) {
    const previous = await getEmbeddingGeneration(ctx, previousId, true);
    const previousActivatedAt = previous
      ? msOf(previous.activated_at)
      : undefined;
    if (
      !previous ||
      previous.space_id !== generation.space_id ||
      previous.state !== "active" ||
      previousActivatedAt === undefined ||
      activatedAt <= previousActivatedAt
    ) {
      throw new Error("Previous embedding generation is invalid");
    }
    await exec(
      ctx,
      `UPDATE kith.embedding_generations
          SET state = 'retired', deactivated_at = $2 WHERE id = $1`,
      [previous.id, at(activatedAt)],
    );
  }
  await exec(
    ctx,
    `UPDATE kith.embedding_generations
        SET state = 'active', activated_at = $2 WHERE id = $1`,
    [generation.id, at(activatedAt)],
  );
  await exec(
    ctx,
    `UPDATE kith.space_embedding_states
        SET active_embedding_generation_id = $2, active_fingerprint = $3,
            activated_at = $4
      WHERE id = $1`,
    [state.id, generation.id, generation.fingerprint, at(activatedAt)],
  );
  // The manifest above was validated target by target against its vectors, so
  // it is a stronger seed than the paged build's. Seeding here is what keeps a
  // newly activated space out of the unseeded fail-closed path.
  await seedTargetsFromManifest(
    ctx,
    state,
    generation.fingerprint!,
    manifest.targets,
    activatedAt,
  );
}

export async function failEmbeddingGeneration(
  ctx: IdentityCtx,
  input: {
    embeddingGenerationId: string;
    code: string;
    message: string;
    failedAt?: number;
  },
): Promise<void> {
  const failedAt = input.failedAt ?? ctx.now;
  assertFiniteTime(failedAt, "Embedding failure time");
  if (!input.code || input.code.length > MAX_FAILURE_CODE_LENGTH) {
    throw new Error("Embedding failure code is invalid");
  }
  if (!input.message || input.message.length > MAX_FAILURE_MESSAGE_LENGTH) {
    throw new Error("Embedding failure message is invalid");
  }
  const generation = await getEmbeddingGeneration(
    ctx,
    input.embeddingGenerationId,
    true,
  );
  if (!generation) throw new Error("Embedding generation not found");
  if (generation.state !== "staging" && generation.state !== "staged") {
    throw new Error("Only an inactive embedding generation can fail");
  }
  const createdAt = msOf(generation.created_at_field);
  const stagedAt = msOf(generation.staged_at);
  if (
    (createdAt !== undefined && failedAt < createdAt) ||
    (stagedAt !== undefined && failedAt < stagedAt)
  ) {
    throw new Error("Embedding failure time is not monotonic");
  }
  await exec(
    ctx,
    `UPDATE kith.embedding_generations
        SET state = 'failed', failure_code = $2, failure_message = $3,
            failed_at = $4
      WHERE id = $1`,
    [generation.id, input.code, input.message, at(failedAt)],
  );
}
