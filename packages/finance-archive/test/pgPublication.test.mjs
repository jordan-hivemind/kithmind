// Publication, which is a real requirement now that the archive is hosted.
//
// "Single writer by convention is not a publication boundary. A laptop
// querying mid-import must not see half a ledger, and must never see new
// transactions against an old reconciliation verdict." Every test here
// observes from a *second connection*, because that is the only vantage point
// from which the claim means anything: a reader on the importing connection
// sees its own uncommitted work no matter how the code is arranged.
//
// The choice made was atomic publication rather than an immutable dataset
// revision readers select. It needs no revision column, no reader-side
// protocol and no schema change: Postgres already gives a reader outside the
// transaction a consistent snapshot, so one transaction spanning the import
// and both gates is the whole mechanism.

import assert from "node:assert/strict";
import test from "node:test";

import { ARCHIVE_WRITE_LOCK_KEY, publishImport } from "../dist/index.js";

import {
  all,
  archive,
  connect,
  count,
  one,
  skip,
} from "./helpers/pgArchive.mjs";

// Synthetic institution and account. No real institution, account, balance or
// file path appears anywhere in this suite.
const INSTITUTION = {
  id: "inst_marrowfield",
  name: "Marrowfield Mutual",
  slug: "marrowfield",
};
const ACCOUNT = { id: "acct_publication", last4: "0407" };
const NOW = new Date("2026-04-01T00:00:00.000Z");

async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug],
  );
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type, base_currency)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ACCOUNT.id,
      INSTITUTION.id,
      ACCOUNT.last4,
      "Synthetic account",
      "checking",
      "USD",
    ],
  );
}

async function seedBalance(client, id, asOf, cash) {
  await client.query(
    `INSERT INTO balances (id, account_id, as_of, cash, currency)
     VALUES ($1, $2, $3, $4, 'USD')`,
    [id, ACCOUNT.id, asOf, cash],
  );
}

function row(overrides = {}) {
  return {
    accountId: ACCOUNT.id,
    tradeDate: null,
    processDate: "2026-03-15",
    settleDate: null,
    datePrecision: "day",
    activityType: "credit",
    description: "Synthetic activity",
    instrumentId: null,
    quantity: null,
    price: null,
    amountText: "400",
    amountNote: null,
    currency: "USD",
    runningBalance: null,
    sourceLocator: "row:1",
    providerTxnId: null,
    ...overrides,
  };
}

function document(sha256, rows, overrides = {}) {
  return {
    sha256,
    filePath: `synthetic/${sha256}.json`,
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "activity_pull",
    docDate: "2026-03-31",
    providerReportedCount: rows.length,
    rows,
    ...overrides,
  };
}

test(
  "a reader on another connection never observes half an import",
  { skip },
  async (t) => {
    const client = await archive(t);
    const observer = await connect(t, client);
    await seed(client);

    // Enough rows that the publication takes many round trips, so the
    // observer below genuinely samples it in flight rather than only before
    // and after.
    const rows = Array.from({ length: 120 }, (_, index) =>
      row({
        sourceLocator: `row:${index + 1}`,
        providerTxnId: `ptx-${index + 1}`,
        amountText: `${index + 1}`,
      }),
    );
    const batch = {
      source: "synthetic-pull",
      documents: [document("a".repeat(64), rows)],
    };

    const samples = [];
    let finished = false;
    // `finally`, not `then`: a rejected publication must also end the loop,
    // or a source bug turns this test into a hang instead of a failure.
    const publication = publishImport(client, batch, NOW).finally(() => {
      finished = true;
    });
    while (!finished) {
      samples.push(await count(observer, "transactions"));
    }
    const summary = await publication;

    assert.equal(summary.rowsInserted, 120);
    // The sampling has to have actually happened, or the assertion below is
    // vacuous.
    assert.ok(
      samples.length >= 2,
      `expected the observer to sample the import in flight, got ${samples.length} sample(s)`,
    );
    // Every sample is the archive before the publication or the archive
    // after it. Not one is in between. The last sample can legitimately be
    // the committed 120 -- the loop's flag is set a microtask after COMMIT --
    // which is why the assertion is about partial states rather than about
    // which sample came last.
    assert.ok(
      samples.includes(0),
      "expected at least one observation before the publication committed",
    );
    for (const sample of samples) {
      assert.ok(
        sample === 0 || sample === 120,
        `a reader observed ${sample} of 120 transactions: half a ledger`,
      );
    }
    assert.equal(await count(observer, "transactions"), 120);
  },
);

