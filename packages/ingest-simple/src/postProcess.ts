// Best-effort classification and embedding after activation. Neither is
// required for a document to appear (`getDocument` already returns it once
// `ingestFile` commits): `write.ts`'s `stageOneFile` already enqueues
// `document_extraction` and marks the new chunks eligible for embedding, in
// the same transaction as activation. This module just drains what queued --
// `deferred.drain` with `deferred.defaultRegistry` runs `document_extraction`
// (and anything else already queued) through the exact handler
// `kith-deferred-work` uses -- and then runs the embedding batch directly,
// `providerBatchEmbedder` + `runEmbeddingFill` (`@repo/kith-store`'s
// `embeddings` namespace), as the task asks, rather than through the queue's
// own `embedding_fill` kind (this package never schedules that kind).

import { deferred, embeddings } from "@repo/kith-store";
import type { Pool } from "pg";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
