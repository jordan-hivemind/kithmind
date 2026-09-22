import assert from "node:assert/strict";
import test from "node:test";

import {
  holdingAdditiveProjectionApprovalDigest,
  positionHash,
  prepareHoldingAdditivePositionCorrection,
  publishHoldingAdditivePositionCorrection,
} from "../dist/index.js";
import { readStoredHoldingProjection } from "../dist/holdingCorrectionCandidate.js";

import { all, archive, count, one, skip } from "./helpers/pgArchive.mjs";

const SHA = "9".repeat(64);
const FOREIGN_SHA = "8".repeat(64);
const DATE = "2026-06-30";
const DOCUMENT = "doc-additive";
const FOREIGN_DOCUMENT = "doc-additive-foreign";
const INSTITUTION = "inst-additive";
const ACCOUNT = "acct-additive";
const NOW = new Date("2026-09-22T08:00:00.000Z");

function locator(name, index) {
  return JSON.stringify({ row: { source: name, index } });
}

function position({
  instrumentId,
  quantity = "1",
  price = "100",
  marketValue = "100",
  marketValueNote = null,
  costBasis = "80",
  unrealized = "20",
  valuationBasis = "market_price",
  valuationNote = "synthetic stated value",
  sourceLocator,
}) {
  return {
    accountId: ACCOUNT,
    asOf: DATE,
    instrumentId,
    quantity,
    price,
    marketValueText: marketValue,
    marketValueNote,
    costBasis,
    unrealized,
    currency: "USD",
    valuationBasis,
    valuationNote,
    sourceLocator,
  };
}

function rowHash(row) {
  return positionHash({
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    asOf: row.asOf,
    quantity: row.quantity,
    marketValue: row.marketValueText,
    costBasis: row.costBasis,
    valuationBasis: row.valuationBasis,
    sourceLocator: row.sourceLocator,
  });
}

function evidence(index) {
  return {
    account: { source: "synthetic_statement", index },
    tables: [
      {
        headers: [{ source: "synthetic_statement", index: index + 1 }],
      },
    ],
  };
}

function scope(emittedPositionCount, index = 10) {
  return {
    accountId: ACCOUNT,
    asOf: DATE,
    proofVersion: "position_scope_v1",
    status: "partial",
    emittedPositionCount,
    gapCodes: ["unresolved_lots"],
    evidence: evidence(index),
  };
}

function candidate(positions, index = 10) {
  return {
    sha256: SHA,
    retainedSha256: SHA,
    retainedByteLength: 2048,
    mediaType: "application/pdf",
    captureId: "capture-additive",
    filePath: "synthetic/additive.pdf",
    textPath: null,
    institutionId: INSTITUTION,
    accountId: ACCOUNT,
    docType: "statement",
    docDate: DATE,
    providerDocumentId: null,
    providerReportedCount: 0,
    rows: [],
    reviewItems: [],
    parseNote: "valuation remains incomplete",
    positions,
    balances: [],
    liabilities: [],
    positionScopes: [scope(positions.length, index)],
    balanceScopes: [],
  };
}

function selection(selectedRowHashes) {
  return {
    scopes: [
      {
        scopeKind: "positions",
        accountId: ACCOUNT,
        asOf: DATE,
        proofVersion: "position_scope_v1",
      },
    ],
    selectedRowHashes,
  };
}

function approvalFor(manifest, selectedRowHashes) {
  const withoutDigest = {
    schemaVersion: 1,
    kind: "holding_additive_projection_approval_v1",
    documentId: DOCUMENT,
    retainedSha256: SHA,
    expectedActiveGenerationId: manifest.expectedActiveGenerationId,
    oldProjectionDigest: manifest.oldProjectionDigest,
    candidateProjectionDigest: manifest.candidateProjectionDigest,
    selectedCurrentDigest: manifest.selectedCurrentDigest,
    selectedRowsDigest: manifest.selectedRowsDigest,
    selectedScopes: manifest.selectedScopes.map(
      ({ scopeKind, accountId, asOf, proofVersion }) => ({
        scopeKind,
        accountId,
        asOf,
        proofVersion,
      }),
    ),
    selectedRowHashes,
    candidateDigest: manifest.candidateDigest,
    completenessAttestation: "operator_verified_source_additions_only",
    authorizeSourceOwnedAdditions: true,
    authorizeChanges: false,
    authorizeRemovals: false,
    approvedBy: "synthetic-reviewer",
    approvedAt: NOW.toISOString(),
  };
  return {
    ...withoutDigest,
    approvalDigest: holdingAdditiveProjectionApprovalDigest(withoutDigest),
  };
}

