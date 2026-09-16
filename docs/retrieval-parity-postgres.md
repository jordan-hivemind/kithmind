# Retrieval parity, rerun against PostgreSQL

P2-39g3 and P2-39g4. This document describes the retrieval parity instrument
that `docs/plans/2026-09-12-postgres-consolidation.md` section 4.2 asks for,
rerun against the PostgreSQL port, how to run it, what it found, and what was
changed in response. P2-39g3 built the instrument and reported a keyword
recall regression. P2-39g4 fixed that regression in the keyword legs and
reran; both runs' numbers are below.

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

Two runs, both on 2026-09-16 against local PostgreSQL 16 with pgvector 0.6.0
and no active embedding index (`vectorStatus: "unavailable"` on every query,
as expected with no `embedQuery` supplied). The before run is P2-39g3, against
the `websearch_to_tsquery` legs P2-39g1 ported. The after run is P2-39g4,
against the shared keyword construction in
`packages/kith-store/src/textSearch.ts`, on the same corpus and the same
candidate budget.

| Metric | Before (P2-39g3) | After (P2-39g4) |
| --- | --- | --- |
| Queries scored | 9 (7 for "avery", 2 for "rowan") | 9 (unchanged) |
| Recall@5 (mean) | 0.167 | 0.889 |
| Recall@10 (mean) | 0.167 | 0.889 |
| Queries missing full recall | 8 | 1 |
| Tenant leaks | 0 | 0 |
| Historical leaks | 0 | 0 |
| Blocking failures | 0 | 0 |

Per query, at k=10:

| Query | Before | After | Note |
| --- | --- | --- | --- |
| avery: exact product and ticket identifiers | 0 | 1 | `version` is absent from the memory; the other five terms carry it. |
| avery: current school only | 0 | 1 | `go` is absent from both the thought and the fact. |
| avery: school history when asked historically | 0 | 1 | `chang` and `time` are absent from both school thoughts. |
| avery: paraphrase with no shared keywords | 0 | 0 | Still a miss, by design. See below. |
| avery: correction never resurfaces as history | 0.5 | 1 | The fact's terse statement never uses `record`; the thought did. |
| avery: multi-fact project status | 0 | 1 | `status` is absent from all three Foster Clarity thoughts. |
| avery: enduring constraint reached by paraphrase | 1 | 1 | Passes as a core memory, which `recall_context` always surfaces. Still not an exercise of keyword search. |
| rowan: other account sees only its own version | 0 | 1 | Same `version` gap as the "avery" version query. |
| rowan: other account sees only its own school record | 0 | 1 | Same `go` gap as the "avery" school query. |

#### What the before run found

Eight of the nine queries missed full recall at k=10. That was a larger gap
than section 2.7's framing ("Convex search is typo tolerant and prefix
matching, PostgreSQL full-text search stems instead") suggested going in, and
the dominant cause the instrument actually found was different from stemming:

**`websearch_to_tsquery` ANDs every significant query token together.** A
short natural-language question routinely contains an ordinary word -- "go",
"version", "status", "changed", "time", "recorded" -- that is not in
PostgreSQL's English stopword list but also never appears in the terse fact
or thought text it is asking about ("Atlas Memory is currently on v2.7.1..."
never spells out the word "version"; "Rowan attends Brightwater School."
never says "go"). Convex's search index tolerated a query token with no
match in the row and ranked on partial overlap; PostgreSQL's AND semantics
require every token to match somewhere, so one absent word dropped the whole
row from the candidate set.

#### What the after run changed

Section 4.2's rule is that a measured regression is fixed by adjusting the
query or by adding `pg_trgm`, never by lowering the bar. Adjusting the query
was enough, so `pg_trgm` was not installed.

All three keyword legs -- `thoughtTextCandidateIds` and `searchFacts` in
`packages/kith-store/src/embeddings/search.ts`, and `keywordCandidates` in
`packages/kith-store/src/documents/model.ts` -- now share one construction
from `packages/kith-store/src/textSearch.ts`: the OR of the query's own
stemmed lexemes, ranked by `ts_rank` so a row matching more of them sorts
first. That is the same partial overlap Convex's index scored, expressed in
PostgreSQL's terms. Nothing else moved: the space predicate, the
retrievability and status filters, the per-space take, the merge and the
limit are as P2-39g1 ported them, and the candidate budget is unchanged.

Four choices in it were measured rather than assumed, on this corpus and on
document-length text.

