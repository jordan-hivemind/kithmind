// F1-71. scripts/collapseDuplicateDocuments.mjs against a real, throwaway
// archive holding what the defect actually produced: several `documents`
// rows, each a separate capture of one provider document, because the
// provider re-rendered the file on every download and the importer's dedupe
// key was the content hash.
//
// Synthetic throughout: an invented institution, an invented account, three
// statements of made-up text. No real document, balance or account number
// appears here or in the raw trees these tests build.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  positionHash,
  retainPayload,
  runPositionReconciliationGate,
  runReconciliationGate,
  writeCaptureManifest,
  writeRawDocument,
} from "../dist/index.js";

import { collapseDuplicateDocuments } from "../scripts/collapseDuplicateDocuments.mjs";

import { all, archive, count, skip } from "./helpers/pgArchive.mjs";

const INSTITUTION_ID = "inst_collapse";
const ACCOUNT_ID = "acct_collapse";
const SPACE_ID = "space_collapse_test";

const RETENTION = {
  kind: "opaque",
  version: "collapse-test-1",
  note: "a rendered statement has no addressable fields; it is retained whole",
};

/** A raw tree rooted in a temp directory, dropped when the test ends. The
 * layout `resolveRawTreeRoot` produces, spelled out here because these tests
 * never set the environment variables it reads. */
function rawTree(t) {
  const dir = mkdtempSync(join(tmpdir(), "kith-finance-collapse-raw-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "archive", "v1", SPACE_ID);
}

async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, 'Collapse Trust', 'collapse-trust')",
    [INSTITUTION_ID],
  );
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, base_currency)
     VALUES ($1, $2, '0176', 'USD')`,
    [ACCOUNT_ID, INSTITUTION_ID],
  );
}

/**
 * One capture of one document: distinct bytes written to the raw tree, a
 * capture manifest recording when it was acquired, and the `documents` row
 * the importer would have written for it before F1-71 (no
 * `provider_document_id` unless the caller asks for one).
 */
function writeCapture(
  client,
  root,
  { id, rendering, capturedAt, providerDocumentId = null, columnProviderId = null },
) {
  const retained = retainPayload(
    RETENTION,
    new TextEncoder().encode(
      `# Collapse Trust statement (synthetic) 2026-03-31\n# rendering ${rendering}\n`,
    ),
    "pdf_statement",
  );
  const written = writeRawDocument(root, retained);
  writeCaptureManifest(root, {
    version: 1,
    captureId: id,
    sourceId: INSTITUTION_ID,
    documentSha256: written.sha256,
    institutionSlug: "collapse-trust",
    acctLast4: "0176",
    docType: "statement",
    ...(providerDocumentId === null ? {} : { providerDocumentId }),
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    capturedAt,
    capabilityTier: "pdf_statement",
    gaps: [],
    originalExtension: ".pdf",
    retention: retained.record,
  });
  return client.query(
    `INSERT INTO documents
       (id, institution_id, account_id, doc_type, doc_date, file_path, sha256, parsed_ok,
        retained_sha256, retained_byte_length, media_type, capture_id, provider_document_id)
     VALUES ($1, $2, $3, 'statement', DATE '2026-03-31', $4, $5, TRUE, $5, $6,
             'text/plain; charset=utf-8', $1, $7)`,
    [
      id,
      INSTITUTION_ID,
      ACCOUNT_ID,
      written.path,
      written.sha256,
      retained.bytes.byteLength,
      // Every row this defect produced has a NULL column: nothing recorded a
      // provider id before F1-71 existed. The manifest may still know one.
      columnProviderId,
    ],
  );
}

/** A position with the real row hash the importer would have computed, filed
 * under one of the duplicate documents. */
async function seedPosition(client, { id, documentId, quantity }) {
  const hash = positionHash({
    accountId: ACCOUNT_ID,
    instrumentId: null,
    asOf: "2026-03-31",
    quantity,
    marketValue: "1000",
    costBasis: "900",
    valuationBasis: "market_price",
    sourceLocator: `holdings:${id}`,
  });
  await client.query(
    `INSERT INTO positions
       (id, account_id, as_of, instrument_id, quantity, market_value, cost_basis,
        valuation_basis, currency, source_document_id, source_locator, row_hash)
     VALUES ($1, $2, DATE '2026-03-31', NULL, $3, '1000', '900', 'market_price', 'USD',
             $4, $5, $6)`,
    [id, ACCOUNT_ID, quantity, documentId, `holdings:${id}`, hash],
  );
}

