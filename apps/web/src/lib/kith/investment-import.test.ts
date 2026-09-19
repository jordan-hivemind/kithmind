// The spreadsheet import's rules: the sign and currency reading, the exact
// decimal arithmetic, the reconciliation that refuses to trust either tab over
// the other, and the run that reports every row.
//
// Synthetic fixtures only. Every name, amount and date below is invented.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  addDecimals,
  buildPreview,
  type EntryBody,
  type ImportWriter,
  type InvestmentFields,
  keyed,
  mapLedger,
  mapSummary,
  multiplyDecimals,
  parseCsv,
  parseMoney,
  parseRate,
  parseSheetDate,
  planImport,
  runImport,
} from "./investment-import";
import { amountSchemaFor } from "./investment-schemas";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "investment-import-fixtures",
);
const REAL_SUMMARY_CSV = readFileSync(
  path.join(FIXTURES_DIR, "summary.csv"),
  "utf8",
);
const REAL_LEDGER_CSV = readFileSync(
  path.join(FIXTURES_DIR, "ledger.csv"),
  "utf8",
);

describe("the amount rule the drawer and the routes share", () => {
  it("accepts a negative amount for a commitment change and no other type", () => {
    // The drawer's Save button asks this, and so does the route. They used to
    // disagree: the drawer carried an unsigned copy, so a reduced commitment
    // could be typed and never saved.
    expect(amountSchemaFor("commitment_change").safeParse("-250.00").success).toBe(
      true,
    );
    for (const entryType of [
      "capital_call_paid",
      "distribution",
      "commitment",
      "fee",
      "write_off",
      "other",
    ]) {
      expect(
        amountSchemaFor(entryType).safeParse("-250.00").success,
        entryType,
      ).toBe(false);
      expect(amountSchemaFor(entryType).safeParse("250.00").success).toBe(true);
    }
    expect(amountSchemaFor("commitment_change").safeParse("250.00").success).toBe(
      true,
    );
    // Still a decimal string, signed or not.
    expect(amountSchemaFor("commitment_change").safeParse("-2.5e3").success).toBe(
      false,
    );
  });
});

const SUMMARY_CSV = [
  "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status,Comment,Comment 2",
  'Bramble Fund I,2023-01-10,Investment Fund,"$100,000.00","$50,000.44","$49,999.56","$12,345.67",Active,"First close",Follow-on likely',
  "Tanager Partners,2024-06-01,Direct,25000,37500,0,0,Active,,",
  ",,,,,,,,,",
].join("\n");

const LEDGER_CSV = [
  "Date,Investment,Amount,GBP,Exchange Rate,Comment",
  "Bramble Fund I,,,,,",
  '2023-04-01,Bramble Fund I,"-30,000.33",,,Call 1',
  '2024-04-01,Bramble Fund I,"-20,000.11",,,Call 2',
  '2025-06-30,Bramble Fund I,"12,345.67",,,Distribution',
  "2024-06-05,Tanager Partners,-25000,,,Single call",
  "2025-02-02,Tanager Partners,-12500,10000,1.25,Sterling call",
  "2025-03-03,Tanager Partners,-9000,-7200,,Missing rate",
  "not a date,Tanager Partners,-1,,,Bad date",
].join("\n");

describe("CSV", () => {
  it("reads quoted fields, doubled quotes and embedded newlines", () => {
    const rows = parseCsv('a,"b,c","say ""hi""" \n1,2,3');
    expect(rows[0]).toEqual(["a", "b,c", 'say "hi" ']);
    expect(rows[1]).toEqual(["1", "2", "3"]);
  });

  it("keys rows by header, case and space insensitively", () => {
    const rows = keyed(parseCsv("  Docs Signed ,Investment\n2024-01-01,Alpha"));
    expect(rows[0]).toEqual({ "docs signed": "2024-01-01", investment: "Alpha" });
  });
});

