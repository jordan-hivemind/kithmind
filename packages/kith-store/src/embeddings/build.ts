// P2-39g2: the paged build. Scan, fill, audit, one page per transaction.
//
// Ported from the build half of `models/embeddings/targets.ts`
// (`runEmbeddingBuildPage` with `runScanPage`, `runFillPage`, `runAuditPage`,
// `probeDuplicateRows`, `auditEmbeddingCounters`, `counterDriftReason`) plus
// the two operator entry points in `models/embeddings/migrations.ts` that a
// fresh PostgreSQL space still needs: `startTargetBackfill` becomes
// `startEmbeddingBuild` and `abandonTargetBackfill` becomes
// `abandonEmbeddingBuild`.
//
// Cursors. Convex's `.paginate()` returned an opaque `continueCursor` the job
// row stored; section 2.3 of the consolidation plan replaces it with a keyset,
// and this module encodes one as `JSON.stringify([stage, inner])` where `inner`
// is the last row of the page. Two keyset shapes are used, one per phase:
//
//   * `(created_at, id)` for the scan stages and the fill, because insertion
//     order is the order those tables are paged in and PostgreSQL does not
//     give it for free the way `_creationTime` did.
//   * `(target_kind, target_id)` for the audit, because it pages the identity
//     index the target table is already unique on.
//
// `created_at` is carried as `created_at::text` rather than as the `Date`
// node-pg parses, which rounds to milliseconds. A timestamp with microseconds
// would round to a value that is either before the row (repeating it forever)
// or after it (skipping its neighbours), and neither failure announces itself.
// The text goes back in as `$n::timestamptz`, which is exact.
//
// The compare-and-set on the stored cursor is unchanged and is the reason a
// duplicate or late call never writes twice: a caller passing anything other
// than the stored cursor is refused and gets the stored cursor back.

import { at, exec, row, rows, type IdentityCtx } from "../identity/db.js";
import { newKithId } from "../ids.js";
import { sha256Utf8 } from "../provenance/sql.js";
import {
  CARD_TARGET_EVENT_KEY,
  composeCardTargetInput,
} from "./cardTargets.js";
import {
  newChunkTargetCaches,
  resolveActiveChunkTarget,
  type ChunkRow,
} from "./chunkTargets.js";
import {
  assertTargetKind,
  EMBEDDING_TARGET_COLUMNS,
  isCurrentThought,
  retireEmbeddingTarget,
  setTargetCoverage,
  upsertEligibleTarget,
  type EmbeddingTargetWriteRow,
} from "./eligibility.js";
import { failEmbeddingGeneration } from "./generations.js";
import {
  addKindCounts,
  commitCounterDelta,
  countOf,
  emptyCounterDelta,
  ensureSpaceEmbeddingState,
  sameCounts,
  spaceEmbedsAllChunks,
  uniqueSpaceState,
  ZERO_HISTORICAL_COUNTS,
  ZERO_KIND_COUNTS,
  type EmbeddingCounterDelta,
  type SpaceEmbeddingStateRow,
} from "./state.js";
import {
  coveredCountsFor,
  embeddingKindCounts,
  type EmbeddingKindCounts,
} from "./targets.js";

/** Per-stage page bounds, from the plan's read and write budgets (1.4). */
export const EMBEDDING_THOUGHT_SCAN_PAGE = 64;
export const EMBEDDING_CHUNK_SCAN_PAGE = 128;
/** A card row is about 2 KiB of text, so 128 per page. */
export const EMBEDDING_CARD_SCAN_PAGE = 128;
export const EMBEDDING_TARGET_PAGE = 128;

/**
 * The audit phase reads vector rows, so it pages smaller than the other
 * stages: 64 targets at up to four rows each.
 */
export const EMBEDDING_AUDIT_PAGE = 64;

/**
 * Rows one target may hold before the duplicate probe stops reading. Two would
 * be enough in a space with no rollback artifact, but the retained fingerprint
 * keeps one row per target, so a two-row probe would be spent before it reached
 * the duplicate it is looking for. A saturated probe is reported, never counted
 * as clean.
 */
const MAX_TARGET_ROW_PROBE = 4;

/** The one-shot audit probes this many targets unless the caller asks for more. */
export const DEFAULT_DUPLICATE_PROBE = EMBEDDING_AUDIT_PAGE;
const MAX_DUPLICATE_PROBE = 128;

/** Named drift causes, so an operator reads a reason rather than a boolean. */
export const COUNTER_DRIFT_RECOUNT = "counter_recount_mismatch";
export const COUNTER_DRIFT_DUPLICATE_ROWS = "duplicate_active_fingerprint_rows";

