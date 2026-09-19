// Typed extraction end to end (ADM-5a), against the real migrated schema.
//
// The document is a real one: admitted, processed and activated through the
// inline ingestion pipeline, so "extraction is scheduled when a generation
// activates" is proven by the activation itself rather than by calling the
// scheduler directly. The model is always a stub -- no test in this package
// makes a completion -- and one of the stubs asserts, from inside the call,
// that no database connection is checked out while it runs.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createKithPool,
  newKithId,
  withKithTransaction,
} from "../dist/index.js";
import { getDocument } from "../dist/documents/index.js";
import { defaultRegistry, drain } from "../dist/deferred/index.js";
import {
  admitInlineWork,
  processInlineWork,
} from "../dist/ingestion/index.js";
import {
  applyCorrection,
  runDocumentExtractionJob,
  scheduleDocumentExtraction,
  scheduleReextraction,
  seedDocumentTypes,
} from "../dist/extraction/index.js";
import { executeRecordQuery } from "../dist/records/index.js";
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

/** What a well-behaved model returns for {@link RECEIPT}. */
function goodReading(overrides = {}) {
  return {
    kind: "receipt",
    summary: "Hardware receipt from Acme Hardware for 15.50.",
    statements: [
      {
        field: "vendor",
        value: "Acme Hardware",
        page: 0,
        quote: "Acme Hardware",
      },
      {
        field: "purchase_date",
        value: "2026-09-01",
        page: 0,
        quote: "Date: 2026-09-01",
      },
      {
        field: "total",
        value: "$15.50",
        page: 0,
        quote: "Total due $15.50",
      },
      {
        field: "line_items",
        value: [
          { description: "Hammer", amount: "10.00" },
          { description: "Nails", amount: "5.50" },
        ],
        page: 0,
        // Spans four physical lines: the quote locator folds whitespace, so
        // this resolves to one span over the page's own text.
        quote: "Hammer\n  10.00\nNails\n  5.50",
      },
    ],
    ...overrides,
  };
}

