import assert from "node:assert/strict";
import test from "node:test";

import {
  holdingScopedProjectionApprovalDigest,
  positionHash,
  prepareHoldingScopedPositionCorrection,
  publishHoldingScopedPositionCorrection,
} from "../dist/index.js";
import { readStoredHoldingProjection } from "../dist/holdingCorrectionCandidate.js";

import { archive, count, one, skip } from "./helpers/pgArchive.mjs";

const SHA = "e".repeat(64);
const DATE = "2026-06-30";
const DOCUMENT = "doc-scoped";
const FOREIGN_DOCUMENT = "doc-foreign";
const INSTITUTION = "inst-scoped";
const ACCOUNT_A = "acct-scoped-a";
const ACCOUNT_B = "acct-scoped-b";
const ACCOUNT_C = "acct-scoped-c";
const NOW = new Date("2026-09-21T19:00:00.000Z");

function locator(source, index) {
  return JSON.stringify({ row: { source, index } });
}

function position(accountId, instrumentId, marketValue, sourceLocator) {
  return {
    accountId,
    asOf: DATE,
    instrumentId,
    quantity: "1",
    price: marketValue,
    marketValueText: marketValue,
    marketValueNote: null,
    costBasis: marketValue,
    unrealized: "0",
    currency: "USD",
    valuationBasis: "market_price",
    valuationNote: null,
    sourceLocator,
  };
}

function hash(row) {
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
        end: { source: "synthetic_statement", index: index + 3 },
      },
    ],
    scopeEnd: { source: "synthetic_statement", index: index + 4 },
  };
}

function scope(accountId, status = "complete", index = 10) {
  return {
    accountId,
    asOf: DATE,
    proofVersion: "position_scope_v1",
    status,
    emittedPositionCount: 1,
    gapCodes: status === "complete" ? [] : ["unresolved_lots"],
    evidence: evidence(index),
  };
}

function candidate(aPositions) {
  const b = position(ACCOUNT_B, "instrument-b", "200", locator("b", 2));
  const c = position(ACCOUNT_C, "instrument-c", "300", locator("c", 3));
  return {
    sha256: SHA,
    retainedSha256: SHA,
    retainedByteLength: 2048,
    mediaType: "application/pdf",
    captureId: "capture-scoped",
    filePath: "synthetic/scoped.pdf",
    textPath: null,
    institutionId: INSTITUTION,
    accountId: null,
    docType: "statement",
    docDate: DATE,
    providerDocumentId: null,
    providerReportedCount: 0,
    rows: [],
    reviewItems: [],
    parseNote: "neighbor account remains partial",
    positions: [...aPositions, b, c],
    balances: [],
    liabilities: [],
    positionScopes: [
      {
        ...scope(ACCOUNT_A, "complete", 10),
        emittedPositionCount: aPositions.length,
        ...(aPositions.length === 0
          ? {
              zeroBasis: "source_stated_none",
              evidence: {
                ...evidence(10),
                explicitNone: { source: "synthetic_statement", index: 12 },
              },
            }
          : {}),
      },
      scope(ACCOUNT_B, "complete", 20),
      scope(ACCOUNT_C, "partial", 30),
    ],
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
      hash(row),
    ],
  );
}

async function seedScope(client, id, accountId, status, row, index) {
  await client.query(
    `INSERT INTO position_scope_observations
       (id, source_document_id, holding_projection_generation_id,
        retained_sha256, account_id, as_of, proof_version, status,
        emitted_position_count, gap_codes, zero_basis, evidence, created_at)
     VALUES ($1, $2, NULL, $3, $4, $5::date, 'position_scope_v1', $6,
             1, $7::text[], NULL, $8::jsonb, $9)`,
    [
      id,
      DOCUMENT,
      SHA,
      accountId,
      DATE,
      status,
      status === "complete" ? [] : ["unresolved_lots"],
      JSON.stringify(evidence(index)),
      NOW.toISOString(),
    ],
  );
  await client.query(
    `INSERT INTO position_scope_memberships
       (source_document_id, scope_id, position_row_hash, account_id, as_of,
        instrument_id, quantity, price, market_value, cost_basis, unrealized,
        currency, valuation_basis, valuation_note, source_locator)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15)`,
    [
      DOCUMENT,
      id,
      hash(row),
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
      row.sourceLocator,
    ],
  );
}

