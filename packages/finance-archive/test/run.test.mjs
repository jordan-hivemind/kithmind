import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  applyPgSchema,
  createArchiveClient,
  sha256HexOf,
  SYNTHETIC_INSTITUTION_NAME,
  SYNTHETIC_INSTITUTION_SLUG,
  textRelativePath,
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

/**
 * F1-55. The same fixtures as `writeAdapterFixtures`, plus a second adapter
 * module whose `parse()` always reports a PDF-tier document as unreadable --
 * standing in for the pre-fix defect (F1-55: the regex extractor saw no
 * text in a real statement's compressed stream) without needing a real PDF
 * in this suite. `discover()`/`acquire()`/`capabilities()` are the real
 * synthetic adapter's own, unchanged, so the same selection file and the
 * same session drive both: only which module `--adapter`/`reparse --adapter`
 * points at decides whether the document parses.
 */
function writeReparseAdapterFixtures(t) {
  const { fixturesDir, adapterModulePath, sessionModulePath } = writeAdapterFixtures(t);
  const brokenAdapterModulePath = join(fixturesDir, "adapter-broken-parse.mjs");
  writeFileSync(
    brokenAdapterModulePath,
    `import { syntheticAdapter } from ${JSON.stringify(distIndexUrl)};\n` +
      `const brokenAdapter = {\n` +
      `  ...syntheticAdapter,\n` +
      `  async parse(rawFile) {\n` +
      `    if (rawFile.kind === "pdf_statement" || rawFile.kind === "trade_confirmation") {\n` +
      `      return {\n` +
      `        activity: [],\n` +
      `        holdings: { positions: [], balances: [], liabilities: [] },\n` +
      `        parseNote: "not parsed: synthetic extractor outage (F1-55 test fixture)",\n` +
      `      };\n` +
      `    }\n` +
      `    return syntheticAdapter.parse(rawFile);\n` +
      `  },\n` +
      `};\n` +
      `export default brokenAdapter;\n`,
  );
  // F1-60. A second extractor that also fails, but for a different stated
  // reason: what a reparse under a better parser looks like when it gets no
  // further but does name the obstacle differently.
  const rebrokenAdapterModulePath = join(fixturesDir, "adapter-broken-parse-2.mjs");
  writeFileSync(
    rebrokenAdapterModulePath,
    `import { syntheticAdapter } from ${JSON.stringify(distIndexUrl)};\n` +
      `const rebrokenAdapter = {\n` +
      `  ...syntheticAdapter,\n` +
      `  async parse(rawFile) {\n` +
      `    if (rawFile.kind === "pdf_statement" || rawFile.kind === "trade_confirmation") {\n` +
      `      return {\n` +
      `        activity: [],\n` +
      `        holdings: { positions: [], balances: [], liabilities: [] },\n` +
      `        parseNote: "partially parsed: 2 holdings block(s) left unparsed (F1-60 test fixture)",\n` +
      `      };\n` +
      `    }\n` +
      `    return syntheticAdapter.parse(rawFile);\n` +
      `  },\n` +
      `};\n` +
      `export default rebrokenAdapter;\n`,
  );
  return {
    fixturesDir,
    adapterModulePath,
    brokenAdapterModulePath,
    rebrokenAdapterModulePath,
    sessionModulePath,
  };
}

/**
 * F1-66. The same fixtures again, plus an adapter whose PDF-tier `parse()`
 * reports an `extractedText` -- the retained text layer. The real synthetic
 * adapter extracts none, so without this no run in this suite ever exercises
 * `writeRetainedText` or the `retained_texts` row written beside it. The text
 * is a fixed synthetic string, so the sha both writes land under is the same
 * on every pass and a second pass is a real idempotence check.
 */
const EXTRACTED_TEXT =
  "HOLDINGS\nSynthetic Neutral Fund   10.000   $1,000.00   Cost 900.00\n";

function writeExtractedTextAdapterFixtures(t) {
  const { fixturesDir, adapterModulePath, sessionModulePath } =
    writeAdapterFixtures(t);
  const textAdapterModulePath = join(fixturesDir, "adapter-extracted-text.mjs");
  writeFileSync(
    textAdapterModulePath,
    `import { syntheticAdapter } from ${JSON.stringify(distIndexUrl)};\n` +
      `const textAdapter = {\n` +
      `  ...syntheticAdapter,\n` +
      `  async parse(rawFile) {\n` +
      `    const parsed = await syntheticAdapter.parse(rawFile);\n` +
      `    if (rawFile.kind === "pdf_statement" || rawFile.kind === "trade_confirmation") {\n` +
      `      return { ...parsed, extractedText: ${JSON.stringify(EXTRACTED_TEXT)} };\n` +
      `    }\n` +
      `    return parsed;\n` +
      `  },\n` +
      `};\n` +
      `export default textAdapter;\n`,
  );
  return {
    fixturesDir,
    adapterModulePath,
    textAdapterModulePath,
    sessionModulePath,
  };
}

/**
 * F1-39. Same adapter fixture as `writeAdapterFixtures`, but the session
 * module withholds the document total (`omitDocumentsTotal`) or serves fewer
 * documents than exist (`documentsLimit`), so `discover()`'s document
 * listing comes back incomplete -- the shape `"requireExhaustive": true`
 * refuses to start against.
 */
function writeIncompleteDiscoveryFixtures(t, sessionOptions) {
  const { fixturesDir, adapterModulePath } = writeAdapterFixtures(t);
  const sessionModulePath = join(fixturesDir, "session-incomplete.mjs");
  writeFileSync(
    sessionModulePath,
    `import { createSyntheticSession } from ${JSON.stringify(distIndexUrl)};\n` +
      `export default function buildSession() {\n` +
      `  return createSyntheticSession(${JSON.stringify(sessionOptions)});\n` +
      `}\n`,
  );
  return { fixturesDir, adapterModulePath, sessionModulePath };
}

/**
 * F1-39. Same adapter fixture, but the session throws fetching one named
 * document's bytes -- an injected acquisition failure, standing in for a
 * real provider outage on one document of a pull that names several.
 *
 * F1-43: `message` defaults to a generic outage (continues, per the test
 * below using it unchanged); pass one matching run.ts's SIGNED_OUT-class
 * regex to stand in for a lost browser session instead.
 */
