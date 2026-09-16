// The one query-embedder seam, shared by every module on the PostgreSQL
// surface that turns search text into a vector before it opens a transaction.
//
// `reads.ts` is the seam's original home: `searchDocuments`, `searchThoughts`
// and `recallContext` are the three read tools that need a query vector, and
// section 4.4 of the web and MCP surface plan requires the embedding request
// to happen before the transaction opens, so the tool can reload the
// credential, close its probe transaction, and only then call the provider.
// `lib/kith/capture.ts` re-exports `setMcpEmbedder` as `setCaptureEmbedder`
// for the same reason `reads.ts` and `lib/kith/capture.ts` must not each carry
// their own injectable seam: two seams over one provider call is two things a
// test or a future caller can set inconsistently. `captureThoughtFromWeb`
// does call `resolveMcpEmbedder()` -- narrative capture's model-backed
// admission gate (landed by the i4 capture-gate follow-up, PR #253) embeds
// the content between its first and second transaction, but only when the
// destination space's thought index is ready to be searched; an incomplete
// index takes the store's keyword candidate leg instead and the embedder is
// never called for that capture. When it is called, the gate fails closed on
// a provider error or a fingerprint that disagrees with the index
// (`admissionUnavailable` in `lib/kith/capture.ts`): the classifier is never
// asked to judge novelty without the comparison set that embedding was
// supposed to build. `capture_thought` and Quick Capture share this: both
// call `lib/kith/capture.ts`'s `runCaptureThought`, which is what makes them
// one gate rather than two.

import { embeddings } from "@repo/kith-store";

export type McpEmbedder = (query: string) => Promise<{
  vector: readonly number[];
  fingerprint: string;
}>;

let embedder: McpEmbedder | undefined;

/** The injectable test seam. Nothing in the app calls this; only tests do. */
export function setMcpEmbedder(next: McpEmbedder | undefined): () => void {
  const previous = embedder;
  embedder = next;
  return () => {
    embedder = previous;
  };
}

async function defaultMcpEmbedder(query: string) {
  const config = embeddings.loadEmbeddingConfig(process.env);
  const result = await embeddings.requestEmbedding(query, config);
  return { vector: result.vector, fingerprint: result.fingerprint };
}

/** The embedder a caller should use right now: the injected one, or the real provider. */
export function resolveMcpEmbedder(): McpEmbedder {
  return embedder ?? defaultMcpEmbedder;
}
