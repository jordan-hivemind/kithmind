// P2-39g3: the retrieval parity instrument, rerun against PostgreSQL in
// keyword mode. See docs/retrieval-parity-postgres.md for the full account
// of what this proves and what it does not (the semantic leg needs a real
// embedding provider and is deliberately out of scope here -- see
// `eval/run-recall-parity.mjs`).
//
// Two unconditional assertions, matching `evalRecall.ts`'s own blocking
// definition: zero tenant leaks and zero unexpected-historical results,
// across every query, every run. Recall itself is not asserted at 1: this
// suite's job is to prove PostgreSQL's full-text search is not equivalent to
// Convex's prefix/typo-tolerant search index (section 2.7 of the
// consolidation plan says as much), so the frozen expectation table below
// pins the exact misses this instrument found, with a one-line reason for
// each, and fails if that *set* changes -- in either direction -- so a
// regression is visible and a fix is provable.

import assert from "node:assert/strict";
import test from "node:test";

import { applyKithSchema } from "../dist/index.js";
import { identityCtx } from "../dist/identity/index.js";
import { runRecallParity } from "../dist/eval/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

/**
 * Every query this instrument's baseline scores, and whether PostgreSQL's
 * `websearch_to_tsquery` full-text search recalls it in full.
 *
 * A row is populated only for a query that does not reach recall 1 at k=10,
 * with a one-line reason. Running this suite against the migrated schema
 * found one dominant cause, not the stemming/prefix-tolerance gap section 2.7
 * of the consolidation plan called out: `websearch_to_tsquery` ANDs every
 * significant query token together, and a short natural-language question
 * routinely contains an ordinary word ("go", "version", "status", "changed",
 * "time", "recorded") that is not PostgreSQL's stopword list but also never
 * appears in the terse fact or thought text it is asking about. Convex's own
 * search index tolerated a query token with no match in the row; PostgreSQL's
 * AND semantics do not. One query ("paraphrase with no shared keywords") is a
 * different, non-PostgreSQL-specific case: it is deliberately built to share
 * no keyword with its answer at all, so it is unanswerable by any keyword
 * search on either engine and exists to prove the semantic leg once a real
 * embedding provider is available (`eval/run-recall-parity.mjs`). A query
 * absent from this table is expected to recall 1 at both k=5 and k=10.
 *
 * This is reported, not absorbed, per section 4.2's acceptance line: fixing
 * it (`pg_trgm`, an OR-mode fallback, or a blend change) is `src/embeddings/
 * search.ts` work for a later slice, owned by the concurrent embedding
 * workstream; this instrument's job is to make the gap visible and keep it
 * from regressing silently in either direction.
 */
const EXPECTED_MISSES = new Map([
  [
    "avery: exact product and ticket identifiers",
    {
      reason:
        "AND-of-terms: the query tokenizes to require 'version', which the " +
        "memory never spells out as a word ('Atlas Memory is currently on " +
        "v2.7.1...' uses 'v2.7.1', not 'version'), so the AND query matches " +
        "nothing.",
    },
  ],
  [
    "avery: current school only",
    {
      reason:
        "AND-of-terms: the query tokenizes to 'rowan' & 'go' & 'school'. 'go' " +
        "is not a PostgreSQL English stopword, and neither the current-school " +
        "thought nor the matching fact's terse statement contains the word " +
        "'go', so the AND query matches nothing in either store.",
    },
  ],
  [
    "avery: school history when asked historically",
    {
      reason:
        "AND-of-terms: the query tokenizes to include 'chang' and 'time' " +
        "(from 'changed'/'time'), neither of which appears in either school " +
        "thought's own wording, so the AND query matches nothing.",
    },
  ],
  [
    "avery: paraphrase with no shared keywords",
    {
      reason:
        "By design, not PostgreSQL-specific: the query and its expected " +
        "memory share no keyword at all, so no keyword search on any engine " +
        "can answer it; this case is reserved to prove the semantic leg once " +
        "a real embedding provider runs hybrid mode (see " +
        "docs/retrieval-parity-postgres.md).",
    },
  ],
  [
    "avery: correction never resurfaces as history",
    {
      reason:
        "Partial (recall 0.5): the corrected thought is found ('record' " +
        "appears in its own wording, 'The earlier O negative record was " +
        "inaccurate.'), but the paired fact's statement is a terse " +
        "subject/predicate/value sentence that never uses the word 'record', " +
        "so the AND query finds the thought but not the fact.",
    },
  ],
  [
    "avery: multi-fact project status",
    {
      reason:
        "AND-of-terms: the query tokenizes to include 'status', which does " +
        "not appear in any of the three Foster Clarity thoughts' own " +
        "wording, so the AND query matches nothing even though 'foster', " +
        "'clariti' and 'rollout' each match individually.",
    },
  ],
  [
    "rowan: other account sees only its own version",
    {
      reason:
        "Same 'version' token gap as 'avery: exact product and ticket " +
        "identifiers': the memory spells the version as 'v9.9.9', never the " +
        "word 'version', so the AND query matches nothing.",
    },
  ],
  [
    "rowan: other account sees only its own school record",
    {
      reason:
        "Same 'go' token gap as 'avery: current school only': neither the " +
        "thought ('Rowan attends Brightwater School.') nor the fact contains " +
        "the word 'go', so the AND query matches nothing.",
    },
  ],
]);

