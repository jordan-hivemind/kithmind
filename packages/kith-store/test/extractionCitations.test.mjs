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
  applyCorrection,
  checkValue,
  diagnoseExtractions,
  valueSignature,
  citedLines,
  pageLines,
  readPrintedDate,
  numberedPage,
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

/** The gate takes cited lines now, not one quote. A test that names a quote
 * means one cited line, so this is the same claim said the new way. */
function asCandidates(quote) {
  return [{ text: quote, start: 0, end: quote.length }];
}

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
  return { field, value, line_items: null, page: 1, lines, ...extra };
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

  // A citation names lines, in id order, whether or not they are adjacent.
  assert.deepEqual(
    citedLines(lines, [6, 7]).map((line) => line.text),
    ["Subtotal   Tax    Total", "20.00      1.60   21.60"],
  );
  // ADM-5f: far-apart ids are legitimate. A column receipt prints labels in
  // one block and amounts in another, and the only honest citation of a total
  // is two lines that are not neighbours.
  assert.deepEqual(
    citedLines(lines, [1, 8]).map((line) => line.id),
    [1, 8],
  );
  assert.deepEqual(
    citedLines(lines, [5, 2]).map((line) => line.id),
    [2, 5],
  );
  // Out of range and too many are still refused.
  assert.equal(citedLines(lines, [0]), null);
  assert.equal(citedLines(lines, [9]), null);
  assert.equal(citedLines(lines, [1, 2, 3, 4]), null);
  assert.equal(citedLines(lines, []), null);
});

test("a rendering space closes only next to a currency mark", () => {
  // Must read: the gap is inside an amount the column split.
  assert.deepEqual(amountsInText("Subtotal $ 165 .00"), ["165"]);
  assert.deepEqual(amountsInText("$ 10 .80"), ["10.8"]);
  assert.deepEqual(amountsInText("Tax USD 13 .20"), ["13.2"]);

  // Must NOT read. Each of these was joined into one fabricated amount by the
  // first version of the repair, which is a value the page never stated under
  // a citation that looked right.
  // ADM-5g round five: the bare number beside the fragment is gone as well.
  // A separator with a digit reachable through it is settled by pasting the
  // two halves back together and asking `parseAmount`: "12    .99" reads as
  // 12.99, "1, 234" as 1,234 and "3. 12" as 3.12, so neither side of any of
  // them may be offered. The earlier round offered the left-hand number,
  // which is the right answer only if the column gap was not a separator --
  // and nothing on the line says which it was.
  assert.deepEqual(amountsInText("APPLES   12    .99"), []);
  assert.deepEqual(amountsInText("Invoice refs 1, 234, 567"), []);
  assert.deepEqual(amountsInText("3. 12 Pack Soda   5.99"), ["5.99"]);
  // ADM-5g: `5L` is digits with a letter glued to them that is neither a
  // currency, a magnitude nor a flag, so the token is not an amount at all --
  // and "2. 5L" does not read as 2.5 either, so the 2 stands on its own.
  assert.deepEqual(amountsInText("Milk 2. 5L"), ["2"]);
  // A bare column gap is two numbers or one, and the page does not say which.
  assert.deepEqual(amountsInText("Total 10. 80"), []);

  // A genuine pair of column amounts stays a pair.
  assert.deepEqual(amountsInText("20.00      1.60   21.60"), [
    "20",
    "1.6",
    "21.6",
  ]);
  // The shapes a code or comma can take, unchanged.
  assert.deepEqual(amountsInText("Tax USD13.20"), ["13.2"]);
  assert.deepEqual(amountsInText("Tax 13.20 USD"), ["13.2"]);
  assert.deepEqual(amountsInText("Amount due 178,20"), ["178.2"]);
});

test("the four fabrications cannot be stored", () => {
  const cases = [
    ["12.99", "APPLES   12    .99"],
    ["1,234,567", "Invoice refs 1, 234, 567"],
    ["3.12", "3. 12 Pack Soda   5.99"],
    ["2.5", "Milk 2. 5L"],
  ];
  for (const [value, quote] of cases) {
    assert.deepEqual(
      checkValue({
        valueType: "money",
        value,
        candidates: asCandidates(quote),
        pageText: quote,
        defaultCurrency: "USD",
      }),
      { ok: false, reason: "value_not_in_quote" },
      quote,
    );
  }
  // And the two that must still read.
  for (const [value, quote] of [
    ["165.00", "Subtotal $ 165 .00"],
    ["10.80", "$ 10 .80"],
  ]) {
    assert.equal(
      checkValue({
        valueType: "money",
        value,
        candidates: asCandidates(quote),
        pageText: quote,
        defaultCurrency: "USD",
      }).ok,
      true,
      quote,
    );
  }
});

