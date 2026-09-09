// The shared harness for every suite that needs a real archive.
//
// These tests need Postgres, and a public clone has none, so they skip
// cleanly unless FINANCE_ARCHIVE_DATABASE_URL points at a throwaway database.
// CI supplies one; the README says so. Nothing here defaults a connection
// string, and none is ever committed.
//
// Each test works inside its own freshly created schema and drops it
// afterwards, so pointing this at a shared development database cannot
// clobber anything and two tests can never see each other's rows.
//
// Where a database is *supposed* to be configured, skipping is the failure,
// not the safety net. FINANCE_ARCHIVE_REQUIRE_DATABASE=1 turns a missing URL
// into a loaded-file failure here, so the guarantee lives in the tests rather
// than in a grep over another tool's console output. CI sets it; a public
// clone sets neither variable and still skips cleanly.

import { randomBytes } from "node:crypto";

import { applyPgSchema, createArchiveClient } from "../../dist/index.js";

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;

if (process.env.FINANCE_ARCHIVE_REQUIRE_DATABASE === "1" && !url) {
  throw new Error(
    "FINANCE_ARCHIVE_REQUIRE_DATABASE=1 but FINANCE_ARCHIVE_DATABASE_URL is not set. " +
      "These tests must run rather than skip here: point the URL at a throwaway " +
      "Postgres, or unset the flag to allow skipping.",
  );
}

/** node:test's `skip` option: false when a database is configured. */
export const skip = url
  ? false
  : "set FINANCE_ARCHIVE_DATABASE_URL to a throwaway Postgres to run the archive tests";

/** A throwaway schema name, unique per client. */
export function testSchemaName() {
  return `finance_archive_test_${randomBytes(8).toString("hex")}`;
}

/** Where `archive` records the schema it created, so `reader` can join it. */
const SCHEMA = Symbol("archive schema");

/**
 * A connected client on a fresh archive schema, dropped when the test ends.
 */
export async function archive(t) {
  const name = testSchemaName();
  const client = createArchiveClient(url, name);
  await client.connect();
  await applyPgSchema(client);
  client[SCHEMA] = name;
  t.after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    await client.end();
  });
  return client;
}

/**
 * A second, independent connection onto the same archive: the laptop querying
 * while the always-on machine imports, or a second importer racing the first.
 * It has its own transaction and its own snapshot, which is the only way to
 * observe from outside whether a publication is atomic.
 */
export async function connect(t, client) {
  const second = createArchiveClient(url, client[SCHEMA]);
  await second.connect();
  t.after(() => second.end());
  return second;
}

/** `SELECT count(*)` as a number. Counts, never rows. */
export async function count(client, table, where = "", values = []) {
  const result = await client.query(
    `SELECT count(*)::text AS n FROM ${table} ${where}`,
    values,
  );
  return Number(result.rows[0].n);
}

/** The single row a query is expected to return, or undefined. */
export async function one(client, sql, values = []) {
  const result = await client.query(sql, values);
  return result.rows[0];
}

/** Every row a query returns. Used only for small, bounded result sets. */
export async function all(client, sql, values = []) {
  const result = await client.query(sql, values);
  return result.rows;
}
