#!/usr/bin/env node
// Host verification for the cutover workflow's live load.
//
// Plan section 3 step 1 ("verify the host") and step 8 ("`finance.schema_version`
// and every `finance` row count are unchanged before and after"). This script
// never writes: every statement it runs is a `SELECT`, and it runs them inside a
// read-only transaction so a mistake is refused by the server rather than caught
// by review. The `finance` schema is read here and written nowhere in this repo's
// cutover path.
//
// The connection string arrives in `KITH_CUTOVER_DATABASE_URL`, never on argv, so
// it is not visible in the process list and cannot land in a shell history or a
// workflow log. Nothing this script prints is derived from the URL.
//
// Usage:
//   KITH_CUTOVER_DATABASE_URL=... node scripts/cutover-host-check.mjs capture \
//     --out reports/host-before.json [--expect-empty-kith]
//   node scripts/cutover-host-check.mjs compare --before a.json --after b.json \
//     --out reports/finance-comparison.json

import { realpathSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// `pg` and the `kith` schema's own version constant, loaded from the sibling
// packages rather than a scripts/-local dependency, the same way
// db-restore-proof.mjs reaches for them.
const PG_CLIENT_URL = new URL(
  "../packages/kith-store/node_modules/pg/esm/index.mjs",
  import.meta.url,
);
const KITH_SCHEMA_URL = new URL(
  "../packages/kith-store/dist/schema.js",
  import.meta.url,
);

export class HostCheckError extends Error {
  constructor(code) {
    super(code);
    this.name = "HostCheckError";
    this.code = code;
  }
}

function fail(code) {
  throw new HostCheckError(code);
}

/** Reads a `--flag value` pair out of an argv slice. */
function flag(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`flag_missing_value:${name}`);
  return value;
}

/**
 * Every fact the cutover needs about the destination host, read in one
 * read-only transaction so the `finance` counts and the `finance` version are
 * one consistent snapshot rather than a sequence of unrelated reads.
 *
 * `expectEmptyKith` is the guard for a live load: `kith` may be absent (the
 * loader creates it) or present and empty, but a `kith` that already holds rows
 * means either a previous load already ran or this is not the database anyone
 * thought it was, and loading again would duplicate the archive.
 */
export async function captureHostState(connectionString, options = {}) {
  const expectEmptyKith = options.expectEmptyKith === true;
  const [pgModule, kithSchema] = await Promise.all([
    import(PG_CLIENT_URL),
    import(KITH_SCHEMA_URL),
  ]);
  const client = new pgModule.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const state = {
      version: 1,
      capturedAt: new Date().toISOString(),
      server: (
        await client.query("SELECT current_setting('server_version') AS v")
      ).rows[0].v,
      vector: (
        await client.query(`
          SELECT
            EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed,
            EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available`)
      ).rows[0],
      kith: await captureKith(client, kithSchema.KITH_SCHEMA_VERSION),
      finance: await captureFinance(client),
      problems: [],
    };
    await client.query("COMMIT");

    if (!state.vector.available) state.problems.push("vector_extension_unavailable");
    if (state.kith.schemaVersion !== 0 && state.kith.schemaVersion !== state.kith.expectedVersion) {
      state.problems.push(
        `kith_schema_version_unexpected:${state.kith.schemaVersion}!=${state.kith.expectedVersion}`,
      );
    }
    if (expectEmptyKith && state.kith.nonEmptyTables.length > 0) {
      state.problems.push(
        `kith_not_empty:${state.kith.nonEmptyTables.map((t) => t.name).join(",")}`,
      );
    }
    if (state.finance.schemaVersion === 0) state.problems.push("finance_schema_absent");
    state.ok = state.problems.length === 0;
    return state;
  } finally {
    await client.end().catch(() => {});
  }
}