async function gateVerdicts(client) {
  const cash = await runReconciliationGate(client);
  const positions = await runPositionReconciliationGate(client);
  return {
    cash: { passed: cash.passed, failed: cash.failed, unverified: cash.unverified },
    positions: {
      passed: positions.passed,
      failed: positions.failed,
      unverified: positions.unverified,
    },
    rows: await all(
      client,
      "SELECT account_id, period_start::text AS period_start, period_end::text AS period_end, status FROM reconciliations ORDER BY period_start",
    ),
  };
}

test(
  "collapses three captures of one document into one canonical row, repointing what cited the others",
  { skip },
  async (t) => {
    const client = await archive(t);
    const root = rawTree(t);
    await seed(client);

    // Three downloads of one statement, each producing different bytes --
    // the defect exactly. Written out of capture order, so "the earliest
    // capture survives" cannot pass by accident of insertion order.
    await writeCapture(client, root, {
      id: "doc-b",
      rendering: "second",
      capturedAt: "2026-04-02T10:00:00.000Z",
    });
    await writeCapture(client, root, {
      id: "doc-a",
      rendering: "first",
      capturedAt: "2026-04-01T10:00:00.000Z",
    });
    await writeCapture(client, root, {
      id: "doc-c",
      rendering: "third",
      capturedAt: "2026-04-03T10:00:00.000Z",
    });

    // What the archive derived from them. The holdings row hash does not
    // include the document, so in practice one copy holds the row and the
    // others hold whatever landed before the dedupe caught up -- both shapes
    // are here.
    await seedPosition(client, { id: "pos-1", documentId: "doc-a", quantity: "10" });
    await seedPosition(client, { id: "pos-2", documentId: "doc-c", quantity: "25" });
    // Two balances, so the cash gate has a real period to reach a verdict on
    // -- "the gates say the same thing afterwards" is only worth asserting if
    // they say something in the first place. The earlier one is cited by a
    // copy that is about to be superseded.
    await client.query(
      `INSERT INTO balances (id, account_id, as_of, total_value, cash, currency, source_document_id)
       VALUES ('bal-0', $1, DATE '2026-02-28', '9500', '400', 'USD', 'doc-c'),
              ('bal-1', $1, DATE '2026-03-31', '10000', '500', 'USD', 'doc-b')`,
      [ACCOUNT_ID],
    );
    // One review item per copy, identical on review_items_dedupe_key: three
    // rows that cannot all survive repointing onto one document.
    for (const [id, documentId] of [
      ["rev-a", "doc-a"],
      ["rev-b", "doc-b"],
      ["rev-c", "doc-c"],
    ]) {
      await client.query(
        `INSERT INTO review_items (id, kind, source_document_id, raw_value, reason)
         VALUES ($1, 'unknown_account_key', $2, 'ZZZ-1', 'account key did not resolve')`,
        [id, documentId],
      );
    }

    const before = await gateVerdicts(client);
    assert.equal(before.rows.length, 1, "the cash gate reached a verdict to compare against");

    // A dry run reports what a real run would do, and writes nothing.
    const dry = await collapseDuplicateDocuments(client, {
      dryRun: true,
      rawTreeRoot: root,
    });
    assert.equal(dry.groups, 1);
    assert.equal(dry.superseded, 2);
    assert.equal(dry.groupsBySource.metadata, 1, "no provider id anywhere: grouped on metadata");
    assert.equal(dry.capturesRead, 3);
    assert.equal(
      await count(client, "documents", "WHERE superseded_by IS NOT NULL"),
      0,
      "a dry run writes nothing",
    );

    const report = await collapseDuplicateDocuments(client, { rawTreeRoot: root });
    assert.equal(report.groups, 1);
    assert.equal(report.superseded, 2);
    assert.equal(report.repointed["positions.source_document_id"], 1, "pos-2 moves off doc-c");
    assert.equal(report.repointed["balances.source_document_id"], 2);
    assert.equal(
      report.deleted["review_items.source_document_id"],
      2,
      "two of the three identical review items would violate the dedupe key",
    );
    assert.equal(report.repointed["review_items.source_document_id"], 0);

    // doc-a is canonical: the earliest capture, which is the rendering the
    // already-imported rows were parsed from.
    const documents = await all(
      client,
      "SELECT id, superseded_by FROM documents ORDER BY id",
    );
    assert.deepEqual(documents, [
      { id: "doc-a", superseded_by: null },
      { id: "doc-b", superseded_by: "doc-a" },
      { id: "doc-c", superseded_by: "doc-a" },
    ]);

    // Nothing cites a superseded row any more, and nothing was deleted from
    // the raw tree or from `documents`.
    const positions = await all(
      client,
      "SELECT id, source_document_id FROM positions ORDER BY id",
    );
    assert.deepEqual(positions, [
      { id: "pos-1", source_document_id: "doc-a" },
      { id: "pos-2", source_document_id: "doc-a" },
    ]);
    assert.deepEqual(
      await all(client, "SELECT id, source_document_id FROM balances ORDER BY id"),
      [
        { id: "bal-0", source_document_id: "doc-a" },
        { id: "bal-1", source_document_id: "doc-a" },
      ],
    );
    const reviews = await all(client, "SELECT id, source_document_id FROM review_items");
    assert.deepEqual(reviews, [{ id: "rev-a", source_document_id: "doc-a" }]);

    // The gates say exactly what they said before: a collapse moves which
    // document a row cites, and no gate reads that.
    assert.deepEqual(await gateVerdicts(client), before);

    // Idempotent: the second run finds no group with more than one
    // non-superseded row.
    const again = await collapseDuplicateDocuments(client, { rawTreeRoot: root });
    assert.equal(again.groups, 0);
    assert.equal(again.superseded, 0);
    assert.deepEqual(
      await all(client, "SELECT id, superseded_by FROM documents ORDER BY id"),
      documents,
    );
    assert.equal(await count(client, "positions"), 2);
    assert.equal(await count(client, "review_items"), 1);
  },
);

