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
import test from "node:test";

import pg from "pg";

import {
  applyPgSchema,
  ARCHIVE_TYPES,
  createArchiveClient,
  fromNumericText,
  PG_SCHEMA_VERSION,
  PG_TABLES,
  pgSchemaVersion,
  withArchiveTransaction,
} from "../dist/index.js";

import { skip, testSchemaName } from "./helpers/pgArchive.mjs";

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;

/** Runs `body` against a freshly created, freshly dropped schema. */
async function withArchive(body, schema = testSchemaName()) {
  const client = createArchiveClient(url, schema);
  await client.connect();
  try {
    await applyPgSchema(client);
    await body(client, schema);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
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
  "every non-finite NUMERIC is rejected by the database, not stored",
  { skip },
  async () => {
    await withArchive(async (client) => {
      const account = await seedAccount(client);
      // Postgres NUMERIC has three non-finite values, not one: Infinity and
      // -Infinity have been accepted since Postgres 14. Application-side
      // validation is not what is under test here -- each insert goes to the
      // server as a literal and has to come back an error, because the domain
      // is what makes this a database invariant rather than a convention.
      for (const nonFinite of ["NaN", "Infinity", "-Infinity"]) {
        await assert.rejects(
          insertAmount(client, account, nonFinite),
          /finance_numeric/,
          `${nonFinite} was accepted into a money column`,
        );
      }

      // Every finance_numeric column, not just the one the loop above used:
      // an infinite balance or quantity is the same defect as an infinite
      // amount, and a domain that only covered transactions.amount would be
      // a guarantee about one column rather than about the type.
      await assert.rejects(
        client.query(
          `INSERT INTO balances (id, account_id, as_of, cash, currency)
           VALUES ('bal-inf', $1, DATE '2026-03-04', 'Infinity'::numeric, 'USD')`,
          [account],
        ),
        /finance_numeric/,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO positions (id, account_id, as_of, quantity, currency)
           VALUES ('pos-inf', $1, DATE '2026-03-04', '-Infinity'::numeric, 'USD')`,
          [account],
        ),
        /finance_numeric/,
      );

      // The server really does accept these into a bare NUMERIC, which is
      // what makes the domain load-bearing rather than decorative.
      const bare = await client.query("SELECT 'Infinity'::numeric::text AS v");
      assert.equal(bare.rows[0].v, "Infinity");

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

// --- coexistence with another component in the same database ---------------
//
// Co-locating databases is the plan of record, so "whatever the connection's
// search_path happens to be" is not a safe place to put the archive. These
// two tests are the concrete failures that would follow: a neighbour's
// schema_version answering for the archive's, and the archive resolving a
// neighbour's table because it is earlier on the path.

/**
 * A connection whose ambient search_path is somebody else's schema. Built
 * from a bare pg.Client on purpose: `createArchiveClient` would pin the path
 * in the startup packet, and the point here is that the archive stays correct
 * without that help, the way it must on a pooled endpoint where a
 * session-level path can be handed to a backend the next statement never sees.
 */
async function neighbourConnection(foreign) {
  const client = new pg.Client({
    connectionString: url,
    types: ARCHIVE_TYPES,
    options: `-c search_path=${foreign}`,
  });
  await client.connect();
  return client;
}

test(
  "another component's schema_version in the same database is not the archive's",
  { skip },
  async () => {
    const foreign = testSchemaName();
    const archiveSchema = testSchemaName();
    const setup = createArchiveClient(url, foreign);
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${foreign}`);
    await setup.query(
      `CREATE TABLE ${foreign}.schema_version (
         version INTEGER PRIMARY KEY, name TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    await setup.query(
      `INSERT INTO ${foreign}.schema_version (version, name) VALUES (99, 'some other component')`,
    );
    await setup.end();

    const client = await neighbourConnection(foreign);
    try {
      // The trap is armed: an unqualified schema_version on this connection
      // resolves to the neighbour's, and it claims a version far past ours.
      const unqualified = await client.query(
        "SELECT max(version)::text AS v FROM schema_version",
      );
      assert.equal(unqualified.rows[0].v, "99");

      // The archive reads its own, which does not exist yet. Version 99 would
      // have been read as "newer than this build understands" and 1 as
      // "already current"; both skip creation against a database that has no
      // archive in it.
      assert.equal(await pgSchemaVersion(client, archiveSchema), 0);
      assert.equal(
        await applyPgSchema(client, archiveSchema),
        PG_SCHEMA_VERSION,
      );
      assert.equal(
        await pgSchemaVersion(client, archiveSchema),
        PG_SCHEMA_VERSION,
      );

      // The archive landed in its own schema, whole.
      const created = await client.query(
        `SELECT count(*)::text AS n FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = ANY($2)`,
        [archiveSchema, [...PG_TABLES]],
      );
      assert.equal(Number(created.rows[0].n), PG_TABLES.length);

      // And the neighbour is untouched: still one table, still version 99,
      // still one row. Creation wrote nothing into it.
      const neighbourTables = await client.query(
        "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1",
        [foreign],
      );
      assert.equal(Number(neighbourTables.rows[0].n), 1);
      const neighbourVersions = await client.query(
        `SELECT count(*)::text AS n, max(version)::text AS v FROM ${foreign}.schema_version`,
      );
      assert.equal(Number(neighbourVersions.rows[0].n), 1);
      assert.equal(neighbourVersions.rows[0].v, "99");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${archiveSchema} CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS ${foreign} CASCADE`);
      await client.end();
    }
  },
);

test(
  "the archive reads and writes its own tables when it is not first on the search_path",
  { skip },
  async () => {
    const foreign = testSchemaName();
    const archiveSchema = testSchemaName();
    const setup = createArchiveClient(url, foreign);
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${foreign}`);
    // A decoy with the same name as one of ours, earlier on the path, so an
    // unqualified `documents` on this connection is the neighbour's.
    await setup.query(
      `CREATE TABLE ${foreign}.documents (id TEXT PRIMARY KEY)`,
    );
    await setup.end();

    const client = await neighbourConnection(foreign);
    try {
      await applyPgSchema(client, archiveSchema);

      // A whole write path, through the package's own transaction helper.
      await withArchiveTransaction(client, async (tx) => {
        await tx.query(
          "INSERT INTO institutions (id, name, slug) VALUES ('inst-2', 'Thistlebrook Trust', 'thistlebrook-2')",
        );
        await tx.query(
          "INSERT INTO accounts (id, institution_id, acct_last4, base_currency) VALUES ('acct-2', 'inst-2', '0042', 'USD')",
        );
        await tx.query(
          `INSERT INTO documents (id, doc_type, file_path, sha256)
           VALUES ('doc-2', 'statement', 'synthetic/statement.pdf', $1)`,
          ["0".repeat(64)],
        );
        await tx.query(
          `INSERT INTO transactions
             (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at)
           VALUES ('txn-2', 'acct-2', DATE '2026-03-04', 'fee', '12.34'::numeric, 'USD', 'hash-coexist', now())`,
        );
      });

      const rows = await client.query(
        `SELECT
           (SELECT count(*)::text FROM ${archiveSchema}.documents) AS ours,
           (SELECT count(*)::text FROM ${foreign}.documents) AS theirs,
           (SELECT count(*)::text FROM ${archiveSchema}.transactions) AS txns`,
      );
      assert.equal(rows.rows[0].ours, "1");
      assert.equal(rows.rows[0].theirs, "0");
      assert.equal(rows.rows[0].txns, "1");

      // The decoy is still what an unqualified name resolves to on this
      // connection, so the assertion above is about the archive pinning its
      // own path rather than about the path being harmless.
      const resolved = await client.query(
        `SELECT n.nspname AS s FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid = to_regclass('documents')`,
      );
      assert.equal(resolved.rows[0].s, foreign);

      // And the money still crossed the driver as decimal text.
      const amount = await client.query(
        `SELECT amount FROM ${archiveSchema}.transactions`,
      );
      assert.equal(typeof amount.rows[0].amount, "string");
      assert.equal(fromNumericText(amount.rows[0].amount), "12.34");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${archiveSchema} CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS ${foreign} CASCADE`);
      await client.end();
    }
  },
);
