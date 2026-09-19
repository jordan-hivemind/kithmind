// Citing a page by line number, against pages shaped like real parser output
// (ADM-5d).
//
// The live trial that prompted this round: an invoice stored three fields and
// lost its total to `value_not_in_quote`; a receipt stored its vendor and
// three line items and lost subtotal, tax and total to `quote_not_found`, one
// line item to the same, and its date to `malformed_statement`. Precision was
// intact -- nothing wrong was stored -- and recall on money was close to zero.
//
// The fixtures below are shaped the way the parser actually emits a page, not
// the way a receipt looks:
//
//   * `evals/parser/src/parser_eval/convert_worker.py:266` renders a detected
//     table row as `" | ".join(values)`, one line per row. Not markdown, not
//     tabs, no padding.
//   * A table docling does *not* detect comes through as ordinary text
//     segments joined with "\n" (`convert_worker.py:86-105`), which is how a
//     till receipt ends up with its labels on one line and its amounts on the
//     next.
//   * A spreadsheet page is the sheet name on line 0 and tab-separated cells
//     after it (`packages/worker-protocol/src/index.ts:584-607`).
//
// Every one of those is lines, which is why the citation is a line id.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createKithPool,
  newKithId,
  withKithTransaction,
} from "../dist/index.js";
import {
  amountsInText,
  citationRange,
  numberedPage,
  pageLines,
  parseModelReading,
  printedDateToIso,
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

const NOW = Date.parse("2026-09-22T12:00:00Z");

/**
 * A till receipt whose amounts sit in a right-hand column that docling did
 * not read as a table: the labels come out on one line and the amounts on the
 * next. This is the shape that produced `quote_not_found` on every money
 * field, because "Subtotal 10.00" is not a substring of the page in any order.
 */
const COLUMN_RECEIPT = [
  "BRACKEN TOOLS",
  "12 Mill Lane",
  "09/18/26 14:32",
  "Chisel                    12.00",
  "Mallet                     8.00",
  "Subtotal   Tax    Total",
  "20.00      1.60   21.60",
  "VISA ************4417",
].join("\n");

/** The same receipt as docling emits it when tableStructure *does* fire:
 * one line per row, cells joined with " | ". */
const TABLE_RECEIPT = [
  "BRACKEN TOOLS",
  "09/18/26 14:32",
  "Item | Amount",
  "Chisel | 12.00",
  "Mallet | 8.00",
  "Subtotal | 20.00",
  "Tax | 1.60",
  "Total | 21.60",
].join("\n");

/** An invoice with OCR artifacts: a space inside a number, a currency code
 * against the digits, and a comma decimal. */
const OCR_INVOICE = [
  "HALLOWAY JOINERY",
  "Invoice 88120",
  "Invoice date: 9 Apr 2026",
  "Planing                  120.00",
  "Fitting                   45.00",
  "Subtotal $ 165 .00",
  "Tax USD13.20",
  "Amount due 178,20",
].join("\n");

function statement(field, value, lines, extra = {}) {
  return { field, value, line_items: null, page: 0, lines, ...extra };
}

function fakeModel(reading) {
  const requests = [];
  return {
    requests,
    name: "synthetic-line-model",
    async read(request) {
      requests.push(request);
      const next =
        typeof reading === "function" ? reading(requests.length) : reading;
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
              capturedAt: "2026-09-18T11:00:00Z",
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
    extract(model, ids, now = NOW + 2_000) {
      return runDocumentExtractionJob(
        pool,
        {
          spaceId,
          sourceItemId: ids.sourceItemId,
          processingGenerationId: ids.generationId,
        },
        { spaceId, payload: {}, attempts: 1 },
        model,
        now,
      );
    },
    rows(sql, values = []) {
      return database.client.query(sql, values).then((r) => r.rows);
    },
    async stored() {
      return (
        await database.client.query(
          `SELECT observation_key, value FROM kith.observations
            WHERE space_id = $1 AND event_type = 'document_statement'
            ORDER BY observation_key`,
          [spaceId],
        )
      ).rows;
    },
    async corrections() {
      return (
        await database.client.query(
          `SELECT field_name, reason FROM kith.corrections
            WHERE space_id = $1 AND state = 'open'
            ORDER BY reason, field_name`,
          [spaceId],
        )
      ).rows;
    },
  };
}

// ---------------------------------------------------------------------------
// The line machinery, on its own.
// ---------------------------------------------------------------------------

test("a page splits into addressable lines and numbers them from one", () => {
  const lines = pageLines(COLUMN_RECEIPT);
  assert.equal(lines.length, 8);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].text, "BRACKEN TOOLS");
  assert.equal(lines[5].text, "Subtotal   Tax    Total");
  // The offsets index the page itself, which is what an evidence span needs.
  for (const line of lines) {
    assert.equal(COLUMN_RECEIPT.slice(line.start, line.end), line.text);
  }
  assert.match(numberedPage(lines), /^1\| BRACKEN TOOLS\n2\| 12 Mill Lane/);

  // A citation is a covering range, so two ids take the line between them.
  assert.deepEqual(citationRange(lines, [6, 7]), {
    start: lines[5].start,
    end: lines[6].end,
  });
  assert.equal(
    COLUMN_RECEIPT.slice(
      citationRange(lines, [6, 7]).start,
      citationRange(lines, [6, 7]).end,
    ),
    "Subtotal   Tax    Total\n20.00      1.60   21.60",
  );
  // Out of range, too many, and too wide are all refused.
  assert.equal(citationRange(lines, [0]), null);
  assert.equal(citationRange(lines, [9]), null);
  assert.equal(citationRange(lines, [1, 2, 3, 4]), null);
  assert.equal(citationRange(lines, [1, 8]), null);
  assert.equal(citationRange(lines, []), null);
});

