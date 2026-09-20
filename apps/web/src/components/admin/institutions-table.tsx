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
import { useMemo, useState } from "react";

import { InstitutionAccountDrawer } from "@/components/admin/institution-account-drawer";
import { DataTable, Detail, Tag } from "@/components/ui/data-table";
import type { InstitutionsPageData } from "@/lib/kith/admin-data";
import {
  archiveDate,
  label,
  tableInteger,
  tableMoney,
} from "@/lib/kith/format";
import type { InstitutionRow } from "@/lib/kith/institutions";

const TONE: Record<InstitutionRow["status"], "neutral" | "accent" | "warn"> = {
  fresh: "accent",
  stale: "warn",
  inactive: "neutral",
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
    <span className="tabular-nums">{tableInteger(value)}</span>
  );
}

function date(value: string | null) {
  return (
    <span className="tabular-nums text-gray-600">{archiveDate(value)}</span>
  );
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

  const [hideEmpty, setHideEmpty] = useState(true);
  const [editing, setEditing] = useState<InstitutionRow | null>(null);
  const institutions = useMemo(
    () =>
      hideEmpty
        ? data.institutions.flatMap((group) => {
            const children = group.children?.filter(
              (child) => child.status !== "empty",
            );
            return children?.length === 0 ? [] : [{ ...group, children }];
          })
        : data.institutions,
    [data.institutions, hideEmpty],
  );

  const columns = useMemo<ColumnDef<InstitutionRow, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Account",
        size: 250,
      },
      {
        id: "accountLast4",
        accessorKey: "accountLast4",
        header: "Last 4",
        size: 80,
        meta: { nowrap: true },
        cell: ({ row }) =>
          row.original.accountLast4 !== null ? (
            <span className="tabular-nums">
              ••••{row.original.accountLast4}
            </span>
          ) : row.original.last4Reason !== null ? (
            <Detail label="—" detail={row.original.last4Reason} />
          ) : (
            ""
          ),
      },
      {
        id: "accountType",
        accessorKey: "accountType",
        header: "Type",
        size: 110,
        cell: ({ row }) =>
          row.original.accountType === null
            ? ""
            : label(row.original.accountType),
      },
      {
        id: "currentValue",
        accessorKey: "currentValue",
        header: "Current value",
        size: 130,
        meta: { nowrap: true },
        cell: ({ row }) =>
          row.original.currentValue === null ||
          row.original.currentValueCurrency === null ? (
            ""
          ) : (
            <Detail
              label={
                <span
                  className={`tabular-nums ${
                    row.original.status === "inactive" ? "text-gray-400" : ""
                  }`}
                >
                  {tableMoney(
                    row.original.currentValue,
                    row.original.currentValueCurrency,
                  )}
                </span>
              }
              detail={`as of ${archiveDate(row.original.currentValueAsOf)}`}
            />
          ),
      },
      {
        id: "statements",
        accessorKey: "statements",
        size: 90,
        header: "Statements",
        meta: { nowrap: true },
        cell: ({ row }) => number(row.original.statements),
      },
      {
        id: "records",
        accessorKey: "records",
        size: 90,
        header: "Records",
        meta: { nowrap: true },
        cell: ({ row }) => number(row.original.records),
      },
      {
        id: "activityFrom",
        accessorKey: "activityFrom",
        size: 110,
        header: "Activity from",
        meta: { nowrap: true },
        cell: ({ row }) => date(row.original.activityFrom),
      },
      {
        id: "activityTo",
        accessorKey: "activityTo",
        size: 110,
        header: "Activity to",
        meta: { nowrap: true },
        cell: ({ row }) => date(row.original.activityTo),
      },
      {
        id: "latestSnapshotAsOf",
        accessorKey: "latestSnapshotAsOf",
        size: 125,
        header: "Latest snapshot",
        meta: { nowrap: true },
        cell: ({ row }) => date(row.original.latestSnapshotAsOf),
      },
      {
        id: "openReviews",
        accessorKey: "openReviews",
        size: 105,
        header: "Open reviews",
        meta: { nowrap: true },
        cell: ({ row }) => number(row.original.openReviews),
      },
      {
        id: "status",
        accessorKey: "status",
        size: 90,
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
        id="admin-institutions"
        data={institutions}
        columns={columns}
        getSubRows={(row) => row.children}
        onRowClick={setEditing}
        actions={[
          {
            label: "Edit",
            onSelect: setEditing,
            hidden: (row) => row.archive === null,
          },
        ]}
        parentLabel={(row) => (
          <>
            {row.name}
            <span className="ml-1 font-normal text-gray-400">
              ({row.children?.length ?? 0})
            </span>
          </>
        )}
        labelSpan={3}
        filterColumns={["status"]}
        initialSorting={[{ id: "name", desc: false }]}
        toolbar={
          <label className="flex h-8 cursor-pointer items-center gap-2 text-sm text-kith-text-secondary">
            <input
              type="checkbox"
              role="switch"
              checked={hideEmpty}
              onChange={(event) => setHideEmpty(event.target.checked)}
              className="h-3.5 w-3.5 accent-accent-600"
            />
            Hide empty accounts
          </label>
        }
        searchPlaceholder="Search institutions"
        empty={
          data.state === "unavailable" && data.reason !== null
            ? `${EMPTY.unavailable}: ${data.reason}`
            : EMPTY[data.state]
        }
      />
      <InstitutionAccountDrawer row={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