async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, 'Synthetic Scoped', 'synthetic-scoped')",
    [INSTITUTION],
  );
  for (const [id, suffix] of [
    [ACCOUNT_A, "1001"],
    [ACCOUNT_B, "1002"],
    [ACCOUNT_C, "1003"],
  ]) {
    await client.query(
      `INSERT INTO accounts
         (id, institution_id, acct_last4, display_name, account_type, base_currency)
       VALUES ($1, $2, $3, $1, 'brokerage', 'USD')`,
      [id, INSTITUTION, suffix],
    );
  }
  await client.query(
    `INSERT INTO instruments (id, symbol, name) VALUES
       ('instrument-a-old', 'AOLD', 'A old'),
       ('instrument-a-new', 'ANEW', 'A new'),
       ('instrument-a-foreign', 'AFRN', 'A foreign'),
       ('instrument-b', 'B', 'B'),
       ('instrument-c', 'C', 'C')`,
  );
  await client.query(
    `INSERT INTO documents
       (id, institution_id, account_id, doc_type, doc_date, file_path, sha256,
        parsed_ok, retained_sha256, retained_byte_length, media_type, capture_id)
     VALUES
       ($1, $2, NULL, 'statement', $3::date, 'synthetic/scoped.pdf', $4,
        FALSE, $4, 2048, 'application/pdf', 'capture-scoped'),
       ($5, $2, $6, 'statement', $3::date, 'synthetic/foreign.pdf', $7,
        TRUE, $7, 1024, 'application/pdf', 'capture-foreign')`,
    [
      DOCUMENT,
      INSTITUTION,
      DATE,
      SHA,
      FOREIGN_DOCUMENT,
      ACCOUNT_A,
      "f".repeat(64),
    ],
  );
  const oldA = position(
    ACCOUNT_A,
    "instrument-a-old",
    "100",
    locator("a-old", 1),
  );
  const foreignA = position(
    ACCOUNT_A,
    "instrument-a-foreign",
    "50",
    locator("foreign", 8),
  );
  const b = position(ACCOUNT_B, "instrument-b", "200", locator("b", 2));
  const c = position(ACCOUNT_C, "instrument-c", "300", locator("c", 3));
  await insertPosition(client, "position-a-old", DOCUMENT, oldA);
  await insertPosition(
    client,
    "position-a-foreign",
    FOREIGN_DOCUMENT,
    foreignA,
  );
  await client.query(
    `UPDATE positions
        SET quantity = 1.000, price = 50.00, market_value = 50.000,
            cost_basis = 50.0, unrealized = 0.00
      WHERE id = 'position-a-foreign'`,
  );
  await insertPosition(client, "position-b", DOCUMENT, b);
  await insertPosition(client, "position-c", DOCUMENT, c);
  await client.query(
    `INSERT INTO balances
       (id, account_id, as_of, total_value, cash, currency, source_document_id,
        source_locator, row_hash)
     VALUES ('balance-b', $1, $2::date, 200, 10, 'USD', $3, $4, 'balance-hash')`,
    [ACCOUNT_B, DATE, DOCUMENT, locator("balance", 1)],
  );
  await client.query(
    `INSERT INTO liabilities
       (id, institution_id, account_id, kind, display_name, balance, currency,
        as_of, source_document_id, source_locator, row_hash)
     VALUES ('liability-c', $1, $2, 'margin', 'Synthetic margin', 25, 'USD',
             $3::date, $4, $5, 'liability-hash')`,
    [INSTITUTION, ACCOUNT_C, DATE, DOCUMENT, locator("liability", 1)],
  );
  await seedScope(client, "scope-b-old", ACCOUNT_B, "complete", b, 20);
  await seedScope(client, "scope-c-old", ACCOUNT_C, "partial", c, 30);
  await client.query(
    `INSERT INTO review_items
       (id, kind, source_document_id, account_id, raw_value, reason, status)
     VALUES
       ('review-a-scope', 'position_scope_mismatch', $1, $2, $3,
        'synthetic mismatch', 'open'),
       ('review-unparsed', 'document_unparsed', $1, NULL, 'synthetic gap',
        'synthetic gap', 'open')`,
    [DOCUMENT, ACCOUNT_A, `${ACCOUNT_A}:${DATE}:position_scope_v1`],
  );
  await client.query(
    `INSERT INTO position_reconciliations
       (id, account_id, instrument_id, period_start, period_end,
        expected_change, computed_change, delta, status, notes)
     VALUES ('stale-a-old-verdict', $1, 'instrument-a-old',
             DATE '2026-03-31', $2::date, 0, 0, 0, 'pass',
             'synthetic verdict that must be retired with the removed series')`,
    [ACCOUNT_A, DATE],
  );
  return { oldA, foreignA, b, c };
}