test("an amount split by a rendering space is still one amount", () => {
  // "$ 165 .00" is one number the column split, not 165 and 0.
  assert.deepEqual(amountsInText("Subtotal $ 165 .00"), ["165"]);
  assert.deepEqual(amountsInText("Total 10. 80"), ["10.8"]);
  // And a genuine pair of column amounts stays a pair.
  assert.deepEqual(amountsInText("20.00      1.60   21.60"), [
    "20",
    "1.6",
    "21.6",
  ]);
  // The four shapes a code or comma can take.
  assert.deepEqual(amountsInText("Tax USD13.20"), ["13.2"]);
  assert.deepEqual(amountsInText("Tax 13.20 USD"), ["13.2"]);
  assert.deepEqual(amountsInText("Amount due 178,20"), ["178.2"]);
  assert.deepEqual(amountsInText("$ 10 .80"), ["10.8"]);
});

test("a printed date normalizes to ISO, and nothing is invented", () => {
  assert.equal(printedDateToIso("09/18/26 14:32"), "2026-09-18");
  assert.equal(printedDateToIso("9 Apr 2026"), "2026-04-09");
  assert.equal(printedDateToIso("Apr 9, 2026"), "2026-04-09");
  assert.equal(printedDateToIso("2026-04-09"), "2026-04-09");
  assert.equal(printedDateToIso("2026/04/09"), "2026-04-09");
  // Month-first for a numeric form, with the ambiguous pair swapped only when
  // the first number cannot be a month.
  assert.equal(printedDateToIso("03/04/26"), "2026-03-04");
  assert.equal(printedDateToIso("18/09/2026"), "2026-09-18");
  // The two-digit year rule, stated: 00-69 is this century.
  assert.equal(printedDateToIso("01/02/69"), "2069-01-02");
  assert.equal(printedDateToIso("01/02/70"), "1970-01-02");
  // Not a date is not a date.
  assert.equal(printedDateToIso("sometime in April"), undefined);
  assert.equal(printedDateToIso("13/32/26"), undefined);
  assert.equal(printedDateToIso(""), undefined);
});

// ---------------------------------------------------------------------------
// The job, against pages shaped like the parser's own output.
// ---------------------------------------------------------------------------