test("a printed date normalizes to ISO, and nothing is invented", () => {
  assert.equal(printedDateToIso("09/18/26 14:32"), "2026-09-18");
  assert.equal(printedDateToIso("9 Apr 2026"), "2026-04-09");
  assert.equal(printedDateToIso("Apr 9, 2026"), "2026-04-09");
  assert.equal(printedDateToIso("2026-04-09"), "2026-04-09");
  assert.equal(printedDateToIso("2026/04/09"), "2026-04-09");
  // An all-numeric date that could be read two ways is neither, until the
  // kind says which. Guessing month-first stored a coin flip.
  assert.equal(printedDateToIso("03/04/26"), undefined);
  assert.deepEqual(readPrintedDate("03/04/26"), { kind: "ambiguous" });
  assert.equal(printedDateToIso("03/04/26", "MDY"), "2026-03-04");
  assert.equal(printedDateToIso("03/04/26", "DMY"), "2026-04-03");
  // One that settles itself needs no knob.
  assert.equal(printedDateToIso("18/09/2026"), "2026-09-18");
  assert.equal(printedDateToIso("13/02/2026"), "2026-02-13");
  assert.equal(printedDateToIso("02/13/2026"), "2026-02-13");
  assert.equal(printedDateToIso("03/03/26"), "2026-03-03");
  assert.equal(printedDateToIso("9 Apr 26"), "2026-04-09");
  // The two-digit year rule, stated: 00-69 is this century. Shown on a date
  // that is not also ambiguous, since an ambiguous one never gets this far.
  assert.equal(printedDateToIso("01/22/69"), "2069-01-22");
  assert.equal(printedDateToIso("01/22/70"), "1970-01-22");
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
            { description: "Chisel", amount: "12.00", lines: [4] },
            { description: "Mallet", amount: "8.00", lines: [5] },
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
  // ADM-5g: an item's key follows its evidence, so the list is counted.
  assert.deepEqual(
    stored
      .map((row) => row.observation_key)
      .filter((key) => !key.startsWith("line_items:"))
      .sort(),
    [
      "payment_last_four",
      "purchase_date",
      "subtotal",
      "tax",
      "total",
      "vendor",
    ],
  );
  assert.equal(
    stored.filter((row) => row.observation_key.startsWith("line_items:"))
      .length,
    2,
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
            { description: "Chisel", amount: "12.00", lines: [4] },
            { description: "Mallet", amount: "8.00", lines: [5] },
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
            { description: "Planing", amount: "120.00", lines: [4] },
            { description: "Fitting", amount: "45.00", lines: [5] },
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
        // Two real lines, far apart, neither of which prints the value.
        statement("subtotal", "20.00", [1, 8]),
        // A page that does not exist.
        { ...statement("tax", "1.60", [1]), page: 9 },
      ],
    }),
    ids,
  );
  assert.equal(outcome.stored, 1);
  // A page the document does not have is its own reason, so the counts can
  // tell "we number pages differently" from "that line id is off the end".
  // ADM-5f: a line id off the end of the page is still out of range; two
  // real-but-wrong lines are a value the citation does not support.
  assert.deepEqual(await f.corrections(), [
    { field_name: "total", reason: "citation_out_of_range" },
    { field_name: "tax", reason: "citation_page_unknown" },
    { field_name: "subtotal", reason: "value_not_in_quote" },
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
        { field: "vendor", value: "BRACKEN TOOLS", page: 1, quote: "BRACKEN TOOLS" },
        { field: "total", value: "21.60", page: 1, quote: "Total | 21.60" },
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
        { field: "vendor", value: "BRACKEN TOOLS", page: 1, quote: "BRACKEN TOOLS" },
        { field: "subtotal", value: "20.00", page: 1, quote: "Subtotal 20.00" },
        { field: "tax", value: "1.60", page: 1, quote: "Tax 1.60" },
        { field: "total", value: "21.60", page: 1, quote: "Total 21.60" },
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

const AMBIGUOUS_RECEIPT = [
  "BRACKEN TOOLS",
  "Date 01/02/26",
  "Chisel | 12.00",
  "Total | 12.00",
].join("\n");

test("an ambiguous printed date waits for the kind to say which order", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(AMBIGUOUS_RECEIPT, "synthetic-ambiguous-date");
  const reading = {
    kind: "receipt",
    summary: "Hardware receipt.",
    statements: [
      statement("vendor", "BRACKEN TOOLS", [1]),
      statement("purchase_date", "01/02/26", [2]),
      statement("total", "12.00", [4]),
    ],
  };
  // Unset: the date is one of two days and neither is stored.
  await f.extract(fakeModel(reading), ids);
  assert.deepEqual(await f.corrections(), [
    { field_name: "purchase_date", reason: "date_ambiguous" },
  ]);
  assert.deepEqual(
    (await f.stored())
      .map((row) => row.observation_key)
      .filter((key) => !key.startsWith("line_items:"))
      .sort(),
    ["total", "vendor"].sort(),
  );
  // ADM-5g: an item's key follows its evidence, so the list is counted.
  assert.equal(
    (await f.stored()).filter((row) =>
      row.observation_key.startsWith("line_items:"),
    ).length,
    0,
  );

  // The kind says month-first, so it reads. Same data home as the model knob.
  await f.client.query(
    `UPDATE kith.document_types
        SET examples = '[{"setting":"date_order","value":"MDY"}]'::jsonb
      WHERE space_id = $1 AND kind = 'receipt'`,
    [f.spaceId],
  );
  await f.extract(fakeModel(reading), ids, NOW + 3_000);
  assert.deepEqual(await f.corrections(), []);
  assert.equal(
    (await f.stored()).find((row) => row.observation_key === "purchase_date")
      .value.value,
    "2026-01-02",
  );

  // And day-first reads the other day, from the same page.
  await f.client.query(
    `UPDATE kith.document_types
        SET examples = '[{"setting":"date_order","value":"DMY"}]'::jsonb
      WHERE space_id = $1 AND kind = 'receipt'`,
    [f.spaceId],
  );
  await f.extract(fakeModel(reading), ids, NOW + 4_000);
  assert.equal(
    (await f.stored()).find((row) => row.observation_key === "purchase_date")
      .value.value,
    "2026-02-01",
  );
});

test("a line between two cited lines cannot support a value", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-noncontiguous");
  // Lines 4 and 6 are "Chisel | 12.00" and "Subtotal | 20.00"; line 5 in
  // between is "Mallet | 8.00". Citing 4 and 6 is allowed now -- a column
  // receipt needs exactly that -- and the 8.00 on line 5 must still not
  // support anything, because the value is checked against the cited lines
  // themselves and never against what lies between them.
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("vendor", "BRACKEN TOOLS", [1]),
        statement("total", "8.00", [4, 6]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.stored, 1);
  assert.deepEqual(await f.corrections(), [
    { field_name: "total", reason: "value_not_in_quote" },
  ]);
});

test("a model the provider refuses falls back once and says so", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-refused-model");
  await f.client.query(
    `UPDATE kith.document_types
        SET examples = '[{"setting":"extraction_model","value":"no-such-model"}]'::jsonb
      WHERE space_id = $1 AND kind = 'receipt'`,
    [f.spaceId],
  );
  const reading = {
    kind: "receipt",
    summary: "Hardware receipt.",
    statements: [statement("vendor", "BRACKEN TOOLS", [1])],
  };
  const refusing = {
    requests: [],
    name: "default-model",
    async read(request) {
      refusing.requests.push(request);
      if (request.model === "no-such-model") {
        throw new Error("Extraction provider request failed");
      }
      return parseModelReading(JSON.stringify(reading));
    },
  };
  // First run: the default reads, the kind asks for the bad model, that call
  // is refused, and the default's reading stands.
  const outcome = await f.extract(refusing, ids);
  assert.equal(outcome.stored, 1);
  assert.deepEqual(await f.corrections(), [
    { field_name: null, reason: "extraction_model_refused" },
  ]);
  assert.equal(
    (
      await f.rows(
        "SELECT model FROM kith.document_extractions WHERE space_id = $1",
        [f.spaceId],
      )
    )[0].model,
    "default-model",
  );

  // Second run knows the kind, tries the override once, and falls back. Two
  // calls, not a loop.
  refusing.requests.length = 0;
  const again = await f.extract(refusing, ids, NOW + 3_000);
  assert.equal(again.stored, 1);
  assert.deepEqual(
    refusing.requests.map((request) => request.model ?? null),
    ["no-such-model", null],
  );
  assert.deepEqual(await f.corrections(), [
    { field_name: null, reason: "extraction_model_refused" },
  ]);
});

test("a page longer than the line bound is marked partially read", { skip }, async (t) => {
  const f = await fixture(t);
  const long = [
    "BRACKEN TOOLS",
    ...Array.from({ length: 450 }, (_, index) => `Item ${index + 1} | 1.00`),
  ].join("\n");
  const ids = await f.ingest(long, "synthetic-long-page");
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "A very long receipt.",
      statements: [statement("vendor", "BRACKEN TOOLS", [1])],
    }),
    ids,
  );
  assert.equal(outcome.truncated, true, "the limitation is visible");
  const item = (await f.corrections()).find(
    (row) => row.reason === "input_truncated",
  );
  assert.ok(item, "a truncation item is open");
  const row = (
    await f.rows(
      "SELECT pages_read, pages_total FROM kith.document_extractions WHERE space_id = $1",
      [f.spaceId],
    )
  )[0];
  // Every page was shown; it is the lines that were cut.
  assert.equal(Number(row.pages_read), Number(row.pages_total));
});

