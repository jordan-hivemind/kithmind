# Offline document retrieval evaluation

Run a recorded, provider-neutral evidence-rank evaluation without network or provider calls:

```sh
node scripts/evaluate-document-retrieval.mjs scripts/fixtures/retrieval-evaluation-synthetic.json
```

The command writes a machine-readable JSON report to standard output. It exits zero only when every measured run satisfies the input's fixed threshold gate. It exits one for measured gate failures and two for invalid input. The report records the SHA-256 of the exact input bytes plus Node, platform, and architecture metadata.

## Input v1

`cases` is the labeled question set. Every case has a unique `id`, non-empty `category`, optional `query` and object `metadata`, and a `kind`.

| Kind           | Label fields                                                               |
| -------------- | -------------------------------------------------------------------------- |
| `answerable`   | A non-empty, unique `relevantEvidenceIds` array of immutable evidence IDs. |
| `unanswerable` | Omit `relevantEvidenceIds`, or provide an empty array.                     |

`runs` records one or more measurements. Each run has a unique `id`, `mode`, optional immutable `fingerprint`, required `timing`, and exactly one observation for every case. `timing` has non-empty `request` and `cli` descriptions: record what `latencyMs` includes in the retrieval request and whether it includes local CLI or serialization overhead.

```json
{
  "caseId": "question-id",
  "rankedEvidenceIds": ["immutable-evidence-id"],
  "latencyMs": 42,
  "semanticCandidateStatus": "available"
}
```

`semanticCandidateStatus` is `available`, `unavailable`, or `not_requested`. A run with any `available` candidate must include a fingerprint so the compared semantic generation or provider is identifiable. Optional `error` records a provider or transport failure without making the evaluator crash. Any recorded error or unavailable candidate fails that run's gate. A semantic-mode run with an error, unavailable candidate, or `not_requested` candidate cannot be called a successful semantic benchmark. A keyword, hybrid, or fallback run is reported separately and is never labeled a semantic benchmark.

Set the complete gate in `thresholds`. `atK` maps each measured positive integer k to `minimumRecall`, `minimumMrr`, and `minimumSuccessRate` values in the inclusive range 0 through 1. `maximumFalsePositiveRate` and `maximumP95LatencyMs` are also required. Metrics use immutable evidence rank: Recall@k is macro recall over answerable cases, MRR@k is mean reciprocal rank, and success is an answerable case with at least one relevant evidence ID in the top k. For negative cases, any ranked evidence ID is an evidence-level false positive and an empty ranking is an empty retrieval candidate set. Neither result measures whether a downstream assistant answered, abstained, or correctly called a question unsupported. Latency percentiles use nearest-rank calculation.

The evaluator fails closed for invalid or duplicate labels, unknown case IDs, duplicate observations, missing observations, duplicate ranked evidence IDs, and malformed bounds. Inputs are bounded to 2 MiB, 10,000 cases, 100 runs, and 1,000 ranked evidence IDs per observation. Fixture labels are synthetic; this tool does not claim a production model benchmark.
