// The reader role's privilege state, and the attack surface it has to refuse.
//
// The SQLite surface this replaces was probed with seventeen attacks and
// blocked all of them. Most of that syntax simply errors on Postgres, and
// confirming that a `PRAGMA` is a syntax error here proves nothing at all. So
// each *intent* is re-expressed as its Postgres equivalent below and run as
// the reader role against a real database. The mapping is stated in the test
// names, so a reviewer can check the old specification against this suite
// line by line:
//
//   | SQLite intent                  | Postgres equivalent tested here            |
//   | ------------------------------ | ------------------------------------------ |
//   | INSERT / UPDATE / DELETE       | the same three, refused by privilege        |
//   | DROP TABLE / ALTER TABLE       | the same two, refused as non-owner          |
//   | CREATE TABLE                   | in the archive schema, in public, and TEMP  |
//   | REPLACE (upsert)               | INSERT ... ON CONFLICT DO UPDATE            |
//   | TRUNCATE                       | TRUNCATE                                    |
//   | ATTACH / DETACH DATABASE       | dblink and postgres_fdw, CREATE SERVER      |
//   | PRAGMA journal_mode = ...      | ALTER SYSTEM, ALTER DATABASE, replica role  |
//   | PRAGMA foreign_keys = OFF      | session_replication_role = replica          |
//   | PRAGMA table_info(...)         | reading another schema and pg_authid        |
//   | readfile()                     | pg_read_file, pg_ls_dir, COPY ... FROM      |
//   | writefile()                    | COPY ... TO file, COPY ... TO PROGRAM, lo_* |
//   | load_extension()               | CREATE EXTENSION                            |
//   | second statement after `;`     | multi-statement simple query                |
//   | second statement in a comment  | the same, with the write behind a comment   |
//   | write hidden inside a WITH     | a data-modifying CTE                        |
//
// Everything here asserts refusal against a real server. Nothing reads a row
// of data: the assertions are on errors and on counts.

import assert from "node:assert/strict";
import test from "node:test";

import {
  adminFor,
  count,
  nonSuperuserArchive,
  one,
  reader,
  refused,
  skip,
} from "./helpers/pgArchive.mjs";
import {
  applyPgReaderRole,
  createArchiveClient,
  READER_CONNECTION_LIMIT,
  readerRoleName,
} from "../dist/index.js";

const INSTITUTION = { id: "inst_river_oak", name: "River Oak Trust", slug: "river-oak" };
const ACCOUNT = { id: "acct_operating", last4: "1200", currency: "USD" };

/** A small synthetic archive, written by the owner, for the reader to fail on. */
async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug],
  );
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, base_currency)
     VALUES ($1, $2, $3, $4)`,
    [ACCOUNT.id, INSTITUTION.id, ACCOUNT.last4, ACCOUNT.currency],
  );
  await client.query(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, description, amount, currency, row_hash, imported_at)
     VALUES ('txn_1', $1, DATE '2026-01-15', 'fee', 'Synthetic fee', '-12.34', 'USD', 'hash_1', now())`,
    [ACCOUNT.id],
  );
}

/**
 * Every attack below runs against a reader the *hosted* owner could actually
 * have created: a role with CREATEROLE and CREATEDB and no superuser bit. A
 * superuser owner would have hidden F1-30, where `ALTER ROLE ... NOSUPERUSER
 * NOBYPASSRLS` was refused with 42501 and no reader existed at all.
 */
async function fixture(t, options = {}) {
  const owner = await nonSuperuserArchive(t);
  await seed(owner);
  const readerHandle = await reader(t, owner, options);
  return { owner, reader: readerHandle };
}

/**
 * Asserts a write is refused twice over, which is what "more than one
 * control" has to mean to be worth claiming.
 *
 * The role carries `default_transaction_read_only = on`, so a write fails
 * with `read_only_sql_transaction` before privileges are ever consulted. That
 * setting is one the role can turn off, so testing only that would test the
 * softest layer and call it a boundary. Each attempt is therefore run again
 * with the setting off, where the refusal must come from
 * `insufficient_privilege` -- the layer the reader cannot reach.
 */
