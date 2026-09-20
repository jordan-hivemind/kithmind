"use client";

// The one table every admin screen uses.
//
// The owner's decision, in one component: compact rows (36px), sortable
// headers, a Filters dropdown with a checklist per column, a search box that filters as you type,
// optional grouped and expandable rows, drag-resizable columns, a clickable
// row, a kebab column, tooltips for detail, square tags, no explanatory
// prose.
//
// TanStack Table supplies sorting, filtering, grouping, expansion and column
// sizing; Radix supplies the kebab menu, the delete confirmation and the
// tooltip. What is written here is the markup and the handful of behaviours
// `lib/kith/table-interactions.ts` and `lib/kith/table-filters.ts` own.
// Deliberately not a component library: one file, and a screen that needs a
// cell rendered differently passes a `cell` in its column definition.

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  type ColumnDef,
  type ColumnSizingState,
  type ExpandedState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  type GroupingState,
  type RowData,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { Check, Filter } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { buttonClass } from "@/components/ui/drawer";
import { archiveDate, label, tableDecimal, tableInteger } from "@/lib/kith/format";
import {
  columnChipOptions,
  matchesFilter,
  rowMatchesSearch,
} from "@/lib/kith/table-filters";
import {
  applyNowrapSizing,
  applyRangeSelection,
  hasActiveSelection,
  isInteractiveTarget,
  pruneSelection,
  resolveRowClickIntent,
  selectionHeaderState,
  shouldToggleSelectionOnKey,
  toggleSelectAll,
  toggleSelection,
} from "@/lib/kith/table-interactions";

declare module "@tanstack/react-table" {
  // The generic parameters have to be here for TypeScript to merge this with
  // TanStack's own declaration, even though this table never reads them back.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Never wraps: a date, a timestamp or a number, whose value would
     * otherwise break across two or three lines in a narrow column. */
    nowrap?: boolean;
  }
}

export type RowAction<T> = {
  label: string;
  onSelect: (row: T) => void;
  disabled?: (row: T) => boolean;
  /** Left out of this row's kebab entirely. A table whose rows are of two
   * kinds (ADM-3's investments over their entries) offers each kind its own
   * actions; `disabled` would show the other kind's greyed out, which reads as
   * "not yet" rather than "not applicable". */
  hidden?: (row: T) => boolean;
  /** Red text, and asks for confirmation (a Radix AlertDialog, never
   * `window.confirm`) before `onSelect` runs. For anything that deletes,
   * archives or revokes. */
  danger?: boolean;
};

