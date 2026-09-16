// P2-39g3: proves `eval/record-document-retrieval.mjs`'s `runs[]` shape by
// feeding its output through the existing document-retrieval evaluator
// (`scripts/evaluate-document-retrieval.mjs`), unchanged.
//
// `scripts/fixtures/retrieval-evaluation-synthetic.json` is NOT used as the
// corpus here. Its evidence ids ("evidence-lab-a", "evidence-service-a", ...)
// are hand-authored labels for a recorded/offline evaluation; they are not
// `kith.evidence_spans` rows, and there is no loader that turns that fixture
// into a seeded PostgreSQL document. Loading it into `kith` is out of scope
// for this instrument. Instead, this test seeds one minimal document the way
// `test/parsedStagingAndDocuments.test.mjs` does (the same provenance chain a
// real ingested document has: source item, revision, text version, page,
// evidence span, document, chunk, activation), records it with
// `recordDocumentRetrievalRuns`, and scores the result with the real
// evaluator against a tiny inline `cases`/`thresholds` input. That proves the
// shape end to end without inventing a parallel fixture format.

import assert from "node:assert/strict";
import test from "node:test";

import { applyKithSchema, newKithId } from "../dist/index.js";
import * as provenance from "../dist/provenance/index.js";
import { evaluateDocumentRetrieval } from "../../../scripts/evaluate-document-retrieval.mjs";
import { recordDocumentRetrievalRuns } from "../eval/record-document-retrieval.mjs";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

function opaqueId() {
  return newKithId();
}

