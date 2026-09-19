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

// Row-selection decision logic (ADM-8a's `selectable` prop on `DataTable`),
// pure for the same reason as everything above: no DOM test environment, so
// what would otherwise be exercised by clicking checkboxes is exercised as
// plain functions over arrays and sets instead.

/** Toggles one id in a selection, without mutating the set passed in. */
export function toggleSelection(
  selected: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * A shift-click range select: every id between `anchorIndex` and
 * `clickedIndex` (inclusive, whichever order they fall in) is added to the
 * selection. Matches the usual file-manager convention -- a range is always
 * added, never toggled off, so a second shift-click over an overlapping range
 * cannot un-select rows the first one selected.
 */
export function applyRangeSelection(
  ids: readonly string[],
  selected: ReadonlySet<string>,
  anchorIndex: number,
  clickedIndex: number,
): Set<string> {
  const start = Math.max(0, Math.min(anchorIndex, clickedIndex));
  const end = Math.min(ids.length - 1, Math.max(anchorIndex, clickedIndex));
  const next = new Set(selected);
  for (let i = start; i <= end; i += 1) next.add(ids[i]!);
  return next;
}

/**
 * The header checkbox's own click: the usual tri-state toggle. Every id in
 * the current filtered view is already selected -> clear; anything else
 * (none selected, or some) -> select every id in view. A header checkbox
 * showing "indeterminate" therefore always selects the rest on click rather
 * than clearing, which is the behaviour people expect from it.
 */
export function toggleSelectAll(
  ids: readonly string[],
  selected: ReadonlySet<string>,
): Set<string> {
  if (ids.length > 0 && ids.every((id) => selected.has(id))) return new Set();
  return new Set(ids);
}

export type SelectionHeaderState = "all" | "some" | "none";

/** What the header checkbox should show: checked, indeterminate, or empty. */
export function selectionHeaderState(
  ids: readonly string[],
  selected: ReadonlySet<string>,
): SelectionHeaderState {
  if (ids.length === 0) return "none";
  const count = ids.filter((id) => selected.has(id)).length;
  if (count === 0) return "none";
  return count === ids.length ? "all" : "some";
}

/**
 * Drops any selected id that is no longer in view -- "selection ... cleared
 * when the filtered set no longer contains a row" -- so a row hidden by a
 * new search term or chip filter cannot be bulk-acted-on invisibly.
 *
 * Returns the identical set instance when nothing needed pruning, so a caller
 * (a `useEffect` keyed on this) can skip the state update, and therefore the
 * re-render, on every filter keystroke that doesn't actually affect the
 * selection.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  visibleIds: ReadonlySet<string>,
): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (visibleIds.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : (selected as Set<string>);
}

/** Whether a keydown on a row should toggle its checkbox rather than fall
 * through to the row's own Enter/expand/activate behaviour: Space, and only
 * when the table is `selectable`. Enter is left for activation even on a
 * selectable table, the same split a checkbox list and a link list agree on
 * everywhere else. */
export function shouldToggleSelectionOnKey(
  key: string,
  selectable: boolean,
): boolean {
  return selectable && key === " ";
}
