// Orphaned extraction spans (ADM-5j), against the real migrated schema.
//
// The write-path half of `src/extraction/spanSweep.ts`: an extraction must
// not leave behind a span nothing points at, whether the statement died at
// its gate, died in pass two, or belonged to a previous run.
//
// Why it matters beyond tidiness: a span outside the manifest that nothing
// adopts fails `verifySealedParsedPayload` with `id_sets`, the generation is
// never `ready`, and the owner's health screen stays red. The cleanup half,
// and that round trip, live in `parsedStagingAndDocuments.test.mjs` beside
// the seal they protect -- a sealed payload is what that file already builds.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createKithPool,
  newKithId,
  withKithTransaction,
} from "../dist/index.js";
import {
  admitInlineWork,
  processInlineWork,
} from "../dist/ingestion/index.js";
import {
  runDocumentExtractionJob,
  seedDocumentTypes,
} from "../dist/extraction/index.js";
import { workerCtx } from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-18T12:00:00Z");

const RECEIPT = [
  "Acme Hardware",
  "Invoice 4471",
  "Date: 2026-09-01",
  "Hammer",
  "  10.00",
  "Nails",
  "  5.50",
  "Subtotal $15.50",
  "Total due $15.50",
].join("\n");

function reading(statements, overrides = {}) {
  return {
    kind: "receipt",
    summary: "Hardware receipt from Acme Hardware.",
    statements,
    ...overrides,
  };
}

const VENDOR = {
  field: "vendor",
  value: "Acme Hardware",
  page: 1,
  quote: "Acme Hardware",
};
const TOTAL = {
  field: "total",
  value: "$15.50",
  page: 1,
  quote: "Total due $15.50",
};

function stubModel(next) {
  let call = 0;
  return {
    name: "synthetic-model",
    async read() {
      call += 1;
      return { unnamed: 0, ...(typeof next === "function" ? next(call) : next) };
    },
  };
}

