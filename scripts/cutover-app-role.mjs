#!/usr/bin/env node
// Runbook step 9's missing half: provisions the login role the web app uses as
// `KITH_DATABASE_URL`, against the same database `.github/workflows/cutover.yml`
// just loaded with the migration role. Before this script, that role had to be
// hand-written against the hosted database; this closes that gap.
//
// The role's privileges are never decided here. `@repo/kith-store`'s own
// `grantProofAppRole(owner, appRole)` (packages/kith-store/src/index.ts) is the
// one place that names what the application credential may touch, and this
// script is a thin wrapper: create or update the login role, then call that
// function, so a change to the grant list only ever has to be made once.
//
// The connection string arrives in `KITH_CUTOVER_DATABASE_URL`, never on argv,
// the same rule `cutover-host-check.mjs` follows. The role's password arrives in
// `KITH_APP_ROLE_PASSWORD`, also never on argv. Nothing this script prints or
// writes is derived from either: no URL, no host and no password ever reach the
// report or stdout. The workflow masks the URL parts itself, the same way its
// other live steps do; this script's job is only to never need that masking in
// the first place.
//
// The password is never concatenated into SQL text by this script. It is bound
// as a query parameter to `SELECT quote_literal($1::text)`, and only the
// server-produced, already-escaped literal that comes back is interpolated into
// the `CREATE ROLE` / `ALTER ROLE` statement text -- the same pattern
// `packages/pg/src/readerRole.ts` uses for `kith_reader` and `finance_reader`.
// The role name is interpolated directly, but only after it passed the regex
// `grantProofAppRole` itself enforces, so it can hold no character SQL would
// need escaped.
//
// Usage:
//   KITH_CUTOVER_DATABASE_URL=... KITH_APP_ROLE_PASSWORD=... \
//     node scripts/cutover-app-role.mjs --role kith_app --out reports/app-role.json

import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// `pg` and `@repo/kith-store`'s built proof-migration surface, loaded from the
// sibling package the same way `cutover-host-check.mjs` reaches `schema.js`.
const PG_CLIENT_URL = new URL(
  "../packages/kith-store/node_modules/pg/esm/index.mjs",
  import.meta.url,
);
const KITH_STORE_URL = new URL("../packages/kith-store/dist/index.js", import.meta.url);

/** The same rule `grantProofAppRole` and `applyProofMigration` enforce. */
export const APP_ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** Matches `readerRoleName`'s floor in `packages/pg/src/readerRole.ts`. */
export const MIN_APP_ROLE_PASSWORD_LENGTH = 16;

/** `CREATE TABLE kith.__probe()` is the literal probe statement the runbook
 * names: a zero-column table, which Postgres allows, so the only thing under
 * test is the privilege, not the shape. */
const PROBE_TABLE_SQL = "CREATE TABLE kith.__probe()";
const INSUFFICIENT_PRIVILEGE = "42501";

export class AppRoleError extends Error {
  constructor(code) {
    super(code);
    this.name = "AppRoleError";
    this.code = code;
  }
}

function fail(code) {
  throw new AppRoleError(code);
}

/** Reads a `--flag value` pair out of an argv slice. */
function flag(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`flag_missing_value:${name}`);
  return value;
}

export function validateAppRoleName(role) {
  if (typeof role !== "string" || !APP_ROLE_NAME_PATTERN.test(role)) {
    fail("invalid_role_name");
  }
  return role;
}

export function validateAppRolePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    fail("KITH_APP_ROLE_PASSWORD is not set");
  }
  if (password.length < MIN_APP_ROLE_PASSWORD_LENGTH) {
    fail(`KITH_APP_ROLE_PASSWORD must be at least ${MIN_APP_ROLE_PASSWORD_LENGTH} characters`);
  }
  return password;
}

/**
 * Creates or updates the login role, grants it exactly what `grantProofAppRole`
 * names, then proves the grant from a second connection opened as that role.
 *
 * Validation runs before any connection is opened: a bad role name or a short
 * password fails before `KITH_CUTOVER_DATABASE_URL` is ever dialed.
 *
 * The create-or-update decision and the statement that acts on it run inside
 * one transaction on one dedicated connection, so a concurrent run cannot
 * observe the role between the existence check and the statement that follows
 * it. `grantProofAppRole` runs after that transaction commits: it is already
 * idempotent (it revokes before it grants) and issues its own statements
 * against the pool, the same way every existing caller uses it.
 */
export async function provisionAppRole(connectionString, role, password) {
  validateAppRoleName(role);
  validateAppRolePassword(password);
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    fail("KITH_CUTOVER_DATABASE_URL is not set");
  }

  const [pgModule, kithStore] = await Promise.all([
    import(PG_CLIENT_URL),
    import(KITH_STORE_URL),
  ]);
  const pool = new pgModule.Pool({ connectionString });
  const problems = [];

  try {
    let created = false;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const exists = (
        await client.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present", [
          role,
        ])
      ).rows[0].present;
      // The password never appears in a statement string built by this script;
      // it is bound here, and only the server's own escaped literal is used
      // below.
      const quotedPassword = (
        await client.query("SELECT quote_literal($1::text) AS q", [password])
      ).rows[0].q;
      if (!exists) {
        await client.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD ${quotedPassword} NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER`,
        );
        created = true;
      } else {
        await client.query(`ALTER ROLE "${role}" WITH PASSWORD ${quotedPassword}`);
        created = false;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // The grant list itself lives in exactly one place: grantProofAppRole.
    await kithStore.grantProofAppRole(pool, role);

    // A second connection, as the app role itself, built from the owner URL's
    // host, port and database -- only the credentials change.
    const appUrl = new URL(connectionString);
    appUrl.username = role;
    appUrl.password = password;
    const appClient = new pgModule.Client({ connectionString: appUrl.toString() });

    let appRoleCanRead = false;
    let appRoleCannotCreate = false;
    await appClient.connect();
    try {
      try {
        await appClient.query("SELECT count(*) FROM kith.users");
        appRoleCanRead = true;
      } catch (error) {
        problems.push(`app_role_read_failed:${error?.code ?? error?.message ?? "unknown"}`);
      }

      try {
        await appClient.query(PROBE_TABLE_SQL);
        // This must never succeed: the app role is granted USAGE, never
        // CREATE, on the kith schema. If it does, the role is misconfigured
        // and the table it should never have been able to create is dropped
        // immediately, as the role that just created it.
        await appClient.query("DROP TABLE kith.__probe").catch(() => {});
        problems.push("app_role_could_create_table");
      } catch (error) {
        if (error?.code === INSUFFICIENT_PRIVILEGE) {
          appRoleCannotCreate = true;
        } else {
          problems.push(
            `app_role_create_probe_unexpected_error:${error?.code ?? error?.message ?? "unknown"}`,
          );
        }
      }
    } finally {
      await appClient.end().catch(() => {});
    }

    return {
      ok: problems.length === 0,
      role,
      created,
      grants: "applied",
      appRoleCanRead,
      appRoleCannotCreate,
      problems,
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const role = flag(argv, "--role");
  if (!role) fail("flag_missing_value:--role");
  const out = flag(argv, "--out");

  const url = process.env.KITH_CUTOVER_DATABASE_URL;
  if (!url) fail("KITH_CUTOVER_DATABASE_URL is not set");
  const password = process.env.KITH_APP_ROLE_PASSWORD;

  const report = await provisionAppRole(url, role, password);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) await writeFile(out, json, { mode: 0o600 });
  process.stdout.write(json);
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ status: "failed", code: error?.code ?? "runner_failed" })}\n`,
    );
    process.exitCode = 1;
  });
