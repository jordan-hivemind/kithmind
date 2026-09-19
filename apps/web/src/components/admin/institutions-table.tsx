"use client";

// Screen 3 (Institutions), read-only: one expandable row per institution over
// its accounts.
//
// Every value comes from the finance archive through its own read contract and
// its reader role. An account is named by its display label or by the four
// digits the archive disclosed, never by a whole number -- the archive stores
// no whole number to return, and `maskedLabel` in `lib/kith/institutions.ts`
// is the one place a label is built.
//
// This screen is not on the change feed: the archive is a different database
// with no `kith.changes` table and no triggers, so there is nothing to
// subscribe to. It refetches on mount and when the window is refocused, which
// is TanStack Query's default and is the right cadence for an archive that a
// monthly statement import changes.

import { useQuery } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import { DataTable, Detail, Tag } from "@/components/ui/data-table";
import type { InstitutionsPageData } from "@/lib/kith/admin-data";
import type { InstitutionRow } from "@/lib/kith/institutions";

const TONE: Record<InstitutionRow["status"], "neutral" | "accent" | "warn"> = {
  fresh: "accent",
  stale: "warn",
  empty: "neutral",
};

const EMPTY: Record<InstitutionsPageData["state"], string> = {
  read: "No institutions",
  not_configured: "Finance archive not configured",
  unavailable: "Finance archive unavailable",
};

/** The one place the partial-read tooltip's wording lives. */
export const TRUNCATED_DETAIL =
  "The archive holds more accounts than this read followed. Rows below are a prefix, not the whole inventory.";

function number(value: number | null) {
  return value === null ? null : (
    <span className="tabular-nums">{value}</span>
  );
}

function date(value: string | null) {
  return <span className="tabular-nums text-gray-600">{value ?? ""}</span>;
}

export function InstitutionsTable({
  initial,
}: {
  initial: InstitutionsPageData;
}) {
  const { data } = useQuery({
    queryKey: ["institutions"],
    queryFn: async (): Promise<InstitutionsPageData> => {
      const response = await fetch("/api/kith/admin/institutions", {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("institutions fetch failed");
      return (await response.json()) as InstitutionsPageData;
    },
    initialData: initial,
  });

  const columns = useMemo<ColumnDef<InstitutionRow, unknown>[]>(
    () => [
      { id: "name", accessorKey: "name", header: "Institution" },
      {
        id: "accountType",
        accessorKey: "accountType",
        header: "Type",
        cell: ({ row }) => row.original.accountType ?? "",
      },
      {
        id: "accounts",
        accessorKey: "accounts",
        header: "Accounts",
        cell: ({ row }) => number(row.original.accounts),
      },
      {
        id: "statements",
        accessorKey: "statements",
        header: "Statements",
        cell: ({ row }) => number(row.original.statements),
      },
      {
        id: "records",
        accessorKey: "records",
        header: "Records",
        cell: ({ row }) => number(row.original.records),
      },
      {
        id: "activityFrom",
        accessorKey: "activityFrom",
        header: "Activity from",
        cell: ({ row }) => date(row.original.activityFrom),
      },
      {
        id: "activityTo",
        accessorKey: "activityTo",
        header: "Activity to",
        cell: ({ row }) => date(row.original.activityTo),
      },
      {
        id: "latestSnapshotAsOf",
        accessorKey: "latestSnapshotAsOf",
        header: "Latest snapshot",
        cell: ({ row }) => date(row.original.latestSnapshotAsOf),
      },
      {
        id: "openReviews",
        accessorKey: "openReviews",
        header: "Open reviews",
        cell: ({ row }) => number(row.original.openReviews),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Tag tone={TONE[row.original.status]}>
            <Detail
              label={row.original.status}
              detail={row.original.statusDetail}
            />
          </Tag>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-2">
      {/* A short read says so. A table quietly missing accounts is the exact
          failure an inventory screen exists to prevent. */}
      {data.truncated ? (
        <div>
          <Tag tone="warn" title={TRUNCATED_DETAIL}>
            partial
          </Tag>
        </div>
      ) : null}
      <DataTable
        data={data.institutions}
        columns={columns}
        getSubRows={(row) => row.children}
        filterColumns={["status"]}
        initialSorting={[{ id: "name", desc: false }]}
        searchPlaceholder="Search institutions"
        empty={
          data.state === "unavailable" && data.reason !== null
            ? `${EMPTY.unavailable}: ${data.reason}`
            : EMPTY[data.state]
        }
      />
    </div>
  );
}
