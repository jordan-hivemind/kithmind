"use client";

// Screen 1 (Health), read-only: one row per check, with its status, the one
// line behind it, and when it was last checked.
//
// Every value comes from the database or from the finance archive's own read
// contract. There is no mock check and no placeholder status: a check with
// nothing to report says `unknown` or `not configured`, which are different
// answers from `ok` and are shown as such.

import type { admin } from "@repo/kith-store";
import { type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import { useAdminScreen } from "@/components/admin/admin-query";
import { DataTable, Detail, Tag } from "@/components/ui/data-table";

type Check = admin.HealthCheck;

/** The tables each check is derived from. Any change invalidates `health`. */
const WATCHED = {
  health: [
    "worker_watcher_states",
    "worker_processing_assessments",
    "source_accounts",
    "deferred_work",
    "card_entity_bindings",
    "card_field_drops",
  ],
} as const;

const TONE: Record<Check["status"], "neutral" | "accent" | "warn"> = {
  ok: "accent",
  attention: "warn",
  problem: "warn",
  unknown: "neutral",
  not_configured: "neutral",
};

const LABEL: Record<Check["status"], string> = {
  ok: "ok",
  attention: "attention",
  problem: "problem",
  unknown: "unknown",
  not_configured: "not configured",
};

function when(value: number | null): string {
  if (value === null) return "";
  return new Date(value).toISOString().slice(0, 16).replace("T", " ");
}

export function HealthTable({ initial }: { initial: { checks: Check[] } }) {
  const data = useAdminScreen("health", WATCHED, initial);

  const columns = useMemo<ColumnDef<Check, unknown>[]>(
    () => [
      { id: "name", accessorKey: "name", header: "Check" },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Tag tone={TONE[row.original.status]}>
            {LABEL[row.original.status]}
          </Tag>
        ),
      },
      {
        id: "detail",
        accessorKey: "detail",
        header: "Detail",
        cell: ({ row }) => (
          <Detail label={row.original.detail} detail={row.original.tooltip} />
        ),
      },
      {
        id: "lastCheckedAt",
        accessorKey: "lastCheckedAt",
        header: "Last checked",
        meta: { nowrap: true },
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-600">
            {when(row.original.lastCheckedAt)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable
      id="admin-health"
      data={data.checks}
      columns={columns}
      filterColumns={["status"]}
      searchPlaceholder="Search checks"
      empty="No checks"
    />
  );
}
