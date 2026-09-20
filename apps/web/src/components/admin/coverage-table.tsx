"use client";

// Screen 4 (Coverage), read-only: one row per life area against what the
// system holds for it.
//
// The empty rows are the point. An area with no sources and no documents is
// listed with zeros and tagged Empty rather than left off, because the screen
// exists to show where nothing has been ingested yet.

import type { admin } from "@repo/kith-store";
import { type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import { useAdminScreen } from "@/components/admin/admin-query";
import { TRUNCATED_DETAIL } from "@/components/admin/institutions-table";
import { DataTable, Detail, Tag } from "@/components/ui/data-table";
import { archiveDate, tableInteger } from "@/lib/kith/format";

type Area = admin.AreaCoverageRow;

/** The tables an area's counts come from. Any change invalidates `coverage`. */
const WATCHED = {
  coverage: [
    "source_accounts",
    "source_roots",
    "source_items",
    "observations",
    "coverage_windows",
    "coverage_gaps",
    "thoughts",
    "facts",
    "investments",
    "investment_entries",
  ],
} as const;

const TONE: Record<admin.CoverageStatus, "neutral" | "accent" | "warn"> = {
  covered: "accent",
  gaps: "warn",
  empty: "neutral",
};

function number(value: number) {
  return <span className="tabular-nums">{tableInteger(value)}</span>;
}

export function CoverageTable({
  initial,
}: {
  initial: { areas: Area[]; truncated: boolean };
}) {
  const data = useAdminScreen("coverage", WATCHED, initial);

  const columns = useMemo<ColumnDef<Area, unknown>[]>(
    () => [
      { id: "area", accessorKey: "area", header: "Area" },
      {
        id: "sources",
        accessorKey: "sources",
        header: "Sources",
        meta: { nowrap: true },
        cell: ({ row }) => number(row.original.sources),
      },
      {
        id: "documents",
        accessorKey: "documents",
        header: "Documents",
        meta: { nowrap: true },
        cell: ({ row }) => number(row.original.documents),
      },
      {
        id: "records",
        accessorKey: "records",
        header: "Records",
        meta: { nowrap: true },
        cell: ({ row }) => number(row.original.records),
      },
      {
        id: "range",
        accessorFn: (row) => row.from ?? "",
        header: "Dates",
        meta: { nowrap: true },
        size: 180,
        minSize: 110,
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-600">
            {row.original.from === null
              ? ""
              : `${archiveDate(row.original.from)} to ${archiveDate(row.original.to)}`}
          </span>
        ),
      },
      {
        id: "gaps",
        accessorKey: "gaps",
        header: "Gaps",
        meta: { nowrap: true },
        cell: ({ row }) => (
          <Detail
            label={number(row.original.gaps)}
            detail={gapTooltip(row.original.gapReasons)}
          />
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Tag tone={TONE[row.original.status]}>{row.original.status}</Tag>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-2">
      {/* The brokerage row's archive contribution is short when the inventory
          read stopped at its page bound, so the totals below understate it. */}
      {data.truncated ? (
        <div>
          <Tag tone="warn" title={TRUNCATED_DETAIL}>
            partial
          </Tag>
        </div>
      ) : null}
      <DataTable
        id="admin-coverage"
        data={data.areas}
        columns={columns}
        filterColumns={["status"]}
        searchPlaceholder="Search areas"
        empty="No areas"
      />
    </div>
  );
}

function gapTooltip(reasons: Record<string, number>): string | null {
  const line = Object.entries(reasons)
    .sort(([, left], [, right]) => right - left)
    .map(([reason, count]) => `${reason} ${count}`)
    .join("\n");
  return line === "" ? null : line;
}
