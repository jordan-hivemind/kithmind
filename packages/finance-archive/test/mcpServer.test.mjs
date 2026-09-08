// End-to-end tests over the four MCP tools, through the real protocol (an
// in-memory client/server pair, same as apps/web's MCP tests), against a
// deliberately partial fixture. The point of the fixture is that three
// account states must stay distinguishable in get_coverage's output rather
// than collapsing into one: a period that has not reconciled, an account
// with an open review item, and an account nothing was ever acquired for.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openArchive, toMinorUnits } from "../dist/index.js";
import { createFinanceArchiveMcpServer } from "../dist/mcp/server.js";

const INSTITUTION = {
  id: "inst_cedar_gate",
  name: "Cedar Gate Financial",
  slug: "cedar-gate",
};

// Three accounts, three states. None of them shares a source_document_id,
// a reconciliation row, or a review_items row with another, so an
// implementation that accidentally pools coverage across accounts would be
// caught immediately.
const UNRECONCILED_ACCOUNT = { id: "acct_unreconciled", last4: "3001" };
const UNDER_REVIEW_ACCOUNT = { id: "acct_under_review", last4: "3002" };
const NEVER_ACQUIRED_ACCOUNT = { id: "acct_never_acquired", last4: "3003" };

function buildFixture(directory) {
  const dbPath = join(directory, "archive.db");
  const db = openArchive(dbPath);
  db.prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)").run(
    INSTITUTION.id,
    INSTITUTION.name,
    INSTITUTION.slug,
  );
  for (const account of [
    UNRECONCILED_ACCOUNT,
    UNDER_REVIEW_ACCOUNT,
    NEVER_ACQUIRED_ACCOUNT,
  ]) {
    db.prepare(
      "INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency) VALUES (?, ?, ?, ?, 'USD')",
    ).run(account.id, INSTITUTION.id, account.last4, "Synthetic account");
  }

  // A document and a transaction for each of the two acquired accounts, so
  // "never acquired" means literally nothing below the account row exists,
  // not just an empty transaction list.
  for (const [index, account] of [
    UNRECONCILED_ACCOUNT,
    UNDER_REVIEW_ACCOUNT,
  ].entries()) {
    // Each account's document gets its own content hash: sha256 is UNIQUE,
    // and two rows sharing one would defeat the purpose of the check.
    const sha256 = index.toString().repeat(64).slice(0, 64);
    db.prepare(
      `INSERT INTO documents (id, institution_id, account_id, doc_type, doc_date, file_path, sha256, text_path, parsed_ok)
       VALUES (?, ?, ?, 'statement', '2026-02-28', ?, ?, ?, 1)`,
    ).run(
      `doc_${account.id}`,
      INSTITUTION.id,
      account.id,
      `synthetic-raw-tree/${account.id}/2026-02.pdf`,
      sha256,
      `synthetic-raw-tree/${account.id}/2026-02.txt`,
    );
    db.prepare(
      `INSERT INTO transactions
         (id, account_id, process_date, activity_type, description, amount, currency,
          source_document_id, source_locator, row_hash, imported_at)
       VALUES (?, ?, '2026-02-15', 'fee', 'Synthetic fee', ?, 'USD', ?, 'page 1, row 3', ?, '2026-03-01T00:00:00.000Z')`,
    ).run(
      `txn_${account.id}`,
      account.id,
      toMinorUnits("-12.50", "USD"),
      `doc_${account.id}`,
      `hash_${account.id}`,
    );
  }

  // State 1: acquired and parsed, but the period has not reconciled.
  db.prepare(
    `INSERT INTO reconciliations (id, account_id, period_start, period_end, currency, tolerance, status)
     VALUES (?, ?, '2026-02-01', '2026-02-28', 'USD', 0, 'unverified')`,
  ).run("rec_unreconciled", UNRECONCILED_ACCOUNT.id);

  // State 2: acquired, parsed and reconciled, but a value is under review.
  db.prepare(
    `INSERT INTO reconciliations (id, account_id, period_start, period_end, currency, tolerance, status)
     VALUES (?, ?, '2026-02-01', '2026-02-28', 'USD', 0, 'pass')`,
  ).run("rec_under_review", UNDER_REVIEW_ACCOUNT.id);
  db.prepare(
    `INSERT INTO review_items (id, kind, account_id, source_document_id, source_locator, raw_value, reason, status)
     VALUES (?, 'ambiguous_amount', ?, ?, 'page 1, row 7', '$12.345', 'more precision than USD minor units allows', 'open')`,
  ).run(
    "review_under_review",
    UNDER_REVIEW_ACCOUNT.id,
    `doc_${UNDER_REVIEW_ACCOUNT.id}`,
  );

  // State 3: the account exists (it was set up) but nothing has been
  // acquired for it yet -- no document, no transaction, no reconciliation,
  // no review item.

  db.close();
  return dbPath;
}

async function withClient(t, run) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-mcp-"));
  const dbPath = buildFixture(directory);
  const { server, close } = createFinanceArchiveMcpServer(dbPath);
  const client = new Client({ name: "finance-archive-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(async () => {
    await client.close();
    close();
    rmSync(directory, { recursive: true, force: true });
  });
  return run(client, dbPath);
}

