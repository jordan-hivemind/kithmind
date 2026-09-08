// The schema and the arithmetic, against a real Postgres.
//
// These tests need a database, and a public clone has none, so they skip
// cleanly unless FINANCE_ARCHIVE_DATABASE_URL points at a throwaway one. The
// tradeoff is stated in the README: a clone with no database still runs every
// pure-logic test in pgMoney.test.mjs (validation, driver decoding, the
// deduplication preimage), but exact NUMERIC aggregation is only proved where
// a database is configured, so CI has to configure one.
//
// Each run works inside its own schema and drops it afterwards, so pointing
// this at a shared development database cannot clobber anything.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import pg from "pg";

import {
  applyPgSchema,
  fromNumericText,
  PG_SCHEMA_VERSION,
  PG_TABLES,
  pgSchemaVersion,
} from "../dist/index.js";

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;
const skip = url
  ? false
  : "set FINANCE_ARCHIVE_DATABASE_URL to a throwaway Postgres to run the integration tests";

/** Runs `body` against a freshly created, freshly dropped schema. */
async function withArchive(body) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const name = `finance_archive_test_${randomBytes(8).toString("hex")}`;
  try {
    await client.query(`CREATE SCHEMA "${name}"`);
    await client.query(`SET search_path TO "${name}"`);
    await applyPgSchema(client);
    await body(client);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await client.end();
  }
}

/** The minimum rows a transaction needs to exist. Wholly invented. */
async function seedAccount(client, currency = "USD") {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ('inst-1', 'Thistlebrook Trust', 'thistlebrook') ON CONFLICT DO NOTHING",
  );
  const id = `acct-${currency.toLowerCase()}`;
  await client.query(
    "INSERT INTO accounts (id, institution_id, acct_last4, base_currency) VALUES ($1, 'inst-1', '0042', $2)",
    [id, currency],
  );
  return id;
}