async function fixture(t) {
  const database = await identityDatabase(t);
  const identity = database.ctx(NOW);
  const userId = await makeUser(identity, { name: "Owner" });
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
     VALUES ($1,$2,transaction_timestamp(),'mcp-client','desktop-capture',
             'Desktop capture',true,0,60000,0,0,0,$3)`,
    [sourceAccountId, spaceId, userId],
  );
  const credential = await makeApiKey(identity, {
    userId,
    capabilities: ["read", "write", "ingest"],
    spaceIds: [spaceId],
    sourceAccountIds: [sourceAccountId],
  });
  const pool = createKithPool(database.databaseUrl, 5);
  pool.on("error", () => {});
  t.after(() => pool.end());
  const run = (now, work) =>
    withKithTransaction(pool, (client) => work(workerCtx(client, now)));
  const rows = (sql, values = []) =>
    database.client.query(sql, values).then((result) => result.rows);
  return {
    ...database,
    pool,
    spaceId,
    rows,
    async seed() {
      return await run(NOW, (ctx) => seedDocumentTypes(ctx, spaceId));
    },
    async ingest(text = RECEIPT, externalId = "synthetic-receipt-1") {
      const admitted = await run(NOW, (ctx) =>
        admitInlineWork(ctx, {
          principal: { userId, credentialId: credential.id },
          input: {
            spaceId,
            requestId: `req-${externalId}`,
            expectedDesiredProcessingEpoch: 0,
            source: {
              connector: "mcp-client",
              accountId: "desktop-capture",
              externalId,
              capturedAt: "2026-09-18T11:00:00Z",
            },
            title: "Synthetic receipt",
            text,
          },
        }),
      );
      const processed = await run(NOW + 1_000, (ctx) =>
        processInlineWork(ctx, { workId: admitted.workId }),
      );
      assert.equal(processed.state, "ready");
      const item = (
        await rows(
          `SELECT id, active_generation_id FROM kith.source_items
            WHERE source_account_id = $1 AND external_id = $2 LIMIT 1`,
          [sourceAccountId, externalId],
        )
      )[0];
      const generation = (
        await rows(
          `SELECT id, source_revision_id, source_text_version_id
             FROM kith.processing_generations WHERE id = $1`,
          [item.active_generation_id],
        )
      )[0];
      const pageId = (
        await rows(
          `SELECT id FROM kith.source_pages WHERE source_text_version_id = $1
            ORDER BY ordinal LIMIT 1`,
          [generation.source_text_version_id],
        )
      )[0].id;
      return {
        sourceItemId: item.id,
        generationId: generation.id,
        sourceRevisionId: generation.source_revision_id,
        textVersionId: generation.source_text_version_id,
        pageId,
      };
    },
    extract(model, sourceItemId, generationId, now = NOW + 2_000) {
      return runDocumentExtractionJob(
        pool,
        { spaceId, sourceItemId, processingGenerationId: generationId },
        { spaceId, payload: {} },
        model,
        now,
      );
    },
  };
}

/** Every `extraction_v1` span on one text version. */
function extractionSpans(f, textVersionId) {
  return f.rows(
    `SELECT id FROM kith.evidence_spans
      WHERE source_text_version_id = $1 AND locator->>'kind' = 'extraction_v1'
      ORDER BY id`,
    [textVersionId],
  );
}

/**
 * Every span id the two record sites and the extraction row name, which is
 * what "referenced" means for a span this pipeline wrote. Deliberately a
 * second, independent implementation of the reference walk: asserting
 * against `unreferencedSpanIds` itself would prove only that it agrees with
 * itself.
 */
async function referencedSpanIds(f, textVersionId) {
  const rows = await f.rows(
    `SELECT jsonb_array_elements_text(value_evidence) AS id
       FROM kith.observations WHERE source_text_version_id = $1
     UNION
     SELECT jsonb_array_elements_text(field_evidence->'occurrence')
       FROM kith.event_versions WHERE source_text_version_id = $1
     UNION
     SELECT statement.value->>'evidenceSpanId'
       FROM kith.document_extractions x,
            jsonb_array_elements(x.statements) AS statement(value)
      WHERE x.space_id = $2`,
    [textVersionId, f.spaceId],
  );
  return new Set(rows.map((row) => row.id).filter((id) => id !== null));
}

async function assertNoOrphans(f, textVersionId) {
  const spans = await extractionSpans(f, textVersionId);
  const referenced = await referencedSpanIds(f, textVersionId);
  assert.deepEqual(
    spans.map((row) => row.id).filter((id) => !referenced.has(id)),
    [],
    "an extraction span survived that nothing points at",
  );
  return spans.length;
}

test("a statement that fails its gate leaves no span behind", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  // `$99.99` is nowhere on the page: `value_not_in_quote`, the reading is
  // dropped, and the span for the line it cited must not outlive it.
  const outcome = await f.extract(
    stubModel(reading([{ ...TOTAL, value: "$99.99" }])),
    ingested.sourceItemId,
    ingested.generationId,
  );
  assert.equal(outcome.stored, 0);
  assert.equal(outcome.failed, 1);
  assert.equal(await assertNoOrphans(f, ingested.textVersionId), 0);
});

test("two statements that disagree leave no span behind", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  // Both readings pass their own gate, so both mint a span; pass two of
  // `prepare` then drops the whole field as `conflicting_values`. This is the
  // case the gate ordering alone never covered -- the span is created before
  // anything knows the field will be dropped.
  const outcome = await f.extract(
    stubModel(
      reading([
        VENDOR,
        TOTAL,
        { field: "total", value: "$5.50", page: 1, quote: "  5.50" },
      ]),
    ),
    ingested.sourceItemId,
    ingested.generationId,
  );
  assert.equal(outcome.stored, 1);
  const failures = await f.rows(
    `SELECT reason FROM kith.corrections WHERE space_id = $1 AND state = 'open'`,
    [f.spaceId],
  );
  assert.ok(failures.some((row) => row.reason === "conflicting_values"));
  // One span, for the one stored statement.
  assert.equal(await assertNoOrphans(f, ingested.textVersionId), 1);
});

test("a re-extraction leaves no unreferenced extraction span", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  await f.extract(
    stubModel(reading([VENDOR, TOTAL])),
    ingested.sourceItemId,
    ingested.generationId,
  );
  const first = await assertNoOrphans(f, ingested.textVersionId);
  assert.equal(first, 2);
  const before = (await extractionSpans(f, ingested.textVersionId)).map(
    (row) => row.id,
  );

  // The second run reads the same document differently: the vendor now cites
  // a different line, and the total no longer survives its gate. Without the
  // sweep the first run's two spans stay behind for ever, and every further
  // re-extraction adds more.
  await f.extract(
    stubModel(
      reading([
        { ...VENDOR, value: "Invoice 4471", quote: "Invoice 4471" },
        { ...TOTAL, value: "$99.99" },
      ]),
    ),
    ingested.sourceItemId,
    ingested.generationId,
    NOW + 3_000,
  );
  assert.equal(await assertNoOrphans(f, ingested.textVersionId), 1);
  const after = (await extractionSpans(f, ingested.textVersionId)).map(
    (row) => row.id,
  );
  assert.ok(
    before.some((id) => !after.includes(id)),
    "the first run's abandoned span was not removed",
  );
});