describe("values", () => {
  it("reads money with symbols, commas, minus signs and parentheses", () => {
    expect(parseMoney("$1,234.50")).toEqual({
      amount: "1234.50",
      negative: false,
      rounded: false,
    });
    expect(parseMoney("(1,234.50)")).toMatchObject({
      amount: "1234.50",
      negative: true,
    });
    expect(parseMoney("-1234.5")).toMatchObject({ amount: "1234.50" });
    expect(parseMoney("£900")).toMatchObject({ amount: "900.00" });
  });

  it("keeps the sheet's own precision rather than rounding to cents", () => {
    // A cell derived from a rate can carry more than two places, and dropping
    // them here changed the number before anything had looked at it.
    expect(parseMoney("1234.5678")).toMatchObject({
      amount: "1234.5678",
      rounded: false,
    });
    // Past the money column's scale it is rounded, and says so.
    expect(parseMoney("1.23456789")).toEqual({
      amount: "1.234568",
      negative: false,
      rounded: true,
    });
  });

  it("reads a blank cell as absent, never as zero", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("-")).toBeNull();
    expect(parseMoney("n/a")).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
  });

  it("rounds an over-precise rate rather than refusing the row", () => {
    expect(parseRate("1.25")).toEqual({ rate: "1.25", rounded: false });
    // Ten places kept, the eleventh rounded away, trailing zeros trimmed.
    expect(parseRate("1.123456789012")).toEqual({
      rate: "1.123456789",
      rounded: true,
    });
    expect(parseRate("1.99999999999")).toEqual({ rate: "2.00", rounded: true });
    expect(parseRate("0")).toBeNull();
    expect(parseRate("")).toBeNull();
  });

  it("reads ISO and US dates and refuses anything else", () => {
    expect(parseSheetDate("2024-03-04")).toBe("2024-03-04");
    expect(parseSheetDate("3/4/2024")).toBe("2024-03-04");
    expect(parseSheetDate("4 March 2024")).toBeNull();
  });

  it("adds and multiplies in integers, not in floats", () => {
    expect(addDecimals(["0.10", "0.20"])).toBe("0.30");
    expect(addDecimals(["30000.33", "20000.11"])).toBe("50000.44");
    expect(addDecimals([])).toBe("0.00");
    expect(addDecimals(["100.00", "-40.50"])).toBe("59.50");
    expect(addDecimals(["12345.67", "-12345.67"])).toBe("0.00");
    expect(multiplyDecimals("10000.00", "1.25")).toBe("12500.00");
    expect(multiplyDecimals("7200.00", "1.2734")).toBe("9168.48");
  });
});

