#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_CASES = 10_000;
const MAX_RUNS = 100;
const MAX_RANKED_EVIDENCE_IDS = 1_000;
const MAX_K = MAX_RANKED_EVIDENCE_IDS;

export class EvaluationInputError extends Error {
  constructor(message) {
    super(`retrieval_evaluation_input_invalid: ${message}`);
    this.name = "EvaluationInputError";
  }
}

function invalid(message) {
  throw new EvaluationInputError(message);
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") invalid(label);
  return value;
}
function uniqueStrings(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
    invalid(label);
  if (value.length > MAX_RANKED_EVIDENCE_IDS) invalid(`${label} exceeds bound`);
  const seen = new Set();
  for (const item of value) {
    nonEmptyString(item, label);
    if (seen.has(item)) invalid(`${label} contains duplicate ${item}`);
    seen.add(item);
  }
  return value;
}
function fraction(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    invalid(label);
  return value;
}
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_K)
    invalid(label);
  return value;
}
function latency(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 86_400_000
  )
    invalid(label);
  return value;
}
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}
function mean(values) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function timing(value, label) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "request") ||
    !Object.hasOwn(value, "cli")
  )
    invalid(label);
  return {
    request: nonEmptyString(value.request, `${label}.request`),
    cli: nonEmptyString(value.cli, `${label}.cli`),
  };
}