export function counterDriftReason(input: {
  recountMismatch: boolean;
  duplicateTargets: number;
}): string | null {
  const reasons = [
    ...(input.recountMismatch ? [COUNTER_DRIFT_RECOUNT] : []),
    ...(input.duplicateTargets > 0 ? [COUNTER_DRIFT_DUPLICATE_ROWS] : []),
  ];
  return reasons.length > 0 ? reasons.join(",") : null;
}

export type EmbeddingBuildPhase =
  "scan" | "fill" | "audit" | "done" | "abandoned";

export type EmbeddingBuildJobRow = {
  id: string;
  space_id: string;
  fingerprint: string;
  embedding_generation_id: string | null;
  phase: string;
  cursor: string | null;
  page_index: string | number | null;
  scanned_count: string | number | null;
  filled_count: string | number | null;
  retired_count: string | number | null;
  audit_eligible_counts: unknown;
  audit_covered_counts: unknown;
  audit_duplicate_targets: string | number | null;
  started_at: Date | null;
};

const JOB_COLUMNS = `id, space_id, fingerprint, embedding_generation_id, phase,
  cursor, page_index, scanned_count, filled_count, retired_count,
  audit_eligible_counts, audit_covered_counts, audit_duplicate_targets,
  started_at`;

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

type ScanStage = "thoughts" | "chunks" | "cards" | "sweep";

/** The last row of a page, in whichever keyset that page is ordered by. */
type Keyset = readonly [string, string];

type ScanCursor = { stage: ScanStage; cursor: Keyset | null };

function encodeKeyset(value: Keyset | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function decodeKeyset(value: unknown): Keyset | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new Error("Embedding build cursor is malformed");
  }
  return [value[0], value[1]];
}

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
      parsed[0] !== "cards" &&
      parsed[0] !== "sweep")
  ) {
    throw new Error("Embedding build cursor is malformed");
  }
  return { stage: parsed[0], cursor: decodeKeyset(parsed[1]) };
}

function decodePhaseCursor(value: string | null): Keyset | null {
  if (value === null) return null;
  return decodeKeyset(JSON.parse(value) as unknown);
}

/** One page of a `(created_at, id)` keyset, plus the cursor that follows it. */
type KeysetPage<T> = { page: T[]; next: Keyset | null };