function writeFailingDocumentFixtures(
  t,
  failingExternalId,
  message = "synthetic outage fetching this document",
) {
  const { fixturesDir, adapterModulePath } = writeAdapterFixtures(t);
  const sessionModulePath = join(fixturesDir, "session-failing.mjs");
  writeFileSync(
    sessionModulePath,
    `import { createSyntheticSession } from ${JSON.stringify(distIndexUrl)};\n` +
      `export default function buildSession() {\n` +
      `  const base = createSyntheticSession();\n` +
      `  return {\n` +
      `    ...base,\n` +
      `    async fetchBytes(path, query) {\n` +
      `      if (path === ${JSON.stringify(`/documents/${failingExternalId}`)}) {\n` +
      `        throw new Error(${JSON.stringify(message)});\n` +
      `      }\n` +
      `      return base.fetchBytes(path, query);\n` +
      `    },\n` +
      `  };\n` +
      `}\n`,
  );
  return { fixturesDir, adapterModulePath, sessionModulePath };
}

/**
 * F1-62. A session whose document downloads (`/documents/...`) delay a fixed
 * number of milliseconds and, before delaying, record how many are in flight
 * together into `hwmFilePath` -- the only channel back to this test process,
 * since `run.ts` runs as its own subprocess (execFileSync below). Proves
 * `--concurrency` actually overlaps downloads rather than only accepting the
 * flag: at `--concurrency 1` the high-water mark this file ends up holding is
 * 1; with real overlap it is greater than 1.
 */