test(
  "groups on the provider document id a capture manifest recorded, and recovers it onto the canonical row",
  { skip },
  async (t) => {
    const client = await archive(t);
    const root = rawTree(t);
    await seed(client);

    // Captured after F1-71, so the manifests know which document they are
    // of -- but the rows predate the column being populated (or were
    // written by an older build), so the database does not.
    await writeCapture(client, root, {
      id: "doc-x",
      rendering: "first",
      capturedAt: "2026-04-01T10:00:00.000Z",
      providerDocumentId: "MS-000123",
    });
    await writeCapture(client, root, {
      id: "doc-y",
      rendering: "second",
      capturedAt: "2026-04-05T10:00:00.000Z",
      providerDocumentId: "MS-000123",
    });
    // A different provider document that happens to share the same
    // (doc_type, account, doc_date) metadata: the case the metadata fallback
    // gets wrong and a recorded provider id gets right.
    await writeCapture(client, root, {
      id: "doc-z",
      rendering: "other document",
      capturedAt: "2026-04-06T10:00:00.000Z",
      providerDocumentId: "MS-000999",
    });
    const report = await collapseDuplicateDocuments(client, { rawTreeRoot: root });
    assert.equal(report.groups, 1);
    assert.equal(report.groupsBySource.capture_manifest, 1);
    assert.equal(report.groupsBySource.metadata, 0);
    assert.equal(report.superseded, 1);
    assert.equal(report.providerIdsRecovered, 1);

    assert.deepEqual(
      await all(
        client,
        "SELECT id, provider_document_id, superseded_by FROM documents ORDER BY id",
      ),
      [
        { id: "doc-x", provider_document_id: "MS-000123", superseded_by: null },
        { id: "doc-y", provider_document_id: null, superseded_by: "doc-x" },
        { id: "doc-z", provider_document_id: null, superseded_by: null },
      ],
      "the second capture of MS-000123 is superseded; a different document is left alone",
    );
  },
);

test(
  "refuses to run against a schema whose references to documents it does not know",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await client.query(
      `CREATE TABLE later_migration (
         id TEXT PRIMARY KEY,
         source_document_id TEXT REFERENCES documents(id))`,
    );

    await assert.rejects(
      collapseDuplicateDocuments(client, { dryRun: true }),
      /later_migration\.source_document_id/,
      "a reference this script cannot repoint is a refusal, not a silent orphan",
    );
  },
);
