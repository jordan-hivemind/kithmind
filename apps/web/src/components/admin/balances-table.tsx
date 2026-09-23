"use client";

// PLAID-1's screen, read-only apart from FIN-5's Rename action: one row per
// linked Plaid account.
//
// Not on the change feed, the same reason `institutions-table.tsx` is not:
// the Plaid feed's tables carry no `kith.changes` triggers (the simplification
// plan retired that machinery for the feed path), so there is nothing to
// subscribe to. It refetches on mount and when the window is refocused,
// TanStack Query's default, which is the right cadence for a feed that a
// daily `pull` changes at most once a day.
//
// FIN-5: `admin.listFinAccounts`' own `accountName` never reflects an
// archive-linked account's `kith.finance_account_overrides` row -- that
// override lives beside the archive, keyed by the archive's own account id,
// and `fin_accounts.display_name` is never set for that kind of row (see
// `packages/kith-store/src/admin/finAccounts.ts`). `rows` below applies
// it on the client from `data.overrides` (`loadBalances`), the same name a
// linked account's Rename writes to, so this table's own Account column
// agrees with what Rename just saved rather than showing the feed's raw name
// underneath it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { RenameAccountDialog, type RenameTarget } from "@/components/admin/rename-account-dialog";
import { DataTable, Detail, Tag } from "@/components/ui/data-table";
import type { BalancesPageData } from "@/lib/kith/admin-data";
import { archiveDate, label, tableMoney } from "@/lib/kith/format";

type FinAccountRow = BalancesPageData["balances"][number];
type BalanceRow = Omit<FinAccountRow, "feedName"> & {
  /** `finance_account_overrides.display_name` when this is an archive-linked
   * account with one, otherwise `FinAccountRow.accountName` unchanged. */
  shownName: string;
  /** The underlying name beside `shownName`, for a tooltip -- null when an
   * owner rename has not replaced it on screen. */
  feedName: string | null;
};

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
  const queryClient = useQueryClient();
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

  const rows = useMemo<BalanceRow[]>(
    () =>
      data.balances.map((row) => {
        const override =
          row.archiveAccountId === null
            ? undefined
            : data.overrides[row.archiveAccountId];
        const shownName = override?.displayName ?? row.accountName;
        return {
          ...row,
          shownName,
          feedName: shownName === row.feedName ? null : row.feedName,
        };
      }),
    [data.balances, data.overrides],
  );

  const [renaming, setRenaming] = useState<BalanceRow | null>(null);
  const renameTarget: RenameTarget | null =
    renaming === null
      ? null
      : {
          id: renaming.accountId,
          label: renaming.shownName,
          initialValue:
            renaming.archiveAccountId !== null
              ? (data.overrides[renaming.archiveAccountId]?.displayName ?? "")
              : (renaming.displayName ?? ""),
          placeholder: renaming.feedName ?? renaming.shownName,
        };
  const saveRename = async (row: BalanceRow, value: string | null) => {
    const response =
      row.archiveAccountId !== null
        ? await fetch(
            `/api/kith/finance-accounts/${encodeURIComponent(row.archiveAccountId)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                displayName: value,
                accountLast4: data.overrides[row.archiveAccountId]?.accountLast4 ?? null,
                accountType: data.overrides[row.archiveAccountId]?.accountType ?? null,
                closed: data.overrides[row.archiveAccountId]?.closed ?? false,
              }),
            },
          )
        : await fetch(
            `/api/kith/fin-accounts/${encodeURIComponent(row.accountId)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ displayName: value }),
            },
          );
    if (!response.ok) throw new Error("rename failed");
    await queryClient.invalidateQueries({ queryKey: ["balances"] });
  };

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
        accessorKey: "shownName",
        header: "Account",
        size: 180,
        cell: ({ row }) =>
          row.original.feedName === null ? (
            row.original.shownName
          ) : (
            <Detail
              label={row.original.shownName}
              detail={`Originally ${row.original.feedName}`}
            />
          ),
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
    <>
      <DataTable
        id="admin-balances"
        data={rows}
        columns={columns}
        initialSorting={[{ id: "institutionName", desc: false }]}
        onRowClick={setRenaming}
        actions={[{ label: "Rename", onSelect: setRenaming }]}
        searchPlaceholder="Search accounts"
        empty="No linked accounts"
      />
      <RenameAccountDialog
        target={renameTarget}
        onClose={() => setRenaming(null)}
        onSave={(value) => saveRename(renaming!, value)}
      />
    </>
  );
}
