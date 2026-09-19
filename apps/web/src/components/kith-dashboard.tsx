"use client";

// The dashboard. `app/(authenticated)/page.tsx` loads `stats` and `recent`
// from one read-only transaction; `useServerData` keeps them current by
// refreshing that render whenever a thought or fact changes in one of the
// caller's spaces. This replaced a ten-second poll of `/api/status/dashboard`.
//
// Quick Capture posts to `POST /api/kith/thoughts/capture`
// (`lib/kith/capture.ts`), the same model-backed admission gate the MCP
// `capture_thought` tool runs.

import { type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import { KithQuickCapture } from "@/components/kith-quick-capture";
import { PageHeader } from "@/components/ui/controls";
import { DataTable, Detail, Tag } from "@/components/ui/data-table";
import { label, shortDate } from "@/lib/kith/format";
import { useServerData } from "@/lib/kith/use-server-data";

type DashboardStats = {
  totalFacts: number;
  totalThoughts: number;
  byType: Array<{ type: string; count: number }>;
};

type DashboardThought = {
  id: string;
  content: string;
  createdAt: number;
  metadata: {
    type: string;
    topics: readonly string[];
    people: readonly string[];
    actionItems: readonly string[];
    summary: string;
  };
};

type DashboardData = {
  stats: DashboardStats;
  recent: readonly DashboardThought[];
};

type Row = {
  id: string;
  content: string;
  type: string;
  topics: string;
  people: string;
  actionItems: string;
  createdAt: number;
};

const LIVE_TABLES = ["thoughts", "facts"] as const;

function Stat({ value, name }: { value: number; name: string }) {
  return (
    <div className="min-w-24 rounded-tag border border-gray-200 px-3 py-2">
      <div className="text-lg leading-6 font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-gray-600">{name}</div>
    </div>
  );
}

export function KithDashboard({ stats, recent }: DashboardData) {
  const data = useServerData<DashboardData>(["dashboard"], { stats, recent }, LIVE_TABLES);

  const rows = useMemo<Row[]>(
    () =>
      data.recent.map((thought) => ({
        id: thought.id,
        content: thought.content,
        type: label(thought.metadata.type),
        topics: thought.metadata.topics.join(", "),
        people: thought.metadata.people.join(", "),
        actionItems: thought.metadata.actionItems.join("\n"),
        createdAt: thought.createdAt,
      })),
    [data.recent],
  );

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "content",
        accessorKey: "content",
        header: "Thought",
        cell: ({ row }) => (
          <span className="line-clamp-1 max-w-2xl">
            <Detail
              label={row.original.content}
              detail={[row.original.content, row.original.actionItems]
                .filter(Boolean)
                .join("\n\n")}
            />
          </span>
        ),
      },
      {
        id: "type",
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => <Tag>{row.original.type}</Tag>,
      },
      { id: "topics", accessorKey: "topics", header: "Topics" },
      { id: "people", accessorKey: "people", header: "People" },
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-gray-600 tabular-nums">
            {shortDate(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader title="Dashboard" />
      <div className="mb-4 flex flex-wrap gap-2">
        <Stat value={data.stats.totalFacts} name="facts" />
        <Stat value={data.stats.totalThoughts} name="thoughts" />
        {data.stats.byType.slice(0, 3).map((entry) => (
          <Stat key={entry.type} value={entry.count} name={label(entry.type)} />
        ))}
      </div>
      <KithQuickCapture />
      <h2 className="mt-6 mb-2 text-sm font-semibold">Recent thoughts</h2>
      <DataTable
        data={rows}
        columns={columns}
        filterColumns={["type"]}
        initialSorting={[{ id: "createdAt", desc: true }]}
        searchPlaceholder="Search thoughts"
        empty="No thoughts"
      />
    </div>
  );
}