async function prepare(client, parsed) {
  const document = await one(
    client,
    `SELECT retained_sha256,
            active_holding_projection_generation_id AS active_generation_id
       FROM documents WHERE id = $1`,
    [DOCUMENT],
  );
  return prepareHoldingScopedPositionCorrection({
    client,
    documentId: DOCUMENT,
    retainedSha256: document.retained_sha256,
    expectedActiveGenerationId: document.active_generation_id,
    stored: await readStoredHoldingProjection(client, DOCUMENT),
    candidate: parsed,
    selectors: [
      {
        scopeKind: "positions",
        accountId: ACCOUNT_A,
        asOf: DATE,
        proofVersion: "position_scope_v1",
      },
    ],
  });
}

function approvalFor(manifest) {
  const unsigned = {
    schemaVersion: 1,
    kind: "holding_scoped_projection_approval_v1",
    documentId: DOCUMENT,
    retainedSha256: SHA,
    expectedActiveGenerationId: manifest.expectedActiveGenerationId,
    oldProjectionDigest: manifest.oldProjectionDigest,
    candidateProjectionDigest: manifest.candidateProjectionDigest,
    selectedCurrentDigest: manifest.selectedCurrentDigest,
    selectedScopes: manifest.selectedScopes.map(
      ({ scopeKind, accountId, asOf, proofVersion }) => ({
        scopeKind,
        accountId,
        asOf,
        proofVersion,
      }),
    ),
    candidateDigest: manifest.candidateDigest,
    completenessAttestation: "operator_verified_complete_scopes",
    authorizeSelectedRemovals: Object.values(manifest.rows).some(
      (table) => table.selectedSourceOwnedRemovals > 0,
    ),
    authorizeEmptySelectedScopes: manifest.selectedScopes.some(
      (scope) => scope.emittedRowCount === 0,
    ),
    approvedBy: "synthetic-reviewer",
    approvedAt: NOW.toISOString(),
  };
  return {
    ...unsigned,
    approvalDigest: holdingScopedProjectionApprovalDigest(unsigned),
  };
}

test(
  "scoped publication preserves neighbors, carries scope proofs and references exact foreign rows without rehoming",
  { skip },
  async (t) => {
    const client = await archive(t);
    const seeded = await seed(client);
    const newA = position(
      ACCOUNT_A,
      "instrument-a-new",
      "125",
      locator("a-new", 4),
    );
    const parsed = candidate([newA, seeded.foreignA]);
    const before = await one(
      client,
      `SELECT
         (SELECT to_jsonb(p) FROM positions p WHERE id = 'position-b') AS position_b,
         (SELECT to_jsonb(b) FROM balances b WHERE id = 'balance-b') AS balance_b,
         (SELECT to_jsonb(l) FROM liabilities l WHERE id = 'liability-c') AS liability_c`,
    );
    const prepared = await prepare(client, parsed);
    assert.equal(prepared.manifest.selectedScopes[0].sourceOwnedRows, 1);
    assert.equal(prepared.manifest.selectedScopes[0].foreignReferencedRows, 1);
    const approval = approvalFor(prepared.manifest);
    const published = await publishHoldingScopedPositionCorrection(
      client,
      { candidate: parsed, approval },
      NOW,
    );

    assert.equal(
      await count(client, "positions", "WHERE id = 'position-a-old'"),
      0,
    );
    assert.deepEqual(
      await one(
        client,
        `SELECT source_document_id, market_value::text AS market_value
           FROM positions WHERE row_hash = $1`,
        [hash(seeded.foreignA)],
      ),
      { source_document_id: FOREIGN_DOCUMENT, market_value: "50.000" },
    );
    const after = await one(
      client,
      `SELECT
         (SELECT to_jsonb(p) FROM positions p WHERE id = 'position-b') AS position_b,
         (SELECT to_jsonb(b) FROM balances b WHERE id = 'balance-b') AS balance_b,
         (SELECT to_jsonb(l) FROM liabilities l WHERE id = 'liability-c') AS liability_c,
         (SELECT parsed_ok FROM documents WHERE id = $1) AS parsed_ok`,
      [DOCUMENT],
    );
    assert.deepEqual(after.position_b, before.position_b);
    assert.deepEqual(after.balance_b, before.balance_b);
    assert.deepEqual(after.liability_c, before.liability_c);
    assert.equal(after.parsed_ok, false);

    const scopes = (
      await client.query(
        `SELECT account_id, status, emitted_position_count::text AS count
           FROM position_scope_observations
          WHERE source_document_id = $1
            AND holding_projection_generation_id = $2
          ORDER BY account_id`,
        [DOCUMENT, published.activeGenerationId],
      )
    ).rows;
    assert.deepEqual(scopes, [
      { account_id: ACCOUNT_A, status: "complete", count: "2" },
      { account_id: ACCOUNT_B, status: "complete", count: "1" },
      { account_id: ACCOUNT_C, status: "partial", count: "1" },
    ]);
    assert.deepEqual(
      await one(
        client,
        `SELECT
           (SELECT status FROM review_items WHERE id = 'review-a-scope') AS scope_status,
           (SELECT status FROM review_items WHERE id = 'review-unparsed') AS unparsed_status`,
      ),
      { scope_status: "resolved", unparsed_status: "open" },
    );
    assert.equal(
      await count(
        client,
        "holding_projection_assertions",
        "WHERE assertion_kind = 'position' AND record_id = 'position-a-old'",
      ),
      1,
    );
    assert.equal(
      await count(
        client,
        "position_reconciliations",
        "WHERE id = 'stale-a-old-verdict'",
      ),
      0,
    );

    await assert.rejects(
      publishHoldingScopedPositionCorrection(client, {
        candidate: parsed,
        approval,
      }),
      /scoped approval does not bind/,
    );

    const newerA = position(
      ACCOUNT_A,
      "instrument-a-new",
      "130",
      locator("a-newer", 5),
    );
    const secondParsed = candidate([newerA, seeded.foreignA]);
    const secondPrepared = await prepare(client, secondParsed);
    const second = await publishHoldingScopedPositionCorrection(
      client,
      {
        candidate: secondParsed,
        approval: approvalFor(secondPrepared.manifest),
      },
      new Date("2026-09-21T19:01:00.000Z"),
    );
    assert.equal(second.generationNumber, 3);
    assert.equal(await count(client, "holding_projection_generations"), 3);
    assert.equal(
      await count(
        client,
        "holding_projection_assertions",
        "WHERE assertion_kind = 'position' AND record_id = 'position-a-old'",
      ),
      1,
    );
  },
);

