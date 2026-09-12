import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import {
  BASELINE_EMBEDDING_DIMENSIONS,
  fingerprintEmbeddingConfig,
  type EmbeddingProfile,
} from "../../lib/embeddingProvider";
import { sha256Hex, utf8ByteLength } from "../ingestion/hash";
import { getAuthorizedReadSpaceIds, type PrincipalRef } from "../../lib/spaces";
import {
  applyEligibilityTouch,
  coveredCountsFor,
  embeddingVectorScopeV2,
  findEmbeddingTarget,
  isCurrentThought,
  newChunkTargetCaches,
  recordVectorCoverageChange,
  resolveActiveChunkTarget,
  seedTargetsFromManifest,
  usesTargetCounters,
  ZERO_KIND_COUNTS,
  type EmbeddingEligibilityTouch,
} from "./targets";

/**
 * Legacy whole-space manifest bounds. P2-6d removed the derive from the
 * eligibility write path entirely, so no ordinary write pays a scan and no
 * write can fail on these bounds. What is left is the profile-transition
 * driver, which stages a *new* fingerprint in one transaction, and the
 * baseline audit. Both still refuse to answer above 256 targets rather than
 * exceeding the platform read limit. A new-fingerprint rebuild above that size
 * needs the paged builder, which is later work.
 */
export const MAX_EMBEDDING_MANIFEST_TARGETS = 256;
export const MAX_EMBEDDING_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_EMBEDDING_VECTOR_ROWS = 256;
export const MAX_EMBEDDING_MANIFEST_SCAN_ROWS = 256;

/** A target holds one vector per fingerprint; the spare slots catch a bug. */
const MAX_TARGET_VECTOR_ROWS = 16;

const MAX_PROFILE_VALUE_LENGTH = 200;
const MAX_FAILURE_CODE_LENGTH = 100;
const MAX_FAILURE_MESSAGE_LENGTH = 1_000;

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type TargetKind = "thought" | "chunk";

export function embeddingVectorSearchScope(input: {
  spaceId: Id<"spaces"> | string;
  fingerprint: string;
  embeddingGenerationId: Id<"embeddingGenerations"> | string;
  targetKind: TargetKind;
}): string {
  return JSON.stringify([
    "embedding-vector-scope-v1",
    String(input.spaceId),
    input.fingerprint,
    String(input.embeddingGenerationId),
    input.targetKind,
  ]);
}

export type ManifestTarget = {
  kind: TargetKind;
  targetId: string;
  inputHash: string;
  processingGenerationId?: Id<"processingGenerations">;
};

export type EmbeddingManifestInput =
  | {
      targetKind: "thought";
      thoughtId: Id<"thoughts">;
      inputText: string;
      inputHash: string;
    }
  | {
      targetKind: "chunk";
      chunkId: Id<"chunks">;
      processingGenerationId: Id<"processingGenerations">;
      inputText: string;
      inputHash: string;
    };

export class EmbeddingManifestLimitError extends Error {}

export type EmbeddingManifest = {
  hash: string;
  thoughtCount: number;
  chunkCount: number;
  targets: ManifestTarget[];
};

export type ActiveEmbeddingTarget = {
  spaceId: Id<"spaces">;
  embeddingGenerationId: Id<"embeddingGenerations">;
  fingerprint: string;
  profile: EmbeddingProfile;
  /** I9: strict. Narrative capture needs a complete thought index. */
  thoughtStatus: "ready" | "unavailable";
  /**
   * D3 B and I10: chunk coverage is a reported ratio, never a reason to make
   * semantic retrieval unavailable. A shortfall reaches the caller through the
   * existing `partial` flag.
   */
  chunkCoverage: { eligible: number; covered: number };
};

/**
 * A space whose counters the P2-6g backfill has not seeded has no source of
 * truth for coverage now that the whole-space derive is gone. It fails closed
 * with this error rather than reporting an empty index as a complete one.
 */
export const UNSEEDED_EMBEDDING_COUNTERS_ERROR =
  "Embedding coverage counters are not seeded for this space; run the P2-6g target backfill (models/embeddings/migrations:startTargetBackfill) before semantic retrieval";

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite timestamp`);
  }
}

function assertProfile(profile: EmbeddingProfile): void {
  for (const [name, value] of Object.entries(profile)) {
    if (name === "dimensions") continue;
    if (
      typeof value !== "string" ||
      !value ||
      value.length > MAX_PROFILE_VALUE_LENGTH
    ) {
      throw new Error(`Embedding profile ${name} is invalid`);
    }
  }
  if (profile.dimensions !== BASELINE_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding profile dimensions require a future index migration; expected ${BASELINE_EMBEDDING_DIMENSIONS}`,
    );
  }
}

function profileFromRow(row: Doc<"embeddingProfiles">): EmbeddingProfile {
  return {
    protocol: row.protocol,
    providerId: row.providerId,
    model: row.model,
    modelRevision: row.modelRevision,
    dimensions: row.dimensions,
    normalization: row.normalization,
    preprocessing: row.preprocessing,
  };
}

function sameProfile(
  row: Doc<"embeddingProfiles">,
  profile: EmbeddingProfile,
): boolean {
  return (
    row.protocol === profile.protocol &&
    row.providerId === profile.providerId &&
    row.model === profile.model &&
    row.modelRevision === profile.modelRevision &&
    row.dimensions === profile.dimensions &&
    row.normalization === profile.normalization &&
    row.preprocessing === profile.preprocessing
  );
}

