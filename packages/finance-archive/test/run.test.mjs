import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  applyPgSchema,
  createArchiveClient,
  SYNTHETIC_INSTITUTION_NAME,
  SYNTHETIC_INSTITUTION_SLUG,
} from "../dist/index.js";
import { all, count, skip, testSchemaName } from "./helpers/pgArchive.mjs";

// The operator command end to end (src/run.ts, "one full acquisition-to-
// verdict pass"), run as an actual subprocess against a throwaway Postgres
// schema and a throwaway raw tree, exactly the way an operator would invoke
// it. F1-33: no SQLite provenance file anywhere in this suite -- run.ts
// reads institution slug and account last4 straight from the same Postgres
// schema it imports into, so there is no second database to keep in sync by
// hand. Synthetic institution, synthetic account, no real data anywhere.

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;

// F1-19: `slug`/`name` are the synthetic adapter's own, not arbitrary test
// values -- `resolveInstitution` upserts by slug, so pre-seeding a row under
// a different slug would leave it unmatched and mint a second, orphaned
// institution row every one of these tests would then have to account for.
const INSTITUTION = {
  id: "inst_thistlebrook_run",
  name: SYNTHETIC_INSTITUTION_NAME,
  slug: SYNTHETIC_INSTITUTION_SLUG,
};
const ACCOUNT = { id: "acct_synthetic_run", last4: "0142", currency: "USD" };
const SPACE_ID = "space_synthetic_run_test";

const distIndexUrl = pathToFileURL(
  fileURLToPath(new URL("../dist/index.js", import.meta.url)),
).href;
const runScript = fileURLToPath(new URL("../dist/run.js", import.meta.url));

/** The adapter and session modules run.ts loads by path -- the same two
 * small files every test in this suite points --adapter/--session at. */
function writeAdapterFixtures(t) {
  const fixturesDir = mkdtempSync(
    join(tmpdir(), "kith-finance-run-fixtures-"),
  );
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

  return { fixturesDir, adapterModulePath, sessionModulePath };
}

/** A throwaway Postgres schema with the institution provisioned and,
 * unless the caller opts out, the account too. Opting out is how the
 * external-key test below proves an account needs no separate provisioning
 * step (F1-32): run.ts's own resolveDiscoveredAccounts call provisions it. */