async function keysetPage<T extends { id: string; created_at_text: string }>(
  ctx: IdentityCtx,
  sql: (predicate: string, limitParam: string) => string,
  values: readonly unknown[],
  cursor: Keyset | null,
  limit: number,
): Promise<KeysetPage<T>> {
  const bound = [...values];
  let predicate = "";
  if (cursor) {
    bound.push(cursor[0], cursor[1]);
    predicate = `AND (created_at, id) > ($${bound.length - 1}::timestamptz, $${bound.length})`;
  }
  bound.push(limit + 1);
  const found = await rows<T>(ctx, sql(predicate, `$${bound.length}`), bound);
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  return {
    page,
    next:
      found.length > limit && last
        ? ([last.created_at_text, last.id] as Keyset)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Duplicate probe
// ---------------------------------------------------------------------------

export type DuplicateRowProbe = {
  /** Targets holding more than one row under this fingerprint. */
  duplicates: number;
  /** Targets whose probe filled up, so a further row cannot be ruled out. */
  saturated: number;
  scanned: number;
};

async function targetVectorRowProbe(
  ctx: IdentityCtx,
  record: EmbeddingTargetWriteRow,
): Promise<
  { space_id: string; embedding_fingerprint: string; target_kind: string }[]
> {
  const kind = assertTargetKind(record.target_kind);
  const column =
    kind === "thought"
      ? "thought_id"
      : kind === "card"
        ? "event_id"
        : "chunk_id";
  return await rows(
    ctx,
    `SELECT space_id, embedding_fingerprint, target_kind
       FROM kith.embedding_vectors WHERE ${column} = $1
      ORDER BY created_at, id LIMIT $2`,
    [record.target_id, MAX_TARGET_ROW_PROBE],
  );
}

/**
 * I11, as an audit. A target with two rows under the active fingerprint is
 * invisible to the reader, which dedupes by target, but both rows take a slot
 * of the fixed candidate budget, so a retrievable target can fall out of top-k.
 * Counting them is the only way that state is reported.
 *
 * Only targets this fingerprint covers are probed, which bounds the reads and
 * leaves an uncovered target, whose rows are cleanup's business, out of it.
 */
export async function probeDuplicateRows(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    fingerprint: string;
    rows: readonly EmbeddingTargetWriteRow[];
  },
): Promise<DuplicateRowProbe> {
  let duplicates = 0;
  let saturated = 0;
  let scanned = 0;
  for (const record of input.rows) {
    if (record.state !== "eligible") continue;
    if (record.covered_fingerprint !== input.fingerprint) continue;
    const probe = await targetVectorRowProbe(ctx, record);
    scanned += 1;
    if (probe.length >= MAX_TARGET_ROW_PROBE) saturated += 1;
    const mine = probe.filter(
      (vector) =>
        vector.space_id === input.spaceId &&
        vector.embedding_fingerprint === input.fingerprint &&
        vector.target_kind === record.target_kind,
    ).length;
    if (mine > 1) duplicates += 1;
  }
  return { duplicates, saturated, scanned };
}

// ---------------------------------------------------------------------------
// The build job
// ---------------------------------------------------------------------------

export type BuildPageResult = {
  accepted: boolean;
  phase: EmbeddingBuildPhase;
  cursor: string | null;
  pageIndex: number;
  scanned: number;
  filled: number;
  retired: number;
  isDone: boolean;
  counterDrift: boolean;
  /** Targets holding more than one row under the build fingerprint. */
  duplicateTargets: number;
};

function jobPhase(job: EmbeddingBuildJobRow): EmbeddingBuildPhase {
  const phase = job.phase;
  if (
    phase !== "scan" &&
    phase !== "fill" &&
    phase !== "audit" &&
    phase !== "done" &&
    phase !== "abandoned"
  ) {
    throw new Error("Embedding build job phase is invalid");
  }
  return phase;
}

function pageResult(
  job: EmbeddingBuildJobRow,
  overrides: Partial<BuildPageResult> = {},
): BuildPageResult {
  const phase = jobPhase(job);
  return {
    accepted: true,
    phase,
    cursor: job.cursor,
    pageIndex: countOf(job.page_index, "Build page index"),
    scanned: 0,
    filled: 0,
    retired: 0,
    isDone: phase === "done" || phase === "abandoned",
    counterDrift: false,
    duplicateTargets: 0,
    ...overrides,
  };
}

export async function getEmbeddingBuildJob(
  ctx: IdentityCtx,
  jobId: string,
  forUpdate = false,
): Promise<EmbeddingBuildJobRow | null> {
  return await row<EmbeddingBuildJobRow>(
    ctx,
    `SELECT ${JOB_COLUMNS} FROM kith.embedding_build_jobs
      WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [jobId],
  );
}

async function requireSpaceState(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<SpaceEmbeddingStateRow> {
  const state = await uniqueSpaceState(ctx, spaceId, true);
  if (!state) throw new Error("Space embedding state not found");
  return state;
}

/**
 * Creates or reuses the one non-terminal build job for a space and fingerprint.
 * Rerunning it is a no-op that returns the job to resume.
 *
 * Ported from `migrations.ts:startTargetBackfill` minus its scheduler: it is
 * not a one-time data migration but the operation a fresh PostgreSQL space
 * needs to seed its counters and target rows at all.
 */
export async function startEmbeddingBuild(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    fingerprint?: string;
    dryRun?: boolean;
    now?: number;
  },
): Promise<{
  dryRun: boolean;
  reused: boolean;
  fingerprint: string;
  jobId?: string;
  phase?: EmbeddingBuildPhase;
  cursor?: string | null;
  existingTargetRows: number;
}> {
  const now = input.now ?? ctx.now;
  const dryRun = input.dryRun ?? false;
  const state = await ensureSpaceEmbeddingState(ctx, input.spaceId);
  const fingerprint = input.fingerprint ?? state.active_fingerprint;
  if (!fingerprint) {
    throw new Error(
      "Space has no active embedding fingerprint; pass one explicitly",
    );
  }
  const counted = await row<{ count: string }>(
    ctx,
    "SELECT count(*)::text AS count FROM kith.embedding_targets WHERE space_id = $1",
    [input.spaceId],
  );
  const existingTargetRows = Number(counted?.count ?? 0);
  const open = await rows<EmbeddingBuildJobRow>(
    ctx,
    `SELECT ${JOB_COLUMNS} FROM kith.embedding_build_jobs
      WHERE space_id = $1 AND fingerprint = $2
        AND phase NOT IN ('done', 'abandoned')
      ORDER BY created_at, id LIMIT 2 FOR UPDATE`,
    [input.spaceId, fingerprint],
  );
  if (open.length > 1) {
    throw new Error("Space has more than one open embedding build job");
  }
  const reusable = open[0];
  if (reusable) {
    return {
      dryRun,
      reused: true,
      fingerprint,
      jobId: reusable.id,
      phase: jobPhase(reusable),
      cursor: reusable.cursor,
      existingTargetRows,
    };
  }
  if (dryRun) {
    return { dryRun: true, reused: false, fingerprint, existingTargetRows };
  }
  const jobId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.embedding_build_jobs
       (id, space_id, created_at, fingerprint, embedding_generation_id, phase,
        cursor, page_index, scanned_count, filled_count, retired_count,
        started_at, updated_at)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, 'scan', NULL, 0, 0, 0, 0,
             $5, $5)`,
    [
      jobId,
      input.spaceId,
      fingerprint,
      state.active_embedding_generation_id &&
      state.active_fingerprint === fingerprint
        ? state.active_embedding_generation_id
        : null,
      at(now),
    ],
  );
  return {
    dryRun: false,
    reused: false,
    fingerprint,
    jobId,
    phase: "scan",
    cursor: null,
    existingTargetRows,
  };
}

/**
 * Section 3.5. A build under a fingerprint that is not the active one fails its
 * generation; a build under the active fingerprint deletes no vector, because
 * everything it inserted is valid coverage of the active index.
 */
export async function abandonEmbeddingBuild(
  ctx: IdentityCtx,
  input: { jobId: string; code: string; message: string; now?: number },
): Promise<{ phase: EmbeddingBuildPhase; generationFailed: boolean }> {
  const now = input.now ?? ctx.now;
  const job = await getEmbeddingBuildJob(ctx, input.jobId, true);
  if (!job) throw new Error("Embedding build job not found");
  if (job.phase === "abandoned") {
    return { phase: "abandoned", generationFailed: false };
  }
  const state = await uniqueSpaceState(ctx, job.space_id);
  const underActiveFingerprint = state?.active_fingerprint === job.fingerprint;
  let generationFailed = false;
  if (job.embedding_generation_id && !underActiveFingerprint) {
    const generation = await row<{ id: string; state: string | null }>(
      ctx,
      "SELECT id, state FROM kith.embedding_generations WHERE id = $1",
      [job.embedding_generation_id],
    );
    if (
      generation &&
      (generation.state === "staging" || generation.state === "staged")
    ) {
      await failEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation.id,
        code: input.code,
        message: input.message,
        failedAt: now,
      });
      generationFailed = true;
    }
  }
  await exec(
    ctx,
    `UPDATE kith.embedding_build_jobs
        SET phase = 'abandoned', cursor = NULL, failure_code = $2,
            failure_message = $3, updated_at = $4
      WHERE id = $1`,
    [job.id, input.code, input.message, at(now)],
  );
  return { phase: "abandoned", generationFailed };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

