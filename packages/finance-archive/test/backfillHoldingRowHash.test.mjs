// F1-49. scripts/backfillHoldingRowHash.mjs against a real, throwaway
// archive: it must compute the same hash the importer would (so a live
// document reprocessed after backfill matches instead of duplicating), must
// be idempotent, and must refuse a table where two existing rows would
// collide rather than let the UNIQUE constraint choose between them.

import assert from "node:assert/strict";
import test from "node:test";

import {
  balanceHash,
  liabilityHash,
  positionHash,
} from "../dist/index.js";

import { backfillHoldingRowHash } from "../scripts/backfillHoldingRowHash.mjs";

import { all, archive, one, skip } from "./helpers/pgArchive.mjs";

const INSTITUTION_ID = "inst_backfill";
const ACCOUNT_ID = "acct_backfill";

async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, 'Backfill Trust', 'backfill-trust')",
    [INSTITUTION_ID],
  );
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, base_currency)
     VALUES ($1, $2, '0199', 'USD')`,
    [ACCOUNT_ID, INSTITUTION_ID],
  );
}

test(
  "backfillHoldingRowHash computes and writes the same row_hash the importer would, and is idempotent",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    await client.query(
      `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, market_value, cost_basis, valuation_basis, currency)
       VALUES ('pos-1', $1, DATE '2026-03-31', NULL, '10', '500', '400', 'market_price', 'USD')`,
      [ACCOUNT_ID],
    );
    await client.query(
      `INSERT INTO balances (id, account_id, as_of, total_value, cash, currency)
       VALUES ('bal-1', $1, DATE '2026-03-31', '10000', '500', 'USD')`,
      [ACCOUNT_ID],
    );
    await client.query(
      `INSERT INTO liabilities (id, account_id, kind, as_of, balance, currency)
       VALUES ('liab-1', $1, 'margin_loan', DATE '2026-03-31', '2000', 'USD')`,
      [ACCOUNT_ID],
    );

    const report = await backfillHoldingRowHash(client);
    assert.deepEqual(report.collisions, {});
    assert.equal(report.updated.positions, 1);
    assert.equal(report.updated.balances, 1);
    assert.equal(report.updated.liabilities, 1);

    const expectedPosition = positionHash({
      accountId: ACCOUNT_ID,
      instrumentId: null,
      asOf: "2026-03-31",
      quantity: "10",
      marketValue: "500",
      costBasis: "400",
      valuationBasis: "market_price",
    });
    const expectedBalance = balanceHash({
      accountId: ACCOUNT_ID,
      asOf: "2026-03-31",
      totalValue: "10000",
      cash: "500",
    });
    const expectedLiability = liabilityHash({
      accountId: ACCOUNT_ID,
      kind: "margin_loan",
      asOf: "2026-03-31",
      balance: "2000",
    });

    const position = await one(
      client,
      "SELECT row_hash FROM positions WHERE id = 'pos-1'",
    );
    const balance = await one(
      client,
      "SELECT row_hash FROM balances WHERE id = 'bal-1'",
    );
    const liability = await one(
      client,
      "SELECT row_hash FROM liabilities WHERE id = 'liab-1'",
    );
    assert.equal(position.row_hash, expectedPosition);
    assert.equal(balance.row_hash, expectedBalance);
    assert.equal(liability.row_hash, expectedLiability);

    // Idempotent: a second run touches nothing, because nothing is NULL
    // anymore, and reports zero updates rather than erroring on rows it has
    // already hashed.
    const second = await backfillHoldingRowHash(client);
    assert.deepEqual(second.collisions, {});
    assert.equal(second.updated.positions, 0);
    assert.equal(second.updated.balances, 0);
    assert.equal(second.updated.liabilities, 0);

    const unchanged = await one(
      client,
      "SELECT row_hash FROM positions WHERE id = 'pos-1'",
    );
    assert.equal(unchanged.row_hash, expectedPosition);
  },
);

test(
  "backfillHoldingRowHash refuses a table where two existing rows would collide, reporting both, while an unaffected table still backfills",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    // Two positions, identical on every hashed field: exactly what a rerun
    // of the same statement pull, before this table had a dedupe key, would
    // have produced.
    await client.query(
      `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, market_value, cost_basis, valuation_basis, currency)
       VALUES ('pos-dupe-1', $1, DATE '2026-03-31', NULL, '10', '500', '400', 'market_price', 'USD')`,
      [ACCOUNT_ID],
    );
    await client.query(
      `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, market_value, cost_basis, valuation_basis, currency)
       VALUES ('pos-dupe-2', $1, DATE '2026-03-31', NULL, '10', '500', '400', 'market_price', 'USD')`,
      [ACCOUNT_ID],
    );
    // balances carries no such duplicate, so it should backfill normally in
    // the same run: one table's refusal must not block another's.
    await client.query(
      `INSERT INTO balances (id, account_id, as_of, total_value, cash, currency)
       VALUES ('bal-clean', $1, DATE '2026-03-31', '10000', '500', 'USD')`,
      [ACCOUNT_ID],
    );

    const report = await backfillHoldingRowHash(client);

    assert.ok(report.collisions.positions);
    assert.equal(report.collisions.positions.length, 1);
    assert.deepEqual(
      new Set(report.collisions.positions[0].ids),
      new Set(["pos-dupe-1", "pos-dupe-2"]),
    );
    assert.equal(report.updated.positions, undefined);

    const positions = await all(
      client,
      "SELECT id, row_hash FROM positions ORDER BY id",
    );
    assert.ok(
      positions.every((row) => row.row_hash === null),
      "a colliding table is left entirely untouched, not partially backfilled",
    );

    // The unaffected table still landed.
    assert.equal(report.updated.balances, 1);
    const balance = await one(
      client,
      "SELECT row_hash FROM balances WHERE id = 'bal-clean'",
    );
    assert.ok(balance.row_hash);
  },
);