async function insertPosition(client, id, documentId, row) {
  await client.query(
    `INSERT INTO positions
       (id, account_id, as_of, instrument_id, quantity, price, market_value,
        cost_basis, unrealized, currency, valuation_basis, valuation_note,
        source_document_id, source_locator, row_hash)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15)`,
    [
      id,
      row.accountId,
      row.asOf,
      row.instrumentId,
      row.quantity,
      row.price,
      row.marketValueText,
      row.costBasis,
      row.unrealized,
      row.currency,
      row.valuationBasis,
      row.valuationNote,
      documentId,
      row.sourceLocator,
      rowHash(row),
    ],
  );
}

async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, 'Synthetic Additive', 'synthetic-additive')",
    [INSTITUTION],
  );
  await client.query(
    `INSERT INTO accounts
       (id, institution_id, acct_last4, display_name, account_type, base_currency)
     VALUES ($1, $2, '1001', 'Synthetic Additive', 'brokerage', 'USD')`,
    [ACCOUNT, INSTITUTION],
  );
  await client.query(
    `INSERT INTO instruments (id, symbol, name) VALUES
       ('instrument-corrected', 'CORR', 'Corrected holding'),
       ('instrument-foreign', 'FRGN', 'Foreign holding'),
       ('instrument-unpriced-one', 'UP1', 'Unpriced one'),
       ('instrument-unpriced-two', 'UP2', 'Unpriced two')`,
  );
  await client.query(
    `INSERT INTO documents
       (id, institution_id, account_id, doc_type, doc_date, file_path, sha256,
        parsed_ok, retained_sha256, retained_byte_length, media_type, capture_id)
     VALUES
       ($1, $2, $3, 'statement', $4::date, 'synthetic/additive.pdf', $5,
        FALSE, $5, 2048, 'application/pdf', 'capture-additive'),
       ($6, $2, $3, 'statement', $4::date, 'synthetic/foreign.pdf', $7,
        TRUE, $7, 1024, 'application/pdf', 'capture-additive-foreign')`,
    [DOCUMENT, INSTITUTION, ACCOUNT, DATE, SHA, FOREIGN_DOCUMENT, FOREIGN_SHA],
  );
  const corrected = position({
    instrumentId: "instrument-corrected",
    marketValue: "125",
    price: "125",
    costBasis: "90",
    unrealized: "35",
    sourceLocator: locator("corrected", 1),
  });
  const foreign = position({
    instrumentId: "instrument-foreign",
    marketValue: "50",
    price: "50",
    costBasis: "40",
    unrealized: "10",
    sourceLocator: locator("foreign-owner", 2),
  });
  await insertPosition(client, "position-corrected", DOCUMENT, corrected);
  await insertPosition(client, "position-foreign", FOREIGN_DOCUMENT, foreign);
  await client.query(
    `INSERT INTO review_items
       (id, kind, source_document_id, raw_value, reason, status)
     VALUES ('review-additive-open', 'document_unparsed', $1,
             'synthetic incomplete valuation', 'synthetic incomplete valuation', 'open')`,
    [DOCUMENT],
  );
  await client.query(
    `INSERT INTO position_scope_observations
       (id, source_document_id, holding_projection_generation_id,
        retained_sha256, account_id, as_of, proof_version, status,
        emitted_position_count, gap_codes, zero_basis, evidence, created_at)
     VALUES ('scope-legacy', $1, NULL, $2, $3, $4::date,
             'position_scope_v1', 'partial', 1,
             ARRAY['unresolved_lots'], NULL, $5::jsonb, $6)`,
    [
      DOCUMENT,
      SHA,
      ACCOUNT,
      DATE,
      JSON.stringify(evidence(1)),
      NOW.toISOString(),
    ],
  );
  await client.query(
    `INSERT INTO position_scope_memberships
       (source_document_id, scope_id, position_row_hash, account_id, as_of,
        instrument_id, quantity, price, market_value, cost_basis, unrealized,
        currency, valuation_basis, valuation_note, source_locator)
     VALUES ($1, 'scope-legacy', $2, $3, $4::date, $5, $6, $7, $8, $9,
             $10, $11, $12, $13, $14)`,
    [
      DOCUMENT,
      rowHash(corrected),
      ACCOUNT,
      DATE,
      corrected.instrumentId,
      corrected.quantity,
      corrected.price,
      corrected.marketValueText,
      corrected.costBasis,
      corrected.unrealized,
      corrected.currency,
      corrected.valuationBasis,
      corrected.valuationNote,
      corrected.sourceLocator,
    ],
  );
  return { corrected, foreign };
}

