import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { applyPgSchema, createArchiveClient, openArchive } from "../dist/index.js";
import { all, count, skip, testSchemaName } from "./helpers/pgArchive.mjs";

// The operator command end to end (src/run.ts, "one full acquisition-to-
// verdict pass"), run as an actual subprocess against a throwaway Postgres
// schema and a throwaway raw tree / SQLite provenance file, exactly the way
// an operator would invoke it. Synthetic institution, synthetic account, no
// real data anywhere.

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;

const INSTITUTION = {
  id: "inst_thistlebrook_run",
  name: "Thistlebrook Trust (synthetic)",
  slug: "thistlebrook-trust-run",
};
const ACCOUNT = { id: "acct_synthetic_run", last4: "0142", currency: "USD" };
const SPACE_ID = "space_synthetic_run_test";

const distIndexUrl = pathToFileURL(
  fileURLToPath(new URL("../dist/index.js", import.meta.url)),
).href;
const runScript = fileURLToPath(new URL("../dist/run.js", import.meta.url));

test(
  "the run command takes an adapter from acquisition through both gate verdicts, prints only a summary, and a second pass inserts nothing new",
  { skip },
  async (t) => {
    const schema = testSchemaName();
    const client = createArchiveClient(url, schema);
    await client.connect();
    await applyPgSchema(client);
    t.after(async () => {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    });

    await client.query(
      "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
      [INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug],
    );
    await client.query(
      `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [ACCOUNT.id, INSTITUTION.id, ACCOUNT.last4, "Synthetic account", ACCOUNT.currency],
    );

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-run-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const dbDir = mkdtempSync(join(tmpdir(), "kith-finance-run-db-"));
    t.after(() => rmSync(dbDir, { recursive: true, force: true }));
    const dbPath = join(dbDir, "archive.db");
    const sqliteDb = openArchive(dbPath);
    sqliteDb
      .prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)")
      .run(INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug);
    sqliteDb
      .prepare(
        `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ACCOUNT.id, INSTITUTION.id, ACCOUNT.last4, "Synthetic account", ACCOUNT.currency);
    sqliteDb.close();

    const fixturesDir = mkdtempSync(join(tmpdir(), "kith-finance-run-fixtures-"));
    t.after(() => rmSync(fixturesDir, { recursive: true, force: true }));

    const adapterModulePath = join(fixturesDir, "adapter.mjs");
    writeFileSync(
      adapterModulePath,
      `import { syntheticAdapter } from ${JSON.stringify(distIndexUrl)};\n` +
        `export default syntheticAdapter;\n`,
    );

    const sessionModulePath = join(fixturesDir, "session.mjs");
    writeFileSync(
      sessionModulePath,
      `import { createSyntheticSession } from ${JSON.stringify(distIndexUrl)};\n` +
        `export default function buildSession() {\n  return createSyntheticSession();\n}\n`,
    );

    const selectionPath = join(fixturesDir, "selection.json");
    writeFileSync(
      selectionPath,
      JSON.stringify({
        institutionId: INSTITUTION.id,
        pulls: [
          {
            accountId: ACCOUNT.id,
            docType: "activity_pull",
            docDate: null,
            selection: {
              kind: "structured_api",
              periodStart: "2025-01-01",
              periodEnd: "2025-04-01",
            },
          },
        ],
      }),
    );

    function runImport(extraArgs = []) {
      return execFileSync(
        process.execPath,
        [
          runScript,
          "--adapter",
          adapterModulePath,
          "--session",
          sessionModulePath,
          "--selection",
          selectionPath,
          "--now",
          "2025-05-01T00:00:00.000Z",
          ...extraArgs,
        ],
        {
          env: {
            ...process.env,
            FINANCE_ARCHIVE_DATABASE_URL: url,
            FINANCE_ARCHIVE_SCHEMA: schema,
            FINANCE_ARCHIVE_RAW_TREE_ROOT: rawDir,
            FINANCE_ARCHIVE_SPACE_ID: SPACE_ID,
            FINANCE_ARCHIVE_DB_PATH: dbPath,
          },
          encoding: "utf8",
        },
      );
    }

    // --dry-run first: the summary shape appears, but nothing commits.
    const dryOutput = runImport(["--dry-run"]);
    assert.match(dryOutput, /mode: dry-run \(rolled back, nothing committed\)/);
    assert.match(dryOutput, /documents acquired: 1/);
    assert.match(dryOutput, /rows inserted: \d+/);
    assert.equal(await count(client, "transactions"), 0);
    assert.equal(await count(client, "import_runs"), 0);

    // The real pass: summary shape, and it actually wrote through.
    const firstOutput = runImport();
    assert.match(firstOutput, /^mode: committed$/m);
    assert.match(firstOutput, /discover: exhaustive \(\d+ document\(s\), \d+ export range\(s\)\)/);
    assert.match(firstOutput, /documents acquired: 1/);
    assert.match(firstOutput, /bytes acquired: \d+/);
    assert.match(firstOutput, /acquisition manifest sha256: [0-9a-f]{64}/);
    assert.match(firstOutput, /rows parsed: \d+/);
    const insertedMatch = firstOutput.match(/rows inserted: (\d+)/);
    assert.ok(insertedMatch, "prints rows inserted");
    const inserted = Number(insertedMatch[1]);
    assert.ok(inserted > 0, "the paginated pull inserted rows");
    assert.match(firstOutput, /rows deduplicated: \d+/);
    assert.match(firstOutput, /review items opened: \d+/);
    assert.match(firstOutput, /money by currency:/);
    assert.match(firstOutput, /cash reconciliation verdicts:/);
    assert.match(firstOutput, /position reconciliation verdicts:/);

    // Never a row: no transaction description, no line of the fixture's own
    // activity text leaks into the summary -- only counts, sums and verdicts.
    assert.ok(!firstOutput.includes("Synthetic"));
    assert.ok(!firstOutput.toLowerCase().includes("dividend"));
    assert.ok(!firstOutput.toLowerCase().includes("description"));

    assert.equal(await count(client, "transactions"), inserted);
    const importRuns = await all(client, "SELECT source FROM import_runs");
    assert.equal(importRuns.length, 1);
    assert.equal(importRuns[0].source, "thistlebrook-trust");

    // A second pass over the identical selection is a no-op: the raw tree is
    // immutable and re-importing the same acquired bytes inserts nothing.
    const secondOutput = runImport();
    assert.match(secondOutput, /rows inserted: 0/);
    assert.equal(await count(client, "transactions"), inserted);
  },
);