function validateThresholds(value) {
  if (!isPlainObject(value)) invalid("thresholds must be an object");
  const allowed = new Set([
    "atK",
    "maximumFalsePositiveRate",
    "maximumP95LatencyMs",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) invalid(`unknown thresholds key ${key}`);
  if (!isPlainObject(value.atK) || Object.keys(value.atK).length === 0)
    invalid("thresholds.atK must contain at least one k");
  const atK = {};
  for (const [rawK, threshold] of Object.entries(value.atK)) {
    if (!/^[1-9]\d*$/u.test(rawK)) invalid("thresholds.atK key");
    const k = positiveInteger(Number(rawK), "thresholds.atK key");
    if (!isPlainObject(threshold)) invalid(`thresholds.atK.${rawK}`);
    const expected = ["minimumRecall", "minimumMrr", "minimumSuccessRate"];
    if (
      Object.keys(threshold).length !== expected.length ||
      !expected.every((key) => Object.hasOwn(threshold, key))
    )
      invalid(
        `thresholds.atK.${rawK} must define recall, mrr, and success rate`,
      );
    atK[k] = {
      minimumRecall: fraction(
        threshold.minimumRecall,
        `thresholds.atK.${rawK}.minimumRecall`,
      ),
      minimumMrr: fraction(
        threshold.minimumMrr,
        `thresholds.atK.${rawK}.minimumMrr`,
      ),
      minimumSuccessRate: fraction(
        threshold.minimumSuccessRate,
        `thresholds.atK.${rawK}.minimumSuccessRate`,
      ),
    };
  }
  if (!Object.hasOwn(value, "maximumFalsePositiveRate"))
    invalid("thresholds.maximumFalsePositiveRate is required");
  if (!Object.hasOwn(value, "maximumP95LatencyMs"))
    invalid("thresholds.maximumP95LatencyMs is required");
  return {
    atK,
    maximumFalsePositiveRate: fraction(
      value.maximumFalsePositiveRate,
      "thresholds.maximumFalsePositiveRate",
    ),
    maximumP95LatencyMs: latency(
      value.maximumP95LatencyMs,
      "thresholds.maximumP95LatencyMs",
    ),
  };
}

function validateInput(input) {
  if (!isPlainObject(input) || input.version !== 1)
    invalid("version must equal 1");
  const allowedInput = new Set([
    "version",
    "metadata",
    "thresholds",
    "cases",
    "runs",
  ]);
  for (const key of Object.keys(input))
    if (!allowedInput.has(key)) invalid(`unknown input key ${key}`);
  if (input.metadata !== undefined && !isPlainObject(input.metadata))
    invalid("metadata must be an object");
  if (
    !Array.isArray(input.cases) ||
    input.cases.length === 0 ||
    input.cases.length > MAX_CASES
  )
    invalid("cases must be a non-empty bounded array");
  const cases = new Map();
  for (const item of input.cases) {
    if (!isPlainObject(item)) invalid("case must be an object");
    const allowed = new Set([
      "id",
      "category",
      "query",
      "kind",
      "relevantEvidenceIds",
      "metadata",
    ]);
    for (const key of Object.keys(item))
      if (!allowed.has(key)) invalid(`unknown case key ${key}`);
    const id = nonEmptyString(item.id, "case id");
    if (cases.has(id)) invalid(`duplicate case id ${id}`);
    nonEmptyString(item.category, `case ${id} category`);
    if (item.query !== undefined)
      nonEmptyString(item.query, `case ${id} query`);
    if (item.metadata !== undefined && !isPlainObject(item.metadata))
      invalid(`case ${id} metadata`);
    if (item.kind !== "answerable" && item.kind !== "unanswerable")
      invalid(`case ${id} kind`);
    if (item.kind === "answerable")
      uniqueStrings(item.relevantEvidenceIds, `case ${id} relevantEvidenceIds`);
    else if (item.relevantEvidenceIds !== undefined) {
      uniqueStrings(
        item.relevantEvidenceIds,
        `case ${id} relevantEvidenceIds`,
        { allowEmpty: true },
      );
      if (item.relevantEvidenceIds.length !== 0)
        invalid(`unanswerable case ${id} has relevant evidence`);
    }
    cases.set(id, item);
  }
  if (
    !Array.isArray(input.runs) ||
    input.runs.length === 0 ||
    input.runs.length > MAX_RUNS
  )
    invalid("runs must be a non-empty bounded array");
  const runs = [];
  const runIds = new Set();
  for (const run of input.runs) {
    if (!isPlainObject(run)) invalid("run must be an object");
    const allowed = new Set([
      "id",
      "mode",
      "fingerprint",
      "observations",
      "metadata",
      "timing",
    ]);
    for (const key of Object.keys(run))
      if (!allowed.has(key)) invalid(`unknown run key ${key}`);
    const id = nonEmptyString(run.id, "run id");
    if (runIds.has(id)) invalid(`duplicate run id ${id}`);
    runIds.add(id);
    const mode = nonEmptyString(run.mode, `run ${id} mode`);
    if (run.fingerprint !== undefined)
      nonEmptyString(run.fingerprint, `run ${id} fingerprint`);
    if (run.metadata !== undefined && !isPlainObject(run.metadata))
      invalid(`run ${id} metadata`);
    const timingMetadata = timing(run.timing, `run ${id} timing`);
    if (
      !Array.isArray(run.observations) ||
      run.observations.length !== cases.size
    )
      invalid(`run ${id} observations must cover every case once`);
    const observationIds = new Set();
    const observations = [];
    for (const observation of run.observations) {
      if (!isPlainObject(observation)) invalid(`run ${id} observation`);
      const allowedObservation = new Set([
        "caseId",
        "rankedEvidenceIds",
        "latencyMs",
        "semanticCandidateStatus",
        "error",
      ]);
      for (const key of Object.keys(observation))
        if (!allowedObservation.has(key))
          invalid(`unknown observation key ${key}`);
      const caseId = nonEmptyString(
        observation.caseId,
        `run ${id} observation caseId`,
      );
      if (!cases.has(caseId)) invalid(`run ${id} unknown case id ${caseId}`);
      if (observationIds.has(caseId))
        invalid(`run ${id} duplicate observation case id ${caseId}`);
      observationIds.add(caseId);
      uniqueStrings(
        observation.rankedEvidenceIds,
        `run ${id} observation ${caseId} rankedEvidenceIds`,
        { allowEmpty: true },
      );
      latency(
        observation.latencyMs,
        `run ${id} observation ${caseId} latencyMs`,
      );
      if (
        !["available", "unavailable", "not_requested"].includes(
          observation.semanticCandidateStatus,
        )
      )
        invalid(`run ${id} observation ${caseId} semanticCandidateStatus`);
      if (observation.error !== undefined)
        nonEmptyString(
          observation.error,
          `run ${id} observation ${caseId} error`,
        );
      observations.push(observation);
    }
    if (
      observations.some(
        (observation) => observation.semanticCandidateStatus === "available",
      ) &&
      run.fingerprint === undefined
    )
      invalid(
        `run ${id} fingerprint is required for available semantic candidates`,
      );
    runs.push({ ...run, id, mode, timing: timingMetadata, observations });
  }
  return { cases, runs, thresholds: validateThresholds(input.thresholds) };
}

function scoreUnit(unit, cases, thresholds) {
  const answerable = [];
  const unanswerable = [];
  const latencies = [];
  let errors = 0;
  let semanticAvailable = 0;
  let semanticUnavailable = 0;
  let semanticNotRequested = 0;
  for (const observation of unit.observations) {
    const item = { case: cases.get(observation.caseId), observation };
    latencies.push(observation.latencyMs);
    if (observation.error !== undefined) errors++;
    if (observation.semanticCandidateStatus === "available")
      semanticAvailable++;
    else if (observation.semanticCandidateStatus === "unavailable")
      semanticUnavailable++;
    else semanticNotRequested++;
    (item.case.kind === "answerable" ? answerable : unanswerable).push(item);
  }
  const atK = {};
  for (const [k, gate] of Object.entries(thresholds.atK)) {
    const answerScores = answerable.map(
      ({ case: evaluationCase, observation }) => {
        const relevant = new Set(evaluationCase.relevantEvidenceIds);
        const top = observation.rankedEvidenceIds.slice(0, Number(k));
        const recalled = top.filter((id) => relevant.has(id)).length;
        const firstRank = top.findIndex((id) => relevant.has(id));
        return {
          recall: recalled / relevant.size,
          reciprocalRank: firstRank === -1 ? 0 : 1 / (firstRank + 1),
          success: firstRank !== -1,
        };
      },
    );
    const successCount = answerScores.filter((score) => score.success).length;
    const metrics = {
      recall: mean(answerScores.map((score) => score.recall)),
      mrr: mean(answerScores.map((score) => score.reciprocalRank)),
      successCount,
      successRate:
        answerScores.length === 0 ? null : successCount / answerScores.length,
      answerableCaseCount: answerScores.length,
    };
    atK[k] = {
      ...metrics,
      threshold: gate,
      passed:
        metrics.recall !== null &&
        metrics.recall >= gate.minimumRecall &&
        metrics.mrr >= gate.minimumMrr &&
        metrics.successRate >= gate.minimumSuccessRate,
    };
  }
  const candidateReturnedCount = unanswerable.filter(
    ({ observation }) => observation.rankedEvidenceIds.length > 0,
  ).length;
  const falsePositiveRate =
    unanswerable.length === 0
      ? null
      : candidateReturnedCount / unanswerable.length;
  const emptyCandidateCount = unanswerable.length - candidateReturnedCount;
  const semanticTotal = semanticAvailable + semanticUnavailable;
  const isSemanticMode = unit.mode === "semantic";
  const semanticBenchmarkEligible =
    isSemanticMode &&
    errors === 0 &&
    semanticUnavailable === 0 &&
    semanticAvailable === unit.observations.length;
  const ineligibleReason = !isSemanticMode
    ? "mode_is_not_semantic"
    : errors > 0
      ? "recorded_error"
      : semanticUnavailable > 0
        ? "semantic_candidate_unavailable"
        : semanticAvailable !== unit.observations.length
          ? "semantic_candidate_not_requested"
          : null;
  const thresholdsPassed =
    Object.values(atK).every((result) => result.passed) &&
    falsePositiveRate !== null &&
    falsePositiveRate <= thresholds.maximumFalsePositiveRate &&
    percentile(latencies, 95) <= thresholds.maximumP95LatencyMs;
  return {
    id: unit.id,
    mode: unit.mode,
    fingerprint: unit.fingerprint ?? null,
    timing: unit.timing ?? null,
    observationCount: unit.observations.length,
    errorCount: errors,
    evidenceRankMetrics: { atK },
    negativeCases: {
      caseCount: unanswerable.length,
      candidateReturnedCount,
      candidateReturnedRate: falsePositiveRate,
      emptyCandidateCount,
      emptyCandidateRate:
        unanswerable.length === 0
          ? null
          : emptyCandidateCount / unanswerable.length,
    },
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: Math.max(...latencies),
    },
    semanticCandidates: {
      availableCount: semanticAvailable,
      unavailableCount: semanticUnavailable,
      notRequestedCount: semanticNotRequested,
      availabilityRate:
        semanticTotal === 0 ? null : semanticAvailable / semanticTotal,
    },
    gate: {
      passed:
        thresholdsPassed &&
        errors === 0 &&
        semanticUnavailable === 0 &&
        (!isSemanticMode || semanticBenchmarkEligible),
      thresholdsPassed,
      semanticBenchmarkEligible,
      semanticBenchmarkIneligibleReason: ineligibleReason,
    },
  };
}