function unpriced(instrumentId, name, quantity = "5") {
  const note = 'no value stated ("N/A")';
  return position({
    instrumentId,
    quantity,
    price: null,
    marketValue: null,
    marketValueNote: note,
    costBasis: "50",
    unrealized: null,
    valuationBasis: null,
    valuationNote: note,
    sourceLocator: JSON.stringify({
      row: { source: name, index: 9 },
      price: {
        source: "synthetic_statement",
        index: 9,
        binding: {
          format: "retained_text_span_v1",
          textSha256: "7".repeat(64),
          textByteLength: 100,
          textCodepointLength: 100,
          start: 10,
          end: 13,
          quote: "N/A",
        },
      },
      marketValue: {
        source: "synthetic_statement",
        index: 9,
        binding: {
          format: "retained_text_span_v1",
          textSha256: "7".repeat(64),
          textByteLength: 100,
          textCodepointLength: 100,
          start: 20,
          end: 23,
          quote: "N/A",
        },
      },
    }),
  });
}

async function prepare(client, parsed, selectedRowHashes) {
  const stored = await readStoredHoldingProjection(client, DOCUMENT);
  const document = await one(
    client,
    "SELECT active_holding_projection_generation_id AS active FROM documents WHERE id = $1",
    [DOCUMENT],
  );
  return prepareHoldingAdditivePositionCorrection({
    client,
    documentId: DOCUMENT,
    retainedSha256: SHA,
    expectedActiveGenerationId: document.active,
    stored,
    candidate: parsed,
    selectors: selection(selectedRowHashes).scopes,
    selectedRowHashes,
  });
}