function writeOverlappingDownloadFixtures(t, { delayMs, hwmFilePath }) {
  const { fixturesDir, adapterModulePath } = writeAdapterFixtures(t);
  const sessionModulePath = join(fixturesDir, "session-overlap.mjs");
  writeFileSync(
    sessionModulePath,
    `import { writeFileSync } from "node:fs";\n` +
      `import { createSyntheticSession } from ${JSON.stringify(distIndexUrl)};\n` +
      `export default function buildSession() {\n` +
      `  const base = createSyntheticSession();\n` +
      `  let inFlight = 0;\n` +
      `  let maxInFlight = 0;\n` +
      `  return {\n` +
      `    ...base,\n` +
      `    async fetchBytes(path, query) {\n` +
      `      if (!path.startsWith("/documents/")) return base.fetchBytes(path, query);\n` +
      `      inFlight += 1;\n` +
      `      maxInFlight = Math.max(maxInFlight, inFlight);\n` +
      `      writeFileSync(${JSON.stringify(hwmFilePath)}, String(maxInFlight));\n` +
      `      try {\n` +
      `        await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(delayMs)}));\n` +
      `        return await base.fetchBytes(path, query);\n` +
      `      } finally {\n` +
      `        inFlight -= 1;\n` +
      `      }\n` +
      `    },\n` +
      `  };\n` +
      `}\n`,
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

/**
 * F1-55. The `reparse` subcommand: no `--session` and no `--selection` --
 * it walks the archive's own `documents` rows and the raw tree, never a
 * browser or the network.
 */
function makeReparseRunner({ adapterModulePath, schema, rawDir }) {
  return function runReparse(extraArgs = []) {
    return execFileSync(
      process.execPath,
      [runScript, "reparse", "--adapter", adapterModulePath, "--now", "2025-06-01T00:00:00.000Z", ...extraArgs],
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
  "--gates: every document is gated incrementally, and the whole-archive pass runs once at the end unless it is turned off",
  { skip },
  async (t) => {
    const { schema } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-run-gates-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeAdapterFixtures(t);
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

    // F1-59. The default: publication gates what each document changed, and
    // one whole-archive pass at the end reports the archive-wide counts.
    const output = runImport();
    assert.match(output, /^mode: committed$/m);
    assert.match(output, /incremental gate periods checked: cash=\d+ positions=\d+/);
    assert.match(output, /^whole-archive gate pass:$/m);
    assert.match(output, /cash: checked=\d+ pass=\d+ fail=\d+ unverified=\d+/);
    assert.match(
      output,
      /positions: checked=\d+ pass=\d+ fail=\d+ unverified=\d+ coverage gaps=\d+/,
    );

    // Turned off, the per-document gates still ran; only the final pass did not.
    const skippedPass = runImport(["--gates", "incremental"]);
    assert.match(
      skippedPass,
      /whole-archive gate pass: skipped \(--gates incremental\)/,
    );
    assert.match(skippedPass, /incremental gate periods checked: /);

    assert.throws(
      () => runImport(["--gates", "sometimes"]),
      /--gates must be "full" or "incremental"/,
    );
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

// --- F1-39: expanded selections and commit-every batching ------------------

test(
  '"expand": "discovered" acquires every discovered document of the requested kinds, filed institution-wide',
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t, { seedAccount: false });

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-run-expand-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeAdapterFixtures(t);
    // The synthetic fixture discovers 3 documents (2 pdf_statement, 1
    // trade_confirmation, see fixtures.ts's DOCUMENTS) -- naming only
    // "trade_confirmation" here proves the "kinds" filter actually filters,
    // not merely that every discovered document gets pulled.
    const selectionPath = writeSelection(fixturesDir, [
      {
        expand: "discovered",
        kinds: ["trade_confirmation"],
        docType: "trade_confirmation",
        requireExhaustive: true,
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
    // documentsDiscoveredByKind reflects the whole discover() result, not
    // only the kinds this entry asked for.
    assert.match(output, /documents discovered by kind:\s*\n\s*pdf_statement: 2/);
    assert.match(output, /trade_confirmation: 1/);
    // The document itself was acquired -- bytes fetched and persisted to the
    // raw tree -- regardless of what happens at import.
    assert.match(output, /documents acquired: 1/);
    assert.match(output, /bytes acquired: [1-9]\d*/);

    // The synthetic adapter's document-tier parse() (pdf_statement/
    // trade_confirmation) never tags a row with its own accountExternalKey
    // -- pre-F1-39 that was fine, since a document-tier pull always named
    // its own real account (README: "a document-tier pull always belongs to
    // one account"). An institution-wide one (this pull, since
    // DiscoveredDocument names no account) has no such fallback either, so
    // adapterImport.ts's resolveRowAccountId correctly refuses to guess: the
    // import fails rather than silently filing the row under the wrong (or
    // no) account. This is the safe outcome, not a bug -- and it exercises
    // the same failure-reporting path as an acquisition-stage failure (see
    // the --commit-every test below), proving the summary reports an
    // import-stage refusal by kind and count too.
    assert.match(output, /document pulls acquired: 0/);
    assert.match(output, /document pulls failed: 1/);
    assert.match(output, /trade_confirmation: acquired=0 skipped=0 failed=1/);

    assert.equal(
      await count(client, "documents", "WHERE institution_id = $1", [
        INSTITUTION.id,
      ]),
      0,
      "an unattributable row is refused, never silently imported unattributed",
    );
    assert.equal(await count(client, "transactions"), 0);
  },
);

test(
  '"expand": "discovered" (F1-40) files a document under the account its own accountExternalKey resolves to, landing its positions and balances there too, while a keyless document stays institution-wide',
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t, { seedAccount: false });

    const rawDir = mkdtempSync(
      join(tmpdir(), "kith-finance-run-expand-account-raw-"),
    );
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeAdapterFixtures(t);
    // The synthetic fixture's two pdf_statement documents: doc-stmt-2025-q1
    // carries accountExternalKey "acct-brokerage-01" and a HOLDINGS section
    // (positions, a balance, a liability); doc-stmt-2025-q2 carries none
    // (fixtures.ts's DOCUMENTS, F1-40).
    const selectionPath = writeSelection(fixturesDir, [
      {
        expand: "discovered",
        kinds: ["pdf_statement"],
        docType: "statement",
        requireExhaustive: true,
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
    // Both statements are acquired regardless of import outcome.
    assert.match(output, /documents acquired: 2/);
    // doc-stmt-2025-q1 imports (filed under its own account); doc-stmt-2025-q2
    // stays institution-wide and fails for the same reason the keyless
    // trade_confirmation does in the test above -- no accountExternalKey on
    // its rows and no pull-level account to fall back on.
    assert.match(output, /document pulls acquired: 1/);
    assert.match(output, /document pulls failed: 1/);
    assert.match(output, /pdf_statement: acquired=1 skipped=0 failed=1/);
    // F1-40's own summary line: one document filed by account, one
    // institution-wide -- independent of the acquired/failed split above.
    assert.match(output, /documents filed: by account=1 institution-wide=1/);

    const accounts = await all(
      client,
      "SELECT id, external_key FROM accounts WHERE institution_id = $1",
      [INSTITUTION.id],
    );
    const brokerage = accounts.find(
      (account) => account.external_key === "acct-brokerage-01",
    );
    assert.ok(brokerage, "the account discover() reported is provisioned");

    const documents = await all(
      client,
      "SELECT id, account_id, doc_type FROM documents WHERE institution_id = $1",
      [INSTITUTION.id],
    );
    assert.equal(
      documents.length,
      1,
      "only the account-attributed statement imported -- the keyless one failed",
    );
    assert.equal(documents[0].account_id, brokerage.id);

    // The whole point: an expanded document pull's positions, balances and
    // liabilities -- not just its own document row -- carry the resolved
    // account_id, exactly like an explicit per-account selection.
    assert.ok(
      (await count(client, "positions", "WHERE account_id = $1", [brokerage.id])) > 0,
      "positions landed on the resolved account",
    );
    assert.ok(
      (await count(client, "balances", "WHERE account_id = $1", [brokerage.id])) > 0,
      "balances landed on the resolved account",
    );
    assert.ok(
      (await count(client, "liabilities", "WHERE account_id = $1", [brokerage.id])) > 0,
      "liabilities landed on the resolved account",
    );
    assert.ok(
      (await count(client, "transactions", "WHERE account_id = $1", [brokerage.id])) > 0,
      "activity rows landed on the resolved account",
    );
  },
);

test(
  '"requireExhaustive": true refuses to start when discover()\'s document listing is incomplete',
  { skip },
  async (t) => {
    const { schema } = await seededSchema(t, { seedAccount: false });

    const rawDir = mkdtempSync(
      join(tmpdir(), "kith-finance-run-expand-incomplete-raw-"),
    );
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    // Withholds the document total, so discover() cannot mark its listing
    // exhaustive (see createSyntheticSession's omitDocumentsTotal option).
    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeIncompleteDiscoveryFixtures(t, { omitDocumentsTotal: true });
    const selectionPath = writeSelection(fixturesDir, [
      {
        expand: "discovered",
        kinds: ["pdf_statement", "trade_confirmation"],
        docType: "statement_or_confirmation",
        requireExhaustive: true,
      },
    ]);
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
        assert.match(String(error.stderr), /requireExhaustive/);
        assert.match(
          String(error.stderr),
          /provider does not report a document total/,
        );
        return true;
      },
    );
  },
);

test(
  '"expand": "activity-ranges" splits a multi-year window into one institution-wide pull per calendar year',
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t, { seedAccount: false });

    const rawDir = mkdtempSync(
      join(tmpdir(), "kith-finance-run-expand-years-raw-"),
    );
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeAdapterFixtures(t);
    // 2023-06-15..2025-02-10 touches three calendar years: 2023, 2024, 2025.
    const selectionPath = writeSelection(fixturesDir, [
      {
        expand: "activity-ranges",
        kind: "structured_api",
        docType: "activity_pull",
        periodStart: "2023-06-15",
        periodEnd: "2025-02-10",
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
    // Three pulls acquired -- one per calendar year the window touches.
    assert.match(output, /documents acquired: 3/);

    // Each pull publishes as its own transaction (structured pulls are
    // never batched by --commit-every), so import_runs gets one row per
    // year even though the synthetic adapter returns byte-identical
    // activity for every period and every row after the first pull dedupes.
    assert.equal(await count(client, "import_runs"), 3);
    assert.ok(await count(client, "transactions") > 0);
  },
);

test(
  "a second pass over a document-tier selection imports nothing new for a document already imported",
  { skip },
  async (t) => {
    // A plain (non-"expand") document-tier entry naming a real account --
    // exactly the pre-F1-39 shape -- run through F1-39's new default
    // commit-every-1 machinery (each document pull is now its own
    // transaction). Proves the "skipped (already imported)" counter, not the
    // expansion feature; see the "expand": "discovered" test above for why an
    // institution-wide document pull cannot itself demonstrate a successful
    // import with this adapter.
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(
      join(tmpdir(), "kith-finance-run-doc-rerun-raw-"),
    );
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeAdapterFixtures(t);
    const selectionPath = writeSelection(fixturesDir, [
      {
        accountId: ACCOUNT.id,
        docType: "confirmation",
        docDate: null,
        selection: {
          kind: "trade_confirmation",
          externalId: "doc-conf-2025-02-10",
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

    const first = runImport();
    assert.match(first, /document pulls acquired: 1/);
    assert.match(first, /document pulls skipped \(already imported\): 0/);
    assert.match(first, /document pulls failed: 0/);
    const inserted = await count(client, "transactions");
    assert.ok(inserted > 0);

    // Raw-tree content addressing plus documents.sha256 dedupe (importer.ts)
    // already make a re-run a no-op; F1-39 only has to report it as a
    // "skip", not re-derive the dedupe itself.
    const second = runImport();
    assert.match(second, /rows inserted: 0/);
    assert.match(second, /document pulls acquired: 0/);
    assert.match(second, /document pulls skipped \(already imported\): 1/);
    assert.match(second, /document pulls failed: 0/);
    assert.equal(await count(client, "transactions"), inserted);
  },
);

test(
  "--commit-every defaults to one document pull per transaction: a refused/failed document is reported and skipped, and the run continues",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(
      join(tmpdir(), "kith-finance-run-failure-raw-"),
    );
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    // doc-stmt-2025-q2 fails to acquire; doc-conf-2025-02-10 does not. Both
    // name a real, seeded account (not an "expand": "discovered" pull), so
    // the only thing under test is failure isolation between two document
    // pulls in the same run.
    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeFailingDocumentFixtures(t, "doc-stmt-2025-q2");
    const selectionPath = writeSelection(fixturesDir, [
      {
        accountId: ACCOUNT.id,
        docType: "statement",
        docDate: null,
        selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q2" },
      },
      {
        accountId: ACCOUNT.id,
        docType: "confirmation",
        docDate: null,
        selection: {
          kind: "trade_confirmation",
          externalId: "doc-conf-2025-02-10",
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

    // Does not throw: a refused/failed document is reported (stderr) and
    // skipped, the run continues and exits 0.
    const output = runImport();
    assert.match(output, /^mode: committed$/m);
    assert.match(output, /document pulls acquired: 1/);
    assert.match(output, /document pulls failed: 1/);
    assert.match(output, /pdf_statement: acquired=0 skipped=0 failed=1/);
    assert.match(output, /trade_confirmation: acquired=1 skipped=0 failed=0/);

    const documents = await all(
      client,
      "SELECT doc_type FROM documents WHERE institution_id = $1",
      [INSTITUTION.id],
    );
    assert.equal(documents.length, 1, "only the surviving document imported");
    assert.equal(documents[0].doc_type, "confirmation");
    assert.ok(await count(client, "transactions") > 0);
  },
);

test(
  "a SIGNED_OUT-class failure stops the run instead of skipping it: what committed before stays committed, and nothing after it is even attempted",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(
      join(tmpdir(), "kith-finance-run-signed-out-raw-"),
    );
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    // doc-stmt-2025-q1 acquires first and commits (commitEvery defaults to
    // 1); doc-stmt-2025-q2 then fails the way a lost browser session does
    // (bridge.mjs's own SIGNED_OUT wording); doc-conf-2025-02-10 comes last
    // in the selection and must never even be attempted -- a lost session
    // fails every remaining document pull the same way within milliseconds
    // (F1-43), so continuing through thousands of them is pure waste.
    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeFailingDocumentFixtures(
        t,
        "doc-stmt-2025-q2",
        "SIGNED_OUT: the tab left the app origin (a session timeout redirects to the login page); sign in again and retry",
      );
    const selectionPath = writeSelection(fixturesDir, [
      {
        accountId: ACCOUNT.id,
        docType: "statement",
        docDate: null,
        selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q1" },
      },
      {
        accountId: ACCOUNT.id,
        docType: "statement",
        docDate: null,
        selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q2" },
      },
      {
        accountId: ACCOUNT.id,
        docType: "confirmation",
        docDate: null,
        selection: {
          kind: "trade_confirmation",
          externalId: "doc-conf-2025-02-10",
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

    assert.throws(
      () => runImport(),
      (error) => {
        assert.match(String(error.stderr), /run stopped: the browser session is gone/);
        assert.match(String(error.stderr), /SIGNED_OUT/);
        assert.match(
          String(error.stderr),
          /1 document pull\(s\) were committed before this/,
        );
        return true;
      },
    );

    const documents = await all(
      client,
      "SELECT doc_type FROM documents WHERE institution_id = $1",
      [INSTITUTION.id],
    );
    assert.equal(
      documents.length,
      1,
      "only the document acquired before the SIGNED_OUT failure was committed",
    );
    assert.equal(documents[0].doc_type, "statement");
    assert.ok(await count(client, "transactions") > 0);
    assert.equal(
      await count(client, "documents", "WHERE doc_type = $1", ["confirmation"]),
      0,
      "the pull after the failing one was never attempted",
    );

    // Sign in again, rerun the same selection: the committed document is
    // skipped and the run reaches the point of failure again unchanged
    // (still doc-stmt-2025-q2 itself, since the fixture always fails it).
    assert.throws(
      () => runImport(),
      (error) => {
        assert.match(String(error.stderr), /run stopped: the browser session is gone/);
        return true;
      },
    );
    assert.equal(
      await count(client, "documents", "WHERE institution_id = $1", [
        INSTITUTION.id,
      ]),
      1,
      "the rerun does not double-commit the already-imported document, and stops at the same failing one",
    );
  },
);

// F1-64. The synthetic session above has no live handle, so it already exits
// promptly regardless of this fix -- it cannot reproduce the defect (a real
// bridge session's CDP WebSocket and keep-alive interval, seen live to hang
// the process 40+ minutes past a "session is gone" stop). This session
// stands in for that: a ref'd interval it never clears on its own, only from
// its own `close()`, exactly like adapter-morgan-stanley/src/bridge.mjs's.
// Without run.ts calling `close()` on the stop path, this interval alone
// keeps the process alive indefinitely.
test(
  "closes the session on the stop path so the process exits promptly instead of hanging on an open handle",
  { skip },
  async (t) => {
    const { schema } = await seededSchema(t);

    const rawDir = mkdtempSync(
      join(tmpdir(), "kith-finance-run-close-session-raw-"),
    );
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath } = writeAdapterFixtures(t);
    const sessionModulePath = join(fixturesDir, "session-lingering.mjs");
    writeFileSync(
      sessionModulePath,
      `import { createSyntheticSession } from ${JSON.stringify(distIndexUrl)};\n` +
        `export default function buildSession() {\n` +
        `  const base = createSyntheticSession();\n` +
        `  const handle = setInterval(() => {}, 60000);\n` +
        `  return {\n` +
        `    ...base,\n` +
        `    async fetchBytes(path, query) {\n` +
        `      if (path === ${JSON.stringify("/documents/doc-stmt-2025-q1")}) {\n` +
        `        throw new Error(${JSON.stringify(
          "SIGNED_OUT: the tab left the app origin (a session timeout redirects to the login page); sign in again and retry",
        )});\n` +
        `      }\n` +
        `      return base.fetchBytes(path, query);\n` +
        `    },\n` +
        `    close() { clearInterval(handle); },\n` +
        `  };\n` +
        `}\n`,
    );
    const selectionPath = writeSelection(fixturesDir, [
      {
        accountId: ACCOUNT.id,
        docType: "statement",
        docDate: null,
        selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q1" },
      },
    ]);

    const start = Date.now();
    assert.throws(
      () =>
        execFileSync(
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
            // Only a guard against this test itself hanging if the fix
            // regresses -- a passing run exits in well under this.
            timeout: 5000,
          },
        ),
      (error) => {
        assert.match(String(error.stderr), /run stopped: the browser session is gone/);
        return true;
      },
    );
    assert.ok(
      Date.now() - start < 5000,
      "the process must exit on its own, closing the session's interval, not merely be killed by execFileSync's timeout",
    );
  },
);

test(
  "F1-54: a success between two runs of failures resets the circuit breaker's consecutive count",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(
      join(tmpdir(), "kith-finance-run-breaker-reset-raw-"),
    );
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    // Nine failures, then a success (a different document), then nine more
    // failures: eighteen failures total but never ten *in a row*, so the
    // breaker must not trip and the run must reach the end normally.
    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeFailingDocumentFixtures(t, "doc-stmt-2025-q2");
    const failingEntry = {
      accountId: ACCOUNT.id,
      docType: "statement",
      docDate: null,
      selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q2" },
    };
    const selectionPath = writeSelection(fixturesDir, [
      ...Array.from({ length: 9 }, () => failingEntry),
      {
        accountId: ACCOUNT.id,
        docType: "confirmation",
        docDate: null,
        selection: {
          kind: "trade_confirmation",
          externalId: "doc-conf-2025-02-10",
        },
      },
      ...Array.from({ length: 9 }, () => failingEntry),
    ]);
    const runImport = makeRunner({
      adapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });

    // Does not throw: the breaker never sees ten consecutive failures.
    const output = runImport();
    assert.match(output, /^mode: committed$/m);
    assert.match(output, /document pulls acquired: 1/);
    assert.match(output, /document pulls failed: 18/);

    const documents = await all(
      client,
      "SELECT doc_type FROM documents WHERE institution_id = $1",
      [INSTITUTION.id],
    );
    assert.equal(documents.length, 1, "the surviving document between the two failure runs imported");
    assert.equal(documents[0].doc_type, "confirmation");
  },
);

// --- F1-62: --acquire-only, --concurrency ---------------------------------

function documentTierSelection(fixturesDir) {
  return writeSelection(fixturesDir, [
    {
      accountId: ACCOUNT.id,
      docType: "statement",
      docDate: null,
      selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q1" },
    },
    {
      accountId: ACCOUNT.id,
      docType: "confirmation",
      docDate: null,
      selection: { kind: "trade_confirmation", externalId: "doc-conf-2025-02-10" },
    },
  ]);
}

test(
  "--acquire-only retains documents with no parse and no rows and no gate, and a later reparse parses them",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);
    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-acquire-only-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } = writeAdapterFixtures(t);
    const selectionPath = documentTierSelection(fixturesDir);
    const runImport = makeRunner({ adapterModulePath, sessionModulePath, selectionPath, schema, rawDir });

    const output = runImport(["--acquire-only"]);
    assert.match(output, /^mode: committed \(--acquire-only: no parse, no rows, no gate\)$/m);
    assert.match(output, /document pulls retained: 2/);
    assert.match(output, /document pulls skipped \(already retained\): 0/);
    assert.match(output, /rows inserted: 0/);
    assert.match(
      output,
      /whole-archive gate pass: skipped \(--acquire-only: no gate runs in acquire-only mode\)/,
    );

    const documents = await all(
      client,
      "SELECT doc_type, parsed_ok, retained_sha256, retained_byte_length, media_type FROM documents " +
        "WHERE institution_id = $1 ORDER BY doc_type",
      [INSTITUTION.id],
    );
    assert.equal(documents.length, 2, "both documents were retained");
    for (const doc of documents) {
      assert.equal(doc.parsed_ok, false, "acquire-only never parses");
      assert.ok(doc.retained_sha256, "retained bytes are recorded");
      assert.ok(doc.retained_byte_length > 0);
      assert.ok(doc.media_type);
    }
    assert.equal(await count(client, "transactions"), 0, "no rows: acquire-only never converts or imports");
    assert.equal(await count(client, "positions"), 0);
    assert.equal(await count(client, "review_items"), 0, "no review item either -- nothing was ever parsed");

    // A second acquire-only pass over the same selection is a no-op against
    // the already-retained documents, reported as skipped rather than
    // silently reinserting.
    const second = runImport(["--acquire-only"]);
    assert.match(second, /document pulls retained: 0/);
    assert.match(second, /document pulls skipped \(already retained\): 2/);
    assert.equal(await count(client, "documents"), 2);

    // reparse (F1-55): no browser, no network -- it reads the retained bytes
    // straight from the raw tree and, under the real (unbroken) adapter,
    // parses both this time.
    const runReparse = makeReparseRunner({ adapterModulePath, schema, rawDir });
    const reparseOutput = runReparse();
    assert.match(reparseOutput, /^mode: reparse$/m);
    assert.match(reparseOutput, /documents reparsed: 2/);
    assert.match(reparseOutput, /documents now parsed: 2/);
    assert.match(reparseOutput, /documents still unparsed: 0/);

    const parsedNow = await all(
      client,
      "SELECT parsed_ok FROM documents WHERE institution_id = $1",
      [INSTITUTION.id],
    );
    assert.ok(parsedNow.every((row) => row.parsed_ok === true));
    assert.ok(await count(client, "transactions") > 0, "reparse actually imported activity rows");
    assert.ok(await count(client, "positions") > 0, "doc-stmt-2025-q1 carries a HOLDINGS section too");
  },
);

test(
  "--acquire-only refuses a selection that also names a structured_api/tabular_export pull",
  { skip },
  async (t) => {
    const { schema } = await seededSchema(t);
    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-acquire-only-mixed-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } = writeAdapterFixtures(t);
    const selectionPath = writeSelection(fixturesDir, [
      {
        accountId: ACCOUNT.id,
        docType: "statement",
        docDate: null,
        selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q1" },
      },
      {
        accountId: ACCOUNT.id,
        docType: "activity_pull",
        docDate: null,
        selection: { kind: "structured_api", periodStart: "2025-01-01", periodEnd: "2025-04-01" },
      },
    ]);
    const runImport = makeRunner({ adapterModulePath, sessionModulePath, selectionPath, schema, rawDir });

    assert.throws(
      () => runImport(["--acquire-only"]),
      (error) => {
        assert.match(String(error.stderr), /--acquire-only supports only pdf_statement\/trade_confirmation/);
        assert.match(String(error.stderr), /structured_api/);
        return true;
      },
    );
  },
);

test(
  "--concurrency 3 overlaps document downloads and still commits each document exactly once",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);
    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-concurrency-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const hwmDir = mkdtempSync(join(tmpdir(), "kith-finance-concurrency-hwm-"));
    t.after(() => rmSync(hwmDir, { recursive: true, force: true }));
    const hwmFilePath = join(hwmDir, "high-water-mark.txt");

    const { fixturesDir, adapterModulePath, sessionModulePath } = writeOverlappingDownloadFixtures(t, {
      delayMs: 150,
      hwmFilePath,
    });
    // The fixture only has three documents; each is named twice (six pulls)
    // so a pool of three lanes has real work to overlap on, and the repeat
    // proves a document downloaded more than once is still committed once.
    const entries = [
      { docType: "statement", kind: "pdf_statement", externalId: "doc-stmt-2025-q1" },
      { docType: "statement", kind: "pdf_statement", externalId: "doc-stmt-2025-q2" },
      { docType: "confirmation", kind: "trade_confirmation", externalId: "doc-conf-2025-02-10" },
    ];
    const selectionPath = writeSelection(fixturesDir, [
      ...entries,
      ...entries,
    ].map(({ docType, kind, externalId }) => ({
      accountId: ACCOUNT.id,
      docType,
      docDate: null,
      selection: { kind, externalId },
    })));
    const runImport = makeRunner({ adapterModulePath, sessionModulePath, selectionPath, schema, rawDir });

    const output = runImport(["--concurrency", "3"]);
    assert.match(output, /^mode: committed$/m);
    assert.match(output, /document pulls acquired: 3/, "one commit per distinct document");
    assert.match(output, /document pulls skipped \(already imported\): 3/, "the repeat of each document dedupes");
    assert.match(output, /document pulls failed: 0/);

    const highWaterMark = Number(readFileSync(hwmFilePath, "utf8"));
    assert.ok(
      highWaterMark >= 2,
      `expected more than one download in flight at once under --concurrency 3, saw a high-water mark of ${highWaterMark}`,
    );

    assert.equal(await count(client, "documents"), 3, "three distinct documents, however many times each was downloaded");
    assert.ok(await count(client, "transactions") > 0);
  },
);

test(
  "the consecutive-failure breaker trips across concurrent streams (--concurrency 3)",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);
    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-breaker-concurrency-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } = writeAdapterFixtures(t);
    // A document id the fixture has never heard of fails synchronously
    // (syntheticTrust's acquireDocument: "unknown document ..."), the same
    // as any other acquisition failure from the breaker's point of view.
    const failingEntry = {
      accountId: ACCOUNT.id,
      docType: "statement",
      docDate: null,
      selection: { kind: "pdf_statement", externalId: "doc-bogus-does-not-exist" },
    };
    const selectionPath = writeSelection(
      fixturesDir,
      Array.from({ length: 12 }, () => failingEntry),
    );
    const runImport = makeRunner({ adapterModulePath, sessionModulePath, selectionPath, schema, rawDir });

    assert.throws(
      () => runImport(["--concurrency", "3"]),
      (error) => {
        assert.match(
          String(error.stderr),
          /run stopped: 10 consecutive document pulls failed/,
          "the breaker's shared count -- across every lane, not per lane -- is what trips it",
        );
        return true;
      },
    );
    assert.equal(await count(client, "documents"), 0, "nothing ever acquired, so nothing was ever committed");
  },
);

// --- reparse (F1-55) ---------------------------------------------------

function reparseSelection(fixturesDir) {
  return writeSelection(fixturesDir, [
    {
      accountId: ACCOUNT.id,
      docType: "statement",
      docDate: null,
      selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q1" },
    },
  ]);
}

test(
  "reparse turns an unparsed document into a parsed one and resolves its review item",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-reparse-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, brokenAdapterModulePath, sessionModulePath } =
      writeReparseAdapterFixtures(t);
    const selectionPath = reparseSelection(fixturesDir);

    // First pass under the broken extractor: the document is retained
    // (ground rule 1) but not parsed -- doc-stmt-2025-q1 is the fixture with
    // a HOLDINGS section (positions, a balance, a liability), so this proves
    // reparse recovers all of it, not only activity rows.
    const runBrokenImport = makeRunner({
      adapterModulePath: brokenAdapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });
    const firstOutput = runBrokenImport();
    assert.match(firstOutput, /^mode: committed$/m);

    const [before] = await all(client, "SELECT id, parsed_ok FROM documents");
    assert.equal(before.parsed_ok, false);
    assert.equal(await count(client, "positions"), 0);
    const openBefore = await all(
      client,
      "SELECT status FROM review_items WHERE kind = 'document_unparsed' AND source_document_id = $1",
      [before.id],
    );
    assert.equal(openBefore.length, 1);
    assert.equal(openBefore[0].status, "open");

    // Reparse under the fixed adapter: no --session, no --selection, no
    // network -- it reads the retained bytes straight from the raw tree.
    const runReparse = makeReparseRunner({ adapterModulePath, schema, rawDir });
    const reparseOutput = runReparse();
    assert.match(reparseOutput, /^mode: reparse$/m);
    assert.match(reparseOutput, /documents reparsed: 1/);
    assert.match(reparseOutput, /documents now parsed: 1/);
    assert.match(reparseOutput, /documents still unparsed: 0/);
    const insertedMatch = reparseOutput.match(/rows inserted: (\d+)/);
    assert.ok(insertedMatch, "prints rows inserted");
    assert.ok(Number(insertedMatch[1]) > 0, "the now-readable statement inserted rows");
    assert.match(reparseOutput, /review items resolved: 1/);

    const [after] = await all(client, "SELECT parsed_ok FROM documents WHERE id = $1", [
      before.id,
    ]);
    assert.equal(after.parsed_ok, true);
    assert.equal(await count(client, "positions"), 4);
    assert.equal(await count(client, "balances"), 1);
    assert.equal(await count(client, "liabilities"), 1);
    assert.ok(await count(client, "transactions") > 0);

    const openAfter = await all(
      client,
      "SELECT status, resolution_note, resolved_at FROM review_items WHERE kind = 'document_unparsed' AND source_document_id = $1",
      [before.id],
    );
    assert.equal(openAfter.length, 1, "resolved in place, never duplicated");
    assert.equal(openAfter[0].status, "resolved");
    assert.match(openAfter[0].resolution_note, /resolved on reimport/);
    assert.ok(openAfter[0].resolved_at, "resolved_at is set");

    // A second reparse pass, still under the fixed adapter, is a no-op: the
    // document is already parsed, so nothing reopens or duplicates.
    const secondReparseOutput = runReparse();
    assert.match(secondReparseOutput, /rows inserted: 0/);
    assert.match(secondReparseOutput, /review items resolved: 0/);
    assert.equal(
      await count(client, "review_items", "WHERE kind = 'document_unparsed'"),
      1,
    );
  },
);

test(
  "reparse re-imports an already-parsed document with zero inserts",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-reparse-noop-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeReparseAdapterFixtures(t);
    const selectionPath = reparseSelection(fixturesDir);

    // The fixed adapter parses cleanly the first time -- no broken adapter
    // involved in this test at all.
    const runImport = makeRunner({
      adapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });
    runImport();
    assert.equal(await count(client, "documents", "WHERE parsed_ok = TRUE"), 1);
    const transactionsBefore = await count(client, "transactions");
    const positionsBefore = await count(client, "positions");
    assert.ok(transactionsBefore > 0);
    assert.ok(positionsBefore > 0);

    const runReparse = makeReparseRunner({ adapterModulePath, schema, rawDir });
    const output = runReparse();
    assert.match(output, /documents reparsed: 1/);
    assert.match(output, /rows inserted: 0/);
    const dedupMatch = output.match(/rows deduplicated: (\d+)/);
    assert.ok(dedupMatch, "prints rows deduplicated");
    assert.ok(
      Number(dedupMatch[1]) > 0,
      "the already-parsed document's rows are all deduplicated, not silently dropped",
    );
    assert.match(output, /review items resolved: 0/);

    assert.equal(await count(client, "transactions"), transactionsBefore);
    assert.equal(await count(client, "positions"), positionsBefore);
    assert.equal(await count(client, "review_items", "WHERE kind = 'document_unparsed'"), 0);
  },
);

test(
  "reparse leaves a still-unparsable document unparsed, with no duplicate review item",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-reparse-stuck-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, brokenAdapterModulePath, sessionModulePath } =
      writeReparseAdapterFixtures(t);
    const selectionPath = reparseSelection(fixturesDir);

    const runBrokenImport = makeRunner({
      adapterModulePath: brokenAdapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });
    runBrokenImport();
    assert.equal(
      await count(client, "review_items", "WHERE kind = 'document_unparsed'"),
      1,
    );

    // Reparse under the *same* still-broken adapter: it fails the identical
    // way on the identical retained bytes.
    const runReparse = makeReparseRunner({
      adapterModulePath: brokenAdapterModulePath,
      schema,
      rawDir,
    });
    const output = runReparse();
    assert.match(output, /documents reparsed: 1/);
    assert.match(output, /documents now parsed: 0/);
    assert.match(output, /documents still unparsed: 1/);
    assert.match(output, /review items resolved: 0/);

    assert.equal(await count(client, "documents", "WHERE parsed_ok = FALSE"), 1);
    const items = await all(
      client,
      "SELECT status FROM review_items WHERE kind = 'document_unparsed'",
    );
    assert.equal(items.length, 1, "no duplicate review item opened on the still-unparsed rerun");
    assert.equal(items[0].status, "open");
  },
);

