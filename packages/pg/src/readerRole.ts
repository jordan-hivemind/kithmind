// The reader role a schema's read surface connects as (F1-21).
//
// Written for the finance archive and extracted into `@repo/pg` unchanged
// (P2-39a): it was already per-schema and already derived the role name from
// the schema, so `kith_reader` costs one call rather than a second copy of the
// privilege state below. The two callers differ in exactly two arguments, the
// schema name and which domains the reader needs USAGE on.
//
// The surface this replaces was a local SQLite file with five in-process
// enforcement layers. That worked because the attacker and the enforcement
// lived in the same process. This one is reachable over a network, so the
// protection moves into the database, and "a role with SELECT" is not a
// description of a privilege state.
//
// Postgres grants more than table privileges without being asked:
//
//   - CONNECT and TEMPORARY on a database are granted to PUBLIC.
//   - EXECUTE on a function and USAGE on a type are granted to PUBLIC.
//   - USAGE on schema `public` is granted to PUBLIC.
//   - Privileges reach a role through role membership, not only through a
//     direct grant.
//   - Default privileges decide what a table created by a *later* migration
//     is born with.
//
// A grant of SELECT on today's tables establishes none of that, so every one
// of those is revoked deliberately below and granted back only where needed.
// This file is the whole path: it is code that is run and tested, not a
// paragraph of instructions someone follows by hand once and cannot re-run.
// It is idempotent, so it is also the documented step after any migration
// that adds a table -- see NO_DEFAULT_SELECT below for why that step exists
// rather than being automatic.
//
// This is schema-adjacent and deliberately separable: it creates no table and
// alters none, it only decides who may read the ones a migration created.

import type pg from "pg";

import { pinnedSchemaOf } from "./transaction.js";

/**
 * Wall clock a single reader statement may take. A role-level setting, which
 * means the role can raise it with its own `SET`. That is precisely why it is
 * not the only control: `READER_CONNECTION_LIMIT` is enforced at connection
 * time and cannot be changed from inside a session, every statement the read
 * surface issues carries its own `LIMIT`, and the surface accepts typed
 * operations rather than SQL, so there is no caller-supplied statement for a
 * raised timeout to run.
 */
export const READER_STATEMENT_TIMEOUT_MS = 5_000;

/** How long a reader may hold an idle transaction open before it is killed. */
export const READER_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;

/** How long a reader waits on a lock before giving up rather than queueing. */
export const READER_LOCK_TIMEOUT_MS = 2_000;

/**
 * Concurrent connections the reader role may hold. Enforced by the server at
 * connection time and not settable from inside a session, which is what makes
 * it the concurrency control the statement timeout cannot be.
 */
export const READER_CONNECTION_LIMIT = 4;

/**
 * Deliberately absent: `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES
 * TO <reader>`.
 *
 * Granting it would mean a table added by a later migration is readable by
 * the reader the moment it exists, which is exactly the "silently readable
 * beyond intent" this task forbids. Default privileges here only *revoke*
 * what PUBLIC would otherwise be born with. Exposing a new table is a
 * deliberate act: re-run `applyReaderRole`, which grants SELECT on the
 * tables that exist at that moment.
 */
const NO_DEFAULT_SELECT = true;

/** Matches `transaction.ts`'s schema rule; a role name is interpolated into DDL. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The key two concurrent setups contend on. Distinct from the schema creation
 * and archive write locks, which are different exclusions.
 *
 * This is not only a test convenience. Several of the statements below update
 * catalog rows that are shared across the whole database -- `pg_database` for
 * the `CONNECT` revoke, `pg_namespace` for schema `public` -- so two setups
 * running at once (two archives in one database, or a retry racing a first
 * attempt) fail with `tuple concurrently updated` rather than converging.
 * Keyed on the database rather than the schema for exactly that reason.
 *
 * Exported because anything that *removes* a reader role touches the same
 * shared rows and has to contend on the same key.
 */
export const READER_ROLE_LOCK_KEY = 411_920_503;