async function refusedTwice(r, sql) {
  const readOnly = await refused(r.client, sql);
  assert.ok(readOnly, sql);
  assert.equal(readOnly.code, "25006", `${sql} must be read_only_sql_transaction`);
  await r.client.query("SET default_transaction_read_only = off");
  try {
    const privilege = await refused(r.client, sql);
    assert.ok(privilege, sql);
    assert.equal(
      privilege.code,
      "42501",
      `${sql} must still be insufficient_privilege with the read-only default off`,
    );
  } finally {
    await r.client.query("RESET default_transaction_read_only");
  }
}

test("the reader role is a non-owner that owns nothing", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  const role = readerRoleName(r.summary.schema);
  assert.equal(r.summary.role, role);

  const owned = await one(
    owner,
    `SELECT count(*)::text AS n
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles o ON o.oid = c.relowner
      WHERE n.nspname = $1 AND o.rolname = $2`,
    [r.summary.schema, role],
  );
  assert.equal(owned.n, "0", "the reader must own no relation it can read");

  const attributes = await one(
    owner,
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls,
            rolreplication, rolconnlimit::text AS rolconnlimit
       FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  assert.equal(attributes.rolsuper, false);
  assert.equal(attributes.rolcreatedb, false);
  assert.equal(attributes.rolcreaterole, false);
  assert.equal(attributes.rolbypassrls, false);
  assert.equal(attributes.rolreplication, false);
  assert.equal(
    attributes.rolinherit,
    false,
    "NOINHERIT, so a membership added later grants nothing implicitly",
  );
  assert.equal(Number(attributes.rolconnlimit), READER_CONNECTION_LIMIT);

  const memberships = await one(
    owner,
    `SELECT count(*)::text AS n FROM pg_auth_members m
       JOIN pg_roles member ON member.oid = m.member WHERE member.rolname = $1`,
    [role],
  );
  assert.equal(memberships.n, "0", "a reader inherits nothing through membership");
});

test("PUBLIC's default database and schema grants are revoked", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  const role = r.summary.role;

  // CONNECT and TEMPORARY are granted to PUBLIC by default. CONNECT is
  // granted back to the reader; TEMPORARY deliberately is not.
  const database = await one(
    owner,
    `SELECT has_database_privilege('public', current_database(), 'CONNECT') AS public_connect,
            has_database_privilege('public', current_database(), 'TEMPORARY') AS public_temp,
            has_database_privilege($1, current_database(), 'CONNECT') AS reader_connect,
            has_database_privilege($1, current_database(), 'TEMPORARY') AS reader_temp`,
    [role],
  );
  assert.equal(database.public_connect, false);
  assert.equal(database.public_temp, false);
  assert.equal(database.reader_connect, true);
  assert.equal(database.reader_temp, false, "a temp table is a write inside the server");

  const schemas = await one(
    owner,
    `SELECT has_schema_privilege('public', 'public', 'USAGE') AS public_public_usage,
            has_schema_privilege($1, 'public', 'USAGE') AS reader_public_usage,
            has_schema_privilege($1, $2, 'USAGE') AS reader_archive_usage,
            has_schema_privilege($1, $2, 'CREATE') AS reader_archive_create,
            has_schema_privilege('public', $2, 'USAGE') AS public_archive_usage`,
    [role, r.summary.schema],
  );
  assert.equal(schemas.public_public_usage, false);
  assert.equal(schemas.reader_public_usage, false);
  assert.equal(schemas.public_archive_usage, false);
  assert.equal(schemas.reader_archive_usage, true);
  assert.equal(schemas.reader_archive_create, false, "USAGE, never CREATE");

  const tables = await one(
    owner,
    `SELECT has_table_privilege($1, $2 || '.transactions', 'SELECT') AS s,
            has_table_privilege($1, $2 || '.transactions', 'INSERT') AS i,
            has_table_privilege($1, $2 || '.transactions', 'UPDATE') AS u,
            has_table_privilege($1, $2 || '.transactions', 'DELETE') AS d,
            has_table_privilege($1, $2 || '.transactions', 'TRUNCATE') AS t,
            has_table_privilege($1, $2 || '.transactions', 'REFERENCES') AS r,
            has_table_privilege($1, $2 || '.transactions', 'TRIGGER') AS g`,
    [role, r.summary.schema],
  );
  assert.deepEqual(
    { ...tables },
    { s: true, i: false, u: false, d: false, t: false, r: false, g: false },
  );
});

