import { describe, expect, test } from "vitest";

import {
  archiveDate,
  label,
  shortDate,
  signedTableMoney,
  tableAccountingMoney,
  tableDateTime,
  tableDecimal,
  tableInteger,
  tableMoney,
  tablePercent,
} from "@/lib/kith/format";

describe("table display formatting", () => {
  test("uses human labels for stored codes", () => {
    expect(label("credit_line")).toBe("Credit Line");
    expect(label("brokerage")).toBe("Brokerage");
  });

  test("formats dates in the app table convention", () => {
    expect(archiveDate("2026-09-26")).toBe("9-26-2026");
    expect(shortDate(Date.parse("2026-09-26T02:05:00Z"))).toBe("9-26-2026");
    expect(tableDateTime(Date.parse("2026-09-26T14:05:00Z"))).toBe(
      "9-26-2026 2:05 PM",
    );
  });

  test("adds separators without changing exact decimal text", () => {
    expect(tableInteger(1234567)).toBe("1,234,567");
    expect(tableDecimal("12345678901234567890.05")).toBe(
      "12,345,678,901,234,567,890.05",
    );
  });

  test("formats exact USD values as accounting money", () => {
    expect(tableAccountingMoney("100000.22")).toBe("$ 100,000.22");
    expect(tableAccountingMoney("-12.5")).toBe("($ 12.50)");
  });

  test("signedTableMoney negates a liability balance so it reads as owed", () => {
    expect(signedTableMoney(482.13, "USD", true)).toBe("$ -482.13");
    // A depository account's balance is unaffected.
    expect(signedTableMoney(482.13, "USD", false)).toBe(
      tableMoney(482.13, "USD"),
    );
    // Negating twice (a liability whose stored value is already negative --
    // Plaid reports some credit refund states this way) reads as positive.
    expect(signedTableMoney(-50, "USD", true)).toBe(tableMoney(50, "USD"));
  });

  test("tablePercent rounds a ratio and never divides by zero", () => {
    expect(tablePercent(250, 1000)).toBe("25%");
    expect(tablePercent(482.13, 5000)).toBe("10%");
    expect(tablePercent(0, 0)).toBe("");
  });
});
