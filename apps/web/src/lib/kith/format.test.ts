import { describe, expect, test } from "vitest";

import {
  archiveDate,
  label,
  shortDate,
  tableDateTime,
  tableDecimal,
  tableInteger,
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
});
