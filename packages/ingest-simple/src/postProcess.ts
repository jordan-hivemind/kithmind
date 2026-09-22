// Best-effort classification and embedding after activation. Neither is
// required for a document to appear (`getDocument` already returns it once
// `ingestFile` commits): `write.ts`'s `stageOneFile` already enqueues
// `document_extraction` and, through `touchWorkerPublicationEmbedding`, marks
// the new chunks eligible for embedding -- and schedules an `embedding_fill`
// job for the daemon -- in the same transaction as activation, whenever the
// space's embedding state has already been counted (see that function's own
// comment for what "counted" requires). This module just drains what's
// queued -- `deferred.drain` with `deferred.defaultRegistry` runs
// `document_extraction` and any already-queued `embedding_fill` job through
// the exact handlers `kith-deferred-work` uses -- and then runs the
// embedding batch directly, `providerBatchEmbedder` + `runEmbeddingFill`
// (`@repo/kith-store`'s `embeddings` namespace), so a target this run made
// eligible does not have to wait for the daemon's own schedule.
//
// `runIngest` calls `runPostProcessing` on every non-dry run, not only one
// that activated something: a target can be eligible-but-uncovered from an
// earlier run (the provider was unconfigured then, or its scheduled
// `embedding_fill` job exhausted its retries) and nothing about *this* run
// touching no files should stop the fill from retrying it. `backfillEmbeddings`
// below is the explicit one-off version of the same idea, for a source
// account whose documents were ingested before this package retried on every
// run, or before the space had an active embedding generation/profile at all.
//
// A document can also stay uncovered because its chunks were never eligible
// in the first place: a space whose `target_policy` is
// `cards_and_opted_in_chunks` (migration 016; `embeddings.spaceEmbedsAllChunks`)
// only registers a document's card, not its chunks, unless the source item or
// account opted in (`chunkTargetsOptedIn`, `build.ts` line ~627). No amount of
// retrying the fill covers a chunk that was never registered as a target.
// `setEmbeddingPolicy` below is the supported way to flip a space to
// `all_chunks` and catch up every already-ingested document in one call.

import { deferred, embeddings, withKithTransaction, workers } from "@repo/kith-store";
import type { Pool } from "pg";

import { resolveSourceAccount } from "./sourceAccount.js";

export type PostProcessResult = {
  extraction: { claimed: number; completed: number; failed: boolean };
  embeddings: { embedded: number; skipped: number; failed: boolean };
};

/** A space's chunk target policy plus its eligible/covered counters, read
 * straight from `kith.space_embedding_states` (through the same store
 * functions the read surfaces use) -- what `--set-embedding-policy` and
 * `--backfill-embeddings` print so a zero-embedded result is explainable
 * (eligible 0 means nothing was ever registered; eligible > covered means
 * the fill has more to do, or failed). */
export type EmbeddingCoverageSnapshot = {
  policy: embeddings.EmbeddingTargetPolicy;
  eligible: embeddings.EmbeddingKindCounts;
  covered: embeddings.EmbeddingKindCounts;
};

async function embeddingCoverageSnapshot(
  pool: Pool,
  spaceId: string,
): Promise<EmbeddingCoverageSnapshot> {
  return withKithTransaction(pool, async (client) => {
    const ctx = { client, now: Date.now() };
    const state = await embeddings.ensureSpaceEmbeddingState(ctx, spaceId);
    const counters = await embeddings.readSpaceCounters(ctx, spaceId);
    return {
      policy: (state.target_policy ?? "all_chunks") as embeddings.EmbeddingTargetPolicy,
      eligible: counters.coverage.eligible ?? embeddings.ZERO_KIND_COUNTS,
      covered: counters.coverage.covered ?? embeddings.ZERO_KIND_COUNTS,
    };
  });
}

type ActiveSourceItem = {
  id: string;
  sourceAccountId: string;
  activeGenerationId: string;
};

async function activeSourceItemsForAccount(
  pool: Pool,
  sourceAccountId: string,
): Promise<ActiveSourceItem[]> {
  const { rows } = await pool.query<{ id: string; active_generation_id: string }>(
    `SELECT id, active_generation_id FROM kith.source_items
      WHERE source_account_id = $1 AND active_generation_id IS NOT NULL`,
    [sourceAccountId],
  );
  return rows.map((row) => ({
    id: row.id,
    sourceAccountId,
    activeGenerationId: row.active_generation_id,
  }));
}