async function captureKith(client, expectedVersion) {
  const present = (
    await client.query("SELECT to_regclass('kith.schema_version') IS NOT NULL AS present")
  ).rows[0].present;
  const schemaVersion = present
    ? Number(
        (await client.query("SELECT coalesce(max(version), 0)::text AS v FROM kith.schema_version"))
          .rows[0].v,
      )
    : 0;
  const reader = (
    await client.query(`
      SELECT coalesce(
        (SELECT array_to_string(rolconfig, ' ') FROM pg_roles WHERE rolname = 'kith_reader'),
        '') AS config,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kith_reader') AS present`)
  ).rows[0];
  const tables = await tableCounts(client, "kith");
  return {
    expectedVersion,
    schemaVersion,
    // Step 1's acceptance names `kith_reader` with `default_transaction_read_only`
    // on. It is reported, not enforced: the reader role is created deliberately
    // with a password this workflow does not hold, so a live load must not fail
    // merely because that separate step has not been run yet.
    readerRolePresent: reader.present,
    readerRoleReadOnly: reader.config.includes("default_transaction_read_only=on"),
    tables,
    nonEmptyTables: tables.filter((t) => t.rowCount > 0 && t.name !== "schema_version"),
  };
}

async function captureFinance(client) {
  const present = (
    await client.query("SELECT to_regclass('finance.schema_version') IS NOT NULL AS present")
  ).rows[0].present;
  return {
    schemaVersion: present
      ? Number(
          (
            await client.query(
              "SELECT coalesce(max(version), 0)::text AS v FROM finance.schema_version",
            )
          ).rows[0].v,
        )
      : 0,
    tables: await tableCounts(client, "finance"),
  };
}

/** Every table in `schema` with its row count, ordered by name so two captures
 * compare element for element. */
async function tableCounts(client, schema) {
  const names = (
    await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename COLLATE "C"`,
      [schema],
    )
  ).rows.map((row) => row.tablename);
  const counts = [];
  for (const name of names) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail(`table_name_invalid:${schema}.${name}`);
    const result = await client.query(`SELECT count(*)::text AS n FROM "${schema}"."${name}"`);
    counts.push({ name, rowCount: Number(result.rows[0].n) });
  }
  return counts;
}

/**
 * Step 8's acceptance, mechanically: the `finance` schema version and every
 * `finance` table row count must be identical before and after the live load.
 * A difference here is proof that something wrote `finance`, which this
 * workflow never does.
 */
export function compareFinance(before, after) {
  const differences = [];
  if (before.finance.schemaVersion !== after.finance.schemaVersion) {
    differences.push(
      `finance.schema_version ${before.finance.schemaVersion} -> ${after.finance.schemaVersion}`,
    );
  }
  const beforeByName = new Map(before.finance.tables.map((t) => [t.name, t.rowCount]));
  const afterByName = new Map(after.finance.tables.map((t) => [t.name, t.rowCount]));
  for (const [name, rowCount] of beforeByName) {
    if (!afterByName.has(name)) {
      differences.push(`finance.${name} disappeared`);
      continue;
    }
    if (afterByName.get(name) !== rowCount) {
      differences.push(`finance.${name} ${rowCount} -> ${afterByName.get(name)}`);
    }
  }
  for (const name of afterByName.keys()) {
    if (!beforeByName.has(name)) differences.push(`finance.${name} appeared`);
  }
  return {
    version: 1,
    ok: differences.length === 0,
    differences,
    financeSchemaVersion: before.finance.schemaVersion,
    financeTables: before.finance.tables.map((t) => ({
      name: t.name,
      rowCount: t.rowCount,
      rowCountAfter: afterByName.get(t.name) ?? null,
    })),
    kithSchemaVersionAfter: after.kith.schemaVersion,
  };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const out = flag(argv, "--out");
  if (command === "capture") {
    const url = process.env.KITH_CUTOVER_DATABASE_URL;
    if (!url) fail("KITH_CUTOVER_DATABASE_URL is not set");
    const state = await captureHostState(url, {
      expectEmptyKith: argv.includes("--expect-empty-kith"),
    });
    const json = `${JSON.stringify(state, null, 2)}\n`;
    if (out) await writeFile(out, json, { mode: 0o600 });
    process.stdout.write(json);
    if (!state.ok) process.exit(1);
    return;
  }
  if (command === "compare") {
    const before = JSON.parse(await readFile(flag(argv, "--before") ?? fail("--before"), "utf8"));
    const after = JSON.parse(await readFile(flag(argv, "--after") ?? fail("--after"), "utf8"));
    const result = compareFinance(before, after);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (out) await writeFile(out, json, { mode: 0o600 });
    process.stdout.write(json);
    if (!result.ok) process.exit(1);
    return;
  }
  fail("usage: cutover-host-check.mjs <capture|compare> [--out f] [--before f --after f]");
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
