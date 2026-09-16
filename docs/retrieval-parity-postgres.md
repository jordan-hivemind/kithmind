# Retrieval parity, rerun against PostgreSQL

P2-39g3. This document describes the retrieval parity instrument that
`docs/plans/2026-09-12-postgres-consolidation.md` section 4.2 asks for,
rerun against the PostgreSQL port, how to run it, and what it found.

The instrument has two parts, matching the two things retrieval does in this
system: the memory recall instrument (thoughts and facts, the frozen
two-account corpus) and the document retrieval instrument (search over
ingested documents). Both are reruns of an existing Convex-side or public
instrument, not new designs.

## Memory recall: the frozen two-account corpus

### What it is

`packages/convex/convex/models/thoughts/memoryEval.corpus.ts` defines two
synthetic accounts, "avery" and "rowan", holding deliberately confusable
memories -- the same child's school, the same product's version, the same
kind of medical detail -- so a broken account boundary produces a retrieval
hit rather than silence. `memoryEval.ts` scores a recorded retrieval result
against that corpus's expectations without calling an embedding or language
model: recall at k, tenant leaks, historical leaks (a superseded or retracted
memory presented where it should not be), and missing or forbidden exact
strings. `evalRecall.ts` is the live baseline: it seeds the corpus through
the real mutations, runs every query through the real hybrid retriever, and
scores the real rankings with the same scorer.

This repository ports all three, unchanged in behavior:

