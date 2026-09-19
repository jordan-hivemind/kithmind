"use client";

// The dashboard. `app/(authenticated)/page.tsx` loads `stats` and `recent`
// from one read-only transaction; `useServerData` keeps them current by
// refreshing that render whenever a thought or fact changes in one of the
// caller's spaces. This replaced a ten-second poll of `/api/status/dashboard`.
//
// Quick Capture posts to `POST /api/kith/thoughts/capture`
// (`lib/kith/capture.ts`), the same model-backed admission gate the MCP
// `capture_thought` tool runs.
//
// Editing and deleting a recent thought are `useOptimisticMutation` against
// this same `["dashboard"]` cache: `apply` patches `recent` at once, a
// failure rolls it back and shows a toast, and either way the mutation
// settling -- and the live change feed, once the write lands -- resyncs from
// the server render.

import { type memory } from "@repo/kith-store";
import { type ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";

import { KithQuickCapture } from "@/components/kith-quick-capture";
import {
  type ThoughtDraft,
  ThoughtDrawer,
} from "@/components/kith-thought-drawer";
import { PageHeader } from "@/components/ui/controls";
import {
  DataTable,
  Detail,
  type RowAction,
  Tag,
} from "@/components/ui/data-table";
import { label, shortDate } from "@/lib/kith/format";
import { mutateJson } from "@/lib/kith/optimistic";
import {
  useOptimisticMutation,
  useServerData,
} from "@/lib/kith/use-server-data";

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

type EditVars = {
  id: string;
  content: string;
  type: memory.ThoughtType;
  topics: string[];
  people: string[];
};

const LIVE_TABLES = ["thoughts", "facts"] as const;
const DASHBOARD_KEY = ["dashboard"];

function Stat({ value, name }: { value: number; name: string }) {
  return (
    <div className="min-w-24 rounded-tag border border-gray-200 px-3 py-2">
      <div className="text-lg leading-6 font-semibold tabular-nums">
        {value}
      </div>
      <div className="text-[11px] text-gray-600">{name}</div>
    </div>
  );
}

export function KithDashboard({ stats, recent }: DashboardData) {
  const data = useServerData<DashboardData>(
    DASHBOARD_KEY,
    { stats, recent },
    LIVE_TABLES,
  );
  const [editing, setEditing] = useState<{
    id: string;
    draft: ThoughtDraft;
  } | null>(null);

  const edit = useOptimisticMutation<DashboardData, EditVars>({
    queryKey: DASHBOARD_KEY,
    mutationFn: (vars) =>
      mutateJson(`/api/kith/thoughts/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          content: vars.content,
          type: vars.type,
          topics: vars.topics,
          people: vars.people,
        }),
      }),
    apply: (current, vars) => ({
      ...current,
      recent: current.recent.map((thought) =>
        thought.id === vars.id
          ? {
              ...thought,
              content: vars.content,
              metadata: {
                ...thought.metadata,
                type: vars.type,
                topics: vars.topics,
                people: vars.people,
              },
            }
          : thought,
      ),
    }),
  });

  const remove = useOptimisticMutation<DashboardData, string>({
    queryKey: DASHBOARD_KEY,
    mutationFn: (id) =>
      mutateJson(`/api/kith/thoughts/${id}`, { method: "DELETE" }),
    apply: (current, id) => ({
      ...current,
      recent: current.recent.filter((thought) => thought.id !== id),
    }),
  });

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
        meta: { nowrap: true },
        cell: ({ row }) => (
          <span className="text-gray-600 tabular-nums">
            {shortDate(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [],
  );

  // Shared by the kebab's Edit item and clicking the row.
  const openEdit = useCallback(
    (row: Row) => {
      const thought = data.recent.find((item) => item.id === row.id);
      if (!thought) return;
      setEditing({
        id: row.id,
        draft: {
          content: thought.content,
          type: thought.metadata.type as memory.ThoughtType,
          topics: thought.metadata.topics.join(", "),
          people: thought.metadata.people.join(", "),
        },
      });
    },
    [data.recent],
  );

  const actions = useMemo<RowAction<Row>[]>(
    () => [
      { label: "Edit", onSelect: openEdit },
      {
        label: "Delete",
        danger: true,
        onSelect: (row) => void remove.mutateAsync(row.id),
      },
      {
        label: "Copy id",
        onSelect: (row) => void navigator.clipboard.writeText(row.id),
      },
    ],
    [openEdit, remove],
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
        id="dashboard-recent-thoughts"
        data={rows}
        columns={columns}
        filterColumns={["type"]}
        initialSorting={[{ id: "createdAt", desc: true }]}
        actions={actions}
        onRowClick={openEdit}
        searchPlaceholder="Search thoughts"
        empty="No thoughts"
      />

      {editing === null ? null : (
        <ThoughtDrawer
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          initial={editing.draft}
          onSave={async (values) => {
            await edit.mutateAsync({ id: editing.id, ...values });
          }}
        />
      )}
    </div>
  );
}
