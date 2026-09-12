#!/usr/bin/env node
// Backfills positions.row_hash, balances.row_hash and liabilities.row_hash
// (F1-49, pgSchema.ts migration version 5) for rows that predate the column.
// Those rows keep a NULL row_hash on migration -- no backfill happens there,
// the same policy every additive migration in pgSchema.ts uses -- so a live
// archive's existing holdings need this one-off pass before the UNIQUE
// constraint is actually protecting anything for them.
//
// Idempotent: only rows with row_hash IS NULL are touched, so running this
// again (or against an archive some of whose holdings were already
// backfilled by an earlier run) changes nothing for rows already hashed.
//
// Refuses rather than guesses, per table: if backfilling would make two
// existing rows in one table share a row_hash -- content the importer would
// have deduplicated had both arrived through it, now both already
// permanently on file -- this reports every such pair for that table and
// writes nothing for it, so an operator can look at the actual rows before
// the constraint is asked to choose for them. A different table with no
// collision is still backfilled in the same run; rerun this script for the
// flagged table once its rows have been reviewed.
//
// Usage (development-first: point this at a throwaway database before a
// hosted one, same as scripts/provision.mjs):
//
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//     node scripts/backfillHoldingRowHash.mjs

import { balanceHash, liabilityHash, positionHash } from "../dist/rowHash.js";
import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "../dist/pgStore.js";

/** One entry per holdings table: how to read its identifying columns back
 * out and feed them to that table's own hash function (rowHash.ts). */
const TABLES = [
  {
    table: "positions",
    // source_locator is read even though most positions never hash it:
    // positionHash only mixes it in when instrument_id is null, the same
    // conditional rowHash.ts applies, so this must supply it every time
    // rather than guess in advance which rows need it.
    columns:
      "id, account_id, instrument_id, as_of, quantity, market_value, cost_basis, valuation_basis, source_locator",
    hash: (row) =>
      positionHash({
        accountId: row.account_id,
        instrumentId: row.instrument_id,
        asOf: row.as_of,
        quantity: row.quantity,
        marketValue: row.market_value,
        costBasis: row.cost_basis,
        valuationBasis: row.valuation_basis,
        sourceLocator: row.source_locator,
      }),
  },
  {
    table: "balances",
    columns: "id, account_id, as_of, total_value, cash",
    hash: (row) =>
      balanceHash({
        accountId: row.account_id,
        asOf: row.as_of,
        totalValue: row.total_value,
        cash: row.cash,
      }),
  },
  {
    table: "liabilities",
    columns: "id, account_id, kind, as_of, balance",
    hash: (row) =>
      liabilityHash({
        accountId: row.account_id,
        kind: row.kind,
        asOf: row.as_of,
        balance: row.balance,
      }),
  },
];

/**
 * Backfills every table in `TABLES` against an already-connected archive
 * client, one table at a time, each in its own transaction. Returns a report
 * of how many rows each table backfilled and, for a table refused, the
 * colliding groups (shared row_hash -> row ids, an "(existing row)" marker
 * standing in for a row that already carried that hash) rather than an id.
 *
 * Exported so `test/backfillHoldingRowHash.test.mjs` can drive it directly
 * against a throwaway schema instead of shelling out to this file.
 */
export async function backfillHoldingRowHash(client) {
  const report = { updated: {}, collisions: {} };

  for (const { table, columns, hash } of TABLES) {
    // eslint-disable-next-line no-await-in-loop -- one table at a time, on
    // purpose: a collision report for one table must not block another.
    await withArchiveTransaction(client, async (tx) => {
      await lockArchiveForWrite(tx);

      const existing = await tx.query(
        `SELECT DISTINCT row_hash FROM ${table} WHERE row_hash IS NOT NULL`,
      );
      const alreadyHashed = new Set(existing.rows.map((r) => r.row_hash));

      const unhashed = await tx.query(
        `SELECT ${columns} FROM ${table} WHERE row_hash IS NULL`,
      );

      const byHash = new Map();
      for (const row of unhashed.rows) {
        const computed = hash(row);
        const ids = byHash.get(computed) ?? [];
        ids.push(row.id);
        byHash.set(computed, ids);
      }

      const collisions = [];
      for (const [computed, ids] of byHash) {
        if (ids.length > 1 || alreadyHashed.has(computed)) {
          collisions.push({
            hash: computed,
            ids: alreadyHashed.has(computed) ? [...ids, "(existing row)"] : ids,
          });
        }
      }

      if (collisions.length > 0) {
        report.collisions[table] = collisions;
        return;
      }

      let updated = 0;
      for (const [computed, ids] of byHash) {
        for (const id of ids) {
          // eslint-disable-next-line no-await-in-loop
          await tx.query(`UPDATE ${table} SET row_hash = $1 WHERE id = $2`, [
            computed,
            id,
          ]);
          updated += 1;
        }
      }
      report.updated[table] = updated;
    });
  }

  return report;
}

async function main() {
  const url = archiveDatabaseUrl();
  const schema = archiveSchemaName();
  const client = createArchiveClient(url, schema);
  await client.connect();
  try {
    const report = await backfillHoldingRowHash(client);

    for (const [table, count] of Object.entries(report.updated)) {
      console.log(`${table}: backfilled ${count} row(s)`);
    }
    for (const [table, collisions] of Object.entries(report.collisions)) {
      console.log(
        `${table}: refused -- ${collisions.length} colliding group(s), nothing written for this table`,
      );
      for (const { hash, ids } of collisions) {
        console.log(`  row_hash ${hash}: ${ids.join(", ")}`);
      }
    }

    if (Object.keys(report.collisions).length > 0) {
      console.log(
        "\nReview the rows above (same table, same identifying fields) before " +
          "re-running this script for the affected table(s).",
      );
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
