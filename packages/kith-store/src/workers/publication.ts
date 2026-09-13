import { sha256Hex } from "../ingestion/inline.js";
import { newKithId } from "../ids.js";
import { at, exec, rows, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";

type KindCounts = { thought: number; chunk: number; card: number };
type CoveredCount = { fingerprint: string; counts: KindCounts };
type CounterDelta = {
  eligible: KindCounts;
  covered: Map<string, KindCounts>;
};

const ZERO_COUNTS: KindCounts = { thought: 0, chunk: 0, card: 0 };
const MAX_TOUCHED_CHUNKS = 256;
const MAX_COVERED_FINGERPRINTS = 16;

function fail(): never {
  workerProtocolError("scan_conflict");
}

function sqlCount(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  )
    fail();
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) fail();
  return count;
}

function jsonCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail();
  return value;
}

function kindCounts(value: unknown): KindCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !("thought" in record) ||
    !("chunk" in record) ||
    !("card" in record)
  )
    fail();
  return {
    thought: jsonCount(record.thought),
    chunk: jsonCount(record.chunk),
    card: jsonCount(record.card),
  };
}

function coveredCounts(value: unknown): CoveredCount[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_COVERED_FINGERPRINTS) fail();
  const found: CoveredCount[] = [];
  const fingerprints = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      fail();
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.fingerprint !== "string" ||
      !record.fingerprint ||
      fingerprints.has(record.fingerprint)
    )
      fail();
    fingerprints.add(record.fingerprint);
    found.push({
      fingerprint: record.fingerprint,
      counts: kindCounts(record.counts),
    });
  }
  return found;
}

function addCounts(left: KindCounts, right: KindCounts): KindCounts {
  const result = {
    thought: left.thought + right.thought,
    chunk: left.chunk + right.chunk,
    card: left.card + right.card,
  };
  if (
    Object.values(result).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    fail();
  return result;
}

function addCovered(
  delta: CounterDelta,
  fingerprint: string,
  amount: number,
): void {
  const counts = delta.covered.get(fingerprint) ?? { ...ZERO_COUNTS };
  counts.chunk += amount;
  delta.covered.set(fingerprint, counts);
}

export async function nextWorkerActivation(
  ctx: WorkerCtx,
  spaceId: string,
): Promise<{ activatedAt: number; priorId?: string; activationEpoch: number }> {
  const processingRows = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.space_processing_state WHERE space_id = $1
     ORDER BY created_at, id LIMIT 2 FOR UPDATE`,
    [spaceId],
  );
  if (processingRows.length > 1) fail();
  const queryRows = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.record_query_space_state WHERE space_id = $1
     ORDER BY created_at, id LIMIT 2 FOR UPDATE`,
    [spaceId],
  );
  if (queryRows.length > 1) fail();
  const prior = processingRows[0];
  const priorActivated =
    prior?.activated_at instanceof Date
      ? prior.activated_at.getTime()
      : ctx.now - 1;
  const snapshot =
    queryRows[0]?.snapshot_clock === null ||
    queryRows[0]?.snapshot_clock === undefined
      ? ctx.now - 1
      : Number(queryRows[0].snapshot_clock);
  if (
    !Number.isSafeInteger(ctx.now) ||
    ctx.now < 0 ||
    (prior !== undefined &&
      (!(prior.activated_at instanceof Date) ||
        !Number.isSafeInteger(priorActivated) ||
        priorActivated < 0 ||
        prior.activation_epoch === null ||
        !Number.isSafeInteger(Number(prior.activation_epoch)) ||
        Number(prior.activation_epoch) < 0)) ||
    (queryRows[0] !== undefined &&
      (!Number.isSafeInteger(snapshot) || snapshot < 0))
  )
    fail();
  const activationEpoch = prior ? Number(prior.activation_epoch) + 1 : 1;
  const activatedAt = Math.max(ctx.now, priorActivated + 1, snapshot + 1);
  if (
    !Number.isSafeInteger(activationEpoch) ||
    activationEpoch < 1 ||
    !Number.isSafeInteger(activatedAt) ||
    activatedAt < 0
  )
    fail();
  return {
    activatedAt,
    activationEpoch,
    ...(prior ? { priorId: String(prior.id) } : {}),
  };
}

