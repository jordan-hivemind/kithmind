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
  PG_MIGRATIONS,
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
  "pgSchemaVersion refuses a schema name it would otherwise interpolate into SQL (F1-34)",
  { skip },
  async () => {
    await withArchive(async (client) => {
      for (const name of [
        'public"; DROP TABLE documents; --',
        "has space",
        "1leading",
        "",
      ]) {
        await assert.rejects(
          () => pgSchemaVersion(client, name),
          /is not a usable archive schema name/,
          `${JSON.stringify(name)} must never reach a query`,
        );
      }
    });
  },
);

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
      assert.equal(PG_TABLES.length, 22);

      // Running it again is a no-op: one row per migration applied, no extra
      // row, revision bump, or error.
      const revision = await oneRevision(client);
      assert.equal(await applyPgSchema(client), PG_SCHEMA_VERSION);
      assert.deepEqual(await oneRevision(client), revision);
      const versions = await client.query(
        "SELECT count(*)::text AS n FROM schema_version",
      );
      assert.equal(Number(versions.rows[0].n), PG_MIGRATIONS.length);
    });
  },
);

test(
  "position scope history is immutable, source-owned, generation-bound, and forgotten with its document",
  { skip },
  async () => {
    await withArchive(async (client) => {
      const accountId = await seedAccount(client);
      const otherAccountId = await seedAccount(client, "EUR");
      await client.query(
        `INSERT INTO documents
           (id, institution_id, account_id, doc_type, doc_date, file_path,
            sha256, retained_sha256, retained_byte_length, media_type,
            capture_id, parsed_ok)
         VALUES ('scope-doc', 'inst-1', $1, 'statement', DATE '2026-03-31',
                 '/raw/scope-doc', $2, $2, 10, 'application/pdf',
                 'scope-capture', FALSE),
                ('other-doc', 'inst-1', $1, 'statement', DATE '2026-03-31',
                 '/raw/other-doc', $3, $3, 10, 'application/pdf',
                 'other-capture', FALSE)`,
        [accountId, "a".repeat(64), "b".repeat(64)],
      );
      await client.query(
        `INSERT INTO holding_projection_generations
           (id, document_id, generation_number, generation_kind,
            retained_sha256, projection_digest, created_at, activated_at)
         VALUES ('other-generation', 'other-doc', 1, 'baseline', $1, $2,
                 now(), now())`,
        ["b".repeat(64), "c".repeat(64)],
      );

      await assert.rejects(
        client.query(
          `INSERT INTO position_scope_observations
             (id, source_document_id, holding_projection_generation_id,
              retained_sha256, account_id, as_of, proof_version, status,
              emitted_position_count, gap_codes, evidence, created_at)
           VALUES ('wrong-generation', 'scope-doc', 'other-generation', $1,
                   $2, DATE '2026-03-31', 'position_scope_v1', 'complete',
                   1, '{}', '{"tables":[]}', now())`,
          ["a".repeat(64), accountId],
        ),
        /foreign key/i,
      );

      await client.query(
        `INSERT INTO position_scope_observations
           (id, source_document_id, retained_sha256, account_id, as_of,
            proof_version, status, emitted_position_count, gap_codes,
            zero_basis, evidence, created_at)
         VALUES ('scope-1', 'scope-doc', $1, $2, DATE '2026-03-31',
                 'position_scope_v1', 'complete', 1, '{}', NULL,
                 '{"tables":[]}', now())`,
        ["a".repeat(64), accountId],
      );
      await client.query(
        `INSERT INTO position_scope_memberships
           (source_document_id, scope_id, position_row_hash, account_id,
            as_of, quantity, price, market_value, cost_basis, unrealized,
            currency, valuation_basis, valuation_note, source_locator)
         VALUES ('scope-doc', 'scope-1', $1, $2, DATE '2026-03-31',
                 1, 2, 2, 1, 1, 'USD', 'market_price', 'synthetic',
                 '{"row":{"source":"synthetic","index":1}}')`,
        ["d".repeat(64), accountId],
      );

      await assert.rejects(
        client.query(
          "UPDATE position_scope_observations SET status = 'partial' WHERE id = 'scope-1'",
        ),
        /immutable/i,
      );
      await assert.rejects(
        client.query(
          "UPDATE position_scope_memberships SET account_id = $1 WHERE scope_id = 'scope-1'",
          [otherAccountId],
        ),
        /immutable/i,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO position_scope_memberships
             (source_document_id, scope_id, position_row_hash, account_id,
              as_of, currency, source_locator)
           VALUES ('scope-doc', 'scope-1', $1, $2, DATE '2026-03-31',
                   'EUR', '{}')`,
          ["e".repeat(64), otherAccountId],
        ),
        /foreign key/i,
      );

      await client.query("DELETE FROM documents WHERE id = 'scope-doc'");
      assert.equal(
        Number(
          (
            await client.query(
              "SELECT count(*)::text AS n FROM position_scope_observations",
            )
          ).rows[0].n,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await client.query(
              "SELECT count(*)::text AS n FROM position_scope_memberships",
            )
          ).rows[0].n,
        ),
        0,
      );
    });
  },
);

test(
  "finance read revision advances for every write event and rolls back atomically",
  { skip },
  async () => {
    await withArchive(async (client) => {
      const initial = await oneRevision(client);
      assert.match(initial.epoch, /^[0-9a-f-]{36}$/);
      const initialRevision = Number(initial.revision);
      assert.ok(initialRevision >= 1);

      await client.query(
        "INSERT INTO institutions (id, name, slug) VALUES ('revision-inst', 'Revision Institution', 'revision-institution')",
      );
      await client.query(
        "UPDATE institutions SET name = 'Corrected Institution' WHERE id = 'revision-inst'",
      );
      await client.query("DELETE FROM institutions WHERE id = 'revision-inst'");
      await client.query("TRUNCATE retained_texts");
      assert.deepEqual(await oneRevision(client), {
        epoch: initial.epoch,
        revision: String(initialRevision + 4),
      });

      await client.query("BEGIN");
      await client.query(
        "INSERT INTO institutions (id, name, slug) VALUES ('rolled-back', 'Rolled Back', 'rolled-back')",
      );
      assert.equal(
        (await oneRevision(client)).revision,
        String(initialRevision + 5),
      );
      await client.query("ROLLBACK");
      assert.equal(
        (await oneRevision(client)).revision,
        String(initialRevision + 4),
      );
    });
  },
);

test(
  "account alias writes invalidate finance reads and roll back atomically",
  { skip },
  async () => {
    await withArchive(async (client) => {
      const accountId = await seedAccount(client);
      const before = Number((await oneRevision(client)).revision);
      const values = ["alias-revision", accountId, "inst-1", "111-222222-333"];

      await client.query(
        `INSERT INTO account_aliases
           (id, account_id, institution_id, external_key, kind)
         VALUES ($1, $2, $3, $4, 'statement_number')`,
        values,
      );
      assert.equal((await oneRevision(client)).revision, String(before + 1));
      await client.query(
        "UPDATE account_aliases SET learned_note = 'synthetic correction' WHERE id = $1",
        [values[0]],
      );
      assert.equal((await oneRevision(client)).revision, String(before + 2));
      await client.query("DELETE FROM account_aliases WHERE id = $1", [
        values[0],
      ]);
      assert.equal((await oneRevision(client)).revision, String(before + 3));

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO account_aliases
           (id, account_id, institution_id, external_key, kind)
         VALUES ($1, $2, $3, $4, 'statement_number')`,
        values,
      );
      assert.equal((await oneRevision(client)).revision, String(before + 4));
      await client.query("ROLLBACK");
      assert.equal((await oneRevision(client)).revision, String(before + 3));

      await client.query(
        `INSERT INTO account_aliases
           (id, account_id, institution_id, external_key, kind)
         VALUES ($1, $2, $3, $4, 'statement_number')`,
        values,
      );
      await client.query("TRUNCATE account_aliases");
      assert.equal((await oneRevision(client)).revision, String(before + 5));
    });
  },
);