// ---------------------------------------------------------------------------
// Page numbering. The regression that cost every document in the live trial.
// ---------------------------------------------------------------------------

/**
 * Inserts pages at the ordinals given, on the document's own sealed text
 * version, replacing whatever the inline lane wrote.
 *
 * Production ordinals are 0-based and need not be dense, and a blank page
 * comes through as empty text. A fixture that numbered from 1 agreed with the
 * broken code by accident, which is how the bug reached the owner's machine.
 */
async function repaginate(f, ids, pages) {
  const textVersionId = (
    await f.rows(
      "SELECT source_text_version_id FROM kith.processing_generations WHERE id = $1",
      [ids.generationId],
    )
  )[0].source_text_version_id;
  // The inline lane staged a page and its spans; both go before the fixture's
  // own pages arrive.
  await f.client.query(
    "DELETE FROM kith.evidence_spans WHERE source_text_version_id = $1",
    [textVersionId],
  );
  await f.client.query(
    "DELETE FROM kith.source_pages WHERE source_text_version_id = $1",
    [textVersionId],
  );
  for (const [ordinal, text] of pages) {
    await f.client.query(
      `INSERT INTO kith.source_pages
         (id,space_id,created_at,source_text_version_id,ordinal,start,"end",
          text,text_hash)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,0,$5,$6,$7)`,
      [
        newKithId(),
        f.spaceId,
        textVersionId,
        ordinal,
        text.length,
        text,
        "d".repeat(64),
      ],
    );
  }
}

test("a single-page document at ordinal 0 reads through line citations", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-ordinal-zero");
  // Exactly what the inline and parsed lanes both produce for a one-page
  // document: one row, ordinal 0. The model is shown "=== page 1 ===" and
  // answers page 1; before this fix the server looked the page up by its
  // ordinal, found nothing, and lost every field on the document.
  await repaginate(f, ids, [[0, TABLE_RECEIPT]]);
  assert.equal(
    Number(
      (
        await f.rows(
          `SELECT ordinal FROM kith.source_pages
            WHERE space_id = $1 ORDER BY ordinal LIMIT 1`,
          [f.spaceId],
        )
      )[0].ordinal,
    ),
    0,
    "the fixture is 0-based, like production",
  );
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt from Bracken Tools.",
      statements: [
        statement("vendor", "BRACKEN TOOLS", [1]),
        statement("purchase_date", "09/18/26", [2]),
        statement("total", "21.60", [8]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.failed, 0);
  assert.deepEqual(
    (await f.stored())
      .map((row) => row.observation_key)
      .filter((key) => !key.startsWith("line_items:"))
      .sort(),
    ["purchase_date", "total", "vendor"].sort(),
  );
  // ADM-5g: an item's key follows its evidence, so the list is counted.
  assert.equal(
    (await f.stored()).filter((row) =>
      row.observation_key.startsWith("line_items:"),
    ).length,
    0,
  );
  assert.deepEqual(await f.corrections(), []);
});

test("sparse 0-based ordinals and a blank page number from one", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-sparse-ordinals");
  // 0-based, with a gap, and a blank verso in the middle. The blank page is
  // not offered to the model at all, and leaving it out shifts nothing:
  // numbering is by position in the list actually shown.
  await repaginate(f, ids, [
    [0, "HALLOWAY JOINERY\nInvoice 88120"],
    [1, ""],
    [4, "Invoice date: 9 Apr 2026\nAmount due $165.00"],
  ]);
  const model = fakeModel({
    kind: "invoice",
    summary: "Joinery invoice.",
    statements: [
      statement("vendor", "HALLOWAY JOINERY", [1]),
      statement("invoice_number", "88120", [2]),
      { ...statement("invoice_date", "9 Apr 2026", [1]), page: 2 },
      { ...statement("total", "$165.00", [2]), page: 2 },
    ],
  });
  const outcome = await f.extract(model, ids);
  // Two pages shown, headed 1 and 2. The blank one is absent.
  const prompt = model.requests[0].prompt;
  assert.match(prompt, /=== page 1 ===\n1\| HALLOWAY JOINERY/);
  assert.match(prompt, /=== page 2 ===\n1\| Invoice date: 9 Apr 2026/);
  assert.doesNotMatch(prompt, /=== page 3 ===/);
  assert.match(prompt, /Pages and lines both count from 1\./);

  assert.equal(outcome.failed, 0);
  assert.deepEqual(
    (await f.stored())
      .map((row) => row.observation_key)
      .filter((key) => !key.startsWith("line_items:"))
      .sort(),
    ["invoice_date", "invoice_number", "total", "vendor"].sort(),
  );
  // ADM-5g: an item's key follows its evidence, so the list is counted.
  assert.equal(
    (await f.stored()).filter((row) =>
      row.observation_key.startsWith("line_items:"),
    ).length,
    0,
  );
  // The spans point at the real page rows, ordinals and all.
  const spans = await f.rows(
    `SELECT p.ordinal FROM kith.evidence_spans s
       JOIN kith.source_pages p ON p.id = s.source_page_id
      WHERE s.space_id = $1 ORDER BY p.ordinal`,
    [f.spaceId],
  );
  assert.deepEqual(
    [...new Set(spans.map((row) => Number(row.ordinal)))],
    [0, 4],
  );
  // A blank page is not a dropped page, so nothing claims the document was
  // read partially.
  assert.equal(outcome.truncated, false);
  assert.deepEqual(await f.corrections(), []);
});

test("a very long line becomes several citable pieces", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-long-line");
  // One 2,000-character line, as some real pages carry. Cited whole it would
  // hold dozens of numbers, and any of them would satisfy a check meant for
  // one.
  const filler = Array.from(
    { length: 120 },
    (_, index) => `item ${index} at ${index}.00`,
  ).join(" ");
  const page = `HALLOWAY JOINERY ${filler} amount due 4242.00`;
  assert.ok(page.length > 2_000);
  await repaginate(f, ids, [[0, page]]);

  const model = fakeModel({
    kind: "invoice",
    summary: "Joinery invoice.",
    statements: [statement("vendor", "HALLOWAY JOINERY", [1])],
  });
  await f.extract(model, ids);
  const shown = model.requests[0].prompt;
  // Split, and each piece is its own citable line.
  assert.match(shown, /^1\| HALLOWAY JOINERY/m);
  assert.match(shown, /^2\| /m);
  // The pieces cover the page exactly: every one is a real slice, and joined
  // they are the page.
  const lines = pageLines(page);
  assert.ok(lines.length > 1);
  assert.equal(lines.map((line) => line.text).join(""), page);
  for (const line of lines) {
    assert.equal(page.slice(line.start, line.end), line.text);
    // ADM-5f: the bound softens rather than cut a value in half.
    assert.ok(line.end - line.start <= 240 + 64);
  }
  // A value on a far piece is not supported by citing the first one.
  assert.deepEqual(
    checkValue({
      valueType: "money",
      value: "4242.00",
      candidates: asCandidates(lines[0].text),
      pageText: page,
      defaultCurrency: "USD",
    }),
    { ok: false, reason: "value_not_in_quote" },
  );
});

