# Bounded pilot retrieval evaluation

Date: 2026-09-08. Status: evaluation in progress.

P2-2 measures the retained, already indexed pilot before expanding ingestion.
The pilot is nine documents, 155 pages and 163 active chunks. It does not
represent complete financial, household or medical coverage. The financial
archive workstream retains ownership of ledger acquisition and normalization.

## Method

Freeze 18 answerable questions and three corpus-scoped unavailable controls
before running searches. Include document disambiguation, paraphrases and
later-page evidence. Keep questions, answers, source identities, quotes and
provider responses in protected owner storage. Public tests use synthetic data.
Record the corpus and label hashes so a changed question set is a new run.

Measure hosted keyword and hybrid search separately. An unavailable semantic
candidate set is a failed capability check, not a poor embedding-model score.
Compare the current embedding baseline and a candidate offline before changing
any active profile. Compare bounded page-based chunk alternatives using the
same retained text. Do not re-extract PDFs or change evidence identities for an
offline comparison.

The [offline scorer](../retrieval-evaluation.md) reports evidence-rank recall,
reciprocal rank, successful retrieval, negative candidate-return rates and
request latency. Record document-rank success separately because the hosted
search returns at most one chunk per document. Multiple citations from one
result must not be mistaken for multiple ranked documents.

The primary diagnostic targets are successful answerable retrieval at rank
five of at least 0.85 and mean reciprocal rank at five of at least 0.65.
Report all-gold evidence recall separately when labels include equivalent
supporting spans. The hosted latency target is p95 below five seconds.
Negative controls describe candidate retrieval only. A semantic top-k result
is not an answer, and an empty ranking does not prove downstream abstention.
No answer-level hallucination or exact structured-record accuracy is claimed.
Authorization and citation-chain failures block release regardless of scores.

## Initial verified state

Live inspection found 163 active document chunks and no chunk vectors. The
17 existing vectors belong to conversational thoughts. The active profile is
the existing baseline, with incomplete document coverage. PDF activation does
not automatically generate document vectors.

Current manifest limits are 256 eligible targets, 256 vector rows per
generation, a 256-row thought scan and a 2 MiB estimated manifest budget.
The pilot currently has 180 eligible targets. The remaining 76-target row
headroom is not a promise that any 76 documents fit. Pages, text bytes,
per-document bounds and concurrent additions must also pass.

## Hosted baseline

The frozen run completed 42 hosted requests across 21 questions, with no
request or citation-validation errors. All 334 returned citations matched
retained text and immutable parent references. The temporary scoped read key
was revoked after the run.

| Measure                               | Keyword       | Hybrid request |
| ------------------------------------- | ------------- | -------------- |
| Supporting evidence in top five       | 11/18 (61.1%) | 11/18 (61.1%)  |
| Evidence MRR at five                  | 0.611         | 0.611          |
| All-gold evidence recall at five      | 0.583         | 0.583          |
| Correct document in top two           | 18/18         | 18/18          |
| Request p95                           | 682 ms        | 655 ms         |
| Semantic candidates available         | Not requested | 0/21           |
| Negative queries returning candidates | 3/3           | 3/3            |

Both requests failed the frozen retrieval target. Hybrid fell back to keyword,
so this is not a measured comparison of embedding models. The seven evidence
misses still found the right document; the selected chunk omitted the needed
page. Every request reported the bounded candidate search as partial. This
qualifies search breadth, not the validity of returned citations. A subsequent
`get_document` can expose additional pages, but that two-step workflow is not
counted as search-only evidence success here.

The corpus has similar tax forms and duplicated facts. It is a diagnostic
pilot, not a held-out estimate of quality across the owner's filing system.

## Controlled expansion

First fix demonstrated retrieval defects and repeat the frozen evaluation.
An index replacement must preserve the current complete readable generation
until compatible replacement vectors have been staged and verified, then
activate with the expected previous generation and unchanged source manifest.
Do not change the query model against old document vectors.

A next source needs an explicit source folder and destination, a small file,
page and byte budget, provenance checks, known-gap reporting, and sufficient
manifest headroom. Existing curated folders remain in place. Do not copy a
whole filing system into Inbox. Recheck capacity immediately before admission
and after publication. Broader backfill still requires P1-12 and P2-6 growth
work. Public backup packaging is independent of this owner-usefulness work.

## Verification

Run the scorer synthetic tests and all four repository checks. Independently
review the labels, runner and measured conclusions. Record provider usage and
latency actually observed; do not invent a dollar cost or model winner. Preserve
watcher and scheduled backup runtimes throughout development in an isolated
worktree. Keep cross-workstream changes on Issue #57.