function stubModel(reading, options = {}) {
  const calls = [];
  return {
    calls,
    name: options.name ?? "synthetic-model",
    async read(prompt) {
      calls.push(prompt);
      if (options.before) await options.before();
      return typeof reading === "function" ? reading(calls.length) : reading;
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
  const pool = createKithPool(database.databaseUrl, options(t).max);
  pool.on("error", () => {});
  t.after(() => pool.end());
  const run = (now, work) =>
    withKithTransaction(pool, (client) => work(workerCtx(client, now)));
  return {
    ...database,
    pool,
    userId,
    spaceId,
    sourceAccountId,
    principal: { userId, credentialId: credential.id },
    run,
    async seed() {
      return await run(NOW, (ctx) => seedDocumentTypes(ctx, spaceId));
    },
    /** Ingests one inline document and activates it, returning its ids. */
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
        await database.client.query(
          `SELECT id, active_generation_id FROM kith.source_items
            WHERE source_account_id = $1 AND external_id = $2 LIMIT 1`,
          [sourceAccountId, externalId],
        )
      ).rows[0];
      const document = (
        await database.client.query(
          `SELECT id FROM kith.documents WHERE source_item_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [item.id],
        )
      ).rows[0];
      const entity = (
        await database.client.query(
          `SELECT id FROM kith.entities WHERE space_id = $1 AND key = 'other:document' LIMIT 1`,
          [spaceId],
        )
      ).rows[0];
      return {
        workId: admitted.workId,
        sourceItemId: item.id,
        generationId: item.active_generation_id,
        documentId: document?.id,
        placeholderEntityId: entity?.id,
      };
    },
    /** Runs the job body directly with a stub model. */
    extract(model, sourceItemId, generationId, now = NOW + 2_000) {
      return runDocumentExtractionJob(
        pool,
        { spaceId, sourceItemId, processingGenerationId: generationId },
        { spaceId, payload: {} },
        model,
        now,
      );
    },
    rows(sql, values = []) {
      return database.client.query(sql, values).then((result) => result.rows);
    },
  };
}

/** Per-test pool size. One test needs `max: 1` to prove no connection is held
 * across the provider call; everything else wants room to breathe. */
const poolSizes = new Map();
function options(t) {
  return { max: poolSizes.get(t.name) ?? 5 };
}

test("the seed is idempotent and never walks back an edited kind", { skip }, async (t) => {
  const f = await fixture(t);
  const first = await f.seed();
  assert.ok(first.inserted.includes("receipt"));
  assert.equal(first.skipped.length, 0);

  // An owner edits a kind: a new version row, which the seed must not touch.
  await f.client.query(
    `INSERT INTO kith.document_types (id, space_id, kind, guidance, version, active)
     VALUES ($1,$2,'receipt','Edited guidance',2,true)`,
    [newKithId(), f.spaceId],
  );
  const second = await f.seed();
  assert.equal(second.inserted.length, 0);
  assert.equal(second.skipped.length, first.inserted.length);
  const versions = await f.rows(
    `SELECT version, guidance FROM kith.document_types
      WHERE space_id = $1 AND kind = 'receipt' ORDER BY version`,
    [f.spaceId],
  );
  assert.deepEqual(
    versions.map((row) => Number(row.version)),
    [1, 2],
  );
  assert.equal(versions[1].guidance, "Edited guidance");
});

test("activation schedules extraction in the publication's own transaction", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  const queued = await f.rows(
    "SELECT kind, payload, dedupe_key, state FROM kith.deferred_work WHERE kind = 'document_extraction'",
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.sourceItemId, ingested.sourceItemId);
  assert.equal(
    queued[0].payload.processingGenerationId,
    ingested.generationId,
  );
  assert.equal(queued[0].dedupe_key, `document_extraction:${ingested.sourceItemId}`);

  // A second activation of the same item collapses onto the queued job.
  await f.run(NOW + 5, (ctx) =>
    scheduleDocumentExtraction(ctx, {
      spaceId: f.spaceId,
      sourceItemId: ingested.sourceItemId,
      processingGenerationId: ingested.generationId,
    }),
  );
  assert.equal(
    (await f.rows("SELECT id FROM kith.deferred_work WHERE kind = 'document_extraction'")).length,
    1,
  );
});

test("a clean reading becomes cited observations that query_records can read", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  const model = stubModel(goodReading());
  const outcome = await f.extract(model, ingested.sourceItemId, ingested.generationId);

  assert.equal(outcome.kind, "receipt");
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.truncated, false);
  // vendor, purchase_date, total, and two line items.
  assert.equal(outcome.stored, 5);
  assert.match(model.calls[0], /Read this document/);
  assert.match(model.calls[0], /receipt:/);

  const observations = await f.rows(
    `SELECT observation_key, observation_type, value, value_evidence
       FROM kith.observations WHERE space_id = $1
        AND event_type = 'document_statement'
      ORDER BY observation_key`,
    [f.spaceId],
  );
  assert.deepEqual(
    observations.map((row) => row.observation_key),
    ["line_items:0", "line_items:1", "purchase_date", "total", "vendor"],
  );
  const total = observations.find((row) => row.observation_key === "total");
  assert.deepEqual(total.value, {
    type: "money",
    amount: "15.5",
    currency: "USD",
  });
  // Every statement resolved to a real span over the sealed page.
  for (const row of observations) {
    assert.equal(row.value_evidence.length, 1);
  }

  // The read side hydrates them: the same validation `query_records` runs.
  const placeholderEntityId = (
    await f.rows(
      "SELECT id FROM kith.entities WHERE space_id = $1 AND key = 'other:document'",
      [f.spaceId],
    )
  )[0].id;
  const latest = await withKithTransaction(f.pool, (client) =>
    executeRecordQuery(
      { client, now: NOW + 3_000 },
      {
        principal: {
          userId: f.userId,
          credentialId: f.principal.credentialId,
        },
        query: {
          operation: "latest_observation",
          spaceId: f.spaceId,
          entityId: placeholderEntityId,
          observationType: "total",
        },
      },
    ),
  );
  assert.equal(latest.operation, "latest_observation");
  assert.equal(latest.status, "match");
  assert.equal(latest.candidates.length, 1);
  assert.deepEqual(latest.candidates[0].value, {
    type: "money",
    amount: "15.5",
    currency: "USD",
  });
  // Two citations: the value's own span, and the anchor span the generic
  // event type cites for its occurrence, subject and type.
  const quotes = latest.candidates[0].citations.map((c) => c.quote);
  assert.ok(quotes.includes("Total due $15.50"), quotes.join(" | "));

  // And `get_document` carries the whole reading with its citations.
  const document = await getDocument(
    f.client,
    [f.spaceId],
    ingested.documentId,
  );
  assert.equal(document.extraction.kind, "receipt");
  assert.equal(document.extraction.model, "synthetic-model");
  assert.equal(document.extraction.documentTypeVersion, 1);
  assert.equal(document.extraction.partial, false);
  const vendor = document.extraction.statements.find(
    (statement) => statement.field === "vendor",
  );
  assert.deepEqual(vendor.value, { type: "text", value: "Acme Hardware" });
  assert.equal(vendor.quote, "Acme Hardware");
  assert.equal(vendor.currencyAssumed, undefined);

  // Another space sees none of it.
  const otherSpace = await makeSpace(f.ctx(NOW), {
    createdBy: f.userId,
    memberId: f.userId,
    role: "owner",
  });
  assert.equal(await getDocument(f.client, [otherSpace], ingested.documentId), null);
});

test("a failed gate opens a correction instead of storing a guess", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  const reading = goodReading();
  reading.statements = [
    // A quote that is not on the page at all.
    { field: "vendor", value: "Fictional Co", page: 0, quote: "Fictional Co" },
    // A quote that is, with a value that does not parse.
    { field: "total", value: "about fifteen", page: 0, quote: "Total due $15.50" },
    // A field the type does not have.
    { field: "warranty", value: "1 year", page: 0, quote: "Acme Hardware" },
    // Line items that do not sum to the stated total.
    {
      field: "line_items",
      value: [{ description: "Hammer", amount: "10.00" }],
      page: 0,
      quote: "Hammer\n  10.00",
    },
    { field: "subtotal", value: "$15.50", page: 0, quote: "Subtotal $15.50" },
  ];
  const outcome = await f.extract(
    stubModel(reading),
    ingested.sourceItemId,
    ingested.generationId,
  );
  // The line items are kept; everything else that failed is not stored.
  assert.equal(outcome.stored, 2);
  const corrections = await f.rows(
    `SELECT field_name, reason, state, original_value FROM kith.corrections
      WHERE space_id = $1 ORDER BY reason`,
    [f.spaceId],
  );
  assert.deepEqual(
    corrections.map((row) => [row.field_name, row.reason]),
    [
      // The subtotal is stated, so that is what the items are compared to.
      ["subtotal", "line_items_mismatch"],
      ["total", "money_unparsable"],
      // One row for every field the kind does not have, not one per name.
      [null, "unknown_field"],
      ["vendor", "quote_not_found"],
    ].sort((left, right) => (left[1] < right[1] ? -1 : 1)),
  );
  assert.ok(corrections.every((row) => row.state === "open"));
  // The model's reading is on the row, so the screen can show what it read.
  const mismatch = corrections.find(
    (row) => row.reason === "line_items_mismatch",
  );
  assert.deepEqual(mismatch.original_value, {
    statedTotal: "15.5",
    itemsTotal: "10",
    against: "subtotal",
  });
  assert.deepEqual(
    corrections.find((row) => row.reason === "unknown_field").original_value,
    { fields: ["warranty"] },
  );

  // Re-running on an unchanged document does not grow the queue.
  await f.extract(stubModel(reading), ingested.sourceItemId, ingested.generationId);
  assert.equal(
    (await f.rows("SELECT id FROM kith.corrections WHERE space_id = $1", [f.spaceId]))
      .length,
    corrections.length,
  );
});

test("a human correction outlives re-extraction and wins the read", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  await f.extract(
    stubModel(goodReading()),
    ingested.sourceItemId,
    ingested.generationId,
  );
  await withKithTransaction(f.pool, (client) =>
    applyCorrection(client, {
      spaceId: f.spaceId,
      sourceItemId: ingested.sourceItemId,
      fieldName: "vendor",
      correctedValue: { type: "text", value: "Acme Hardware LLC" },
      actorUserId: f.userId,
      reason: "legal name",
      now: NOW + 4_000,
    }),
  );

  // Re-extract. The model reads the same thing it read before.
  const again = await f.extract(
    stubModel(goodReading()),
    ingested.sourceItemId,
    ingested.generationId,
    NOW + 5_000,
  );
  assert.equal(again.stored, 5);
  // One extraction row, not two: the replace is in place.
  assert.equal(
    (await f.rows("SELECT id FROM kith.document_extractions WHERE space_id = $1", [f.spaceId]))
      .length,
    1,
  );
  // And one event, whose observations were replaced rather than duplicated.
  assert.equal(
    (await f.rows(
      "SELECT id FROM kith.observations WHERE space_id = $1 AND event_type = 'document_statement'",
      [f.spaceId],
    )).length,
    5,
  );

  const document = await getDocument(f.client, [f.spaceId], ingested.documentId);
  const vendor = document.extraction.statements.find(
    (statement) => statement.field === "vendor",
  );
  assert.equal(vendor.corrected, true);
  assert.deepEqual(vendor.value, { type: "text", value: "Acme Hardware LLC" });
  // The model's newer reading is kept beside the fix, not instead of it.
  assert.deepEqual(vendor.originalValue, { type: "text", value: "Acme Hardware" });
});

test("a kind added as a row is used with no code change", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const typeId = newKithId();
  await f.client.query(
    `INSERT INTO kith.document_types (id, space_id, kind, description, guidance, version, active)
     VALUES ($1,$2,'hardware_warranty','A warranty card.','Read the issuer and the term.',1,true)`,
    [typeId, f.spaceId],
  );
  await f.client.query(
    `INSERT INTO kith.document_type_fields
       (id, space_id, document_type_id, name, value_type, required, check_kind)
     VALUES ($1,$2,$3,'issuer','organization',true,'on_page'),
            ($4,$2,$3,'term_months','number',false,'exact')`,
    [newKithId(), f.spaceId, typeId, newKithId()],
  );
  const ingested = await f.ingest();
  const model = stubModel({
    kind: "hardware_warranty",
    summary: "A warranty from Acme Hardware.",
    statements: [
      { field: "issuer", value: "Acme Hardware", page: 0, quote: "Acme Hardware" },
      { field: "term_months", value: "4471", page: 0, quote: "Invoice 4471" },
    ],
  });
  const outcome = await f.extract(
    model,
    ingested.sourceItemId,
    ingested.generationId,
  );
  assert.equal(outcome.kind, "hardware_warranty");
  assert.equal(outcome.stored, 2);
  assert.match(model.calls[0], /hardware_warranty: A warranty card\./);
  const row = (
    await f.rows(
      "SELECT kind, document_type_id FROM kith.document_extractions WHERE space_id = $1",
      [f.spaceId],
    )
  )[0];
  assert.equal(row.kind, "hardware_warranty");
  assert.equal(row.document_type_id, typeId);
});

test("a document past the page bound is read partially and says so", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  // Widen the sealed text version to more pages than the bound allows.
  const textVersionId = (
    await f.rows(
      `SELECT source_text_version_id FROM kith.processing_generations WHERE id = $1`,
      [ingested.generationId],
    )
  )[0].source_text_version_id;
  for (let page = 1; page <= 20; page += 1) {
    await f.client.query(
      `INSERT INTO kith.source_pages
         (id,space_id,created_at,source_text_version_id,ordinal,start,"end",text,text_hash)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,0,10,$5,$6)`,
      [
        newKithId(),
        f.spaceId,
        textVersionId,
        page,
        `Continued page ${page}`,
        "c".repeat(64),
      ],
    );
  }
  const model = stubModel(goodReading());
  const outcome = await f.extract(
    model,
    ingested.sourceItemId,
    ingested.generationId,
  );
  assert.equal(outcome.truncated, true);
  const row = (
    await f.rows(
      "SELECT pages_read, pages_total FROM kith.document_extractions WHERE space_id = $1",
      [f.spaceId],
    )
  )[0];
  assert.equal(Number(row.pages_read), 12);
  assert.equal(Number(row.pages_total), 21);
  assert.match(model.calls[0], /Only the first 12 of 21 pages are shown\./);
  // Visible, not silent.
  const truncation = await f.rows(
    "SELECT field_name, state FROM kith.corrections WHERE space_id = $1 AND reason = 'input_truncated'",
    [f.spaceId],
  );
  assert.equal(truncation.length, 1);
  assert.equal(truncation[0].field_name, null);
  assert.equal(truncation[0].state, "open");

  const document = await getDocument(f.client, [f.spaceId], ingested.documentId);
  assert.equal(document.extraction.partial, true);
  assert.equal(document.extraction.openCorrections.length, 1);
});

poolSizes.set("no database connection is held across the model call", 1);
test("no database connection is held across the model call", { skip }, async (t) => {
  const f = await fixture(t);
  assert.equal(f.pool.options.max, 1);
  await f.seed();
  const ingested = await f.ingest();
  let reached = false;
  const model = stubModel(goodReading(), {
    // The pool has exactly one connection. If the job held it across this
    // call, this query could never be served and the test would time out
    // rather than fail with a message -- which is itself the proof.
    async before() {
      const probe = await f.pool.query("SELECT 1 AS ok");
      assert.equal(probe.rows[0].ok, 1);
      reached = true;
    },
  });
  const outcome = await f.extract(
    model,
    ingested.sourceItemId,
    ingested.generationId,
  );
  assert.equal(reached, true);
  assert.equal(outcome.stored, 5);
});

test("the daemon drains the queued job through the registry", { skip }, async (t) => {
  const f = await fixture(t);
  // No explicit seed: the first extraction in a space seeds the starter set,
  // because nothing else would until the types screen exists.
  const ingested = await f.ingest();
  assert.equal(
    (await f.rows("SELECT id FROM kith.document_types WHERE space_id = $1", [f.spaceId]))
      .length,
    0,
  );
  const model = stubModel(goodReading());
  const drained = await drain(
    f.pool,
    defaultRegistry({ extractionModel: model }),
    { now: NOW + 10_000 },
  );
  const extraction = drained.outcomes.find(
    (outcome) => outcome.kind === "document_extraction",
  );
  assert.ok(extraction, "the extraction job was claimed");
  assert.equal(extraction.status, "completed");
  assert.equal(model.calls.length, 1);
  assert.ok(
    (await f.rows("SELECT id FROM kith.document_types WHERE space_id = $1", [f.spaceId]))
      .length >= 12,
    "the starter kinds were seeded on the first extraction",
  );
  assert.equal(
    (await f.rows(
      "SELECT id FROM kith.document_extractions WHERE source_item_id = $1",
      [ingested.sourceItemId],
    )).length,
    1,
  );

  // Re-extraction on demand finds it by kind and queues it again.
  const requeued = await f.run(NOW + 11_000, (ctx) =>
    scheduleReextraction(ctx, { spaceId: f.spaceId, kind: "receipt" }),
  );
  assert.deepEqual(requeued, [ingested.sourceItemId]);
  assert.deepEqual(
    await f.run(NOW + 11_001, (ctx) =>
      scheduleReextraction(ctx, { spaceId: f.spaceId, kind: "invoice" }),
    ),
    [],
  );
});

const TAXED = [
  "Acme Hardware",
  "Widget",
  "  10.00",
  "Gadget",
  "  20.00",
  "Subtotal $30.00",
  "Sales tax $2.40",
  "Total due $32.40",
].join("\n");

test("taxed line items are compared to the subtotal, not the total", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest(TAXED, "synthetic-taxed-1");
  const outcome = await f.extract(
    stubModel({
      kind: "receipt",
      summary: "A taxed receipt.",
      statements: [
        {
          field: "line_items",
          value: [
            { description: "Widget", amount: "10.00" },
            { description: "Gadget", amount: "20.00" },
          ],
          page: 0,
          quote: "Widget\n  10.00\nGadget\n  20.00",
        },
        { field: "subtotal", value: "$30.00", page: 0, quote: "Subtotal $30.00" },
        { field: "tax", value: "$2.40", page: 0, quote: "Sales tax $2.40" },
        { field: "total", value: "$32.40", page: 0, quote: "Total due $32.40" },
      ],
    }),
    ingested.sourceItemId,
    ingested.generationId,
  );
  // Items sum to the subtotal; the total carries the tax. Comparing the items
  // to the total was a false mismatch on every taxed receipt.
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.stored, 5);
  assert.equal(
    (
      await f.rows(
        "SELECT id FROM kith.corrections WHERE space_id = $1 AND reason = 'line_items_mismatch'",
        [f.spaceId],
      )
    ).length,
    0,
  );
});

test("two readings of one field store neither and open a correction", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  const outcome = await f.extract(
    stubModel({
      kind: "receipt",
      summary: "A receipt the model could not settle.",
      statements: [
        { field: "total", value: "$15.50", page: 0, quote: "Total due $15.50" },
        { field: "total", value: "$15.50", page: 0, quote: "Subtotal $15.50" },
        { field: "vendor", value: "Acme Hardware", page: 0, quote: "Acme Hardware" },
        { field: "vendor", value: "Acme", page: 0, quote: "Acme Hardware" },
      ],
    }),
    ingested.sourceItemId,
    ingested.generationId,
  );
  // `total` was read twice with the same value: one observation, no item.
  // `vendor` was read two different ways: neither is stored.
  assert.equal(outcome.stored, 1);
  const stored = await f.rows(
    `SELECT observation_type FROM kith.observations
      WHERE space_id = $1 AND event_type = 'document_statement'`,
    [f.spaceId],
  );
  assert.deepEqual(
    stored.map((row) => row.observation_type),
    ["total"],
  );
  const conflict = await f.rows(
    "SELECT field_name, original_value FROM kith.corrections WHERE space_id = $1 AND reason = 'conflicting_values'",
    [f.spaceId],
  );
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].field_name, "vendor");
  // Both readings are on the row, so the owner can pick one.
  assert.equal(conflict[0].original_value.length, 2);
});

test("a correction reaches query_records, not only get_document", { skip }, async (t) => {
  const f = await fixture(t);
  await f.seed();
  const ingested = await f.ingest();
  await f.extract(
    stubModel(goodReading()),
    ingested.sourceItemId,
    ingested.generationId,
  );
  await withKithTransaction(f.pool, (client) =>
    applyCorrection(client, {
      spaceId: f.spaceId,
      sourceItemId: ingested.sourceItemId,
      fieldName: "total",
      correctedValue: { type: "money", amount: "16.50", currency: "USD" },
      actorUserId: f.userId,
      reason: "the tax line was missed",
      now: NOW + 4_000,
    }),
  );
  // The observation carries the corrected value, so the exact-arithmetic side
  // of the store agrees with the document read instead of contradicting it.
  // The placeholder entity is minted by the extraction, so it is read now
  // rather than at ingest.
  const entityId = (
    await f.rows(
      "SELECT id FROM kith.entities WHERE space_id = $1 AND key = 'other:document'",
      [f.spaceId],
    )
  )[0].id;
  const latest = await withKithTransaction(f.pool, (client) =>
    executeRecordQuery(
      { client, now: NOW + 5_000 },
      {
        principal: {
          userId: f.userId,
          credentialId: f.principal.credentialId,
        },
        query: {
          operation: "latest_observation",
          spaceId: f.spaceId,
          entityId,
          observationType: "total",
        },
      },
    ),
  );
  assert.equal(latest.status, "match");
  assert.deepEqual(latest.candidates[0].value, {
    type: "money",
    amount: "16.5",
    currency: "USD",
  });
  const document = await getDocument(f.client, [f.spaceId], ingested.documentId);
  const total = document.extraction.statements.find(
    (statement) => statement.field === "total",
  );
  assert.deepEqual(total.value, {
    type: "money",
    amount: "16.50",
    currency: "USD",
  });
  // A corrected value that is not an observation value leaves the observation
  // alone rather than writing something the exact side cannot read.
  await withKithTransaction(f.pool, (client) =>
    applyCorrection(client, {
      spaceId: f.spaceId,
      sourceItemId: ingested.sourceItemId,
      fieldName: "total",
      correctedValue: "sixteen fifty",
      actorUserId: f.userId,
      now: NOW + 6_000,
    }),
  );
  const unchanged = await f.rows(
    `SELECT value FROM kith.observations
      WHERE space_id = $1 AND observation_type = 'total'`,
    [f.spaceId],
  );
  assert.deepEqual(unchanged[0].value, {
    type: "money",
    amount: "16.5",
    currency: "USD",
  });
});