export async function recordWorkerActivation(
  ctx: WorkerCtx,
  spaceId: string,
  activation: Awaited<ReturnType<typeof nextWorkerActivation>>,
): Promise<void> {
  if (activation.priorId) {
    await exec(
      ctx,
      `UPDATE kith.space_processing_state SET activation_epoch = $1,
       activated_at = $2 WHERE id = $3`,
      [
        activation.activationEpoch,
        at(activation.activatedAt),
        activation.priorId,
      ],
    );
  } else {
    await exec(
      ctx,
      `INSERT INTO kith.space_processing_state
       (id, space_id, created_at, activation_epoch, activated_at)
       VALUES ($1,$2,transaction_timestamp(),$3,$4)`,
      [
        newKithId(),
        spaceId,
        activation.activationEpoch,
        at(activation.activatedAt),
      ],
    );
  }
}

async function generationChunks(
  ctx: WorkerCtx,
  spaceId: string,
  generationId: string,
): Promise<Record<string, unknown>[]> {
  const found = await rows<Record<string, unknown>>(
    ctx,
    `SELECT id, space_id, processing_generation_id, text, publication_state
     FROM kith.chunks WHERE processing_generation_id = $1
     ORDER BY created_at, id LIMIT $2`,
    [generationId, MAX_TOUCHED_CHUNKS + 1],
  );
  if (found.length > MAX_TOUCHED_CHUNKS) fail();
  for (const chunk of found) {
    if (
      chunk.space_id !== spaceId ||
      chunk.processing_generation_id !== generationId ||
      typeof chunk.id !== "string" ||
      typeof chunk.text !== "string"
    )
      fail();
  }
  return found;
}

async function retireActiveVectors(
  ctx: WorkerCtx,
  spaceId: string,
  previousGenerationId: string,
  chunks: readonly Record<string, unknown>[],
  activeGenerationId: string,
  fingerprint: string,
): Promise<void> {
  for (const chunk of chunks) {
    const found = await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.embedding_vectors
       WHERE embedding_generation_id = $1 AND chunk_id = $2 LIMIT 2 FOR UPDATE`,
      [activeGenerationId, chunk.id],
    );
    if (found.length > 1) fail();
    const vector = found[0];
    if (!vector) continue;
    if (
      vector.space_id !== spaceId ||
      vector.target_kind !== "chunk" ||
      vector.processing_generation_id !== previousGenerationId ||
      vector.embedding_fingerprint !== fingerprint
    )
      fail();
    await exec(ctx, "DELETE FROM kith.embedding_vectors WHERE id = $1", [
      vector.id,
    ]);
  }
}

async function findTarget(
  ctx: WorkerCtx,
  spaceId: string,
  chunkId: string,
): Promise<Record<string, unknown> | null> {
  const found = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.embedding_targets
     WHERE space_id = $1 AND target_kind = 'chunk' AND target_id = $2
     ORDER BY created_at, id LIMIT 2 FOR UPDATE`,
    [spaceId, chunkId],
  );
  if (found.length > 1) fail();
  const target = found[0];
  if (!target) return null;
  if (
    target.space_id !== spaceId ||
    target.target_kind !== "chunk" ||
    target.target_id !== chunkId ||
    typeof target.input_hash !== "string" ||
    (target.state !== "eligible" && target.state !== "retired") ||
    (target.covered_fingerprint !== null &&
      typeof target.covered_fingerprint !== "string")
  )
    fail();
  return target;
}