test(
  "a reader never sees new transactions against an old reconciliation verdict",
  { skip },
  async (t) => {
    const client = await archive(t);
    const observer = await connect(t, client);
    await seed(client);
    // The statement says cash rose by 400 over March.
    await seedBalance(client, "bal_1", "2026-03-01", "1000");
    await seedBalance(client, "bal_2", "2026-03-31", "1400");

    const first = await publishImport(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("a".repeat(64), [row({ providerTxnId: "ptx-1" })]),
        ],
      },
      NOW,
    );
    assert.equal(first.cash.passed, 1);

    // Both facts read in one statement, so each sample is one snapshot.
    const observe = async () => {
      const observed = await one(
        observer,
        `SELECT
           (SELECT count(*)::text FROM transactions) AS transactions,
           (SELECT status FROM reconciliations WHERE account_id = $1) AS status`,
        [ACCOUNT.id],
      );
      return `${observed.transactions}/${observed.status}`;
    };

    // F1-59. Sampled on both sides of the publication as well as during it.
    // What this test proves is that no instant exists in which a reader sees
    // two transactions against the verdict that judged one -- a statement
    // about every sample, not about how many the polling loop happened to
    // catch. Sampling only *during* the publication was a race against the
    // thing being observed: a publication is now a fixed handful of round
    // trips rather than one per period in the archive, so on a fast enough
    // database the loop legitimately catches one instant and proves nothing.
    // That is exactly how this failed on Postgres 17 in CI, on the
    // sample-count guard and never on the invariant itself.
    const samples = [await observe()];

    // A second document adds activity inside the same period that the stated
    // balance change no longer explains. The verdict must flip in the same
    // instant the transaction appears.
    const second = publishImport(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("b".repeat(64), [
            row({
              providerTxnId: "ptx-2",
              processDate: "2026-03-16",
              amountText: "50",
              sourceLocator: "row:2",
            }),
          ]),
        ],
      },
      NOW,
    );

    let finished = false;
    const publication = second.finally(() => {
      finished = true;
    });
    while (!finished) {
      samples.push(await observe());
    }
    const summary = await publication;
    samples.push(await observe());

    assert.equal(summary.cash.failed, 1);
    // The two settled instants, pinned rather than raced for: before the
    // publication one transaction stands against a passing verdict, after it
    // two stand against a failing one. The flip happened.
    assert.equal(samples[0], "1/pass");
    assert.equal(samples.at(-1), "2/fail");
    // One transaction with a passing verdict, or two with a failing one.
    // Never two transactions still carrying the verdict that judged one.
    for (const sample of samples) {
      assert.ok(
        sample === "1/pass" || sample === "2/fail",
        `a reader observed ${sample}: new ledger against an old verdict`,
      );
    }
    assert.equal(
      `${(await one(observer, "SELECT count(*)::text AS n FROM transactions")).n}`,
      "2",
    );
  },
);

test(
  "a publication that fails partway leaves nothing at all behind",
  { skip },
  async (t) => {
    const client = await archive(t);
    const observer = await connect(t, client);
    await seed(client);

    // The first document is perfectly good. The second breaks ground rule 7:
    // the provider's own total does not match the pull. The good document's
    // rows must not survive the rejection.
    const batch = {
      source: "synthetic-pull",
      documents: [
        document("a".repeat(64), [row({ providerTxnId: "ptx-1" })]),
        document("b".repeat(64), [row({ providerTxnId: "ptx-2" })], {
          providerReportedCount: 9,
        }),
      ],
    };

    await assert.rejects(publishImport(client, batch, NOW), /ground rule 7/);

    assert.equal(await count(observer, "transactions"), 0);
    assert.equal(await count(observer, "documents"), 0);
    assert.equal(await count(observer, "import_runs"), 0);
    assert.equal(await count(observer, "review_items"), 0);
  },
);

/** The two-row batch both concurrency tests below publish. */
function concurrentBatch() {
  return {
    source: "synthetic-pull",
    documents: [
      document("a".repeat(64), [
        row({ providerTxnId: "ptx-1" }),
        row({
          providerTxnId: "ptx-2",
          sourceLocator: "row:2",
          amountText: "25",
          description: "Synthetic transit fare",
        }),
      ]),
    ],
  };
}