// ---------------------------------------------------------------------------
// The column receipt the live trial lost every money field on (ADM-5f).
// ---------------------------------------------------------------------------

/**
 * A till receipt as the parser emits one: no table rows, a short median line,
 * and the totals block printing its labels together and its amounts together.
 * The label for a total is seven lines from the amount.
 */
const COLUMN_TOTALS_RECEIPT = [
  "BRACKEN",          // 1  vendor, split over two lines, as a logo often is
  "TOOLS LTD.",       // 2
  "12 Mill Lane",     // 3
  "09/18/26 14:32",   // 4
  "Chisel",           // 5
  "12.00",            // 6
  "Mallet",           // 7
  "8.00",             // 8
  "Subtotal",         // 9
  "Tax",              // 10
  "Total",            // 11
  "20.00",            // 12
  "1.60",             // 13
  "21.60",            // 14
].join("\n");

test("a column receipt stores its money fields from far-apart lines", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_TOTALS_RECEIPT, "synthetic-column-totals");
  await f.client.query(
    `UPDATE kith.document_types
        SET examples = '[{"setting":"date_order","value":"MDY"}]'::jsonb
      WHERE space_id = $1 AND kind = 'receipt'`,
    [f.spaceId],
  );
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        // The vendor is split across two adjacent lines, which text fields
        // may span.
        statement("vendor", "BRACKEN TOOLS LTD.", [1, 2]),
        statement("purchase_date", "09/18/26 14:32", [4]),
        // Each item cites the line with its description and the line with
        // its amount: on this receipt they are different lines.
        statement("line_items", null, [6, 8], {
          line_items: [
            { description: "Chisel", amount: "12.00", lines: [5, 6] },
            { description: "Mallet", amount: "8.00", lines: [7, 8] },
          ],
        }),
        // Label and amount, five lines apart. Every one of these was
        // citation_out_of_range under the contiguity rule.
        statement("subtotal", "20.00", [9, 12]),
        statement("tax", "1.60", [10, 13]),
        statement("total", "21.60", [11, 14]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.failed, 0, "no corrections");
  assert.deepEqual(
    (await f.stored())
      .map((row) => row.observation_key)
      .filter((key) => !key.startsWith("line_items:"))
      .sort(),
    ["purchase_date", "subtotal", "tax", "total", "vendor"].sort(),
  );
  // ADM-5g: an item's key follows its evidence, so the list is counted.
  assert.equal(
    (await f.stored()).filter((row) =>
      row.observation_key.startsWith("line_items:"),
    ).length,
    2,
  );
  const stored = await f.stored();
  assert.equal(
    stored.find((row) => row.observation_key === "total").value.amount,
    "21.6",
  );
  assert.equal(
    stored.find((row) => row.observation_key === "purchase_date").value.value,
    "2026-09-18",
  );
  // Each line item cites the line that prints its own amount, not a range.
  const spans = await f.rows(
    `SELECT o.observation_key, s."start", s."end" FROM kith.observations o
       JOIN kith.evidence_spans s ON s.id = (o.value_evidence->>0)
      WHERE o.space_id = $1 AND o.observation_type = 'line_items'
      ORDER BY o.observation_key`,
    [f.spaceId],
  );
  assert.equal(spans.length, 2);
  assert.notEqual(spans[0].start, spans[1].start);
});

test("a value on neither cited line is still refused", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_TOTALS_RECEIPT, "synthetic-column-wrong");
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        // Lines 9 and 14 are "Subtotal" and "21.60". Claiming the subtotal is
        // 20.00 cites two real lines, neither of which prints it, and the
        // 20.00 sitting on line 12 in between must not rescue it.
        statement("subtotal", "20.00", [9, 14]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.stored, 0);
  assert.deepEqual(await f.corrections(), [
    { field_name: "subtotal", reason: "value_not_in_quote" },
  ]);
});

test("a vendor may be folded and split, but a number may not", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_TOTALS_RECEIPT, "synthetic-vendor-folding");
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        // Case and punctuation folded, and spanning the two adjacent lines.
        statement("vendor", "Bracken Tools Ltd", [1, 2]),
        // The same latitude must NOT reach money: 12.00 on line 6 and 8.00 on
        // line 8 are two amounts, and 128.00 is neither of them.
        statement("total", "128.00", [6, 8]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.stored, 1);
  assert.equal(
    (await f.stored()).find((row) => row.observation_key === "vendor").value
      .value,
    "Bracken Tools Ltd",
  );
  assert.deepEqual(await f.corrections(), [
    { field_name: "total", reason: "value_not_in_quote" },
  ]);
});

test("every statement and every correction records what it cited", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_TOTALS_RECEIPT, "synthetic-citation-record");
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("subtotal", "20.00", [9, 12]),
        statement("total", "999.00", [11, 14]),
      ],
    }),
    ids,
  );
  const stored = (
    await f.rows(
      "SELECT statements FROM kith.document_extractions WHERE space_id = $1",
      [f.spaceId],
    )
  )[0].statements;
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].citation, {
    shownPage: 1,
    pageOrdinal: 0,
    lines: [9, 12],
    pageLineCount: 14,
    contiguous: false,
  });
  const correction = (
    await f.rows(
      "SELECT original_value FROM kith.corrections WHERE space_id = $1",
      [f.spaceId],
    )
  )[0].original_value;
  assert.equal(correction.value, "999.00");
  assert.deepEqual(correction.citation, {
    shownPage: 1,
    pageOrdinal: 0,
    lines: [11, 14],
    pageLineCount: 14,
    contiguous: false,
  });
});

test("the diagnostic answers in numbers and never in text", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(COLUMN_TOTALS_RECEIPT, "synthetic-diagnose");
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("vendor", "BRACKEN TOOLS LTD.", [1, 2]),
        // Cited the label lines only: the amount is on 12, not on 9 or 11.
        statement("subtotal", "20.00", [9, 11]),
      ],
    }),
    ids,
    NOW + 2_000,
  );
  const summary = await withKithTransaction(f.pool, (client) =>
    diagnoseExtractions(client, { kind: "receipt", limit: 5 }),
  );
  assert.equal(summary.documents.length, 1);
  const document = summary.documents[0];
  assert.equal(document.kind, "receipt");
  assert.equal(document.model, "synthetic-line-model");
  assert.equal(document.storedStatements, 1);
  assert.equal(document.lineCount, 14);
  // The column layout's fingerprint: a short median beside a longer maximum.
  assert.ok(document.medianLineChars < document.maxLineChars);
  assert.equal(document.failures.length, 1);
  const failure = document.failures[0];
  assert.equal(failure.field, "subtotal");
  assert.equal(failure.reason, "value_not_in_quote");
  assert.equal(failure.shownPage, 1);
  assert.equal(failure.pageOrdinal, 0);
  assert.deepEqual(failure.citedLines, [9, 11]);
  assert.equal(failure.pageLineCount, 14);
  assert.equal(failure.contiguous, false);
  // This is the answer the live trial could not get: the value IS on the
  // page, on line 12, and the model cited 9 and 11.
  assert.equal(failure.onCitedPage, true);
  assert.deepEqual(failure.onLines, [12]);
  assert.equal(failure.onOtherPage, false);
  assert.equal(failure.signature, "99.99");
  assert.deepEqual(summary.reasonCounts, { value_not_in_quote: 1 });
  assert.deepEqual(summary.byKind, { receipt: { value_not_in_quote: 1 } });

  // Nothing the document says can reach the output.
  const printed = JSON.stringify(summary);
  for (const secret of ["BRACKEN", "TOOLS", "Mill Lane", "Chisel", "Mallet"]) {
    assert.equal(printed.includes(secret), false, secret);
  }
});

