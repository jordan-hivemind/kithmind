import assert from "node:assert/strict";
import test from "node:test";

import { parseFinanceReadRequest } from "@repo/finance-contract";

import {
  balanceHash,
  holdingProjectionApprovalDigest,
  liabilityHash,
  positionHash,
  publishHoldingProjectionReplacement,
  publishImport,
  serveFinanceRead,
} from "../dist/index.js";
import {
  buildHoldingCorrectionCandidateManifest,
  readStoredHoldingProjection,
} from "../dist/holdingCorrectionCandidate.js";

import { archive, count, one, reader, skip } from "./helpers/pgArchive.mjs";

const SHA = "b".repeat(64);
const NOW = new Date("2026-09-21T12:00:00.000Z");
const INSTITUTION = "inst-projection";
const ACCOUNT = "acct-projection";
const DOCUMENT = "doc-projection";

function bindings(field, value) {
  return JSON.stringify({
    [field]: {
      binding: {
        format: "json_pointer_v1",
        pointer: `/synthetic/${field}`,
        rawValue: String(value),
      },
    },
  });
}

function position({
  instrumentId = "instrument-stable",
  marketValue = "100",
  locator = bindings("marketValue", marketValue),
} = {}) {
  return {
    asOf: "2026-06-30",
    instrumentId,
    quantity: "2",
    price: "50",
    marketValueText: marketValue,
    marketValueNote: null,
    costBasis: "80",
    unrealized: "20",
    currency: "USD",
    valuationBasis: "market_price",
    valuationNote: "synthetic stated value",
    sourceLocator: locator,
  };
}

function balance(totalValue = "120") {
  return {
    asOf: "2026-06-30",
    totalValueText: totalValue,
    totalValueNote: null,
    cash: "20",
    currency: "USD",
    periodStartValue: "90",
    periodEndValue: totalValue,
    sourceLocator: bindings("totalValue", totalValue),
  };
}

function liability(amount = "40") {
  return {
    accountId: ACCOUNT,
    kind: "credit_line",
    displayName: "Synthetic credit line",
    balanceText: amount,
    balanceNote: null,
    currency: "USD",
    rate: "0.05",
    asOf: "2026-06-30",
    collateralNote: null,
    sourceLocator: bindings("balance", amount),
  };
}

function candidate(overrides = {}) {
  return {
    sha256: SHA,
    retainedSha256: SHA,
    retainedByteLength: 1024,
    mediaType: "application/json",
    captureId: "capture-projection",
    filePath: "synthetic/projection.json",
    textPath: null,
    institutionId: INSTITUTION,
    accountId: ACCOUNT,
    docType: "statement",
    docDate: "2026-06-30",
    providerDocumentId: null,
    providerReportedCount: 0,
    rows: [],
    reviewItems: [],
    positions: [position()],
    balances: [balance()],
    liabilities: [liability()],
    ...overrides,
  };
}

