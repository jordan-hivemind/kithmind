"use client";

// The one table every admin screen uses.
//
// The owner's decision, in one component: compact rows (34px), sortable
// headers, column filters as chips, a search box that filters as you type,
// optional grouped and expandable rows, a kebab column, tooltips for detail,
// square tags, no explanatory prose.
//
// TanStack Table supplies sorting, filtering, grouping and expansion; Radix
// supplies the kebab menu and the tooltip. What is written here is the markup
// and the two behaviours `lib/kith/table-filters.ts` owns. Deliberately not a
// component library: one file, and a screen that needs a cell rendered
// differently passes a `cell` in its column definition.

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  type ColumnDef,
  type ExpandedState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  type GroupingState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import {
  columnChipOptions,
  matchesChipFilter,
  rowMatchesSearch,
} from "@/lib/kith/table-filters";

export type RowAction<T> = {
  label: string;
  onSelect: (row: T) => void;
  disabled?: (row: T) => boolean;
  /** Left out of this row's kebab entirely. A table whose rows are of two
   * kinds (ADM-3's investments over their entries) offers each kind its own
   * actions; `disabled` would show the other kind's greyed out, which reads as
   * "not yet" rather than "not applicable". */
  hidden?: (row: T) => boolean;
};

export type DataTableProps<T> = {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  /** Column ids offered as filter chips, in the order the chips appear. */
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
  /** Extra controls at the end of the toolbar, after the chips. */
  toolbar?: React.ReactNode;
  /** When set, the search box reports to the caller, which searches on the
   * server and passes the matching rows back in `data`; the table then does
   * not filter on the text itself. */
  onSearchChange?: (value: string) => void;
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
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-tag border px-1.5 py-0.5 text-[11px] leading-none ${tones[tone]}`}
    >
      {children}
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
        <span className="cursor-default underline decoration-gray-300 decoration-dotted underline-offset-2">
          {label}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={4}
          className="z-50 max-w-sm rounded-tag border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 shadow-md"
        >
          {detail}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function DataTable<T>({
  data,
  columns,
  filterColumns = [],
  initialSorting = [],
  groupBy,
  getSubRows,
  canExpand,
  onExpandChange,
  actions = [],
  searchPlaceholder = "Search",
  empty = "Nothing here",
  toolbar,
  onSearchChange,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [search, setSearch] = useState("");
  const [chips, setChips] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const grouping = useMemo<GroupingState>(
    () => (groupBy === undefined ? [] : [groupBy]),
    [groupBy],
  );

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      expanded,
      grouping,
      globalFilter: onSearchChange === undefined ? search : "",
    },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    onGlobalFilterChange: setSearch,
    ...(getSubRows === undefined ? {} : { getSubRows }),
    ...(canExpand === undefined
      ? {}
      : { getRowCanExpand: (row: { original: T }) => canExpand(row.original) }),
    globalFilterFn: (row, _columnId, value: string) =>
      rowMatchesSearch(Object.values(row.original as object), value),
    ...(getSubRows === undefined ? {} : { getSubRows }),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  // Chips come from the whole data set, not the filtered rows: a chip that
  // disappeared as soon as another chip excluded it could never be unselected.
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

  // Chips apply to top-level rows. A `getSubRows` child is shown or hidden
  // with its parent -- the row model emits children right after the parent
  // they were expanded from, so a parent a chip excluded would otherwise leave
  // its children on screen with nothing above them. Without `getSubRows` every
  // row has depth 0 and this is the same filter it always was.
  const hiddenParents = new Set<string>();
  const rows = table.getRowModel().rows.filter((row) => {
    if (row.getIsGrouped()) return true;
    if (row.depth > 0) return !hiddenParents.has(row.parentId ?? "");
    const kept = filterColumns.every((columnId) =>
      matchesChipFilter(
        (row.original as Record<string, unknown>)[columnId],
        chips[columnId] ?? [],
      ),
    );
    if (!kept) hiddenParents.add(row.id);
    return kept;
  });

  const toggleChip = (columnId: string, value: string) => {
    setChips((current) => {
      const selected = current[columnId] ?? [];
      return {
        ...current,
        [columnId]: selected.includes(value)
          ? selected.filter((item) => item !== value)
          : [...selected, value],
      };
    });
  };

  return (
    <Tooltip.Provider delayDuration={200}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              onSearchChange?.(event.target.value);
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-7 w-56 rounded-tag border border-gray-300 px-2 text-xs outline-none focus:border-accent-500"
          />
          {chipOptions.map(({ columnId, options }) =>
            options.map((option) => {
              const selected = (chips[columnId] ?? []).includes(option.value);
              return (
                <button
                  key={`${columnId}:${option.value}`}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleChip(columnId, option.value)}
                  className={`rounded-tag border px-1.5 py-0.5 text-[11px] leading-none ${
                    selected
                      ? "border-accent-600 bg-accent-600 text-white"
                      : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300"
                  }`}
                >
                  {option.value}
                  <span className="ml-1 opacity-60">{option.count}</span>
                </button>
              );
            }),
          )}
          {toolbar}
        </div>

        <table className="w-full border-collapse text-xs">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-gray-200">
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className="h-row px-2 text-left align-middle font-medium text-gray-500"
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
                          className="flex items-center gap-1 hover:text-gray-900"
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
                    </th>
                  );
                })}
                {actions.length > 0 ? <th className="h-row w-8" /> : null}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={table.getAllLeafColumns().length + (actions.length > 0 ? 1 : 0)}
                  className="h-row px-2 text-gray-500"
                >
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-gray-100 hover:bg-accent-50/40 ${
                    row.depth > 0 ? "bg-gray-50/60 text-gray-600" : ""
                  }`}
                >
                  {row.getVisibleCells().map((cell, cellIndex) => (
                    <td key={cell.id} className="h-row px-2 align-middle">
                      {/* The expander for a `getSubRows` table: on the first
                          column only, so the tree reads down one edge, and a
                          child is indented rather than given a dead toggle. */}
                      {cellIndex === 0 && getSubRows !== undefined ? (
                        row.getCanExpand() ? (
                          <button
                            type="button"
                            onClick={() => {
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
                          onClick={row.getToggleExpandedHandler()}
                          aria-expanded={row.getIsExpanded()}
                          className="flex items-center gap-1 font-medium"
                        >
                          <span aria-hidden>{row.getIsExpanded() ? "▾" : "▸"}</span>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          <span className="text-gray-400">({row.subRows.length})</span>
                        </button>
                      ) : (groupBy !== undefined && cell.getIsAggregated()) ||
                        cell.getIsPlaceholder() ? null : (
                        // `getIsAggregated` is true for any row that has
                        // sub-rows, whether or not the table is grouping, so a
                        // `getSubRows` parent would render nothing at all if
                        // this were not gated on `groupBy`. A grouped table
                        // behaves exactly as it did.
                        flexRender(cell.column.columnDef.cell, cell.getContext())
                      )}
                    </td>
                  ))}
                  {actions.length > 0 ? (
                    <td className="h-row px-1 text-right align-middle">
                      {row.getIsGrouped() ? null : (
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger
                            aria-label="Row actions"
                            className="rounded-tag px-1.5 py-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                          >
                            &#8942;
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              align="end"
                              sideOffset={2}
                              className="z-50 min-w-36 rounded-tag border border-gray-200 bg-white py-1 text-xs shadow-md"
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
                                  onSelect={() => action.onSelect(row.original)}
                                  className="cursor-default px-2 py-1 outline-none data-[disabled]:text-gray-300 data-[highlighted]:bg-accent-50"
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
              ))
            )}
          </tbody>
        </table>
      </div>
    </Tooltip.Provider>
  );
}