test("a value signature keeps the shape and drops the content", () => {
  assert.equal(valueSignature("$1,234.56"), "$9,999.99");
  assert.equal(valueSignature("Bracken Tools"), "aaaaaaa aaaaa");
  assert.equal(valueSignature("09/18/26 14:32"), "99/99/99 99:99");
  assert.equal(valueSignature("12 Mill Lane, Apt #4"), "99 aaaa aaaa, aaa 9");
  // Bounded, so a long value cannot become a long quotation.
  assert.equal(valueSignature("x".repeat(500)).length, 24);
  assert.equal(valueSignature(null), "");
  // A structured value is folded the same way, so even a JSON envelope
  // cannot carry its own strings out.
  assert.equal(
    valueSignature({ type: "money", amount: "1.00" }),
    "aaaa:aaaaa,aaaaaa:9.99",
  );
});

// ---------------------------------------------------------------------------
// A cut that lands inside a value (ADM-5f). Shipped in ADM-5e and live.
// ---------------------------------------------------------------------------

/** The token class a cut must never land inside. */
const TOKEN_CHAR = /[0-9.,:/'-]/;

/**
 * Which positions of a line belong to a value rather than to filler.
 *
 * A dot leader is made of the same characters a decimal point is, so a naive
 * reading would call every leader one enormous token and no invoice line
 * could ever be split. Three or more identical punctuation characters in a
 * row are a rule on the page, not a number -- the same judgement
 * `fillerPositions` makes in `lines.ts`, restated here so the property is
 * checked against its own definition rather than against the implementation.
 */
function tokenPositions(text) {
  const token = new Set();
  let runStart = 0;
  for (let at = 1; at <= text.length; at += 1) {
    if (at === text.length || text[at] !== text[runStart]) {
      const filler = at - runStart >= 3 && /[^\w\s]/.test(text[runStart]);
      if (!filler) {
        for (let index = runStart; index < at; index += 1) {
          if (TOKEN_CHAR.test(text[index])) token.add(index);
        }
      }
      runStart = at;
    }
  }
  return token;
}

/** Whether any piece boundary has value characters on both sides, which is
 * the shape of a number or a date cut in half. */
function cutsThroughToken(line, pieces) {
  const token = tokenPositions(line.text);
  for (let index = 1; index < pieces.length; index += 1) {
    const at = pieces[index].start - line.start;
    if (token.has(at - 1) && token.has(at)) return true;
  }
  return false;
}

test("a long line is never cut through a number or a date", () => {
  // The three reproductions. Each is a 240-plus character line whose only
  // whitespace is far to the left, so the old splitter fell back to cutting
  // at the bound -- which landed inside the value.
  const reproductions = {
    amount: ["Consulting services", ".".repeat(220), "1,234.56"],
    date: ["Statement period ending", ".".repeat(216), "09/18/2026"],
    credit: ["Adjustment for prior period", ".".repeat(210), "(1,234.56)"],
    trailingCr: ["Balance carried forward", ".".repeat(214), "1,234.56 CR"],
  };
  for (const [name, [label, leader, value]] of Object.entries(reproductions)) {
    const line = `${label}${leader}${value}`;
    assert.ok(line.length > 240, name);
    const pieces = pageLines(line);
    // Exact cover, as always.
    assert.equal(pieces.map((piece) => piece.text).join(""), line, name);
    // And the value survives whole on one piece.
    assert.ok(
      pieces.some((piece) => piece.text.includes(value)),
      `${name}: the value is whole on one piece`,
    );
    assert.equal(
      cutsThroughToken({ start: 0, text: line }, pieces),
      false,
      name,
    );
    // The dot leader is filler, not a token, so the line still splits rather
    // than being abandoned whole.
    assert.ok(pieces.length > 1, `${name}: still split`);
  }
});

test("a cut edge is unknown, so no piece offers what the line does not", () => {
  // ADM-5g round five. The fourth review cut `...$2.5 million` down to
  // `$2.5`, `( 1,234 )` down to `( 1,234` and `45.00 CR` down to `45.00`, and
  // each survivor was then shown to the model as a line of its own, cited in
  // good faith, and stored as a number the page never printed -- the 10^6,
  // sign-flip and lost-parenthesis errors, arriving through the splitter
  // rather than through the finder.
  //
  // Two things close it, and the test checks both at once. The splitter no
  // longer cuts beside a digit, a currency mark, a parenthesis, a sign, a
  // magnitude word or a `CR`; and where it does cut, the piece carries
  // `cutStart`/`cutEnd`, which makes the amount finder treat the edge as
  // unknown and refuse anything touching it. The invariant is the same one
  // the oracle fuzzer asserts: **no piece may offer a value the whole line
  // does not.**
  const tails = [
    "$2.5 million",
    "$2.5  million",
    "$2.5 M",
    "( 1,234 )",
    "(1,234)",
    "45.00 CR",
    "$1 000 000",
    "1,234.56",
    "12.99T",
    "$2.5M",
    "(1,234.56) CR",
    "USD 13.20",
    "13.20 USD",
    "-$42.00",
    "250.00-",
  ];
  for (const tail of tails) {
    const whole = new Set(amountsInText(`Consulting services ${tail} paid`));
    // Every offset around the 240-character bound, so the cut lands before,
    // inside and after the amount in turn.
    for (let pad = 180; pad < 300; pad += 1) {
      const line = `${"word ".repeat(Math.ceil(pad / 5)).slice(0, pad)}${tail} paid`;
      const pieces = pageLines(line);
      assert.equal(
        pieces.map((piece) => piece.text).join(""),
        line,
        `${tail} at ${pad}: exact cover`,
      );
      for (const piece of pieces) {
        assert.equal(line.slice(piece.start, piece.end), piece.text);
        const offered = amountsInText(piece.text, {
          cutStart: piece.cutStart,
          cutEnd: piece.cutEnd,
        });
        for (const value of offered) {
          assert.ok(
            whole.has(value),
            `${JSON.stringify(tail)} at ${pad}: piece ${JSON.stringify(piece.text.slice(-40))} offered ${value}, which the line does not print (${[...whole].join(", ") || "nothing"})`,
          );
        }
      }
    }
  }
});

test("a cut edge refuses the amount that touches it", () => {
  // The rule on its own, without the splitter: the same text, read once as a
  // whole line and once as a piece with an unknown edge.
  assert.deepEqual(amountsInText("Fund size $2.5"), ["2.5"]);
  assert.deepEqual(amountsInText("Fund size $2.5", { cutEnd: true }), []);
  assert.deepEqual(amountsInText("$2.5 mill", { cutEnd: true }), []);
  assert.deepEqual(amountsInText("55390.", { cutEnd: true }), []);
  assert.deepEqual(amountsInText("12:", { cutEnd: true }), []);
  assert.deepEqual(amountsInText("1,234 total", { cutStart: true }), []);
  // A cut on the other side leaves the amount alone.
  assert.deepEqual(amountsInText("Fund size $2.5", { cutStart: true }), ["2.5"]);
  // And a real line edge is not a cut.
  assert.deepEqual(amountsInText("total 1,234"), ["1234"]);
});

test("a value cut in half cannot be stored", { skip }, async (t) => {
  const f = await fixture(t);
  const page = [
    "HALLOWAY JOINERY",
    `Consulting services${".".repeat(220)}1,234.56`,
    `Statement period ending${".".repeat(216)}09/18/2026`,
    `Adjustment for prior period${".".repeat(210)}(1,234.56)`,
  ].join("\n");
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-cut-token");
  await repaginate(f, ids, [[0, page]]);
  await f.client.query(
    `UPDATE kith.document_types
        SET examples = '[{"setting":"date_order","value":"MDY"}]'::jsonb
      WHERE space_id = $1 AND kind = 'invoice'`,
    [f.spaceId],
  );
  // What the old splitter offered the model as whole lines, and what a model
  // would then cite in good faith. None of these is what the document says.
  const model = fakeModel({
    kind: "invoice",
    summary: "Joinery invoice.",
    statements: [
      statement("vendor", "HALLOWAY JOINERY", [1]),
      statement("total", "234.56", [3]),
      statement("invoice_date", "09/18/2020", [4]),
      statement("subtotal", "1234.56", [5]),
    ],
  });
  const outcome = await f.extract(model, ids);
  // Only the vendor: the three fabricated readings have no line that prints
  // them, because no line was ever cut through a value.
  assert.equal(outcome.stored, 1);
  assert.deepEqual(
    (await f.stored()).map((row) => row.observation_key),
    ["vendor"],
  );
  for (const row of await f.corrections()) {
    assert.equal(row.reason, "value_not_in_quote", row.field_name);
  }
  // And the page as shown never offers a partial value as a line.
  const shown = model.requests[0].prompt;
  assert.doesNotMatch(shown, /^\d+\| 234\.56$/m);
  assert.doesNotMatch(shown, /^\d+\| 09\/18\/20$/m);
});

test("pieces always cover the line and never split a token", () => {
  // Property-style, over the shapes a parsed line actually takes: words, dot
  // leaders, amounts, dates and long unbroken runs.
  const parts = [
    "Consulting",
    "services",
    "Statement period ending",
    " ",
    "   ",
    ".".repeat(4),
    ".".repeat(40),
    "-".repeat(12),
    "1,234.56",
    "(9,876.54)",
    "09/18/2026",
    "2026-09-18T14:32:00",
    "42",
    "0.07",
    "INV-0012",
    "x".repeat(70),
    "$1,000.00 CR",
  ];
  // A deterministic pseudo-random walk, so a failure is reproducible.
  let seed = 20260919;
  const next = (bound) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % bound;
  };
  for (let round = 0; round < 400; round += 1) {
    let line = "";
    while (line.length < 300 + next(400)) line += parts[next(parts.length)];
    const pieces = pageLines(line);
    assert.equal(
      pieces.map((piece) => piece.text).join(""),
      line,
      `round ${round}: exact cover`,
    );
    for (const piece of pieces) {
      assert.equal(line.slice(piece.start, piece.end), piece.text);
      assert.ok(piece.end > piece.start, `round ${round}: no empty piece`);
    }
    assert.equal(
      cutsThroughToken({ start: 0, text: line }, pieces),
      false,
      `round ${round}: no cut inside a token`,
    );
  }
});