describe("the sign and currency rule", () => {
  it("reads a negative Amount as a call and a positive one as a distribution", () => {
    const { drafts } = mapLedger(keyed(parseCsv(LEDGER_CSV)));
    const bramble = drafts.filter((d) => d.investmentName === "Bramble Fund I");
    expect(bramble.map((d) => d.entryType)).toEqual([
      "capital_call_paid",
      "capital_call_paid",
      "distribution",
    ]);
    expect(bramble[0]!.amount).toBe("30000.33");
    expect(bramble[0]!.currency).toBe("USD");
    expect(bramble[0]!.exchangeRate).toBeNull();
    expect(bramble[2]!.why).toBe("positive Amount → distribution");
  });

  it("takes the sign from the USD column even when the GBP cell is unsigned", () => {
    const { drafts } = mapLedger(keyed(parseCsv(LEDGER_CSV)));
    const sterling = drafts.find((d) => d.currency === "GBP")!;
    // The fixture's GBP cell is positive and its Amount cell is negative. The
    // sign belongs to the Amount column, so this is a call rather than a
    // distribution; reading it off the GBP column alone got this backwards.
    expect(sterling).toMatchObject({
      amount: "10000.00",
      currency: "GBP",
      exchangeRate: "1.25",
      entryType: "capital_call_paid",
      why: "negative Amount → capital_call_paid",
      usdAmount: "12500.00",
    });
  });

  it("checks a GBP row against the sheet's own USD figure", () => {
    const { drafts } = mapLedger(keyed(parseCsv(LEDGER_CSV)));
    const sterling = drafts.find((d) => d.currency === "GBP")!;
    // 10000 x 1.25 = 12500, and the sheet says 12500: inside tolerance.
    expect(sterling.rateCheck).toEqual({
      sheetUsd: "12500.00",
      convertedUsd: "12500.00",
      difference: "0.00",
      suspect: false,
    });
  });

  it("flags a rate that looks inverted", () => {
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      // 10000 GBP is about 12500 USD; a rate of 0.8 is the inverse and gives
      // 8000, which is nowhere near the sheet's own figure.
      "2025-02-02,Alpha,-12500,10000,0.8,Inverted",
    ].join("\n");
    const { drafts } = mapLedger(keyed(parseCsv(ledger)));
    expect(drafts[0]!.rateCheck).toMatchObject({
      sheetUsd: "12500.00",
      convertedUsd: "8000.00",
      difference: "4500.00",
      suspect: true,
    });
    expect(buildPreview("", ledger).suspectRates).toHaveLength(1);
  });

  it("skips what it cannot read, with a reason and a line", () => {
    const { skipped } = mapLedger(keyed(parseCsv(LEDGER_CSV)));
    expect(skipped.map((row) => row.reason)).toEqual([
      // A section header the owner typed into the sheet: no investment column.
      "No investment name",
      "GBP amount with no exchange rate",
      "Date is blank or unrecognised",
    ]);
    expect(skipped[0]!.line).toBe(2);
  });

  it("gives two identical rows two keys", () => {
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2025-01-05,Alpha,-1000,,,First call of the day",
      "2025-01-05,Alpha,-1000,,,Second call of the day",
      "2025-01-06,Alpha,-1000,,,Different day",
    ].join("\n");
    const { drafts } = mapLedger(keyed(parseCsv(ledger)));
    // Without the occurrence the second row shared the first's key, the
    // unique index dropped it, and the import reported two rows imported.
    expect(drafts.map((d) => d.occurrence)).toEqual([1, 2, 1]);
    expect(new Set(drafts.map((d) => d.importKey)).size).toBe(3);
    expect(drafts[0]!.importKey).toBe("ledger:alpha:2025-01-05:USD:-1000.00#1");
    expect(drafts[1]!.importKey).toBe("ledger:alpha:2025-01-05:USD:-1000.00#2");
  });

  it("gives a row a key that is stable across imports of the same file", () => {
    const first = mapLedger(keyed(parseCsv(LEDGER_CSV))).drafts;
    const second = mapLedger(keyed(parseCsv(LEDGER_CSV))).drafts;
    expect(first.map((d) => d.importKey)).toEqual(second.map((d) => d.importKey));
    expect(first[0]!.importKey).toBe(
      "ledger:bramble fund i:2023-04-01:USD:-30000.33#1",
    );
  });
});

describe("the preview", () => {
  it("maps Summary rows to investments and their commitment", () => {
    const preview = buildPreview(SUMMARY_CSV, LEDGER_CSV);
    expect(preview.summary.map((row) => row.name)).toEqual([
      "Bramble Fund I",
      "Tanager Partners",
    ]);
    expect(preview.summary[0]).toMatchObject({
      category: "Investment Fund",
      signedOn: "2023-01-10",
      status: "active",
      committed: "100000.00",
      notes: "First close — Follow-on likely",
    });
    expect(preview.skipped.some((row) => row.reason === "No investment name")).toBe(
      true,
    );
  });

  it("reconciles in USD, converting GBP rows rather than ignoring them", () => {
    const preview = buildPreview(SUMMARY_CSV, LEDGER_CSV);
    // Bramble's rows add to exactly what the Summary says, so it is silent.
    expect(
      preview.reconciliation.filter(
        (row) => row.investmentName === "Bramble Fund I",
      ),
    ).toEqual([]);
    // Tanager: 25,000 USD plus 10,000 GBP at 1.25 = 37,500 USD, which is what
    // the sheet says. Excluding GBP rows made an investment with any sterling
    // call disagree every single time, which is a warning nobody reads.
    expect(
      preview.reconciliation.filter(
        (row) => row.investmentName === "Tanager Partners",
      ),
    ).toEqual([]);
  });

  it("sums converted rows unrounded, the way the store does", () => {
    // Two 100.00 GBP calls at 1.00005 are 100.005 USD each. Rounding per row
    // first gives 200.02; the store converts, sums and rounds once, which
    // gives 200.01. The sheet agrees with the store, so the preview must say
    // nothing -- an acknowledgement demanded for a rounding artifact teaches
    // the operator to tick the box without reading it.
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,2024-01-01,Direct,1000,200.01,799.99,0,Active",
    ].join("\n");
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2024-02-01,Alpha,,-100,1.00005,",
      "2024-03-01,Alpha,,-100,1.00005,",
    ].join("\n");
    const preview = buildPreview(summary, ledger);
    expect(preview.ledger[0]!.usdAmount).toBe("100.005");
    expect(preview.reconciliation).toEqual([]);

    // And the per-row rate check still compares at cents, which is the
    // precision the sheet's own USD column carries.
    expect(multiplyDecimals("100.00", "1.00005")).toBe("100.01");
    expect(multiplyDecimals("100.00", "1.00005", 6)).toBe("100.005");
  });

  it("reports the difference with its sign and a label when the tabs disagree", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,2024-01-01,Direct,1000,900,100,50,Active",
    ].join("\n");
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2024-02-01,Alpha,-800,,,",
      "2024-09-01,Alpha,75,,,",
    ].join("\n");
    const { reconciliation } = buildPreview(summary, ledger);
    expect(reconciliation).toMatchObject([
      {
        investmentName: "Alpha",
        field: "sent",
        stated: "900.00",
        imported: "800.00",
        difference: "100.00",
      },
      {
        investmentName: "Alpha",
        field: "received",
        stated: "50.00",
        imported: "75.00",
        difference: "-25.00",
      },
    ]);
    expect(reconciliation[0]!.label).toContain("the sheet says sent 900.00 USD");
  });
});