function aggregateRuns(runs, cases, thresholds) {
  const groups = new Map();
  for (const run of runs) {
    const key = JSON.stringify([run.mode, run.fingerprint ?? null]);
    const group = groups.get(key) ?? {
      id: `mode:${run.mode}`,
      mode: run.mode,
      fingerprint: run.fingerprint,
      observations: [],
    };
    group.observations.push(...run.observations);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) =>
    scoreUnit(group, cases, thresholds),
  );
}

export function evaluateDocumentRetrieval(input, { inputSha256 = null } = {}) {
  const { cases, runs, thresholds } = validateInput(input);
  const scoredRuns = runs.map((run) => scoreUnit(run, cases, thresholds));
  return {
    version: 1,
    metricSemantics: {
      rankUnit: "immutable_evidence_id",
      recall: "macro recall over answerable cases",
      mrr: "mean reciprocal rank over answerable cases",
      negativeCases:
        "a ranked evidence id is an evidence-level false positive; an empty ranking is an empty retrieval candidate set and does not measure answer abstention",
      latencyPercentile: "nearest-rank percentile across recorded observations",
    },
    input: {
      sha256: inputSha256,
      caseCount: cases.size,
      runCount: runs.length,
      metadata: input.metadata ?? null,
    },
    thresholds,
    runs: scoredRuns,
    modes: aggregateRuns(runs, cases, thresholds),
    gate: {
      passed: scoredRuns.every((run) => run.gate.passed),
      failedRunIds: scoredRuns
        .filter((run) => !run.gate.passed)
        .map((run) => run.id),
    },
  };
}

export function parseArguments(args) {
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h")
    throw new EvaluationInputError(
      "usage: node scripts/evaluate-document-retrieval.mjs <input.json>",
    );
  return args[0];
}
async function readBoundedInput(path) {
  let handle;
  try {
    handle = await openFile(path, "r");
  } catch {
    invalid("input file unavailable");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_INPUT_BYTES)
      invalid("input byte length");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      invalid("input changed during read");
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function evaluateFile(path) {
  const bytes = await readBoundedInput(path);
  let input;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("input is not valid UTF-8 JSON");
  }
  return {
    ...evaluateDocumentRetrieval(input, {
      inputSha256: createHash("sha256").update(bytes).digest("hex"),
    }),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

const invokedPath = process.argv[1];
function isDirectInvocation() {
  try {
    return (
      typeof invokedPath === "string" &&
      import.meta.url === pathToFileURL(realpathSync(invokedPath)).href
    );
  } catch {
    return false;
  }
}
if (isDirectInvocation()) {
  try {
    const report = await evaluateFile(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.gate.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof EvaluationInputError ? error.message : "retrieval_evaluation_failed"}\n`,
    );
    process.exitCode = 2;
  }
}