test("an identifier is stored as the document spells it", { skip }, async (t) => {
  const f = await fixture(t);
  const page = ["HALLOWAY JOINERY", "Invoice No. INV-0012", "Total $20.00"].join(
    "\n",
  );
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-identifier-spelling");
  await repaginate(f, ids, [[0, page]]);
  for (const spelling of ["INV.0012", "INV 0012", "inv 0012"]) {
    await f.extract(
      fakeModel({
        kind: "invoice",
        summary: "Joinery invoice.",
        statements: [statement("invoice_number", spelling, [2])],
      }),
      ids,
      NOW + 2_000,
    );
    const stored = (await f.stored()).find(
      (row) => row.observation_key === "invoice_number",
    );
    // The fold accepts all three, and what is stored is the page's own.
    assert.equal(stored.value.value, "INV-0012", spelling);
  }
});

test("the diagnostic survives a correction with a scalar reading", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-legacy-correction");
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [statement("vendor", "BRACKEN TOOLS", [1])],
    }),
    ids,
  );
  // A row written before ADM-5f recorded citations: the reading is the bare
  // value, with no envelope around it. `"value" in original` threw on this,
  // and the CLI aborted on the first one it met.
  await f.client.query(
    `INSERT INTO kith.corrections
       (id, space_id, target_kind, target_id, field_name, original_value,
        reason, state)
     VALUES ($1,$2,'document',$3,'total','"21.60"'::jsonb,
             'value_not_in_quote','open')`,
    [newKithId(), f.spaceId, ids.sourceItemId],
  );
  const summary = await withKithTransaction(f.pool, (client) =>
    diagnoseExtractions(client, { limit: 5 }),
  );
  const failure = summary.documents[0].failures.find(
    (entry) => entry.field === "total",
  );
  assert.ok(failure, "the legacy row is reported rather than fatal");
  assert.equal(failure.shownPage, null);
  assert.deepEqual(failure.citedLines, []);
  assert.equal(failure.signature, "99.99");
  // With no citation recorded there is no cited page, but the diagnostic can
  // still say the document prints it.
  assert.equal(failure.onCitedPage, false);
  assert.equal(failure.onOtherPage, true);
});

// ---------------------------------------------------------------------------
// Line items, entry by entry (ADM-5g).
//
// With a strong model the remaining failures on the owner's documents were
// both line items: a whole list refused because one entry was garbled, an
// amount that arrived as "1299" for a printed 12.99, and an amount carrying a
// tax letter. Each entry is now gated on its own citation and stored on its
// own.
// ---------------------------------------------------------------------------

/** A receipt whose items print their description and amount on separate
 * lines, one description wrapping onto a second line, and one amount
 * carrying a tax flag. */