test("a column receipt stores every money field it cites", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_RECEIPT, "synthetic-column-receipt");
  // The labels are on line 6 and the amounts on line 7. Under the old
  // contract the model had to type "Subtotal 20.00", which is on no line of
  // this page; under the new one it cites both lines and the server reads
  // them.
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt from Bracken Tools for 21.60.",
      statements: [
        statement("vendor", "BRACKEN TOOLS", [1]),
        statement("purchase_date", "09/18/26", [3]),
        statement("line_items", null, [4, 5], {
          line_items: [
            { description: "Chisel", amount: "12.00" },
            { description: "Mallet", amount: "8.00" },
          ],
        }),
        statement("subtotal", "20.00", [6, 7]),
        statement("tax", "1.60", [6, 7]),
        statement("total", "21.60", [6, 7]),
        statement("payment_last_four", "4417", [8]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.kind, "receipt");
  assert.equal(outcome.failed, 0, "no corrections at all");
  const stored = await f.stored();
  assert.deepEqual(
    stored.map((row) => row.observation_key).sort(),
    [
      "line_items:0",
      "line_items:1",
      "payment_last_four",
      "purchase_date",
      "subtotal",
      "tax",
      "total",
      "vendor",
    ],
  );
  assert.equal(
    stored.find((row) => row.observation_key === "total").value.amount,
    "21.6",
  );
  // The printed date normalized without the model converting it.
  assert.equal(
    stored.find((row) => row.observation_key === "purchase_date").value.value,
    "2026-09-18",
  );
  assert.deepEqual(await f.corrections(), []);
});

test("a pipe-rendered table receipt reads the same way", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-table-receipt");
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt from Bracken Tools for 21.60.",
      statements: [
        statement("vendor", "BRACKEN TOOLS", [1]),
        statement("purchase_date", "09/18/26", [2]),
        statement("line_items", null, [4, 5], {
          line_items: [
            { description: "Chisel", amount: "12.00" },
            { description: "Mallet", amount: "8.00" },
          ],
        }),
        statement("subtotal", "20.00", [6]),
        statement("tax", "1.60", [7]),
        statement("total", "21.60", [8]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.stored, 7);
  assert.deepEqual(await f.corrections(), []);
});

test("OCR artifacts and a foreign decimal still read", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(OCR_INVOICE, "synthetic-ocr-invoice");
  const outcome = await f.extract(
    fakeModel({
      kind: "invoice",
      summary: "Joinery invoice from Halloway Joinery.",
      statements: [
        statement("vendor", "HALLOWAY JOINERY", [1]),
        statement("invoice_number", "88120", [2]),
        statement("invoice_date", "9 Apr 2026", [3]),
        statement("line_items", null, [4, 5], {
          line_items: [
            { description: "Planing", amount: "120.00" },
            { description: "Fitting", amount: "45.00" },
          ],
        }),
        statement("subtotal", "$ 165 .00", [6]),
        statement("tax", "USD13.20", [7]),
        statement("total", "178,20", [8]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.failed, 0);
  const stored = await f.stored();
  assert.equal(
    stored.find((row) => row.observation_key === "subtotal").value.amount,
    "165",
  );
  assert.equal(
    stored.find((row) => row.observation_key === "total").value.amount,
    "178.2",
  );
  assert.deepEqual(await f.corrections(), []);
});

test("a citation outside the page is a named failure, not a wrong fact", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_RECEIPT, "synthetic-bad-citation");
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("vendor", "BRACKEN TOOLS", [1]),
        // Past the end of the page.
        statement("total", "21.60", [99]),
        // A range too wide to be a citation.
        statement("subtotal", "20.00", [1, 8]),
        // A page that does not exist.
        { ...statement("tax", "1.60", [1]), page: 4 },
      ],
    }),
    ids,
  );
  assert.equal(outcome.stored, 1);
  assert.deepEqual(await f.corrections(), [
    { field_name: "subtotal", reason: "citation_out_of_range" },
    { field_name: "tax", reason: "citation_out_of_range" },
    { field_name: "total", reason: "citation_out_of_range" },
  ]);
});

test("the old quote shape still reads, for an endpoint with no schema", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-quote-fallback");
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        { field: "vendor", value: "BRACKEN TOOLS", page: 0, quote: "BRACKEN TOOLS" },
        { field: "total", value: "21.60", page: 0, quote: "Total | 21.60" },
      ],
    }),
    ids,
  );
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.stored, 2);
});