async function seededSchema(t, { seedAccount = true } = {}) {
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
  if (seedAccount) {
    await client.query(
      `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ACCOUNT.id,
        INSTITUTION.id,
        ACCOUNT.last4,
        "Synthetic account",
        ACCOUNT.currency,
      ],
    );
  }
  return { schema, client };
}

/**
 * F1-19: `institutionId` is omitted by default -- main() resolves the real
 * one from the adapter's own capabilities() before discover
 * (resolveInstitution), so a selection file no longer has to already name an
 * existing institutions row. Pass one explicitly only to exercise the
 * compatibility path (a selection file that still names one, agreeing or
 * disagreeing with what gets resolved).
 */
function writeSelection(fixturesDir, pulls, institutionId) {
  const selectionPath = join(fixturesDir, "selection.json");
  writeFileSync(
    selectionPath,
    JSON.stringify({
      ...(institutionId === undefined ? {} : { institutionId }),
      pulls,
    }),
  );
  return selectionPath;
}

function makeRunner({
  adapterModulePath,
  sessionModulePath,
  selectionPath,
  schema,
  rawDir,
}) {
  return function runImport(extraArgs = []) {
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
        },
        encoding: "utf8",
      },
    );
  };
}

test(
  "the run command takes an adapter from acquisition through both gate verdicts, prints only a summary, and a second pass inserts nothing new",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-run-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeAdapterFixtures(t);
    // F1-19 operator gap: no "institutionId" in this selection at all.
    const selectionPath = writeSelection(fixturesDir, [
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
    ]);
    const runImport = makeRunner({
      adapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });

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
    // F1-36: a row this importer refused (opened a review item for, never
    // inserted) is a distinct line from a deduplicated row, not folded into
    // it.
    assert.match(firstOutput, /rows refused: \d+/);
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

    // The institution row F1-19's resolveInstitution upserted is the one
    // already seeded (matched by slug), not a second row for one adapter.
    assert.equal(await count(client, "institutions"), 1);

    // A second pass over the identical selection is a no-op: the raw tree is
    // immutable and re-importing the same acquired bytes inserts nothing.
    const secondOutput = runImport();
    assert.match(secondOutput, /rows inserted: 0/);
    assert.equal(await count(client, "transactions"), inserted);
  },
);

test(
  "a selection file's institutionId, when present, must agree with what the adapter's capabilities() resolve to",
  { skip },
  async (t) => {
    const { schema } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-run-mismatch-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeAdapterFixtures(t);
    // Compatibility only: a caller who still names an institutionId gets a
    // loud refusal, not a silent import against a different institution,
    // when it disagrees with what resolveInstitution actually resolves to.
    const selectionPath = writeSelection(
      fixturesDir,
      [
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
      "not-the-real-institution-id",
    );
    const runImport = makeRunner({
      adapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });

    assert.throws(
      () => runImport(["--dry-run"]),
      (error) => {
        assert.match(
          String(error.stderr),
          /names institutionId not-the-real-institution-id/,
        );
        assert.match(String(error.stderr), new RegExp(INSTITUTION.slug));
        return true;
      },
    );
  },
);

test(
  "a selection can name an account by the adapter's own external key (F1-32), with no separate account-provisioning step, and a second pass inserts nothing new",
  { skip },
  async (t) => {
    // Institution only -- the account is discovered and upserted by run.ts
    // itself, via resolveDiscoveredAccounts, never provisioned by this test.
    const { schema, client } = await seededSchema(t, { seedAccount: false });

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-run-ext-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeAdapterFixtures(t);
    const selectionPath = writeSelection(fixturesDir, [
      {
        accountExternalKey: "acct-brokerage-01",
        docType: "activity_pull",
        docDate: null,
        selection: {
          kind: "structured_api",
          periodStart: "2025-01-01",
          periodEnd: "2025-04-01",
        },
      },
    ]);
    const runImport = makeRunner({
      adapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });

    const output = runImport();
    assert.match(output, /^mode: committed$/m);
    const insertedMatch = output.match(/rows inserted: (\d+)/);
    assert.ok(insertedMatch, "prints rows inserted");
    const inserted = Number(insertedMatch[1]);
    assert.ok(inserted > 0);

    // run.ts resolves every account discover() reports, not only the one the
    // selection names -- the synthetic adapter's fixture reports two.
    const accounts = await all(
      client,
      "SELECT external_key, acct_last4, display_name, account_type FROM accounts WHERE institution_id = $1",
      [INSTITUTION.id],
    );
    assert.equal(
      accounts.length,
      2,
      "every account discover() reported was provisioned by run.ts itself, from discover() alone",
    );
    const brokerage = accounts.find(
      (account) => account.external_key === "acct-brokerage-01",
    );
    assert.ok(brokerage, "the selection's own account is among them");
    assert.equal(brokerage.acct_last4, "4471");
    assert.equal(brokerage.display_name, "Brokerage");
    assert.equal(brokerage.account_type, "brokerage");

    assert.equal(await count(client, "transactions"), inserted);

    // A second pass, same selection: resolveDiscoveredAccounts upserts the
    // same rows rather than minting new ones, and the raw tree's
    // immutability makes the import itself a no-op exactly as it is for a
    // selection that names its account by id.
    const second = runImport();
    assert.match(second, /rows inserted: 0/);
    assert.equal(
      await count(client, "accounts", "WHERE institution_id = $1", [
        INSTITUTION.id,
      ]),
      2,
    );
    assert.equal(await count(client, "transactions"), inserted);
  },
);

test(
  "a scope: institution selection (F1-35) attributes rows to their own discovered accounts and persists a null document account",
  { skip },
  async (t) => {
    // No account seeded: an institution-wide pull names none, and the two
    // it needs come entirely from discover(), same as the external-key test
    // above.
    const { schema, client } = await seededSchema(t, { seedAccount: false });

    const rawDir = mkdtempSync(
      join(tmpdir(), "kith-finance-run-institution-raw-"),
    );
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeAdapterFixtures(t);
    const selectionPath = writeSelection(fixturesDir, [
      {
        scope: "institution",
        docType: "activity_pull",
        docDate: null,
        selection: {
          kind: "structured_api",
          periodStart: "2025-01-01",
          periodEnd: "2025-04-01",
        },
      },
    ]);
    const runImport = makeRunner({
      adapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });

    const output = runImport();
    assert.match(output, /^mode: committed$/m);
    const insertedMatch = output.match(/rows inserted: (\d+)/);
    assert.ok(insertedMatch, "prints rows inserted");
    const inserted = Number(insertedMatch[1]);
    assert.ok(inserted > 0);

    const accounts = await all(
      client,
      "SELECT id, external_key FROM accounts WHERE institution_id = $1",
      [INSTITUTION.id],
    );
    assert.equal(
      accounts.length,
      2,
      "both accounts discover() reported are provisioned, same as any other pull",
    );

    // The synthetic activity feed is paginated, so this one institution-wide
    // pull becomes one document per page (adapterImport.ts's documented
    // per-page splitting); every one of them belongs to the institution, not
    // to any one account -- never one row's account standing in for every
    // row's.
    const documentCount = await count(client, "documents");
    assert.ok(documentCount > 0);
    assert.equal(
      await count(client, "documents", "WHERE account_id IS NULL"),
      documentCount,
    );

    // The whole point of attributing rows by their own accountExternalKey:
    // every discovered account actually has transactions, not just the one
    // an old single-accountId pull would have filed everything under.
    for (const account of accounts) {
      const accountCount = await count(
        client,
        "transactions",
        "WHERE account_id = $1",
        [account.id],
      );
      assert.ok(accountCount > 0, `account ${account.external_key} has rows`);
    }
    assert.equal(await count(client, "transactions"), inserted);

    // A second pass over the identical selection is still a no-op.
    const second = runImport();
    assert.match(second, /rows inserted: 0/);
    assert.equal(await count(client, "transactions"), inserted);
  },
);
