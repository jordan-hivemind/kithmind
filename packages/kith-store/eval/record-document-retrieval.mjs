#!/usr/bin/env node
// P2-39g3: turns `searchDocuments` results into the `runs[]` observation
// shape `scripts/evaluate-document-retrieval.mjs` consumes, against a real
// PostgreSQL database, so the owner can rerun the frozen private question
// set after a load. See docs/retrieval-parity-postgres.md and
// docs/retrieval-evaluation.md (the shape this produces).
//
// This script only records observations; it never carries or reads a label
// (`relevantEvidenceIds`), a threshold, or the private question set itself.
// The owner splices its `runs[]` output into their own private evaluator
// input alongside those labels, the way
// `scripts/fixtures/retrieval-evaluation-synthetic.json` shows for the
// public synthetic corpus.
//
// Usage:
//   node packages/kith-store/eval/record-document-retrieval.mjs <cases.json> [databaseUrl]
// `databaseUrl` defaults to `KITH_STORE_DATABASE_URL` when omitted.
//
// <cases.json>:
//   {
//     "spaceIds": ["default space id searched for every case"],
//     "cases": [
//       {
//         "id": "case-1",
//         "query": "quarterly",
//         "spaceIds": ["optional per-case override of the default above"],
//         "limit": 10,
//         "includeHistorical": false
//       }
//     ]
//   }
//
// Only `id`, `query`, and (directly or inherited) `spaceIds` are read from
// each case. Prints `{ runs: [ ... ] }` to standard output.

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { searchDocuments } from "../dist/documents/index.js";

const DEFAULT_LIMIT = 10;

function requireNonEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value;
}

/**
 * One case's evidence ranking: `searchDocuments`'s own relevance order,
 * flattened to its citations' evidence span ids -- the immutable identifier
 * `scripts/evaluate-document-retrieval.mjs` ranks by, durable across a
 * document's reprocessing in a way `documentId`/`chunkId` are not --
 * deduplicated in first-seen order.
 */
function rankedEvidenceIdsFrom(results) {
  const seen = new Set();
  const ranked = [];
  for (const result of results) {
    for (const citation of result.citations) {
      if (seen.has(citation.evidenceSpanId)) continue;
      seen.add(citation.evidenceSpanId);
      ranked.push(citation.evidenceSpanId);
    }
  }
  return ranked;
}

/**
 * Runs every case through `searchDocuments` and returns one run in the
 * `scripts/evaluate-document-retrieval.mjs` input shape.
 *
 * `searchDocuments` is called with no `semantic` argument, so every
 * observation is `semanticCandidateStatus: "not_requested"`: a keyword-only
 * rerun, never mislabeled a semantic benchmark (the evaluator's own rule --
 * see docs/retrieval-evaluation.md). A caller that wants the semantic leg
 * recorded resolves candidates with `src/embeddings/search.ts`'s
 * `searchChunkAndCardVectorCandidates` first and passes the result as
 * `options.semantic`; this script does not do that itself because the
 * private corpus it targets is not guaranteed to have an active embedding
 * index (see docs/retrieval-parity-postgres.md).
 */
export async function recordDocumentRetrievalRuns(client, input, options = {}) {
  const cases = requireNonEmptyArray(input.cases, "cases");
  const defaultSpaceIds = input.spaceIds;
  const runId = options.runId ?? "keyword-postgres-v1";
  const observations = [];
  for (const testCase of cases) {
    if (typeof testCase.id !== "string" || testCase.id.trim() === "") {
      throw new Error("Every case needs a non-empty string id");
    }
    if (typeof testCase.query !== "string" || testCase.query.trim() === "") {
      throw new Error(`Case "${testCase.id}" needs a non-empty query`);
    }
    const spaceIds = requireNonEmptyArray(
      testCase.spaceIds ?? defaultSpaceIds,
      `Case "${testCase.id}" spaceIds (and no top-level default was supplied)`,
    );

    const startedAt = performance.now();
    let rankedEvidenceIds = [];
    let error;
    try {
      const semantic = typeof options.resolveSemantic === "function"
        ? await options.resolveSemantic(client, spaceIds, testCase)
        : undefined;
      const { results } = await searchDocuments(
        client,
        spaceIds,
        {
          query: testCase.query,
          limit: testCase.limit ?? DEFAULT_LIMIT,
          includeHistorical: testCase.includeHistorical ?? false,
        },
        semantic,
      );
      rankedEvidenceIds = rankedEvidenceIdsFrom(results);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const latencyMs = Math.round(performance.now() - startedAt);
    observations.push({
      caseId: testCase.id,
      rankedEvidenceIds,
      latencyMs,
      // Always "not_requested": see the module comment. A caller that passes
      // `options.resolveSemantic` is responsible for its own run metadata --
      // this script's default path never attempts the semantic leg.
      semanticCandidateStatus: "not_requested",
      ...(error === undefined ? {} : { error }),
    });
  }
  return {
    runs: [
      {
        id: runId,
        mode: options.mode ?? "keyword",
        timing: {
          request: "latencyMs measures one completed searchDocuments call against PostgreSQL",
          cli: "latencyMs excludes cases-file parsing and JSON serialization",
        },
        observations,
      },
    ],
  };
}

async function main(casesPath, databaseUrl) {
  const raw = await readFile(casesPath, "utf8");
  const input = JSON.parse(raw);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const output = await recordDocumentRetrievalRuns(client, input);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

const invokedPath = process.argv[1];
function isDirectInvocation() {
  try {
    return typeof invokedPath === "string" && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href;
  } catch {
    return false;
  }
}
if (isDirectInvocation()) {
  const [casesPath, databaseUrlArg] = process.argv.slice(2);
  const databaseUrl = databaseUrlArg ?? process.env.KITH_STORE_DATABASE_URL;
  if (!casesPath || !databaseUrl) {
    process.stderr.write(
      "usage: node record-document-retrieval.mjs <cases.json> [databaseUrl]  (or set KITH_STORE_DATABASE_URL)\n",
    );
    process.exitCode = 2;
  } else {
    try {
      await main(casesPath, databaseUrl);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