async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, 'Synthetic Projection Source', 'projection-source')",
    [INSTITUTION],
  );
  await client.query(
    `INSERT INTO accounts
       (id, institution_id, acct_last4, display_name, account_type, base_currency)
     VALUES ($1, $2, '1001', 'Synthetic Projection', 'brokerage', 'USD')`,
    [ACCOUNT, INSTITUTION],
  );
  await client.query(
    `INSERT INTO instruments (id, symbol, name) VALUES
       ('instrument-stable', 'STBL', 'Synthetic Stable'),
       ('instrument-removed', 'RMVD', 'Synthetic Removed'),
       ('instrument-foreign', 'FRGN', 'Synthetic Foreign')`,
  );
  await client.query(
    `INSERT INTO documents
       (id, institution_id, account_id, doc_type, doc_date, file_path, sha256,
        parsed_ok, retained_sha256, retained_byte_length, media_type, capture_id)
     VALUES ($1, $2, $3, 'statement', DATE '2026-06-30',
             'synthetic/projection.json', $4, FALSE, $4, 1024,
             'application/json', 'capture-projection')`,
    [DOCUMENT, INSTITUTION, ACCOUNT, SHA],
  );

  const stable = position();
  const removed = position({
    instrumentId: "instrument-removed",
    marketValue: "75",
  });
  await client.query(
    `INSERT INTO positions
       (id, account_id, as_of, instrument_id, quantity, price, market_value,
        cost_basis, unrealized, currency, valuation_basis, valuation_note,
        source_document_id, source_locator, row_hash)
     VALUES
       ('position-stable', $1, $2, $3, $4, $5, $6, $7, $8, 'USD', $9, $10, $11, $12, $13),
       ('position-removed', $1, $2, $14, $4, $5, $15, $7, $8, 'USD', $9, $10, $11, $16, $17)`,
    [
      ACCOUNT,
      stable.asOf,
      stable.instrumentId,
      stable.quantity,
      stable.price,
      stable.marketValueText,
      stable.costBasis,
      stable.unrealized,
      stable.valuationBasis,
      stable.valuationNote,
      DOCUMENT,
      stable.sourceLocator,
      positionHash({
        accountId: ACCOUNT,
        instrumentId: stable.instrumentId,
        asOf: stable.asOf,
        quantity: stable.quantity,
        marketValue: stable.marketValueText,
        costBasis: stable.costBasis,
        valuationBasis: stable.valuationBasis,
        sourceLocator: stable.sourceLocator,
      }),
      removed.instrumentId,
      removed.marketValueText,
      removed.sourceLocator,
      positionHash({
        accountId: ACCOUNT,
        instrumentId: removed.instrumentId,
        asOf: removed.asOf,
        quantity: removed.quantity,
        marketValue: removed.marketValueText,
        costBasis: removed.costBasis,
        valuationBasis: removed.valuationBasis,
        sourceLocator: removed.sourceLocator,
      }),
    ],
  );
  await client.query(
    `INSERT INTO balances
       (id, account_id, as_of, total_value, cash, currency,
        period_start_value, period_end_value, source_document_id,
        source_locator, row_hash)
     VALUES ('balance-old', $1, DATE '2026-06-30', 100, 20, 'USD',
             90, 100, $2, $3, $4)`,
    [
      ACCOUNT,
      DOCUMENT,
      bindings("totalValue", "100"),
      balanceHash({
        accountId: ACCOUNT,
        asOf: "2026-06-30",
        totalValue: "100",
        cash: "20",
      }),
    ],
  );
  await client.query(
    `INSERT INTO liabilities
       (id, institution_id, account_id, kind, display_name, balance, currency,
        rate, as_of, source_document_id, source_locator, row_hash)
     VALUES ('liability-old', $1, $2, 'credit_line', 'Synthetic credit line',
             50, 'USD', 0.05, DATE '2026-06-30', $3, $4, $5)`,
    [
      INSTITUTION,
      ACCOUNT,
      DOCUMENT,
      bindings("balance", "50"),
      liabilityHash({
        accountId: ACCOUNT,
        kind: "credit_line",
        asOf: "2026-06-30",
        balance: "50",
      }),
    ],
  );
  await client.query(
    `INSERT INTO review_items
       (id, kind, source_document_id, raw_value, reason, status)
     VALUES
       ('review-unparsed', 'document_unparsed', $1, 'synthetic gap', 'synthetic gap', 'open'),
       ('review-holdings', 'reparse_projection_mismatch', $1, 'holdings',
        'authoritative replay did not exactly restate this document''s active reviewed holding projection; current holdings and history were preserved and the document remains partial',
        'open'),
       ('review-human', 'reparse_projection_mismatch', $1, 'human-holdings', 'human decision', 'dismissed')`,
    [DOCUMENT],
  );
}

async function manifestFor(client, parsed) {
  return buildHoldingCorrectionCandidateManifest({
    documentId: DOCUMENT,
    retainedSha256: SHA,
    stored: await readStoredHoldingProjection(client, DOCUMENT),
    candidate: parsed,
  });
}

function approvalFor(manifest, expectedActiveGenerationId) {
  const unsigned = {
    schemaVersion: 1,
    kind: "holding_projection_approval_v1",
    documentId: DOCUMENT,
    retainedSha256: SHA,
    expectedActiveGenerationId,
    oldProjectionDigest: manifest.oldProjectionDigest,
    candidateProjectionDigest: manifest.candidateProjectionDigest,
    candidateDigest: manifest.candidateDigest,
    completenessAttestation: "operator_verified_complete_projection",
    authorizeRemovals: Object.values(manifest.tables).some(
      (table) => table.removed > 0,
    ),
    authorizeEmptyProjection: Object.values(manifest.tables).every(
      (table) => table.candidateRows === 0,
    ),
    approvedBy: "synthetic-reviewer",
    approvedAt: NOW.toISOString(),
  };
  return {
    ...unsigned,
    approvalDigest: holdingProjectionApprovalDigest(unsigned),
  };
}