test("a table a later migration adds is not silently readable", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  // Exactly what a later migration does: the owner creates a table after the
  // reader role was set up. Default privileges must leave it unreadable until
  // someone deliberately re-runs the role setup.
  await owner.query(`CREATE TABLE ${r.summary.schema}.later_migration (id TEXT)`);
  const granted = await one(
    owner,
    `SELECT has_table_privilege($1, $2 || '.later_migration', 'SELECT') AS s,
            has_table_privilege('public', $2 || '.later_migration', 'SELECT') AS p`,
    [r.summary.role, r.summary.schema],
  );
  assert.equal(granted.s, false, "no default SELECT: exposure is a deliberate act");
  assert.equal(granted.p, false, "and PUBLIC gets nothing either");
  assert.ok(await refused(r.client, "SELECT * FROM later_migration"));

  // The other half of the same policy, named rather than implied: a table the
  // read surface genuinely needs is exposed by the setup having run over it.
  // F1-66's `retained_texts` holds the retained text `get_evidence` reslices a
  // `retained_text_span_v1` quote out of (mcp/pgRead.ts), so a reader that
  // could not select it would answer `retained_evidence_unavailable` for every
  // PDF-tier citation -- which is the defect that table exists to fix.
  const retainedTexts = await one(
    owner,
    `SELECT has_table_privilege($1, $2 || '.retained_texts', 'SELECT') AS s,
            has_table_privilege($1, $2 || '.retained_texts', 'INSERT') AS i,
            has_table_privilege('public', $2 || '.retained_texts', 'SELECT') AS p`,
    [r.summary.role, r.summary.schema],
  );
  assert.equal(retainedTexts.s, true, "the read surface's own table is readable");
  assert.equal(retainedTexts.i, false, "read, and only read");
  assert.equal(retainedTexts.p, false, "and PUBLIC still gets nothing");
  assert.equal(await count(r.client, "retained_texts"), 0);
});

