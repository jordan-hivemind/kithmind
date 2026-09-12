// F1-56. The second account key space, end to end: learning which printed
// account number belongs to which account, resolving a row's key against
// the aliases that learning wrote, and moving the rows the old resolution
// misfiled.
//
// Everything here is synthetic. The two "printed account numbers" are
// invented values in the shape a statement prints, the institution is
// Thistlebrook Trust (the reference adapter's invented institution), and the
// documents are the same synthetic fixtures every other suite uses. What is
// new is the adapter fixture below: a wrapper around `syntheticAdapter`
// whose `parse()` stamps each parsed row and holding with a printed account
// number the adapter's own `discover()` never reports -- exactly the shape
// the real institution has, where the site's API keys accounts one way and
// its statements print another.

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
  maskAccountKey,
  planAccountAliases,
  SYNTHETIC_INSTITUTION_NAME,
  SYNTHETIC_INSTITUTION_SLUG,
} from "../dist/index.js";
import { all, count, one, skip, testSchemaName } from "./helpers/pgArchive.mjs";

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;

const INSTITUTION = {
  id: "inst_alias_test",
  name: SYNTHETIC_INSTITUTION_NAME,
  slug: SYNTHETIC_INSTITUTION_SLUG,
};
/** The two accounts the reference adapter's `discover()` reports, by its own
 * external key -- the "API key" space. */
const ACCOUNT_A = { id: "acct_alias_a", externalKey: "acct-brokerage-01", last4: "4471" };
const ACCOUNT_B = { id: "acct_alias_b", externalKey: "acct-trust-01", last4: "9902" };

/** The "statement number" space: invented numbers in the printed shape,
 * related to nothing above by any digit rule -- which is the whole point. */
const NUMBER_A = "111-222222-333";
const NUMBER_B = "444-555555-333";

/** Substrings that identify each synthetic document by its own text, so the
 * stamping adapter below can give each one its own printed numbers. */
const FEBRUARY_STATEMENT = "2025-02-01..2025-02-28";
const MARCH_STATEMENT = "2025-03-01..2025-03-31";
const CONFIRMATION = "trade confirmation";

const SPACE_ID = "space_alias_test";

const distIndexUrl = pathToFileURL(
  fileURLToPath(new URL("../dist/index.js", import.meta.url)),
).href;
const runScript = fileURLToPath(new URL("../dist/run.js", import.meta.url));

/**
 * A throwaway schema with the institution and both accounts provisioned,
 * each carrying the external key `discover()` reports for it (so
 * `resolveDiscoveredAccounts` upserts onto these rows rather than minting
 * new ones) and a base currency (which a discovered account has none of).
 */
async function seededSchema(t) {
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
  for (const account of [ACCOUNT_A, ACCOUNT_B]) {
    await client.query(
      `INSERT INTO accounts (id, institution_id, external_key, acct_last4, display_name, base_currency)
       VALUES ($1, $2, $3, $4, $5, 'USD')`,
      [account.id, INSTITUTION.id, account.externalKey, account.last4, "synthetic"],
    );
  }
  return { schema, client };
}

/**
 * The adapter under test: `syntheticAdapter` with one thing added, a
 * `parse()` that stamps every row and holding it returns with a printed
 * account number chosen by which document it is reading.
 *
 * `numbersByMarker` maps a substring of a document's own text to the numbers
 * that document prints. One number is a single-account statement; two is a
 * consolidated one, and the holdings are dealt between them -- positions
 * alternating, the balance taking the *second* number so the balances path
 * is exercised as well as the positions one, the liability the first.
 *
 * F1-56b. `holdingsByMarker` optionally *replaces* a document's parsed
 * holdings with an explicit list, each entry naming the number it is printed
 * under. That is what lets two documents state the identical holding -- a
 * consolidated statement and the account's own statement, the shape that
 * produces a misfiled row the target account already holds. Every hashed
 * field is spelled out here, because "identical" has to mean identical to
 * `positionHash`/`balanceHash`, not merely similar.
 */