test(
  "tracked writes fail closed when the revision singleton is missing",
  { skip },
  async () => {
    await withArchive(async (client) => {
      await client.query("DELETE FROM finance_read_revision WHERE singleton");
      await assert.rejects(
        client.query(
          "INSERT INTO instruments (id, symbol) VALUES ('unrevisioned', 'BAD')",
        ),
        /finance read revision singleton missing/,
      );
      const instruments = await client.query(
        "SELECT count(*)::text AS n FROM instruments",
      );
      assert.equal(instruments.rows[0].n, "0");
    });
  },
);

test(
  "finance read revision serializes writers before they take disjoint table locks",
  { skip },
  async () => {
    const schema = testSchemaName();
    const first = createArchiveClient(url, schema);
    const second = createArchiveClient(url, schema);
    await Promise.all([first.connect(), second.connect()]);
    try {
      await applyPgSchema(first);
      await applyPgSchema(second);
      const initialRevision = Number((await oneRevision(first)).revision);
      await first.query("BEGIN");
      await second.query("BEGIN");
      await first.query(
        "INSERT INTO instruments (id, symbol) VALUES ('revision-a', 'REVA')",
      );
      const secondFirstWrite = second.query(
        "INSERT INTO retained_texts (sha256, byte_length, codepoint_length, content) VALUES ($1, 1, 1, $2)",
        ["a".repeat(64), Buffer.from("a")],
      );
      await first.query(
        "INSERT INTO retained_texts (sha256, byte_length, codepoint_length, content) VALUES ($1, 1, 1, $2)",
        ["b".repeat(64), Buffer.from("b")],
      );
      await first.query("COMMIT");
      await secondFirstWrite;
      await second.query(
        "INSERT INTO instruments (id, symbol) VALUES ('revision-b', 'REVB')",
      );
      await second.query("COMMIT");
      assert.equal(
        (await oneRevision(first)).revision,
        String(initialRevision + 4),
      );
    } finally {
      await Promise.allSettled([
        first.query("ROLLBACK"),
        second.query("ROLLBACK"),
      ]);
      await first.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await Promise.all([first.end(), second.end()]);
    }
  },
);