describe("planning", () => {
  it("omits a blank optional field rather than sending an empty string", () => {
    // An empty Category cell used to be posted as "", which the route's schema
    // refuses, which made the whole Summary row -- and its Committed figure --
    // vanish with no error anyone saw.
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status,Comment",
      "Alpha,2024-01-01,,1000,0,1000,0,Active,",
    ].join("\n");
    const plan = planImport(buildPreview(summary, ""));
    expect(plan.invalid).toEqual([]);
    const [investment] = plan.operations;
    expect(investment).toMatchObject({
      kind: "investment",
      fields: { name: "Alpha", status: "active" },
    });
    expect(
      investment!.kind === "investment" ? investment!.fields : {},
    ).not.toHaveProperty("category");
    expect(plan.operations[1]).toMatchObject({
      kind: "entry",
      body: {
        entryType: "commitment",
        entryDate: "2024-01-01",
        amount: "1000.00",
      },
    });
  });

  it("refuses to invent a date for a commitment the sheet never dated", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,,Direct,1000,0,1000,0,Active",
    ].join("\n");
    const plan = planImport(buildPreview(summary, ""));
    // The investment is still importable; only its commitment entry is not,
    // because today's date would be a fabricated fact in a financial record.
    expect(plan.operations).toHaveLength(1);
    expect(plan.invalid).toHaveLength(1);
    expect(plan.invalid[0]!.reason).toContain("no Docs Signed date");
  });
});

