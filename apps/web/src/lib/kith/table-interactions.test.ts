import { describe, expect, test } from "vitest";

import {
  applyNowrapSizing,
  hasActiveSelection,
  isInteractiveTarget,
  resolveRowClickIntent,
  ROW_CLICK_IGNORE_SELECTOR,
} from "@/lib/kith/table-interactions";

/** A fake DOM node: `closest` returns itself when `selector` matches the tag
 * it stands in for, and null otherwise -- enough to exercise the real
 * selector without a DOM. */
function fakeTarget(tag: string | null): { closest(selector: string): unknown } {
  return {
    closest(selector: string) {
      if (tag === null) return null;
      const tags = selector.split(",").map((part) => part.trim());
      return tags.some(
        (part) => part === tag || (tag === "ignore" && part === "[data-row-click-ignore]"),
      )
        ? {}
        : null;
    },
  };
}

describe("isInteractiveTarget", () => {
  test("ignores clicks on the row body itself", () => {
    expect(isInteractiveTarget(fakeTarget(null))).toBe(false);
    expect(isInteractiveTarget(fakeTarget("td"))).toBe(false);
  });

  test("ignores clicks on interactive children: links, buttons, form controls", () => {
    expect(isInteractiveTarget(fakeTarget("a"))).toBe(true);
    expect(isInteractiveTarget(fakeTarget("button"))).toBe(true);
    expect(isInteractiveTarget(fakeTarget("input"))).toBe(true);
    expect(isInteractiveTarget(fakeTarget('[role="button"]'))).toBe(true);
  });

  test("the resize handle opts out via data-row-click-ignore, not sort or click", () => {
    expect(ROW_CLICK_IGNORE_SELECTOR).toContain("[data-row-click-ignore]");
    expect(isInteractiveTarget(fakeTarget("ignore"))).toBe(true);
  });

  test("a plain value with no closest() is never interactive", () => {
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget(undefined)).toBe(false);
    expect(isInteractiveTarget("a string")).toBe(false);
    expect(isInteractiveTarget(42)).toBe(false);
  });
});

describe("hasActiveSelection", () => {
  test("no selection, or an empty one, is not an active selection", () => {
    expect(hasActiveSelection(null)).toBe(false);
    expect(hasActiveSelection({ toString: () => "" })).toBe(false);
  });

  test("selected text is an active selection", () => {
    expect(hasActiveSelection({ toString: () => "some text" })).toBe(true);
  });
});

describe("resolveRowClickIntent", () => {
  test("a group row always expands, even with onRowClick set", () => {
    expect(resolveRowClickIntent({ canExpand: true, hasRowClick: true })).toBe("expand");
    expect(resolveRowClickIntent({ canExpand: true, hasRowClick: false })).toBe("expand");
  });

  test("a leaf row activates only when the table has onRowClick", () => {
    expect(resolveRowClickIntent({ canExpand: false, hasRowClick: true })).toBe("activate");
    expect(resolveRowClickIntent({ canExpand: false, hasRowClick: false })).toBe("none");
  });
});

describe("applyNowrapSizing", () => {
  test("gives an unsized nowrap column a default size and min size", () => {
    const [column] = applyNowrapSizing([{ id: "createdAt", meta: { nowrap: true } }]);
    expect(column?.size).toBe(110);
    expect(column?.minSize).toBe(70);
  });

  test("leaves a column that already has a size alone", () => {
    const [column] = applyNowrapSizing([{ id: "createdAt", meta: { nowrap: true }, size: 200 }]);
    expect(column?.size).toBe(200);
    expect(column?.minSize).toBeUndefined();
  });

  test("leaves a non-nowrap column untouched", () => {
    const [column] = applyNowrapSizing([{ id: "name" }]);
    expect(column?.size).toBeUndefined();
  });
});