const ITEMISED_RECEIPT = [
  "BRACKEN TOOLS",          // 1
  "09/18/26",               // 2
  "Chisel",                 // 3
  "12.99 T",                // 4
  "Mallet, rubber faced",   // 5
  "two pound",              // 6
  "8.00",                   // 7
  "Screws box of 100",      // 8
  "4.25",                   // 9
  "Total",                  // 10
  "25.24",                  // 11
].join("\n");

test("each line item stores on its own citation", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(ITEMISED_RECEIPT, "synthetic-itemised");
  await f.client.query(
    `UPDATE kith.document_types
        SET examples = '[{"setting":"date_order","value":"MDY"}]'::jsonb
      WHERE space_id = $1 AND kind = 'receipt'`,
    [f.spaceId],
  );
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("vendor", "BRACKEN TOOLS", [1]),
        statement("purchase_date", "09/18/26", [2]),
        statement("line_items", null, [3, 4], {
          line_items: [
            // Description and amount on different lines.
            { description: "Chisel", amount: "12.99 T", lines: [3, 4] },
            // A description wrapped over two adjacent lines.
            {
              description: "Mallet, rubber faced two pound",
              amount: "8.00",
              lines: [5, 6, 7],
            },
            { description: "Screws box of 100", amount: "4.25", lines: [8, 9] },
          ],
        }),
        statement("total", "25.24", [10, 11]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.failed, 0, "no corrections");
  const stored = await f.stored();
  // ADM-5g: an item's key follows its evidence, so the list is counted.
  assert.deepEqual(
    stored
      .map((row) => row.observation_key)
      .filter((key) => !key.startsWith("line_items:"))
      .sort(),
    ["purchase_date", "total", "vendor"],
  );
  assert.equal(
    stored.filter((row) => row.observation_key.startsWith("line_items:"))
      .length,
    3,
  );
  // The tax letter is a flag, not a digit.
  assert.deepEqual(
    stored
      .filter((row) => row.observation_key.startsWith("line_items:"))
      .map((row) => row.value.amount),
    ["12.99", "8", "4.25"],
  );
  // Each item's span is the line that prints its own amount, so three
  // different spans.
  const spans = await f.rows(
    `SELECT DISTINCT s."start" FROM kith.observations o
       JOIN kith.evidence_spans s ON s.id = (o.value_evidence->>0)
      WHERE o.space_id = $1 AND o.observation_type = 'line_items'`,
    [f.spaceId],
  );
  assert.equal(spans.length, 3);
});

test("a bad entry is one entry, and the rest still store", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(ITEMISED_RECEIPT, "synthetic-partial-items");
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("line_items", null, [3, 4], {
          line_items: [
            { description: "Chisel", amount: "12.99 T", lines: [3, 4] },
            // The decimal point dropped: 1299 is not what line 4 prints.
            { description: "Mallet, rubber faced", amount: "1299", lines: [5, 7] },
            { description: "Screws box of 100", amount: "4.25", lines: [8, 9] },
          ],
        }),
      ],
    }),
    ids,
  );
  // Two of three stored, and one row saying one is missing.
  assert.equal(outcome.stored, 2);
  assert.deepEqual(
    (await f.stored()).map((row) => row.value.amount),
    ["12.99", "4.25"],
  );
  const corrections = await f.rows(
    "SELECT reason, original_value FROM kith.corrections WHERE space_id = $1",
    [f.spaceId],
  );
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].reason, "line_items_partial");
  // Counts only: which entries failed is the diagnostic's business.
  assert.equal(corrections[0].original_value.value.failedItems, 1);
  assert.equal(corrections[0].original_value.value.totalItems, 3);
  // The shape of the entry that failed, folded: enough to see the decimal
  // point is missing, and not enough to read the receipt.
  assert.deepEqual(corrections[0].original_value.value.failedShapes, [
    {
      amount: "9999",
      description: "aaaaaa, aaaaaa aaaaa",
      lines: [5, 7],
      reason: "value_not_in_quote",
    },
  ]);
  // A partial list is never compared against a stated total, which would
  // raise a mismatch that says nothing.
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

test("a statement that cites nothing says so by name", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(ITEMISED_RECEIPT, "synthetic-no-citation");
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        { field: "total", value: "25.24", page: 1, lines: [] },
        statement("vendor", "BRACKEN TOOLS", [1]),
      ],
    }),
    ids,
  );
  assert.equal(outcome.stored, 1);
  // Its own reason: "the model forgot to cite" is not "the quote is not on
  // the page", and the counts have to separate them.
  assert.deepEqual(await f.corrections(), [
    { field_name: "total", reason: "citation_missing" },
  ]);
});

test("the diagnostic shows each entry's amount and description apart", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(ITEMISED_RECEIPT, "synthetic-item-signatures");
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("line_items", null, [3, 4], {
          line_items: [
            { description: "Chisel", amount: "1299", lines: [3, 4] },
            { description: "Mallet", amount: "8.00", lines: [5, 7] },
          ],
        }),
      ],
    }),
    ids,
  );
  const summary = await withKithTransaction(f.pool, (client) =>
    diagnoseExtractions(client, { kind: "receipt", limit: 5 }),
  );
  const failure = summary.documents[0].failures.find(
    (entry) => entry.field === "line_items",
  );
  assert.ok(failure);
  // The whole-list signature reads as one run of folded JSON. Split out, the
  // missing decimal point is visible at a glance.
  assert.deepEqual(failure.itemSignatures, [
    {
      amount: "9999",
      description: "aaaaaa",
      lines: [3, 4],
      reason: "value_not_in_quote",
    },
  ]);
  // And still nothing the document says.
  const printed = JSON.stringify(summary);
  for (const secret of ["BRACKEN", "Chisel", "Mallet", "Screws"]) {
    assert.equal(printed.includes(secret), false, secret);
  }
});

test("an item with no lines of its own needs an unambiguous statement", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(ITEMISED_RECEIPT, "synthetic-item-fallback");
  // Line 3 prints "Chisel", line 4 prints "12.99 T". An entry with no lines
  // of its own, under a statement citing both, used to take the whole
  // citation -- which is how a description on one line paired with a
  // different item's amount on another.
  const outcome = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("line_items", null, [3, 4], {
          line_items: [{ description: "Chisel", amount: "12.99", lines: [] }],
        }),
      ],
    }),
    ids,
  );
  assert.equal(outcome.stored, 0);
  assert.deepEqual(await f.corrections(), [
    { field_name: "line_items", reason: "value_not_in_quote" },
  ]);

  // A statement naming exactly one line leaves no ambiguity, so the entry may
  // still lean on it.
  const single = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("line_items", null, [9], {
          line_items: [
            { description: "Screws box of 100", amount: "4.25", lines: [] },
          ],
        }),
      ],
    }),
    ids,
    NOW + 3_000,
  );
  assert.equal(single.stored, 0, "line 9 prints the amount but not the words");
  const named = await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("line_items", null, [8], {
          line_items: [
            { description: "Screws box of 100", amount: "4.25", lines: [8, 9] },
          ],
        }),
      ],
    }),
    ids,
    NOW + 4_000,
  );
  assert.equal(named.stored, 1);
});