describe("running", () => {
  function writer(overrides: Partial<ImportWriter> = {}): ImportWriter & {
    entries: [string, EntryBody][];
    created: InvestmentFields[];
  } {
    const entries: [string, EntryBody][] = [];
    const created: InvestmentFields[] = [];
    let next = 0;
    return {
      entries,
      created,
      existing: new Map(),
      createInvestment: async (fields) => {
        created.push(fields);
        next += 1;
        return { id: `investment-${next}`, created: true };
      },
      createEntry: async (investmentId, body) => {
        entries.push([investmentId, body]);
        return { created: true };
      },
      ...overrides,
    };
  }

  const SMALL_SUMMARY = [
    "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
    "Alpha,2024-01-01,Direct,1000,800,200,0,Active",
  ].join("\n");
  const SMALL_LEDGER = [
    "Date,Investment,Amount,GBP,Exchange Rate,Comment",
    "2024-02-01,Alpha,-800,,,",
    "2024-03-01,Beta,-500,,,",
  ].join("\n");

  it("creates each investment once and reports every row", async () => {
    const io = writer();
    const outcome = await runImport(
      planImport(buildPreview(SMALL_SUMMARY, SMALL_LEDGER)),
      io,
    );
    expect(outcome.investmentsCreated).toBe(2);
    expect(outcome.entriesCreated).toBe(3);
    expect(outcome.failed).toEqual([]);
    // Alpha's commitment and call go to the same investment; Beta, which only
    // the Ledger mentions, gets its own.
    expect(io.entries.map(([id]) => id)).toEqual([
      "investment-1",
      "investment-1",
      "investment-2",
    ]);
    expect(outcome.results).toHaveLength(4);
  });

  it("reuses an investment that already exists rather than creating it", async () => {
    // `existing` is built including archived investments. One the owner
    // archived is still the investment the sheet names, and creating a live
    // second one beside it is what the partial unique index cannot refuse.
    const io = writer({ existing: new Map([["alpha", "already-here"]]) });
    const outcome = await runImport(
      planImport(buildPreview(SMALL_SUMMARY, SMALL_LEDGER)),
      io,
    );
    expect(outcome.investmentsCreated).toBe(1);
    expect(outcome.investmentsExisting).toBe(1);
    expect(io.created.map((fields) => fields.name)).toEqual(["Beta"]);
    // Every Alpha row lands on the row that was already there.
    expect(io.entries.filter(([id]) => id === "already-here")).toHaveLength(2);
  });

  it("counts an investment once however many rows name it", async () => {
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2024-02-01,Alpha,-100,,,",
      "2024-03-01,Alpha,-100,,,",
      "2024-04-01,Alpha,-100,,,",
      "2024-05-01,Beta,-100,,,",
    ].join("\n");
    const io = writer({ existing: new Map([["alpha", "already-here"]]) });
    const outcome = await runImport(
      planImport(buildPreview(SMALL_SUMMARY, ledger)),
      io,
    );
    // Not four: the Summary row and three Ledger rows resolve one name.
    expect(outcome.investmentsExisting).toBe(1);
    expect(outcome.investmentsCreated).toBe(1);
  });

  it("counts a row the import key already covered as existing, not created", async () => {
    const io = writer({ createEntry: async () => ({ created: false }) });
    const outcome = await runImport(
      planImport(buildPreview(SMALL_SUMMARY, SMALL_LEDGER)),
      io,
    );
    expect(outcome.entriesCreated).toBe(0);
    expect(outcome.entriesAlreadyImported).toBe(3);
    expect(outcome.failed).toEqual([]);
  });

  it("records a failed row and keeps going", async () => {
    let call = 0;
    const io = writer({
      createEntry: async () => {
        call += 1;
        if (call === 1) throw new Error("Investment not found");
        return { created: true };
      },
    });
    const outcome = await runImport(
      planImport(buildPreview(SMALL_SUMMARY, SMALL_LEDGER)),
      io,
    );
    // The earlier version let the first rejection escape, which stopped the
    // import partway with nothing said and no way to tell what had landed.
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.reason).toBe("Investment not found");
    expect(outcome.entriesCreated).toBe(2);
  });

  it("carries a row that could not be planned into the outcome", async () => {
    const undated = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,,Direct,1000,0,1000,0,Active",
    ].join("\n");
    const outcome = await runImport(
      planImport(buildPreview(undated, "")),
      writer(),
    );
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.reason).toContain("no Docs Signed date");
    expect(outcome.investmentsCreated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The real sheet's accounting format, and the six failures a dry run against
// it found. Each is tested in isolation here; `REAL_SUMMARY_CSV` and
// `REAL_LEDGER_CSV` (below) reproduce all of them together, the way the real
// export does.
// ---------------------------------------------------------------------------

describe("the accounting-style money format", () => {
  it("reads a parenthesised negative even when a symbol sits outside the parens", () => {
    // The bug: `(...)` was only recognised anchored to the cell's own start,
    // so `$ (72,182)` -- the real sheet's own shape -- never matched, and
    // every capital call was read as a positive number.
    expect(parseMoney(" $ (72,182)")).toMatchObject({
      amount: "72182.00",
      negative: true,
    });
    expect(parseMoney("$ (1,234.56)")).toMatchObject({
      amount: "1234.56",
      negative: true,
    });
  });

  it("reads the accounting zero placeholder as zero, not as absent", () => {
    expect(parseMoney(" $ -   ")).toEqual({
      amount: "0.00",
      negative: false,
      rounded: false,
    });
    // A bare dash with no currency symbol is still "not stated": that is the
    // existing rule for a column the sheet left out of the row entirely.
    expect(parseMoney("-")).toBeNull();
  });

  it("reads a positive accounting amount with the symbol and digits spaced apart", () => {
    expect(parseMoney(" $ 100,000 ")).toEqual({
      amount: "100000.00",
      negative: false,
      rounded: false,
    });
  });
});

describe("date year plausibility", () => {
  it("refuses a date whose year is outside 1990-2100 rather than importing it", () => {
    // `2/6/0206` matches the `M/D/YYYY` shape exactly (day 2, month 6, year
    // "0206") and used to become the stored date `0206-02-06`.
    expect(parseSheetDate("2/6/0206")).toBeNull();
    expect(parseSheetDate("2024-02-06")).toBe("2024-02-06");
  });

  it("reports the bad year with its own reason, not the generic one", () => {
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2/6/0206,Alpha,-1000,,,Typo year",
    ].join("\n");
    const { skipped } = mapLedger(keyed(parseCsv(ledger)));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe(
      "Date year 0206 is outside a plausible range (1990-2100)",
    );
  });
});