test("a re-extraction's queue shows the current run, not every run", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_RECEIPT, "synthetic-requeue-receipt");
  // First run: the total's citation is wrong, so it opens an item.
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("vendor", "BRACKEN TOOLS", [1]),
        statement("total", "21.60", [99]),
      ],
    }),
    ids,
  );
  assert.deepEqual(await f.corrections(), [
    { field_name: "total", reason: "citation_out_of_range" },
  ]);

  // Second run reads the total correctly. The stale item goes rather than
  // sitting in the queue beside a field that is now stored.
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("vendor", "BRACKEN TOOLS", [1]),
        statement("total", "21.60", [6, 7]),
      ],
    }),
    ids,
    NOW + 3_000,
  );
  assert.deepEqual(await f.corrections(), []);
  assert.equal((await f.stored()).length, 2);

  // A failure that recurs is one row, not two.
  for (const now of [NOW + 4_000, NOW + 5_000]) {
    await f.extract(
      fakeModel({
        kind: "receipt",
        summary: "Hardware receipt.",
        statements: [
          statement("vendor", "BRACKEN TOOLS", [1]),
          statement("total", "21.60", [99]),
        ],
      }),
      ids,
      now,
    );
  }
  assert.deepEqual(await f.corrections(), [
    { field_name: "total", reason: "citation_out_of_range" },
  ]);
});

test("a kind can name its own model, and the default is unchanged", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_RECEIPT, "synthetic-model-override");
  // The override is data: one element of the type's `examples` array.
  await f.client.query(
    `UPDATE kith.document_types
        SET examples = '[{"setting":"extraction_model","value":"stronger-model"}]'::jsonb
      WHERE space_id = $1 AND kind = 'receipt'`,
    [f.spaceId],
  );
  const reading = {
    kind: "receipt",
    summary: "Hardware receipt.",
    statements: [statement("vendor", "BRACKEN TOOLS", [1])],
  };
  const model = fakeModel(reading);
  const outcome = await f.extract(model, ids);
  // First read with the default to learn the kind, then once more with the
  // model that kind asks for.
  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[0].model, undefined);
  assert.equal(model.requests[1].model, "stronger-model");
  assert.equal(outcome.stored, 1);
  assert.equal(
    (
      await f.rows(
        "SELECT model FROM kith.document_extractions WHERE space_id = $1",
        [f.spaceId],
      )
    )[0].model,
    "stronger-model",
  );

  // Re-extraction knows the kind already, so it costs one call.
  const again = fakeModel(reading);
  await f.extract(again, ids, NOW + 3_000);
  assert.equal(again.requests.length, 1);
  assert.equal(again.requests[0].model, "stronger-model");

  // A kind with no override is untouched.
  const letter = await f.ingest("A short note.\nSigned 9 Apr 2026.", "synthetic-letter");
  const plain = fakeModel({
    kind: "letter_or_notice",
    summary: "A note.",
    statements: [statement("letter_date", "9 Apr 2026", [2])],
  });
  await f.extract(plain, letter, NOW + 4_000);
  assert.equal(plain.requests.length, 1);
  assert.equal(plain.requests[0].model, undefined);
});

test("the shape the old contract produced, for the record", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_RECEIPT, "synthetic-old-contract");
  // What a model writes when it is asked to copy a quote off this page: the
  // label and the amount it reads on one visual line. None of these strings
  // is on the page in that order, which is the whole of the live trial's
  // failure reproduced here so it cannot come back unnoticed.
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        { field: "vendor", value: "BRACKEN TOOLS", page: 0, quote: "BRACKEN TOOLS" },
        { field: "subtotal", value: "20.00", page: 0, quote: "Subtotal 20.00" },
        { field: "tax", value: "1.60", page: 0, quote: "Tax 1.60" },
        { field: "total", value: "21.60", page: 0, quote: "Total 21.60" },
      ],
    }),
    ids,
  );
  // One field stored, three money fields lost on the citation. Exactly the
  // live trial's receipt.
  assert.equal(outcome.stored, 1);
  assert.deepEqual(await f.corrections(), [
    { field_name: "subtotal", reason: "quote_not_found" },
    { field_name: "tax", reason: "quote_not_found" },
    { field_name: "total", reason: "quote_not_found" },
  ]);
});