test("an item's key follows its evidence, not its position", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(ITEMISED_RECEIPT, "synthetic-stable-keys");
  const three = [
    { description: "Chisel", amount: "12.99 T", lines: [3, 4] },
    { description: "Mallet, rubber faced", amount: "8.00", lines: [5, 7] },
    { description: "Screws box of 100", amount: "4.25", lines: [8, 9] },
  ];
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [statement("line_items", null, [3, 4], { line_items: three })],
    }),
    ids,
  );
  const first = (await f.stored())
    .filter((row) => row.observation_key.startsWith("line_items:"))
    .map((row) => [row.observation_key, row.value.amount]);
  assert.equal(first.length, 3);

  // The model lists the same receipt in a different order, and the first
  // entry fails. Position-keyed, every later key would shift by one and an
  // owner's correction on one line would land on another.
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("line_items", null, [3, 4], {
          line_items: [
            { description: "Chisel", amount: "1299", lines: [3, 4] },
            three[2],
            three[1],
          ],
        }),
      ],
    }),
    ids,
    NOW + 3_000,
  );
  const second = (await f.stored())
    .filter((row) => row.observation_key.startsWith("line_items:"))
    .map((row) => [row.observation_key, row.value.amount]);
  assert.equal(second.length, 2);
  // Each surviving key still carries the amount it carried before.
  for (const [key, amount] of second) {
    const before = first.find((entry) => entry[0] === key);
    assert.ok(before, `${key} kept its key across a reorder`);
    assert.equal(before[1], amount);
  }
});

test("a one-item list still keys by evidence", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(ITEMISED_RECEIPT, "synthetic-one-item");
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("line_items", null, [3, 4], {
          line_items: [
            { description: "Chisel", amount: "12.99 T", lines: [3, 4] },
          ],
        }),
      ],
    }),
    ids,
  );
  const [only] = await f.stored();
  // Not the bare field name: a list keyed `line_items` today orphans the
  // owner's correction the moment next week's receipt has two lines.
  assert.match(only.observation_key, /^line_items:\d+-[a-z0-9]+-\d+$/);
});

test("two identical items on one line get their own keys", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(TABLE_RECEIPT, "synthetic-twin-items");
  const page = ["BRACKEN TOOLS", "Chisel 5.00   Chisel 5.00"].join("\n");
  await repaginate(f, ids, [[0, page]]);
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("line_items", null, [2], {
          line_items: [
            { description: "Chisel", amount: "5.00", lines: [2] },
            { description: "Chisel", amount: "5.00", lines: [2] },
          ],
        }),
      ],
    }),
    ids,
  );
  const stored = await f.stored();
  assert.equal(stored.length, 2);
  // Same line, same words, same amount -- and still two keys, or correcting
  // one would correct both.
  assert.notEqual(stored[0].observation_key, stored[1].observation_key);
});

test("a correction with no line left to land on is not duplicated", { skip }, async (t) => {
  const f = await fixture(t);
  const ids = await f.ingest(ITEMISED_RECEIPT, "synthetic-orphan-correction");
  // The same item is printed twice on this receipt -- once in the body and
  // once in a summary block -- so two different lines are an equally correct
  // citation for it.
  const page = [
    "BRACKEN TOOLS", // 1
    "Chisel 12.99", // 2
    "SUMMARY", // 3
    "Chisel 12.99", // 4
  ].join("\n");
  await repaginate(f, ids, [[0, page]]);
  const reading = (line) => ({
    kind: "receipt",
    summary: "Hardware receipt.",
    statements: [
      statement("line_items", null, [line], {
        line_items: [{ description: "Chisel", amount: "12.99", lines: [line] }],
      }),
    ],
  });
  await f.extract(fakeModel(reading(2)), ids);
  const [item] = await f.stored();
  await withKithTransaction(f.pool, (client) =>
    applyCorrection(client, {
      spaceId: f.spaceId,
      sourceItemId: ids.sourceItemId,
      fieldName: item.observation_key,
      correctedValue: { type: "money", amount: "13.99", currency: "USD" },
      actorUserId: f.userId,
      now: NOW + 3_000,
    }),
  );
  assert.equal((await f.stored())[0].value.amount, "13.99");

  // The next run cites the summary line instead, so the old key matches
  // nothing. Inserting the corrected value under it would put the item in the
  // list twice and make every sum over it double count, silently.
  await f.extract(fakeModel(reading(4)), ids, NOW + 4_000);
  const after = await f.stored();
  assert.equal(after.length, 1, "one line item, not two");
  const orphan = (await f.corrections()).find(
    (row) => row.reason === "correction_orphaned",
  );
  assert.ok(orphan, "the owner is told the correction no longer lands");
  // ADM-5g: keyed on the list field, not on the line key. A line key carries
  // the evidence hash of the line the run cited, so an item keyed on it comes
  // back under a new id on every run and a dismissal never holds.
  assert.equal(orphan.field_name, "line_items");
  assert.equal(
    (await f.corrections()).filter(
      (row) => row.reason === "correction_orphaned",
    ).length,
    1,
  );
});

test("a correction that lands on nothing says so as it is made", { skip }, async (t) => {
  // ADM-5g: the same orphan, one step earlier. `applyCorrection` writes the
  // row and pushes the value through to the observation; when the key names
  // no observation, the push returns -1 and used to be discarded. The screen
  // then showed `resolved` while `sum_money` and `latest_observation` never
  // saw the owner's number -- the two halves of the store disagreeing about
  // the same fact, which is what the write-through exists to prevent.
  const f = await fixture(t);
  const ids = await f.ingest(ITEMISED_RECEIPT, "synthetic-orphan-on-apply");
  const page = ["BRACKEN TOOLS", "Chisel 12.99"].join("\n");
  await repaginate(f, ids, [[0, page]]);
  await f.extract(
    fakeModel({
      kind: "receipt",
      summary: "Hardware receipt.",
      statements: [
        statement("line_items", null, [2], {
          line_items: [{ description: "Chisel", amount: "12.99", lines: [2] }],
        }),
      ],
    }),
    ids,
  );
  const stale = "line_items:9-0000000-0";
  await withKithTransaction(f.pool, (client) =>
    applyCorrection(client, {
      spaceId: f.spaceId,
      sourceItemId: ids.sourceItemId,
      fieldName: stale,
      correctedValue: { type: "money", amount: "13.99", currency: "USD" },
      actorUserId: f.userId,
      now: NOW + 3_000,
    }),
  );
  // The item the run did store is untouched: a correction that lands nowhere
  // must not land on a neighbour.
  assert.equal((await f.stored())[0].value.amount, "12.99");
  const orphan = (await f.corrections()).find(
    (row) => row.reason === "correction_orphaned",
  );
  assert.ok(orphan, "the owner is told the correction never reached the sum");
  assert.equal(orphan.field_name, "line_items");
});
