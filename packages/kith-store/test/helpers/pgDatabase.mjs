// A throwaway database per test, for the suites that need a real server.
//
// These tests need Postgres and a public clone has none, so they skip cleanly
// unless KITH_STORE_DATABASE_URL points at one. CI supplies it. Nothing here
// defaults a connection string and none is ever committed.
//
// A throwaway *database*, not a throwaway schema, unlike the finance archive's
// harness. The brain's schema name is fixed at `kith` -- every statement in the
// package is qualified with it -- so isolation cannot come from renaming the
// schema, and a test that created and dropped `kith` in whatever database the
// URL happened to point at would be one misconfigured variable away from
// dropping a real one. A database this suite created itself is safe to drop, and
// it lets `kith` and `finance` be applied side by side under their real names,
// which is the layout section 2.1 of the consolidation plan actually adopts.
//
// Where a database is supposed to be configured, skipping is the failure rather
// than the safety net: KITH_STORE_REQUIRE_DATABASE=1 turns a missing URL into a
// loaded-file failure here.

import { randomBytes } from "node:crypto";

import pg from "pg";

const url = process.env.KITH_STORE_DATABASE_URL;

if (process.env.KITH_STORE_REQUIRE_DATABASE === "1" && !url) {
  throw new Error(
    "KITH_STORE_REQUIRE_DATABASE=1 but KITH_STORE_DATABASE_URL is not set. " +
      "These tests must run rather than skip here: point the URL at a throwaway " +
      "Postgres, or unset the flag to allow skipping.",
  );
}

/** node:test's `skip` option: false when a database is configured. */
export const skip = url
  ? false
  : "set KITH_STORE_DATABASE_URL to a throwaway Postgres to run the kith store tests";

function urlForDatabase(database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function onAdmin(work) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

/**
 * A fresh empty database, dropped when the test ends.
 *
 * Every connection opened on it goes through `adopt`, which closes it before the
 * drop: `DROP DATABASE ... WITH (FORCE)` terminates whatever is still connected,
 * and a terminated node-postgres client emits an `'error'` event that, with no
 * listener, is an uncaught exception rather than a tidy cleanup.
 */
export async function throwawayDatabase(t) {
  const name = `kith_store_test_${randomBytes(8).toString("hex")}`;
  await onAdmin((admin) => admin.query(`CREATE DATABASE ${name}`));
  const open = [];
  const database = {
    url: urlForDatabase(name),
    adopt(client) {
      client.on("error", () => {
        // The connection is going away with the database; a failure here must
        // not overwrite whatever the test is already reporting.
      });
      open.push(client);
      return client;
    },
  };
  t.after(async () => {
    for (const client of open.reverse()) {
      await client.end().catch(() => {});
    }
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
    );
  });
  return database;
}

/** A connected client on a throwaway database, closed before it is dropped. */
export async function connect(database) {
  const client = database.adopt(
    new pg.Client({ connectionString: database.url }),
  );
  await client.connect();
  return client;
}

/** Every row a query returns. Used only for small, bounded result sets. */
export async function all(client, sql, values = []) {
  return (await client.query(sql, values)).rows;
}

/** The error running `sql` raised, or null when it succeeded. */
export async function refused(client, sql, values = []) {
  try {
    await client.query(sql, values);
    return null;
  } catch (error) {
    return error;
  }
}
