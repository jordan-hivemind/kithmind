// The two table behaviours that are ours rather than TanStack Table's.
//
// This app has no component test environment (vitest runs in `node`), so the
// rule `lib/kith/table-filters.ts` states is the rule here: the logic that
// decides what the owner sees lives in pure functions, and those are tested.

import { describe, expect, test } from "vitest";

import {
  columnChipOptions,
  matchesFilter,
  rowMatchesSearch,
  searchableText,
} from "@/lib/kith/table-filters";

const ROWS = [
  { name: "Provider folder", connector: "fs", area: "finance", items: 12 },
  { name: "Broker statements", connector: "imap", area: "finance", items: 4 },
  { name: "Vehicle records", connector: "fs", area: null, items: 0 },
];

describe("search as you type", () => {
  test("no search matches every row", () => {
    expect(rowMatchesSearch(Object.values(ROWS[0]!), "")).toBe(true);
    expect(rowMatchesSearch(Object.values(ROWS[0]!), "   ")).toBe(true);
  });

  test("a term matches any cell, case-insensitively", () => {
    expect(rowMatchesSearch(Object.values(ROWS[0]!), "PROVIDER")).toBe(true);
    expect(rowMatchesSearch(Object.values(ROWS[1]!), "imap")).toBe(true);
    // Numbers are searchable too; the owner types "12" as readily as a word.
    expect(rowMatchesSearch(Object.values(ROWS[0]!), "12")).toBe(true);
  });

  test("a substring matches, not only a prefix", () => {
    expect(rowMatchesSearch(Object.values(ROWS[1]!), "statem")).toBe(true);
    expect(rowMatchesSearch(Object.values(ROWS[1]!), "oker")).toBe(true);
  });

  test("every term must match, so typing more narrows", () => {
    expect(rowMatchesSearch(Object.values(ROWS[0]!), "provider finance")).toBe(true);
    // Order does not matter.
    expect(rowMatchesSearch(Object.values(ROWS[0]!), "finance provider")).toBe(true);
    // But a term that is nowhere in the row excludes it.
    expect(rowMatchesSearch(Object.values(ROWS[0]!), "provider vehicle")).toBe(false);
  });

  test("a null cell contributes nothing rather than the word null", () => {
    expect(searchableText(null)).toBe("");
    expect(rowMatchesSearch(Object.values(ROWS[2]!), "null")).toBe(false);
  });

  test("nested values are searchable", () => {
    expect(searchableText({ path: "/Home/Statements" })).toBe("/home/statements");
    expect(searchableText(["a", { b: "C" }])).toBe("a c");
  });
});

describe("filter chips", () => {
  test("one chip per distinct value, commonest first", () => {
    expect(columnChipOptions(ROWS.map((row) => row.connector))).toEqual([
      { value: "fs", count: 2 },
      { value: "imap", count: 1 },
    ]);
  });

  test("ties break alphabetically, so the order is stable", () => {
    expect(columnChipOptions(["b", "a", "c"])).toEqual([
      { value: "a", count: 1 },
      { value: "b", count: 1 },
      { value: "c", count: 1 },
    ]);
  });

  test("empty cells get no chip", () => {
    expect(columnChipOptions(ROWS.map((row) => row.area))).toEqual([
      { value: "finance", count: 2 },
    ]);
    expect(columnChipOptions([undefined, "", null])).toEqual([]);
  });

  test("nothing unchecked shows everything; an unchecked value hides its rows", () => {
    expect(matchesFilter("fs", [])).toBe(true);
    expect(matchesFilter("fs", ["imap"])).toBe(true);
    expect(matchesFilter("imap", ["imap"])).toBe(false);
    // An empty cell has no option to uncheck, so it always shows.
    expect(matchesFilter(null, ["imap"])).toBe(true);
  });
});
