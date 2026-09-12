#!/usr/bin/env node

/**
 * Card recall, section 11 of docs/plans/2026-09-12-document-cards.md.
 *
 * A synthetic corpus of at least 200 documents with distinct summaries is
 * queried by a paraphrase of each summary. The card's own document must be in
 * the top five for at least 80% of the queries, and the rate is recorded.
 *
 * Two embedders, one corpus and one scorer:
 *
 * - `--embedder=fake` (the default, and what the unit test runs) is a
 *   deterministic structural embedder. It proves the ranking path: one target
 *   per document, a contested top five over 200 documents, and the
 *   document-level containment rule. It measures no meaning at all, because a
 *   paraphrase that shares no distinctive term with its summary is exactly the
 *   thing a term-based embedder cannot resolve.
 * - `--embedder=openai` calls the real provider named by `EMBEDDING_MODEL`
 *   with `OPENAI_API_KEY`. That is the run whose rate answers the plan's
 *   question. Until it has been run, the plan's meaning claim is unmeasured.
 *
 * No real document, name or figure appears here. The corpus is generated.
 */

import process from "node:process";

const DEFAULT_DOCUMENT_COUNT = 200;
const TOP_K = 5;
const PROVIDER_BATCH = 32;

// Distinct subject matter per document, so two summaries are never near
// duplicates of each other. The paraphrase of a summary is written from the
// paired vocabulary and shares none of the summary's distinctive terms.
const SUBJECTS = [
  {
    kind: "Confidentiality agreement",
    summary: "binds both signatories to keep the other side's material secret",
    paraphrase: "neither party may disclose what the other told them",
  },
  {
    kind: "Equipment lease",
    summary: "rents machinery for a fixed term against a monthly instalment",
    paraphrase: "hires out gear for a set period at a recurring charge",
  },
  {
    kind: "Service termination notice",
    summary: "ends an ongoing engagement effective at the close of the quarter",
    paraphrase: "stops the running arrangement when the three months run out",
  },
  {
    kind: "Warranty statement",
    summary: "promises repair of defective parts within the coverage window",
    paraphrase: "undertakes to fix faulty components while the guarantee lasts",
  },
  {
    kind: "Shipping manifest",
    summary: "lists every crate loaded onto the vessel and its declared weight",
    paraphrase: "enumerates the containers put aboard the ship with tonnage",
  },
  {
    kind: "Meeting minutes",
    summary: "records the motions put to the board and how each member voted",
    paraphrase: "captures the proposals before the directors and their ballots",
  },
  {
    kind: "Insurance endorsement",
    summary: "adds flood damage to the perils the policy already covers",
    paraphrase: "extends the protection to harm caused by rising water",
  },
  {
    kind: "Licence grant",
    summary: "permits use of the trademark in two named territories",
    paraphrase: "allows the brand to be used across a pair of stated regions",
  },
  {
    kind: "Settlement release",
    summary: "discharges all claims arising from the disputed transaction",
    paraphrase: "waives every grievance stemming from the contested deal",
  },
  {
    kind: "Maintenance schedule",
    summary: "sets the inspection interval for each installed unit",
    paraphrase: "fixes how often every fitted device must be checked",
  },
  {
    kind: "Assignment deed",
    summary: "transfers the receivable balance to the acquiring institution",
    paraphrase: "moves the outstanding debt over to the purchasing bank",
  },
  {
    kind: "Compliance attestation",
    summary: "certifies that the audited controls operated without exception",
    paraphrase: "confirms the reviewed safeguards ran with no lapse found",
  },
];

const QUALIFIERS = [
  "for the northern district",
  "covering the second half of the year",
  "with an amendment attached",
  "as executed by the original signatories",
  "restated after the review",
  "for the subsidiary entity",
  "under the revised schedule",
  "with the annex incorporated",
  "following the renewal",
  "as filed with the registry",
  "limited to the pilot programme",
  "including the addendum",
  "after the boundary correction",
  "for the successor arrangement",
  "on the amended terms",
  "with the appendix replaced",
  "as of the closing date",
];

/**
 * One card per document. `text` is what `composeCardTargetInput` composes in
 * `packages/convex/convex/models/embeddings/cardTargets.ts`; `query` is the
 * paraphrase the document must be retrieved by.
 */
export function generateCardCorpus(documentCount = DEFAULT_DOCUMENT_COUNT) {
  if (!Number.isSafeInteger(documentCount) || documentCount < 200) {
    throw new Error("The card recall corpus is at least 200 documents");
  }
  const corpus = [];
  for (let index = 0; index < documentCount; index += 1) {
    const subject = SUBJECTS[index % SUBJECTS.length];
    const qualifier = QUALIFIERS[index % QUALIFIERS.length];
    const serial = String(index + 1).padStart(4, "0");
    const title = `${subject.kind} ${serial} ${qualifier}`;
    const summary = `${subject.summary} ${qualifier}`;
    corpus.push({
      documentId: `doc-${serial}`,
      subjectIndex: index % SUBJECTS.length,
      qualifierIndex: index % QUALIFIERS.length,
      // The two halves, so a test can check the distinctive vocabulary
      // without having to guess where the shared qualifier starts.
      summaryBody: subject.summary,
      queryBody: subject.paraphrase,
      // The composition of section 8.1, in its fixed order.
      text: [
        `Kind: ${subject.kind}`,
        `Title: ${title}`,
        `Date: 2025-${String((index % 12) + 1).padStart(2, "0")}-15`,
        `Summary: ${summary}`,
      ].join("\n"),
      query: `${subject.paraphrase} ${qualifier}`,
    });
  }
  return corpus;
}

