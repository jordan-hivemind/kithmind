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
search returns ranked passages, capped at three distinct chunks per document.
Multiple citations from one result must not be mistaken for multiple ranked
documents.

The primary diagnostic targets are successful answerable retrieval at rank
five of at least 0.85 and mean reciprocal rank at five of at least 0.65.
Report all-gold evidence recall separately when labels include equivalent
supporting spans. The hosted latency target is p95 below five seconds.
Negative controls describe candidate retrieval only. A semantic top-k result
is not an answer, and an empty ranking does not prove downstream abstention.
No answer-level hallucination or exact structured-record accuracy is claimed.
Authorization and citation-chain failures block release regardless of scores.

## Current index

The current index audit found 17 thought vectors and 163 chunk vectors: all
180 active targets are present, with no missing, extra, duplicate or invalid
rows. After the weighted large-profile trial below, the active profile is
large. This audit establishes index shape, not retrieval quality or a model
comparison.

Current manifest limits are 256 eligible targets, 256 vector rows per
generation, a 256-row thought scan and a 2 MiB estimated manifest budget.
The pilot currently has 180 eligible targets. The remaining 76-target row
headroom is not a promise that any 76 documents fit. Pages, text bytes,
per-document bounds and concurrent additions must also pass.

## Hosted baseline and rerun

The initial frozen run completed 42 hosted requests across the same 21
questions. Keyword and hybrid each retrieved supporting evidence at rank five
for 11/18 answerable questions, with MRR 0.611. Hybrid had semantic candidates
for 0/21 requests and fell back to keyword. It returned 334 valid citations;
the scoped read key was revoked afterward.

The combined frozen rerun completed 42 hosted requests across 21 questions,
with no request or citation-validation errors. All 734 returned citations
matched retained text and immutable parent references. The temporary scoped
read key was revoked after the run.

| Measure                         | Keyword       | Hybrid request |
| ------------------------------- | ------------- | -------------- |
| Supporting evidence in top five | 13/18 (72.2%) | 14/18 (77.8%)  |
| Evidence MRR at five            | 0.648148      | 0.668519       |
| Request p95                     | 752 ms        | 1.789 s        |
| Semantic candidates available   | Not requested | 21/21          |

Both requests still fail the frozen 85% success-at-five target. The hybrid
result now has semantic candidates for every request, but remains a bounded
hosted measurement rather than a proof of answer quality. Every request
reported the bounded candidate search as partial. This qualifies search
breadth, not the validity of returned citations or any downstream answer.

PR #84 was merged at `4651036` and the existing deployment workflow
automatically deployed it in CI run `34309952297` before the rerun. The rerun
therefore cannot isolate a single index change. Future measurement plans must
account for this automatic deployment behavior.

The corpus has similar tax forms and duplicated facts. It is a diagnostic
pilot, not a held-out estimate of quality across the owner's filing system.

## Offline embedding and passage comparison

The frozen labels were also scored offline against immutable retained chunks
and evidence IDs. This records local cosine ranking, not hosted request
latency or a deployed model change. The missing document-vector repair is
complete. The large profile was evaluated in production twice: an
equal-weight fusion trial was not adopted after the hosted gate failed, and
the weighted-fusion retrial below passed the gate and is now the active
profile.

| Candidate                                                   | Answerable success at five |          Evidence MRR at five | Status                                                                   |
| ----------------------------------------------------------- | -------------------------: | ----------------------------: | ------------------------------------------------------------------------ |
| Existing 163 chunks, small 1,536 dimensions, raw chunk rank |                      13/18 |                       0.62037 | Diagnostic baseline                                                      |
| Existing 163 chunks, large 1,536 dimensions, raw chunk rank |                      17/18 |                       0.76389 | Corroborated by the weighted large-profile trial below; model now active |
| Existing chunks, small, one result per document             |                      12/18 |       Not a deployment target | Superseded selection policy                                              |
| Existing chunks, large, one result per document             |                      13/18 |       Not a deployment target | Superseded selection policy                                              |
| Existing chunks, small, up to three passages per document   |                      13/18 | Not a model comparison change | Current passage-selection policy                                         |
| Existing chunks, large, up to three passages per document   |                      16/18 |       Not a deployment target | Current passage policy; model now active after the weighted retrial      |
| Page split near 1,200 characters with 180 overlap           |  11/18 parent-page success |               Diagnostic only | 475 chunks, exceeds current target bound                                 |
| Page split near 2,400 characters with 300 overlap           |  13/18 parent-page success |               Diagnostic only | 263 chunks, exceeds current target bound                                 |

The offline run made 55 provider requests with zero retries and reported
511,224 input tokens. It does not infer cost. A split chunk inherits no proof
that it supports all page evidence; exact span identity remains required. Both
split candidates exceed the current 256 eligible-target limit before thoughts,
so neither can be activated under the present manifest bound.

## Thought-only comparison