function writeStampingAdapter(
  dir,
  numbersByMarker,
  { holdingsByMarker = {}, name = "adapter-stamped.mjs" } = {},
) {
  const path = join(dir, name);
  writeFileSync(
    path,
    `import { syntheticAdapter } from ${JSON.stringify(distIndexUrl)};\n` +
      `const NUMBERS = ${JSON.stringify(numbersByMarker)};\n` +
      `const HOLDINGS = ${JSON.stringify(holdingsByMarker)};\n` +
      `const pick = (numbers, i) => numbers[i % numbers.length];\n` +
      `function locator(kind, i) {\n` +
      `  return { row: { source: kind, index: 1, field: "explicit holding " + i } };\n` +
      `}\n` +
      `function explicitHoldings(spec, kind) {\n` +
      `  return {\n` +
      `    positions: (spec.positions ?? []).map((p, i) => ({\n` +
      `      sourceDocument: kind,\n` +
      `      accountExternalKey: p.key,\n` +
      `      asOf: p.asOf,\n` +
      `      instrument: { symbol: p.symbol, cusip: p.cusip, isin: null, name: p.name },\n` +
      `      quantity: p.quantity,\n` +
      `      price: null,\n` +
      `      marketValue: p.marketValue,\n` +
      `      marketValueNote: null,\n` +
      `      costBasis: p.costBasis,\n` +
      `      unrealized: null,\n` +
      `      currency: "USD",\n` +
      `      valuationBasis: "market_price",\n` +
      `      valuationNote: "synthetic explicit holding",\n` +
      `      locators: locator(kind, "p" + i),\n` +
      `    })),\n` +
      `    balances: (spec.balances ?? []).map((b, i) => ({\n` +
      `      sourceDocument: kind,\n` +
      `      accountExternalKey: b.key,\n` +
      `      asOf: b.asOf,\n` +
      `      totalValue: b.totalValue,\n` +
      `      totalValueNote: null,\n` +
      `      cash: b.cash,\n` +
      `      currency: "USD",\n` +
      `      periodStartValue: null,\n` +
      `      periodEndValue: null,\n` +
      `      locators: locator(kind, "b" + i),\n` +
      `    })),\n` +
      `    liabilities: [],\n` +
      `  };\n` +
      `}\n` +
      `function stamp(parsed, numbers, spec, kind) {\n` +
      `  return {\n` +
      `    ...parsed,\n` +
      `    activity: parsed.activity.map((row) => ({ ...row, accountExternalKey: numbers[0] })),\n` +
      `    holdings: spec !== undefined ? explicitHoldings(spec, kind) : {\n` +
      `      positions: parsed.holdings.positions.map((p, i) => ({ ...p, accountExternalKey: pick(numbers, i) })),\n` +
      `      balances: parsed.holdings.balances.map((b, i) => ({ ...b, accountExternalKey: pick(numbers, i + 1) })),\n` +
      `      liabilities: parsed.holdings.liabilities.map((l, i) => ({ ...l, accountExternalKey: pick(numbers, i) })),\n` +
      `    },\n` +
      `  };\n` +
      `}\n` +
      `export default {\n` +
      `  ...syntheticAdapter,\n` +
      `  async parse(rawFile) {\n` +
      `    const parsed = await syntheticAdapter.parse(rawFile);\n` +
      `    const text = new TextDecoder().decode(rawFile.bytes);\n` +
      `    for (const [marker, numbers] of Object.entries(NUMBERS)) {\n` +
      `      if (text.includes(marker)) return stamp(parsed, numbers, HOLDINGS[marker], rawFile.kind);\n` +
      `    }\n` +
      `    return parsed;\n` +
      `  },\n` +
      `};\n`,
  );
  return path;
}

function writeSessionFixture(dir) {
  const path = join(dir, "session.mjs");
  writeFileSync(
    path,
    `import { createSyntheticSession } from ${JSON.stringify(distIndexUrl)};\n` +
      `export default function buildSession() {\n  return createSyntheticSession();\n}\n`,
  );
  return path;
}

/**
 * Which account each document is pulled under. The default -- February and
 * March statements under A, the confirmation under B -- is the corpus most
 * tests here use; the duplicate-removal test files the March statement under
 * B instead, so that account has a statement of its own stating holdings the
 * consolidated February statement also states.
 */
const DEFAULT_PULL_ACCOUNTS = {
  february: ACCOUNT_A.externalKey,
  march: ACCOUNT_A.externalKey,
  confirmation: ACCOUNT_B.externalKey,
};

