// What the job does with the shapes a model actually replies in (ADM-5c).
//
// A live trial of the merged backend extracted five real documents with
// gpt-4o-mini. The three `letter_or_notice` documents worked. The one
// `invoice` and the one `receipt` stored zero statements and each opened one
// `unknown_field` correction reading `{"fields":["(unnamed)"]}` -- which says
// that every entry in those replies arrived with no usable `field`, and says
// nothing at all about how many entries that was. Both failing kinds have a
// `line_item_list` field; the kind that worked has none.
//
// So this suite pins the contract from both ends. The documents are synthetic
// (invented vendor, invented amounts), the model is a fake that returns one
// shape per case, and the cases are the good shape plus every bad shape the
// parser can be handed.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createKithPool,
  newKithId,
  withKithTransaction,
} from "../dist/index.js";
import {
  EXTRACTION_REPLY_UNREADABLE,
  buildRequest,
  extractionSchema,
  parseModelReading,
  runDocumentExtractionJob,
  seedDocumentTypes,
} from "../dist/extraction/index.js";
import {
  admitInlineWork,
  processInlineWork,
} from "../dist/ingestion/index.js";
import { workerCtx } from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-20T12:00:00Z");

/** A synthetic receipt. Invented vendor, invented amounts. */
const RECEIPT = [
  "Bracken Tools",
  "Date: 2026-04-02",
  "Chisel",
  "  12.00",
  "Mallet",
  "  8.00",
  "Subtotal $20.00",
  "Total due $20.00",
].join("\n");

/** A synthetic invoice. The other kind that failed the live trial. */
const INVOICE = [
  "Halloway Joinery",
  "Invoice 88120",
  "Invoice date: 2026-04-09",
  "Dated 2026-04-09",
  "Planing",
  "  120.00",
  "Fitting",
  "  45.00",
  "Subtotal $165.00",
  "Amount due $165.00",
].join("\n");

/** The shape the prompt and the schema both ask for. */
function goodShape(kind) {
  const receipt = kind === "receipt";
  return {
    kind,
    summary: receipt
      ? "Hardware receipt from Bracken Tools for $20.00."
      : "Joinery invoice from Halloway Joinery for $165.00.",
    statements: [
      {
        field: receipt ? "vendor" : "vendor",
        value: receipt ? "Bracken Tools" : "Halloway Joinery",
        line_items: null,
        page: 1,
        quote: receipt ? "Bracken Tools" : "Halloway Joinery",
      },
      {
        field: receipt ? "purchase_date" : "invoice_date",
        value: receipt ? "2026-04-02" : "2026-04-09",
        line_items: null,
        page: 1,
        quote: receipt ? "Date: 2026-04-02" : "Invoice date: 2026-04-09",
      },
      {
        field: "line_items",
        value: null,
        line_items: receipt
          ? [
              { description: "Chisel", amount: "12.00" },
              { description: "Mallet", amount: "8.00" },
            ]
          : [
              { description: "Planing", amount: "120.00" },
              { description: "Fitting", amount: "45.00" },
            ],
        page: 1,
        quote: receipt
          ? "Chisel\n  12.00\nMallet\n  8.00"
          : "Planing\n  120.00\nFitting\n  45.00",
      },
      {
        field: "subtotal",
        value: receipt ? "$20.00" : "$165.00",
        line_items: null,
        page: 1,
        quote: receipt ? "Subtotal $20.00" : "Subtotal $165.00",
      },
      {
        field: "total",
        value: receipt ? "$20.00" : "$165.00",
        line_items: null,
        page: 1,
        quote: receipt ? "Total due $20.00" : "Amount due $165.00",
      },
    ],
  };
}

/**
 * Every shape that makes `field` unusable, as JSON text, so the parser is
 * exercised exactly as the provider exercises it.
 */
function badShapes(kind) {
  const good = goodShape(kind);
  return {
    /** The field name promoted to a key of its own. */
    field_as_key: {
      kind,
      summary: good.summary,
      statements: good.statements.map((statement) => ({
        [statement.field]: statement.value ?? statement.line_items,
        page: statement.page,
        quote: statement.quote,
      })),
    },
    /** Line items flattened into top-level statements. */
    items_as_statements: {
      kind,
      summary: good.summary,
      statements: [
        { description: "Chisel", amount: "12.00", page: 1, quote: "Chisel" },
        { description: "Mallet", amount: "8.00", page: 1, quote: "Mallet" },
      ],
    },
    /** A nested object where a name was asked for. */
    nested_field: {
      kind,
      summary: good.summary,
      statements: good.statements.map((statement) => ({
        ...statement,
        field: { name: statement.field },
      })),
    },
    /** Statements as plain strings. */
    strings: {
      kind,
      summary: good.summary,
      statements: ["vendor: Bracken Tools", "total: $20.00"],
    },
    /** Nulls in the array. */
    nulls: { kind, summary: good.summary, statements: [null, null] },
  };
}

