// The spreadsheet import's rules: the sign and currency reading, the exact
// decimal arithmetic, and the reconciliation that refuses to trust either
// tab over the other.
//
// Synthetic fixtures only. Every name, amount and date below is invented.

import { describe, expect, it } from "vitest";

import {
  addDecimals,
  buildPreview,
  keyed,
  mapLedger,
  parseCsv,
  parseMoney,
  parseSheetDate,
} from "./investment-import";

const SUMMARY_CSV = [
  "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status,Comment,Comment 2",
  'Bramble Fund I,2023-01-10,Investment Fund,"$100,000.00","$50,000.44","$49,999.56","$12,345.67",Active,"First close",Follow-on likely',
  "Tanager Partners,2024-06-01,Direct,25000,25000,0,0,Active,,",
  ",,,,,,,,,",
].join("\n");

const LEDGER_CSV = [
  "Date,Investment,Amount,GBP,Exchange Rate,Comment",
  'Bramble Fund I,,,,,',
  '2023-04-01,Bramble Fund I,"-30,000.33",,,Call 1',
  '2024-04-01,Bramble Fund I,"-20,000.11",,,Call 2',
  '2025-06-30,Bramble Fund I,"12,345.67",,,Distribution',
  "2024-06-05,Tanager Partners,-25000,,,Single call",
  "2025-02-02,Tanager Partners,-12500,-10000,1.25,Sterling call",
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
    expect(parseMoney("$1,234.50")).toEqual({ amount: "1234.50", negative: false });
    expect(parseMoney("(1,234.50)")).toEqual({ amount: "1234.50", negative: true });
    expect(parseMoney("-1234.5")).toEqual({ amount: "1234.50", negative: true });
    expect(parseMoney("£900")).toEqual({ amount: "900.00", negative: false });
  });

  it("reads a blank cell as absent, never as zero", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("-")).toBeNull();
    expect(parseMoney("n/a")).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
  });

  it("reads ISO and US dates and refuses anything else", () => {
    expect(parseSheetDate("2024-03-04")).toBe("2024-03-04");
    expect(parseSheetDate("3/4/2024")).toBe("2024-03-04");
    expect(parseSheetDate("4 March 2024")).toBeNull();
  });

  it("adds in cents, not in floats", () => {
    expect(addDecimals(["0.10", "0.20"])).toBe("0.30");
    expect(addDecimals(["30000.33", "20000.11"])).toBe("50000.44");
    expect(addDecimals([])).toBe("0.00");
    expect(addDecimals(["100.00", "-40.50"])).toBe("59.50");
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
    // The rule that produced the type is carried to the preview, so the
    // operator flips a row knowing what was read.
    expect(bramble[2]!.why).toBe("positive Amount → distribution");
  });

  it("reads a GBP column as the amount, its currency and its rate", () => {
    const { drafts } = mapLedger(keyed(parseCsv(LEDGER_CSV)));
    const sterling = drafts.find((d) => d.currency === "GBP");
    expect(sterling).toMatchObject({
      amount: "10000.00",
      currency: "GBP",
      exchangeRate: "1.25",
      entryType: "capital_call_paid",
      why: "negative GBP → capital_call_paid",
    });
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

  it("gives a row a key that is stable across imports of the same file", () => {
    const first = mapLedger(keyed(parseCsv(LEDGER_CSV))).drafts;
    const second = mapLedger(keyed(parseCsv(LEDGER_CSV))).drafts;
    expect(first.map((d) => d.importKey)).toEqual(second.map((d) => d.importKey));
    expect(new Set(first.map((d) => d.importKey)).size).toBe(first.length);
    expect(first[0]!.importKey).toBe(
      "ledger:bramble fund i:2023-04-01:USD:-30000.33",
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

  it("flags a difference instead of trusting either tab", () => {
    const preview = buildPreview(SUMMARY_CSV, LEDGER_CSV);
    // Bramble's ledger adds to exactly what the Summary says, so it is silent.
    expect(
      preview.reconciliation.filter((row) => row.investmentName === "Bramble Fund I"),
    ).toEqual([]);
    // Tanager's Summary says 25,000 sent; the readable USD ledger rows add to
    // 25,000 as well, but the GBP call is not converted with a rate the
    // Summary never stated, so nothing is silently reconciled either way.
    const tanager = preview.reconciliation.filter(
      (row) => row.investmentName === "Tanager Partners",
    );
    expect(tanager).toEqual([]);
  });

  it("reports the difference with its sign when the tabs disagree", () => {
    const summary = [
      "Investment,Docs Signed,Category,Committed,Sent,Outstanding Commitment,Received,Status",
      "Alpha,2024-01-01,Direct,1000,900,100,50,Active",
    ].join("\n");
    const ledger = [
      "Date,Investment,Amount,GBP,Exchange Rate,Comment",
      "2024-02-01,Alpha,-800,,,",
      "2024-09-01,Alpha,75,,,",
    ].join("\n");
    expect(buildPreview(summary, ledger).reconciliation).toEqual([
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
  });
});