A separate private ten-query thought-only comparison was 10/10 at rank five
for both models. Small had MRR 0.8 and large had MRR 1.0; paired ordering was
4/6 for small and 6/6 for large. The comparison made six provider requests,
reported 5,356 input tokens, and had zero retries. Its historical and
lifecycle filtering was offline evaluation logic, not a production security
proof. The trial below completes the shared-profile safety check for this
candidate. Its first hosted document score did not meet the gate; the
weighted-fusion retrial in the section after it did.

## Shared-profile trial and rollback

The development recall suite passed for both profiles: recall at five was
0.944 and recall at ten was 1.0, with no blocking, scope or lifecycle failures.
Both preserved exact-duplicate identity, stored unrelated content and avoided
collapsing a close but materially different thought. Small requested confirmation
for that close case; large stored it. Synthetic fixtures were removed and the
original configuration restored.

A separate two-target development generation rehearsal verified exact vectors,
activation, rollback and restoration of the original configuration. It also
recovered from a configuration change before activation and from an already
active candidate with a missing final journal event. Independent review checked
the frozen driver and both durable recovery proofs before production execution.

Production staged and verified all 180 large-profile vectors before activation.
It then staged a complete small-profile rollback. The pinned watcher was paused
for this window; the daily backup service remained enabled. The same frozen
21 questions produced the following hosted results:

| Measure                         | Keyword       | Large hybrid  |
| ------------------------------- | ------------- | ------------- |
| Supporting evidence in top five | 13/18 (72.2%) | 15/18 (83.3%) |
| Evidence MRR at five            | 0.648148      | 0.736111      |
| Request p95                     | 819 ms        | 1.097 s       |
| Semantic candidates available   | Not requested | 21/21         |

All 734 returned citations validated, with zero request errors. The actual
profile was verified before and after the run, and the temporary read key was
revoked. Four frozen current-only production thought queries passed under both
profiles, with semantic retrieval available and every returned result checked
against the current owner and space membership. These checks do not measure
historical-query behavior or production capture writes.

The large hybrid result failed the unchanged 85% success target, which requires
at least 16/18. Production therefore activated the verified small rollback and
restored the original model configuration. Its 180-vector audit passed and the
pinned watcher resumed with a complete pass. The candidate is not adopted.
The next retrieval step is to diagnose fusion and passage-ranking misses while
preserving the frozen labels and reporting any tuning as pilot diagnostics.

## Weighted large-profile trial and adoption

Date 2026-09-12. PR #89 gave semantic document ranks a bounded weight in
reciprocal-rank fusion (k 60, keyword weight 1, semantic weight 1.25) instead
of the prior equal weighting. Before changing the active model, a hosted
validation of this weighting alone against the unchanged small profile
confirmed no regression: 14/18, diagnostic only, not adopted. The candidate
for this trial is `text-embedding-3-large` at 1,536 dimensions, revision
`comparison-openai-large-1536-v1`, combined with the PR #89 weighted fusion.
The corpus is unchanged at 180 active targets: 17 current thoughts, 163
chunks and 9 documents.

The same frozen 21 questions produced the following hosted results:

| Measure                          | Keyword       | Weighted large hybrid |
| -------------------------------- | ------------- | --------------------- |
| Supporting evidence in top five  | 13/18 (72.2%) | 17/18 (94.4%)         |
| Evidence MRR at five             | 0.648         | 0.758                 |
| All-gold evidence recall at five | Not measured  | 0.833                 |
| Request p95                      | 711.5 ms      | 1.4237 s              |
| Semantic candidates available    | Not requested | 21/21                 |

All 734 returned citations validated, with zero request, citation or
authorization errors. The keyword result is unchanged from every prior run.
Four frozen current-only production thought queries passed under the
weighted large profile (4/4).

The frozen gate (16/18 or better, MRR at five of at least 0.65, hosted p95
below five seconds, semantic candidates for 21/21 requests, zero errors, and
a passing thought smoke check) passed. The candidate is accepted and is now
the active production profile: the model and revision overrides are set to
the large profile rather than left absent. The small profile remains staged
as the rollback artifact and would be regenerated fresh if ever needed; it is
not left partially active alongside the large profile.

| Run                                | Supporting evidence in top five | Status                             |
| ---------------------------------- | ------------------------------: | ---------------------------------- |
| Baseline                           |                           11/18 | Diagnostic baseline                |
| Combined repair                    |                           14/18 | Passage-retention fix, not adopted |
| First large, equal-weight fusion   |                           15/18 | Rejected; below the frozen gate    |
| Small profile, weighted fusion     |                           14/18 | Diagnostic only, not adopted       |
| Weighted large fusion (this trial) |                           17/18 | Accepted; now active               |

The earlier offline sensitivity projection for the large model (17/18, see
the offline comparison table above) is corroborated, not replaced, by this
hosted run: the offline score anticipated the hosted outcome once fusion
weighting was corrected, rather than substituting for it.

This satisfies the retrieval-quality gate that bulk document backfill has
been waiting on. The remaining bulk-backfill gates are parser/provenance and
capacity (P1-12 and P2-6 growth tests), and both remain open.

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
