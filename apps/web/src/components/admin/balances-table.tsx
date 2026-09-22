"use client";

// PLAID-1's screen, read-only: one row per linked Plaid account.
//
// Not on the change feed, the same reason `institutions-table.tsx` is not:
// the Plaid feed's tables carry no `kith.changes` triggers (the simplification
// plan retired that machinery for the feed path), so there is nothing to
// subscribe to. It refetches on mount and when the window is refocused,
// TanStack Query's default, which is the right cadence for a feed that a
// daily `pull` changes at most once a day.

import { useQuery } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import { DataTable, Tag } from "@/components/ui/data-table";
import type { BalancesPageData } from "@/lib/kith/admin-data";
import { archiveDate, label, tableMoney } from "@/lib/kith/format";

type BalanceRow = BalancesPageData["balances"][number];

function money(amount: number | null, currency: string | null) {
  if (amount === null || currency === null) return "";
  return <span className="tabular-nums">{tableMoney(amount, currency)}</span>;
}

function date(value: string | null) {
  return (
    <span className="tabular-nums text-gray-600">{archiveDate(value)}</span>
  );
}

export function BalancesTable({ initial }: { initial: BalancesPageData }) {
  const { data } = useQuery({
    queryKey: ["balances"],
    queryFn: async (): Promise<BalancesPageData> => {
      const response = await fetch("/api/kith/admin/balances", {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("balances fetch failed");
      return (await response.json()) as BalancesPageData;
    },
    initialData: initial,
  });

  const columns = useMemo<ColumnDef<BalanceRow, unknown>[]>(
    () => [
      {
        id: "institutionName",
        accessorKey: "institutionName",
        header: "Institution",
        size: 150,
      },
      {
        id: "accountName",
        accessorKey: "accountName",
        header: "Account",
        size: 180,
      },
      {
        id: "mask",
        accessorKey: "mask",
        header: "Mask",
        size: 70,
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) =>
          row.original.mask === null ? "" : (
            <span className="tabular-nums">••••{row.original.mask}</span>
          ),
      },
      {
        id: "type",
        accessorFn: (row) => row.subtype ?? row.type ?? "",
        header: "Type",
        size: 110,
        cell: ({ row }) => {
          const value = row.original.subtype ?? row.original.type;
          return value === null ? "" : label(value);
        },
      },
      {
        id: "currentBalance",
        header: "Balance",
        size: 130,
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) =>
          money(row.original.currentBalance, row.original.currency),
      },
      {
        id: "holdingsValue",
        header: "Holdings",
        size: 130,
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) =>
          money(row.original.holdingsValue, row.original.currency),
      },
      {
        id: "asOf",
        accessorFn: (row) => row.balanceAsOf ?? row.holdingsAsOf ?? "",
        header: "As of",
        size: 110,
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) =>
          date(row.original.balanceAsOf ?? row.original.holdingsAsOf),
      },
      {
        id: "needsRelink",
        header: "",
        size: 100,
        cell: ({ row }) =>
          row.original.needsRelinkAt === null ? null : (
            <Tag tone="warn" title="Plaid reports this item needs re-authentication">
              needs relink
            </Tag>
          ),
      },
    ],
    [],
  );

  return (
    <DataTable
      id="admin-balances"
      data={data.balances}
      columns={columns}
      initialSorting={[{ id: "institutionName", desc: false }]}
      searchPlaceholder="Search accounts"
      empty="No linked accounts"
    />
  );
}
