"use client";

// Screen 2 (Sources), read-only: every folder, institution and manual source
// with its area, its item count, when it was last read and its status.
//
// Every value comes from the database (source accounts, their items, their
// root and its latest report, and the watcher state). There is no mock row
// here and no placeholder data path: a source with no root shows an empty area
// rather than an invented one.
//
// The server's read is the first paint and also the query's `initialData`, so
// the table is populated before the client has fetched anything; after that
// `useLiveChanges` invalidates `["sources"]` whenever any of the tables this
// screen reads changes, and TanStack Query refetches `/api/kith/sources`.

import type { admin } from "@repo/kith-store";
import { useQuery } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import { DataTable, Detail, Tag } from "@/components/ui/data-table";
import { useLiveChanges } from "@/lib/kith/use-live-changes";

type Source = admin.SourceInventoryRow;

/** The tables this screen's data is read from. A change on any of them
 * invalidates `["sources"]`. */
const WATCHED = {
  sources: [
    "source_accounts",
    "source_roots",
    "source_root_reports",
    "source_items",
    "worker_watcher_states",
    "worker_processing_assessments",
  ],
} as const;

const STATUS_TONE: Record<Source["status"], "neutral" | "accent" | "warn"> = {
  ok: "accent",
  pending: "neutral",
  disabled: "neutral",
  overdue: "warn",
  problem: "warn",
};

function when(value: number | null): string {
  if (value === null) return "";
  return new Date(value).toISOString().slice(0, 16).replace("T", " ");
}

export function SourcesTable({ initial }: { initial: Source[] }) {
  useLiveChanges(WATCHED);
  const { data } = useQuery({
    queryKey: ["sources"],
    queryFn: async (): Promise<Source[]> => {
      const response = await fetch("/api/kith/sources", {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("sources fetch failed");
      return ((await response.json()) as { sources: Source[] }).sources;
    },
    initialData: initial,
  });

  const columns = useMemo<ColumnDef<Source, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Source",
        cell: ({ row }) => (
          <Detail label={row.original.name} detail={row.original.location} />
        ),
      },
      { id: "connector", accessorKey: "connector", header: "Type" },
      {
        id: "kind",
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) =>
          row.original.kind === null ? null : <Tag>{row.original.kind}</Tag>,
      },
      {
        id: "area",
        accessorKey: "area",
        header: "Area",
        cell: ({ row }) =>
          row.original.area === null ? null : <Tag>{row.original.area}</Tag>,
      },
      {
        id: "itemCount",
        accessorKey: "itemCount",
        header: "Items",
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.itemCount}</span>
        ),
      },
      {
        id: "skippedCount",
        accessorKey: "skippedCount",
        header: "Skipped",
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.skippedCount}</span>
        ),
      },
      {
        id: "lastReadAt",
        accessorKey: "lastReadAt",
        header: "Last read",
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-600">
            {when(row.original.lastReadAt)}
          </span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Tag tone={STATUS_TONE[row.original.status]} title={row.original.problem ?? undefined}>
            {row.original.status}
          </Tag>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable
      data={data}
      columns={columns}
      filterColumns={["status", "connector", "area"]}
      initialSorting={[{ id: "name", desc: false }]}
      searchPlaceholder="Search sources"
      empty="No sources"
    />
  );
}