/** Every already-ingested document across a whole space, regardless of which
 * source account it came in through -- what `setEmbeddingPolicy` needs,
 * since a policy switch is a space-level change, not an account-level one. */
async function activeSourceItemsForSpace(
  pool: Pool,
  spaceId: string,
): Promise<ActiveSourceItem[]> {
  const { rows } = await pool.query<{
    id: string;
    source_account_id: string;
    active_generation_id: string;
  }>(
    `SELECT id, source_account_id, active_generation_id FROM kith.source_items
      WHERE space_id = $1 AND active_generation_id IS NOT NULL
        AND source_account_id IS NOT NULL`,
    [spaceId],
  );
  return rows.map((row) => ({
    id: row.id,
    sourceAccountId: row.source_account_id,
    activeGenerationId: row.active_generation_id,
  }));
}

/** The same per-item eligibility touch `write.ts`'s `stageOneFile` runs on
 * ingest (`workers.touchWorkerPublicationEmbedding`): re-registers or
 * retires each item's active generation's chunk targets under whatever
 * `target_policy` reads right now. Idempotent, see `backfillEmbeddings`'s own
 * doc comment. */
async function touchActiveSourceItems(
  pool: Pool,
  spaceId: string,
  items: readonly ActiveSourceItem[],
): Promise<void> {
  for (const item of items) {
    await workers.withWorkerTransaction(pool, (ctx) =>
      workers.touchWorkerPublicationEmbedding(ctx, {
        spaceId,
        sourceItemId: item.id,
        sourceAccountId: item.sourceAccountId,
        processingGenerationId: item.activeGenerationId,
      }),
    );
  }
}

async function runEmbeddingFillBestEffort(
  pool: Pool,
  spaceId: string,
  env: Readonly<Record<string, string | undefined>>,
  log: (message: string) => void,
): Promise<PostProcessResult["embeddings"]> {
  const result: PostProcessResult["embeddings"] = { embedded: 0, skipped: 0, failed: false };
  try {
    const embed = embeddings.providerBatchEmbedder(env);
    const filled = await embeddings.runEmbeddingFill(pool, spaceId, embed, {});
    result.embedded = filled.embedded;
    result.skipped = filled.skipped;
  } catch (error) {
    result.failed = true;
    log(`Embedding fill did not run: ${errorMessage(error)}`);
  }
  return result;
}

export async function runPostProcessing(
  pool: Pool,
  spaceId: string,
  env: Readonly<Record<string, string | undefined>>,
  maxExtractionJobs: number,
  log: (message: string) => void,
): Promise<PostProcessResult> {
  const result: PostProcessResult = {
    extraction: { claimed: 0, completed: 0, failed: false },
    embeddings: { embedded: 0, skipped: 0, failed: false },
  };

  try {
    const registry = deferred.defaultRegistry({ env });
    const summary = await deferred.drain(pool, registry, {
      maxJobs: Math.max(1, maxExtractionJobs),
    });
    result.extraction.claimed = summary.claimed;
    result.extraction.completed = summary.completed;
  } catch (error) {
    result.extraction.failed = true;
    log(`Classification did not run: ${errorMessage(error)}`);
  }

  result.embeddings = await runEmbeddingFillBestEffort(pool, spaceId, env, log);

  return result;
}

export type BackfillEmbeddingsResult = {
  /** Source items this call re-touched (every source item on the account
   * with an active generation, whether or not it already had full vector
   * coverage -- `touchWorkerPublicationEmbedding` is idempotent for an
   * already-covered target, see its own doc comment, so touching one that
   * needed nothing is a cheap no-op, not a correctness risk). */
  sourceItemsTouched: number;
  embeddings: PostProcessResult["embeddings"];
  /** The account's space, read after the touch loop and the fill above, so a
   * zero `embeddings.embedded` is explainable: `eligible` at zero means
   * nothing was ever registered (the policy excludes these chunks, or the
   * space is not counted yet); `eligible > covered` means the fill still has
   * owed work or failed. */
  coverage: EmbeddingCoverageSnapshot;
};

