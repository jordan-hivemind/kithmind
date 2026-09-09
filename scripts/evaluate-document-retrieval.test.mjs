import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EvaluationInputError,
  evaluateDocumentRetrieval,
  evaluateFile,
} from "./evaluate-document-retrieval.mjs";

const script = fileURLToPath(
  new URL("./evaluate-document-retrieval.mjs", import.meta.url),
);
const fixture = fileURLToPath(
  new URL("./fixtures/retrieval-evaluation-synthetic.json", import.meta.url),
);

function input() {
  return JSON.parse(readFileSync(fixture, "utf8"));
}

test("scores synthetic evidence ranks, unanswerable abstention, and semantic availability", () => {
  const report = evaluateDocumentRetrieval(input());
  const semantic = report.runs[0];
  assert.equal(report.gate.passed, true);
  assert.deepEqual(semantic.evidenceRankMetrics.atK[1], {
    recall: 0.75,
    mrr: 1,
    successCount: 2,
    successRate: 1,
    answerableCaseCount: 2,
    threshold: { minimumRecall: 0.5, minimumMrr: 0.5, minimumSuccessRate: 0.5 },
    passed: true,
  });
  assert.equal(semantic.evidenceRankMetrics.atK[3].recall, 1);
  assert.deepEqual(semantic.negativeCases, {
    caseCount: 1,
    candidateReturnedCount: 0,
    candidateReturnedRate: 0,
    emptyCandidateCount: 1,
    emptyCandidateRate: 1,
  });
  assert.equal(semantic.semanticCandidates.availabilityRate, 1);
  assert.equal(semantic.gate.semanticBenchmarkEligible, true);
  assert.equal(report.runs[1].gate.semanticBenchmarkEligible, false);
  assert.equal(
    report.runs[1].gate.semanticBenchmarkIneligibleReason,
    "mode_is_not_semantic",
  );
});

test("records semantic unavailability and errors as a failed gate without aborting scoring", () => {
  const evaluation = input();
  evaluation.runs[0].observations[0].semanticCandidateStatus = "unavailable";
  evaluation.runs[0].observations[1].error = "provider_timeout";
  const report = evaluateDocumentRetrieval(evaluation);
  const semantic = report.runs[0];
  assert.equal(semantic.errorCount, 1);
  assert.equal(semantic.semanticCandidates.unavailableCount, 1);
  assert.equal(semantic.gate.semanticBenchmarkEligible, false);
  assert.equal(
    semantic.gate.semanticBenchmarkIneligibleReason,
    "recorded_error",
  );
  assert.equal(semantic.gate.passed, false);
  assert.deepEqual(report.gate.failedRunIds, ["semantic-public-v1-run-1"]);
});

test("does not pass a fallback run that records unavailable semantic candidates", () => {
  const evaluation = input();
  evaluation.runs[1].observations[0].semanticCandidateStatus = "unavailable";
  const report = evaluateDocumentRetrieval(evaluation);
  assert.equal(report.runs[1].gate.passed, false);
  assert.equal(
    report.runs[1].gate.semanticBenchmarkIneligibleReason,
    "mode_is_not_semantic",
  );
});

test("fails closed for duplicate labels, unknown IDs, and missing observations", () => {
  for (const change of [
    (evaluation) => evaluation.cases.push({ ...evaluation.cases[0] }),
    (evaluation) => {
      evaluation.runs[0].observations[0].caseId = "unknown";
    },
    (evaluation) => {
      evaluation.runs[0].observations.pop();
    },
    (evaluation) => {
      evaluation.runs[0].observations[0].rankedEvidenceIds = ["same", "same"];
    },
  ]) {
    const evaluation = input();
    change(evaluation);
    assert.throws(
      () => evaluateDocumentRetrieval(evaluation),
      EvaluationInputError,
    );
  }
});

test("fails closed for invalid top-level schema and threshold gates", () => {
  const invalidInput = input();
  invalidInput.extra = true;
  assert.throws(
    () => evaluateDocumentRetrieval(invalidInput),
    EvaluationInputError,
  );
  const invalidThreshold = input();
  invalidThreshold.thresholds.atK[1].minimumMrr = 1.1;
  assert.throws(
    () => evaluateDocumentRetrieval(invalidThreshold),
    EvaluationInputError,
  );
});

test("requires request and CLI timing metadata", () => {
  const evaluation = input();
  delete evaluation.runs[0].timing;
  assert.throws(
    () => evaluateDocumentRetrieval(evaluation),
    EvaluationInputError,
  );
});

test("requires a fingerprint when any semantic candidate is available", () => {
  const evaluation = input();
  delete evaluation.runs[0].fingerprint;
  assert.throws(
    () => evaluateDocumentRetrieval(evaluation),
    EvaluationInputError,
  );
  const keywordOnly = input();
  delete keywordOnly.runs[1].fingerprint;
  assert.doesNotThrow(() => evaluateDocumentRetrieval(keywordOnly));
});

test("CLI emits hash-bearing JSON and reports measured gate failures with exit code one", async (t) => {
  const passed = spawnSync(process.execPath, [script, fixture], {
    encoding: "utf8",
  });
  assert.equal(passed.status, 0);
  assert.equal(passed.stderr, "");
  const report = JSON.parse(passed.stdout);
  assert.match(report.input.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.runtime.node, process.version);

  const directory = mkdtempSync(join(tmpdir(), "kith-retrieval-eval-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const failed = input();
  failed.runs[0].observations[2].rankedEvidenceIds = ["irrelevant-evidence"];
  const path = join(directory, "failed.json");
  writeFileSync(path, JSON.stringify(failed));
  const result = spawnSync(process.execPath, [script, path], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).gate.passed, false);
  assert.equal(result.stderr, "");
  assert.equal((await evaluateFile(path)).gate.passed, false);
});

test("CLI recognizes a symlink path containing spaces and a hash", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kith retrieval #"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = join(directory, "evaluate # retrieval.mjs");
  symlinkSync(script, link);
  const result = spawnSync(process.execPath, [link, fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).gate.passed, true);
  assert.equal(result.stderr, "");
});
