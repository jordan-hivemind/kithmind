import assert from "node:assert/strict";
import test from "node:test";

import { parseFinanceReadRequest } from "@repo/finance-contract";

import {
  issueFinanceCursor,
  verifyFinanceCursor,
} from "../dist/mcp/financeCursor.js";

const SECRET = "synthetic-cursor-secret-at-least-32-bytes";
const NOW = 1_789_000_000_000;

function request(overrides = {}) {
  return parseFinanceReadRequest({
    contractVersion: 1,
    spaceId: "space-synthetic-cursor",
    operation: "get_holdings_snapshot",
    accountId: "account-synthetic-cursor",
    snapshot: { mode: "exact", asOf: "2026-07-31" },
    limit: 2,
    ...overrides,
  });
}

function context(overrides = {}) {
  return {
    principalId: "principal-synthetic-cursor",
    spaceId: "space-synthetic-cursor",
    cursorSigningSecret: SECRET,
    now: () => NOW,
    ...overrides,
  };
}

function binding(normalizedRequest = request(), overrides = {}) {
  return {
    operation: normalizedRequest.operation,
    normalizedRequest,
    datasetRevision: "revision-synthetic-cursor-1",
    selectedSnapshotAsOf: "2026-07-31",
    ...overrides,
  };
}

test("a cursor binds the principal, normalized query, selected snapshot, and revision", () => {
  const token = issueFinanceCursor(context(), binding(), ["position-002"]);
  assert.deepEqual(verifyFinanceCursor(context(), binding(), token), [
    "position-002",
  ]);

  assert.throws(
    () =>
      verifyFinanceCursor(
        context({ principalId: "principal-other" }),
        binding(),
        token,
      ),
    (error) => error.code === "invalid_request",
  );
  assert.throws(
    () => verifyFinanceCursor(context(), binding(request({ limit: 3 })), token),
    (error) => error.code === "invalid_request",
  );
  assert.throws(
    () =>
      verifyFinanceCursor(
        context(),
        binding(request(), { selectedSnapshotAsOf: "2026-07-30" }),
        token,
      ),
    (error) => error.code === "invalid_request",
  );
  assert.throws(
    () =>
      verifyFinanceCursor(
        context(),
        binding(request(), {
          datasetRevision: "revision-synthetic-cursor-2",
        }),
        token,
      ),
    (error) => error.code === "revision_changed",
  );
});

test("expectedDatasetRevision may be added on continuation without changing the query binding", () => {
  const token = issueFinanceCursor(context(), binding(), ["position-002"]);
  const continued = request({
    expectedDatasetRevision: "revision-synthetic-cursor-1",
  });
  assert.deepEqual(verifyFinanceCursor(context(), binding(continued), token), [
    "position-002",
  ]);
});

test("tampered, expired, and weak-secret cursors fail closed", () => {
  const token = issueFinanceCursor(context(), binding(), ["position-002"]);
  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  assert.throws(
    () => verifyFinanceCursor(context(), binding(), tampered),
    (error) => error.code === "invalid_request",
  );
  assert.throws(
    () =>
      verifyFinanceCursor(
        context({ now: () => NOW + 15 * 60 * 1000 }),
        binding(),
        token,
      ),
    (error) => error.code === "invalid_request",
  );
  assert.throws(
    () =>
      issueFinanceCursor(
        context({ cursorSigningSecret: "too-short" }),
        binding(),
        ["position-002"],
      ),
    (error) => error.code === "invalid_request",
  );
});
