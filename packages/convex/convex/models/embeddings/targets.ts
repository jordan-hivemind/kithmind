import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { sha256Hex } from "../ingestion/hash";

/**
 * Durable, resumable target bookkeeping for the embedding index.
 *
 * `embeddingTargets` holds one row per eligible target per space and the space
 * state holds the transactional counters those rows are summarised by. Nothing
 * here is read by a retrieval path: the reader cutover is a later PR.
 */

/** Design ceiling from the index-capacity plan. No page bound may preclude it. */
export const EMBEDDING_TARGET_CAPACITY_CEILING = 50_000;

/** Per-stage page bounds, sized from the plan's read and write budgets. */
export const EMBEDDING_THOUGHT_SCAN_PAGE = 64;
export const EMBEDDING_CHUNK_SCAN_PAGE = 128;
export const EMBEDDING_TARGET_PAGE = 128;

/** A space row stays small: active plus retired fingerprints, never a history. */
const MAX_COVERED_FINGERPRINTS = 16;

export type EmbeddingTargetKind = "thought" | "chunk" | "card";

export type EmbeddingKindCounts = {
  thought: number;
  chunk: number;
  card: number;
};

export const ZERO_KIND_COUNTS: EmbeddingKindCounts = {
  thought: 0,
  chunk: 0,
  card: 0,
};

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/**
 * I2: the generation-free vector scope. A pure function of space, fingerprint
 * and target kind, with the space first so one equality comparison still
 * isolates a space.
 */