async function runScanPage(
  ctx: IdentityCtx,
  job: EmbeddingBuildJobRow,
  batchSize: number,
  now: number,
): Promise<{ cursor: string | null; scanned: number; retired: number }> {
  let state = await requireSpaceState(ctx, job.space_id);
  if (state.eligible_counts === null || state.eligible_counts === undefined) {
    // Seeding the counters at zero is what marks the space as counted. An
    // empty space would otherwise finish a build with absent counters and
    // keep failing closed forever.
    await exec(
      ctx,
      "UPDATE kith.space_embedding_states SET eligible_counts = $2::jsonb WHERE id = $1",
      [state.id, JSON.stringify(ZERO_KIND_COUNTS)],
    );
    state = { ...state, eligible_counts: { ...ZERO_KIND_COUNTS } };
  }
  const delta = emptyCounterDelta();
  const position = decodeScanCursor(job.cursor);
  const startedAt = job.started_at;
  let scanned = 0;
  let retired = 0;
  let next: ScanCursor;

  if (position.stage === "thoughts") {
    if (position.cursor === null) {
      // The thought stage visits every thought in the space exactly once, so
      // it is the one place that can count the historical buckets. Restarting
      // the stage restarts the count.
      await exec(
        ctx,
        `UPDATE kith.space_embedding_states
            SET historical_thought_counts = $2::jsonb WHERE id = $1`,
        [state.id, JSON.stringify(ZERO_HISTORICAL_COUNTS)],
      );
      state = {
        ...state,
        historical_thought_counts: { ...ZERO_HISTORICAL_COUNTS },
      };
    }
    const page = await keysetPage<{
      id: string;
      created_at_text: string;
      content: string;
      memory_status: string | null;
    }>(
      ctx,
      (predicate, limit) => `SELECT id, created_at::text AS created_at_text,
              content, memory_status
         FROM kith.thoughts WHERE space_id = $1 ${predicate}
        ORDER BY created_at, id LIMIT ${limit}`,
      [job.space_id],
      position.cursor,
      Math.min(batchSize, EMBEDDING_THOUGHT_SCAN_PAGE),
    );
    for (const thought of page.page) {
      if (!isCurrentThought(thought)) {
        if (
          thought.memory_status === "superseded" ||
          thought.memory_status === "retracted"
        ) {
          delta.history[thought.memory_status] += 1;
        }
        continue;
      }
      scanned += 1;
      await upsertEligibleTarget(
        ctx,
        {
          spaceId: job.space_id,
          targetKind: "thought",
          targetId: thought.id,
          inputHash: await sha256Utf8(thought.content),
          now,
        },
        delta,
      );
    }
    next =
      page.next === null
        ? { stage: "chunks", cursor: null }
        : { stage: "thoughts", cursor: page.next };
  } else if (position.stage === "chunks") {
    const page = await keysetPage<ChunkRow & { created_at_text: string }>(
      ctx,
      (predicate, limit) => `SELECT id, space_id, processing_generation_id,
              document_id, text, publication_state,
              created_at::text AS created_at_text
         FROM kith.chunks
        WHERE space_id = $1 AND publication_state = 'active' ${predicate}
        ORDER BY created_at, id LIMIT ${limit}`,
      [job.space_id],
      position.cursor,
      Math.min(batchSize, EMBEDDING_CHUNK_SCAN_PAGE),
    );
    const caches = newChunkTargetCaches();
    const embedsAllChunks = spaceEmbedsAllChunks(state);
    for (const chunk of page.page) {
      const resolved = await resolveActiveChunkTarget(
        ctx,
        job.space_id,
        chunk,
        caches,
      );
      if (!resolved) continue;
      // Section 8.2. An ineligible chunk is simply not upserted; the sweep
      // stage retires whatever row it used to have, so a policy flip
      // converges in one rerun of the same build.
      if (!embedsAllChunks && !resolved.optedIn) continue;
      scanned += 1;
      await upsertEligibleTarget(
        ctx,
        {
          spaceId: job.space_id,
          targetKind: "chunk",
          targetId: chunk.id,
          inputHash: await sha256Utf8(chunk.text ?? ""),
          processingGenerationId: resolved.processingGenerationId,
          now,
        },
        delta,
      );
    }
    next =
      page.next === null
        ? { stage: "cards", cursor: null }
        : { stage: "chunks", cursor: page.next };
  } else if (position.stage === "cards") {
    // One target per generic card event. The event is the stable identity, so
    // this page never depends on which card generation published it.
    const page = await keysetPage<{
      id: string;
      created_at_text: string;
      source_item_id: string | null;
      space_id: string;
      event_key: string | null;
    }>(
      ctx,
      (predicate, limit) => `SELECT id, space_id, source_item_id, event_key,
              created_at::text AS created_at_text
         FROM kith.events WHERE space_id = $1 ${predicate}
        ORDER BY created_at, id LIMIT ${limit}`,
      [job.space_id],
      position.cursor,
      Math.min(batchSize, EMBEDDING_CARD_SCAN_PAGE),
    );
    for (const event of page.page) {
      if (event.event_key !== CARD_TARGET_EVENT_KEY) continue;
      if (!event.source_item_id) continue;
      const composed = await composeCardTargetInput(
        ctx,
        job.space_id,
        event.source_item_id,
        event,
      );
      if (!composed) continue;
      scanned += 1;
      await upsertEligibleTarget(
        ctx,
        {
          spaceId: job.space_id,
          targetKind: "card",
          targetId: event.id,
          inputHash: await sha256Utf8(composed.text),
          now,
        },
        delta,
      );
    }
    next =
      page.next === null
        ? { stage: "sweep", cursor: null }
        : { stage: "cards", cursor: page.next };
  } else {
    // Anything still eligible that this run never touched is gone from the
    // live set; retiring it is what makes a rerun converge.
    const page = await keysetPage<
      EmbeddingTargetWriteRow & { created_at_text: string }
    >(
      ctx,
      (predicate, limit) => `SELECT ${EMBEDDING_TARGET_COLUMNS},
              created_at::text AS created_at_text
         FROM kith.embedding_targets
        WHERE space_id = $1 AND state = 'eligible' ${predicate}
        ORDER BY created_at, id LIMIT ${limit}`,
      [job.space_id],
      position.cursor,
      Math.min(batchSize, EMBEDDING_TARGET_PAGE),
    );
    for (const record of page.page) {
      if (
        startedAt !== null &&
        record.updated_at !== null &&
        record.updated_at.getTime() >= startedAt.getTime()
      ) {
        continue;
      }
      await retireEmbeddingTarget(ctx, record, now, delta);
      retired += 1;
    }
    next =
      page.next === null
        ? { stage: "sweep", cursor: null }
        : { stage: "sweep", cursor: page.next };
    if (page.next === null) {
      await commitCounterDelta(ctx, state, delta, now);
      return { cursor: null, scanned, retired };
    }
  }

  await commitCounterDelta(ctx, state, delta, now);
  return { cursor: encodeScanCursor(next), scanned, retired };
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

/** Finds the vector that covers exactly this target text under a fingerprint. */
async function findCoveringVector(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    fingerprint: string;
    row: EmbeddingTargetWriteRow;
  },
): Promise<{ id: string } | null> {
  const kind = assertTargetKind(input.row.target_kind);
  const column =
    kind === "thought"
      ? "thought_id"
      : kind === "card"
        ? "event_id"
        : "chunk_id";
  return await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.embedding_vectors
      WHERE ${column} = $1 AND space_id = $2 AND embedding_fingerprint = $3
        AND target_kind = $4 AND input_hash = $5
      ORDER BY created_at, id LIMIT 1`,
    [
      input.row.target_id,
      input.spaceId,
      input.fingerprint,
      kind,
      input.row.input_hash,
    ],
  );
}

async function runFillPage(
  ctx: IdentityCtx,
  job: EmbeddingBuildJobRow,
  batchSize: number,
  now: number,
): Promise<{ cursor: string | null; filled: number }> {
  const state = await requireSpaceState(ctx, job.space_id);
  const delta = emptyCounterDelta();
  const page = await keysetPage<
    EmbeddingTargetWriteRow & { created_at_text: string }
  >(
    ctx,
    (predicate, limit) => `SELECT ${EMBEDDING_TARGET_COLUMNS},
            created_at::text AS created_at_text
       FROM kith.embedding_targets
      WHERE space_id = $1 AND state = 'eligible' ${predicate}
      ORDER BY created_at, id LIMIT ${limit}`,
    [job.space_id],
    decodePhaseCursor(job.cursor),
    Math.min(batchSize, EMBEDDING_TARGET_PAGE),
  );
  let filled = 0;
  for (const record of page.page) {
    if (record.covered_fingerprint === job.fingerprint) continue;
    const vector = await findCoveringVector(ctx, {
      spaceId: job.space_id,
      fingerprint: job.fingerprint,
      row: record,
    });
    if (!vector) {
      // A marker naming another fingerprint is not coverage of this build.
      // Clearing it is what puts the row back on the owed index, so the
      // provider fill can find it without scanning the space.
      if (record.covered_fingerprint !== null) {
        await setTargetCoverage(ctx, record, null, now, delta);
      }
      continue;
    }
    await setTargetCoverage(ctx, record, job.fingerprint, now, delta);
    filled += 1;
  }
  await commitCounterDelta(ctx, state, delta, now);
  return { cursor: encodeKeyset(page.next), filled };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function runAuditPage(
  ctx: IdentityCtx,
  job: EmbeddingBuildJobRow,
  batchSize: number,
): Promise<{
  cursor: string | null;
  scanned: number;
  eligible: EmbeddingKindCounts;
  covered: EmbeddingKindCounts;
  duplicates: number;
  saturated: number;
}> {
  const limit = Math.min(batchSize, EMBEDDING_AUDIT_PAGE);
  const cursor = decodePhaseCursor(job.cursor);
  const bound: unknown[] = [job.space_id];
  let predicate = "";
  if (cursor) {
    bound.push(cursor[0], cursor[1]);
    predicate = `AND (target_kind, target_id) > ($${bound.length - 1}, $${bound.length})`;
  }
  bound.push(limit + 1);
  const found = await rows<EmbeddingTargetWriteRow>(
    ctx,
    `SELECT ${EMBEDDING_TARGET_COLUMNS} FROM kith.embedding_targets
      WHERE space_id = $1 ${predicate}
      ORDER BY target_kind, target_id LIMIT $${bound.length}`,
    bound,
  );
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  const next =
    found.length > limit && last
      ? ([last.target_kind ?? "", last.target_id ?? ""] as Keyset)
      : null;
  const eligible = { ...ZERO_KIND_COUNTS };
  const covered = { ...ZERO_KIND_COUNTS };
  for (const record of page) {
    if (record.state !== "eligible") continue;
    const kind = assertTargetKind(record.target_kind);
    eligible[kind] += 1;
    if (record.covered_fingerprint === job.fingerprint) covered[kind] += 1;
  }
  // The whole-space duplicate guarantee is this paged probe: the one-shot
  // audit below reads a bounded prefix, but every target passes through here.
  const probe = await probeDuplicateRows(ctx, {
    spaceId: job.space_id,
    fingerprint: job.fingerprint,
    rows: page,
  });
  return {
    cursor: encodeKeyset(next),
    scanned: page.length,
    eligible,
    covered,
    duplicates: probe.duplicates,
    saturated: probe.saturated,
  };
}

function storedCounts(value: unknown): EmbeddingKindCounts {
  if (value === null || value === undefined) return { ...ZERO_KIND_COUNTS };
  return embeddingKindCounts(value);
}

/**
 * Runs one page of a build under compare-and-set on the stored cursor. A caller
 * passing anything other than the stored cursor is refused and gets the stored
 * cursor back, so a duplicate or late call never writes twice.
 */
export async function runEmbeddingBuildPage(
  ctx: IdentityCtx,
  input: {
    jobId: string;
    cursor: string | null;
    batchSize?: number;
    now?: number;
  },
): Promise<BuildPageResult> {
  const now = input.now ?? ctx.now;
  const job = await getEmbeddingBuildJob(ctx, input.jobId, true);
  if (!job) throw new Error("Embedding build job not found");
  const phase = jobPhase(job);
  if (phase === "done" || phase === "abandoned") {
    return pageResult(job, { isDone: true });
  }
  if ((job.cursor ?? null) !== (input.cursor ?? null)) {
    return pageResult(job, { accepted: false, isDone: false });
  }
  const batchSize = Math.min(
    Math.max(input.batchSize ?? EMBEDDING_TARGET_PAGE, 1),
    EMBEDDING_TARGET_PAGE,
  );
  const pageIndex = countOf(job.page_index, "Build page index") + 1;

  if (phase === "scan") {
    const result = await runScanPage(ctx, job, batchSize, now);
    const done = result.cursor === null;
    await exec(
      ctx,
      `UPDATE kith.embedding_build_jobs
          SET phase = $2, cursor = $3, page_index = $4, scanned_count = $5,
              retired_count = $6, updated_at = $7
        WHERE id = $1`,
      [
        job.id,
        done ? "fill" : "scan",
        result.cursor,
        pageIndex,
        countOf(job.scanned_count, "Scanned count") + result.scanned,
        countOf(job.retired_count, "Retired count") + result.retired,
        at(now),
      ],
    );
    return pageResult(job, {
      phase: done ? "fill" : "scan",
      cursor: result.cursor,
      pageIndex,
      scanned: result.scanned,
      retired: result.retired,
      isDone: false,
    });
  }

  if (phase === "fill") {
    const result = await runFillPage(ctx, job, batchSize, now);
    const done = result.cursor === null;
    // The audit accumulators are reset only on the page that *enters* the
    // audit phase, so a resumed audit adds to what earlier audit pages
    // counted rather than starting over.
    await exec(
      ctx,
      `UPDATE kith.embedding_build_jobs
          SET phase = $2, cursor = $3, page_index = $4, filled_count = $5,
              updated_at = $6${
                done
                  ? `, audit_eligible_counts = $7::jsonb,
              audit_covered_counts = $7::jsonb, audit_duplicate_targets = 0`
                  : ""
              }
        WHERE id = $1`,
      [
        job.id,
        done ? "audit" : "fill",
        result.cursor,
        pageIndex,
        countOf(job.filled_count, "Filled count") + result.filled,
        at(now),
        ...(done ? [JSON.stringify(ZERO_KIND_COUNTS)] : []),
      ],
    );
    return pageResult(job, {
      phase: done ? "audit" : "fill",
      cursor: result.cursor,
      pageIndex,
      filled: result.filled,
      isDone: false,
    });
  }

  const result = await runAuditPage(ctx, job, batchSize);
  const eligible = addKindCounts(
    storedCounts(job.audit_eligible_counts),
    result.eligible,
  );
  const covered = addKindCounts(
    storedCounts(job.audit_covered_counts),
    result.covered,
  );
  const duplicateTargets =
    (job.audit_duplicate_targets === null
      ? 0
      : countOf(job.audit_duplicate_targets, "Audit duplicate targets")) +
    result.duplicates;
  const done = result.cursor === null;
  let drift = false;
  if (done) {
    const state = await requireSpaceState(ctx, job.space_id);
    const recountMismatch =
      !sameCounts(storedCounts(state.eligible_counts), eligible) ||
      !sameCounts(coveredCountsFor(state, job.fingerprint), covered);
    // A target with two rows under one fingerprint is drift the counters
    // cannot show: both rows mark the same target covered exactly once.
    drift = recountMismatch || duplicateTargets > 0;
    await exec(
      ctx,
      `UPDATE kith.space_embedding_states
          SET counter_drift = $2, counter_drift_reason = $3, last_audit_at = $4
        WHERE id = $1`,
      [
        state.id,
        drift,
        counterDriftReason({ recountMismatch, duplicateTargets }),
        at(now),
      ],
    );
  }
  await exec(
    ctx,
    `UPDATE kith.embedding_build_jobs
        SET phase = $2, cursor = $3, page_index = $4,
            audit_eligible_counts = $5::jsonb,
            audit_covered_counts = $6::jsonb, audit_duplicate_targets = $7,
            updated_at = $8
      WHERE id = $1`,
    [
      job.id,
      done ? "done" : "audit",
      result.cursor,
      pageIndex,
      JSON.stringify(eligible),
      JSON.stringify(covered),
      duplicateTargets,
      at(now),
    ],
  );
  return pageResult(job, {
    phase: done ? "done" : "audit",
    cursor: result.cursor,
    pageIndex,
    scanned: result.scanned,
    isDone: done,
    counterDrift: drift,
    duplicateTargets,
  });
}

/**
 * Recounts the target table and compares it with the stored counters. The
 * recount reads target rows only, so it stays inside one transaction at the
 * production corpus size and reports incompleteness instead of guessing.
 */
export async function auditEmbeddingCounters(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    fingerprint: string;
    maxRows?: number;
    duplicateProbeLimit?: number;
    repair?: boolean;
    now?: number;
  },
): Promise<{
  complete: boolean;
  scanned: number;
  counterDrift: boolean;
  counterDriftReason?: string;
  duplicateTargets: number;
  duplicateProbeScanned: number;
  duplicateProbeSaturated: number;
  duplicateProbeComplete: boolean;
  recountedEligible: EmbeddingKindCounts;
  recountedCovered: EmbeddingKindCounts;
  storedEligible: EmbeddingKindCounts;
  storedCovered: EmbeddingKindCounts;
  repaired: boolean;
}> {
  const now = input.now ?? ctx.now;
  const state = await requireSpaceState(ctx, input.spaceId);
  const maxRows = Math.min(Math.max(input.maxRows ?? 2048, 1), 4096);
  const found = await rows<EmbeddingTargetWriteRow>(
    ctx,
    `SELECT ${EMBEDDING_TARGET_COLUMNS} FROM kith.embedding_targets
      WHERE space_id = $1 ORDER BY target_kind, target_id LIMIT $2`,
    [input.spaceId, maxRows + 1],
  );
  const complete = found.length <= maxRows;
  const eligible = { ...ZERO_KIND_COUNTS };
  const covered = { ...ZERO_KIND_COUNTS };
  for (const record of found.slice(0, maxRows)) {
    if (record.state !== "eligible") continue;
    const kind = assertTargetKind(record.target_kind);
    eligible[kind] += 1;
    if (record.covered_fingerprint === input.fingerprint) covered[kind] += 1;
  }
  const storedEligible = storedCounts(state.eligible_counts);
  const storedCovered = coveredCountsFor(state, input.fingerprint);
  const recountMismatch =
    complete &&
    (!sameCounts(storedEligible, eligible) ||
      !sameCounts(storedCovered, covered));
  // Vector rows are the expensive read, so the probe is a bounded prefix of
  // the covered targets rather than the whole table. The build job's audit
  // phase pages over every target and is the whole-space guarantee.
  const probeLimit = Math.min(
    Math.max(input.duplicateProbeLimit ?? DEFAULT_DUPLICATE_PROBE, 0),
    MAX_DUPLICATE_PROBE,
  );
  const coveredRows = found
    .slice(0, maxRows)
    .filter(
      (record) =>
        record.state === "eligible" &&
        record.covered_fingerprint === input.fingerprint,
    );
  const probe = await probeDuplicateRows(ctx, {
    spaceId: input.spaceId,
    fingerprint: input.fingerprint,
    rows: coveredRows.slice(0, probeLimit),
  });
  const duplicateProbeComplete = complete && coveredRows.length <= probeLimit;
  const drift = recountMismatch || probe.duplicates > 0;
  const reason = counterDriftReason({
    recountMismatch,
    duplicateTargets: probe.duplicates,
  });
  let repaired = false;
  if (complete) {
    const assignments = [
      "counter_drift = $2",
      "counter_drift_reason = $3",
      "last_audit_at = $4",
    ];
    const values: unknown[] = [state.id, drift, reason, at(now)];
    if (recountMismatch && input.repair) {
      const others = (
        Array.isArray(state.covered_counts) ? state.covered_counts : []
      ).filter(
        (entry: unknown) =>
          (entry as { fingerprint?: string }).fingerprint !== input.fingerprint,
      );
      values[1] = probe.duplicates > 0;
      // A recount repairs counters, never duplicate rows: only a cleanup
      // removes those, so their flag survives the repair.
      values[2] = counterDriftReason({
        recountMismatch: false,
        duplicateTargets: probe.duplicates,
      });
      values.push(JSON.stringify(eligible));
      assignments.push(`eligible_counts = $${values.length}::jsonb`);
      values.push(
        JSON.stringify([
          ...others,
          { fingerprint: input.fingerprint, counts: covered },
        ]),
      );
      assignments.push(`covered_counts = $${values.length}::jsonb`);
      repaired = true;
    }
    await exec(
      ctx,
      `UPDATE kith.space_embedding_states SET ${assignments.join(", ")}
        WHERE id = $1`,
      values,
    );
  }
  return {
    complete,
    scanned: Math.min(found.length, maxRows),
    counterDrift: drift,
    ...(reason === null ? {} : { counterDriftReason: reason }),
    duplicateTargets: probe.duplicates,
    duplicateProbeScanned: probe.scanned,
    duplicateProbeSaturated: probe.saturated,
    duplicateProbeComplete,
    recountedEligible: eligible,
    recountedCovered: covered,
    storedEligible,
    storedCovered,
    repaired,
  };
}

export type { EmbeddingCounterDelta };
