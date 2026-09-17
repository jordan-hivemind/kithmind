import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_ROLE_NAME_PATTERN,
  AppRoleError,
  MIN_APP_ROLE_PASSWORD_LENGTH,
  provisionAppRole,
} from "./cutover-app-role.mjs";

// The same variable the rest of this repo's Postgres suites use. Without it
// there is no throwaway server to create databases on, so the database-backed
// cases skip rather than fail, exactly as the kith-store suites do.
const DATABASE_URL = process.env.KITH_STORE_DATABASE_URL;
const skip = DATABASE_URL ? false : "KITH_STORE_DATABASE_URL is not set";

const UNREACHABLE_URL = "postgres://nobody:nobody@127.0.0.1:1/nowhere";

async function pgClientModule() {
  return import("../packages/kith-store/node_modules/pg/esm/index.mjs");
}

/** A fresh empty database, dropped when the test ends. Applies the `kith`
 * schema so a role provisioned against it has something to be granted on. */
async function throwawayKithDatabase(t) {
  const pg = await pgClientModule();
  const { applyKithSchema } = await import("../packages/kith-store/dist/index.js");
  const name = `kith_cutover_app_role_${Math.random().toString(16).slice(2, 12)}`;

  const admin = new pg.default.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  t.after(async () => {
    const cleaner = new pg.default.Client({ connectionString: DATABASE_URL });
    await cleaner.connect();
    await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await cleaner.end();
  });

  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const target = url.toString();

  const owner = new pg.default.Client({ connectionString: target });
  await owner.connect();
  await applyKithSchema(owner);
  // A schema the app role has no business reading, to prove the grant is
  // scoped to `kith` rather than merely "everything this role can see".
  await owner.query("CREATE SCHEMA other_schema");
  await owner.query("CREATE TABLE other_schema.secrets (id integer primary key)");
  await owner.end();

  return target;
}

test("the regex rejects a bad role name before any connection", async () => {
  await assert.rejects(
    () => provisionAppRole(UNREACHABLE_URL, "Not-A-Valid-Role", "a".repeat(24)),
    (error) => error instanceof AppRoleError && error.code === "invalid_role_name",
  );
});

test("the regex matches grantProofAppRole's own pattern", () => {
  assert.equal(APP_ROLE_NAME_PATTERN.test("kith_app"), true);
  assert.equal(APP_ROLE_NAME_PATTERN.test("Kith_App"), false);
  assert.equal(APP_ROLE_NAME_PATTERN.test("9kith"), false);
  assert.equal(APP_ROLE_NAME_PATTERN.test("kith-app"), false);
});

test("a missing password is refused naming the variable, not the value", async () => {
  await assert.rejects(
    () => provisionAppRole(UNREACHABLE_URL, "kith_app_test", undefined),
    (error) =>
      error instanceof AppRoleError &&
      error.message.includes("KITH_APP_ROLE_PASSWORD") &&
      error.message.includes("not set"),
  );
});

test("a short password is refused naming the variable, not the value", async () => {
  const shortPassword = "too-short-1";
  assert.equal(shortPassword.length < MIN_APP_ROLE_PASSWORD_LENGTH, true);
  await assert.rejects(
    () => provisionAppRole(UNREACHABLE_URL, "kith_app_test", shortPassword),
    (error) =>
      error instanceof AppRoleError &&
      error.message.includes("KITH_APP_ROLE_PASSWORD") &&
      !error.message.includes(shortPassword),
  );
});