function fakeModel(reading) {
  const requests = [];
  return {
    requests,
    name: "synthetic-shape-model",
    async read(request) {
      requests.push(request);
      const next =
        typeof reading === "function" ? reading(requests.length) : reading;
      // The fake stands where the provider stands, so it answers through the
      // provider's own parser rather than around it.
      return parseModelReading(JSON.stringify(next));
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
  const pool = createKithPool(database.databaseUrl, 4);
  pool.on("error", () => {});
  t.after(() => pool.end());
  const run = (now, work) =>
    withKithTransaction(pool, (client) => work(workerCtx(client, now)));
  await run(NOW, (ctx) => seedDocumentTypes(ctx, spaceId));
  return {
    ...database,
    pool,
    userId,
    spaceId,
    async ingest(text, externalId) {
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
              capturedAt: "2026-04-09T11:00:00Z",
            },
            title: "Synthetic document",
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
      return { sourceItemId: item.id, generationId: item.active_generation_id };
    },
    extract(model, ids, attempts = 1, now = NOW + 2_000) {
      return runDocumentExtractionJob(
        pool,
        {
          spaceId,
          sourceItemId: ids.sourceItemId,
          processingGenerationId: ids.generationId,
        },
        { spaceId, payload: {}, attempts },
        model,
        now,
      );
    },
    rows(sql, values = []) {
      return database.client.query(sql, values).then((r) => r.rows);
    },
  };
}

// ---------------------------------------------------------------------------
// The parser, on its own. No database: these are claims about one function.
// ---------------------------------------------------------------------------

test("only a named field survives the parser, and the rest are counted", () => {
  const good = parseModelReading(JSON.stringify(goodShape("receipt")));
  assert.equal(good.unnamed, 0);
  assert.equal(good.statements.length, 5);
  // A `line_item_list` field arrives in its own property and comes out as the
  // statement's value, which is what the gate reads.
  const items = good.statements.find(
    (statement) => statement.field === "line_items",
  );
  assert.deepEqual(items.value, [
    { description: "Chisel", amount: "12.00" },
    { description: "Mallet", amount: "8.00" },
  ]);

  for (const [name, shape] of Object.entries(badShapes("receipt"))) {
    const parsed = parseModelReading(JSON.stringify(shape));
    assert.equal(parsed.statements.length, 0, name);
    assert.ok(parsed.unnamed > 0, `${name} counts its entries`);
  }

  // A mechanical rename is recovered; it is not a guess about a value.
  for (const key of ["field_name", "name"]) {
    const renamed = parseModelReading(
      JSON.stringify({
        kind: "receipt",
        summary: "",
        statements: [
          { [key]: "vendor", value: "Bracken Tools", page: 1, quote: "Bracken Tools" },
        ],
      }),
    );
    assert.equal(renamed.statements.length, 1, key);
    assert.equal(renamed.statements[0].field, "vendor");
    assert.equal(renamed.unnamed, 0);
  }

  // An envelope that is not an array of entries is no entries, not a crash.
  const object = parseModelReading(
    JSON.stringify({ kind: "receipt", summary: "", statements: {} }),
  );
  assert.deepEqual(object.statements, []);
  assert.equal(object.unnamed, 0);
});

test("the schema makes the field name unrepresentable when absent", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(RECEIPT, "synthetic-schema-receipt");
  const model = fakeModel(goodShape("receipt"));
  await f.extract(model, ids);
  const request = model.requests[0];
  assert.ok(request.kinds.includes("receipt"));
  assert.ok(request.fields.includes("line_items"));
  const schema = extractionSchema(request);
  const statement = schema.properties.statements.items;
  // ADM-5d: the citation is line ids, not a quote. The server builds the
  // quote from them, so there is nothing left for the model to copy wrong.
  assert.deepEqual(statement.required, [
    "field",
    "page",
    "lines",
    "value",
    "line_items",
  ]);
  // ADM-5e: both count from 1, and the schema says so.
  assert.equal(statement.properties.lines.minItems, 1);
  assert.deepEqual(statement.properties.lines.items, {
    type: "integer",
    minimum: 1,
  });
  // ADM-5g: each list entry carries its own citation and states its amount
  // format, because entries sit on different lines and a model that drops the
  // decimal point loses every one of them.
  const item = statement.properties.line_items.items;
  assert.deepEqual(item.required, ["description", "amount", "lines"]);
  assert.equal(item.properties.lines.minItems, 1);
  assert.match(item.properties.amount.description, /12\.99.*1299/);
  assert.deepEqual(statement.properties.page, {
    type: "integer",
    minimum: 1,
  });
  assert.equal(statement.additionalProperties, false);
  assert.ok(statement.properties.field.enum.includes("vendor"));
  assert.deepEqual(statement.properties.line_items.type, ["array", "null"]);

  // And the prompt says the same thing in words, for an endpoint that honours
  // no schema.
  const built = buildRequest({
    ...request,
    pages: [],
    pagesTotal: 0,
    types: [],
  });
  assert.match(model.requests[0].prompt, /Every statement names a field/);
  assert.match(model.requests[0].prompt, /"line_items": \[\{"description"/);
  assert.equal(typeof built.prompt, "string");
});

// ---------------------------------------------------------------------------
// The job, against the real schema.
// ---------------------------------------------------------------------------

for (const [kind, text, external] of [
  ["receipt", RECEIPT, "synthetic-good-receipt"],
  ["invoice", INVOICE, "synthetic-good-invoice"],
]) {
  test(`the good shape stores a ${kind}'s fields and its line items`, { skip }, async (t) => {
    const f = await fixture(t);
    const ids = await f.ingest(text, external);
    const outcome = await f.extract(fakeModel(goodShape(kind)), ids);
    assert.equal(outcome.kind, kind);
    assert.equal(outcome.failed, 0);
    // vendor, the date, the two line items, subtotal and total.
    assert.equal(outcome.stored, 6);
    const stored = await f.rows(
      `SELECT observation_key, value FROM kith.observations
        WHERE space_id = $1 AND event_type = 'document_statement'
        ORDER BY observation_key`,
      [f.spaceId],
    );
    assert.deepEqual(
      stored.map((row) => row.observation_key).sort(),
      [
        "line_items:0",
        "line_items:1",
        kind === "receipt" ? "purchase_date" : "invoice_date",
        "subtotal",
        "total",
        "vendor",
      ].sort(),
    );
    assert.equal(
      stored.find((row) => row.observation_key === "vendor").value.value,
      kind === "receipt" ? "Bracken Tools" : "Halloway Joinery",
    );
    assert.equal(
      stored.find((row) => row.observation_key === "total").value.amount,
      kind === "receipt" ? "20" : "165",
    );
    // The items sum to the subtotal, so no mismatch is raised.
    assert.equal(
      (
        await f.rows(
          "SELECT id FROM kith.corrections WHERE space_id = $1",
          [f.spaceId],
        )
      ).length,
      0,
    );
  });
}

test("a reply that names nothing is retried once, then recorded with its count", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(RECEIPT, "synthetic-bad-receipt");
  const shape = badShapes("receipt").field_as_key;

  // First run: the reply had entries and named no field, so the job fails with
  // a named, retryable code rather than writing the document off.
  await assert.rejects(
    f.extract(fakeModel(shape), ids, 0),
    (error) => error.code === EXTRACTION_REPLY_UNREADABLE,
  );
  assert.equal(
    (await f.rows("SELECT id FROM kith.document_extractions WHERE space_id = $1", [f.spaceId]))
      .length,
    0,
    "the failed attempt wrote nothing",
  );

  // Second run: the model answers the same way, so it is recorded -- with the
  // count the live trial's correction could not show.
  const outcome = await f.extract(fakeModel(shape), ids, 1, NOW + 3_000);
  assert.equal(outcome.stored, 0);
  const corrections = await f.rows(
    "SELECT field_name, reason, original_value FROM kith.corrections WHERE space_id = $1",
    [f.spaceId],
  );
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].reason, "unknown_field");
  assert.equal(corrections[0].field_name, null);
  assert.deepEqual(corrections[0].original_value, {
    fields: [],
    unnamed: 5,
    unusable: 5,
  });
});