test(
  "additive partial publication bootstraps legacy proof, preserves corrected assertions and references foreign rows",
  { skip },
  async (t) => {
    const client = await archive(t);
    const { corrected, foreign } = await seed(client);
    const legacyBefore = await one(
      client,
      `SELECT row_to_json(o)::text AS body
         FROM position_scope_observations o WHERE id = 'scope-legacy'`,
    );
    const currentBefore = await one(
      client,
      `SELECT row_to_json(p)::text AS body FROM positions p
        WHERE id = 'position-corrected'`,
    );

    const parserDrift = { ...corrected, price: "124", unrealized: "34" };
    const foreignReference = {
      ...foreign,
      sourceLocator: locator("foreign-proof-from-selected-source", 3),
    };
    const first = unpriced("instrument-unpriced-one", "unpriced-one");
    const parsed = candidate([parserDrift, foreignReference, first]);
    const prepared = await prepare(client, parsed, [rowHash(first)]);
    assert.equal(
      (
        await one(
          client,
          "SELECT holding_additive_manifest_has_valid_scopes($1::jsonb) AS valid",
          [prepared.manifest],
        )
      ).valid,
      true,
    );
    for (const [missingKey, replacementKey] of [
      ["status", "unknownStatus"],
      ["sourceOwnedAdditions", "unknownCount"],
    ]) {
      const malformed = structuredClone(prepared.manifest);
      malformed.selectedScopes[0][replacementKey] =
        malformed.selectedScopes[0][missingKey];
      delete malformed.selectedScopes[0][missingKey];
      assert.equal(
        (
          await one(
            client,
            "SELECT holding_additive_manifest_has_valid_scopes($1::jsonb) AS valid",
            [malformed],
          )
        ).valid,
        false,
      );
    }
    const scalarScope = {
      ...prepared.manifest,
      selectedScopes: [null],
    };
    assert.equal(
      (
        await one(
          client,
          "SELECT holding_additive_manifest_has_valid_scopes($1::jsonb) AS valid",
          [scalarScope],
        )
      ).valid,
      false,
    );
    assert.equal(prepared.manifest.rows.changedRows, 0);
    assert.equal(prepared.manifest.rows.removedRows, 0);
    assert.equal(prepared.manifest.rows.sourceOwnedAdditions, 1);
    assert.deepEqual(
      prepared.manifest.selectedScopes.map((item) => ({
        status: item.status,
        additions: item.sourceOwnedAdditions,
        foreign: item.exactForeignReferences,
        unmatched: item.unmatchedPartialMembers,
      })),
      [{ status: "partial", additions: 1, foreign: 1, unmatched: 1 }],
    );

    const firstApproval = approvalFor(prepared.manifest, [rowHash(first)]);
    const firstPublication = await publishHoldingAdditivePositionCorrection(
      client,
      { candidate: parsed, approval: firstApproval },
      NOW,
    );
    assert.equal(firstPublication.previousGenerationId.length > 0, true);
    assert.equal(firstPublication.mintedIds, 1);
    assert.equal(await count(client, "holding_projection_generations"), 2);
    assert.equal(
      await count(client, "positions", "WHERE source_document_id = $1", [
        DOCUMENT,
      ]),
      2,
    );
    assert.equal(
      await count(client, "positions", "WHERE source_document_id = $1", [
        FOREIGN_DOCUMENT,
      ]),
      1,
    );
    assert.deepEqual(
      await one(
        client,
        `SELECT parsed_ok, active_holding_projection_generation_id AS active
           FROM documents WHERE id = $1`,
        [DOCUMENT],
      ),
      { parsed_ok: false, active: firstPublication.activeGenerationId },
    );
    assert.equal(
      (
        await one(
          client,
          `SELECT row_to_json(p)::text AS body FROM positions p
            WHERE id = 'position-corrected'`,
        )
      ).body,
      currentBefore.body,
    );
    assert.equal(
      (
        await one(
          client,
          `SELECT row_to_json(o)::text AS body
             FROM position_scope_observations o WHERE id = 'scope-legacy'`,
        )
      ).body,
      legacyBefore.body,
    );
    assert.equal(
      await count(
        client,
        "position_scope_observations",
        "WHERE source_document_id = $1 AND holding_projection_generation_id = $2 AND status = 'partial'",
        [DOCUMENT, firstPublication.activeGenerationId],
      ),
      1,
    );
    assert.equal(
      await count(
        client,
        "position_scope_memberships m JOIN position_scope_observations o ON o.id = m.scope_id",
        "WHERE o.holding_projection_generation_id = $1",
        [firstPublication.activeGenerationId],
      ),
      3,
    );
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE id = 'review-additive-open' AND status = 'open'",
      ),
      1,
    );
    assert.deepEqual(
      await one(
        client,
        `SELECT status, gap_codes
           FROM position_scope_observations
          WHERE source_document_id = $1
            AND holding_projection_generation_id = $2`,
        [DOCUMENT, firstPublication.activeGenerationId],
      ),
      { status: "partial", gap_codes: ["unresolved_lots"] },
    );
    await assert.rejects(
      client.query(
        `INSERT INTO holding_projection_generations
           (id, document_id, generation_number, generation_kind,
            retained_sha256, projection_digest, candidate_projection_digest,
            candidate_digest, candidate_manifest, old_projection_digest,
            approval_digest, approved_by, approved_at,
            completeness_attestation, removals_authorized,
            empty_projection_authorized,
            approval_expected_active_generation_id,
            expected_previous_generation_id, created_at, activated_at)
         SELECT 'generation-tampered', document_id, 99, generation_kind,
                retained_sha256, projection_digest, candidate_projection_digest,
                candidate_digest,
                jsonb_set(candidate_manifest, '{rows,changedRows}', '1'::jsonb),
                old_projection_digest, approval_digest, approved_by, approved_at,
                completeness_attestation, removals_authorized,
                empty_projection_authorized,
                approval_expected_active_generation_id,
                expected_previous_generation_id, created_at, activated_at
           FROM holding_projection_generations
          WHERE id = $1`,
        [firstPublication.activeGenerationId],
      ),
      /violates check constraint "holding_projection_generations_shape_check"/,
    );
    assert.equal(await count(client, "holding_projection_generations"), 2);

    const firstAssertions = await all(
      client,
      `SELECT a.record_id, a.assertion_digest, a.source_locator
         FROM holding_projection_generation_memberships m
         JOIN holding_projection_assertions a
           ON a.source_document_id = m.document_id
          AND a.assertion_kind = m.assertion_kind
          AND a.record_id = m.record_id
        WHERE m.document_id = $1 AND m.generation_id = $2
        ORDER BY a.record_id`,
      [DOCUMENT, firstPublication.activeGenerationId],
    );
    const second = unpriced("instrument-unpriced-two", "unpriced-two", "7");
    const secondParsed = candidate(
      [
        { ...parserDrift, price: "123", unrealized: "33" },
        foreignReference,
        { ...first, price: "not-readable" },
        second,
      ],
      20,
    );
    const secondPrepared = await prepare(client, secondParsed, [
      rowHash(second),
    ]);
    const secondApproval = approvalFor(secondPrepared.manifest, [
      rowHash(second),
    ]);
    const secondPublication = await publishHoldingAdditivePositionCorrection(
      client,
      { candidate: secondParsed, approval: secondApproval },
      new Date("2026-09-22T08:01:00.000Z"),
    );
    const carried = await all(
      client,
      `SELECT a.record_id, a.assertion_digest, a.source_locator
         FROM holding_projection_generation_memberships m
         JOIN holding_projection_assertions a
           ON a.source_document_id = m.document_id
          AND a.assertion_kind = m.assertion_kind
          AND a.record_id = m.record_id
        WHERE m.document_id = $1 AND m.generation_id = $2
          AND a.record_id = ANY($3::text[])
        ORDER BY a.record_id`,
      [
        DOCUMENT,
        secondPublication.activeGenerationId,
        firstAssertions.map((row) => row.record_id),
      ],
    );
    assert.deepEqual(carried, firstAssertions);
    assert.equal(await count(client, "holding_projection_generations"), 3);
    assert.equal(
      await count(client, "positions", "WHERE source_document_id = $1", [
        DOCUMENT,
      ]),
      3,
    );
    assert.equal(
      await count(
        client,
        "position_scope_observations",
        "WHERE source_document_id = $1 AND holding_projection_generation_id = $2 AND status = 'partial'",
        [DOCUMENT, secondPublication.activeGenerationId],
      ),
      1,
    );
  },
);

