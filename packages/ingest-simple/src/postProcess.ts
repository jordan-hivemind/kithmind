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

import { deferred, embeddings, workers } from "@repo/kith-store";
import type { Pool } from "pg";

import { resolveSourceAccount } from "./sourceAccount.js";

export type PostProcessResult = {
  extraction: { claimed: number; completed: number; failed: boolean };
  embeddings: { embedded: number; skipped: number; failed: boolean };
};

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

  try {
    const embed = embeddings.providerBatchEmbedder(env);
    const filled = await embeddings.runEmbeddingFill(pool, spaceId, embed, {});
    result.embeddings.embedded = filled.embedded;
    result.embeddings.skipped = filled.skipped;
  } catch (error) {
    result.embeddings.failed = true;
    log(`Embedding fill did not run: ${errorMessage(error)}`);
  }

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
  const { rows: items } = await pool.query<{ id: string; active_generation_id: string }>(
    `SELECT id, active_generation_id FROM kith.source_items
      WHERE source_account_id = $1 AND active_generation_id IS NOT NULL`,
    [sourceAccountId],
  );

  for (const item of items) {
    await workers.withWorkerTransaction(pool, (ctx) =>
      workers.touchWorkerPublicationEmbedding(ctx, {
        spaceId: account.spaceId,
        sourceItemId: item.id,
        sourceAccountId,
        processingGenerationId: item.active_generation_id,
      }),
    );
  }
  log(
    `backfill: re-touched ${items.length} source item${items.length === 1 ? "" : "s"} ` +
      `on source account ${sourceAccountId} for embedding eligibility`,
  );

  const result: PostProcessResult["embeddings"] = { embedded: 0, skipped: 0, failed: false };
  try {
    const embed = embeddings.providerBatchEmbedder(env);
    const filled = await embeddings.runEmbeddingFill(pool, account.spaceId, embed, {});
    result.embedded = filled.embedded;
    result.skipped = filled.skipped;
  } catch (error) {
    result.failed = true;
    log(`Embedding fill did not run: ${errorMessage(error)}`);
  }

  return { sourceItemsTouched: items.length, embeddings: result };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