describe("the sheet's own Total row", () => {
  it("is not imported as an investment", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,2024-01-01,Direct,1000,0,1000,0,Active",
      "Total,,,1000,0,1000,0,",
    ].join("\n");
    const { drafts, totalsRow } = mapSummary(keyed(parseCsv(summary)));
    expect(drafts.map((row) => row.name)).toEqual(["Alpha"]);
    expect(totalsRow).toMatchObject({ committed: "1000.00" });
  });

  it("matches the Investment cell case-insensitively and trimmed", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      " TOTAL ,,,1000,0,1000,0,",
    ].join("\n");
    const { drafts, totalsRow } = mapSummary(keyed(parseCsv(summary)));
    expect(drafts).toEqual([]);
    expect(totalsRow).not.toBeNull();
  });
});

describe("reconciliation tolerance", () => {
  it("stays silent within a dollar, the gap whole-dollar Summary figures vs cents in the Ledger leaves", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,2024-01-01,Direct,1000,1000,0,0,Active",
    ].join("\n");
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2024-02-01,Alpha,-999.50,,,",
    ].join("\n");
    expect(buildPreview(summary, ledger).reconciliation).toEqual([]);
  });

  it("still reports a gap of more than a dollar", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,2024-01-01,Direct,1000,1000,0,0,Active",
    ].join("\n");
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2024-02-01,Alpha,-998,,,",
    ].join("\n");
    expect(buildPreview(summary, ledger).reconciliation).toMatchObject([
      { investmentName: "Alpha", field: "sent", difference: "2.00" },
    ]);
  });
});

describe("dating a commitment from the Ledger when Docs Signed is blank", () => {
  it("dates the commitment at the earliest Ledger entry and marks it estimated", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,,Direct,1000,900,100,0,Active",
    ].join("\n");
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2024-05-01,Alpha,-400,,,",
      "2024-02-15,Alpha,-500,,,",
    ].join("\n");
    const plan = planImport(buildPreview(summary, ledger));
    expect(plan.invalid).toEqual([]);
    const commitment = plan.operations.find(
      (op) => op.kind === "entry" && op.body.entryType === "commitment",
    );
    expect(commitment).toMatchObject({
      kind: "entry",
      body: {
        entryDate: "2024-02-15",
        amount: "1000.00",
        note: "date estimated from first payment",
      },
    });
  });

  it("leaves the commitment for the owner when there is no Docs Signed date and no Ledger rows either", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,,Direct,1000,0,1000,0,Active",
    ].join("\n");
    const plan = planImport(buildPreview(summary, ""));
    expect(plan.operations).toHaveLength(1); // the investment, not the commitment
    expect(plan.invalid).toHaveLength(1);
    expect(plan.invalid[0]!.reason).toContain("no Ledger rows to estimate");
    // Never today's date, whatever today is.
    expect(
      plan.operations.some(
        (op) => op.kind === "entry" && op.body.entryType === "commitment",
      ),
    ).toBe(false);
  });
});