export type DataTableProps<T> = {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  /** Column ids offered in the Filters dropdown, in the order the sections appear. */
  filterColumns?: readonly string[];
  /** The order the table opens in. Without one, rows arrive in the order the
   * read returned them, which for a keyed read is id order and means nothing
   * to the reader. */
  initialSorting?: SortingState;
  /** Column id to group by, with one expandable header row per group. */
  groupBy?: string;
  /**
   * A row's children, for a table whose groups are rows of their own rather
   * than headers over aggregated cells (ADM-2's institutions screen).
   *
   * `groupBy` derives its group rows from the data and can only render
   * aggregates in them; this renders the parent as an ordinary row of the same
   * type, so a group's columns are read from the group's own record. Omitted,
   * nothing changes: `getSubRows` is undefined and every row is a leaf, which
   * is what every table before this one was.
   */
  getSubRows?: (row: T) => T[] | undefined;
  /**
   * With `getSubRows`: what a parent row shows in place of its first
   * `labelSpan` cells, so the parent's name sits on the row like a group
   * header instead of reserving a column of its own.
   */
  parentLabel?: (row: T) => React.ReactNode;
  labelSpan?: number;
  /**
   * Whether a row has children at all, independent of whether they have been
   * loaded. Without it a row whose children arrive on expansion could never be
   * expanded: TanStack decides from `getSubRows`, which is empty until the
   * fetch that the expansion itself triggers.
   */
  canExpand?: (row: T) => boolean;
  /**
   * Called when a row is expanded or collapsed. The table still owns the
   * expansion state; this only reports it, so a caller whose children are
   * loaded on demand can fetch them.
   */
  onExpandChange?: (row: T, expanded: boolean) => void;
  /** Row actions behind the kebab in the last column. */
  actions?: readonly RowAction<T>[];
  /** Placeholder for the search box. Two or three words, never a sentence. */
  searchPlaceholder?: string;
  /** Rendered in place of the rows when there are none. */
  empty?: React.ReactNode;
  /** Extra controls at the end of the toolbar, after the Filters button. */
  toolbar?: React.ReactNode;
  /** When set, the search box reports to the caller, which searches on the
   * server and passes the matching rows back in `data`; the table then does
   * not filter on the text itself. */
  onSearchChange?: (value: string) => void;
  /** A stable id for this table, used only to key its column widths in
   * `localStorage`. Without one, columns still resize, but the widths reset
   * on reload. */
  id?: string;
  /**
   * Called when a row that can't expand is clicked (or Enter/Space is
   * pressed on it), anywhere but on an interactive child -- a link, a button,
   * the kebab, a checkbox, or the column resize handle. A row that can
   * expand toggles instead, on every table, whether or not this is set; see
   * `resolveRowClickIntent`.
   */
  onRowClick?: (row: T) => void;
  /**
   * Turns on a leading checkbox column: a fixed-width, non-resizable,
   * non-sortable column the way the trailing kebab column already is (both
   * sit outside TanStack's own column model, sized and rendered by this
   * component directly, for the same reason -- neither is a value of the
   * row's, so neither should be sortable, filterable or resizable like one).
   *
   * Off by default, so a table that does not pass this is unchanged: the
   * decision logic lives in `lib/kith/table-interactions.ts` and is unit
   * tested there (no DOM test environment exists to click a real checkbox
   * in), the same way `resolveRowClickIntent` and friends already are.
   */
  selectable?: boolean;
  /** A stable id for a row, used as the selection's key. Defaults to the
   * row's own `id` field; required via a thrown error at select-time if a
   * row shape has none, since a table row usually does. */
  getRowId?: (row: T) => string;
  /** Bulk actions over the current selection, shown in the toolbar only
   * while something is selected -- beside the "N selected" pill and the
   * clear control -- and only meaningful with `selectable`. Same shape as
   * `RowAction`, over the array of selected rows instead of one: a `danger`
   * action still confirms first, with the count in the prompt. Selection is
   * cleared after any bulk action runs, confirmed or not. */
  bulkActions?: readonly RowAction<T[]>[];
  /** Hide the built-in search input when the table is embedded in a compact
   * summary. Filter chips, selection controls, and toolbar content remain. */
  showSearch?: boolean;
};