test("a document that genuinely states nothing is not a failure", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(RECEIPT, "synthetic-empty-receipt");
  // No entries at all is a quiet no-op: nothing to retry, nothing to correct.
  const outcome = await f.extract(
    fakeModel({ kind: "receipt", summary: "Nothing legible.", statements: [] }),
    ids,
    0,
  );
  assert.equal(outcome.stored, 0);
  assert.equal(outcome.failed, 0);
  assert.equal(
    (await f.rows("SELECT id FROM kith.corrections WHERE space_id = $1", [f.spaceId]))
      .length,
    0,
  );
});

test("one stray field among good ones is a correction, not a retry", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(RECEIPT, "synthetic-stray-receipt");
  const shape = goodShape("receipt");
  shape.statements.push({
    field: "warranty_months",
    value: "12",
    line_items: null,
    page: 1,
    quote: "Bracken Tools",
  });
  const outcome = await f.extract(fakeModel(shape), ids, 0);
  assert.equal(outcome.stored, 6);
  const corrections = await f.rows(
    "SELECT reason, original_value FROM kith.corrections WHERE space_id = $1",
    [f.spaceId],
  );
  assert.equal(corrections.length, 1);
  assert.deepEqual(corrections[0].original_value, {
    fields: ["warranty_months"],
    unnamed: 0,
    unusable: 1,
  });
});
