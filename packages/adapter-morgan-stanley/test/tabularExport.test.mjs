import { test } from "node:test";
import assert from "node:assert/strict";
import adapter from "../src/adapter.mjs";
import { createFixtureSession } from "../fixtures/session.mjs";

const SELECTION = { kind: "tabular_export", periodStart: "2025-01-01", periodEnd: "2025-02-28" };

test("acquire retains the export opaque with no row count -- the provider states none", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });

  assert.equal(acquired.manifest.kind, "tabular_export");
  assert.equal(acquired.manifest.reportedRowCount, null);
  assert.equal(acquired.manifest.mediaType, "text/csv; charset=utf-8");
  assert.equal(acquired.retention.policy.kind, "opaque");
  assert.deepEqual(acquired.retention.droppedPaths, []);
});

test("parse reads the real header row, signs quantity by the same table as the API tier, and binds amount by column", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "tabular_export", bytes: acquired.bytes });

  assert.equal(parsed.activity.length, 4);
  assert.deepEqual(parsed.holdings, { positions: [], balances: [], liabilities: [] });

  const sell = parsed.activity.find((r) => r.activityType === "Sold");
  assert.equal(sell.quantity, "-25", "signed the same way as the structured_api tier");
  assert.equal(sell.amount, "5321.1");

  const csvText = new TextDecoder().decode(acquired.bytes);
  const dataLines = csvText.split("\n").filter((l) => l.length > 0).slice(1);

  parsed.activity.forEach((row, i) => {
    const binding = row.locators.row.binding;
    assert.equal(binding.format, "delimited_row_v1");
    assert.equal(binding.columnName, "Amount");
    assert.equal(binding.columnIndex, 6);
    assert.equal(binding.rowIndex, i, "rowIndex is the physical data-record position");
    const fieldsInLine = dataLines[i].split(",");
    assert.equal(fieldsInLine[binding.columnIndex], binding.rawValue, "the binding resolves against the retained bytes");
  });
});

test("no row's externalId is fabricated -- the export states no provider row id", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "tabular_export", bytes: acquired.bytes });
  assert.ok(parsed.activity.every((r) => r.externalId === null));
});