test(
  "F1-60: a reparse that reports a different parse note rewrites the one item in place",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-reparse-renote-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, brokenAdapterModulePath, rebrokenAdapterModulePath, sessionModulePath } =
      writeReparseAdapterFixtures(t);
    const selectionPath = reparseSelection(fixturesDir);

    makeRunner({
      adapterModulePath: brokenAdapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    })();
    const [before] = await all(
      client,
      "SELECT id, reason, raw_value FROM review_items WHERE kind = 'document_unparsed'",
    );
    assert.match(before.reason, /synthetic extractor outage/);

    // The same immutable bytes, read by an extractor that gets no further but
    // says something different about why.
    const output = makeReparseRunner({
      adapterModulePath: rebrokenAdapterModulePath,
      schema,
      rawDir,
    })();
    assert.match(output, /documents still unparsed: 1/);
    assert.match(output, /review items updated: 1/);
    assert.match(output, /review items resolved: 0/);
    assert.match(output, /review items opened: 0/);

    const after = await all(
      client,
      "SELECT id, status, reason, raw_value FROM review_items WHERE kind = 'document_unparsed'",
    );
    assert.equal(after.length, 1, "one item per document: rewritten, never duplicated");
    assert.equal(after[0].id, before.id, "the same row, not a replacement");
    assert.equal(after[0].status, "open");
    assert.match(after[0].reason, /2 holdings block\(s\) left unparsed/);
    assert.equal(after[0].raw_value, after[0].reason, "raw_value carries the note it was opened on");

    // A rerun under that same second extractor changes nothing again: the
    // note it reports is now the note the item already carries.
    const again = makeReparseRunner({
      adapterModulePath: rebrokenAdapterModulePath,
      schema,
      rawDir,
    })();
    assert.match(again, /review items updated: 0/);
    assert.equal(await count(client, "review_items", "WHERE kind = 'document_unparsed'"), 1);
  },
);

