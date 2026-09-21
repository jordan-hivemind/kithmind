import assert from "node:assert/strict";
import test from "node:test";

import { buildHoldingCorrectionCandidateManifest } from "../dist/holdingCorrectionCandidate.js";

const SHA = "a".repeat(64);

function position({
  instrumentId,
  locator,
  quantity = "1",
  marketValue = "100.00",
}) {
  return {
    asOf: "2025-03-31",
    instrumentId,
    quantity,
    price: "100",
    marketValueText: marketValue,
    marketValueNote: null,
    costBasis: "90",
    unrealized: "10",
    currency: "USD",
    valuationBasis: "market_price",
    valuationNote: "statement market value",
    sourceLocator: locator,
  };
}

function semantic({ instrumentId, quantity = "1", marketValue = "100" }) {
  return [
    "acct-1",
    "2025-03-31",
    instrumentId,
    quantity,
    "100",
    marketValue,
    "90",
    "10",
    "USD",
    "market_price",
    "statement market value",
  ];
}

function candidate(overrides = {}) {
  return {
    sha256: SHA,
    retainedSha256: SHA,
    retainedByteLength: 100,
    mediaType: "application/pdf",
    captureId: "capture-1",
    filePath: "/synthetic/raw",
    institutionId: "inst-1",
    accountId: "acct-1",
    docType: "statement",
    docDate: "2025-03-31",
    providerReportedCount: null,
    rows: [],
    reviewItems: [],
    positions: [],
    balances: [],
    liabilities: [],
    ...overrides,
  };
}

function storedPosition(id, instrumentId, locator, overrides = {}) {
  return {
    id,
    rowHash: id.padEnd(64, "0").slice(0, 64),
    sourceLocator: locator,
    semantic: semantic({ instrumentId, ...overrides }),
  };
}

const emptyTables = { positions: [], balances: [], liabilities: [] };

test("candidate manifest binds exact old state and reports add/change/remove without authorizing removal", () => {
  const stored = {
    ...emptyTables,
    positions: [
      storedPosition("old-a", "inst-a", "page:1:row:1"),
      storedPosition("old-b", "inst-b", "page:1:row:2"),
      storedPosition("old-c", "inst-c", "page:1:row:3"),
    ],
  };
  const parsed = candidate({
    positions: [
      position({ instrumentId: "inst-a", locator: "improved:page:1:row:1" }),
      position({
        instrumentId: "inst-b",
        locator: "page:1:row:2",
        marketValue: "125.00",
      }),
      position({ instrumentId: "inst-d", locator: "page:1:row:4" }),
    ],
  });

  const manifest = buildHoldingCorrectionCandidateManifest({
    documentId: "doc-1",
    retainedSha256: SHA,
    stored,
    candidate: parsed,
  });

  assert.deepEqual(manifest.tables.positions, {
    oldRows: 3,
    candidateRows: 3,
    unchanged: 1,
    changed: 1,
    added: 1,
    removed: 1,
  });
  assert.equal(manifest.completeness.state, "unproven");
  assert.equal(manifest.completeness.removalsAuthorized, false);
  assert.deepEqual(manifest.completeness.reasons, [
    "adapter_has_no_holding_completeness_attestation",
  ]);
  for (const field of [
    manifest.oldProjectionDigest,
    manifest.candidateProjectionDigest,
    manifest.candidateDigest,
  ]) {
    assert.match(field, /^[0-9a-f]{64}$/);
  }
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /acct-1|page:1|statement market value|125/);

  const reordered = buildHoldingCorrectionCandidateManifest({
    documentId: "doc-1",
    retainedSha256: SHA,
    stored: { ...stored, positions: [...stored.positions].reverse() },
    candidate: {
      ...parsed,
      positions: [...parsed.positions].reverse(),
    },
  });
  assert.equal(reordered.oldProjectionDigest, manifest.oldProjectionDigest);
  assert.equal(
    reordered.candidateProjectionDigest,
    manifest.candidateProjectionDigest,
  );
  assert.equal(reordered.candidateDigest, manifest.candidateDigest);
});

test("parse gaps and rejected rows stay partial even when the candidate appears empty", () => {
  const manifest = buildHoldingCorrectionCandidateManifest({
    documentId: "doc-2",
    retainedSha256: SHA,
    stored: {
      ...emptyTables,
      positions: [storedPosition("old-a", "inst-a", "page:1:row:1")],
    },
    candidate: candidate({
      parseNote: "synthetic parser gap",
      positions: [
        {
          ...position({ instrumentId: "inst-a", locator: "page:1:row:1" }),
          asOf: "not-a-date",
        },
      ],
    }),
  });

  assert.equal(manifest.completeness.state, "partial");
  assert.equal(manifest.completeness.removalsAuthorized, false);
  assert.deepEqual(manifest.completeness.reasons, [
    "adapter_has_no_holding_completeness_attestation",
    "candidate_row_rejected",
    "parse_gap",
  ]);
  assert.equal(manifest.tables.positions.removed, 1);
  assert.equal(manifest.tables.positions.candidateRows, 0);
});

test("ambiguous remaining locators and retained-byte mismatches fail closed", () => {
  const duplicatedLocator = {
    ...emptyTables,
    positions: [
      storedPosition("old-a", "inst-a", "same"),
      storedPosition("old-b", "inst-b", "same"),
    ],
  };
  assert.throws(
    () =>
      buildHoldingCorrectionCandidateManifest({
        documentId: "doc-3",
        retainedSha256: SHA,
        stored: duplicatedLocator,
        candidate: candidate({
          positions: [position({ instrumentId: "inst-z", locator: "same" })],
        }),
      }),
    /ambiguous source locator/,
  );
  assert.throws(
    () =>
      buildHoldingCorrectionCandidateManifest({
        documentId: "doc-3",
        retainedSha256: "b".repeat(64),
        stored: emptyTables,
        candidate: candidate(),
      }),
    /not bound to the selected retained bytes/,
  );
});