async function oneRevision(client) {
  const result = await client.query(
    "SELECT epoch::text, revision::text FROM finance_read_revision WHERE singleton",
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

test(
  "a version 11 archive preserves its epoch and advances once for the alias read dependency",
  { skip },
  async () => {
    const schema = testSchemaName();
    const client = createArchiveClient(url, schema);
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(
        `CREATE TABLE ${schema}.schema_version (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
      const version11 = PG_MIGRATIONS.filter((one) => one.version <= 11);
      assert.equal(version11.at(-1).version, 11);
      for (const migration of version11) {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${schema}.schema_version (version, name) VALUES ($1, $2)`,
          [migration.version, migration.name],
        );
      }
      await client.query(
        "INSERT INTO institutions (id, name, slug) VALUES ('alias-inst', 'Alias Institution', 'alias-institution')",
      );
      await client.query(
        `INSERT INTO accounts (id, institution_id, external_key, base_currency)
         VALUES ('alias-account', 'alias-inst', 'opaque-key', 'USD')`,
      );
      await client.query(
        `INSERT INTO account_aliases
           (id, account_id, institution_id, external_key, kind)
         VALUES ('alias-before-v12', 'alias-account', 'alias-inst',
                 '111-220042-333', 'statement_number')`,
      );
      const before = await oneRevision(client);

      assert.equal(await applyPgSchema(client, schema), PG_SCHEMA_VERSION);
      const migrated = await oneRevision(client);
      assert.equal(migrated.epoch, before.epoch);
      assert.equal(Number(migrated.revision), Number(before.revision) + 1);

      assert.equal(await applyPgSchema(client, schema), PG_SCHEMA_VERSION);
      assert.deepEqual(await oneRevision(client), migrated);
      await client.query(
        "UPDATE account_aliases SET learned_note = 'synthetic update' WHERE id = 'alias-before-v12'",
      );
      assert.equal(
        Number((await oneRevision(client)).revision),
        Number(migrated.revision) + 1,
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
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

// An archive that already exists is the case a migration is for: the columns
// F1-29 adds are worth nothing if applying them drops what is already there.
test(
  "an archive at the previous version migrates to the current one without data loss",
  { skip },
  async () => {
    const schema = testSchemaName();
    const client = createArchiveClient(url, schema);
    await client.connect();
    try {
      // A genuine older archive: the first migration and its version row,
      // nothing after it. Not the current schema with columns dropped back
      // off, which would prove only that the test can undo its own setup.
      const [first] = PG_MIGRATIONS;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(
        `CREATE TABLE ${schema}.schema_version (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
      await client.query(first.sql);
      await client.query(
        `INSERT INTO ${schema}.schema_version (version, name) VALUES ($1, $2)`,
        [first.version, first.name],
      );
      assert.equal(await pgSchemaVersion(client, schema), first.version);
      assert.ok(
        PG_SCHEMA_VERSION > first.version,
        "there is a later version to migrate to",
      );

      const sha = "9".repeat(64);
      await client.query(
        "INSERT INTO institutions (id, name, slug) VALUES ('inst-1', 'Thistlebrook Trust', 'thistlebrook')",
      );
      await client.query(
        `INSERT INTO documents (id, institution_id, doc_type, doc_date, file_path, sha256)
         VALUES ('doc-1', 'inst-1', 'activity_pull', DATE '2026-03-04', '/raw/doc-1', $1)`,
        [sha],
      );
      // An account provisioned by hand before F1-32, on the columns v1
      // actually had: base_currency was NOT NULL then, so a pre-migration
      // account always states one.
      await client.query(
        "INSERT INTO accounts (id, institution_id, acct_last4, base_currency) VALUES ('acct-1', 'inst-1', '0042', 'USD')",
      );

      assert.equal(await applyPgSchema(client, schema), PG_SCHEMA_VERSION);

      // F1-32. No backfill, the same policy F1-29's columns above use: the
      // pre-migration account honestly names no external key.
      const migratedAccount = await client.query(
        "SELECT external_key, base_currency FROM accounts WHERE id = 'acct-1'",
      );
      assert.deepEqual(migratedAccount.rows[0], {
        external_key: null,
        base_currency: "USD",
      });

      // The unique constraint is scoped per institution, and Postgres never
      // treats two NULLs as equal: a second hand-provisioned account with no
      // external key coexists with the first rather than colliding on it.
      await client.query(
        "INSERT INTO accounts (id, institution_id, acct_last4) VALUES ('acct-2', 'inst-1', '0043')",
      );
      // A discovered account can now state one, and no base_currency at all
      // -- the column lost its NOT NULL in the same migration, since a
      // DiscoveredAccount carries no currency.
      await client.query(
        "INSERT INTO accounts (id, institution_id, acct_last4, external_key) VALUES ('acct-3', 'inst-1', '0044', 'ext-1')",
      );
      // But the same institution cannot state the same external key twice.
      await assert.rejects(
        client.query(
          "INSERT INTO accounts (id, institution_id, acct_last4, external_key) VALUES ('acct-4', 'inst-1', '0045', 'ext-1')",
        ),
        /accounts_external_key_unique/,
      );
      // A different institution reusing the same opaque external key is
      // unrelated and not a collision.
      await client.query(
        "INSERT INTO institutions (id, name, slug) VALUES ('inst-2', 'Marrow Creek Trust', 'marrow-creek')",
      );
      await client.query(
        "INSERT INTO accounts (id, institution_id, acct_last4, external_key) VALUES ('acct-5', 'inst-2', '0046', 'ext-1')",
      );

      // The row is still there, unchanged, and the new columns are null: no
      // backfill, so a document imported before this migration honestly says
      // it names no retained bytes.
      const migrated = await client.query(
        `SELECT file_path, sha256, doc_date::text AS doc_date, retained_sha256,
                retained_byte_length, media_type, capture_id
         FROM documents WHERE id = 'doc-1'`,
      );
      assert.equal(migrated.rowCount, 1);
      assert.deepEqual(migrated.rows[0], {
        file_path: "/raw/doc-1",
        sha256: sha,
        doc_date: "2026-03-04",
        retained_sha256: null,
        retained_byte_length: null,
        media_type: null,
        capture_id: null,
      });

      // Three of the four is a provenance record that reads as complete and
      // resolves to nothing. The table refuses it.
      await assert.rejects(
        client.query(
          "UPDATE documents SET media_type = 'application/json' WHERE id = 'doc-1'",
        ),
        /documents_retained_provenance_complete/,
      );

      // All four together is what the write path produces, and BIGINT crosses
      // the driver boundary as text like every other exact number here.
      await client.query(
        `UPDATE documents
         SET retained_sha256 = $1, retained_byte_length = 2048,
             media_type = 'application/json', capture_id = 'cap-1'
         WHERE id = 'doc-1'`,
        [sha],
      );
      const filled = await client.query(
        "SELECT retained_byte_length::text AS n, media_type FROM documents WHERE id = 'doc-1'",
      );
      assert.equal(filled.rows[0].n, "2048");
      assert.equal(filled.rows[0].media_type, "application/json");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
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

// F1-36. review_items.source_document_id already carried a foreign key to
// documents(id) (the initial schema, inline REFERENCES), just with the
// default NO ACTION -- so deleting a document any review item still named
// blocked outright. The version-4 migration adds ON DELETE CASCADE; this
// proves that against a real archive rather than trusting the DDL to have
// parsed the way it reads.
// F1-49. positions, balances and liabilities had no row-level dedupe of
// their own; the version-5 migration gives each a nullable row_hash. Nullable
// is the point: Postgres never treats two NULLs as equal in a UNIQUE
// constraint, so existing rows (which this migration does not backfill --
// see scripts/backfillHoldingRowHash.mjs) coexist with each other, while two
// rows that do carry the same hash still collide.
test(
  "positions, balances and liabilities gain a nullable, uniquely-constrained row_hash (F1-49)",
  { skip },
  async () => {
    await withArchive(async (client) => {
      const account = await seedAccount(client);

      // Multiple NULLs coexist -- no backfill happened, and none is required
      // for the column to be usable going forward.
      await client.query(
        "INSERT INTO positions (id, account_id, as_of, currency) VALUES ('pos-null-1', $1, DATE '2026-03-04', 'USD')",
        [account],
      );
      await client.query(
        "INSERT INTO positions (id, account_id, as_of, currency) VALUES ('pos-null-2', $1, DATE '2026-03-04', 'USD')",
        [account],
      );
      await client.query(
        "INSERT INTO balances (id, account_id, as_of, currency) VALUES ('bal-null-1', $1, DATE '2026-03-04', 'USD')",
        [account],
      );
      await client.query(
        "INSERT INTO balances (id, account_id, as_of, currency) VALUES ('bal-null-2', $1, DATE '2026-03-04', 'USD')",
        [account],
      );
      await client.query(
        "INSERT INTO liabilities (id, kind, as_of, currency) VALUES ('liab-null-1', 'margin_loan', DATE '2026-03-04', 'USD')",
      );
      await client.query(
        "INSERT INTO liabilities (id, kind, as_of, currency) VALUES ('liab-null-2', 'margin_loan', DATE '2026-03-04', 'USD')",
      );

      // A real hash is unique per table.
      await client.query(
        "INSERT INTO positions (id, account_id, as_of, currency, row_hash) VALUES ('pos-hashed-1', $1, DATE '2026-03-04', 'USD', 'hash-pos-1')",
        [account],
      );
      await assert.rejects(
        client.query(
          "INSERT INTO positions (id, account_id, as_of, currency, row_hash) VALUES ('pos-hashed-2', $1, DATE '2026-03-05', 'USD', 'hash-pos-1')",
          [account],
        ),
        /positions_row_hash_unique/,
      );

      await client.query(
        "INSERT INTO balances (id, account_id, as_of, currency, row_hash) VALUES ('bal-hashed-1', $1, DATE '2026-03-04', 'USD', 'hash-bal-1')",
        [account],
      );
      await assert.rejects(
        client.query(
          "INSERT INTO balances (id, account_id, as_of, currency, row_hash) VALUES ('bal-hashed-2', $1, DATE '2026-03-05', 'USD', 'hash-bal-1')",
          [account],
        ),
        /balances_row_hash_unique/,
      );

      await client.query(
        "INSERT INTO liabilities (id, kind, as_of, currency, row_hash) VALUES ('liab-hashed-1', 'margin_loan', DATE '2026-03-04', 'USD', 'hash-liab-1')",
      );
      await assert.rejects(
        client.query(
          "INSERT INTO liabilities (id, kind, as_of, currency, row_hash) VALUES ('liab-hashed-2', 'margin_loan', DATE '2026-03-05', 'USD', 'hash-liab-1')",
        ),
        /liabilities_row_hash_unique/,
      );
    });
  },
);

test(
  "review_items.source_document_id cascades when its document is deleted (F1-36)",
  { skip },
  async () => {
    await withArchive(async (client) => {
      await client.query(
        "INSERT INTO institutions (id, name, slug) VALUES ('inst-1', 'Thistlebrook Trust', 'thistlebrook')",
      );
      await client.query(
        `INSERT INTO documents (id, institution_id, doc_type, doc_date, file_path, sha256)
         VALUES ('doc-1', 'inst-1', 'activity_pull', DATE '2026-03-04', '/raw/doc-1', $1)`,
        ["a".repeat(64)],
      );
      await client.query(
        `INSERT INTO review_items (id, kind, source_document_id, reason)
         VALUES ('review-1', 'unparseable_process_date', 'doc-1', 'not a valid date')`,
      );

      await client.query("DELETE FROM documents WHERE id = 'doc-1'");

      const remaining = await client.query(
        "SELECT count(*)::text AS n FROM review_items WHERE id = 'review-1'",
      );
      assert.equal(
        remaining.rows[0].n,
        "0",
        "the review item about the deleted document's content should not outlive it",
      );
    });
  },
);

// F1-65. review_items_dedupe_key (migration version 7) must not be the thing
// that discovers a live archive's existing duplicates: CREATE UNIQUE INDEX
// would fail mid-build, after whatever work Postgres already did scanning
// the table. The DO block ahead of it is supposed to catch that first, with
// a message that sends an operator to the collapse script instead.
test(
  "the review_items dedupe migration refuses with duplicates on file, and succeeds once they are collapsed",
  { skip },
  async () => {
    const schema = testSchemaName();
    const client = createArchiveClient(url, schema);
    await client.connect();
    try {
      // Every migration except the one under test (version 7): a live
      // archive the night before this ships, with a hosted reparse's worth
      // of duplicates already on file. Filtered by version rather than
      // "all but the last" -- later migrations (F1-58, F1-66) now follow it.
      const priorMigrations = PG_MIGRATIONS.filter((m) => m.version < 7);
      assert.equal(priorMigrations.length, 6);
      assert.ok(
        PG_MIGRATIONS[priorMigrations.length].name.startsWith(
          "review_items dedupe key",
        ),
        "the migration under test is still version 7",
      );
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(
        `CREATE TABLE ${schema}.schema_version (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
      for (const migration of priorMigrations) {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${schema}.schema_version (version, name) VALUES ($1, $2)`,
          [migration.version, migration.name],
        );
      }
      assert.equal(
        await pgSchemaVersion(client, schema),
        priorMigrations[priorMigrations.length - 1].version,
      );

      await client.query(
        "INSERT INTO institutions (id, name, slug) VALUES ('inst-1', 'Thistlebrook Trust', 'thistlebrook')",
      );
      await client.query(
        `INSERT INTO documents (id, institution_id, doc_type, doc_date, file_path, sha256)
         VALUES ('doc-1', 'inst-1', 'activity_pull', DATE '2026-03-04', '/raw/doc-1', $1)`,
        ["b".repeat(64)],
      );
      // Two rows, identical on the dedupe key: exactly what a reparse before
      // F1-65 produced.
      await client.query(
        `INSERT INTO review_items (id, kind, source_document_id, source_locator, raw_value, reason)
         VALUES
           ('review-dupe-1', 'weak_instrument_match', 'doc-1', 'row:1', 'ZZZ', 'first'),
           ('review-dupe-2', 'weak_instrument_match', 'doc-1', 'row:1', 'ZZZ', 'second')`,
      );

      await assert.rejects(
        applyPgSchema(client, schema),
        /collapseDuplicateReviewItems\.mjs/,
        "the migration should name the collapse script rather than fail on the index build itself",
      );
      // Refused, not partially applied: still at the prior version.
      assert.equal(
        await pgSchemaVersion(client, schema),
        priorMigrations[priorMigrations.length - 1].version,
      );

      // An operator running the collapse script (or, here, doing exactly
      // what it does) clears the duplicate before retrying.
      await client.query("DELETE FROM review_items WHERE id = 'review-dupe-2'");

      assert.equal(await applyPgSchema(client, schema), PG_SCHEMA_VERSION);
      const survivor = await client.query(
        "SELECT id FROM review_items ORDER BY id",
      );
      assert.deepEqual(
        survivor.rows.map((r) => r.id),
        ["review-dupe-1"],
      );

      // The index is real: a fresh attempt at the same key is refused too.
      await assert.rejects(
        client.query(
          `INSERT INTO review_items (id, kind, source_document_id, source_locator, raw_value, reason)
           VALUES ('review-dupe-3', 'weak_instrument_match', 'doc-1', 'row:1', 'ZZZ', 'third')`,
        ),
        /review_items_dedupe_key/,
      );

      // A null locator is still a candidate for this index once the document
      // is set: `AdapterReviewItem`-produced kinds always carry one, and
      // most of the owner's 84,266 weak_instrument_match duplicates were
      // exactly this shape. The expression coalesces it, so a second row
      // sharing kind, document and raw_value collides even with both
      // locators null.
      await client.query(
        `INSERT INTO review_items (id, kind, source_document_id, source_locator, raw_value, reason)
         VALUES ('review-null-1', 'weak_instrument_match', 'doc-1', NULL, 'ZZZ', 'null locator, first')`,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO review_items (id, kind, source_document_id, source_locator, raw_value, reason)
           VALUES ('review-null-2', 'weak_instrument_match', 'doc-1', NULL, 'ZZZ', 'null locator, second')`,
        ),
        /review_items_dedupe_key/,
        "a null locator does not exempt a document-scoped item from the index",
      );

      // Null document (with or without a null locator too): never a
      // candidate for this index, so never refused -- exactly like every
      // item written before PR137, and every pull-level item
      // adapterImport.ts's flushInstruments still writes with a null
      // document today.
      await client.query(
        `INSERT INTO review_items (id, kind, source_document_id, source_locator, raw_value, reason)
         VALUES
           ('review-nulldoc-1', 'weak_instrument_match', NULL, NULL, 'ZZZ', 'null document and locator, first'),
           ('review-nulldoc-2', 'weak_instrument_match', NULL, NULL, 'ZZZ', 'null document and locator, second')`,
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  },
);

// F1-58. review_items_weak_instrument_match_key (migration version 8) is
// additive to migration 7's dedupe key: this identity is
// (kind, institution_id, raw_value, matched_instrument_id), never the
// document, because a weak instrument match is a fact about the descriptor
// and what it matched, not about which statement happened to restate it.
// Unlike migration 7, this one applies cleanly on a fresh archive with no
// collapse required first: the four columns it adds start every existing
// row at NULL, and a NULL never conflicts with another NULL under a unique
// index.
test(
  "the weak instrument match unique index applies cleanly against existing rows, and enforces its own key going forward",
  { skip },
  async () => {
    await withArchive(async (client) => {
      await client.query(
        "INSERT INTO institutions (id, name, slug) VALUES ('inst-1', 'Thistlebrook Trust', 'thistlebrook')",
      );
      await client.query(
        `INSERT INTO documents (id, institution_id, doc_type, doc_date, file_path, sha256)
         VALUES ('doc-1', 'inst-1', 'activity_pull', DATE '2026-03-04', '/raw/doc-1', $1)`,
        ["d".repeat(64)],
      );
      // A second document, same institution: migration 7's dedupe key is
      // keyed on the document, so every row below that is meant to collide
      // only under the *new* index uses this one instead of doc-1, keeping
      // the two identities cleanly separated in this test.
      await client.query(
        `INSERT INTO documents (id, institution_id, doc_type, doc_date, file_path, sha256)
         VALUES ('doc-2', 'inst-1', 'activity_pull', DATE '2026-04-04', '/raw/doc-2', $1)`,
        ["e".repeat(64)],
      );
      await client.query(
        "INSERT INTO instruments (id, symbol) VALUES ('instr-1', 'ZEPHYR')",
      );

      // A row from before this migration: no institution_id or
      // matched_instrument_id at all. Nothing here should ever have been
      // refused by a guard that only ever finds NULLs to compare.
      await client.query(
        `INSERT INTO review_items (id, kind, source_document_id, raw_value, reason)
         VALUES ('legacy-1', 'weak_instrument_match', 'doc-1', 'ZZZ', 'pre-migration, no columns yet')`,
      );

      await client.query(
        `INSERT INTO review_items
           (id, kind, source_document_id, raw_value, reason, institution_id, matched_instrument_id, occurrence_count, last_seen_document_id)
         VALUES ('weak-1', 'weak_instrument_match', 'doc-1', 'ZEPHYR-descriptor', 'first sighting', 'inst-1', 'instr-1', 1, 'doc-1')`,
      );

      // Same (institution, descriptor, matched instrument), a different
      // document: refused by the new key even though migration 7's key
      // (scoped by document) would have allowed this row through.
      await assert.rejects(
        client.query(
          `INSERT INTO review_items
             (id, kind, source_document_id, raw_value, reason, institution_id, matched_instrument_id, occurrence_count, last_seen_document_id)
           VALUES ('weak-2', 'weak_instrument_match', 'doc-2', 'ZEPHYR-descriptor', 'second sighting', 'inst-1', 'instr-1', 1, 'doc-2')`,
        ),
        /review_items_instrument_match_key/,
      );

      // A different matched instrument: not a conflict, this is a distinct
      // descriptor/instrument pair even though the raw descriptor matches.
      await client.query(
        "INSERT INTO instruments (id, symbol) VALUES ('instr-2', 'ZEPHYR')",
      );
      await client.query(
        `INSERT INTO review_items
           (id, kind, source_document_id, raw_value, reason, institution_id, matched_instrument_id, occurrence_count, last_seen_document_id)
         VALUES ('weak-3', 'weak_instrument_match', 'doc-2', 'ZEPHYR-descriptor', 'matched a different row', 'inst-1', 'instr-2', 1, 'doc-2')`,
      );

      // A different kind entirely, sharing every other column: the index is
      // scoped to kind = 'weak_instrument_match' and does not apply.
      await client.query(
        `INSERT INTO review_items
           (id, kind, source_document_id, raw_value, reason, institution_id, matched_instrument_id, occurrence_count, last_seen_document_id)
         VALUES ('other-kind-1', 'undeclared_activity_type', 'doc-1', 'ZEPHYR-descriptor', 'unrelated kind', 'inst-1', 'instr-1', 1, 'doc-1')`,
      );
    });
  },
);