async function sha256Utf8(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seedSourceAccount(client, spaceId) {
  const id = opaqueId();
  await client.query(
    "INSERT INTO kith.source_accounts (id, space_id, created_at) VALUES ($1,$2,transaction_timestamp())",
    [id, spaceId],
  );
  return id;
}

async function seedUser(client) {
  const id = opaqueId();
  await client.query("INSERT INTO kith.users (id, created_at) VALUES ($1,transaction_timestamp())", [id]);
  return id;
}

/**
 * One minimal, fully activated, searchable document -- the same fixture
 * shape `test/parsedStagingAndDocuments.test.mjs`'s
 * "getDocument and searchDocuments overlay the item's live card doc type"
 * test builds, trimmed to what this test needs: one chunk whose text and
 * evidence span make the query "quarterly" answerable by exactly one
 * evidence id.
 */
async function seedMinimalDocument(client, spaceId) {
  const sourceAccountId = await seedSourceAccount(client, spaceId);
  const userId = await seedUser(client);
  const text = "The quarterly statement total is settled.";

  const item = await provenance.createOrGetSourceItem(client, {
    spaceId,
    sourceAccountId,
    externalId: "fixture/record-document-retrieval.txt",
    title: "Record document retrieval fixture",
  });
  const revision = await provenance.createOrGetRevision(client, {
    spaceId,
    sourceItemId: item.id,
    mediaType: "text/plain",
    inlineText: text,
    capturedAt: new Date("2026-02-01T00:00:00Z"),
    userId,
  });
  const textVersion = await provenance.createOrGetTextVersion(client, {
    spaceId,
    sourceRevisionId: revision.id,
    extractionFingerprint: "extract-v1",
    text,
  });
  const [page] = await provenance.stagePages(client, {
    spaceId,
    sourceTextVersionId: textVersion.id,
    pages: [{ ordinal: 0, start: 0, end: text.length, text }],
  });
  const [span] = await provenance.stageEvidenceSpans(client, {
    spaceId,
    sourceRevisionId: revision.id,
    sourceTextVersionId: textVersion.id,
    spans: [{ sourcePageId: page.id, ordinal: 0, start: 4, end: 13 }],
  });
  await provenance.setDesiredSourceRevision(client, {
    spaceId,
    sourceItemId: item.id,
    desiredRevisionId: revision.id,
    expectedDesiredProcessingEpoch: 0,
  });
  const generationId = (
    await client.query(
      `INSERT INTO kith.processing_generations
         (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, source_text_version_id,
          desired_processing_epoch, card_generation, state)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,1,false,'queued') RETURNING id`,
      [opaqueId(), spaceId, sourceAccountId, item.id, revision.id, textVersion.id],
    )
  ).rows[0].id;
  const [document] = await provenance.stageDocuments(client, {
    spaceId,
    processingGenerationId: generationId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    sourceTextVersionId: textVersion.id,
    documents: [
      {
        documentKey: "doc-1",
        title: "Quarterly statement",
        docType: "statement",
        capturedAt: new Date("2026-02-01T00:00:00Z"),
        evidenceSpanIds: [span.id],
      },
    ],
  });
  await provenance.stageChunks(client, {
    spaceId,
    processingGenerationId: generationId,
    chunks: [{ documentId: document.id, ordinal: 0, text, evidenceSpanIds: [span.id] }],
  });
  await provenance.activateSourceItemGeneration(client, {
    spaceId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    processingGenerationId: generationId,
    expectedDesiredProcessingEpoch: 1,
  });
  // Ingestion's own activation step (row e) also flips the generation to
  // "ready"; not ported here, so seeded directly, exactly as
  // `test/parsedStagingAndDocuments.test.mjs` does for the same fixture.
  await client.query(
    "UPDATE kith.processing_generations SET state = 'ready', activated_at = transaction_timestamp() WHERE id = $1",
    [generationId],
  );

  return { evidenceSpanId: span.id };
}

test(
  "record-document-retrieval's runs[] shape scores through the real evaluator on a minimal seeded document",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    await applyKithSchema(client);
    const spaceId = newKithId();
    const { evidenceSpanId } = await seedMinimalDocument(client, spaceId);

    // One answerable case and one unanswerable control, matching the shape
    // `scripts/fixtures/retrieval-evaluation-synthetic.json` uses: the
    // evaluator's false-positive rate is undefined (and so `thresholdsPassed`
    // is unconditionally false) with zero negative cases, so a single
    // observation cannot exercise the gate on its own.
    const casesInput = {
      spaceIds: [spaceId],
      cases: [
        { id: "quarterly", query: "quarterly" },
        { id: "unanswerable-control", query: "xyzzynonexistentterm" },
      ],
    };
    const recorded = await recordDocumentRetrievalRuns(client, casesInput);

    assert.equal(recorded.runs.length, 1);
    const [run] = recorded.runs;
    assert.equal(run.mode, "keyword");
    assert.equal(run.observations.length, 2);
    const observationById = new Map(run.observations.map((observation) => [observation.caseId, observation]));
    const answerable = observationById.get("quarterly");
    assert.equal(answerable.semanticCandidateStatus, "not_requested");
    assert.equal(answerable.error, undefined);
    assert.equal(typeof answerable.latencyMs, "number");
    assert.deepEqual(answerable.rankedEvidenceIds, [evidenceSpanId]);
    const unanswerable = observationById.get("unanswerable-control");
    assert.equal(unanswerable.semanticCandidateStatus, "not_requested");
    assert.deepEqual(unanswerable.rankedEvidenceIds, []);

    // Feed the recorded run through the real evaluator, unchanged, with a
    // tiny inline label/threshold set -- exactly the shape the owner would
    // splice this into for their own private question set.
    const evaluatorInput = {
      version: 1,
      metadata: { corpus: "record-document-retrieval fixture" },
      thresholds: {
        atK: { "1": { minimumRecall: 1, minimumMrr: 1, minimumSuccessRate: 1 } },
        maximumFalsePositiveRate: 0,
        maximumP95LatencyMs: 60_000,
      },
      cases: [
        {
          id: "quarterly",
          category: "synthetic",
          query: "quarterly",
          kind: "answerable",
          relevantEvidenceIds: [evidenceSpanId],
        },
        {
          id: "unanswerable-control",
          category: "control",
          query: "xyzzynonexistentterm",
          kind: "unanswerable",
        },
      ],
      runs: recorded.runs,
    };
    const report = evaluateDocumentRetrieval(evaluatorInput);
    assert.equal(report.gate.passed, true, JSON.stringify(report, null, 2));
    assert.equal(report.runs[0].gate.passed, true);
  },
);
