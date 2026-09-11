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
  // The export is an Excel workbook, not delimited text.
  assert.equal(
    acquired.manifest.mediaType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(acquired.retention.policy.kind, "opaque");
  assert.deepEqual(acquired.retention.droppedPaths, []);
});

test("parse returns zero rows for tabular_export -- acquire-only until an xlsx reader is chosen", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "tabular_export", bytes: acquired.bytes });

  assert.deepEqual(parsed.activity, []);
  assert.deepEqual(parsed.holdings, { positions: [], balances: [], liabilities: [] });
});