function validateVector(vector: readonly number[]): void {
  if (
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
}

async function uniqueSpaceState(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
): Promise<Doc<"spaceEmbeddingStates"> | null> {
  const rows = await ctx.db
    .query("spaceEmbeddingStates")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .take(2);
  if (rows.length > 1) throw new Error("Duplicate space embedding state");
  return rows[0] ?? null;
}

export async function ensureSpaceEmbeddingState(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
): Promise<Doc<"spaceEmbeddingStates">> {
  const space = await ctx.db.get(spaceId);
  if (!space) throw new Error("Embedding space not found");
  const existing = await uniqueSpaceState(ctx, spaceId);
  if (existing) return existing;
  const id = await ctx.db.insert("spaceEmbeddingStates", {
    spaceId,
    eligibilityEpoch: 0,
  });
  return (await ctx.db.get(id))!;
}

export async function ensureEmbeddingProfile(
  ctx: MutationCtx,
  input: {
    profile: EmbeddingProfile;
    fingerprint: string;
    createdAt: number;
  },
): Promise<Doc<"embeddingProfiles">> {
  assertProfile(input.profile);
  assertFiniteTime(input.createdAt, "Embedding profile creation time");
  const calculated = await fingerprintEmbeddingConfig(input.profile);
  if (calculated !== input.fingerprint) {
    throw new Error(
      "Embedding profile fingerprint does not match its identity",
    );
  }
  const rows = await ctx.db
    .query("embeddingProfiles")
    .withIndex("by_fingerprint", (q) => q.eq("fingerprint", input.fingerprint))
    .take(2);
  if (rows.length > 1)
    throw new Error("Duplicate embedding profile fingerprint");
  const existing = rows[0];
  if (existing) {
    if (!sameProfile(existing, input.profile)) {
      throw new Error("Embedding profile fingerprint collision or damaged row");
    }
    return existing;
  }
  const id = await ctx.db.insert("embeddingProfiles", {
    fingerprint: input.fingerprint,
    ...input.profile,
    createdAt: input.createdAt,
  });
  return (await ctx.db.get(id))!;
}

function targetKey(target: ManifestTarget): string {
  return `${target.kind}:${target.targetId}`;
}

/**
 * Derives the complete active target set inside fixed global row and byte
 * budgets. It throws instead of returning a partial manifest.
 */
export async function deriveEmbeddingManifest(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
): Promise<EmbeddingManifest> {
  const thoughts = await ctx.db
    .query("thoughts")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .take(MAX_EMBEDDING_MANIFEST_SCAN_ROWS + 1);
  if (thoughts.length > MAX_EMBEDDING_MANIFEST_SCAN_ROWS) {
    throw new EmbeddingManifestLimitError(
      "Embedding target manifest exceeds its global scan budget",
    );
  }

  const targets: ManifestTarget[] = [];
  let estimatedBytes = 0;
  for (const thought of thoughts) {
    if (!isCurrentThought(thought)) continue;
    estimatedBytes +=
      utf8ByteLength(thought.content) + thought.embedding.length * 8;
    targets.push({
      kind: "thought",
      targetId: String(thought._id),
      inputHash: await sha256Hex(thought.content),
    });
  }

  if (targets.length > MAX_EMBEDDING_MANIFEST_TARGETS) {
    throw new EmbeddingManifestLimitError(
      "Embedding target manifest exceeds its global row budget",
    );
  }

  const remaining = MAX_EMBEDDING_MANIFEST_TARGETS - targets.length;
  const chunks = await ctx.db
    .query("chunks")
    .withIndex("by_spaceId_and_publicationState", (q) =>
      q.eq("spaceId", spaceId).eq("publicationState", "active"),
    )
    .take(remaining + 1);
  if (chunks.length > remaining) {
    throw new EmbeddingManifestLimitError(
      "Embedding target manifest exceeds its global row budget",
    );
  }

  const caches = newChunkTargetCaches();
  for (const chunk of chunks) {
    estimatedBytes += utf8ByteLength(chunk.text);
    const resolved = await resolveActiveChunkTarget(
      ctx,
      spaceId,
      chunk,
      caches,
    );
    if (!resolved) continue;
    targets.push({
      kind: "chunk",
      targetId: String(chunk._id),
      inputHash: await sha256Hex(chunk.text),
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
  const hash = await sha256Hex(
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
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    profile: EmbeddingProfile;
    fingerprint: string;
    createdAt: number;
  },
): Promise<Doc<"embeddingGenerations">> {
  const state = await ensureSpaceEmbeddingState(ctx, input.spaceId);
  assertStagingFingerprintIsNew(state, input.fingerprint);
  const profile = await ensureEmbeddingProfile(ctx, input);
  const manifest = await deriveEmbeddingManifest(ctx, input.spaceId);
  const unfinished = await ctx.db
    .query("embeddingGenerations")
    .withIndex("by_spaceId_and_state", (q) =>
      q.eq("spaceId", input.spaceId).eq("state", "staging"),
    )
    .take(2);
  if (unfinished.length > 0) {
    throw new Error("Space already has a staging embedding generation");
  }
  const staged = await ctx.db
    .query("embeddingGenerations")
    .withIndex("by_spaceId_and_state", (q) =>
      q.eq("spaceId", input.spaceId).eq("state", "staged"),
    )
    .take(1);
  if (staged.length > 0) {
    throw new Error("Space already has a staged embedding generation");
  }
  const id = await ctx.db.insert("embeddingGenerations", {
    spaceId: input.spaceId,
    embeddingProfileId: profile._id,
    fingerprint: input.fingerprint,
    state: "staging",
    eligibilityEpoch: state.eligibilityEpoch,
    manifestHash: manifest.hash,
    expectedThoughtCount: manifest.thoughtCount,
    expectedChunkCount: manifest.chunkCount,
    completedThoughtCount: 0,
    completedChunkCount: 0,
    coverageInvalid: false,
    createdAt: input.createdAt,
  });
  return (await ctx.db.get(id))!;
}

async function requireGenerationProfile(
  ctx: ReadCtx,
  generation: Doc<"embeddingGenerations">,
): Promise<Doc<"embeddingProfiles">> {
  const profile = await ctx.db.get(generation.embeddingProfileId);
  if (
    !profile ||
    profile.fingerprint !== generation.fingerprint ||
    (await fingerprintEmbeddingConfig(profileFromRow(profile))) !==
      generation.fingerprint
  ) {
    throw new Error("Embedding generation profile is invalid");
  }
  return profile;
}

async function validateManifestVectors(
  ctx: ReadCtx,
  generation: Doc<"embeddingGenerations">,
  manifest: EmbeddingManifest,
  rejectExtras: boolean,
): Promise<{
  thoughtCount: number;
  chunkCount: number;
  extraThoughtCount: number;
  extraChunkCount: number;
}> {
  const rows = await ctx.db
    .query("embeddingVectors")
    .withIndex("by_embeddingGenerationId", (q) =>
      q.eq("embeddingGenerationId", generation._id),
    )
    .take(MAX_EMBEDDING_VECTOR_ROWS + 1);
  if (rows.length > MAX_EMBEDDING_VECTOR_ROWS) {
    throw new EmbeddingManifestLimitError(
      "Embedding generation exceeds its vector row budget",
    );
  }
  const byTarget = new Map<string, Doc<"embeddingVectors">>();
  for (const row of rows) {
    const id = row.targetKind === "thought" ? row.thoughtId : row.chunkId;
    const wrongShape =
      !id ||
      (row.targetKind === "thought" &&
        (row.chunkId !== undefined ||
          row.processingGenerationId !== undefined)) ||
      (row.targetKind === "chunk" &&
        (row.thoughtId !== undefined ||
          row.processingGenerationId === undefined));
    if (
      wrongShape ||
      row.spaceId !== generation.spaceId ||
      row.embeddingGenerationId !== generation._id ||
      row.embeddingFingerprint !== generation.fingerprint ||
      row.searchScope !==
        embeddingVectorSearchScope({
          spaceId: row.spaceId,
          fingerprint: row.embeddingFingerprint,
          embeddingGenerationId: row.embeddingGenerationId,
          targetKind: row.targetKind,
        })
    ) {
      throw new Error(
        "Embedding vector has an invalid generation or target shape",
      );
    }
    validateVector(row.embedding);
    const key = `${row.targetKind}:${id}`;
    if (byTarget.has(key))
      throw new Error("Duplicate embedding generation target");
    byTarget.set(key, row);
  }

  let thoughtCount = 0;
  let chunkCount = 0;
  const manifestKeys = new Set<string>();
  for (const target of manifest.targets) {
    const key = targetKey(target);
    manifestKeys.add(key);
    const row = byTarget.get(key);
    if (
      !row ||
      row.inputHash !== target.inputHash ||
      row.processingGenerationId !== target.processingGenerationId
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
  let extraThoughtCount = 0;
  let extraChunkCount = 0;
  for (const [key, row] of byTarget) {
    if (manifestKeys.has(key)) continue;
    if (row.targetKind === "thought") extraThoughtCount += 1;
    else extraChunkCount += 1;
  }
  return { thoughtCount, chunkCount, extraThoughtCount, extraChunkCount };
}

async function requireUnchangedManifest(
  ctx: ReadCtx,
  generation: Doc<"embeddingGenerations">,
): Promise<EmbeddingManifest> {
  const state = await uniqueSpaceState(ctx, generation.spaceId);
  if (!state || state.eligibilityEpoch !== generation.eligibilityEpoch) {
    throw new Error("Embedding eligibility changed during generation staging");
  }
  const manifest = await deriveEmbeddingManifest(ctx, generation.spaceId);
  if (
    manifest.hash !== generation.manifestHash ||
    manifest.thoughtCount !== generation.expectedThoughtCount ||
    manifest.chunkCount !== generation.expectedChunkCount
  ) {
    throw new Error(
      "Embedding target manifest changed during generation staging",
    );
  }
  return manifest;
}

export async function getStagingEmbeddingManifestInputs(
  ctx: ReadCtx,
  embeddingGenerationId: Id<"embeddingGenerations">,
): Promise<{
  generation: Doc<"embeddingGenerations">;
  inputs: EmbeddingManifestInput[];
}> {
  const generation = await ctx.db.get(embeddingGenerationId);
  if (!generation) throw new Error("Embedding generation not found");
  if (generation.state !== "staging") {
    throw new Error("Embedding generation is not accepting staged vectors");
  }
  await requireGenerationProfile(ctx, generation);
  const manifest = await requireUnchangedManifest(ctx, generation);
  const inputs: EmbeddingManifestInput[] = [];
  for (const target of manifest.targets) {
    if (target.kind === "thought") {
      const thoughtId = ctx.db.normalizeId("thoughts", target.targetId);
      const thought = thoughtId ? await ctx.db.get(thoughtId) : null;
      if (
        !thought ||
        thought.spaceId !== generation.spaceId ||
        !isCurrentThought(thought) ||
        (await sha256Hex(thought.content)) !== target.inputHash
      ) {
        throw new Error("Embedding thought manifest input changed");
      }
      inputs.push({
        targetKind: "thought",
        thoughtId: thought._id,
        inputText: thought.content,
        inputHash: target.inputHash,
      });
      continue;
    }
    const chunkId = ctx.db.normalizeId("chunks", target.targetId);
    const chunk = chunkId ? await ctx.db.get(chunkId) : null;
    if (
      !chunk ||
      chunk.spaceId !== generation.spaceId ||
      chunk.processingGenerationId !== target.processingGenerationId ||
      chunk.publicationState !== "active" ||
      (await sha256Hex(chunk.text)) !== target.inputHash
    ) {
      throw new Error("Embedding chunk manifest input changed");
    }
    inputs.push({
      targetKind: "chunk",
      chunkId: chunk._id,
      processingGenerationId: chunk.processingGenerationId,
      inputText: chunk.text,
      inputHash: target.inputHash,
    });
  }
  return { generation, inputs };
}

export async function stageEmbeddingGeneration(
  ctx: MutationCtx,
  input: {
    embeddingGenerationId: Id<"embeddingGenerations">;
    stagedAt: number;
  },
): Promise<void> {
  assertFiniteTime(input.stagedAt, "Embedding staging time");
  const generation = await ctx.db.get(input.embeddingGenerationId);
  if (!generation) throw new Error("Embedding generation not found");
  if (generation.state === "staged") return;
  if (generation.state !== "staging") {
    throw new Error("Only a staging embedding generation can be staged");
  }
  if (input.stagedAt < generation.createdAt) {
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
  await ctx.db.patch(generation._id, {
    state: "staged",
    completedThoughtCount: completed.thoughtCount,
    completedChunkCount: completed.chunkCount,
    coverageInvalid: false,
    thoughtCoverageInvalid: false,
    chunkCoverageInvalid: false,
    stagedAt: input.stagedAt,
  });
}

export async function activateEmbeddingGeneration(
  ctx: MutationCtx,
  input: {
    embeddingGenerationId: Id<"embeddingGenerations">;
    expectedPreviousGenerationId?: Id<"embeddingGenerations">;
    activatedAt: number;
  },
): Promise<void> {
  assertFiniteTime(input.activatedAt, "Embedding activation time");
  const generation = await ctx.db.get(input.embeddingGenerationId);
  if (!generation) throw new Error("Embedding generation not found");
  if (generation.state !== "staged") {
    throw new Error("Only a staged embedding generation can activate");
  }
  const state = await uniqueSpaceState(ctx, generation.spaceId);
  if (!state) throw new Error("Space embedding state not found");
  if (
    generation.stagedAt === undefined ||
    input.activatedAt < generation.createdAt ||
    input.activatedAt < generation.stagedAt ||
    (state?.activatedAt !== undefined && input.activatedAt <= state.activatedAt)
  ) {
    throw new Error("Embedding activation time is not monotonic");
  }
  if (
    state.activeEmbeddingGenerationId !== input.expectedPreviousGenerationId
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
    completed.thoughtCount !== generation.expectedThoughtCount ||
    completed.chunkCount !== generation.expectedChunkCount
  ) {
    throw new Error("Embedding generation is incomplete at activation");
  }
  const previousId = state.activeEmbeddingGenerationId;
  if (previousId) {
    const previous = await ctx.db.get(previousId);
    if (
      !previous ||
      previous.spaceId !== generation.spaceId ||
      previous.state !== "active" ||
      previous.activatedAt === undefined ||
      input.activatedAt <= previous.activatedAt
    ) {
      throw new Error("Previous embedding generation is invalid");
    }
    await ctx.db.patch(previous._id, {
      state: "retired",
      deactivatedAt: input.activatedAt,
    });
  }
  await ctx.db.patch(generation._id, {
    state: "active",
    activatedAt: input.activatedAt,
  });
  await ctx.db.patch(state._id, {
    activeEmbeddingGenerationId: generation._id,
    activeFingerprint: generation.fingerprint,
    activatedAt: input.activatedAt,
  });
  // The manifest above was validated target by target against its vectors, so
  // it is a stronger seed than the paged backfill. Seeding here is what keeps
  // a newly activated space out of the unseeded fail-closed path.
  await seedTargetsFromManifest(
    ctx,
    state,
    generation.fingerprint,
    manifest.targets,
    input.activatedAt,
  );
}

export async function failEmbeddingGeneration(
  ctx: MutationCtx,
  input: {
    embeddingGenerationId: Id<"embeddingGenerations">;
    code: string;
    message: string;
    failedAt: number;
  },
): Promise<void> {
  assertFiniteTime(input.failedAt, "Embedding failure time");
  if (!input.code || input.code.length > MAX_FAILURE_CODE_LENGTH) {
    throw new Error("Embedding failure code is invalid");
  }
  if (!input.message || input.message.length > MAX_FAILURE_MESSAGE_LENGTH) {
    throw new Error("Embedding failure message is invalid");
  }
  const generation = await ctx.db.get(input.embeddingGenerationId);
  if (!generation) throw new Error("Embedding generation not found");
  if (generation.state !== "staging" && generation.state !== "staged") {
    throw new Error("Only an inactive embedding generation can fail");
  }
  if (
    input.failedAt < generation.createdAt ||
    (generation.stagedAt !== undefined && input.failedAt < generation.stagedAt)
  ) {
    throw new Error("Embedding failure time is not monotonic");
  }
  await ctx.db.patch(generation._id, {
    state: "failed",
    failureCode: input.code,
    failureMessage: input.message,
    failedAt: input.failedAt,
  });
}

export async function getActiveEmbeddingTarget(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
): Promise<ActiveEmbeddingTarget | null> {
  const state = await uniqueSpaceState(ctx, spaceId);
  if (!state?.activeEmbeddingGenerationId || !state.activeFingerprint)
    return null;
  const generation = await ctx.db.get(state.activeEmbeddingGenerationId);
  if (
    !generation ||
    generation.spaceId !== spaceId ||
    generation.state !== "active" ||
    generation.fingerprint !== state.activeFingerprint ||
    generation.deactivatedAt !== undefined
  ) {
    throw new Error("Active embedding generation pointer is invalid");
  }
  const profile = await requireGenerationProfile(ctx, generation);
  // The counters are the only source of coverage truth now that the
  // whole-space derive is gone (I4, I5). An unseeded space fails closed.
  if (!usesTargetCounters(state)) {
    throw new Error(UNSEEDED_EMBEDDING_COUNTERS_ERROR);
  }
  const eligible = state.eligibleCounts ?? ZERO_KIND_COUNTS;
  const covered = coveredCountsFor(state, state.activeFingerprint);
  return {
    spaceId,
    embeddingGenerationId: generation._id,
    fingerprint: generation.fingerprint,
    profile: profileFromRow(profile),
    // I9. The audit watermark of I5 gates activation, not retrieval: an
    // eligibility write would otherwise disable capture until an audit ran.
    thoughtStatus:
      state.counterDrift !== true && covered.thought === eligible.thought
        ? "ready"
        : "unavailable",
    chunkCoverage: { eligible: eligible.chunk, covered: covered.chunk },
  };
}

/**
 * Section 3.4 point 2 holds only for a *new* fingerprint: a staged generation
 * is invisible to readers because no reader names its fingerprint. Under the
 * active fingerprint there is no such window. I11 would make the driver's
 * inserts delete and replace live rows before activation, and I3 means a
 * second generation of the same fingerprint is the same row set anyway. The
 * incremental fill (P2-6c) is the only writer under the active fingerprint.
 */
function assertStagingFingerprintIsNew(
  state: Doc<"spaceEmbeddingStates">,
  fingerprint: string,
): void {
  if (state.activeFingerprint === fingerprint) {
    throw new Error(
      "Staging a generation under the active fingerprint is retired; the incremental fill owns that index",
    );
  }
}

export async function requireActiveEmbeddingTarget(
  ctx: ReadCtx,
  input: {
    spaceId: Id<"spaces">;
    /** Write paths still pin the generation; readers pin the fingerprint. */
    embeddingGenerationId?: Id<"embeddingGenerations">;
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
  ctx: ReadCtx,
  input: {
    kind: TargetKind;
    thoughtId?: Id<"thoughts">;
    chunkId?: Id<"chunks">;
  },
): Promise<Doc<"embeddingVectors">[]> {
  const rows =
    input.kind === "thought"
      ? await ctx.db
          .query("embeddingVectors")
          .withIndex("by_thoughtId", (q) => q.eq("thoughtId", input.thoughtId))
          .take(MAX_TARGET_VECTOR_ROWS + 1)
      : await ctx.db
          .query("embeddingVectors")
          .withIndex("by_chunkId", (q) => q.eq("chunkId", input.chunkId))
          .take(MAX_TARGET_VECTOR_ROWS + 1);
  if (rows.length > MAX_TARGET_VECTOR_ROWS) {
    throw new Error("Embedding target exceeds its vector row budget");
  }
  return rows;
}

async function insertVector(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    embeddingGenerationId: Id<"embeddingGenerations">;
    fingerprint: string;
    kind: TargetKind;
    thoughtId?: Id<"thoughts">;
    chunkId?: Id<"chunks">;
    processingGenerationId?: Id<"processingGenerations">;
    inputText: string;
    vector: number[];
  },
): Promise<{
  id: Id<"embeddingVectors">;
  inserted: boolean;
  generationState: "staging" | "active";
  activeTarget: ActiveEmbeddingTarget | null;
}> {
  validateVector(input.vector);
  const generation = await ctx.db.get(input.embeddingGenerationId);
  if (
    !generation ||
    generation.spaceId !== input.spaceId ||
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
          embeddingGenerationId: generation._id,
          fingerprint: input.fingerprint,
        })
      : null;
  const targetId = input.kind === "thought" ? input.thoughtId : input.chunkId;
  if (!targetId) throw new Error("Embedding vector target is missing");
  const inputHash = await sha256Hex(input.inputText);
  const scopeV2 = embeddingVectorScopeV2({
    spaceId: input.spaceId,
    fingerprint: input.fingerprint,
    targetKind: input.kind,
  });
  // I11, in full. The exclusive slot is `(spaceId, fingerprint, targetKind,
  // targetId)`, with no generation in it: a row staged by an older generation
  // under this fingerprint occupies the same slot and the same `scopeV2`, so
  // leaving it would put two rows of one target in the candidate set. At most
  // one row survives this transaction, and it is the one whose `inputHash`
  // matches the text being embedded. Rows under another fingerprint are
  // untouched, because a retired fingerprint is the rollback artifact. The
  // covered counters net to zero across a swap: the delete releases the marker
  // and the insert below sets it again.
  const siblings = (
    await targetVectorRows(ctx, {
      kind: input.kind,
      thoughtId: input.thoughtId,
      chunkId: input.chunkId,
    })
  ).filter(
    (row) =>
      row.spaceId === input.spaceId &&
      row.embeddingFingerprint === input.fingerprint &&
      row.targetKind === input.kind,
  );
  // I3: an unchanged target keeps its row across generations of one
  // fingerprint. Prefer this generation's row so a replay is a plain no-op.
  const existing =
    siblings.find(
      (row) =>
        row.inputHash === inputHash &&
        row.embeddingGenerationId === generation._id,
    ) ?? siblings.find((row) => row.inputHash === inputHash);
  for (const row of siblings) {
    if (existing && row._id === existing._id) continue;
    await releaseVectorCoverage(ctx, row);
    await ctx.db.delete(row._id);
  }
  const searchScope = embeddingVectorSearchScope({
    spaceId: input.spaceId,
    fingerprint: input.fingerprint,
    embeddingGenerationId: generation._id,
    targetKind: input.kind,
  });
  if (existing) {
    if (
      existing.processingGenerationId !== input.processingGenerationId ||
      existing.searchScope !==
        embeddingVectorSearchScope({
          spaceId: existing.spaceId,
          fingerprint: existing.embeddingFingerprint,
          embeddingGenerationId: existing.embeddingGenerationId,
          targetKind: existing.targetKind,
        }) ||
      existing.embedding.length !== input.vector.length ||
      existing.embedding.some((value, index) => value !== input.vector[index])
    ) {
      throw new Error("Conflicting immutable embedding vector");
    }
    // A row written before the scopeV2 backfill is invisible to the reader.
    // Naming its own slot is derived identity, not content, so I1 holds.
    if (existing.scopeV2 !== scopeV2) {
      await ctx.db.patch(existing._id, { scopeV2 });
    }
    await recordVectorCoverageChange(ctx, {
      spaceId: input.spaceId,
      targetKind: input.kind,
      targetId: String(targetId),
      fingerprint: input.fingerprint,
      inputHash,
      covered: true,
      now: Date.now(),
    });
    return {
      id: existing._id,
      inserted: false,
      generationState: generation.state,
      activeTarget,
    };
  }
  const id = await ctx.db.insert("embeddingVectors", {
    spaceId: input.spaceId,
    embeddingGenerationId: generation._id,
    embeddingFingerprint: input.fingerprint,
    targetKind: input.kind,
    searchScope,
    scopeV2,
    ...(input.thoughtId ? { thoughtId: input.thoughtId } : {}),
    ...(input.chunkId ? { chunkId: input.chunkId } : {}),
    ...(input.processingGenerationId
      ? { processingGenerationId: input.processingGenerationId }
      : {}),
    inputHash,
    embedding: input.vector,
  });
  await recordVectorCoverageChange(ctx, {
    spaceId: input.spaceId,
    targetKind: input.kind,
    targetId: String(targetId),
    fingerprint: input.fingerprint,
    inputHash,
    covered: true,
    now: Date.now(),
  });
  return {
    id,
    inserted: true,
    generationState: generation.state,
    activeTarget,
  };
}

/**
 * I4, delete half: drops the coverage marker the deleted row was holding.
 *
 * It is a no-op unless the target's marker still names this row's fingerprint,
 * so releasing twice for one target cannot drive a counter negative. Callers
 * that delete a duplicate rather than the last row of a target must not call
 * it at all; see the cleanup in `migrations.ts`.
 */
export async function releaseVectorCoverage(
  ctx: MutationCtx,
  row: Doc<"embeddingVectors">,
): Promise<void> {
  const targetId = row.targetKind === "thought" ? row.thoughtId : row.chunkId;
  if (!targetId) return;
  await recordVectorCoverageChange(ctx, {
    spaceId: row.spaceId,
    targetKind: row.targetKind,
    targetId: String(targetId),
    fingerprint: row.embeddingFingerprint,
    inputHash: row.inputHash,
    covered: false,
    now: Date.now(),
  });
}

/**
 * Marks the targets a write touched without bumping the epoch. Use it when the
 * transaction has to mark a target eligible *before* inserting its vector, so
 * the insert finds a row to mark covered; the epoch bump then follows the
 * insert as it always has. A space still on the legacy derive is untouched.
 */
export async function markEligibilityTargets(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  touch: EmbeddingEligibilityTouch,
): Promise<boolean> {
  const state = await ensureSpaceEmbeddingState(ctx, spaceId);
  if (!usesTargetCounters(state)) return false;
  await applyEligibilityTouch(ctx, state, touch, Date.now());
  return true;
}

/**
 * Call after an eligibility-changing write, in the same mutation, naming the
 * targets the write touched.
 *
 * On a counted space (P2-6c) this upserts or retires exactly those targets,
 * applies their counter deltas and mirrors the counters onto the active
 * generation row. It reads the touched targets and one state row, never the
 * space. The legacy whole-space derive below runs only for a space whose
 * counters have not been seeded and audited yet; P2-6d removes it.
 */
export async function bumpEmbeddingEligibilityEpoch(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  touch?: EmbeddingEligibilityTouch,
): Promise<number> {
  const state = await ensureSpaceEmbeddingState(ctx, spaceId);
  const nextEpoch = state.eligibilityEpoch + 1;
  if (!Number.isSafeInteger(nextEpoch)) {
    throw new Error("Embedding eligibility epoch is exhausted");
  }
  await ctx.db.patch(state._id, { eligibilityEpoch: nextEpoch });
  if (usesTargetCounters(state)) {
    await applyEligibilityTouch(ctx, state, touch ?? {}, Date.now());
  }
  if (state.activeEmbeddingGenerationId) {
    const generation = await ctx.db.get(state.activeEmbeddingGenerationId);
    if (
      !generation ||
      generation.state !== "active" ||
      generation.spaceId !== spaceId
    ) {
      throw new Error("Active embedding generation pointer is invalid");
    }
    await ctx.db.patch(generation._id, { eligibilityEpoch: nextEpoch });
  }
  return nextEpoch;
}

export async function insertThoughtEmbedding(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    thoughtId: Id<"thoughts">;
    embeddingGenerationId: Id<"embeddingGenerations">;
    fingerprint: string;
    inputText: string;
    vector: number[];
    bumpEligibility?: boolean;
  },
): Promise<Id<"embeddingVectors">> {
  const thought = await ctx.db.get(input.thoughtId);
  if (
    !thought ||
    thought.spaceId !== input.spaceId ||
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
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    chunkId: Id<"chunks">;
    embeddingGenerationId: Id<"embeddingGenerations">;
    fingerprint: string;
    inputText: string;
    vector: number[];
    bumpEligibility?: boolean;
  },
): Promise<Id<"embeddingVectors">> {
  const chunk = await ctx.db.get(input.chunkId);
  if (
    !chunk ||
    chunk.spaceId !== input.spaceId ||
    chunk.text !== input.inputText ||
    chunk.processingGenerationId === undefined
  ) {
    throw new Error(
      "Chunk embedding target does not match its content or space",
    );
  }
  const result = await insertVector(ctx, {
    ...input,
    kind: "chunk",
    processingGenerationId: chunk.processingGenerationId,
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

export async function deleteChunkEmbeddingVectors(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    chunkId: Id<"chunks">;
    limit?: number;
  },
): Promise<{ deleted: number; done: boolean }> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 25);
  const rows = await ctx.db
    .query("embeddingVectors")
    .withIndex("by_chunkId", (q) => q.eq("chunkId", input.chunkId))
    .take(limit + 1);
  for (const row of rows.slice(0, limit)) {
    if (row.spaceId !== input.spaceId || row.targetKind !== "chunk") {
      throw new Error("Chunk embedding cleanup found an invalid vector parent");
    }
    await releaseVectorCoverage(ctx, row);
    await ctx.db.delete(row._id);
  }
  return { deleted: Math.min(rows.length, limit), done: rows.length <= limit };
}

export async function deleteThoughtEmbeddingVectors(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    thoughtId: Id<"thoughts">;
    limit?: number;
  },
): Promise<{ deleted: number; done: boolean }> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 25);
  const rows = await ctx.db
    .query("embeddingVectors")
    .withIndex("by_thoughtId", (q) => q.eq("thoughtId", input.thoughtId))
    .take(limit + 1);
  for (const row of rows.slice(0, limit)) {
    if (row.spaceId !== input.spaceId || row.targetKind !== "thought") {
      throw new Error(
        "Thought embedding cleanup found an invalid vector parent",
      );
    }
    await releaseVectorCoverage(ctx, row);
    await ctx.db.delete(row._id);
  }
  return { deleted: Math.min(rows.length, limit), done: rows.length <= limit };
}

/** Removes only stale targets from the current active generation. */
export async function deleteActiveThoughtEmbeddingVectors(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    embeddingGenerationId: Id<"embeddingGenerations">;
    fingerprint: string;
    thoughtIds: Id<"thoughts">[];
  },
): Promise<number> {
  if (input.thoughtIds.length < 1 || input.thoughtIds.length > 10) {
    throw new Error("Active thought embedding cleanup requires 1-10 targets");
  }
  await requireActiveEmbeddingTarget(ctx, input);
  let deleted = 0;
  for (const thoughtId of [...new Set(input.thoughtIds)]) {
    const thought = await ctx.db.get(thoughtId);
    if (
      !thought ||
      thought.spaceId !== input.spaceId ||
      isCurrentThought(thought)
    ) {
      throw new Error(
        "Active thought embedding cleanup target is still current",
      );
    }
    const rows = await ctx.db
      .query("embeddingVectors")
      .withIndex("by_generation_and_thoughtId", (q) =>
        q
          .eq("embeddingGenerationId", input.embeddingGenerationId)
          .eq("thoughtId", thoughtId),
      )
      .take(2);
    if (rows.length > 1) {
      throw new Error("Duplicate active thought embedding vector");
    }
    const row = rows[0];
    if (!row) continue;
    if (
      row.spaceId !== input.spaceId ||
      row.embeddingFingerprint !== input.fingerprint ||
      row.targetKind !== "thought" ||
      row.chunkId !== undefined ||
      row.processingGenerationId !== undefined ||
      row.searchScope !==
        embeddingVectorSearchScope({
          spaceId: input.spaceId,
          fingerprint: input.fingerprint,
          embeddingGenerationId: input.embeddingGenerationId,
          targetKind: "thought",
        })
    ) {
      throw new Error("Active thought embedding vector has invalid identity");
    }
    await releaseVectorCoverage(ctx, row);
    await ctx.db.delete(row._id);
    deleted += 1;
  }
  return deleted;
}

export async function resolveAuthorizedThoughtVectorCandidates(
  ctx: Pick<QueryCtx, "db">,
  input: {
    principal: PrincipalRef;
    // The generation id may still ride along from the candidate scan; the
    // hydration recheck does not use it (I2, I7).
    targets: Array<{
      spaceId: Id<"spaces">;
      embeddingGenerationId?: Id<"embeddingGenerations">;
      fingerprint: string;
    }>;
    embeddingVectorIds: Id<"embeddingVectors">[];
  },
): Promise<
  Array<{
    embeddingVectorId: Id<"embeddingVectors">;
    thoughtId: Id<"thoughts">;
    spaceId: Id<"spaces">;
  }>
> {
  if (input.embeddingVectorIds.length > 256 || input.targets.length > 32) {
    throw new Error("Embedding candidate hydration exceeds its bound");
  }
  const requestedSpaces = input.targets.map((target) => target.spaceId);
  const authorized = new Set(
    await getAuthorizedReadSpaceIds(ctx, input.principal, requestedSpaces),
  );
  const activeTargets = new Map<string, ActiveEmbeddingTarget>();
  for (const target of input.targets) {
    if (!authorized.has(target.spaceId)) continue;
    // I2: the fingerprint, not the generation, binds a row to the live index.
    const active = await requireActiveEmbeddingTarget(ctx, {
      spaceId: target.spaceId,
      fingerprint: target.fingerprint,
    });
    activeTargets.set(String(target.spaceId), active);
  }
  const rows = await Promise.all(
    input.embeddingVectorIds.map((id) => ctx.db.get(id)),
  );
  const results = [];
  const accepted = new Set<string>();
  for (const row of rows) {
    if (!row || row.targetKind !== "thought" || !row.thoughtId) continue;
    const active = activeTargets.get(String(row.spaceId));
    if (
      !active ||
      active.thoughtStatus !== "ready" ||
      active.fingerprint !== row.embeddingFingerprint ||
      row.chunkId !== undefined ||
      row.processingGenerationId !== undefined ||
      row.scopeV2 !==
        embeddingVectorScopeV2({
          spaceId: row.spaceId,
          fingerprint: row.embeddingFingerprint,
          targetKind: "thought",
        })
    ) {
      continue;
    }
    // One candidate per target, whatever the index returned. Candidates arrive
    // in score order, so the best surviving row is the one that is kept.
    const targetKey = `${row.spaceId}:${row.thoughtId}`;
    if (accepted.has(targetKey)) continue;
    if (!(await targetIsEligibleFor(ctx, row, String(row.thoughtId)))) continue;
    const thought = await ctx.db.get(row.thoughtId);
    if (
      !thought ||
      thought.spaceId !== row.spaceId ||
      !isCurrentThought(thought) ||
      row.inputHash !== (await sha256Hex(thought.content))
    ) {
      continue;
    }
    accepted.add(targetKey);
    results.push({
      embeddingVectorId: row._id,
      thoughtId: thought._id,
      spaceId: row.spaceId,
    });
  }
  return results;
}

/**
 * I7, eligibility half. The target table is the live eligibility record, so a
 * row whose target has been retired or rewritten since the vector was written
 * is dropped here even though the vector itself is still well formed.
 */
async function targetIsEligibleFor(
  ctx: Pick<QueryCtx, "db">,
  row: Doc<"embeddingVectors">,
  targetId: string,
): Promise<boolean> {
  const target = await findEmbeddingTarget(
    ctx,
    row.spaceId,
    row.targetKind,
    targetId,
  );
  return (
    target !== null &&
    target.state === "eligible" &&
    target.inputHash === row.inputHash
  );
}

export async function resolveAuthorizedChunkVectorCandidates(
  ctx: Pick<QueryCtx, "db">,
  input: {
    principal: PrincipalRef;
    // The generation id may still ride along from the candidate scan; the
    // hydration recheck does not use it (I2, I7).
    targets: Array<{
      spaceId: Id<"spaces">;
      embeddingGenerationId?: Id<"embeddingGenerations">;
      fingerprint: string;
    }>;
    embeddingVectorIds: Id<"embeddingVectors">[];
  },
): Promise<
  Array<{
    embeddingVectorId: Id<"embeddingVectors">;
    chunkId: Id<"chunks">;
    spaceId: Id<"spaces">;
  }>
> {
  if (input.embeddingVectorIds.length > 256 || input.targets.length > 32) {
    throw new Error("Embedding candidate hydration exceeds its bound");
  }
  const requestedSpaces = input.targets.map((target) => target.spaceId);
  const authorized = new Set(
    await getAuthorizedReadSpaceIds(ctx, input.principal, requestedSpaces),
  );
  const activeTargets = new Map<string, ActiveEmbeddingTarget>();
  for (const target of input.targets) {
    if (!authorized.has(target.spaceId)) continue;
    activeTargets.set(
      String(target.spaceId),
      await requireActiveEmbeddingTarget(ctx, {
        spaceId: target.spaceId,
        fingerprint: target.fingerprint,
      }),
    );
  }
  const rows = await Promise.all(
    input.embeddingVectorIds.map((id) => ctx.db.get(id)),
  );
  const results = [];
  const accepted = new Set<string>();
  for (const row of rows) {
    if (
      !row ||
      row.targetKind !== "chunk" ||
      !row.chunkId ||
      !row.processingGenerationId
    ) {
      continue;
    }
    const active = activeTargets.get(String(row.spaceId));
    // I10: an incomplete chunk index is reported by the caller, never a reason
    // to drop a candidate whose own target is covered and eligible.
    if (
      !active ||
      active.fingerprint !== row.embeddingFingerprint ||
      row.thoughtId !== undefined ||
      row.scopeV2 !==
        embeddingVectorScopeV2({
          spaceId: row.spaceId,
          fingerprint: row.embeddingFingerprint,
          targetKind: "chunk",
        })
    ) {
      continue;
    }
    const targetKey = `${row.spaceId}:${row.chunkId}`;
    if (accepted.has(targetKey)) continue;
    if (!(await targetIsEligibleFor(ctx, row, String(row.chunkId)))) continue;
    const chunk = await ctx.db.get(row.chunkId);
    if (
      !chunk ||
      chunk.spaceId !== row.spaceId ||
      chunk.processingGenerationId !== row.processingGenerationId ||
      chunk.publicationState !== "active" ||
      row.inputHash !== (await sha256Hex(chunk.text))
    ) {
      continue;
    }
    const [document, generation] = await Promise.all([
      ctx.db.get(chunk.documentId),
      ctx.db.get(chunk.processingGenerationId),
    ]);
    const item = generation ? await ctx.db.get(generation.sourceItemId) : null;
    if (
      !document ||
      !generation ||
      !item ||
      document.publicationState !== "active" ||
      document.processingGenerationId !== generation._id ||
      generation.state !== "ready" ||
      item.activeGenerationId !== generation._id ||
      item.spaceId !== row.spaceId
    ) {
      continue;
    }
    accepted.add(targetKey);
    results.push({
      embeddingVectorId: row._id,
      chunkId: chunk._id,
      spaceId: row.spaceId,
    });
  }
  return results;
}
