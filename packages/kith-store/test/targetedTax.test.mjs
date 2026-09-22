import assert from "node:assert/strict";
import test from "node:test";

import {
  createKithPool,
  newKithId,
  sha256,
  withKithTransaction,
} from "../dist/index.js";
import { runTargetedTaxExtractionJob } from "../dist/extraction/index.js";
import { admitInlineWork, processInlineWork } from "../dist/ingestion/index.js";
import {
  appendTargetedTaxBatch,
  beginTargetedTaxExtraction,
  workerCtx,
} from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-21T12:00:00Z");

async function fixture(t, text, externalId) {
  const database = await identityDatabase(t);
  const identity = database.ctx(NOW);
  const userId = await makeUser(identity, { name: "Synthetic owner" });
  const spaceId = await makeSpace(identity, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const sourceAccountId = newKithId();
  await database.client.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, inventory_epoch, completed_inventory_epoch,
        manifest_version, created_by)
     VALUES ($1,$2,transaction_timestamp(),'mcp-client','targeted-tax-test',
             'Targeted tax test',true,0,60000,0,0,0,$3)`,
    [sourceAccountId, spaceId, userId],
  );
  const credential = await makeApiKey(identity, {
    userId,
    capabilities: ["read", "write", "ingest"],
    spaceIds: [spaceId],
    sourceAccountIds: [sourceAccountId],
  });
  const principal = { userId, credentialId: credential.id };
  const pool = createKithPool(database.databaseUrl, 5);
  pool.on("error", () => {});
  t.after(() => pool.end());
  const run = (work, at = NOW) =>
    withKithTransaction(pool, (client) => work(workerCtx(client, at)));
  const admitted = await run((ctx) =>
    admitInlineWork(ctx, {
      principal,
      input: {
        spaceId,
        requestId: `admit-${externalId}`,
        expectedDesiredProcessingEpoch: 0,
        source: {
          connector: "mcp-client",
          accountId: "targeted-tax-test",
          externalId,
          capturedAt: "2026-09-21T11:00:00Z",
        },
        title: "Synthetic tax form",
        text,
      },
    }),
  );
  await run((ctx) => processInlineWork(ctx, { workId: admitted.workId }), NOW + 1);
  const source = (
    await database.client.query(
      `SELECT i.id, i.desired_revision_id, r.content_hash
         FROM kith.source_items i
         JOIN kith.source_revisions r ON r.id=i.desired_revision_id
        WHERE i.space_id=$1 AND i.external_id=$2`,
      [spaceId, externalId],
    )
  ).rows[0];
  return {
    ...database,
    pool,
    run,
    principal,
    spaceId,
    sourceAccountId,
    sourceItemId: source.id,
    sourceRevisionId: source.desired_revision_id,
    contentHash: source.content_hash,
  };
}

function beginRequest(f, overrides = {}) {
  const request = {
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    requestId: "target-begin",
    sourceItemId: f.sourceItemId,
    sourceRevisionId: f.sourceRevisionId,
    observedContentHash: f.contentHash,
    goalKind: "form_1040_totals_v1",
    instanceKey: "1040:2025",
    requiredFields: ["tax_year", "return_version", "total_tax"],
    optionalFields: [],
    sourcePageCount: 2,
    ...overrides,
  };
  request.requestDigest = sha256(
    `kith-targeted-tax-goal:v1\0${JSON.stringify([
      request.sourceItemId,
      request.sourceRevisionId,
      request.observedContentHash,
      request.goalKind,
      request.instanceKey,
      request.requiredFields,
      request.optionalFields,
      request.sourcePageCount,
    ])}`,
  );
  return request;
}

function appendRequest(f, targetId, ordinal, originalPage, text, overrides = {}) {
  const textHash = sha256(text);
  const artifact = {
    artifactKind: "selective_pdf_pages_v1",
    sourceSha256: f.contentHash,
    selectedPdfSha256: sha256(`selected:${ordinal}`),
    sourcePageCount: 2,
    originalPages: [originalPage],
    coverageFingerprint: sha256(`coverage:${ordinal}`),
    artifactFingerprint: sha256(`artifact:${ordinal}`),
    parserFingerprint: "selective-pdf-test-v1",
    extractionFingerprint: "selective-text-test-v1",
  };
  return {
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    operation: "extraction.appendTargetedTaxBatch",
    requestId: `target-append-${ordinal}`,
    targetId,
    sourceRevisionId: f.sourceRevisionId,
    batchOrdinal: ordinal,
    artifact,
    pages: [{ originalPage, text, textHash }],
    coverage: {
      formFamily: "form_1040",
      requestedRegionsClosed: true,
      continuationsClosed: true,
    },
    ...overrides,
  };
}

function model(reading, before) {
  return {
    name: "synthetic-targeted-tax",
    async read() {
      if (before) await before();
      return { summary: "", unnamed: 0, ...reading };
    },
  };
}

async function runBatch(f, targetId, ordinal, reading, before) {
  await runTargetedTaxExtractionJob(
    f.pool,
    { spaceId: f.spaceId, targetId, batchOrdinal: ordinal },
    { spaceId: f.spaceId, payload: {} },
    model(reading, before),
  );
  return (
    await f.client.query(
      `SELECT * FROM kith.document_targeted_extractions WHERE id=$1`,
      [targetId],
    )
  ).rows[0];
}

test("targeted tax gates values against cited text and keeps competing readings", { skip }, async (t) => {
  const f = await fixture(t, "Synthetic retained original", "tax-conflict");
  const begun = await f.run((ctx) =>
    beginTargetedTaxExtraction(ctx, f.principal, beginRequest(f, {
      optionalFields: ["total_payments"],
    })),
  );
  const page1 = [
    "Form 1040 U.S. Individual Income Tax Return",
    "Tax year 2025",
    "Return version 2025",
    "Total tax $123.00",
  ].join("\r\n");
  await f.run((ctx) =>
    appendTargetedTaxBatch(ctx, f.principal, appendRequest(f, begun.targetId, 0, 1, page1)),
  );
  let row = await runBatch(f, begun.targetId, 0, {
    kind: "tax_return_1040",
    statements: [
      { field: "tax_year", value: "2025", page: 1, lines: [2], quote: "" },
      { field: "return_version", value: "2025", page: 1, lines: [3], quote: "" },
      { field: "total_tax", value: "$123.00", page: 1, lines: [4], quote: "" },
      // Adversarial: a different field may not borrow the line's amount.
      { field: "total_payments", value: "$999.00", page: 1, lines: [4], quote: "" },
    ],
  });
  assert.equal(row.status, "complete");
  assert.equal(row.outcomes.some((outcome) => outcome.field === "total_payments"), false);

  const page2 = "Total tax $124.00";
  await f.run((ctx) =>
    appendTargetedTaxBatch(ctx, f.principal, appendRequest(f, begun.targetId, 1, 2, page2)),
  );
  row = await runBatch(f, begun.targetId, 1, {
    kind: "tax_return_1040",
    statements: [
      { field: "total_tax", value: "$124.00", page: 2, lines: [1], quote: "" },
    ],
  });
  assert.equal(row.status, "conflict");
  const total = row.outcomes.find((outcome) => outcome.field === "total_tax");
  assert.equal(total.status, "conflict");
  assert.equal(total.readings.length, 2);
  assert.equal(total.readings.every((reading) => reading.citations.length === 1), true);
  assert.deepEqual(
    total.readings.map((reading) => reading.value.amount).sort(),
    ["123", "124"],
  );
});

test("targeted tax commit refuses a revision changed during the model call", { skip }, async (t) => {
  const f = await fixture(t, "Synthetic retained original", "tax-race");
  const begun = await f.run((ctx) =>
    beginTargetedTaxExtraction(ctx, f.principal, beginRequest(f)),
  );
  const page = "Form 1040 U.S. Individual Income Tax Return\nTax year 2025";
  await f.run((ctx) =>
    appendTargetedTaxBatch(ctx, f.principal, appendRequest(f, begun.targetId, 0, 1, page)),
  );
  const row = await runBatch(
    f,
    begun.targetId,
    0,
    {
      kind: "tax_return_1040",
      statements: [{ field: "tax_year", value: "2025", page: 1, lines: [2], quote: "" }],
    },
    () => f.client.query(`UPDATE kith.source_items SET desired_revision_id=NULL WHERE id=$1`, [f.sourceItemId]),
  );
  assert.equal(row.status, "running");
  assert.equal(row.batches[0].state, "pending");
  assert.deepEqual(row.outcomes, []);
});

test("a first-page-only K-1 cannot complete without key-region and continuation closure", { skip }, async (t) => {
  const text = "Schedule K-1 (Form 1065)\nTax year 2025\nPartnership Synthetic LP";
  const f = await fixture(t, "Synthetic retained original", "k1-open");
  const begun = await f.run((ctx) =>
    beginTargetedTaxExtraction(ctx, f.principal, beginRequest(f, {
      goalKind: "schedule_k1_key_fields_v1",
      instanceKey: "k1:2025:synthetic",
      requiredFields: ["tax_year", "form_family", "partnership_name"],
      optionalFields: ["box_1_ordinary_business_income"],
    })),
  );
  await f.run((ctx) =>
    appendTargetedTaxBatch(ctx, f.principal, appendRequest(f, begun.targetId, 0, 1, text, {
      coverage: {
        formFamily: "schedule_k1_1065",
        requestedRegionsClosed: false,
        continuationsClosed: false,
      },
    })),
  );
  const row = await runBatch(f, begun.targetId, 0, {
    kind: "schedule_k1_1065",
    statements: [
      { field: "form_family", value: "1065", page: 1, lines: [1], quote: "" },
      { field: "tax_year", value: "2025", page: 1, lines: [2], quote: "" },
      { field: "partnership_name", value: "Synthetic LP", page: 1, lines: [3], quote: "" },
    ],
  });
  assert.equal(row.status, "incomplete_resumable");
  assert.ok(row.unresolved_codes.includes("requested_regions_open"));
  assert.ok(row.unresolved_codes.includes("continuations_open"));
});
