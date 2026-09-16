// P2-39g3: the retrieval parity instrument, rerun against PostgreSQL in
// keyword mode. P2-39g4: rerun again after the keyword legs were fixed. See
// docs/retrieval-parity-postgres.md for the full account of what this proves
// and what it does not (the semantic leg needs a real embedding provider and
// is deliberately out of scope here -- see `eval/run-recall-parity.mjs`).
//
// Two unconditional assertions, matching `evalRecall.ts`'s own blocking
// definition: zero tenant leaks and zero unexpected-historical results,
// across every query, every run. Recall itself is not asserted at 1, because
// one query in the frozen corpus is built to be unanswerable by keyword search
// on any engine. The expectation table below pins the exact misses this
// instrument finds, with a reason for each, and fails if that *set* changes --
// in either direction -- so a regression is visible and a fix is provable.

import assert from "node:assert/strict";
import test from "node:test";

import { applyKithSchema } from "../dist/index.js";
import { identityCtx } from "../dist/identity/index.js";
import { runRecallParity } from "../dist/eval/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

/**
 * Every query this instrument's baseline scores, and whether PostgreSQL's
 * full-text search recalls it in full.
 *
 * A row is populated only for a query that does not reach recall 1 at k=10,
 * with a reason a reviewer can check against `src/eval/corpus.ts`. A query
 * absent from this table is expected to recall 1 at both k=5 and k=10.
 *
 * P2-39g3 ran this instrument against the `websearch_to_tsquery` legs P2-39g1
 * ported, and eight of these nine queries missed: recall@10 of 0.167. The
 * cause was not the stemming gap section 2.7 of the consolidation plan
 * expected. `websearch_to_tsquery` ANDs every significant query token, so one
 * ordinary word ("go", "version", "status", "changed", "time", "recorded")
 * that is not a PostgreSQL English stopword but also never appears in the
 * terse memory being asked about dropped the whole row. Convex's search index
 * ranked on partial term overlap instead.
 *
 * P2-39g4 fixed that on the query side, per section 4.2's rule that a measured
 * regression is fixed by adjusting the query or adding `pg_trgm`, never by
 * lowering the bar. All three keyword legs now share `src/textSearch.ts`: the
 * query's own stemmed lexemes OR'd together, ranked by `ts_rank` so a row
 * matching more of them sorts first. Seven of the eight misses closed at an
 * unchanged candidate budget and recall@10 went to 0.889, so `pg_trgm` -- the
 * plan's fallback if adjusting the query had not been enough -- was measured
 * as unnecessary and is not installed. docs/retrieval-parity-postgres.md has
 * the per-query before and after.
 *
 * One miss remains. It is not a PostgreSQL gap and no keyword construction can
 * close it, which is why recall is still not asserted at 1 here. The two leak
 * assertions below stay unconditional, as they always were.
 */
const EXPECTED_MISSES = new Map([
  [
    "avery: paraphrase with no shared keywords",
    {
      reason:
        "By design, and not PostgreSQL-specific. The query ('Who should I " +
        "call when the heating stops working?') and its expected memory " +
        "('Delgado Mechanical services the furnace and boiler; ask for " +
        "Marisol.') share no term at all, so the OR of the query's lexemes " +
        "matches zero rows exactly as the AND did. No keyword search on any " +
        "engine can answer it. This case is reserved to prove the semantic " +
        "leg once a real embedding provider runs hybrid mode (see " +
        "docs/retrieval-parity-postgres.md).",
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