export function embeddingVectorScopeV2(input: {
  spaceId: Id<"spaces"> | string;
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

export function isCurrentThought(thought: Doc<"thoughts">): boolean {
  return (
    thought.memoryStatus === undefined || thought.memoryStatus === "current"
  );
}

// ---------------------------------------------------------------------------
// Counter deltas
// ---------------------------------------------------------------------------

/**
 * Signed counter changes accumulated while a page runs, then written once.
 * Every delta is committed in the same transaction as the rows that caused it,
 * which is what I4 requires.
 */
export type EmbeddingCounterDelta = {
  eligible: EmbeddingKindCounts;
  covered: Map<string, EmbeddingKindCounts>;
};

export function emptyCounterDelta(): EmbeddingCounterDelta {
  return { eligible: { ...ZERO_KIND_COUNTS }, covered: new Map() };
}

export function addEligibleDelta(
  delta: EmbeddingCounterDelta,
  kind: EmbeddingTargetKind,
  amount: number,
): void {
  delta.eligible[kind] += amount;
}

export function addCoveredDelta(
  delta: EmbeddingCounterDelta,
  fingerprint: string,
  kind: EmbeddingTargetKind,
  amount: number,
): void {
  const counts = delta.covered.get(fingerprint) ?? { ...ZERO_KIND_COUNTS };
  counts[kind] += amount;
  delta.covered.set(fingerprint, counts);
}

function counterDeltaIsEmpty(delta: EmbeddingCounterDelta): boolean {
  const eligibleChanged = (Object.values(delta.eligible) as number[]).some(
    (value) => value !== 0,
  );
  if (eligibleChanged) return false;
  for (const counts of delta.covered.values()) {
    if ((Object.values(counts) as number[]).some((value) => value !== 0)) {
      return false;
    }
  }
  return true;
}

function eligibleChanged(delta: EmbeddingCounterDelta): boolean {
  return (Object.values(delta.eligible) as number[]).some(
    (value) => value !== 0,
  );
}

function addKindCounts(
  base: EmbeddingKindCounts,
  addend: EmbeddingKindCounts,
): EmbeddingKindCounts {
  const sum = {
    thought: base.thought + addend.thought,
    chunk: base.chunk + addend.chunk,
    card: base.card + addend.card,
  };
  for (const [kind, value] of Object.entries(sum)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Embedding ${kind} counter went out of range`);
    }
  }
  return sum;
}

export function coveredCountsFor(
  state: Doc<"spaceEmbeddingStates">,
  fingerprint: string,
): EmbeddingKindCounts {
  const row = state.coveredCounts?.find(
    (entry) => entry.fingerprint === fingerprint,
  );
  return row ? { ...row.counts } : { ...ZERO_KIND_COUNTS };
}

/** Writes an accumulated delta onto the space state in one patch. */
export async function commitCounterDelta(
  ctx: MutationCtx,
  state: Doc<"spaceEmbeddingStates">,
  delta: EmbeddingCounterDelta,
  now: number,
): Promise<void> {
  if (counterDeltaIsEmpty(delta)) return;
  const patch: Partial<Doc<"spaceEmbeddingStates">> = {};
  if (eligibleChanged(delta)) {
    patch.eligibleCounts = addKindCounts(
      state.eligibleCounts ?? ZERO_KIND_COUNTS,
      delta.eligible,
    );
    patch.lastEligibilityChangeAt = now;
  }
  if (delta.covered.size > 0) {
    const covered = new Map(
      (state.coveredCounts ?? []).map((entry) => [
        entry.fingerprint,
        entry.counts,
      ]),
    );
    for (const [fingerprint, counts] of delta.covered) {
      covered.set(
        fingerprint,
        addKindCounts(covered.get(fingerprint) ?? ZERO_KIND_COUNTS, counts),
      );
    }
    if (covered.size > MAX_COVERED_FINGERPRINTS) {
      throw new Error(
        "Embedding covered counters exceed their fingerprint cap",
      );
    }
    patch.coveredCounts = [...covered].map(([fingerprint, counts]) => ({
      fingerprint,
      counts,
    }));
  }
  await ctx.db.patch(state._id, patch);
}

// ---------------------------------------------------------------------------
// Target rows
// ---------------------------------------------------------------------------

export async function findEmbeddingTarget(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  targetKind: EmbeddingTargetKind,
  targetId: string,
): Promise<Doc<"embeddingTargets"> | null> {
  const rows = await ctx.db
    .query("embeddingTargets")
    .withIndex("by_space_kind_target", (q) =>
      q
        .eq("spaceId", spaceId)
        .eq("targetKind", targetKind)
        .eq("targetId", targetId),
    )
    .take(2);
  if (rows.length > 1) throw new Error("Duplicate embedding target row");
  return rows[0] ?? null;
}

/**
 * Creates or refreshes the row for an eligible target. A changed `inputHash`
 * drops the coverage marker, because the vector that covered the old text no
 * longer covers this target.
 */
export async function upsertEligibleTarget(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    targetKind: EmbeddingTargetKind;
    targetId: string;
    inputHash: string;
    processingGenerationId?: Id<"processingGenerations">;
    now: number;
  },
  delta: EmbeddingCounterDelta,
): Promise<"created" | "changed" | "unchanged"> {
  const existing = await findEmbeddingTarget(
    ctx,
    input.spaceId,
    input.targetKind,
    input.targetId,
  );
  if (!existing) {
    await ctx.db.insert("embeddingTargets", {
      spaceId: input.spaceId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      inputHash: input.inputHash,
      ...(input.processingGenerationId
        ? { processingGenerationId: input.processingGenerationId }
        : {}),
      state: "eligible",
      updatedAt: input.now,
    });
    addEligibleDelta(delta, input.targetKind, 1);
    return "created";
  }
  const hashChanged = existing.inputHash !== input.inputHash;
  const parentChanged =
    existing.processingGenerationId !== input.processingGenerationId;
  const wasRetired = existing.state === "retired";
  if (!hashChanged && !parentChanged && !wasRetired) {
    // Touching the row is what lets the scan sweep find rows it never visited.
    await ctx.db.patch(existing._id, { updatedAt: input.now });
    return "unchanged";
  }
  if (wasRetired) addEligibleDelta(delta, input.targetKind, 1);
  const dropsCoverage = hashChanged || parentChanged || wasRetired;
  if (dropsCoverage && existing.coveredFingerprint) {
    addCoveredDelta(delta, existing.coveredFingerprint, input.targetKind, -1);
  }
  await ctx.db.patch(existing._id, {
    inputHash: input.inputHash,
    processingGenerationId: input.processingGenerationId,
    state: "eligible",
    coveredFingerprint: dropsCoverage ? undefined : existing.coveredFingerprint,
    updatedAt: input.now,
  });
  return wasRetired ? "created" : "changed";
}

export async function retireEmbeddingTarget(
  ctx: MutationCtx,
  row: Doc<"embeddingTargets">,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<void> {
  if (row.state === "retired") return;
  addEligibleDelta(delta, row.targetKind, -1);
  if (row.coveredFingerprint) {
    addCoveredDelta(delta, row.coveredFingerprint, row.targetKind, -1);
  }
  await ctx.db.patch(row._id, {
    state: "retired",
    coveredFingerprint: undefined,
    updatedAt: now,
  });
}

/**
 * I4, covered half: called from the transaction that inserted or deleted the
 * vector, never from a later reconciliation of its own.
 */
export async function setTargetCoverage(
  ctx: MutationCtx,
  row: Doc<"embeddingTargets">,
  fingerprint: string | undefined,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<boolean> {
  if (row.coveredFingerprint === fingerprint) return false;
  if (row.coveredFingerprint) {
    addCoveredDelta(delta, row.coveredFingerprint, row.targetKind, -1);
  }
  if (fingerprint) addCoveredDelta(delta, fingerprint, row.targetKind, 1);
  await ctx.db.patch(row._id, {
    coveredFingerprint: fingerprint,
    updatedAt: now,
  });
  return true;
}

/**
 * Maintains the coverage marker and counters for a vector write or delete.
 * A space with no target rows yet is untouched, so this is dormant until the
 * backfill has seeded the table.
 */
export async function recordVectorCoverageChange(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    targetKind: EmbeddingTargetKind;
    targetId: string;
    fingerprint: string;
    inputHash: string;
    covered: boolean;
    now: number;
  },
): Promise<void> {
  const row = await findEmbeddingTarget(
    ctx,
    input.spaceId,
    input.targetKind,
    input.targetId,
  );
  if (!row || row.state !== "eligible") return;
  if (input.covered && row.inputHash !== input.inputHash) return;
  if (!input.covered && row.coveredFingerprint !== input.fingerprint) return;
  const state = await ctx.db
    .query("spaceEmbeddingStates")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", input.spaceId))
    .unique();
  if (!state) return;
  const delta = emptyCounterDelta();
  await setTargetCoverage(
    ctx,
    row,
    input.covered ? input.fingerprint : undefined,
    input.now,
    delta,
  );
  await commitCounterDelta(ctx, state, delta, input.now);
}

// ---------------------------------------------------------------------------
// Chunk eligibility, shared with the legacy whole-space manifest
// ---------------------------------------------------------------------------

export type ChunkTargetCaches = {
  documents: Map<string, Doc<"documents"> | null>;
  generations: Map<string, Doc<"processingGenerations"> | null>;
  items: Map<string, Doc<"sourceItems"> | null>;
  accounts: Map<string, Doc<"sourceAccounts"> | null>;
  revisions: Map<string, Doc<"sourceRevisions"> | null>;
  textVersions: Map<string, Doc<"sourceTextVersions"> | null>;
};

export function newChunkTargetCaches(): ChunkTargetCaches {
  return {
    documents: new Map(),
    generations: new Map(),
    items: new Map(),
    accounts: new Map(),
    revisions: new Map(),
    textVersions: new Map(),
  };
}

/**
 * Validates an active chunk's whole parent chain. Returns null when the chunk
 * belongs to a forgotten source item, which is a skip rather than a fault.
 */
export async function resolveActiveChunkTarget(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  chunk: Doc<"chunks">,
  caches: ChunkTargetCaches,
): Promise<{ processingGenerationId: Id<"processingGenerations"> } | null> {
  let document = caches.documents.get(chunk.documentId);
  if (document === undefined) {
    document = await ctx.db.get(chunk.documentId);
    caches.documents.set(chunk.documentId, document);
  }
  let generation = caches.generations.get(chunk.processingGenerationId);
  if (generation === undefined) {
    generation = await ctx.db.get(chunk.processingGenerationId);
    caches.generations.set(chunk.processingGenerationId, generation);
  }
  const itemId = generation?.sourceItemId;
  let item = itemId ? caches.items.get(itemId) : null;
  if (itemId && item === undefined) {
    item = await ctx.db.get(itemId);
    caches.items.set(itemId, item);
  }
  const accountId = generation?.sourceAccountId;
  let account = accountId ? caches.accounts.get(accountId) : null;
  if (accountId && account === undefined) {
    account = await ctx.db.get(accountId);
    caches.accounts.set(accountId, account);
  }
  const revisionId = generation?.sourceRevisionId;
  let revision = revisionId ? caches.revisions.get(revisionId) : null;
  if (revisionId && revision === undefined) {
    revision = await ctx.db.get(revisionId);
    caches.revisions.set(revisionId, revision);
  }
  const textVersionId = generation?.sourceTextVersionId;
  let textVersion = textVersionId
    ? caches.textVersions.get(textVersionId)
    : null;
  if (textVersionId && textVersion === undefined) {
    textVersion = await ctx.db.get(textVersionId);
    caches.textVersions.set(textVersionId, textVersion);
  }
  if (
    !document ||
    !generation ||
    !item ||
    !account ||
    !revision ||
    !textVersion ||
    document.spaceId !== spaceId ||
    document.processingGenerationId !== generation._id ||
    document.sourceItemId !== item._id ||
    document.sourceRevisionId !== generation.sourceRevisionId ||
    document.sourceTextVersionId !== generation.sourceTextVersionId ||
    document.publicationState !== "active" ||
    generation.spaceId !== spaceId ||
    generation.state !== "ready" ||
    generation.sourceAccountId !== item.sourceAccountId ||
    account.spaceId !== spaceId ||
    revision.spaceId !== spaceId ||
    revision.sourceItemId !== item._id ||
    textVersion.spaceId !== spaceId ||
    textVersion.sourceRevisionId !== revision._id ||
    !textVersion.evidenceSealed ||
    item.spaceId !== spaceId
  ) {
    throw new Error("Active chunk has an invalid processing parent chain");
  }
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    return null;
  }
  if (item.activeGenerationId !== generation._id) {
    throw new Error(
      "Active chunk is not in its source item's active generation",
    );
  }
  if (item.activeRevisionId !== revision._id) {
    throw new Error("Active chunk is not in its source item's active revision");
  }
  return { processingGenerationId: generation._id };
}

// ---------------------------------------------------------------------------
// Paged build
// ---------------------------------------------------------------------------

type ScanStage = "thoughts" | "chunks" | "sweep";

type ScanCursor = { stage: ScanStage; cursor: string | null };

function encodeScanCursor(value: ScanCursor): string {
  return JSON.stringify([value.stage, value.cursor]);
}

function decodeScanCursor(value: string | null): ScanCursor {
  if (value === null) return { stage: "thoughts", cursor: null };
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    (parsed[0] !== "thoughts" &&
      parsed[0] !== "chunks" &&
      parsed[0] !== "sweep")
  ) {
    throw new Error("Embedding build cursor is malformed");
  }
  const inner = parsed[1];
  if (inner !== null && typeof inner !== "string") {
    throw new Error("Embedding build cursor is malformed");
  }
  return { stage: parsed[0], cursor: inner };
}

export type BuildPageResult = {
  accepted: boolean;
  phase: Doc<"embeddingBuildJobs">["phase"];
  cursor: string | null;
  pageIndex: number;
  scanned: number;
  filled: number;
  retired: number;
  isDone: boolean;
  counterDrift: boolean;
};

function pageResult(
  job: Doc<"embeddingBuildJobs">,
  overrides: Partial<BuildPageResult> = {},
): BuildPageResult {
  return {
    accepted: true,
    phase: job.phase,
    cursor: job.cursor,
    pageIndex: job.pageIndex,
    scanned: 0,
    filled: 0,
    retired: 0,
    isDone: job.phase === "done" || job.phase === "abandoned",
    counterDrift: false,
    ...overrides,
  };
}

async function requireSpaceState(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
): Promise<Doc<"spaceEmbeddingStates">> {
  const state = await ctx.db
    .query("spaceEmbeddingStates")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .unique();
  if (!state) throw new Error("Space embedding state not found");
  return state;
}

async function runScanPage(
  ctx: MutationCtx,
  job: Doc<"embeddingBuildJobs">,
  batchSize: number,
  now: number,
): Promise<{ cursor: string | null; scanned: number; retired: number }> {
  const state = await requireSpaceState(ctx, job.spaceId);
  const delta = emptyCounterDelta();
  const position = decodeScanCursor(job.cursor);
  let scanned = 0;
  let retired = 0;
  let next: ScanCursor;

  if (position.stage === "thoughts") {
    const page = await ctx.db
      .query("thoughts")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", job.spaceId))
      .paginate({
        cursor: position.cursor,
        numItems: Math.min(batchSize, EMBEDDING_THOUGHT_SCAN_PAGE),
      });
    for (const thought of page.page) {
      if (!isCurrentThought(thought)) continue;
      scanned += 1;
      await upsertEligibleTarget(
        ctx,
        {
          spaceId: job.spaceId,
          targetKind: "thought",
          targetId: String(thought._id),
          inputHash: await sha256Hex(thought.content),
          now,
        },
        delta,
      );
    }
    next = page.isDone
      ? { stage: "chunks", cursor: null }
      : { stage: "thoughts", cursor: page.continueCursor };
  } else if (position.stage === "chunks") {
    const page = await ctx.db
      .query("chunks")
      .withIndex("by_spaceId_and_publicationState", (q) =>
        q.eq("spaceId", job.spaceId).eq("publicationState", "active"),
      )
      .paginate({
        cursor: position.cursor,
        numItems: Math.min(batchSize, EMBEDDING_CHUNK_SCAN_PAGE),
      });
    const caches = newChunkTargetCaches();
    for (const chunk of page.page) {
      const resolved = await resolveActiveChunkTarget(
        ctx,
        job.spaceId,
        chunk,
        caches,
      );
      if (!resolved) continue;
      scanned += 1;
      await upsertEligibleTarget(
        ctx,
        {
          spaceId: job.spaceId,
          targetKind: "chunk",
          targetId: String(chunk._id),
          inputHash: await sha256Hex(chunk.text),
          processingGenerationId: resolved.processingGenerationId,
          now,
        },
        delta,
      );
    }
    next = page.isDone
      ? { stage: "sweep", cursor: null }
      : { stage: "chunks", cursor: page.continueCursor };
  } else {
    // Anything still eligible that this run never touched is gone from the
    // live set; retiring it is what makes a rerun converge.
    const page = await ctx.db
      .query("embeddingTargets")
      .withIndex("by_space_and_state", (q) =>
        q.eq("spaceId", job.spaceId).eq("state", "eligible"),
      )
      .paginate({
        cursor: position.cursor,
        numItems: Math.min(batchSize, EMBEDDING_TARGET_PAGE),
      });
    for (const row of page.page) {
      if (row.updatedAt >= job.startedAt) continue;
      await retireEmbeddingTarget(ctx, row, now, delta);
      retired += 1;
    }
    next = page.isDone
      ? { stage: "sweep", cursor: null }
      : { stage: "sweep", cursor: page.continueCursor };
    if (page.isDone) {
      await commitCounterDelta(ctx, state, delta, now);
      return { cursor: null, scanned, retired };
    }
  }

  await commitCounterDelta(ctx, state, delta, now);
  return { cursor: encodeScanCursor(next), scanned, retired };
}

/** Finds the vector that covers exactly this target text under a fingerprint. */
async function findCoveringVector(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    fingerprint: string;
    row: Doc<"embeddingTargets">;
  },
): Promise<Doc<"embeddingVectors"> | null> {
  const { row } = input;
  if (row.targetKind === "card") return null;
  const thoughtId =
    row.targetKind === "thought"
      ? ctx.db.normalizeId("thoughts", row.targetId)
      : null;
  const chunkId =
    row.targetKind === "chunk"
      ? ctx.db.normalizeId("chunks", row.targetId)
      : null;
  if (!thoughtId && !chunkId) return null;
  const candidates = thoughtId
    ? await ctx.db
        .query("embeddingVectors")
        .withIndex("by_thoughtId", (q) => q.eq("thoughtId", thoughtId))
        .take(8)
    : await ctx.db
        .query("embeddingVectors")
        .withIndex("by_chunkId", (q) => q.eq("chunkId", chunkId!))
        .take(8);
  return (
    candidates.find(
      (candidate) =>
        candidate.spaceId === input.spaceId &&
        candidate.embeddingFingerprint === input.fingerprint &&
        candidate.targetKind === row.targetKind &&
        candidate.inputHash === row.inputHash,
    ) ?? null
  );
}

async function runFillPage(
  ctx: MutationCtx,
  job: Doc<"embeddingBuildJobs">,
  batchSize: number,
  now: number,
): Promise<{ cursor: string | null; filled: number }> {
  const state = await requireSpaceState(ctx, job.spaceId);
  const delta = emptyCounterDelta();
  const page = await ctx.db
    .query("embeddingTargets")
    .withIndex("by_space_and_state", (q) =>
      q.eq("spaceId", job.spaceId).eq("state", "eligible"),
    )
    .paginate({
      cursor: job.cursor,
      numItems: Math.min(batchSize, EMBEDDING_TARGET_PAGE),
    });
  let filled = 0;
  for (const row of page.page) {
    if (row.coveredFingerprint === job.fingerprint) continue;
    const vector = await findCoveringVector(ctx, {
      spaceId: job.spaceId,
      fingerprint: job.fingerprint,
      row,
    });
    if (!vector) continue;
    await setTargetCoverage(ctx, row, job.fingerprint, now, delta);
    filled += 1;
  }
  await commitCounterDelta(ctx, state, delta, now);
  return { cursor: page.isDone ? null : page.continueCursor, filled };
}

async function runAuditPage(
  ctx: MutationCtx,
  job: Doc<"embeddingBuildJobs">,
  batchSize: number,
): Promise<{
  cursor: string | null;
  scanned: number;
  eligible: EmbeddingKindCounts;
  covered: EmbeddingKindCounts;
}> {
  const page = await ctx.db
    .query("embeddingTargets")
    .withIndex("by_space_kind_target", (q) => q.eq("spaceId", job.spaceId))
    .paginate({
      cursor: job.cursor,
      numItems: Math.min(batchSize, EMBEDDING_TARGET_PAGE),
    });
  const eligible = { ...ZERO_KIND_COUNTS };
  const covered = { ...ZERO_KIND_COUNTS };
  for (const row of page.page) {
    if (row.state !== "eligible") continue;
    eligible[row.targetKind] += 1;
    if (row.coveredFingerprint === job.fingerprint) {
      covered[row.targetKind] += 1;
    }
  }
  return {
    cursor: page.isDone ? null : page.continueCursor,
    scanned: page.page.length,
    eligible,
    covered,
  };
}

function sameCounts(
  left: EmbeddingKindCounts,
  right: EmbeddingKindCounts,
): boolean {
  return (
    left.thought === right.thought &&
    left.chunk === right.chunk &&
    left.card === right.card
  );
}

/**
 * Runs one page of a build under compare-and-set on the stored cursor. A
 * caller passing anything other than the stored cursor is refused and gets the
 * stored cursor back, so a duplicate or late call never writes twice.
 */
export async function runEmbeddingBuildPage(
  ctx: MutationCtx,
  input: {
    jobId: Id<"embeddingBuildJobs">;
    cursor: string | null;
    batchSize?: number;
    now: number;
  },
): Promise<BuildPageResult> {
  const job = await ctx.db.get(input.jobId);
  if (!job) throw new Error("Embedding build job not found");
  if (job.phase === "done" || job.phase === "abandoned") {
    return pageResult(job, { isDone: true });
  }
  if ((job.cursor ?? null) !== (input.cursor ?? null)) {
    return pageResult(job, { accepted: false, isDone: false });
  }
  const batchSize = Math.min(
    Math.max(input.batchSize ?? EMBEDDING_TARGET_PAGE, 1),
    EMBEDDING_TARGET_PAGE,
  );

  if (job.phase === "scan") {
    const result = await runScanPage(ctx, job, batchSize, input.now);
    const done = result.cursor === null;
    await ctx.db.patch(job._id, {
      phase: done ? "fill" : "scan",
      cursor: result.cursor,
      pageIndex: job.pageIndex + 1,
      scannedCount: job.scannedCount + result.scanned,
      retiredCount: job.retiredCount + result.retired,
      updatedAt: input.now,
    });
    return pageResult(job, {
      phase: done ? "fill" : "scan",
      cursor: result.cursor,
      pageIndex: job.pageIndex + 1,
      scanned: result.scanned,
      retired: result.retired,
      isDone: false,
    });
  }

  if (job.phase === "fill") {
    const result = await runFillPage(ctx, job, batchSize, input.now);
    const done = result.cursor === null;
    await ctx.db.patch(job._id, {
      phase: done ? "audit" : "fill",
      cursor: result.cursor,
      pageIndex: job.pageIndex + 1,
      filledCount: job.filledCount + result.filled,
      ...(done
        ? {
            auditEligibleCounts: { ...ZERO_KIND_COUNTS },
            auditCoveredCounts: { ...ZERO_KIND_COUNTS },
          }
        : {}),
      updatedAt: input.now,
    });
    return pageResult(job, {
      phase: done ? "audit" : "fill",
      cursor: result.cursor,
      pageIndex: job.pageIndex + 1,
      filled: result.filled,
      isDone: false,
    });
  }

  const result = await runAuditPage(ctx, job, batchSize);
  const eligible = addKindCounts(
    job.auditEligibleCounts ?? ZERO_KIND_COUNTS,
    result.eligible,
  );
  const covered = addKindCounts(
    job.auditCoveredCounts ?? ZERO_KIND_COUNTS,
    result.covered,
  );
  const done = result.cursor === null;
  let drift = false;
  if (done) {
    const state = await requireSpaceState(ctx, job.spaceId);
    drift =
      !sameCounts(state.eligibleCounts ?? ZERO_KIND_COUNTS, eligible) ||
      !sameCounts(coveredCountsFor(state, job.fingerprint), covered);
    await ctx.db.patch(state._id, {
      counterDrift: drift,
      lastAuditAt: input.now,
    });
  }
  await ctx.db.patch(job._id, {
    phase: done ? "done" : "audit",
    cursor: result.cursor,
    pageIndex: job.pageIndex + 1,
    auditEligibleCounts: eligible,
    auditCoveredCounts: covered,
    updatedAt: input.now,
  });
  return pageResult(job, {
    phase: done ? "done" : "audit",
    cursor: result.cursor,
    pageIndex: job.pageIndex + 1,
    scanned: result.scanned,
    isDone: done,
    counterDrift: drift,
  });
}

/**
 * Recounts the target table and compares it with the stored counters. The
 * recount reads target rows only, so it stays inside one transaction at the
 * production corpus size and reports incompleteness instead of guessing.
 */
export async function auditEmbeddingCounters(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    fingerprint: string;
    maxRows?: number;
    repair?: boolean;
    now: number;
  },
): Promise<{
  complete: boolean;
  scanned: number;
  counterDrift: boolean;
  recountedEligible: EmbeddingKindCounts;
  recountedCovered: EmbeddingKindCounts;
  storedEligible: EmbeddingKindCounts;
  storedCovered: EmbeddingKindCounts;
  repaired: boolean;
}> {
  const state = await requireSpaceState(ctx, input.spaceId);
  const maxRows = Math.min(Math.max(input.maxRows ?? 2048, 1), 4096);
  const rows = await ctx.db
    .query("embeddingTargets")
    .withIndex("by_space_kind_target", (q) => q.eq("spaceId", input.spaceId))
    .take(maxRows + 1);
  const complete = rows.length <= maxRows;
  const eligible = { ...ZERO_KIND_COUNTS };
  const covered = { ...ZERO_KIND_COUNTS };
  for (const row of rows.slice(0, maxRows)) {
    if (row.state !== "eligible") continue;
    eligible[row.targetKind] += 1;
    if (row.coveredFingerprint === input.fingerprint) {
      covered[row.targetKind] += 1;
    }
  }
  const storedEligible = state.eligibleCounts ?? { ...ZERO_KIND_COUNTS };
  const storedCovered = coveredCountsFor(state, input.fingerprint);
  const drift =
    complete &&
    (!sameCounts(storedEligible, eligible) ||
      !sameCounts(storedCovered, covered));
  let repaired = false;
  if (complete) {
    const patch: Partial<Doc<"spaceEmbeddingStates">> = {
      counterDrift: drift,
      lastAuditAt: input.now,
    };
    if (drift && input.repair) {
      const others = (state.coveredCounts ?? []).filter(
        (entry) => entry.fingerprint !== input.fingerprint,
      );
      patch.eligibleCounts = eligible;
      patch.coveredCounts = [
        ...others,
        { fingerprint: input.fingerprint, counts: covered },
      ];
      patch.counterDrift = false;
      repaired = true;
    }
    await ctx.db.patch(state._id, patch);
  }
  return {
    complete,
    scanned: Math.min(rows.length, maxRows),
    counterDrift: drift,
    recountedEligible: eligible,
    recountedCovered: covered,
    storedEligible,
    storedCovered,
    repaired,
  };
}