test(
  "additive partial publication refuses evidence conflicts and stale approval with no mutation",
  { skip },
  async (t) => {
    const client = await archive(t);
    const { corrected } = await seed(client);
    const conflict = position({
      instrumentId: "instrument-unpriced-one",
      marketValue: "75",
      price: "15",
      costBasis: "50",
      unrealized: "25",
      sourceLocator: corrected.sourceLocator,
    });
    await assert.rejects(
      prepare(client, candidate([conflict]), [rowHash(conflict)]),
      /conflicts with an existing source-owned evidence boundary/,
    );
    assert.equal(await count(client, "holding_projection_generations"), 0);
    assert.equal(await count(client, "holding_projection_assertions"), 0);
    assert.equal(
      await count(client, "positions", "WHERE source_document_id = $1", [
        DOCUMENT,
      ]),
      1,
    );

    const unsupportedNull = position({
      instrumentId: "instrument-unpriced-one",
      price: null,
      marketValue: null,
      marketValueNote: "parser could not read the market value",
      valuationBasis: null,
      valuationNote: "parser could not read the market value",
      sourceLocator: locator("unbound-null-value", 4),
    });
    await assert.rejects(
      prepare(
        client,
        candidate([unsupportedNull]),
        [rowHash(unsupportedNull)],
      ),
      /lacks source-stated evidence/,
    );
    assert.equal(await count(client, "holding_projection_generations"), 0);
    assert.equal(await count(client, "holding_projection_assertions"), 0);

    const addition = unpriced(
      "instrument-unpriced-one",
      "valid-after-conflict",
    );
    const parsed = candidate([corrected, addition]);
    const prepared = await prepare(client, parsed, [rowHash(addition)]);
    const approval = approvalFor(prepared.manifest, [rowHash(addition)]);
    const staleWithoutDigest = {
      ...approval,
      candidateDigest: "0".repeat(64),
    };
    delete staleWithoutDigest.approvalDigest;
    const stale = {
      ...staleWithoutDigest,
      approvalDigest:
        holdingAdditiveProjectionApprovalDigest(staleWithoutDigest),
    };
    await assert.rejects(
      publishHoldingAdditivePositionCorrection(
        client,
        { candidate: parsed, approval: stale },
        NOW,
      ),
      /does not bind the selected candidate and state/,
    );
    assert.equal(await count(client, "holding_projection_generations"), 0);
    assert.equal(await count(client, "holding_projection_assertions"), 0);
    assert.equal(await count(client, "position_scope_observations"), 1);
    assert.equal(
      await count(client, "positions", "WHERE source_document_id = $1", [
        DOCUMENT,
      ]),
      1,
    );
  },
);