test(
  "F1-60: a note change never reopens or overwrites an item a reviewer already closed",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-reparse-dismissed-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, brokenAdapterModulePath, rebrokenAdapterModulePath, sessionModulePath } =
      writeReparseAdapterFixtures(t);
    const selectionPath = reparseSelection(fixturesDir);

    makeRunner({
      adapterModulePath: brokenAdapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    })();
    await client.query(
      "UPDATE review_items SET status = 'dismissed' WHERE kind = 'document_unparsed'",
    );

    const output = makeReparseRunner({
      adapterModulePath: rebrokenAdapterModulePath,
      schema,
      rawDir,
    })();
    assert.match(output, /review items updated: 0/);

    const items = await all(
      client,
      "SELECT status, reason FROM review_items WHERE kind = 'document_unparsed'",
    );
    assert.equal(items.length, 1, "a dismissal is not a reason to open a second item");
    assert.equal(items[0].status, "dismissed");
    assert.match(items[0].reason, /synthetic extractor outage/, "the reviewer's row is untouched");
  },
);

test(
  "reparse --only-unparsed skips a document that already parsed",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-reparse-onlyunparsed-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, adapterModulePath, sessionModulePath } =
      writeReparseAdapterFixtures(t);
    const selectionPath = reparseSelection(fixturesDir);

    const runImport = makeRunner({
      adapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });
    runImport();
    assert.equal(await count(client, "documents", "WHERE parsed_ok = TRUE"), 1);

    const runReparse = makeReparseRunner({ adapterModulePath, schema, rawDir });
    const output = runReparse(["--only-unparsed"]);
    assert.match(output, /mode: reparse \(--only-unparsed\)/);
    assert.match(output, /documents considered: 0/);
    assert.match(output, /documents reparsed: 0/);
  },
);