test(
  "a second writer is excluded by the database, not by everyone remembering",
  { skip },
  async (t) => {
    const client = await archive(t);
    const holder = await connect(t, client);
    const watcher = await connect(t, client);
    await seed(client);

    const pid = Number(
      (await one(client, "SELECT pg_backend_pid()::text AS pid")).pid,
    );

    // A writer already in progress, represented by the lock it holds. It is
    // the same lock every archive writer takes, so what happens next is what
    // happens to a second import on a second machine.
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1)", [
      ARCHIVE_WRITE_LOCK_KEY,
    ]);

    const publication = publishImport(client, concurrentBatch(), NOW);

    // Wait for the publisher to be *blocked on that lock*, observed in
    // pg_locks rather than by sleeping for a plausible interval. Scoped to
    // this connection's own backend, so another suite importing concurrently
    // cannot satisfy it by accident.
    let blocked = 0;
    for (let attempt = 0; blocked === 0; attempt += 1) {
      if (attempt > 2000) {
        // Bounded so a missing lock is a failure with a reason rather than a
        // suite that hangs.
        assert.fail(
          "the publisher never waited on the archive write lock; a second writer is not excluded",
        );
      }
      blocked = await count(
        watcher,
        "pg_locks",
        "WHERE locktype = 'advisory' AND objid = $1 AND pid = $2 AND NOT granted",
        [ARCHIVE_WRITE_LOCK_KEY, pid],
      );
    }

    // Genuinely waiting: it has not written a thing.
    assert.equal(await count(watcher, "transactions"), 0);
    assert.equal(await count(watcher, "documents"), 0);

    await holder.query("COMMIT");

    const summary = await publication;
    assert.equal(summary.rowsInserted, 2);
    assert.equal(await count(watcher, "transactions"), 2);
  },
);

test(
  "two concurrent publications of one batch leave one archive, and the retry inserts nothing",
  { skip },
  async (t) => {
    const client = await archive(t);
    const rival = await connect(t, client);
    await seed(client);

    const [left, right] = await Promise.all([
      publishImport(client, concurrentBatch(), NOW),
      publishImport(rival, concurrentBatch(), NOW),
    ]);

    // Whichever went second found the document already imported and had
    // nothing to do, which is what an idempotent retry looks like. Neither
    // died on the row_hash or sha256 unique constraint.
    assert.deepEqual([left.rowsInserted, right.rowsInserted].sort(), [0, 2]);
    assert.deepEqual([left.rowsSkipped, right.rowsSkipped].sort(), [0, 2]);
    assert.equal(await count(client, "transactions"), 2);
    assert.equal(await count(client, "documents"), 1);
    // Both runs are recorded: an import that found nothing new is still an
    // import that ran.
    assert.equal(await count(client, "import_runs"), 2);
  },
);

test(
  "a value past the typed boundary is rejected into review, never rounded into place",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    // 19 fractional digits, one past the 18 the typed boundary carries.
    // NUMERIC with no declared scale would store it exactly; rounding it to
    // fit would be a silent loss, and storing it would smuggle a value past
    // the contract the read surface publishes.
    const tooPrecise = "1.0000000000000000001";
    const summary = await publishImport(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("a".repeat(64), [
            row({ providerTxnId: "ptx-1", quantity: tooPrecise }),
          ]),
        ],
      },
      NOW,
    );

    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.reviewItemsOpened, 1);
    const stored = await one(
      client,
      "SELECT quantity, status FROM transactions",
    );
    assert.equal(stored.quantity, null);
    assert.equal(stored.status, "review");

    const items = await all(
      client,
      "SELECT kind, raw_value, reason FROM review_items",
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "ambiguous_quantity");
    assert.equal(items[0].raw_value, tooPrecise);
    // The reason says what the limit was and that nothing was dropped to fit.
    assert.match(items[0].reason, /19 fractional digits/);
    assert.match(items[0].reason, /rather than rounding/);
  },
);

test(
  "publishing reports both gates' verdicts, and the import run records them",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedBalance(client, "bal_1", "2026-03-01", "1000");
    await seedBalance(client, "bal_2", "2026-03-31", "1400");

    const summary = await publishImport(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("a".repeat(64), [row({ providerTxnId: "ptx-1" })]),
        ],
      },
      NOW,
    );

    assert.equal(summary.cash.periodsChecked, 1);
    assert.equal(summary.cash.passed, 1);
    assert.equal(summary.positions.periodsChecked, 0);
    assert.equal(summary.reconciliationsPassed, 1);
    assert.equal(summary.reconciliationsFailed, 0);

    const run = await one(
      client,
      "SELECT reconciliations_passed, reconciliations_failed FROM import_runs WHERE id = $1",
      [summary.importRunId],
    );
    assert.equal(run.reconciliations_passed, "1");
    assert.equal(run.reconciliations_failed, "0");

    // A passing period still records the tolerance it was allowed to use.
    const verdict = await one(
      client,
      "SELECT status, tolerance::text AS tolerance, delta::text AS delta FROM reconciliations",
    );
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.tolerance, "0");
    assert.equal(verdict.delta, "0");
  },
);
