import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { parseFinanceReadRequest } from "@repo/finance-contract";

import { serveFinanceRead } from "../dist/index.js";
import { archive, skip } from "./helpers/pgArchive.mjs";

const SPACE = "space-snapshot-performance";
const ACCOUNT = "account-snapshot-performance";
const INSTITUTION = "institution-snapshot-performance";
const AS_OF = "2026-06-30";
const DOCUMENT_COUNT = 120;
const GENERATIONS_PER_DOCUMENT = 80;
const POSITION_COUNT = 350;

async function seedHistoricalScopes(client) {
  await client.query(
    `INSERT INTO institutions (id, name, slug)
     VALUES ($1, 'Synthetic Snapshot Performance', 'snapshot-performance')`,
    [INSTITUTION],
  );
  await client.query(
    `INSERT INTO accounts
       (id, institution_id, acct_last4, display_name, account_type,
        base_currency)
     VALUES ($1, $2, '9001', 'Synthetic Performance Account',
             'brokerage', 'USD')`,
    [ACCOUNT, INSTITUTION],
  );
  await client.query(
    `INSERT INTO instruments (id, symbol, name)
     SELECT 'instrument-snapshot-performance-' || position_number,
            'PERF' || position_number,
            'Synthetic Performance Holding ' || position_number
       FROM generate_series(1, $1) position_number`,
    [POSITION_COUNT],
  );
  await client.query(
    `INSERT INTO documents
       (id, institution_id, account_id, doc_type, doc_date, file_path, sha256,
        parsed_ok, retained_sha256, retained_byte_length, media_type,
        capture_id)
     SELECT 'document-performance-' || document_number,
            $1, $2, 'statement', $3::date,
            'synthetic/performance-' || document_number || '.pdf',
            repeat(md5('document-' || document_number), 2), FALSE,
            repeat(md5('document-' || document_number), 2), 100,
            'application/pdf', 'capture-performance-' || document_number
       FROM generate_series(1, $4) document_number`,
    [INSTITUTION, ACCOUNT, AS_OF, DOCUMENT_COUNT],
  );
  await client.query(
    `INSERT INTO holding_projection_generations
       (id, document_id, generation_number, generation_kind,
        retained_sha256, projection_digest, created_at, activated_at)
     SELECT 'generation-performance-' || document_number || '-' || generation_number,
            'document-performance-' || document_number,
            generation_number, 'baseline',
            repeat(md5('document-' || document_number), 2),
            repeat(md5('projection-' || document_number || '-' || generation_number), 2),
            now(), now()
       FROM generate_series(1, $1) document_number
       CROSS JOIN generate_series(1, $2) generation_number`,
    [DOCUMENT_COUNT, GENERATIONS_PER_DOCUMENT],
  );
  await client.query(
    `UPDATE documents
        SET active_holding_projection_generation_id =
              'generation-performance-' ||
              split_part(id, '-', 3) || '-' || $1
      WHERE id LIKE 'document-performance-%'`,
    [GENERATIONS_PER_DOCUMENT],
  );
  await client.query(
    `INSERT INTO positions
       (id, account_id, as_of, instrument_id, quantity, price, market_value,
        cost_basis, unrealized, currency, valuation_basis, valuation_note,
        source_document_id, source_locator, row_hash)
     SELECT 'position-snapshot-performance-' || position_number,
        $1, $2::date,
        'instrument-snapshot-performance-' || position_number,
        2, 50, 100, 80, 20, 'USD',
        'market_price', 'Synthetic statement market value',
        'document-performance-1',
        jsonb_build_object(
          'row', jsonb_build_object(
            'source', 'synthetic', 'index', position_number))::text,
        repeat(md5('position-' || position_number), 2)
       FROM generate_series(1, $3) position_number`,
    [ACCOUNT, AS_OF, POSITION_COUNT],
  );
  await client.query(
    `INSERT INTO position_scope_observations
       (id, source_document_id, holding_projection_generation_id,
        retained_sha256, account_id, as_of, proof_version, status,
        emitted_position_count, gap_codes, zero_basis, evidence, created_at)
     SELECT 'scope-performance-' || document_number || '-' || generation_number,
            'document-performance-' || document_number,
            'generation-performance-' || document_number || '-' || generation_number,
            repeat(md5('document-' || document_number), 2),
            $1, $2::date, 'position_scope_v1',
            CASE WHEN generation_number = $4 THEN 'complete' ELSE 'partial' END,
            CASE WHEN generation_number = $4 THEN $5 ELSE 0 END,
            CASE WHEN generation_number = $4
                 THEN '{}'::text[] ELSE ARRAY['unresolved_lots'] END,
            NULL,
            '{"tables":[{"headers":[{"source":"synthetic","index":1}],"end":{"source":"synthetic","index":2}}],"scopeEnd":{"source":"synthetic","index":3}}'::jsonb,
            now()
       FROM generate_series(1, $3) document_number
       CROSS JOIN generate_series(1, $4) generation_number`,
    [
      ACCOUNT,
      AS_OF,
      DOCUMENT_COUNT,
      GENERATIONS_PER_DOCUMENT,
      POSITION_COUNT,
    ],
  );
  await client.query(
    `INSERT INTO position_scope_memberships
       (source_document_id, scope_id, position_row_hash, account_id, as_of,
        instrument_id, quantity, price, market_value, cost_basis, unrealized,
        currency, valuation_basis, valuation_note, source_locator)
     SELECT 'document-performance-' || document_number,
            'scope-performance-' || document_number || '-' || $3,
            repeat(md5('position-' || position_number), 2),
            $1, $2::date,
            'instrument-snapshot-performance-' || position_number,
            2, 50, 100, 80, 20, 'USD', 'market_price',
            'Synthetic statement market value',
            jsonb_build_object(
              'row', jsonb_build_object(
                'source', 'synthetic-proof', 'index', position_number))::text
       FROM generate_series(1, $4) document_number
       CROSS JOIN generate_series(1, $5) position_number`,
    [
      ACCOUNT,
      AS_OF,
      GENERATIONS_PER_DOCUMENT,
      DOCUMENT_COUNT,
      POSITION_COUNT,
    ],
  );
  await client.query(
    `INSERT INTO review_items
       (id, kind, account_id, source_document_id, raw_value, reason, status)
     SELECT 'review-performance-' || document_number, 'document_unparsed',
            $1, 'document-performance-' || document_number,
            'synthetic-parser-gap-' || document_number,
            'synthetic parser gap', 'open'
       FROM generate_series(1, 1) document_number`,
    [ACCOUNT],
  );
}