test(
  "keyword-mode recall parity: zero leaks always, recall misses match the frozen expectation table",
  { skip },
  async (t) => {
    const database = await throwawayDatabase(t);
    const client = await connect(database);
    await applyKithSchema(client);
    await client.query("SET search_path TO kith, public");
    const ctx = identityCtx(client);

    const report = await runRecallParity(ctx);

    assert.equal(report.mode, "keyword");
    assert.equal(report.totalTenantLeaks, 0, `tenant leaks: ${JSON.stringify(report.queries.filter((q) => q.tenantLeakIds.length > 0))}`);
    assert.equal(
      report.totalHistoricalLeaks,
      0,
      `historical leaks: ${JSON.stringify(report.queries.filter((q) => q.historicalLeakIds.length > 0))}`,
    );
    assert.equal(report.blockingFailures.length, 0);
    assert.equal(report.passed, true);

    // Every query's own vectorStatus is "unavailable": keyword mode supplies
    // no `embedQuery`, so `recallCandidates` never attempts the vector leg.
    for (const queryResult of report.queries) {
      assert.equal(queryResult.vectorStatus, "unavailable", queryResult.name);
    }

    const actualMisses = new Map(
      report.queries
        .filter((queryResult) => queryResult.recallAtTen < 1)
        .map((queryResult) => [`${queryResult.account}: ${queryResult.name}`, queryResult]),
    );

    const missingFromTable = [...actualMisses.keys()].filter((name) => !EXPECTED_MISSES.has(name));
    const noLongerMissing = [...EXPECTED_MISSES.keys()].filter((name) => !actualMisses.has(name));
    assert.deepEqual(
      missingFromTable,
      [],
      `recall regressed on a query the expectation table does not explain: ${JSON.stringify(missingFromTable)}. ` +
        "Add a row to EXPECTED_MISSES with a one-line reason, or fix the regression.",
    );
    assert.deepEqual(
      noLongerMissing,
      [],
      `a query the expectation table marks as missing now recalls fully: ${JSON.stringify(noLongerMissing)}. ` +
        "Remove its row from EXPECTED_MISSES -- this is a parity improvement, but the table must track reality.",
    );

    // Report the final numbers the way the brief asks: printed, not just
    // asserted, so a human rerunning this suite sees them without reading
    // source.
    t.diagnostic(
      `recall@5=${report.recallAtFive.toFixed(3)} recall@10=${report.recallAtTen.toFixed(3)} ` +
        `queries=${report.queries.length} misses=${actualMisses.size} ` +
        `tenantLeaks=${report.totalTenantLeaks} historicalLeaks=${report.totalHistoricalLeaks}`,
    );
    for (const queryResult of report.queries) {
      t.diagnostic(
        `${queryResult.account}: ${queryResult.name} -- recall@5=${queryResult.recallAtFive} ` +
          `recall@10=${queryResult.recallAtTen} vectorStatus=${queryResult.vectorStatus}` +
          (queryResult.missingExactStrings.length > 0
            ? ` missingExactStrings=${JSON.stringify(queryResult.missingExactStrings)}`
            : ""),
      );
    }
  },
);
