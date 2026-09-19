// The row-interaction behaviours that are ours rather than TanStack Table's:
// whether a click on the row body should be ignored because it landed on an
// interactive child, what a click that isn't ignored should do, and the
// default width a "never wrap" column gets.
//
// This app has no component test environment (vitest runs in `node`), so the
// rule `lib/kith/table-filters.ts` states is the rule here too: the logic
// lives in pure functions, duck-typed rather than `instanceof Element` where
// that matters, and those functions are what's tested.

import type { ColumnDef } from "@tanstack/react-table";

/** A click on one of these -- or on anything the row markup tags with
 * `data-row-click-ignore` (the column resize handle) -- must not also
 * trigger the row's own click or expand behaviour. */
export const ROW_CLICK_IGNORE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [data-row-click-ignore]';

type ClosestLike = { closest(selector: string): unknown };

function hasClosest(value: unknown): value is ClosestLike {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { closest?: unknown }).closest === "function"
  );
}

/**
 * True when `target` is, or is nested inside, an element the row click
 * ignores: a link, a button, a form control, the kebab trigger, or the
 * column resize handle.
 *
 * Duck-typed on `closest` instead of `target instanceof Element` so this can
 * be unit tested with a plain object instead of a real DOM node.
 */
export function isInteractiveTarget(target: unknown): boolean {
  return hasClosest(target) && target.closest(ROW_CLICK_IGNORE_SELECTOR) !== null;
}

/** True when the browser selection is non-empty text, meaning the click that
 * ended a text-selection drag should not also fire the row click. */
export function hasActiveSelection(selection: { toString(): string } | null): boolean {
  return selection !== null && selection.toString() !== "";
}

export type RowClickIntent = "expand" | "activate" | "none";

/**
 * What a click on the row body (one `isInteractiveTarget` didn't already
 * rule out) should do.
 *
 * A row that can expand always toggles, whether or not the table also has
 * `onRowClick` -- Institutions' account rows and Investments' entry rows sit
 * under exactly this kind of parent, and a parent that opened an edit panel
 * instead of expanding on click would leave no way to reach its children by
 * clicking the row at all.
 */
export function resolveRowClickIntent(options: {
  canExpand: boolean;
  hasRowClick: boolean;
}): RowClickIntent {
  if (options.canExpand) return "expand";
  if (options.hasRowClick) return "activate";
  return "none";
}

const DEFAULT_NOWRAP_SIZE = 110;
const DEFAULT_NOWRAP_MIN_SIZE = 70;

/**
 * Gives every `meta: { nowrap: true }` column a sensible width when its
 * table didn't already size it, so a date like "2026-08-24" gets enough
 * room without every column definition having to spell out a `size`.
 */
export function applyNowrapSizing<T>(
  columns: readonly ColumnDef<T, unknown>[],
): ColumnDef<T, unknown>[] {
  return columns.map((column) =>
    column.meta?.nowrap === true && column.size === undefined
      ? { ...column, size: DEFAULT_NOWRAP_SIZE, minSize: DEFAULT_NOWRAP_MIN_SIZE }
      : column,
  );
}