/**
 * The one-off catch-up for a source account's already-ingested documents:
 * `--backfill-embeddings` (cli.ts). For every source item on the account
 * with an active generation, re-runs the exact eligibility touch
 * `write.ts`'s `stageOneFile` already runs on ingest
 * (`workers.touchWorkerPublicationEmbedding`) -- registering an
 * `embedding_targets` row for a chunk that never got one (the space had no
 * active embedding generation/profile yet when it was ingested, or the
 * space's counters were not seeded until later) and scheduling
 * `embedding_fill` for the daemon -- then runs the same inline fill
 * `runPostProcessing` does, so a configured provider covers the backlog
 * immediately instead of waiting for the daemon's next drain.
 *
 * Idempotent and safe to run repeatedly: an already-covered target's
 * `covered_fingerprint` is left untouched (`touchWorkerPublicationEmbedding`
 * only clears it when the chunk's own input or generation actually
 * changed), so this never re-embeds or double-counts a document that is
 * already fully covered.
 */
export async function backfillEmbeddings(
  pool: Pool,
  sourceAccountId: string,
  env: Readonly<Record<string, string | undefined>>,
  log: (message: string) => void,
): Promise<BackfillEmbeddingsResult> {
  const account = await resolveSourceAccount(pool, sourceAccountId);
  const items = await activeSourceItemsForAccount(pool, sourceAccountId);

  await touchActiveSourceItems(pool, account.spaceId, items);
  log(
    `backfill: re-touched ${items.length} source item${items.length === 1 ? "" : "s"} ` +
      `on source account ${sourceAccountId} for embedding eligibility`,
  );

  const result = await runEmbeddingFillBestEffort(pool, account.spaceId, env, log);
  const coverage = await embeddingCoverageSnapshot(pool, account.spaceId);

  return { sourceItemsTouched: items.length, embeddings: result, coverage };
}

export type SetEmbeddingPolicyResult = {
  spaceId: string;
  policy: embeddings.EmbeddingTargetPolicy;
  changed: boolean;
  before: EmbeddingCoverageSnapshot;
  after: EmbeddingCoverageSnapshot;
  sourceItemsTouched: number;
  embeddings: PostProcessResult["embeddings"];
};

/**
 * `--set-embedding-policy <policy> --space <id>` (cli.ts). Switches the
 * space's `target_policy` through the store's own
 * `embeddings.setSpaceEmbeddingTargetPolicy` (state.ts) -- never raw SQL --
 * then, so an owner does not have to wait for the daemon's next build-job
 * scan (`build.ts`'s `runScanPage`) to see an already-ingested document
 * become searchable, re-runs the exact same per-item eligibility touch
 * `backfillEmbeddings` above runs for one source account
 * (`workers.touchWorkerPublicationEmbedding`), scoped to every source item
 * in the space instead of one account's, and then the same inline fill.
 *
 * Safe to call when the policy is already the requested one: the store
 * function is a no-op in that case (`changed: false`), and the touch-and-fill
 * pass still runs, which is what covers a document ingested while the policy
 * was already `all_chunks` but before a provider was configured, or before
 * this package retried the fill on every run.
 */
export async function setEmbeddingPolicy(
  pool: Pool,
  spaceId: string,
  policy: embeddings.EmbeddingTargetPolicy,
  env: Readonly<Record<string, string | undefined>>,
  log: (message: string) => void,
): Promise<SetEmbeddingPolicyResult> {
  const before = await embeddingCoverageSnapshot(pool, spaceId);

  const change = await withKithTransaction(pool, (client) =>
    embeddings.setSpaceEmbeddingTargetPolicy({ client, now: Date.now() }, spaceId, policy),
  );
  log(
    change.changed
      ? `embedding policy for space ${spaceId}: ${before.policy} -> ${policy}`
      : `embedding policy for space ${spaceId} is already ${policy}; re-scanning anyway`,
  );

  const items = await activeSourceItemsForSpace(pool, spaceId);
  await touchActiveSourceItems(pool, spaceId, items);
  log(
    `re-touched ${items.length} source item${items.length === 1 ? "" : "s"} ` +
      `in space ${spaceId} for embedding eligibility`,
  );

  const embedResult = await runEmbeddingFillBestEffort(pool, spaceId, env, log);
  const after = await embeddingCoverageSnapshot(pool, spaceId);

  return {
    spaceId,
    policy,
    changed: change.changed,
    before,
    after,
    sourceItemsTouched: items.length,
    embeddings: embedResult,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