async function touchGenerationTargets(
  ctx: WorkerCtx,
  spaceId: string,
  generationId: string,
  eligible: boolean,
  chunks: readonly Record<string, unknown>[],
  delta: CounterDelta,
): Promise<void> {
  for (const chunk of chunks) {
    const chunkId = String(chunk.id);
    const target = await findTarget(ctx, spaceId, chunkId);
    if (eligible && chunk.publication_state === "active") {
      const inputHash = await sha256Hex(String(chunk.text));
      if (!target) {
        await exec(
          ctx,
          `INSERT INTO kith.embedding_targets
           (id,space_id,created_at,target_kind,target_id,input_hash,
            processing_generation_id,state,updated_at)
           VALUES ($1,$2,transaction_timestamp(),'chunk',$3,$4,$5,'eligible',$6)`,
          [newKithId(), spaceId, chunkId, inputHash, generationId, at(ctx.now)],
        );
        delta.eligible.chunk += 1;
        continue;
      }
      const changed =
        target.state === "retired" ||
        target.input_hash !== inputHash ||
        target.processing_generation_id !== generationId;
      if (target.state === "retired") delta.eligible.chunk += 1;
      if (changed && typeof target.covered_fingerprint === "string")
        addCovered(delta, target.covered_fingerprint, -1);
      await exec(
        ctx,
        `UPDATE kith.embedding_targets SET input_hash=$1,
         processing_generation_id=$2,state='eligible',covered_fingerprint=$3,
         updated_at=$4 WHERE id=$5`,
        [
          inputHash,
          generationId,
          changed ? null : target.covered_fingerprint,
          at(ctx.now),
          target.id,
        ],
      );
      continue;
    }
    if (!target || target.state === "retired") continue;
    delta.eligible.chunk -= 1;
    if (typeof target.covered_fingerprint === "string")
      addCovered(delta, target.covered_fingerprint, -1);
    await exec(
      ctx,
      `UPDATE kith.embedding_targets SET state='retired',
       covered_fingerprint=NULL,updated_at=$1 WHERE id=$2`,
      [at(ctx.now), target.id],
    );
  }
}