test(
  "F1-66: an import stores the retained text in the archive beside the raw tree file, and a reparse of the same document rewrites neither",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);

    const rawDir = mkdtempSync(join(tmpdir(), "kith-finance-retained-text-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));

    const { fixturesDir, textAdapterModulePath, sessionModulePath } =
      writeExtractedTextAdapterFixtures(t);
    const selectionPath = reparseSelection(fixturesDir);

    const runImport = makeRunner({
      adapterModulePath: textAdapterModulePath,
      sessionModulePath,
      selectionPath,
      schema,
      rawDir,
    });
    assert.match(runImport(), /^mode: committed$/m);

    // The row is keyed on the text's own sha, which is exactly the hash the
    // raw tree file is content-addressed under: one identity, two places.
    const sha256 = sha256HexOf(Buffer.from(EXTRACTED_TEXT, "utf8"));
    const [stored] = await all(
      client,
      "SELECT sha256, byte_length::text AS byte_length, codepoint_length::text AS codepoint_length, content, created_at FROM retained_texts",
    );
    assert.ok(stored, "the import wrote the retained text into the archive");
    assert.equal(stored.sha256, sha256);
    assert.equal(
      Number(stored.byte_length),
      Buffer.byteLength(EXTRACTED_TEXT, "utf8"),
    );
    assert.equal(
      Number(stored.codepoint_length),
      Array.from(EXTRACTED_TEXT).length,
    );
    assert.equal(stored.content.toString("utf8"), EXTRACTED_TEXT);

    // The same bytes really are on disk under the path the sha names, which
    // is what the raw-tree fallback and the backfill both resolve.
    assert.equal(
      readFileSync(join(rawDir, "archive", "v1", SPACE_ID, textRelativePath(sha256)), "utf8"),
      EXTRACTED_TEXT,
    );

    // Reparse re-extracts the identical text. Content addressing makes that a
    // no-op rather than a conflict: still one row, still the original one.
    const runReparse = makeReparseRunner({
      adapterModulePath: textAdapterModulePath,
      schema,
      rawDir,
    });
    assert.match(runReparse(), /documents reparsed: 1/);
    const rows = await all(
      client,
      "SELECT sha256, created_at FROM retained_texts",
    );
    assert.equal(rows.length, 1, "idempotent on sha: no second row, no error");
    assert.deepEqual(rows[0].created_at, stored.created_at);
  },
);