describe("investments named in only one tab", () => {
  it("lists a Ledger investment the Summary never names under its own heading", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,2024-01-01,Direct,1000,1000,0,0,Active",
    ].join("\n");
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2024-02-01,Alpha,-1000,,,",
      "2024-03-01,Beta,-500,,,",
    ].join("\n");
    const preview = buildPreview(summary, ledger);
    expect(preview.ledgerOnlyInvestments).toEqual(["Beta"]);
    // Still gets created: `runImport` makes an investment for any Ledger row
    // whose name resolves to nothing, with no commitment since the Summary is
    // what states one.
    const outcome = planImport(preview);
    expect(
      outcome.operations.some(
        (op) => op.kind === "entry" && op.investmentName === "Beta",
      ),
    ).toBe(true);
  });

  it("lists a Summary row with a Sent amount and no Ledger rows under its own heading", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,2024-01-01,Direct,1000,1000,0,0,Active",
    ].join("\n");
    const preview = buildPreview(summary, "");
    expect(preview.sentWithNoLedgerRows).toEqual([
      { investmentName: "Alpha", line: 2, amount: "1000.00" },
    ]);
  });
});

describe("the real sheet's format, reproduced end to end", () => {
  it("reconciles the whole sheet the way the operator will see it", () => {
    const preview = buildPreview(REAL_SUMMARY_CSV, REAL_LEDGER_CSV);

    // Four investments, not five: the sheet's own Total row is used, not
    // imported.
    expect(preview.summary.map((row) => row.name)).toEqual([
      "Bramble Fund I",
      "Tanager Direct",
      "Angel Startup",
      "Volo Earth",
    ]);

    // Bramble's Docs Signed is blank; its commitment is dated at its earliest
    // capital call and marked estimated.
    expect(preview.summary[0]).toMatchObject({
      committed: "100000.00",
      statedSent: "72182.00",
      statedReceived: "12345.67",
      signedOn: null,
    });

    // "Direct " (trailing space) and the accounting zero placeholder both
    // read cleanly.
    expect(preview.summary[1]).toMatchObject({
      category: "Direct",
      statedReceived: "0.00",
    });

    // The typo'd year is reported, not imported as a fourth VoLo Earth call.
    expect(preview.skipped).toContainEqual(
      expect.objectContaining({
        reason: "Date year 0206 is outside a plausible range (1990-2100)",
      }),
    );

    // Case differs between the tabs ("Volo Earth" / "VoLo Earth") and two
    // identical calls land on the same day; both still reconcile exactly.
    // Tanager (off by $1.50) is the one investment that does not.
    expect(preview.reconciliation).toMatchObject([
      { investmentName: "Tanager Direct", field: "sent", difference: "1.50" },
      { investmentName: "Angel Startup", field: "sent", difference: "10000.00" },
    ]);

    // Meridian Notes is only in the Ledger; Angel Startup's Sent has no
    // Ledger rows at all.
    expect(preview.ledgerOnlyInvestments).toEqual(["Meridian Notes"]);
    expect(preview.sentWithNoLedgerRows).toEqual([
      { investmentName: "Angel Startup", line: 4, amount: "10000.00" },
    ]);

    // The sheet's own Total row checks out against both the Summary's own
    // rows and the Ledger's totals.
    expect(preview.topLineCheck).toMatchObject({
      committed: { totalRow: "185000.00", summarySum: "185000.00" },
      sent: { totalRow: "157182.00", summarySum: "157182.00" },
      received: { totalRow: "12345.67", summarySum: "12345.67" },
    });

    // A GBP row with no USD column reads by its own sign and converts at its
    // own rate: -£15,200.00 at 1.3 is a $19,760.00 capital call.
    const sterling = preview.ledger.find(
      (row) => row.investmentName === "Meridian Notes" && row.currency === "GBP",
    );
    expect(sterling).toMatchObject({
      entryType: "capital_call_paid",
      usdAmount: "19760.00",
    });

    const plan = planImport(preview);
    // Angel Startup's commitment is the one row genuinely left for the owner:
    // no Docs Signed date and no Ledger rows to estimate one from.
    expect(plan.invalid).toHaveLength(1);
    expect(plan.invalid[0]!.label).toContain("Angel Startup");
    expect(plan.invalid[0]!.reason).toContain("no Ledger rows to estimate");

    const commitments = plan.operations.filter(
      (op) => op.kind === "entry" && op.body.entryType === "commitment",
    );
    expect(commitments).toHaveLength(3); // not Angel Startup
    const bramble = commitments.find(
      (op) => op.kind === "entry" && op.investmentName === "Bramble Fund I",
    );
    expect(bramble).toMatchObject({
      body: {
        entryDate: "2021-03-01", // Bramble's earliest capital call
        note: "date estimated from first payment",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Independent review of #309 (ADM-3b) found five more issues. 1-3 below get a
// test each, as asked; 4 (the store's `findOrCreateInvestment`) is addressed
// in scripts/investments-import.mjs (see its own test), and 5
// (topLineCheck's own ledgerDifference) gets a test here too.
// ---------------------------------------------------------------------------

describe("a zero USD cell states no direction (review #1)", () => {
  it("reads a capital call from GBP when Amount is the zero placeholder, not a distribution", () => {
    // Amount blank entirely (no USD column at all) already worked; the bug
    // was the accounting zero placeholder `$ -`, which is *present* and
    // parses to a real (zero) value, so it used to win as the sign source
    // and every such row came out positive -- a distribution -- regardless
    // of the GBP call's own sign.
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      '2024-02-01,Alpha,"$ -   ","(10,000)",1.3,Sterling call',
    ].join("\n");
    const { drafts } = mapLedger(keyed(parseCsv(ledger)));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      entryType: "capital_call_paid",
      currency: "GBP",
      amount: "10000.00",
      why: "negative GBP → capital_call_paid",
    });
  });

  it("still reads the sign from a genuinely stated, non-zero USD cell", () => {
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      '2024-02-01,Alpha,150,"(10,000)",1.3,Disagreeing signs',
    ].join("\n");
    const { drafts } = mapLedger(keyed(parseCsv(ledger)));
    expect(drafts[0]).toMatchObject({ entryType: "distribution" });
  });

  it("does not check a GBP row's rate against the zero placeholder", () => {
    // "0.00" is not a stated USD figure to check the conversion against; it
    // used to flag as suspect every single time, no matter how close the
    // rate actually was.
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      '2024-02-01,Alpha,"$ -   ","(10,000)",1.3,Sterling call',
    ].join("\n");
    const { drafts } = mapLedger(keyed(parseCsv(ledger)));
    expect(drafts[0]!.rateCheck).toBeNull();
  });
});

describe("parseMoney refuses an ambiguous number rather than guessing (review #2)", () => {
  it("refuses a European-style decimal comma instead of dropping it", () => {
    // Stripped blindly, `1.234,56` became `1.23456`: a different number.
    expect(parseMoney("1.234,56")).toBeNull();
  });

  it("refuses a space used as a thousands separator", () => {
    expect(parseMoney("1 000,50")).toBeNull();
  });

  it("refuses a malformed comma grouping", () => {
    expect(parseMoney("1,2,3")).toBeNull();
  });

  it("still accepts a plain decimal and a properly grouped one", () => {
    expect(parseMoney("1234.56")).toMatchObject({ amount: "1234.56" });
    expect(parseMoney("1,234,567.89")).toMatchObject({ amount: "1234567.89" });
  });

  it("reports an unreadable Committed cell rather than silently treating it as not stated", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      'Alpha,2024-01-01,Direct,"1.234,56",0,1000,0,Active',
    ].join("\n");
    const { drafts, skipped } = mapSummary(keyed(parseCsv(summary)));
    expect(drafts[0]!.committed).toBeNull();
    expect(skipped).toContainEqual(
      expect.objectContaining({ reason: "Committed value is unreadable" }),
    );
  });
});

describe("topLineCheck also differences the Ledger's own totals (review #5)", () => {
  it("does not report 0.00 when the Ledger is thousands off the Total row", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,2024-01-01,Direct,1000,1000,0,0,Active",
      "Total,,,1000,1000,0,0,",
    ].join("\n");
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      // The Ledger's own capital calls add to only 1: nowhere near the
      // Total row's stated 1000, even though the Summary's own rows agree
      // with it exactly.
      "2024-02-01,Alpha,-1,,,",
    ].join("\n");
    const { topLineCheck } = buildPreview(summary, ledger);
    expect(topLineCheck!.sent).toMatchObject({
      totalRow: "1000.00",
      summarySum: "1000.00",
      difference: "0.00",
      ledgerSum: "1.00",
      ledgerDifference: "999.00",
    });
  });
});