function normalize(values) {
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  return norm === 0 ? values : values.map((value) => value / norm);
}

export function cosine(left, right) {
  let dot = 0;
  for (let i = 0; i < left.length; i += 1) dot += left[i] * right[i];
  return dot;
}

const FAKE_DIMENSIONS = 64;

function axis(seed, dimensions) {
  // A cheap deterministic pseudo-random unit vector. No crypto claim; it only
  // has to be stable and spread out.
  const values = new Array(dimensions);
  let state = (seed + 1) * 2654435761;
  for (let i = 0; i < dimensions; i += 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    values[i] = state / 0xffffffff - 0.5;
  }
  return normalize(values);
}

/**
 * The deterministic structural embedder. It reads the document's own identity
 * and its subject, never the words, so it stands in for an embedder that
 * resolved the paraphrase. Two things keep the top five genuinely contested,
 * so a broken ranking path fails this rather than passing it by construction:
 * every document of one subject crowds the same neighbourhood, and the query
 * carries a large per-document drift term that blunts the identity signal.
 * Calibrated to land at 0.92 rather than at 1.0.
 */
const FAKE_QUERY_DRIFT = 1.5;

export function fakeEmbedder(corpus) {
  const byText = new Map();
  const byQuery = new Map();
  for (const [index, entry] of corpus.entries()) {
    const identity = axis(1000 + index, FAKE_DIMENSIONS);
    const subject = axis(entry.subjectIndex, FAKE_DIMENSIONS);
    const qualifier = axis(500 + entry.qualifierIndex, FAKE_DIMENSIONS);
    const drift = axis(7000 + index, FAKE_DIMENSIONS);
    byText.set(
      entry.text,
      normalize(
        identity.map(
          (value, i) => 0.5 * value + 0.4 * subject[i] + 0.1 * qualifier[i],
        ),
      ),
    );
    byQuery.set(
      entry.query,
      normalize(
        identity.map(
          (value, i) =>
            0.42 * value +
            0.48 * subject[i] +
            0.1 * qualifier[i] +
            FAKE_QUERY_DRIFT * drift[i],
        ),
      ),
    );
  }
  return async (inputs) =>
    inputs.map((input) => {
      const vector = byText.get(input) ?? byQuery.get(input);
      if (!vector) throw new Error("Fake embedder saw an unknown input");
      return vector;
    });
}

async function openAiEmbedder(inputs) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for --embedder=openai");
  const model = process.env.EMBEDDING_MODEL ?? "text-embedding-3-large";
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
  const vectors = [];
  for (let start = 0; start < inputs.length; start += PROVIDER_BATCH) {
    const batch = inputs.slice(start, start + PROVIDER_BATCH);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: batch, dimensions }),
    });
    if (!response.ok) {
      throw new Error(`embedding request failed: ${response.status}`);
    }
    const body = await response.json();
    for (const row of body.data) vectors.push(normalize(row.embedding));
  }
  return vectors;
}

/**
 * Ranks every document for every paraphrase query and reports the rate at
 * which the card's own document is in the top five. One vector per document,
 * which is what the card model puts in the index.
 */
export async function measureCardRecall(corpus, embed, topK = TOP_K) {
  const documentVectors = await embed(corpus.map((entry) => entry.text));
  const queryVectors = await embed(corpus.map((entry) => entry.query));
  let hits = 0;
  let reciprocalRankSum = 0;
  for (const [index, entry] of corpus.entries()) {
    const query = queryVectors[index];
    const ranked = documentVectors
      .map((vector, candidate) => ({
        documentId: corpus[candidate].documentId,
        score: cosine(query, vector),
      }))
      .sort(
        (a, b) =>
          b.score - a.score || a.documentId.localeCompare(b.documentId),
      );
    const rank = ranked.findIndex(
      (row) => row.documentId === entry.documentId,
    );
    if (rank >= 0 && rank < topK) hits += 1;
    if (rank >= 0) reciprocalRankSum += 1 / (rank + 1);
  }
  return {
    documentCount: corpus.length,
    topK,
    hits,
    rate: hits / corpus.length,
    mrr: reciprocalRankSum / corpus.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const embedderArg =
    args.find((value) => value.startsWith("--embedder="))?.split("=")[1] ??
    "fake";
  const countArg = Number(
    args.find((value) => value.startsWith("--documents="))?.split("=")[1] ??
      DEFAULT_DOCUMENT_COUNT,
  );
  const corpus = generateCardCorpus(countArg);
  const embed =
    embedderArg === "openai" ? openAiEmbedder : fakeEmbedder(corpus);
  const result = await measureCardRecall(corpus, embed);
  process.stdout.write(
    `${JSON.stringify(
      {
        embedder: embedderArg,
        measuresMeaning: embedderArg === "openai",
        ...result,
        passed: result.rate >= 0.8,
      },
      null,
      2,
    )}\n`,
  );
  if (result.rate < 0.8) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  await main();
}