async function evidence(r, recordId) {
  const request = parseFinanceReadRequest({
    contractVersion: 1,
    operation: "get_evidence",
    spaceId: "space-projection",
    recordId,
    limit: 10,
  });
  return serveFinanceRead(r.client, request, "space-projection", {
    principalId: "principal-projection",
    cursorSigningSecret: "synthetic-projection-secret-at-least-32-bytes",
    rawTreeRoot: null,
  });
}

test(
  "reviewed replacements retain typed history, support a second correction and finalize only through exact authoritative replay",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    const firstCandidate = candidate();
    const firstManifest = await manifestFor(client, firstCandidate);
    const firstApproval = approvalFor(firstManifest, null);
    const first = await publishHoldingProjectionReplacement(
      client,
      {
        candidate: firstCandidate,
        approval: firstApproval,
      },
      NOW,
    );

    assert.equal(first.retainedIds, 1);
    assert.equal(first.mintedIds, 2);
    assert.equal(await count(client, "holding_projection_generations"), 2);
    assert.equal(await count(client, "holding_projection_assertions"), 6);
    assert.equal(
      (
        await one(
          client,
          "SELECT parsed_ok::text AS value FROM documents WHERE id = $1",
          [DOCUMENT],
        )
      ).value,
      "false",
    );
    assert.equal(
      (
        await one(
          client,
          "SELECT status FROM review_items WHERE id = 'review-holdings'",
        )
      ).status,
      "open",
    );
    assert.equal(
      (
        await one(
          client,
          "SELECT status FROM review_items WHERE id = 'review-unparsed'",
        )
      ).status,
      "open",
    );

    const r = await reader(t, client);
    for (const [recordId, field] of [
      ["pos:position-removed", "marketValue"],
      ["bal:balance-old", "totalValue"],
      ["liab:liability-old", "balance"],
    ]) {
      const result = await evidence(r, recordId);
      assert.equal(result.items.length, 1, recordId);
      assert.match(result.items[0].evidenceId, new RegExp(`:${field}$`));
    }

    await publishImport(
      client,
      { source: "synthetic-exact-replay", documents: [firstCandidate] },
      new Date("2026-09-21T12:01:00.000Z"),
      { authoritativeReparse: true },
    );
    assert.equal(
      (
        await one(
          client,
          "SELECT parsed_ok::text AS value FROM documents WHERE id = $1",
          [DOCUMENT],
        )
      ).value,
      "true",
    );
    assert.equal(
      (
        await one(
          client,
          "SELECT status FROM review_items WHERE id = 'review-holdings'",
        )
      ).status,
      "resolved",
    );
    assert.equal(
      (
        await one(
          client,
          "SELECT status FROM review_items WHERE id = 'review-unparsed'",
        )
      ).status,
      "resolved",
    );
    assert.equal(
      (
        await one(
          client,
          "SELECT status FROM review_items WHERE id = 'review-human'",
        )
      ).status,
      "dismissed",
    );

    const secondCandidate = candidate({
      positions: [position({ marketValue: "105" })],
    });
    const secondManifest = await manifestFor(client, secondCandidate);
    const secondApproval = approvalFor(
      secondManifest,
      first.activeGenerationId,
    );
    const second = await publishHoldingProjectionReplacement(
      client,
      {
        candidate: secondCandidate,
        approval: secondApproval,
      },
      new Date("2026-09-21T12:02:00.000Z"),
    );
    assert.equal(second.generationNumber, 3);
    assert.equal(await count(client, "holding_projection_generations"), 3);
    const durableSecond = await one(
      client,
      `SELECT candidate_projection_digest, candidate_manifest
         FROM holding_projection_generations WHERE id = $1`,
      [second.activeGenerationId],
    );
    assert.equal(
      durableSecond.candidate_projection_digest,
      secondManifest.candidateProjectionDigest,
    );
    assert.deepEqual(durableSecond.candidate_manifest, secondManifest);

    await publishImport(
      client,
      { source: "synthetic-second-replay", documents: [secondCandidate] },
      new Date("2026-09-21T12:03:00.000Z"),
      { authoritativeReparse: true },
    );
    assert.equal(
      (
        await one(
          client,
          "SELECT parsed_ok::text AS value FROM documents WHERE id = $1",
          [DOCUMENT],
        )
      ).value,
      "true",
    );

    await assert.rejects(
      publishHoldingProjectionReplacement(client, {
        candidate: secondCandidate,
        approval: secondApproval,
      }),
      /approval does not bind/,
    );
    const partialCandidate = candidate({ parseNote: "synthetic parser gap" });
    const partialManifest = await manifestFor(client, partialCandidate);
    await assert.rejects(
      publishHoldingProjectionReplacement(client, {
        candidate: partialCandidate,
        approval: approvalFor(partialManifest, second.activeGenerationId),
      }),
      /partial candidates cannot be published/,
    );

    await assert.rejects(
      client.query(
        `INSERT INTO holding_projection_generations
           (id, document_id, generation_number, generation_kind,
            retained_sha256, projection_digest, candidate_projection_digest,
            candidate_digest, candidate_manifest, old_projection_digest,
            approval_digest, approved_by, approved_at, completeness_attestation,
            removals_authorized, empty_projection_authorized,
            approval_expected_active_generation_id,
            expected_previous_generation_id, created_at, activated_at)
         SELECT 'malformed-generation', document_id, 99, generation_kind,
                retained_sha256, projection_digest, candidate_projection_digest,
                candidate_digest, candidate_manifest, old_projection_digest,
                approval_digest, approved_by, approved_at, NULL,
                removals_authorized, empty_projection_authorized,
                approval_expected_active_generation_id,
                expected_previous_generation_id, created_at, activated_at
           FROM holding_projection_generations WHERE id = $1`,
        [second.activeGenerationId],
      ),
      /check constraint/,
    );
    await assert.rejects(
      client.query(
        "UPDATE holding_projection_assertions SET source_locator = source_locator WHERE record_id = 'position-removed'",
      ),
      /history is immutable/,
    );
  },
);

