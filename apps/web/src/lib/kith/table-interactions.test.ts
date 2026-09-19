import { describe, expect, test } from "vitest";

import {
  applyNowrapSizing,
  applyRangeSelection,
  hasActiveSelection,
  isInteractiveTarget,
  pruneSelection,
  resolveRowClickIntent,
  ROW_CLICK_IGNORE_SELECTOR,
  selectionHeaderState,
  shouldToggleSelectionOnKey,
  toggleSelectAll,
  toggleSelection,
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

describe("toggleSelection", () => {
  test("adds an unselected id and removes a selected one", () => {
    expect([...toggleSelection(new Set(), "a")]).toEqual(["a"]);
    expect([...toggleSelection(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });

  test("never mutates the set passed in", () => {
    const original = new Set(["a"]);
    toggleSelection(original, "b");
    expect([...original]).toEqual(["a"]);
  });
});

describe("applyRangeSelection", () => {
  const ids = ["a", "b", "c", "d", "e"];

  test("selects every id between the anchor and the click, inclusive", () => {
    expect([...applyRangeSelection(ids, new Set(), 1, 3)].sort()).toEqual(["b", "c", "d"]);
  });

  test("works in either direction", () => {
    expect([...applyRangeSelection(ids, new Set(), 3, 1)].sort()).toEqual(["b", "c", "d"]);
  });

  test("adds to the existing selection rather than replacing it", () => {
    const result = applyRangeSelection(ids, new Set(["e"]), 0, 1);
    expect([...result].sort()).toEqual(["a", "b", "e"]);
  });

  test("a second overlapping shift-click never removes what the first selected", () => {
    const first = applyRangeSelection(ids, new Set(), 0, 2);
    const second = applyRangeSelection(ids, first, 1, 3);
    expect([...second].sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("clamps to the array bounds", () => {
    expect([...applyRangeSelection(ids, new Set(), -5, 1)].sort()).toEqual(["a", "b"]);
    expect([...applyRangeSelection(ids, new Set(), 3, 50)].sort()).toEqual(["d", "e"]);
  });
});

describe("toggleSelectAll", () => {
  const ids = ["a", "b", "c"];

  test("selects every id when none or some are selected", () => {
    expect([...toggleSelectAll(ids, new Set())].sort()).toEqual(["a", "b", "c"]);
    expect([...toggleSelectAll(ids, new Set(["b"]))].sort()).toEqual(["a", "b", "c"]);
  });

  test("clears when every id is already selected", () => {
    expect([...toggleSelectAll(ids, new Set(["a", "b", "c"]))]).toEqual([]);
  });

  test("an empty view selects nothing", () => {
    expect([...toggleSelectAll([], new Set())]).toEqual([]);
  });
});

describe("selectionHeaderState", () => {
  const ids = ["a", "b", "c"];

  test("none, some and all", () => {
    expect(selectionHeaderState(ids, new Set())).toBe("none");
    expect(selectionHeaderState(ids, new Set(["a"]))).toBe("some");
    expect(selectionHeaderState(ids, new Set(["a", "b", "c"]))).toBe("all");
  });

  test("an empty view is never 'all', even with a stale selection", () => {
    expect(selectionHeaderState([], new Set(["a"]))).toBe("none");
  });
});

describe("pruneSelection", () => {
  test("drops ids no longer visible", () => {
    const pruned = pruneSelection(new Set(["a", "b"]), new Set(["a"]));
    expect([...pruned]).toEqual(["a"]);
  });

  test("returns the same instance when nothing changed", () => {
    const selected = new Set(["a"]);
    expect(pruneSelection(selected, new Set(["a", "b"]))).toBe(selected);
  });
});

describe("shouldToggleSelectionOnKey", () => {
  test("space toggles selection only on a selectable table", () => {
    expect(shouldToggleSelectionOnKey(" ", true)).toBe(true);
    expect(shouldToggleSelectionOnKey(" ", false)).toBe(false);
  });

  test("enter never toggles selection, even when selectable", () => {
    expect(shouldToggleSelectionOnKey("Enter", true)).toBe(false);
  });
});