function payload(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("describe_schema documents tables, money policy and valuation basis", (t) =>
  withClient(t, async (client) => {
    const result = payload(
      await client.callTool({ name: "describe_schema", arguments: {} }),
    );
    assert.equal(result.completeness, "complete");
    assert.equal(typeof result.datasetRevision, "number");
    const tableNames = result.schema.tables.map((table) => table.name);
    assert.ok(tableNames.includes("transactions"));
    assert.ok(tableNames.includes("reconciliations"));
    assert.match(result.schema.moneyPolicy, /minor units/);
    assert.equal(
      result.schema.valuationBasisMeanings.reported_nav,
      "Net asset value as reported by the fund or manager.",
    );
    assert.equal(result.schema.currencyPolicy.minorUnitExponents.JPY, 0);
  }));

test("run_query returns a big money sum as an exact string, never a float", (t) =>
  withClient(t, async (client) => {
    const result = payload(
      await client.callTool({
        name: "run_query",
        arguments: {
          sql: "SELECT account_id, sum(amount) AS total FROM transactions GROUP BY account_id ORDER BY account_id",
        },
      }),
    );
    assert.equal(result.completeness, "complete");
    assert.equal(result.truncated, false);
    assert.equal(typeof result.datasetRevision, "number");
    assert.ok(result.rows.length >= 2);
    for (const row of result.rows) {
      assert.equal(typeof row.total, "string");
      assert.equal(row.total, "-1250");
    }
  }));

test("run_query never labels a zero-row result as proof of absence", (t) =>
  withClient(t, async (client) => {
    const result = payload(
      await client.callTool({
        name: "run_query",
        arguments: {
          sql: "SELECT id FROM transactions WHERE account_id = ?",
          params: [NEVER_ACQUIRED_ACCOUNT.id],
        },
      }),
    );
    assert.equal(result.rows.length, 0);
    assert.match(result.resultSemantics, /not proof/);
    assert.match(result.resultSemantics, /get_coverage/);
  }));

test("run_query rejects a write attempt through the MCP tool, not just the library call", (t) =>
  withClient(t, async (client) => {
    const result = await client.callTool({
      name: "run_query",
      arguments: { sql: "DELETE FROM transactions" },
    });
    assert.equal(result.isError, true);
  }));

test("get_evidence cites the source document for a found row and says so plainly when there is none", (t) =>
  withClient(t, async (client) => {
    const found = payload(
      await client.callTool({
        name: "get_evidence",
        arguments: {
          table: "transactions",
          id: `txn_${UNRECONCILED_ACCOUNT.id}`,
        },
      }),
    );
    assert.equal(found.completeness, "complete");
    assert.equal(found.evidence.found, true);
    assert.equal(found.evidence.sourceLocator, "page 1, row 3");
    assert.equal(found.evidence.document.sha256, "0".repeat(64));
    assert.match(found.evidence.document.textPath, /\.txt$/);

    const missing = payload(
      await client.callTool({
        name: "get_evidence",
        arguments: { table: "transactions", id: "txn_does_not_exist" },
      }),
    );
    assert.equal(missing.completeness, "not_found");
    assert.equal(missing.evidence.found, false);
  }));

test("get_coverage keeps three account states distinct", (t) =>
  withClient(t, async (client) => {
    const result = payload(
      await client.callTool({ name: "get_coverage", arguments: {} }),
    );
    assert.equal(result.completeness, "complete");
    const byId = Object.fromEntries(
      result.accounts.map((a) => [a.accountId, a]),
    );

    const unreconciled = byId[UNRECONCILED_ACCOUNT.id];
    assert.equal(unreconciled.acquisitionState, "acquired");
    assert.equal(unreconciled.documents.count, 1);
    assert.equal(unreconciled.periods.length, 1);
    assert.equal(unreconciled.periods[0].status, "unverified");
    assert.equal(unreconciled.reviewItems.open, 0);

    const underReview = byId[UNDER_REVIEW_ACCOUNT.id];
    assert.equal(underReview.acquisitionState, "acquired");
    assert.equal(underReview.periods[0].status, "pass");
    assert.equal(underReview.reviewItems.open, 1);

    const neverAcquired = byId[NEVER_ACQUIRED_ACCOUNT.id];
    assert.equal(neverAcquired.acquisitionState, "never_acquired");
    assert.equal(neverAcquired.documents.count, 0);
    assert.equal(neverAcquired.transactions.count, 0);
    assert.equal(neverAcquired.periods.length, 0);
    assert.equal(neverAcquired.reviewItems.open, 0);

    // The three states really are three different shapes, not the same
    // summary repeated under different account IDs.
    assert.notDeepEqual(unreconciled.periods, underReview.periods);
    assert.notEqual(
      unreconciled.acquisitionState,
      neverAcquired.acquisitionState,
    );
    assert.notEqual(
      underReview.reviewItems.open,
      neverAcquired.reviewItems.open,
    );
  }));

test("get_coverage reports not_found for an accountId that does not exist, not an empty list", (t) =>
  withClient(t, async (client) => {
    const result = payload(
      await client.callTool({
        name: "get_coverage",
        arguments: { accountId: "acct_does_not_exist" },
      }),
    );
    assert.equal(result.completeness, "not_found");
    assert.deepEqual(result.accounts, []);
  }));

test("the dataset revision changes when the archive is written by another connection", (t) =>
  withClient(t, async (client, dbPath) => {
    const before = payload(
      await client.callTool({ name: "describe_schema", arguments: {} }),
    );

    const writer = openArchive(dbPath);
    writer
      .prepare(
        "INSERT INTO institutions (id, name, slug) VALUES ('inst_new', 'New Synthetic Bank', 'new-synthetic')",
      )
      .run();
    writer.close();

    const after = payload(
      await client.callTool({ name: "describe_schema", arguments: {} }),
    );
    assert.notEqual(after.datasetRevision, before.datasetRevision);
  }));