test("a function a later migration adds needs the setup re-run to be locked down", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  // EXECUTE on a function is granted to PUBLIC by default, which is the trap
  // a table-level grant review never notices.
  //
  // This one is a measured limitation rather than a guarantee, and it is
  // asserted in both directions so it cannot rot into a false claim. Postgres
  // merges a default-privilege entry with the built-in default rather than
  // replacing it, so `ALTER DEFAULT PRIVILEGES ... REVOKE ... ON FUNCTIONS
  // FROM PUBLIC` does not remove PUBLIC's EXECUTE from an object created
  // later. The concrete revoke on a re-run is what does, which is why
  // re-running the setup after a migration is documented rather than
  // optional.
  await owner.query(
    `CREATE FUNCTION ${r.summary.schema}.later_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
  );
  const before = await one(
    owner,
    "SELECT has_function_privilege('public', $1 || '.later_fn()', 'EXECUTE') AS p",
    [r.summary.schema],
  );
  assert.equal(
    before.p,
    true,
    "default privileges do not remove PUBLIC's built-in EXECUTE; see pgReaderRole.ts",
  );

  await applyPgReaderRole(owner, { password: r.password });
  const after = await one(
    owner,
    `SELECT has_function_privilege('public', $1 || '.later_fn()', 'EXECUTE') AS p,
            has_function_privilege($2, $1 || '.later_fn()', 'EXECUTE') AS s`,
    [r.summary.schema, r.summary.role],
  );
  assert.equal(after.p, false, "re-running the setup revokes it concretely");
  assert.equal(after.s, false);
  assert.ok(await refused(r.client, "SELECT later_fn()"));
});

test("a plain read as the reader still works", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const row = await one(r.client, "SELECT count(*)::text AS n FROM transactions");
  assert.equal(row.n, "1");
});

test("INSERT, UPDATE and DELETE are refused", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  const writes = [
    `INSERT INTO transactions (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at)
     VALUES ('evil', 'acct_operating', DATE '2026-01-01', 'fee', '-1', 'USD', 'evil', now())`,
    "UPDATE transactions SET amount = '0'",
    "DELETE FROM transactions",
  ];
  for (const sql of writes) await refusedTwice(r, sql);
  assert.equal(await count(owner, "transactions"), 1);
});

test("DDL against what it reads is refused", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  const ddl = [
    "DROP TABLE transactions",
    "ALTER TABLE transactions ADD COLUMN evil TEXT",
    "ALTER TABLE transactions DROP CONSTRAINT transactions_pkey",
    "CREATE INDEX evil ON transactions (id)",
    "COMMENT ON TABLE transactions IS 'evil'",
  ];
  for (const sql of ddl) {
    assert.ok(await refused(r.client, sql), sql);
  }
  assert.equal(await count(owner, "transactions"), 1);
});

test("creating a table anywhere it could reach is refused", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const attempts = [
    "CREATE TABLE evil (id TEXT)",
    `CREATE TABLE ${r.summary.schema}.evil (id TEXT)`,
    "CREATE TABLE public.evil (id TEXT)",
    // The TEMPORARY privilege was revoked from PUBLIC and never granted back:
    // a reader that can stage rows inside the server has a write, even if it
    // never touches an archive table.
    "CREATE TEMP TABLE evil (id TEXT)",
    "CREATE SCHEMA evil",
    "SELECT 1 INTO TEMP evil",
  ];
  for (const sql of attempts) {
    assert.ok(await refused(r.client, sql), sql);
  }
});

test("an upsert, the REPLACE analogue, is refused", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  await refusedTwice(
    r,
    `INSERT INTO transactions (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at)
     VALUES ('txn_1', 'acct_operating', DATE '2026-01-15', 'fee', '0', 'USD', 'hash_1', now())
     ON CONFLICT (id) DO UPDATE SET amount = '0'`,
  );
  const row = await one(owner, "SELECT amount FROM transactions WHERE id = 'txn_1'");
  assert.equal(row.amount, "-12.34", "and the row is untouched");
});

test("TRUNCATE is refused", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  assert.ok(await refused(r.client, "TRUNCATE TABLE transactions"));
  assert.equal(await count(owner, "transactions"), 1);
});

test("reaching another database, the ATTACH analogue, is refused", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const attempts = [
    "CREATE EXTENSION IF NOT EXISTS dblink",
    "CREATE EXTENSION IF NOT EXISTS postgres_fdw",
    "CREATE SERVER evil FOREIGN DATA WRAPPER postgres_fdw OPTIONS (dbname 'postgres')",
    "SELECT dblink_connect('evil', 'dbname=postgres')",
  ];
  for (const sql of attempts) {
    assert.ok(await refused(r.client, sql), sql);
  }
});

test("loading an extension, the load_extension analogue, is refused", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  for (const sql of [
    "CREATE EXTENSION IF NOT EXISTS plpgsql",
    "CREATE EXTENSION IF NOT EXISTS file_fdw",
    "LOAD 'plpgsql'",
  ]) {
    assert.ok(await refused(r.client, sql), sql);
  }
});

test("changing server or database settings, the mutating-PRAGMA analogue, is refused", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const attempts = [
    "ALTER SYSTEM SET statement_timeout = '1h'",
    // The database name comes from the setup summary, never hardcoded: a
    // literal here would name whatever database the author happened to use.
    `ALTER DATABASE "${r.summary.database}" SET statement_timeout = '1h'`,
    // The foreign_keys = OFF analogue: replica mode suppresses triggers and
    // foreign key enforcement server-side. Superuser only.
    "SET session_replication_role = 'replica'",
    // Raising its own connection limit is the escalation that would make the
    // concurrency control as soft as the timeout. It needs CREATEROLE.
    `ALTER ROLE ${r.summary.role} WITH CONNECTION LIMIT 100`,
    `ALTER ROLE ${r.summary.role} WITH SUPERUSER`,
    `ALTER ROLE ${r.summary.role} WITH BYPASSRLS`,
  ];
  for (const sql of attempts) {
    assert.ok(await refused(r.client, sql), sql);
  }
});

test("reading beyond what it needs, the reading-PRAGMA analogue, is refused", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  // A second archive in the same database is the neighbouring component the
  // plan's named-schema rule exists for. The reader of one must not read it.
  const neighbour = `${r.summary.schema}_neighbour`;
  await owner.query(`CREATE SCHEMA ${neighbour}`);
  await owner.query(`CREATE TABLE ${neighbour}.balances (id TEXT)`);

  const attempts = [
    `SELECT * FROM ${neighbour}.balances`,
    "SELECT * FROM public.pg_stat_statements",
    // Password hashes. Restricted to superusers, unlike most of pg_catalog.
    "SELECT rolpassword FROM pg_authid",
    "SELECT passwd FROM pg_shadow",
  ];
  for (const sql of attempts) {
    assert.ok(await refused(r.client, sql), sql);
  }

  // pg_catalog itself is readable by PUBLIC and revoking it would break the
  // driver, so the boundary that matters is what a non-superuser is shown
  // *inside* it. Another session's SQL text is redacted rather than returned,
  // which is the reading-PRAGMA intent: no introspection beyond what the read
  // surface needs.
  const activity = await r.client.query(
    "SELECT query FROM pg_stat_activity WHERE pid <> pg_backend_pid()",
  );
  for (const row of activity.rows) {
    assert.equal(
      row.query,
      "<insufficient privilege>",
      "another session's SQL must never be visible to the reader",
    );
  }
  await owner.query(`DROP SCHEMA IF EXISTS ${neighbour} CASCADE`);
});

test("reading a server file, the readfile analogue, is refused", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const attempts = [
    "SELECT pg_read_file('/etc/hosts')",
    "SELECT pg_read_binary_file('/etc/hosts')",
    "SELECT pg_ls_dir('/')",
    "SELECT pg_stat_file('/etc/hosts')",
    "COPY transactions FROM '/etc/hosts'",
    "SELECT lo_import('/etc/hosts')",
  ];
  for (const sql of attempts) {
    assert.ok(await refused(r.client, sql), sql);
  }
});

test("writing a server file, the writefile analogue, is refused", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const attempts = [
    "COPY transactions TO '/tmp/kith-evil'",
    "COPY (SELECT 1) TO '/tmp/kith-evil'",
    "COPY (SELECT 1) TO PROGRAM 'cat > /tmp/kith-evil'",
    "SELECT lo_export(1, '/tmp/kith-evil')",
    // Large objects are a write path that touches no table the grant review
    // would ever look at.
    "SELECT lo_create(0)",
    "SELECT lo_from_bytea(0, '\\x00'::bytea)",
  ];
  for (const sql of attempts) {
    assert.ok(await refused(r.client, sql), sql);
  }
});

test("a second statement after a semicolon cannot write", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  // node-postgres sends a parameterless query over the simple query protocol,
  // where Postgres really does execute every statement in the string. So this
  // is not "the parser rejects it" -- the second statement is submitted and
  // the *privilege* is what stops it. That is the stronger property.
  await refusedTwice(r, "SELECT 1; DELETE FROM transactions");
  assert.equal(await count(owner, "transactions"), 1);
});

test("a second statement smuggled behind a comment cannot write", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  const attempts = [
    "SELECT 1; /* harmless */ DELETE FROM transactions",
    "SELECT 1 -- trailing\n; DROP TABLE transactions",
  ];
  for (const sql of attempts) {
    assert.ok(await refused(r.client, sql), sql);
  }
  assert.equal(await count(owner, "transactions"), 1);
});

test("a write hidden inside a WITH is refused", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  const attempts = [
    "WITH doomed AS (DELETE FROM transactions RETURNING id) SELECT * FROM doomed",
    "WITH changed AS (UPDATE transactions SET amount = '0' RETURNING id) SELECT * FROM changed",
    `WITH added AS (
       INSERT INTO transactions (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at)
       VALUES ('evil', 'acct_operating', DATE '2026-01-01', 'fee', '-1', 'USD', 'evil', now())
       RETURNING id)
     SELECT * FROM added`,
  ];
  for (const sql of attempts) await refusedTwice(r, sql);
  assert.equal(await count(owner, "transactions"), 1);
});

test("escalating to another role is refused", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  const ownerName = (await one(owner, "SELECT current_user AS name")).name;
  for (const sql of [
    `SET ROLE ${ownerName}`,
    `SET SESSION AUTHORIZATION ${ownerName}`,
    "SET ROLE pg_read_all_data",
    `GRANT pg_read_server_files TO ${r.summary.role}`,
    `GRANT INSERT ON transactions TO ${r.summary.role}`,
  ]) {
    assert.ok(await refused(r.client, sql), sql);
  }
});

test("the role's own statement_timeout is not the boundary", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  // The role setting is a default the role can raise, which is exactly why it
  // is not relied on alone. Raising it changes nothing that matters.
  await r.client.query("SET statement_timeout = 0");
  await r.client.query("RESET statement_timeout");
  await r.client.query("SET default_transaction_read_only = off");
  const error = await refused(r.client, "DELETE FROM transactions");
  assert.ok(error);
  assert.equal(error.code, "42501");
  assert.equal(await count(owner, "transactions"), 1);
});

test("a READ ONLY transaction refuses a write even where privilege would allow it", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  // The counterfactual the layering claims: grant the reader INSERT, so
  // privilege alone would let the write through, and show the transaction
  // mode still stops it. Without this the "more than one control" claim is
  // untested.
  await owner.query(
    `GRANT INSERT ON ${r.summary.schema}.transactions TO ${r.summary.role}`,
  );
  await r.client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const error = await refused(
    r.client,
    `INSERT INTO transactions (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at)
     VALUES ('evil', 'acct_operating', DATE '2026-01-01', 'fee', '-1', 'USD', 'evil', now())`,
  );
  await r.client.query("ROLLBACK");
  assert.ok(error);
  assert.equal(error.code, "25006", "read_only_sql_transaction");
  assert.equal(await count(owner, "transactions"), 1);
});

test("concurrency is bounded at connection time, not by a setting", { skip }, async (t) => {
  const owner = await nonSuperuserArchive(t);
  await seed(owner);
  const r = await reader(t, owner, { connectionLimit: 1 });
  // The first connection is already open. A second one is refused by the
  // server before any statement runs, and nothing the role can SET changes it.
  const second = createArchiveClient(r.url, r.summary.schema);
  let error = null;
  try {
    await second.connect();
    await second.end();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "a second concurrent reader connection must be refused");
  assert.equal(error.code, "53300", "too_many_connections");
});

test("the whole setup runs as a non-superuser owner (F1-30)", { skip }, async (t) => {
  const { owner, reader: r } = await fixture(t);
  const actor = await one(
    owner,
    `SELECT rolsuper, rolcreaterole, rolcreatedb
       FROM pg_roles WHERE rolname = current_user`,
  );
  assert.equal(actor.rolsuper, false, "the hosted archive owner is not a superuser");
  assert.equal(actor.rolcreaterole, true);
  assert.equal(actor.rolcreatedb, true);

  // The re-run path, which is the documented step after a migration. It has
  // to verify the superuser-gated attributes rather than re-assert them:
  // Postgres refuses to let this role so much as *name* SUPERUSER, BYPASSRLS
  // or REPLICATION in an ALTER ROLE, even to set the value the role already
  // has. That refusal is asserted directly below, so a statement quietly
  // reintroduced into the setup fails this test rather than production.
  await applyPgReaderRole(owner, { password: r.password });
  const attributes = await one(
    owner,
    `SELECT rolsuper, rolbypassrls, rolreplication
       FROM pg_roles WHERE rolname = $1`,
    [r.summary.role],
  );
  assert.deepEqual(
    { ...attributes },
    { rolsuper: false, rolbypassrls: false, rolreplication: false },
  );
  for (const attribute of ["NOSUPERUSER", "NOBYPASSRLS", "NOREPLICATION"]) {
    const error = await refused(
      owner,
      `ALTER ROLE ${r.summary.role} WITH ${attribute}`,
    );
    assert.ok(error, attribute);
    assert.equal(
      error.code,
      "42501",
      `${attribute} in ALTER ROLE is superuser-only even when it changes nothing`,
    );
  }
});

test("a pre-existing role that bypasses row security is refused, not adopted", { skip }, async (t) => {
  const owner = await nonSuperuserArchive(t);
  const admin = await adminFor(t, owner);
  const schema = (await one(owner, "SELECT current_schema() AS name")).name;
  const role = readerRoleName(schema);
  const password = "f1_30_throwaway_password";

  // The verification's whole point: a role that already exists outside this
  // path may hold an attribute a non-superuser owner cannot remove. Adopting
  // it would hand back a "reader" that reads past every row security policy.
  await admin.query(`CREATE ROLE ${role} WITH LOGIN BYPASSRLS PASSWORD '${password}'`);
  try {
    const error = await applyPgReaderRole(owner, { password }).then(
      () => null,
      (caught) => caught,
    );
    assert.ok(error, "an existing BYPASSRLS role must not be accepted as a reader");
    assert.match(error.message, /BYPASSRLS/);
    const still = await one(
      owner,
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = $1",
      [role],
    );
    assert.equal(still.rolbypassrls, true, "and nothing silently claimed otherwise");
  } finally {
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
  }
});