export type ReaderRoleOptions = {
  /** The schema the reader may read. Defaults to the client's pin. */
  schema?: string;
  /** The reader's password. Never defaulted and never committed. */
  password: string;
  /**
   * Domains in that schema the reader needs USAGE on, because a column is
   * declared over them. USAGE on a type is granted to PUBLIC by default, so
   * each one named here is revoked from PUBLIC first and granted back to the
   * reader alone; a domain left out of this list stays revoked from PUBLIC,
   * which is the same deliberate-exposure rule NO_DEFAULT_SELECT states for
   * tables. Empty by default: a schema with no domains needs none.
   */
  domains?: readonly string[];
  connectionLimit?: number;
  statementTimeoutMs?: number;
};

export type ReaderRoleSummary = {
  role: string;
  schema: string;
  database: string;
  connectionLimit: number;
  statementTimeoutMs: number;
};

/**
 * The reader role for one schema. Derived rather than configured, so two
 * schemas in one database get two readers and neither can read the other, and
 * so nothing has to remember a name. `finance` yields `finance_reader` and
 * `kith` yields `kith_reader`.
 */
export function readerRoleName(schema: string): string {
  const name = `${schema}_reader`;
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a usable reader role name; ` +
        "the schema name must leave room for the _reader suffix within 63 characters",
    );
  }
  return name;
}

/**
 * Creates or updates the reader role and puts the database into the exact
 * privilege state described at the top of this file. Idempotent, so it is
 * safe to re-run, and re-running is the documented way to expose a table a
 * later migration added.
 *
 * Runs as the schema owner (or a superuser): it needs CREATE ROLE and the
 * ability to revoke PUBLIC's grants on the database.
 */
export async function applyReaderRole(
  client: pg.ClientBase,
  options: ReaderRoleOptions,
): Promise<ReaderRoleSummary> {
  const schema = options.schema ?? pinnedSchemaOf(client);
  if (schema === undefined || !IDENTIFIER.test(schema)) {
    throw new Error(`${JSON.stringify(schema)} is not a usable schema name`);
  }
  const role = readerRoleName(schema);
  const domains = options.domains ?? [];
  for (const domain of domains) {
    if (!IDENTIFIER.test(domain)) {
      throw new Error(`${JSON.stringify(domain)} is not a usable domain name`);
    }
  }
  const connectionLimit = options.connectionLimit ?? READER_CONNECTION_LIMIT;
  const statementTimeoutMs =
    options.statementTimeoutMs ?? READER_STATEMENT_TIMEOUT_MS;
  if (typeof options.password !== "string" || options.password.length < 16) {
    throw new Error(
      "the reader role needs a password of at least 16 characters, supplied by the " +
        "caller; this package never generates or defaults one and none is ever committed",
    );
  }

  // The password is quoted by the server itself rather than by a regex here.
  // Everything else interpolated below is a validated identifier.
  const quoted = await client.query<{ password: string; database: string }>(
    "SELECT quote_literal($1::text) AS password, current_database() AS database",
    [options.password],
  );
  const password = quoted.rows[0]!.password;
  const database = quoted.rows[0]!.database;
  const quotedDatabase = (
    await client.query<{ name: string }>(
      "SELECT quote_ident(current_database()) AS name",
    )
  ).rows[0]!.name;

  // One transaction, so the privilege state applies whole or not at all, and
  // one advisory lock, so a second setup waits rather than colliding on a
  // shared catalog row. Postgres runs CREATE ROLE, GRANT, REVOKE and ALTER
  // DEFAULT PRIVILEGES transactionally, so this really is atomic.
  await client.query("BEGIN");
  try {
    await applyPrivileges(client, {
      role,
      schema,
      password,
      quotedDatabase,
      connectionLimit,
      statementTimeoutMs,
      domains,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return { role, schema, database, connectionLimit, statementTimeoutMs };
}

async function applyPrivileges(
  client: pg.ClientBase,
  {
    role,
    schema,
    password,
    quotedDatabase,
    connectionLimit,
    statementTimeoutMs,
    domains,
  }: {
    role: string;
    schema: string;
    password: string;
    quotedDatabase: string;
    connectionLimit: number;
    statementTimeoutMs: number;
    domains: readonly string[];
  },
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [
    READER_ROLE_LOCK_KEY,
  ]);

  const exists = await client.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
    [role],
  );
  // SUPERUSER, BYPASSRLS and REPLICATION are stated once, here. Postgres lets
  // a non-superuser CREATE ROLE *mention* them -- only setting them true is
  // gated -- but ALTER ROLE refuses the mention itself unless the actor is a
  // superuser, even when it names the value the role already has. The hosted
  // archive owner has CREATEROLE and CREATEDB and is not a superuser, so an
  // ALTER that re-asserted them failed with 42501 and the reader was never
  // created. The re-run path verifies them instead (verifyAttributes).
  //
  // NOINHERIT so a membership someone adds later does not silently hand the
  // reader another role's privileges. The membership assertion below closes
  // the SET ROLE half, which NOINHERIT does not.
  if (!exists.rows[0]!.present) {
    await client.query(
      `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
         NOINHERIT NOREPLICATION NOBYPASSRLS
         CONNECTION LIMIT ${connectionLimit} PASSWORD ${password}`,
    );
  } else {
    // Verify the superuser-gated boundary *before* touching the role. On
    // Postgres 16 and later a CREATEROLE owner may only ALTER roles it
    // administers, so a pre-existing privileged role would otherwise fail
    // with "permission denied to alter role" and the boundary refusal
    // below would never be reached.
    await verifyAttributes(client, role);
    // Only the attributes a non-superuser owner may legitimately alter.
    await client.query(
      `ALTER ROLE ${role} WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT
         CONNECTION LIMIT ${connectionLimit} PASSWORD ${password}`,
    );
  }

  // The boundary is asserted rather than assumed, on both paths: a role that
  // already existed with SUPERUSER or BYPASSRLS cannot be demoted from here,
  // so it is refused loudly instead of being reported as a reader.
  await verifyAttributes(client, role);

  // Role-level defaults. Each is a floor rather than a boundary -- the role
  // can raise any of them with its own SET -- which is why the surface does
  // not depend on them alone. See READER_STATEMENT_TIMEOUT_MS.
  await client.query(
    `ALTER ROLE ${role} SET statement_timeout = '${statementTimeoutMs}ms'`,
  );
  await client.query(
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '${READER_IDLE_TRANSACTION_TIMEOUT_MS}ms'`,
  );
  await client.query(
    `ALTER ROLE ${role} SET lock_timeout = '${READER_LOCK_TIMEOUT_MS}ms'`,
  );
  await client.query(
    `ALTER ROLE ${role} SET default_transaction_read_only = on`,
  );
  await client.query(`ALTER ROLE ${role} SET search_path = ${schema}`);

  // Database: PUBLIC's CONNECT *and* TEMPORARY both go. TEMPORARY is not
  // granted back -- a reader that can create a temporary table can stage
  // data inside the server, which is a write even though it touches no
  // archive table.
  await client.query(`REVOKE ALL ON DATABASE ${quotedDatabase} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${quotedDatabase} TO ${role}`);

  // Schema `public`: USAGE is granted to PUBLIC by default, and a privilege
  // held via PUBLIC cannot be revoked from one role, so keeping the reader
  // out of `public` means PUBLIC's own grant has to go. This is a
  // database-wide change and it is deliberate: a co-located component gets an
  // explicit grant rather than inheriting one. The owner keeps its access.
  await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);

  // The archive schema: USAGE, never CREATE.
  await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);

  await client.query(
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, ${role}`,
  );
  // Every table that exists right now, `retained_texts` (F1-66) included: the
  // read surface verifies a `retained_text_span_v1` citation by fetching that
  // text and reslicing the quote out of it (`verifiedAgainstRetainedText`,
  // mcp/pgRead.ts), so the reader that has to do the verifying must be able
  // to SELECT it. `test/pgReaderRole.test.mjs` asserts that grant by name,
  // beside the assertion that a table this function has *not* been re-run
  // over stays unreadable -- the two together are the whole exposure policy.
  //
  // On a live archive that already has a reader, migration 9 creates the
  // table after this last ran, so it is born unreadable (NO_DEFAULT_SELECT).
  // Re-running this function is one way to fix that and rotates the
  // password, which a live gateway is holding; a single
  // `GRANT SELECT ON <schema>.retained_texts TO <schema>_reader` as the
  // archive owner is the other, and is what the F1-66 rollout used.
  await client.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
  );
  await client.query(
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC, ${role}`,
  );
  // EXECUTE on a function is granted to PUBLIC by default, so a function
  // added to this schema would be callable by the reader without anyone
  // granting anything.
  await client.query(
    `REVOKE ALL ON ALL ROUTINES IN SCHEMA ${schema} FROM PUBLIC, ${role}`,
  );

  // USAGE on a type is likewise granted to PUBLIC by default. Revoked, then
  // granted back to the reader, which needs it to read the columns declared
  // over these domains.
  for (const domain of domains) {
    await client.query(
      `REVOKE ALL ON DOMAIN ${schema}.${domain} FROM PUBLIC, ${role}`,
    );
    await client.query(`GRANT USAGE ON DOMAIN ${schema}.${domain} TO ${role}`);
  }

  // Default privileges: what an object created here *later* is born with.
  // Only revocations, deliberately (NO_DEFAULT_SELECT).
  //
  // These work for TABLES and SEQUENCES, which is where the "a later
  // migration must not be silently readable" requirement bites: a table
  // created after this ran is readable by nobody until this function is run
  // again. `test/pgReaderRole.test.mjs` asserts exactly that.
  //
  // They do **not** work for FUNCTIONS or TYPES, and that is measured rather
  // than assumed. Postgres stores a default-privilege entry as a delta over
  // the built-in default and merges the two at creation time, so revoking
  // PUBLIC's built-in EXECUTE on functions or USAGE on types stores nothing
  // and changes nothing: a function created later is still executable by
  // PUBLIC, and therefore by the reader. Verified on Postgres 17 -- the entry
  // is either absent from `pg_default_acl` or present without the revocation,
  // and the new object's `proacl` still carries `=X/owner`.
  //
  // So the guarantee for functions and types is the concrete revoke above,
  // which is why re-running this function after a migration is the documented
  // step rather than a nicety. The calls stay because they are correct where
  // they work and cost nothing where they do not.
  const objectKinds = ["TABLES", "SEQUENCES", "FUNCTIONS", "TYPES"] as const;
  for (const kind of objectKinds) {
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON ${kind} FROM PUBLIC`,
    );
    if (NO_DEFAULT_SELECT) {
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON ${kind} FROM ${role}`,
      );
    }
  }

  // Membership is the inheritance path NOINHERIT does not close: a member can
  // still SET ROLE to the granting role. Nothing in this package grants one,
  // so a membership here means something outside this path did, and that is a
  // decision to surface loudly rather than to revoke silently.
  const memberships = await client.query<{ grantor: string }>(
    `SELECT r.rolname AS grantor
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.roleid
       JOIN pg_roles member ON member.oid = m.member
      WHERE member.rolname = $1`,
    [role],
  );
  if (memberships.rowCount) {
    throw new Error(
      `${role} is a member of ${memberships.rows
        .map((row) => row.grantor)
        .join(
          ", ",
        )}; a reader must own nothing and inherit nothing, so remove ` +
        "the membership rather than relying on NOINHERIT, which does not stop SET ROLE",
    );
  }
}