test(
  "the role is created on first run, updated on second run, and the password change takes effect",
  { skip },
  async (t) => {
    const pg = await pgClientModule();
    const role = `kith_app_test_${Math.random().toString(16).slice(2, 8)}`;
    // Registered before `throwawayKithDatabase` registers the database drop:
    // `t.after` hooks run in registration order, and the role's grants must be
    // dropped (and the role with them) while the database it was granted on
    // still exists.
    let target = null;
    t.after(async () => {
      if (!target) return;
      const admin = new pg.default.Client({ connectionString: target });
      await admin.connect();
      await admin.query(`DROP OWNED BY "${role}"`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
      await admin.end();
    });
    target = await throwawayKithDatabase(t);

    const admin = new pg.default.Client({ connectionString: target });
    await admin.connect();
    async function storedPasswordHash() {
      const result = await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [
        role,
      ]);
      return result.rows[0]?.rolpassword ?? null;
    }

    const firstPassword = "first-password-abcdef12";
    const first = await provisionAppRole(target, role, firstPassword);
    assert.equal(first.ok, true, JSON.stringify(first.problems));
    assert.equal(first.role, role);
    assert.equal(first.created, true);
    assert.equal(first.grants, "applied");
    assert.equal(first.appRoleCanRead, true);
    assert.equal(first.appRoleCannotCreate, true);
    assert.deepEqual(first.problems, []);
    assert.equal(JSON.stringify(first).includes(firstPassword), false);
    assert.equal(JSON.stringify(first).includes(target), false);
    const hashAfterFirst = await storedPasswordHash();
    assert.equal(typeof hashAfterFirst, "string");

    const secondPassword = "second-password-ghijkl34";
    const second = await provisionAppRole(target, role, secondPassword);
    assert.equal(second.ok, true, JSON.stringify(second.problems));
    assert.equal(second.created, false, "the second run updates rather than recreates the role");
    assert.equal(second.appRoleCanRead, true);
    assert.equal(second.appRoleCannotCreate, true);

    // `ALTER ROLE ... PASSWORD` on the second run stored a new credential
    // rather than leaving the first one in place. This reads the stored hash
    // rather than testing a rejected connection, because the local Postgres
    // used for this test authenticates over TCP with `trust`, which never
    // checks a supplied password at all.
    const hashAfterSecond = await storedPasswordHash();
    assert.equal(typeof hashAfterSecond, "string");
    assert.notEqual(hashAfterSecond, hashAfterFirst, "the second run must rotate the credential");
    await admin.end();

    // The role connects, reads inside `kith`, and is refused outside
    // it and refused a write anywhere.
    const freshUrl = new URL(target);
    freshUrl.username = role;
    freshUrl.password = secondPassword;
    const fresh = new pg.default.Client({ connectionString: freshUrl.toString() });
    await fresh.connect();
    try {
      const read = await fresh.query("SELECT count(*)::int AS n FROM kith.users");
      assert.equal(read.rows[0].n, 0);

      await assert.rejects(
        () => fresh.query("SELECT count(*) FROM other_schema.secrets"),
        (error) => error.code === "42501",
        "the app role must not read a schema grantProofAppRole never named",
      );

      await assert.rejects(
        () => fresh.query("CREATE TABLE kith.a_table_the_app_role_must_never_create (id int)"),
        (error) => error.code === "42501",
      );

      const probe = await fresh.query(
        "SELECT to_regclass('kith.a_table_the_app_role_must_never_create') AS present",
      );
      assert.equal(probe.rows[0].present, null, "the refused CREATE TABLE created nothing");
    } finally {
      await fresh.end().catch(() => {});
    }
  },
);