test(
  "foreign-owned hashes, superseded documents and unauthorized ordinary replay fail closed without moving the active generation",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const parsed = candidate();
    const manifest = await manifestFor(client, parsed);
    const published = await publishHoldingProjectionReplacement(
      client,
      {
        candidate: parsed,
        approval: approvalFor(manifest, null),
      },
      NOW,
    );

    await assert.rejects(
      publishImport(client, { source: "ordinary", documents: [parsed] }, NOW),
      /authoritative exact replay/,
    );

    const foreignSha = "d".repeat(64);
    await client.query(
      `INSERT INTO documents
         (id, institution_id, account_id, doc_type, file_path, sha256, parsed_ok)
       VALUES ('foreign-document', $1, $2, 'statement', 'synthetic/foreign', $3, TRUE)`,
      [INSTITUTION, ACCOUNT, foreignSha],
    );
    const foreign = position({
      instrumentId: "instrument-foreign",
      marketValue: "33",
    });
    const foreignHash = positionHash({
      accountId: ACCOUNT,
      instrumentId: foreign.instrumentId,
      asOf: foreign.asOf,
      quantity: foreign.quantity,
      marketValue: foreign.marketValueText,
      costBasis: foreign.costBasis,
      valuationBasis: foreign.valuationBasis,
      sourceLocator: foreign.sourceLocator,
    });
    await client.query(
      `INSERT INTO positions
         (id, account_id, as_of, instrument_id, quantity, market_value,
          cost_basis, currency, valuation_basis, source_document_id,
          source_locator, row_hash)
       VALUES ('foreign-position', $1, $2, $3, $4, $5, $6, 'USD', $7, 'foreign-document', $8, $9)`,
      [
        ACCOUNT,
        foreign.asOf,
        foreign.instrumentId,
        foreign.quantity,
        foreign.marketValueText,
        foreign.costBasis,
        foreign.valuationBasis,
        foreign.sourceLocator,
        foreignHash,
      ],
    );
    const colliding = candidate({ positions: [position(), foreign] });
    const collisionManifest = await manifestFor(client, colliding);
    await assert.rejects(
      publishHoldingProjectionReplacement(client, {
        candidate: colliding,
        approval: approvalFor(collisionManifest, published.activeGenerationId),
      }),
      /owned by another document/,
    );
    assert.equal(
      (
        await one(
          client,
          "SELECT active_holding_projection_generation_id AS id FROM documents WHERE id = $1",
          [DOCUMENT],
        )
      ).id,
      published.activeGenerationId,
    );

    await client.query(
      "UPDATE documents SET superseded_by = 'foreign-document' WHERE id = $1",
      [DOCUMENT],
    );
    const currentManifest = await manifestFor(client, parsed);
    await assert.rejects(
      publishHoldingProjectionReplacement(client, {
        candidate: parsed,
        approval: approvalFor(currentManifest, published.activeGenerationId),
      }),
      /superseded documents/,
    );
  },
);