function writeSelection(dir, pullAccounts = DEFAULT_PULL_ACCOUNTS) {
  const path = join(dir, "selection.json");
  writeFileSync(
    path,
    JSON.stringify({
      pulls: [
        {
          accountExternalKey: pullAccounts.february,
          docType: "statement",
          docDate: "2025-02-28",
          selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q1" },
        },
        {
          accountExternalKey: pullAccounts.march,
          docType: "statement",
          docDate: "2025-03-31",
          selection: { kind: "pdf_statement", externalId: "doc-stmt-2025-q2" },
        },
        {
          accountExternalKey: pullAccounts.confirmation,
          docType: "confirmation",
          docDate: "2025-02-10",
          selection: {
            kind: "trade_confirmation",
            externalId: "doc-conf-2025-02-10",
          },
        },
      ],
    }),
  );
  return path;
}

function makeEnv(schema, rawDir) {
  return {
    ...process.env,
    FINANCE_ARCHIVE_DATABASE_URL: url,
    FINANCE_ARCHIVE_SCHEMA: schema,
    FINANCE_ARCHIVE_RAW_TREE_ROOT: rawDir,
    FINANCE_ARCHIVE_SPACE_ID: SPACE_ID,
  };
}

function runCommand(env, args) {
  return execFileSync(process.execPath, [runScript, ...args], {
    env,
    encoding: "utf8",
  });
}

/**
 * Everything a test needs: a schema, a raw tree, the stamping adapter for
 * the numbers this test wants printed, and the corpus already imported once
 * under the pre-alias resolution.
 */
async function importedArchive(t, numbersByMarker, options = {}) {
  const { schema, client } = await seededSchema(t);
  const rawDir = mkdtempSync(join(tmpdir(), "kith-alias-raw-"));
  t.after(() => rmSync(rawDir, { recursive: true, force: true }));
  const fixturesDir = mkdtempSync(join(tmpdir(), "kith-alias-fixtures-"));
  t.after(() => rmSync(fixturesDir, { recursive: true, force: true }));

  const adapterPath = writeStampingAdapter(fixturesDir, numbersByMarker, {
    holdingsByMarker: options.holdingsByMarker,
  });
  const sessionPath = writeSessionFixture(fixturesDir);
  const selectionPath = writeSelection(fixturesDir, options.pullAccounts);
  const env = makeEnv(schema, rawDir);

  runCommand(env, [
    "--adapter",
    adapterPath,
    "--session",
    sessionPath,
    "--selection",
    selectionPath,
    "--now",
    "2025-05-01T00:00:00.000Z",
  ]);

  return { schema, client, env, adapterPath };
}