/** Square tags (2px), gray by default, blue when they carry the selection. */
export function Tag({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "warn";
  title?: string;
}) {
  const tones = {
    neutral: "bg-gray-100 text-gray-700 border-gray-200",
    accent: "bg-accent-50 text-accent-700 border-accent-200",
    warn: "bg-amber-50 text-amber-800 border-amber-200",
  } as const;
  const displayChildren =
    typeof children === "string" && /^[a-z]+(?:_[a-z]+)*$/.test(children)
      ? label(children)
      : children;
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-tag border px-1.5 py-0.5 text-xs leading-none ${tones[tone]}`}
    >
      {displayChildren}
    </span>
  );
}

/** A cell whose full value is only worth the space on hover. */
export function Detail({
  label,
  detail,
}: {
  label: React.ReactNode;
  detail: string | null;
}) {
  if (detail === null || detail === "") return <>{label}</>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="cursor-default underline decoration-kith-border-subtle decoration-dotted underline-offset-2">
          {label}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={4}
          className="z-50 max-w-sm rounded-control border border-kith-border-subtle bg-kith-surface px-3 py-2 text-sm text-kith-text-secondary shadow-[var(--kith-shadow-md)]"
        >
          {detail}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const WIDTHS_KEY_PREFIX = "kith:table-widths:";

/** The default `getRowId`: a row's own `id` field, the shape every row type
 * in this app already has. Thrown lazily (only when `selectable` actually
 * needs an id) rather than at the type level, so a table with no `id` field
 * that never turns `selectable` on is unaffected. */
function defaultRowId<T>(row: T): string {
  const value = (row as { id?: unknown }).id;
  if (typeof value !== "string") {
    throw new Error(
      "DataTable: selectable requires getRowId, or rows with a string id field",
    );
  }
  return value;
}

/** A checkbox that can show the indeterminate (dash) state, which plain HTML
 * has no attribute for -- it is a DOM property, set imperatively. */
function SelectionCheckbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (event: React.MouseEvent) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={() => {}}
      onClick={onChange}
      className="h-3.5 w-3.5 accent-accent-600"
    />
  );
}

/** Reads a table's saved column widths. Wrapped in `try`/`catch`: private
 * browsing, a full quota or a disabled store all throw rather than return
 * nothing, and the table must render correctly either way. */
function loadColumnSizing(id: string | undefined): ColumnSizingState {
  if (id === undefined || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(WIDTHS_KEY_PREFIX + id);
    return raw === null ? {} : (JSON.parse(raw) as ColumnSizingState);
  } catch {
    return {};
  }
}

/** Apply the app's table display conventions to primitive values while
 * leaving custom React cells untouched. */
function displayCellValue(value: React.ReactNode): React.ReactNode {
  if (typeof value === "number" && Number.isInteger(value)) return tableInteger(value);
  if (typeof value !== "string") return value;
  if (/^-?\d+$/.test(value)) return tableDecimal(value);
  if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return archiveDate(value);
  if (/^[a-z]+(?:_[a-z]+)+$/.test(value)) return label(value);
  return value;
}

export function DataTable<T>({
  data,
  columns,
  filterColumns = [],
  initialSorting = [],
  groupBy,
  getSubRows,
  parentLabel,
  labelSpan = 1,
  canExpand,
  onExpandChange,
  actions = [],
  searchPlaceholder = "Search",
  empty = "Nothing here",
  toolbar,
  onSearchChange,
  id,
  onRowClick,
  selectable = false,
  getRowId = defaultRowId,
  bulkActions = [],
  showSearch = true,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [search, setSearch] = useState("");
  const [unchecked, setUnchecked] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() =>
    loadColumnSizing(id),
  );
  const [confirming, setConfirming] = useState<{ action: RowAction<T>; row: T } | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState<{
    action: RowAction<T[]>;
    rows: T[];
  } | null>(null);
  // The shift-click anchor: the index of the last plain (non-shift) click,
  // so a shift-click range-selects from there rather than from wherever
  // selection happened to start.
  const anchorRef = useRef<number | null>(null);
  const grouping = useMemo<GroupingState>(
    () => (groupBy === undefined ? [] : [groupBy]),
    [groupBy],
  );
  const sizedColumns = useMemo(() => applyNowrapSizing(columns), [columns]);

  // Widths persist per table id, in `localStorage`, inside `try`/`catch`: a
  // table with no id (or a page loaded with storage unavailable) just
  // doesn't remember, which is what every table did before this.
  useEffect(() => {
    if (id === undefined || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WIDTHS_KEY_PREFIX + id, JSON.stringify(columnSizing));
    } catch {
      // Private browsing, a full quota, or a disabled store. Widths just
      // don't persist this session.
    }
  }, [id, columnSizing]);

  const table = useReactTable({
    data,
    columns: sizedColumns,
    defaultColumn: {
      cell: ({ getValue }) =>
        displayCellValue(getValue() as React.ReactNode),
    },
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    state: {
      sorting,
      expanded,
      grouping,
      columnSizing,
      globalFilter: onSearchChange === undefined ? search : "",
    },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    onColumnSizingChange: setColumnSizing,
    onGlobalFilterChange: setSearch,
    ...(getSubRows === undefined ? {} : { getSubRows }),
    ...(canExpand === undefined
      ? {}
      : { getRowCanExpand: (row: { original: T }) => canExpand(row.original) }),
    globalFilterFn: (row, _columnId, value: string) =>
      rowMatchesSearch(Object.values(row.original as object), value),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    // Off: the row models queue these resets from render onto a microtask,
    // which can set state before the first mount completes (React logs
    // "Can't perform a React state update on a component that hasn't mounted
    // yet"). There is no pagination to reset, and collapsing expanded rows on
    // every live refetch would be wrong anyway.
    autoResetAll: false,
  });

  // Options come from the whole data set, not the filtered rows: an option that
  // disappeared as soon as another filter excluded it could never be rechecked.
  const chipOptions = useMemo(
    () =>
      filterColumns.map((columnId) => ({
        columnId,
        options: columnChipOptions(
          data.map((row) => (row as Record<string, unknown>)[columnId]),
        ),
      })),
    [data, filterColumns],
  );

  // Filters apply to top-level rows. A `getSubRows` child is shown or hidden
  // with its parent -- the row model emits children right after the parent
  // they were expanded from, so a parent a chip excluded would otherwise leave
  // its children on screen with nothing above them. Without `getSubRows` every
  // row has depth 0 and this is the same filter it always was.
  const hiddenParents = new Set<string>();
  const rows = table.getRowModel().rows.filter((row) => {
    if (row.getIsGrouped()) return true;
    if (row.depth > 0) return !hiddenParents.has(row.parentId ?? "");
    const kept = filterColumns.every((columnId) =>
      matchesFilter(
        (row.original as Record<string, unknown>)[columnId],
        unchecked[columnId] ?? [],
      ),
    );
    if (!kept) hiddenParents.add(row.id);
    return kept;
  });

  // The current filtered view's ids, in display order: what "select all"
  // selects, what a shift-click ranges over, and what a stale selection is
  // pruned against when a search or filter changes what's in view.
  const rowIdList = useMemo(
    () => (selectable ? rows.map((row) => getRowId(row.original)) : []),
    [selectable, rows, getRowId],
  );
  useEffect(() => {
    if (!selectable) return;
    setSelected((current) => pruneSelection(current, new Set(rowIdList)));
  }, [selectable, rowIdList]);
  const selectionState = selectionHeaderState(rowIdList, selected);
  const selectedRows = useMemo(
    () =>
      selectable
        ? rows
            .filter((row) => selected.has(getRowId(row.original)))
            .map((row) => row.original)
        : [],
    [selectable, rows, selected, getRowId],
  );

  const setUncheckedFor = (columnId: string, values: string[]) =>
    setUnchecked((current) => ({ ...current, [columnId]: values }));
  const activeFilterCount = Object.values(unchecked).reduce(
    (total, values) => total + values.length,
    0,
  );

  const kebabWidth = actions.length > 0 ? 32 : 0;
  const selectWidth = selectable ? 28 : 0;
  const extraColumns = (actions.length > 0 ? 1 : 0) + (selectable ? 1 : 0);

  return (
    <Tooltip.Provider delayDuration={200}>
      <div className="flex flex-col gap-2">
        {showSearch || chipOptions.length > 0 || selectable || toolbar ? (
          <div className="flex flex-wrap items-center gap-2">
            {showSearch ? (
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  onSearchChange?.(event.target.value);
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-8 w-full rounded-control border border-kith-border-subtle bg-kith-surface px-2.5 text-sm outline-none focus:border-kith-action focus:ring-1 focus:ring-kith-action sm:w-56"
              />
            ) : null}
            {chipOptions.length > 0 ? (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger className="flex h-8 items-center gap-1.5 rounded-control border border-kith-border-subtle bg-kith-surface px-2.5 text-sm text-kith-text-secondary hover:bg-kith-surface-muted data-[state=open]:bg-kith-surface-muted">
                  <Filter className="size-3.5" aria-hidden="true" />
                  Filter
                  {activeFilterCount > 0 ? (
                    <span className="rounded-tag bg-accent-600 px-1.5 py-0.5 text-xs leading-none text-white">
                      {activeFilterCount}
                    </span>
                  ) : null}
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    sideOffset={4}
                    className="z-50 max-h-[70vh] min-w-56 overflow-y-auto rounded-control border border-kith-border-subtle bg-kith-surface px-2 py-1 text-sm shadow-[var(--kith-shadow-md)]"
                  >
                    {chipOptions.map(({ columnId, options }, sectionIndex) => {
                      const header = table.getColumn(columnId)?.columnDef.header;
                      const values = options.map((option) => option.value);
                      const hidden = unchecked[columnId] ?? [];
                      return (
                        <div key={columnId}>
                          {sectionIndex > 0 ? (
                            <DropdownMenu.Separator className="my-1 h-px bg-kith-border-subtle" />
                          ) : null}
                          <div className="flex items-center justify-between px-1 pt-1.5 pb-1 text-xs font-medium tracking-wide text-kith-text-muted uppercase">
                            <span>{typeof header === "string" ? header : label(columnId)}</span>
                            <span className="normal-case">
                              <button
                                type="button"
                                onClick={() => setUncheckedFor(columnId, [])}
                                className="text-accent-700 hover:underline"
                              >
                                All
                              </button>
                              <span aria-hidden className="mx-1 text-kith-text-muted">
                                /
                              </span>
                              <button
                                type="button"
                                onClick={() => setUncheckedFor(columnId, values)}
                                className="text-accent-700 hover:underline"
                              >
                                None
                              </button>
                            </span>
                          </div>
                          {options.map((option) => (
                            <DropdownMenu.CheckboxItem
                              key={option.value}
                              checked={!hidden.includes(option.value)}
                              onSelect={(event) => event.preventDefault()}
                              onCheckedChange={(checked) =>
                                setUncheckedFor(
                                  columnId,
                                  checked
                                    ? hidden.filter((value) => value !== option.value)
                                    : [...hidden, option.value],
                                )
                              }
                              className="group flex cursor-default items-center gap-2 rounded-control px-1 py-1 outline-none data-[highlighted]:bg-accent-50"
                            >
                              <span
                                aria-hidden
                                className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-gray-300 bg-white text-[10px] leading-none text-white group-data-[state=checked]:border-accent-600 group-data-[state=checked]:bg-accent-600"
                              >
                                <Check className="hidden size-3 group-data-[state=checked]:block" />
                              </span>
                              <span className="flex-1">{label(option.value)}</span>
                              <span className="text-xs text-kith-text-muted tabular-nums">
                                {option.count}
                              </span>
                            </DropdownMenu.CheckboxItem>
                          ))}
                        </div>
                      );
                    })}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : null}
            {selectable && selected.size > 0 ? (
              <>
                <Tag tone="accent">{selected.size} selected</Tag>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-xs text-kith-text-muted hover:text-kith-text-secondary"
                >
                  Clear
                </button>
                {bulkActions
                  .filter((action) => !(action.hidden?.(selectedRows) ?? false))
                  .map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      disabled={action.disabled?.(selectedRows) ?? false}
                      onClick={() =>
                        action.danger
                          ? setConfirmingBulk({ action, rows: selectedRows })
                          : (action.onSelect(selectedRows), setSelected(new Set()))
                      }
                      className={
                        action.danger
                          ? "h-8 rounded-control border border-kith-danger-border px-3 text-sm text-kith-danger hover:bg-kith-danger-bg disabled:text-kith-text-muted"
                          : buttonClass
                      }
                    >
                      {action.label}
                    </button>
                  ))}
              </>
            ) : null}
            {toolbar}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table
            style={{
              width: "100%",
              minWidth: table.getTotalSize() + kebabWidth + selectWidth,
            }}
            className="kith-table-text w-full table-fixed border-collapse text-kith-text"
          >
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr
                  key={headerGroup.id}
                  className="border-b border-kith-border-subtle bg-kith-surface-muted"
                >
                  {selectable ? (
                    <th className="h-row w-7 bg-kith-surface-muted px-1 align-middle">
                      <SelectionCheckbox
                        label="Select all"
                        checked={selectionState === "all"}
                        indeterminate={selectionState === "some"}
                        onChange={(event) => {
                          event.stopPropagation();
                          setSelected((current) => toggleSelectAll(rowIdList, current));
                        }}
                      />
                    </th>
                  ) : null}
                  {headerGroup.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        style={{ width: header.getSize() }}
                        className="relative h-row border-r border-kith-border bg-kith-surface-muted px-2 text-left align-middle font-medium text-kith-text-secondary last:border-r-0"
                      >
                        {header.isPlaceholder ? null : header.column.getCanSort() ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            aria-sort={
                              sorted === "asc"
                                ? "ascending"
                                : sorted === "desc"
                                  ? "descending"
                                  : "none"
                            }
                            className="flex items-center gap-1 hover:text-kith-text"
                          >
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                            <span aria-hidden className="text-gray-400">
                              {sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : ""}
                            </span>
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                        {header.column.getCanResize() ? (
                          <div
                            data-row-click-ignore
                            onMouseDown={header.getResizeHandler()}
                            onTouchStart={header.getResizeHandler()}
                            onDoubleClick={() => header.column.resetSize()}
                            onClick={(event) => event.stopPropagation()}
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize column"
                            className="absolute inset-y-1 right-0 w-1.5 cursor-col-resize touch-none select-none border-r border-kith-border-subtle hover:border-kith-action"
                          />
                        ) : null}
                      </th>
                    );
                  })}
                  {actions.length > 0 ? (
                    <th className="h-row w-8 bg-kith-surface-muted" />
                  ) : null}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.getAllLeafColumns().length + extraColumns}
                    className="h-36 px-4 text-center align-middle"
                  >
                    <div role="status" className="text-sm text-kith-text-muted">
                      {empty}
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((row, rowIndex) => {
                  const intent = resolveRowClickIntent({
                    canExpand: row.getCanExpand(),
                    hasRowClick: onRowClick !== undefined,
                  });
                  // Selectable but otherwise inert (no expand, no
                  // onRowClick): still focusable, so Space can reach its
                  // checkbox from the keyboard. `trigger` below is a no-op
                  // for such a row either way.
                  const focusable = intent !== "none" || selectable;
                  const rowId = selectable ? getRowId(row.original) : "";
                  const trigger = (event: { target: unknown }) => {
                    if (isInteractiveTarget(event.target)) return;
                    if (hasActiveSelection(window.getSelection())) return;
                    if (intent === "expand") {
                      onExpandChange?.(row.original, !row.getIsExpanded());
                      row.toggleExpanded();
                    } else if (intent === "activate") {
                      onRowClick?.(row.original);
                    }
                  };
                  return (
                    <tr
                      key={row.id}
                      tabIndex={focusable ? 0 : undefined}
                      onClick={focusable ? trigger : undefined}
                      onKeyDown={
                        focusable
                          ? (event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              if (isInteractiveTarget(event.target)) return;
                              event.preventDefault();
                              if (shouldToggleSelectionOnKey(event.key, selectable)) {
                                anchorRef.current = rowIndex;
                                setSelected((current) => toggleSelection(current, rowId));
                                return;
                              }
                              trigger(event);
                            }
                          : undefined
                      }
                      className={`border-b border-kith-border-subtle hover:bg-accent-50/60 ${
                        row.getCanExpand()
                          ? "border-l-2 border-l-accent-500 bg-accent-50/70 font-medium"
                          : row.depth > 0
                            ? "bg-kith-surface text-kith-text-secondary"
                            : "bg-kith-surface"
                      } ${
                        intent === "none"
                          ? ""
                          : "cursor-pointer focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent-600"
                      }`}
                    >
                      {selectable ? (
                        <td
                          data-row-click-ignore
                          className="h-row px-1 align-middle"
                        >
                          <SelectionCheckbox
                            label={`Select row ${rowIndex + 1}`}
                            checked={selected.has(rowId)}
                            onChange={(event) => {
                              event.stopPropagation();
                              if (event.shiftKey && anchorRef.current !== null) {
                                setSelected((current) =>
                                  applyRangeSelection(
                                    rowIdList,
                                    current,
                                    anchorRef.current!,
                                    rowIndex,
                                  ),
                                );
                              } else {
                                anchorRef.current = rowIndex;
                                setSelected((current) => toggleSelection(current, rowId));
                              }
                            }}
                          />
                        </td>
                      ) : null}
                      {row.getVisibleCells().map((cell, cellIndex) => {
                        const spansLabel =
                          parentLabel !== undefined && row.getCanExpand();
                        if (spansLabel && cellIndex > 0 && cellIndex < labelSpan) {
                          return null;
                        }
                        return (
                        <td
                          key={cell.id}
                          colSpan={spansLabel && cellIndex === 0 ? labelSpan : undefined}
                          style={{ width: cell.column.getSize() }}
                          className={`h-row px-2 align-middle ${
                            cell.column.columnDef.meta?.nowrap === true
                              ? "whitespace-nowrap"
                              : ""
                          }`}
                        >
                          {/* The expander for a `getSubRows` table: on the first
                              column only, so the tree reads down one edge, and a
                              child is indented rather than given a dead toggle. */}
                          {cellIndex === 0 && getSubRows !== undefined ? (
                            row.getCanExpand() ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onExpandChange?.(row.original, !row.getIsExpanded());
                                  row.toggleExpanded();
                                }}
                                aria-expanded={row.getIsExpanded()}
                                aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
                                className="mr-1 text-gray-400 hover:text-gray-700"
                              >
                                {row.getIsExpanded() ? "▾" : "▸"}
                              </button>
                            ) : (
                              <span aria-hidden className="mr-1 inline-block w-3" />
                            )
                          ) : null}
                          {cell.getIsGrouped() ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                row.getToggleExpandedHandler()();
                              }}
                              aria-expanded={row.getIsExpanded()}
                              className="flex items-center gap-1 font-medium"
                            >
                              <span aria-hidden>{row.getIsExpanded() ? "▾" : "▸"}</span>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              <span className="text-gray-400">({row.subRows.length})</span>
                            </button>
                          ) : spansLabel && cellIndex === 0 ? (
                            parentLabel(row.original)
                          ) : (groupBy !== undefined && cell.getIsAggregated()) ||
                            cell.getIsPlaceholder() ? null : (
                            // `getIsAggregated` is true for any row that has
                            // sub-rows, whether or not the table is grouping, so a
                            // `getSubRows` parent would render nothing at all if
                            // this were not gated on `groupBy`. A grouped table
                            // behaves exactly as it did.
                            flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )
                          )}
                        </td>
                        );
                      })}
                      {actions.length > 0 ? (
                        <td className="sticky right-0 h-row border-l border-gray-100 bg-inherit px-1 text-right align-middle">
                          {row.getIsGrouped() ||
                          actions.every(
                            (action) => action.hidden?.(row.original) ?? false,
                          ) ? null : (
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger
                                aria-label="Row actions"
                                data-row-click-ignore
                                onClick={(event) => event.stopPropagation()}
                                className="rounded-control px-2 py-1 text-kith-text-muted hover:bg-kith-surface-muted hover:text-kith-text"
                              >
                                &#8942;
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                  align="end"
                                  sideOffset={2}
                                  className="z-50 min-w-36 rounded-control border border-kith-border-subtle bg-kith-surface py-1 text-sm shadow-[var(--kith-shadow-md)]"
                                >
                                  {actions
                                    .filter(
                                      (action) =>
                                        !(action.hidden?.(row.original) ?? false),
                                    )
                                    .map((action) => (
                                      <DropdownMenu.Item
                                        key={action.label}
                                        disabled={action.disabled?.(row.original) ?? false}
                                        onSelect={() =>
                                          action.danger
                                            ? setConfirming({ action, row: row.original })
                                            : action.onSelect(row.original)
                                        }
                                        className={`cursor-default px-2 py-1 outline-none data-[disabled]:text-gray-300 data-[highlighted]:bg-accent-50 ${
                                          action.danger ? "text-kith-danger" : ""
                                        }`}
                                      >
                                        {action.label}
                                      </DropdownMenu.Item>
                                    ))}
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog.Root
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-kith-overlay" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]">
            <AlertDialog.Title className="kith-section-title">
              {confirming?.action.label}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-kith-text-secondary">
              This can&apos;t be undone.
            </AlertDialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialog.Cancel className={buttonClass}>Cancel</AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => {
                  if (confirming) confirming.action.onSelect(confirming.row);
                  setConfirming(null);
                }}
                className="h-8 rounded-control border border-kith-danger bg-kith-danger px-3 text-sm text-white hover:bg-red-700"
              >
                {confirming?.action.label}
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root
        open={confirmingBulk !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingBulk(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-kith-overlay" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]">
            <AlertDialog.Title className="kith-section-title">
              {confirmingBulk?.action.label}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-kith-text-secondary">
              This can&apos;t be undone. Affects {confirmingBulk?.rows.length ?? 0}{" "}
              item{confirmingBulk?.rows.length === 1 ? "" : "s"}.
            </AlertDialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialog.Cancel className={buttonClass}>Cancel</AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => {
                  if (confirmingBulk) confirmingBulk.action.onSelect(confirmingBulk.rows);
                  setConfirmingBulk(null);
                  setSelected(new Set());
                }}
                className="h-8 rounded-control border border-kith-danger bg-kith-danger px-3 text-sm text-white hover:bg-red-700"
              >
                {confirmingBulk?.action.label}
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </Tooltip.Provider>
  );
}
