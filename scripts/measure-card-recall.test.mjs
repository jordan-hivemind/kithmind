import assert from "node:assert/strict";
import test from "node:test";

import {
  fakeEmbedder,
  generateCardCorpus,
  measureCardRecall,
} from "./measure-card-recall.mjs";

test("the corpus is at least 200 documents with distinct summaries", () => {
  const corpus = generateCardCorpus();
  assert.ok(corpus.length >= 200);
  assert.equal(new Set(corpus.map((entry) => entry.text)).size, corpus.length);
  assert.equal(new Set(corpus.map((entry) => entry.query)).size, corpus.length);
});

test("a paraphrase query shares no distinctive term with its summary", () => {
  // Distinctive means "not a stopword and not a qualifier term". The
  // qualifier is deliberately shared, because it is what a real query carries
  // over from the document; the summary's own vocabulary is not.
  const stopwords = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
    "by", "as", "from", "that", "this", "it", "its", "their", "them", "they",
    "each", "every", "all", "both", "no", "not", "what", "how", "when", "who",
    "may", "must", "was", "were", "is", "are", "be", "been", "has", "have",
    "had", "after", "before", "over", "under", "out", "up", "down", "other",
    "another", "second", "two", "three", "pair", "set", "side", "sides",
    "which", "while", "into", "run", "runs",
  ]);
  const terms = (value) =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((term) => term && !stopwords.has(term)),
    );
  for (const entry of generateCardCorpus()) {
    const queryTerms = terms(entry.queryBody);
    const overlap = [...terms(entry.summaryBody)].filter((term) =>
      queryTerms.has(term),
    );
    assert.deepEqual(
      overlap,
      [],
      `"${entry.summaryBody}" and "${entry.queryBody}" share ${overlap.join(", ")}`,
    );
  }
});

test("card recall reaches at least 80% at five over the synthetic corpus", async () => {
  const corpus = generateCardCorpus();
  const result = await measureCardRecall(corpus, fakeEmbedder(corpus));
  // Recorded, not only asserted, per section 11 of the document-card plan.
  // This is the deterministic structural embedder: it measures the ranking
  // path and the document-level containment rule, never meaning. The number
  // that answers the plan's question comes from
  // `node scripts/measure-card-recall.mjs --embedder=openai`.
  assert.equal(result.documentCount, 200);
  assert.equal(result.topK, 5);
  assert.equal(result.hits, 184);
  assert.equal(result.rate, 0.92);
  assert.ok(result.rate >= 0.8);
});