/** The number in a `label: <n>` line of a command's summary. */
function summaryValue(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}: (-?\\d+)$`, "m").exec(output);
  assert.notEqual(match, null, `no "${label}" line in:\n${output}`);
  return Number(match[1]);
}

// --- the rule itself (no database) -----------------------------------------

test("a number is learned only from documents that print exactly one number", () => {
  const learning = planAccountAliases(
    [
      // A consolidated statement: pulled under one account, printing two
      // numbers. Evidence for neither.
      { accountId: "acct_a", keys: [NUMBER_A, NUMBER_B] },
      // A single-account statement: its printed number is its account's.
      { accountId: "acct_a", keys: [NUMBER_A] },
      { accountId: "acct_a", keys: [NUMBER_A] },
    ],
    () => false,
  );
  assert.equal(learning.seen, 2);
  assert.deepEqual([...learning.accepted], [[NUMBER_A, "acct_a"]]);
  assert.deepEqual(learning.ambiguous, []);
  assert.deepEqual(learning.unmapped, [NUMBER_B]);
});

test("two single-number documents that disagree make a number ambiguous, never a winner", () => {
  const learning = planAccountAliases(
    [
      { accountId: "acct_a", keys: [NUMBER_A] },
      { accountId: "acct_b", keys: [NUMBER_A] },
    ],
    () => false,
  );
  assert.equal(learning.accepted.size, 0);
  assert.deepEqual(learning.ambiguous, [NUMBER_A]);
});

test("a document printing one unknown number alongside one known number is not single-account", () => {
  const learning = planAccountAliases(
    [{ accountId: "acct_a", keys: [NUMBER_A, "acct-brokerage-01"] }],
    (key) => key === "acct-brokerage-01",
  );
  assert.equal(learning.accepted.size, 0);
  assert.deepEqual(learning.unmapped, [NUMBER_A]);
});

test("an institution-wide document names no account, so it is evidence for nothing", () => {
  const learning = planAccountAliases([{ accountId: null, keys: [NUMBER_A] }], () => false);
  assert.equal(learning.accepted.size, 0);
  assert.deepEqual(learning.unmapped, [NUMBER_A]);
});

test("a masked key shows its shape and nothing else", () => {
  const masked = maskAccountKey(NUMBER_A);
  assert.match(masked, /^###-######-### \[[0-9a-f]{8}\]$/);
  assert.equal(
    masked.slice(0, masked.indexOf(" ")),
    "###-######-###",
    "no digit of the key survives masking",
  );
  assert.equal(masked, maskAccountKey(NUMBER_A), "stable across calls");
  assert.notEqual(masked, maskAccountKey(NUMBER_B), "two keys stay distinguishable");
});

// --- learning, resolution and re-attribution against a real archive --------

test(
  "learning accepts a number from single-number documents, and re-attribution moves the consolidated statement's rows and closes their review items",
  { skip },
  async (t) => {
    const { client, env, adapterPath } = await importedArchive(t, {
      // Consolidated: the February statement prints both numbers.
      [FEBRUARY_STATEMENT]: [NUMBER_A, NUMBER_B],
      // Single-account, one per account: the evidence.
      [MARCH_STATEMENT]: [NUMBER_A],
      [CONFIRMATION]: [NUMBER_B],
    });

    // Before anything is learned, every holding the consolidated statement
    // carried is filed under the account it was pulled under, and each
    // unresolved key left a review item -- now carrying the document it came
    // from, which is the pointer F1-56 restores.
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_B.id]), 0);
    const openItems = await all(
      client,
      "SELECT source_document_id FROM review_items WHERE kind = 'unknown_account_key' AND status = 'open'",
    );
    assert.ok(openItems.length > 0);
    assert.ok(
      openItems.every((item) => item.source_document_id !== null),
      "every unknown_account_key item names the document it came from",
    );

    const dryLearn = runCommand(env, [
      "learn-account-aliases",
      "--adapter",
      adapterPath,
      "--dry-run",
      "--now",
      "2025-06-01T00:00:00.000Z",
    ]);
    assert.match(dryLearn, /^mode: learn-account-aliases \(dry run\)$/m);
    assert.equal(summaryValue(dryLearn, "documents printing one account number"), 2);
    assert.equal(summaryValue(dryLearn, "documents printing several account numbers"), 1);
    assert.equal(summaryValue(dryLearn, "account numbers seen"), 2);
    assert.equal(summaryValue(dryLearn, "accepted"), 2);
    assert.equal(summaryValue(dryLearn, "ambiguous"), 0);
    assert.equal(summaryValue(dryLearn, "unmapped"), 0);
    assert.equal(summaryValue(dryLearn, "aliases written"), 0);
    assert.equal(await count(client, "account_aliases"), 0, "a dry run writes nothing");

    const learn = runCommand(env, [
      "learn-account-aliases",
      "--adapter",
      adapterPath,
      "--now",
      "2025-06-01T00:00:00.000Z",
    ]);
    assert.equal(summaryValue(learn, "aliases written"), 2);
    const aliases = await all(
      client,
      "SELECT account_id, external_key, kind FROM account_aliases ORDER BY external_key",
    );
    assert.deepEqual(aliases, [
      { account_id: ACCOUNT_A.id, external_key: NUMBER_A, kind: "statement_number" },
      { account_id: ACCOUNT_B.id, external_key: NUMBER_B, kind: "statement_number" },
    ]);

    // Learning again writes nothing: the accepted keys now resolve, so there
    // is nothing left to learn.
    const relearn = runCommand(env, ["learn-account-aliases", "--adapter", adapterPath]);
    assert.equal(summaryValue(relearn, "account numbers seen"), 0);
    assert.equal(summaryValue(relearn, "aliases written"), 0);

    const dryMove = runCommand(env, [
      "reattribute-accounts",
      "--adapter",
      adapterPath,
      "--dry-run",
      "--now",
      "2025-06-01T00:00:00.000Z",
    ]);
    assert.match(dryMove, /^mode: reattribute-accounts \(dry run\)$/m);
    assert.equal(summaryValue(dryMove, "documents with rows to move"), 1);
    assert.equal(summaryValue(dryMove, "positions moved"), 2);
    assert.equal(summaryValue(dryMove, "balances moved"), 1);
    assert.equal(summaryValue(dryMove, "liabilities moved"), 0);
    assert.equal(
      await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_B.id]),
      0,
      "a dry run moves nothing",
    );

    const move = runCommand(env, [
      "reattribute-accounts",
      "--adapter",
      adapterPath,
      "--now",
      "2025-06-01T00:00:00.000Z",
    ]);
    assert.equal(summaryValue(move, "positions moved"), 2);
    assert.equal(summaryValue(move, "balances moved"), 1);
    assert.equal(summaryValue(move, "rows left (row hash mismatch)"), 0);
    assert.equal(summaryValue(move, "rows left (target account already holds this row)"), 0);
    assert.equal(summaryValue(move, "locators with conflicting target accounts"), 0);
    assert.match(move, /^open unknown_account_key items: \d+ -> 0$/m);

    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_B.id]), 2);
    assert.equal(await count(client, "balances", "WHERE account_id = $1", [ACCOUNT_B.id]), 1);
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'unknown_account_key' AND status = 'open'",
      ),
      0,
    );
    const resolvedItem = await one(
      client,
      "SELECT resolution_note FROM review_items WHERE kind = 'unknown_account_key' LIMIT 1",
    );
    assert.match(resolvedItem.resolution_note, /reattribute-accounts/);

    // Every moved row's hash was recomputed for its new account: a reparse
    // recomputes the same hashes and therefore inserts nothing.
    const reparse = runCommand(env, [
      "reparse",
      "--adapter",
      adapterPath,
      "--now",
      "2025-06-02T00:00:00.000Z",
    ]);
    assert.equal(summaryValue(reparse, "rows inserted"), 0);
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_B.id]), 2);

    // And re-attributing again moves nothing: the rows are already there.
    const again = runCommand(env, ["reattribute-accounts", "--adapter", adapterPath]);
    assert.equal(summaryValue(again, "positions moved"), 0);
    assert.equal(summaryValue(again, "balances moved"), 0);
  },
);

test(
  "a number two single-number documents disagree about is reported by masked shape and never written",
  { skip },
  async (t) => {
    const { client, env, adapterPath } = await importedArchive(t, {
      [FEBRUARY_STATEMENT]: [NUMBER_A, NUMBER_B],
      // Both single-number documents print the same number, under two
      // different accounts.
      [MARCH_STATEMENT]: [NUMBER_A],
      [CONFIRMATION]: [NUMBER_A],
    });

    const learn = runCommand(env, ["learn-account-aliases", "--adapter", adapterPath]);
    assert.equal(summaryValue(learn, "account numbers seen"), 2);
    assert.equal(summaryValue(learn, "accepted"), 0);
    assert.equal(summaryValue(learn, "ambiguous"), 1);
    assert.equal(summaryValue(learn, "unmapped"), 1);
    assert.equal(summaryValue(learn, "aliases written"), 0);
    assert.equal(await count(client, "account_aliases"), 0);

    // Masked shape only: neither number's digits appear anywhere in what an
    // operator sees.
    assert.match(learn, /^ {2}ambiguous: ###-######-### \[[0-9a-f]{8}\]$/m);
    assert.match(learn, /^ {2}unmapped: ###-######-### \[[0-9a-f]{8}\]$/m);
    assert.ok(!learn.includes(NUMBER_A), "the key itself is never printed");
    assert.ok(!learn.includes(NUMBER_B));

    // Nothing learned, so nothing to move.
    const move = runCommand(env, ["reattribute-accounts", "--adapter", adapterPath]);
    assert.equal(summaryValue(move, "documents with rows to move"), 0);
    assert.equal(summaryValue(move, "positions moved"), 0);
  },
);

test(
  "an import resolves a printed account number against an existing alias, with no review item and no re-attribution needed",
  { skip },
  async (t) => {
    const { schema, client } = await seededSchema(t);
    const rawDir = mkdtempSync(join(tmpdir(), "kith-alias-forward-raw-"));
    t.after(() => rmSync(rawDir, { recursive: true, force: true }));
    const fixturesDir = mkdtempSync(join(tmpdir(), "kith-alias-forward-fixtures-"));
    t.after(() => rmSync(fixturesDir, { recursive: true, force: true }));

    // The aliases already exist, as they would after one learning pass.
    for (const [key, accountId] of [
      [NUMBER_A, ACCOUNT_A.id],
      [NUMBER_B, ACCOUNT_B.id],
    ]) {
      await client.query(
        `INSERT INTO account_aliases (id, account_id, institution_id, external_key, kind)
         VALUES ($1, $2, $3, $4, 'statement_number')`,
        [`alias_${key}`, accountId, INSTITUTION.id, key],
      );
    }

    const adapterPath = writeStampingAdapter(fixturesDir, {
      [FEBRUARY_STATEMENT]: [NUMBER_A, NUMBER_B],
      [MARCH_STATEMENT]: [NUMBER_A],
      [CONFIRMATION]: [NUMBER_B],
    });

    runCommand(makeEnv(schema, rawDir), [
      "--adapter",
      adapterPath,
      "--session",
      writeSessionFixture(fixturesDir),
      "--selection",
      writeSelection(fixturesDir),
      "--now",
      "2025-05-01T00:00:00.000Z",
    ]);

    // The consolidated statement's sections landed on their own accounts on
    // the way in, with nothing left for re-attribution to fix.
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_A.id]), 2);
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_B.id]), 2);
    assert.equal(await count(client, "balances", "WHERE account_id = $1", [ACCOUNT_B.id]), 1);
    assert.equal(
      await count(client, "review_items", "WHERE kind = 'unknown_account_key'"),
      0,
      "an alias resolves the key, so nothing is unknown",
    );
  },
);

test(
  "an alias cannot name an account at another institution, or two accounts at one",
  { skip },
  async (t) => {
    const { client } = await seededSchema(t);
    await client.query(
      "INSERT INTO institutions (id, name, slug) VALUES ('inst_other', 'Other', 'other-synthetic')",
    );
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO account_aliases (id, account_id, institution_id, external_key, kind)
           VALUES ('a1', $1, 'inst_other', $2, 'statement_number')`,
          [ACCOUNT_A.id, NUMBER_A],
        ),
      /account_aliases_account_fkey/,
    );
    await client.query(
      `INSERT INTO account_aliases (id, account_id, institution_id, external_key, kind)
       VALUES ('a2', $1, $2, $3, 'statement_number')`,
      [ACCOUNT_A.id, INSTITUTION.id, NUMBER_A],
    );
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO account_aliases (id, account_id, institution_id, external_key, kind)
           VALUES ('a3', $1, $2, $3, 'statement_number')`,
          [ACCOUNT_B.id, INSTITUTION.id, NUMBER_A],
        ),
      /account_aliases_key_unique/,
    );
  },
);

// --- F1-56b: the duplicate a move cannot displace --------------------------
//
// A household covered twice over: one consolidated statement filed under
// account A that states both accounts' holdings, and account B's own
// statement that states B's holdings again. Only the consolidated copy was
// ever misfiled, so when re-attribution tries to move it to B, B already
// holds a row with the identical content and the move is blocked. Left
// there, it is a second copy of one holding under the wrong account.

/** A holding both statements state, to the letter of positionHash. */
const SHARED_POSITION = {
  key: NUMBER_B,
  symbol: "FKE",
  cusip: "000000FK1",
  name: "Fictional Kelp ETF",
  asOf: "2025-02-28",
  quantity: "40",
  marketValue: "4212.00",
  costBasis: "3900.00",
};
/** One B holds only via the consolidated statement: it can actually move. */
const MOVABLE_POSITION = {
  key: NUMBER_B,
  symbol: "SGH",
  cusip: "000000SG2",
  name: "Synthetic Glacier Holdings",
  asOf: "2025-02-28",
  quantity: "25",
  marketValue: "1203.45",
  costBasis: "1200.00",
};
/** One that is A's own and must not be touched at all. */
const A_POSITION = {
  key: NUMBER_A,
  symbol: "FKE",
  cusip: "000000FK1",
  name: "Fictional Kelp ETF",
  asOf: "2025-02-28",
  quantity: "11",
  marketValue: "1158.30",
  costBasis: "1000.00",
};
const SHARED_BALANCE = {
  key: NUMBER_B,
  asOf: "2025-02-28",
  totalValue: "18150.45",
  cash: "420.10",
};

/**
 * February is the consolidated statement (pulled under A, printing both
 * numbers); March is account B's own statement (pulled under B, printing
 * only B's number) and states the shared holding and balance a second time.
 * The confirmation is A's, so learning has one single-number document per
 * account.
 */
function duplicateCorpus() {
  return {
    numbers: {
      [FEBRUARY_STATEMENT]: [NUMBER_A, NUMBER_B],
      [MARCH_STATEMENT]: [NUMBER_B],
      [CONFIRMATION]: [NUMBER_A],
    },
    options: {
      pullAccounts: {
        february: ACCOUNT_A.externalKey,
        march: ACCOUNT_B.externalKey,
        confirmation: ACCOUNT_A.externalKey,
      },
      holdingsByMarker: {
        [FEBRUARY_STATEMENT]: {
          positions: [A_POSITION, MOVABLE_POSITION, SHARED_POSITION],
          balances: [SHARED_BALANCE],
        },
        [MARCH_STATEMENT]: {
          positions: [SHARED_POSITION],
          balances: [SHARED_BALANCE],
        },
      },
    },
  };
}

test(
  "a misfiled row the target account already holds is reported, then deleted only when --remove-duplicates asks",
  { skip },
  async (t) => {
    const { numbers, options } = duplicateCorpus();
    const { client, env, adapterPath } = await importedArchive(t, numbers, options);

    // The consolidated statement filed all three of its positions under A;
    // B holds only the one its own statement stated.
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_A.id]), 3);
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_B.id]), 1);

    const learn = runCommand(env, ["learn-account-aliases", "--adapter", adapterPath]);
    assert.equal(summaryValue(learn, "accepted"), 2);
    assert.equal(summaryValue(learn, "aliases written"), 2);

    // Without the flag: one position moves, and the shared position and
    // balance are reported as already held at the target, untouched.
    const reported = runCommand(env, [
      "reattribute-accounts",
      "--adapter",
      adapterPath,
      "--dry-run",
    ]);
    assert.equal(summaryValue(reported, "positions moved"), 1);
    assert.equal(summaryValue(reported, "positions removed as duplicates"), 0);
    assert.equal(summaryValue(reported, "balances removed as duplicates"), 0);
    assert.equal(
      summaryValue(reported, "rows left (target account already holds this row)"),
      2,
    );
    assert.match(reported, /re-run with --remove-duplicates/);

    // With the flag, still a dry run: the same counts, nothing written.
    const dry = runCommand(env, [
      "reattribute-accounts",
      "--adapter",
      adapterPath,
      "--remove-duplicates",
      "--dry-run",
      "--now",
      "2025-06-01T00:00:00.000Z",
    ]);
    assert.match(dry, /^mode: reattribute-accounts \(--remove-duplicates\) \(dry run\)$/m);
    assert.equal(summaryValue(dry, "positions moved"), 1);
    assert.equal(summaryValue(dry, "positions removed as duplicates"), 1);
    assert.equal(summaryValue(dry, "balances removed as duplicates"), 1);
    assert.equal(
      summaryValue(dry, "rows left (target account already holds this row)"),
      0,
    );
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_A.id]), 3);
    assert.equal(
      await count(client, "review_items", "WHERE kind = 'duplicate_holding_removed'"),
      0,
      "a dry run deletes nothing and records nothing",
    );

    const real = runCommand(env, [
      "reattribute-accounts",
      "--adapter",
      adapterPath,
      "--remove-duplicates",
      "--now",
      "2025-06-01T00:00:00.000Z",
    ]);
    assert.equal(summaryValue(real, "positions moved"), 1);
    assert.equal(summaryValue(real, "positions removed as duplicates"), 1);
    assert.equal(summaryValue(real, "balances removed as duplicates"), 1);

    // A keeps only its own holding; B has its own plus the one that moved,
    // and exactly one copy of the shared one.
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_A.id]), 1);
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_B.id]), 2);
    assert.equal(await count(client, "balances", "WHERE account_id = $1", [ACCOUNT_A.id]), 0);
    assert.equal(await count(client, "balances", "WHERE account_id = $1", [ACCOUNT_B.id]), 1);

    // The deletion left a durable, joinable record naming the document whose
    // copy went and how many rows it was.
    const recorded = await all(
      client,
      `SELECT r.account_id, r.raw_value, r.reason, d.doc_type
         FROM review_items r JOIN documents d ON d.id = r.source_document_id
        WHERE r.kind = 'duplicate_holding_removed'
        ORDER BY r.raw_value`,
    );
    assert.equal(recorded.length, 2, "one item per document and table");
    for (const item of recorded) {
      assert.equal(item.account_id, ACCOUNT_A.id);
      assert.equal(item.raw_value, "1");
      assert.match(item.reason, /removed on 2025-06-01T00:00:00\.000Z/);
      assert.match(item.reason, new RegExp(ACCOUNT_B.id));
    }

    // Stable under re-import: the consolidated statement now resolves the
    // shared holding to B, where row_hash finds the survivor, so nothing
    // comes back.
    const reparse = runCommand(env, [
      "reparse",
      "--adapter",
      adapterPath,
      "--now",
      "2025-06-02T00:00:00.000Z",
    ]);
    assert.equal(summaryValue(reparse, "rows inserted"), 0);
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_A.id]), 1);
    assert.equal(await count(client, "positions", "WHERE account_id = $1", [ACCOUNT_B.id]), 2);

    // Idempotent: a second run has nothing left to move or remove.
    const again = runCommand(env, [
      "reattribute-accounts",
      "--adapter",
      adapterPath,
      "--remove-duplicates",
    ]);
    assert.equal(summaryValue(again, "positions moved"), 0);
    assert.equal(summaryValue(again, "positions removed as duplicates"), 0);
    assert.equal(summaryValue(again, "balances removed as duplicates"), 0);
  },
);

test(
  "verdicts for periods a departing snapshot bounded are deleted; a period still bounded by a row that stayed is not",
  { skip },
  async (t) => {
    const { numbers, options } = duplicateCorpus();
    const { client, env, adapterPath } = await importedArchive(t, numbers, options);
    runCommand(env, ["learn-account-aliases", "--adapter", adapterPath]);

    const instrument = async (symbol) =>
      (await one(client, "SELECT id FROM instruments WHERE symbol = $1", [symbol])).id;
    const sgh = await instrument("SGH"); // moves out of A
    const fke = await instrument("FKE"); // A keeps its own FKE position

    // Two verdicts anchored on the departing SGH snapshot's own date -- the
    // periods that end and begin at it -- plus one anchored on the same date
    // for FKE, which A still holds a position at. Only the first two name
    // periods that will cease to exist.
    const verdicts = [
      ["v_end_sgh", sgh, "2025-01-31", "2025-02-28"],
      ["v_start_sgh", sgh, "2025-02-28", "2025-03-31"],
      ["v_keep_fke", fke, "2025-01-31", "2025-02-28"],
    ];
    for (const [id, instrumentId, start, end] of verdicts) {
      await client.query(
        `INSERT INTO position_reconciliations
           (id, account_id, instrument_id, period_start, period_end, tolerance, status)
         VALUES ($1, $2, $3, $4, $5, 0, 'fail')`,
        [id, ACCOUNT_A.id, instrumentId, start, end],
      );
    }
    // And one cash verdict anchored on the balance that leaves A.
    await client.query(
      `INSERT INTO reconciliations
         (id, account_id, period_start, period_end, currency, tolerance, status)
       VALUES ('v_cash', $1, '2025-01-31', '2025-02-28', 'USD', 0, 'fail')`,
      [ACCOUNT_A.id],
    );

    const real = runCommand(env, [
      "reattribute-accounts",
      "--adapter",
      adapterPath,
      "--remove-duplicates",
    ]);
    assert.match(
      real,
      /^verdicts deleted for periods that no longer exist: cash \d+ positions \d+$/m,
    );

    const surviving = await all(
      client,
      "SELECT id FROM position_reconciliations WHERE id = ANY($1::text[]) ORDER BY id",
      [verdicts.map(([id]) => id)],
    );
    assert.deepEqual(
      surviving.map((row) => row.id),
      ["v_keep_fke"],
      "only the periods bounded by a snapshot that actually left are deleted",
    );
    assert.equal(
      await count(client, "reconciliations", "WHERE id = $1", ["v_cash"]),
      0,
      "the balance left A, so the period it bounded is gone too",
    );

    // The command ends with a whole-archive pass, so the archive is judged
    // as a whole rather than only where this run reached.
    assert.match(real, /^whole-archive gate pass positions: checked=\d+/m);
  },
);

test("learn-account-aliases refuses the destructive flag rather than ignoring it", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [runScript, "learn-account-aliases", "--adapter", "x", "--remove-duplicates"],
        { encoding: "utf8", stdio: "pipe" },
      ),
    /--remove-duplicates belongs to reattribute-accounts/,
  );
});