| Choice | Alternative measured | Why the alternative lost |
| --- | --- | --- |
| Lexemes from `to_tsvector('english', $n)`, rendered with `quote_literal` | `replace(plainto_tsquery('english', $n)::text, '&', '|')` | The blind replace rewrites a `&` inside a lexeme as well as the operators between them, silently corrupting that term. |
| `ts_rank` with the default normalization | `ts_rank_cd` | Under an OR query every lexeme is its own cover, so cover density counts repetition. One query word repeated eight times scored 0.8 against 0.3 for a row matching three distinct query words. |
| `ts_rank` with the default normalization | `ts_rank(..., 1)` and the other length-normalizing flags | Length normalization promoted the shorter superseded "Rowan attends Lakeside School." over the longer current "Rowan currently attends Redwood Academy...", and on document-length text dropped a long chunk matching three query terms below a short one matching two. |
| No prefix matching on the final term | `:*` on the highest-position lexeme | Measured against all nine queries: it added zero candidate rows on this corpus. Untested behavior for no measured gain, so it is not there. |

`pg_trgm` remains available as the plan's named remedy if a later corpus
measures a miss this construction cannot reach -- a real typo, which stemming
and OR both still fail. Nothing in this run needed it.

#### The one remaining miss

**"avery: paraphrase with no shared keywords" still recalls 0, and no keyword
construction can change that.** The query ("Who should I call when the
heating stops working?") and its expected memory ("Delgado Mechanical
services the furnace and boiler; ask for Marisol.") share no term at all, so
the OR of the query's lexemes matches zero rows exactly as the AND did. The
case exists to prove the semantic leg, and it is still owed (see below).

`test/recallParity.test.mjs`'s `EXPECTED_MISSES` table pins exactly this one
miss with that reason. The test fails if the set of missing queries changes in
either direction, so both a later regression and a later fix are visible
rather than silently absorbed.

**Zero tenant leaks and zero historical leaks in every run, before and
after.** These are asserted unconditionally, separately from recall, because
they test the one thing this corpus exists to test: `avery` and `rowan` hold
deliberately confusable rows in separate spaces, and every read in this suite
queries only its own account's own space (`[spaceId]`, never the union). A
leak here would mean the space predicate in `src/embeddings/search.ts` or
`src/memory/{facts,thoughts}.ts` let another space's row through -- not that
the query happened to search more than one space. Broadening the keyword match
to an OR widens which rows inside a space can answer a query; it does not
touch the space predicate, the `retracted` exclusion or the validity window,
and the after run confirms that empirically at every k for both accounts.

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
   by a lost row."** Met as of P2-39g4. The P2-39g3 run did not meet it: the
   dominant cause was AND-of-terms query construction, not stemming, and the
   drop (8 of 9 queries) was far larger than "explained by stemming"
   implies. That was reported rather than absorbed, and P2-39g4 fixed it in
   the keyword legs with the OR-mode ranked construction the plan named as
   the first fallback. Eight of the nine queries now recall in full, at the
   same candidate budget. The ninth shares no term with its answer at all,
   so it is not a lost row in any engine's sense; it is the case the corpus
   reserves for the semantic leg. `pg_trgm`, the plan's second fallback, was
   measured as unnecessary and is not installed.

Do not read the keyword-mode pass in CI as semantic parity. Point 2 above is
still owed, and the corpus's one remaining miss is exactly the case that would
prove it.

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

### The document keyword leg after P2-39g4

`keywordCandidates` in `src/documents/model.ts` had the same AND-of-terms
construction the memory legs had, and it moved to the same shared helper. It
has no frozen public corpus to measure recall against, so the behavior is
proved directly instead, in
`packages/kith-store/test/parsedStagingAndDocuments.test.mjs` ("the document
keyword leg matches partial term overlap and ranks by how much matched"). It
seeds two chunks through the real provenance chain, one carrying three of a
four-term query and one carrying a single term, and asserts three things: a
query with one ordinary word that appears in neither chunk still finds them
(under AND-of-terms that one word returned nothing at all), the chunk matching
three terms ranks above the chunk matching one, and a query sharing no term
with either chunk still returns nothing, because this is an OR over the
query's own lexemes and not a match-all. It also asserts that the broadened
match does not widen the space boundary.

What that test does not do is measure the owner's private question set, which
is the paragraph below.

### What remains owed

Rerunning the owner's actual private question set after a PostgreSQL load,
with `docs/private/document-retrieval-cases.json` (or an equivalent) built
by hand from the frozen corpus, and this document updated with the resulting
numbers. That is owner work: this repository's public tree has no path to
the private corpus (see AGENTS.md's public contributor workflow), and no
agent should populate one.