let hashCounter = 0;
async function insertAmount(client, accountId, amount, currency = "USD") {
  hashCounter += 1;
  await client.query(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at)
     VALUES ($1, $2, DATE '2026-03-04', 'fee', $3::numeric, $4, $5, now())`,
    [
      `txn-${hashCounter}`,
      accountId,
      amount,
      currency,
      `hash-${String(hashCounter).padStart(4, "0")}`,
    ],
  );
}

test(
  "schema creation is repeatable and the applied version is recorded",
  { skip },
  async () => {
    await withArchive(async (client) => {
      assert.equal(await pgSchemaVersion(client), PG_SCHEMA_VERSION);

      const tables = await client.query(
        "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1)",
        [[...PG_TABLES]],
      );
      assert.equal(Number(tables.rows[0].n), PG_TABLES.length);
      assert.equal(PG_TABLES.length, 13);

      // Running it again is a no-op, not a second version row and not an error.
      assert.equal(await applyPgSchema(client), PG_SCHEMA_VERSION);
      const versions = await client.query(
        "SELECT count(*)::text AS n FROM schema_version",
      );
      assert.equal(Number(versions.rows[0].n), 1);
    });
  },
);

test(
  "NUMERIC arrives as decimal text, never as a float",
  { skip },
  async () => {
    await withArchive(async (client) => {
      const account = await seedAccount(client);
      await insertAmount(client, account, "0.30000000000000004");
      const read = await client.query("SELECT amount FROM transactions");
      assert.equal(typeof read.rows[0].amount, "string");
      assert.equal(fromNumericText(read.rows[0].amount), "0.30000000000000004");

      // An unconstrained NUMERIC does not round a value the way NUMERIC(38, 18)
      // would, which is why the columns declare no scale.
      const precise = await client.query("SELECT $1::numeric::text AS v", [
        "1.00000000000000000000000001",
      ]);
      assert.equal(precise.rows[0].v, "1.00000000000000000000000001");
    });
  },
);

test(
  "arithmetic and aggregation are exact, including past 2^53",
  { skip },
  async () => {
    await withArchive(async (client) => {
      const account = await seedAccount(client);
      // Every one of these is exactly representable; their sum is not, as a
      // double, and neither are the operands past 2^53.
      for (const amount of [
        "9007199254740993",
        "9007199254740993",
        "0.1",
        "0.2",
      ]) {
        await insertAmount(client, account, amount);
      }
      const total = await client.query(
        "SELECT sum(amount)::text AS total FROM transactions",
      );
      assert.equal(total.rows[0].total, "18014398509481986.3");
      // The same sum through a double would not land here.
      assert.notEqual(
        String(9007199254740993 + 9007199254740993 + 0.1 + 0.2),
        "18014398509481986.3",
      );

      const pair = await client.query(
        "SELECT (0.1::numeric + 0.2::numeric)::text AS v",
      );
      assert.equal(pair.rows[0].v, "0.3");
    });
  },
);

test(
  "a multi-currency round trip totals per currency and never across them",
  { skip },
  async () => {
    await withArchive(async (client) => {
      // JPY is the zero-exponent case: 1250 yen is 1250, not 12.50.
      const usd = await seedAccount(client, "USD");
      const jpy = await seedAccount(client, "JPY");
      const kwd = await seedAccount(client, "KWD");
      await insertAmount(client, usd, "12.34", "USD");
      await insertAmount(client, usd, "-0.01", "USD");
      await insertAmount(client, jpy, "1250", "JPY");
      await insertAmount(client, jpy, "3", "JPY");
      await insertAmount(client, kwd, "1.234", "KWD");

      const grouped = await client.query(
        "SELECT currency, sum(amount)::text AS total FROM transactions GROUP BY currency ORDER BY currency",
      );
      assert.deepEqual(
        grouped.rows.map((r) => [r.currency, r.total]),
        [
          ["JPY", "1253"],
          ["KWD", "1.234"],
          ["USD", "12.33"],
        ],
      );

      // Grouping is not cosmetic: the ungrouped total is a different number
      // from every per-currency total, so a query that forgot to group would be
      // reporting something that is not any currency's balance.
      const crossed = await client.query(
        "SELECT sum(amount)::text AS total FROM transactions",
      );
      assert.equal(crossed.rows[0].total, "1266.564");
      for (const row of grouped.rows) {
        assert.notEqual(crossed.rows[0].total, row.total);
      }
    });
  },
);

test(
  "a non-finite NUMERIC is rejected by the database, not stored",
  { skip },
  async () => {
    await withArchive(async (client) => {
      const account = await seedAccount(client);
      await assert.rejects(
        insertAmount(client, account, "NaN"),
        /finance_numeric/,
      );
      const count = await client.query(
        "SELECT count(*)::text AS n FROM transactions",
      );
      assert.equal(Number(count.rows[0].n), 0);
    });
  },
);

test(
  "the constraints the SQLite schema expressed are still expressed",
  { skip },
  async () => {
    await withArchive(async (client) => {
      const account = await seedAccount(client);

      // acct_last4 is exactly four digits.
      await assert.rejects(
        client.query(
          "INSERT INTO accounts (id, institution_id, acct_last4, base_currency) VALUES ('acct-bad', 'inst-1', '042', 'USD')",
        ),
        /acct_last4/,
      );

      // row_hash is unique, which is what makes deduplication a database fact.
      await insertAmount(client, account, "12.34");
      await assert.rejects(
        client.query(
          `INSERT INTO transactions
           (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at)
         VALUES ('txn-dup', $1, DATE '2026-03-04', 'fee', 1, 'USD',
                 (SELECT row_hash FROM transactions LIMIT 1), now())`,
          [account],
        ),
        /row_hash/,
      );

      // Currency is a three-letter code on every money column.
      await assert.rejects(
        client.query(
          "INSERT INTO balances (id, account_id, as_of, currency) VALUES ('bal-bad', $1, DATE '2026-03-04', 'usd')",
          [account],
        ),
        /currency_code/,
      );

      // positions keeps its valuation basis, and commitments exists unpopulated.
      await assert.rejects(
        client.query(
          "INSERT INTO positions (id, account_id, as_of, currency, valuation_basis) VALUES ('pos-bad', $1, DATE '2026-03-04', 'USD', 'vibes')",
          [account],
        ),
        /valuation_basis/,
      );
      const commitments = await client.query(
        "SELECT count(*)::text AS n FROM commitments",
      );
      assert.equal(Number(commitments.rows[0].n), 0);
    });
  },
);