async function snapshot(client) {
  const request = parseFinanceReadRequest({
    contractVersion: 1,
    spaceId: SPACE,
    operation: "get_holdings_snapshot",
    accountId: ACCOUNT,
    snapshot: { mode: "exact", asOf: AS_OF },
    limit: 10,
  });
  return serveFinanceRead(client, request, SPACE, {
    principalId: "principal-snapshot-performance",
    cursorSigningSecret: "synthetic-snapshot-performance-secret-32-bytes",
    rawTreeRoot: null,
  });
}

test(
  "exact holdings snapshot evaluates historical scope proofs once within the production timeout",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedHistoricalScopes(client);

    const started = performance.now();
    const response = await snapshot(client);
    const elapsedMs = performance.now() - started;

    assert.ok(elapsedMs < 5_000, `snapshot took ${elapsedMs.toFixed(1)}ms`);
    assert.deepEqual(response.selectedSnapshot, {
      status: "found",
      asOf: AS_OF,
    });
    assert.equal(response.items.length, 10);
    assert.equal(response.summary.positionCount, POSITION_COUNT);
    assert.equal(response.coverage.reasons.includes("failed_import"), false);

    await client.query(
      `INSERT INTO review_items
         (id, kind, account_id, source_document_id, raw_value, reason, status,
          projection_scope_kind, projection_scope_as_of)
       VALUES ('review-performance-blocking', 'reparse_projection_mismatch', $1,
               'document-performance-1', 'synthetic ambiguity',
               'synthetic blocking review', 'open', 'positions', $2::date)`,
      [ACCOUNT, AS_OF],
    );
    const blocked = await snapshot(client);
    assert.equal(blocked.summary.status, "unavailable");
    assert.equal(blocked.summary.reason, "incomplete_source");
    assert.ok(blocked.coverage.reasons.includes("failed_import"));
  },
);