/**
 * The attribute half of the boundary, read back from the catalog.
 *
 * Three of these (`rolsuper`, `rolbypassrls`, `rolreplication`) can only be
 * named in `ALTER ROLE` by a superuser, so on a re-run there is no statement
 * the archive owner could issue to force them. Checking is what is left, and
 * an existing role that does not already satisfy the boundary is an error:
 * silently handing back a reader that can bypass row security would be worse
 * than failing.
 */
async function verifyAttributes(
  client: pg.ClientBase,
  role: string,
): Promise<void> {
  const attributes = await client.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
  }>(
    `SELECT rolsuper, rolbypassrls, rolreplication, rolcreatedb, rolcreaterole,
            rolinherit
       FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  const row = attributes.rows[0];
  if (!row) {
    throw new Error(`${role} does not exist after its setup ran`);
  }
  const held = (
    [
      ["SUPERUSER", row.rolsuper],
      ["BYPASSRLS", row.rolbypassrls],
      ["REPLICATION", row.rolreplication],
      ["CREATEDB", row.rolcreatedb],
      ["CREATEROLE", row.rolcreaterole],
      ["INHERIT", row.rolinherit],
    ] as const
  )
    .filter(([, value]) => value)
    .map(([name]) => name);
  if (held.length) {
    throw new Error(
      `${role} already exists with ${held.join(", ")}; a reader must hold none of ` +
        "SUPERUSER, BYPASSRLS, REPLICATION, CREATEDB, CREATEROLE or INHERIT. " +
        "SUPERUSER, BYPASSRLS and REPLICATION cannot be removed by a non-superuser " +
        "owner, so drop the role and let this function create it",
    );
  }
}