| Convex | PostgreSQL | What changed |
| --- | --- | --- |
| `models/thoughts/memoryEval.ts` | `packages/kith-store/src/eval/memoryEval.ts` | Nothing. Ported verbatim -- pure scoring, no database. |
| `models/thoughts/memoryEval.corpus.ts` | `packages/kith-store/src/eval/corpus.ts` | Nothing. Ported verbatim. Every name, product and company in it is synthetic (see the file's own header). |
| `models/thoughts/evalRecall.ts` | `packages/kith-store/src/eval/recallParity.ts` | Seeds through this package's real memory services (`captureThought`, `transitionMemory`, `rememberFact`) instead of Convex mutations, and scores through `recallCandidates`/`recallContext` (`src/embeddings/search.ts`, `src/memory/recall.ts`) instead of Convex actions. See the module's own comment for why seeding and scoring are two functions rather than one. |

`packages/kith-store/src/eval/` is exported as `eval` from the package's
`src/index.ts` and as the `@repo/kith-store/eval` package export, the same
convention as every other domain (`embeddings`, `memory`, `documents`).

### How to run it

Keyword mode, in the test suite, against a throwaway database:

```sh
KITH_STORE_DATABASE_URL=postgres://postgres@localhost:5432/postgres \
KITH_STORE_REQUIRE_DATABASE=1 \
pnpm --filter @repo/kith-store test:once
```

`test/recallParity.test.mjs` is the specific file; it asserts zero tenant
leaks and zero historical leaks unconditionally, and checks recall against
the frozen expectation table below (see "Keyword-mode results").

The standalone script, which prints the full JSON report and is what the
owner reruns after a real load:

```sh
KITH_STORE_DATABASE_URL=postgres://user:pass@host:5432/postgres \
pnpm eval:recall:postgres
```

This creates and drops its own throwaway database (never the pointed-at
server's real database), runs keyword mode always, and also runs hybrid mode
when a `BRAIN_EMBED_*` environment variable is set and a usable API key is
available (`BRAIN_EMBED_API_KEY`, or `OPENAI_API_KEY` for the default
endpoint). No embedding provider credential exists in this development
environment, and none is or should be committed; hybrid mode is written and
type-checked here but has not been exercised against a real provider. The
owner runs it with their own credentials to complete the semantic half of
this acceptance line -- see "What remains owed" below.

The script exits nonzero only on a tenant leak or a historical leak, in
either mode. A recall miss alone does not fail the exit code: section 2.7 of
the consolidation plan already expects PostgreSQL full-text search to differ
from Convex's search index, and this document's "Keyword-mode results" table
is where that is measured and explained, not silently gated on.

### Keyword-mode results

Run 2026-09-16 against local PostgreSQL 16 with pgvector 0.6.0, no active
embedding index (`vectorStatus: "unavailable"` on every query, as expected
with no `embedQuery` supplied):

| Metric | Value |
| --- | --- |
| Queries scored | 9 (7 for "avery", 2 for "rowan") |
| Recall@5 (mean) | 0.167 |
| Recall@10 (mean) | 0.167 |
| Tenant leaks | 0 |
| Historical leaks (retracted/stale shown as current, or shown at all when retracted) | 0 |
| Blocking failures | 0 (leaks are the only blocking condition; see below) |

Eight of the nine queries miss full recall at k=10. That is a larger gap
than section 2.7's framing ("Convex search is typo tolerant and prefix
matching, PostgreSQL full-text search stems instead") suggested going in, and
the dominant cause running this instrument actually found is different from
stemming:

**`websearch_to_tsquery` ANDs every significant query token together.** A
short natural-language question routinely contains an ordinary word -- "go",
"version", "status", "changed", "time", "recorded" -- that is not in
PostgreSQL's English stopword list but also never appears in the terse fact
or thought text it is asking about ("Atlas Memory is currently on v2.7.1..."
never spells out the word "version"; "Rowan attends Brightwater School."
never says "go"). Convex's search index tolerated a query token with no
match in the row and ranked on partial overlap; PostgreSQL's AND semantics
require every token to match somewhere, so one absent word drops the whole
row from the candidate set. This is a real, measured regression, not a
scoring artifact -- confirmed by direct inspection of `content_search` and
the resulting `websearch_to_tsquery` output for each miss below.

| Query | Recall@10 | Reason |
| --- | --- | --- |
| avery: exact product and ticket identifiers | 0 | AND-of-terms. Tokenizes to require `version`; the memory spells it `v2.7.1`, never the word "version". |
| avery: current school only | 0 | AND-of-terms. Tokenizes to `rowan` & `go` & `school`; `go` is not a stopword and appears in neither the matching thought nor the matching fact. |
| avery: school history when asked historically | 0 | AND-of-terms. Tokenizes to include `chang`/`time`; neither school thought's wording uses either word. |
| avery: paraphrase with no shared keywords | 0 | Not PostgreSQL-specific: this case is deliberately built to share no keyword with its answer at all, so no keyword search on any engine can answer it. It exists to prove the semantic leg once hybrid mode runs with a real provider. |
| avery: correction never resurfaces as history | 0.5 | Partial. The corrected thought is found (`record` appears in its own wording); the paired fact's terse subject/predicate/value statement never uses `record`, so only the thought is found. |
| avery: multi-fact project status | 0 | AND-of-terms. Tokenizes to include `status`; none of the three Foster Clarity thoughts use that word, even though `foster`, `clariti` and `rollout` each match individually. |
| avery: enduring constraint reached by paraphrase | 1 (pass) | Passes, but coincidentally: the expected memory is a **core** memory, which `recall_context` always surfaces regardless of the query, so this case does not actually exercise keyword search. |
| rowan: other account sees only its own version | 0 | Same `version` token gap as the "avery" version query. |
| rowan: other account sees only its own school record | 0 | Same `go` token gap as the "avery" school query. |

`test/recallParity.test.mjs`'s `EXPECTED_MISSES` table pins exactly this set
with the same reasons. The test fails if the set of missing queries changes
in either direction, so a later fix (see "What remains owed") or a
regression is visible immediately, rather than silently absorbed.

**Zero tenant leaks and zero historical leaks in every run.** These are
asserted unconditionally, separately from recall, because they test the one
thing this corpus exists to test: `avery` and `rowan` hold deliberately
confusable rows in separate spaces, and every read in this suite queries only
its own account's own space (`[spaceId]`, never the union). A leak here would
mean the space predicate in `src/embeddings/search.ts` or
`src/memory/{facts,thoughts}.ts` let another space's row through -- not that
the query happened to search more than one space. It did not happen in this
run, at any k, for either account.

### What remains owed for section 4.2

Section 4.2's acceptance line has three parts. This slice (P2-39g3) delivers
the instrument and the keyword-mode rerun; it does not, and does not claim
to, close all three:

1. **"The three unavailable controls must still report unavailable."** This
   line refers to the *document* retrieval instrument's controls (the pilot
   evaluation's corpus), not the memory corpus above -- see the document
   section below for that instrument's status.
2. **"Semantic recall at the same candidate budget must not regress."** Not
   measured here. No embedding provider credential exists in this
   development environment and none may be committed (see AGENTS.md's
   security-sensitive-work rules and this repository's stated environment
   constraints). Hybrid mode is implemented and exercised for shape and
   wiring (`eval/run-recall-parity.mjs` builds the embedding index the same
   way `test/helpers/embeddingFixture.mjs` does for tests, using real
   vectors from `requestEmbedding` in place of the fixture's synthetic
   one-hot ones), but has never run against a real provider. **The owner
   runs `pnpm eval:recall:postgres` with `BRAIN_EMBED_API_KEY` (or
   `OPENAI_API_KEY`) set to complete this**, and this document should be
   updated with that run's numbers before section 4.2 is called satisfied.
3. **"Any keyword-recall change must be explained by stemming rather than
   by a lost row."** Explained above, but not met as stated: the dominant
   cause is AND-of-terms query construction, not stemming, and it is a
   larger drop (8 of 9 queries) than "explained by stemming" implies. This
   is reported, not absorbed, per the plan's own fallback: `pg_trgm` fuzzy
   matching or an OR-mode/ranked fallback in the keyword leg. Both are
   changes to `src/embeddings/search.ts`, which is explicitly out of scope
   for this slice (owned by a concurrent workstream building the embedding
   write side) and is not touched here. **This is the primary finding this
   instrument owes forward**: keyword parity, as currently constructed, is
   not met, and closing it is real follow-on work, not a formality.

Do not read the keyword-mode pass in CI as semantic parity, or as the
"explained by stemming" bar being met. Neither is true yet.

## Document retrieval: recording a rerun of the private question set

`scripts/evaluate-document-retrieval.mjs` and
`docs/retrieval-evaluation.md` already define the scoring instrument and its
input shape (`cases` with labeled `relevantEvidenceIds`, `runs` with
per-case `rankedEvidenceIds`/`latencyMs`/`semanticCandidateStatus`). The
owner's actual question set and its `docs/plans/2026-09-08-pilot-retrieval-evaluation.md`
frozen corpus (180 active targets, 17 thoughts, 163 chunks, 18 answerable
questions and 3 unavailable controls) live in `docs/private/`, which is not
in this repository and is never populated by an agent.

`packages/kith-store/eval/record-document-retrieval.mjs` is the missing
piece for rerunning that private question set after a PostgreSQL load: given
a small `cases.json` (`id`, `query`, and a `spaceIds` list -- see the
script's own header) and a database URL, it calls `searchDocuments`
(`src/documents/model.ts`) for every case and turns the results into the
`runs[]` observation shape the evaluator consumes, flattening each result's
citations to their evidence span ids (the evaluator's immutable rank unit,
durable across a document's reprocessing in a way `documentId`/`chunkId` are
not). It reads and echoes no label -- no `relevantEvidenceIds`, no
threshold -- so it never needs to see the owner's private answer key. The
owner splices its `runs[]` output into their own private evaluator input
alongside those labels and runs `scripts/evaluate-document-retrieval.mjs` on
the merged file, the same way `scripts/fixtures/retrieval-evaluation-synthetic.json`
demonstrates for the public synthetic corpus:

```sh
node packages/kith-store/eval/record-document-retrieval.mjs \
  docs/private/document-retrieval-cases.json \
  "$KITH_STORE_DATABASE_URL" \
  > /tmp/postgres-runs.json
# then, after merging /tmp/postgres-runs.json's "runs" into the owner's
# private evaluator input alongside its labeled "cases" and "thresholds":
node scripts/evaluate-document-retrieval.mjs docs/private/document-retrieval-full.json
```

**`scripts/fixtures/retrieval-evaluation-synthetic.json`'s corpus cannot be
loaded into `kith` as-is.** Its evidence ids (`evidence-lab-a`,
`evidence-service-a`, ...) are hand-authored labels for a recorded, offline
evaluation; they are not `kith.evidence_spans` rows produced by the real
provenance chain, and there is no loader that turns that fixture into a
seeded PostgreSQL document. `packages/kith-store/test/recordDocumentRetrieval.test.mjs`
proves `record-document-retrieval.mjs`'s shape a different way instead: it
seeds one minimal document through the real provenance service the way
`test/parsedStagingAndDocuments.test.mjs` does (source item, revision, text
version, page, evidence span, document, chunk, activation), records it, and
feeds the result through the real evaluator with a tiny inline label and
threshold set. That test passes, proving the shape end to end without
inventing a parallel fixture format. It does not, and cannot, prove anything
about the owner's actual private question set's recall -- only the owner,
running the recorder against their own loaded corpus, can do that.

### What remains owed

Rerunning the owner's actual private question set after a PostgreSQL load,
with `docs/private/document-retrieval-cases.json` (or an equivalent) built
by hand from the frozen corpus, and this document updated with the resulting
numbers. That is owner work: this repository's public tree has no path to
the private corpus (see AGENTS.md's public contributor workflow), and no
agent should populate one.