test(
  "a positively empty selected scope removes its last owned position and stale instrument verdict while preserving its neighbor",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await client.query(
      "DELETE FROM positions WHERE source_document_id = $1",
      [FOREIGN_DOCUMENT],
    );
    const neighborBefore = await one(
      client,
      "SELECT to_jsonb(p) AS row FROM positions p WHERE id = 'position-b'",
    );
    const parsed = candidate([]);
    const prepared = await prepare(client, parsed);
    assert.equal(prepared.manifest.selectedScopes[0].emittedRowCount, 0);
    assert.equal(
      prepared.manifest.rows.positions.selectedSourceOwnedRemovals,
      1,
    );
    const approval = approvalFor(prepared.manifest);
    assert.equal(approval.authorizeSelectedRemovals, true);
    assert.equal(approval.authorizeEmptySelectedScopes, true);

    const published = await publishHoldingScopedPositionCorrection(
      client,
      { candidate: parsed, approval },
      NOW,
    );

    assert.equal(
      await count(client, "positions", `WHERE account_id = '${ACCOUNT_A}'`),
      0,
    );
    assert.deepEqual(
      await one(
        client,
        "SELECT to_jsonb(p) AS row FROM positions p WHERE id = 'position-b'",
      ),
      neighborBefore,
    );
    assert.equal(
      await count(
        client,
        "position_reconciliations",
        "WHERE id = 'stale-a-old-verdict'",
      ),
      0,
    );
    assert.deepEqual(
      await one(
        client,
        `SELECT status, emitted_position_count::text AS count, zero_basis
           FROM position_scope_observations
          WHERE source_document_id = $1
            AND holding_projection_generation_id = $2
            AND account_id = $3`,
        [DOCUMENT, published.activeGenerationId, ACCOUNT_A],
      ),
      { status: "complete", count: "0", zero_basis: "source_stated_none" },
    );
  },
);

test(
  "scoped candidate refuses unrepresented or semantically conflicting foreign rows without writes",
  { skip },
  async (t) => {
    const client = await archive(t);
    const seeded = await seed(client);
    const newA = position(
      ACCOUNT_A,
      "instrument-a-new",
      "125",
      locator("a-new", 4),
    );
    await assert.rejects(
      prepare(client, candidate([newA])),
      /does not represent every foreign-owned row/,
    );

    const conflict = { ...seeded.foreignA, price: "51" };
    await assert.rejects(
      prepare(client, candidate([newA, conflict])),
      /foreign-owned selected position has different semantics/,
    );
    assert.equal(await count(client, "holding_projection_generations"), 0);
    assert.equal(await count(client, "positions"), 4);
  },
);