test(
  "a provider-managed role: ALTER ROLE is refused, but the grants and both verifications still run",
  { skip },
  async (t) => {
    const pg = await pgClientModule();
    const providerRole = `kith_provider_owner_${Math.random().toString(16).slice(2, 8)}`;
    const appRole = `kith_app_provider_${Math.random().toString(16).slice(2, 8)}`;
    const providerRolePassword = "provider-owner-pw-abcdef12";
    const appRolePassword = "provider-console-password-1";

    // Registered before `throwawayKithDatabase` registers the database drop,
    // for the same reason the earlier test in this file does: both roles'
    // owned objects (the whole `kith` schema, in `providerRole`'s case) must
    // be dropped while the database that holds them still exists.
    let target = null;
    t.after(async () => {
      if (!target) return;
      const admin = new pg.default.Client({ connectionString: target });
      await admin.connect();
      // CASCADE: `providerRole` owns the `kith` schema itself (reassigned
      // below), and a plain `DROP OWNED BY` refuses to drop a schema that
      // still has dependent objects in it (here, the schema's own domain
      // types) -- the same as `DROP SCHEMA ... RESTRICT` would. This is a
      // throwaway database this test's own `t.after` drops next, so cascading
      // is safe.
      await admin.query(`DROP OWNED BY "${providerRole}" CASCADE`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${providerRole}"`).catch(() => {});
      await admin.query(`DROP OWNED BY "${appRole}" CASCADE`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${appRole}"`).catch(() => {});
      await admin.end();
    });
    target = await throwawayKithDatabase(t);

    const admin = new pg.default.Client({ connectionString: target });
    await admin.connect();

    // The role a provider's console would have created by hand: LOGIN and a
    // known password, nothing else.
    await admin.query(
      `CREATE ROLE "${appRole}" LOGIN PASSWORD '${appRolePassword}'`,
    );

    // The role this test stands in for the migration role on a hosted
    // provider: no CREATEROLE (so it can create or re-password neither
    // role above), but the owner of `kith` and every table in it (so it can
    // still GRANT and REVOKE on them) -- the same split a provider's
    // project-owner role has. Made by handing it ownership of the schema
    // `throwawayKithDatabase` already applied, rather than by revoking
    // CREATEROLE from an existing role: the local superuser connecting to
    // this suite needs to keep CREATEROLE itself, to create and drop the
    // throwaway databases and roles every test in this file uses.
    await admin.query(
      `CREATE ROLE "${providerRole}" LOGIN PASSWORD '${providerRolePassword}' NOCREATEROLE NOCREATEDB NOSUPERUSER`,
    );
    await admin.query(`ALTER SCHEMA kith OWNER TO "${providerRole}"`);
    const tables = (
      await admin.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'kith'`)
    ).rows;
    for (const { tablename } of tables) {
      await admin.query(`ALTER TABLE kith."${tablename}" OWNER TO "${providerRole}"`);
    }
    await admin.end();

    const providerUrl = new URL(target);
    providerUrl.username = providerRole;
    providerUrl.password = providerRolePassword;

    const result = await provisionAppRole(providerUrl.toString(), appRole, appRolePassword);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.role, appRole);
    assert.equal(result.created, false, "the role already existed");
    assert.equal(result.passwordManaged, "provider");
    assert.equal(result.grants, "applied");
    assert.equal(result.appRoleCanRead, true);
    assert.equal(result.appRoleCannotCreate, true, "CREATE was still refused for the app role");
    assert.deepEqual(result.problems, []);
    assert.equal(JSON.stringify(result).includes(appRolePassword), false);
    assert.equal(JSON.stringify(result).includes(target), false);
  },
);

test(
  "the create-forbidden path returns a report instead of throwing, and names the fix",
  { skip },
  async (t) => {
    const pg = await pgClientModule();
    const restrictedRole = `kith_no_createrole_${Math.random().toString(16).slice(2, 8)}`;
    const restrictedRolePassword = "restricted-role-pw-abcdef12";
    const appRole = `kith_app_forbidden_${Math.random().toString(16).slice(2, 8)}`;
    const name = `kith_cutover_app_role_forbid_${Math.random().toString(16).slice(2, 12)}`;

    t.after(async () => {
      const cleaner = new pg.default.Client({ connectionString: DATABASE_URL });
      await cleaner.connect();
      await cleaner.query(`DROP ROLE IF EXISTS "${restrictedRole}"`).catch(() => {});
      await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await cleaner.end();
    });

    const admin = new pg.default.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    // No `kith` schema is applied here: the create-forbidden path returns
    // before `grantProofAppRole` ever runs, so nothing downstream needs it.
    await admin.query(
      `CREATE ROLE "${restrictedRole}" LOGIN PASSWORD '${restrictedRolePassword}' NOCREATEROLE NOCREATEDB NOSUPERUSER`,
    );
    await admin.end();

    const restrictedUrl = new URL(DATABASE_URL);
    restrictedUrl.pathname = `/${name}`;
    restrictedUrl.username = restrictedRole;
    restrictedUrl.password = restrictedRolePassword;

    const result = await provisionAppRole(restrictedUrl.toString(), appRole, "a".repeat(24));
    assert.equal(result.ok, false);
    assert.equal(result.role, appRole);
    assert.equal(result.created, false);
    assert.equal(result.grants, "not_applied");
    assert.equal(result.passwordManaged, null);
    assert.equal(result.appRoleCanRead, false);
    assert.equal(result.appRoleCannotCreate, false);
    assert.deepEqual(result.problems, ["app_role_create_forbidden:42501"]);
    assert.match(result.hint, /provider/i);
    assert.match(result.hint, /KITH_APP_ROLE_PASSWORD/);
    assert.match(result.hint, /app-role/);
  },
);