/** Maintains the embedding rows whose eligibility one worker publish changes. */
export async function touchWorkerPublicationEmbedding(
  ctx: WorkerCtx,
  input: {
    spaceId: string;
    sourceItemId: string;
    sourceAccountId: string;
    processingGenerationId: string;
    previousGenerationId?: string;
  },
): Promise<void> {
  const stateRows = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.space_embedding_states WHERE space_id = $1
     ORDER BY created_at, id LIMIT 2 FOR UPDATE`,
    [input.spaceId],
  );
  if (stateRows.length > 1) fail();
  const state = stateRows[0];
  if (!state) {
    await exec(
      ctx,
      `INSERT INTO kith.space_embedding_states
       (id,space_id,created_at,eligibility_epoch)
       VALUES ($1,$2,transaction_timestamp(),1)`,
      [newKithId(), input.spaceId],
    );
    return;
  }
  const eligibilityEpoch = sqlCount(state.eligibility_epoch) + 1;
  if (!Number.isSafeInteger(eligibilityEpoch)) fail();
  const policy = state.target_policy ?? "all_chunks";
  if (policy !== "all_chunks" && policy !== "cards_and_opted_in_chunks") fail();
  const eligible =
    state.eligible_counts === null || state.eligible_counts === undefined
      ? null
      : kindCounts(state.eligible_counts);
  const covered = coveredCounts(state.covered_counts);
  if (state.last_audit_at !== null && !(state.last_audit_at instanceof Date))
    fail();
  const counted = eligible !== null && state.last_audit_at instanceof Date;

  const activeId = state.active_embedding_generation_id;
  const activeFingerprint = state.active_fingerprint;
  let activeGeneration: Record<string, unknown> | null = null;
  if (activeId !== null && activeId !== undefined) {
    if (typeof activeId !== "string") fail();
    const found = await rows<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.embedding_generations WHERE id=$1 LIMIT 2 FOR UPDATE",
      [activeId],
    );
    if (
      found.length !== 1 ||
      found[0]!.space_id !== input.spaceId ||
      found[0]!.state !== "active" ||
      found[0]!.deactivated_at !== null
    )
      fail();
    if (activeFingerprint !== null && activeFingerprint !== undefined) {
      if (
        typeof activeFingerprint !== "string" ||
        found[0]!.fingerprint !== activeFingerprint
      )
        fail();
      const profiles = await rows<Record<string, unknown>>(
        ctx,
        "SELECT * FROM kith.embedding_profiles WHERE id=$1 LIMIT 2",
        [found[0]!.embedding_profile_id],
      );
      if (
        profiles.length !== 1 ||
        profiles[0]!.fingerprint !== activeFingerprint
      )
        fail();
    }
    activeGeneration = found[0]!;
  }

  const currentChunks = await generationChunks(
    ctx,
    input.spaceId,
    input.processingGenerationId,
  );
  const previousChunks =
    input.previousGenerationId &&
    input.previousGenerationId !== input.processingGenerationId
      ? await generationChunks(ctx, input.spaceId, input.previousGenerationId)
      : [];
  if (
    activeGeneration &&
    typeof activeFingerprint === "string" &&
    input.previousGenerationId &&
    input.previousGenerationId !== input.processingGenerationId
  ) {
    await retireActiveVectors(
      ctx,
      input.spaceId,
      input.previousGenerationId,
      previousChunks,
      String(activeGeneration.id),
      activeFingerprint,
    );
  }

  let nextEligible = eligible;
  let nextCovered = covered;
  if (counted && eligible) {
    const itemRows = await rows<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.source_items WHERE id=$1 LIMIT 2 FOR UPDATE",
      [input.sourceItemId],
    );
    const accountRows = await rows<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.source_accounts WHERE id=$1 LIMIT 2 FOR UPDATE",
      [input.sourceAccountId],
    );
    if (
      itemRows.length !== 1 ||
      accountRows.length !== 1 ||
      itemRows[0]!.space_id !== input.spaceId ||
      itemRows[0]!.source_account_id !== input.sourceAccountId ||
      itemRows[0]!.active_generation_id !== input.processingGenerationId ||
      accountRows[0]!.space_id !== input.spaceId
    )
      fail();
    const chunksEligible =
      policy === "all_chunks" ||
      (itemRows[0]!.embed_full_chunks ??
        accountRows[0]!.embed_full_chunks ??
        false) === true;
    const delta: CounterDelta = {
      eligible: { ...ZERO_COUNTS },
      covered: new Map(),
    };
    await touchGenerationTargets(
      ctx,
      input.spaceId,
      input.processingGenerationId,
      chunksEligible,
      currentChunks,
      delta,
    );
    if (
      input.previousGenerationId &&
      input.previousGenerationId !== input.processingGenerationId
    ) {
      await touchGenerationTargets(
        ctx,
        input.spaceId,
        input.previousGenerationId,
        false,
        previousChunks,
        delta,
      );
    }
    nextEligible = addCounts(eligible, delta.eligible);
    const nextCoveredMap = new Map(
      covered.map((entry) => [entry.fingerprint, entry.counts]),
    );
    for (const [fingerprint, change] of delta.covered) {
      nextCoveredMap.set(
        fingerprint,
        addCounts(nextCoveredMap.get(fingerprint) ?? ZERO_COUNTS, change),
      );
    }
    if (nextCoveredMap.size > MAX_COVERED_FINGERPRINTS) fail();
    nextCovered = [...nextCoveredMap].map(([fingerprint, counts]) => ({
      fingerprint,
      counts,
    }));
  }

  if (counted && nextEligible) {
    await exec(
      ctx,
      `UPDATE kith.space_embedding_states SET eligibility_epoch=$1,
       eligible_counts=$2,covered_counts=$3,last_eligibility_change_at=$4
       WHERE id=$5`,
      [
        eligibilityEpoch,
        JSON.stringify(nextEligible),
        JSON.stringify(nextCovered),
        eligible && nextEligible.chunk !== eligible.chunk
          ? at(ctx.now)
          : state.last_eligibility_change_at,
        state.id,
      ],
    );
  } else {
    await exec(
      ctx,
      "UPDATE kith.space_embedding_states SET eligibility_epoch=$1 WHERE id=$2",
      [eligibilityEpoch, state.id],
    );
  }
  if (activeGeneration) {
    await exec(
      ctx,
      "UPDATE kith.embedding_generations SET eligibility_epoch=$1 WHERE id=$2",
      [eligibilityEpoch, activeGeneration.id],
    );
  }
  if (
    activeGeneration &&
    counted &&
    nextEligible &&
    typeof activeFingerprint === "string" &&
    activeGeneration.fingerprint === activeFingerprint
  ) {
    const activeCovered =
      nextCovered.find((entry) => entry.fingerprint === activeFingerprint)
        ?.counts ?? ZERO_COUNTS;
    await exec(
      ctx,
      `UPDATE kith.embedding_generations SET eligibility_epoch=$1,
       expected_thought_count=$2,expected_chunk_count=$3,
       completed_thought_count=$4,completed_chunk_count=$5,
       coverage_invalid=false,thought_coverage_invalid=false,
       chunk_coverage_invalid=false WHERE id=$6`,
      [
        eligibilityEpoch,
        nextEligible.thought,
        nextEligible.chunk,
        activeCovered.thought,
        activeCovered.chunk,
        activeGeneration.id,
      ],
    );
  }
}
