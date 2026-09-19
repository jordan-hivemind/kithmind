// The spreadsheet import's rules: the sign and currency reading, the exact
// decimal arithmetic, the reconciliation that refuses to trust either tab over
// the other, and the run that reports every row.
//
// Synthetic fixtures only. Every name, amount and date below is invented.

import { describe, expect, it } from "vitest";

import {
  addDecimals,
  buildPreview,
  type EntryBody,
  type ImportWriter,
  type InvestmentFields,
  keyed,
  mapLedger,
  multiplyDecimals,
  parseCsv,
  parseMoney,
  parseRate,
  parseSheetDate,
  planImport,
  runImport,
} from "./investment-import";
import { amountSchemaFor } from "./investment-schemas";

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
