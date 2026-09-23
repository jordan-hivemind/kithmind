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

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { Info } from "lucide-react";
import { useMemo, useState } from "react";

import { InstitutionAccountDrawer } from "@/components/admin/institution-account-drawer";
import { valueInformationDetail } from "@/components/admin/institutions-value-info";
import {
  RenameAccountDialog,
  type RenameTarget,
} from "@/components/admin/rename-account-dialog";
import { DataTable, Detail, Tag } from "@/components/ui/data-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { InstitutionsPageData } from "@/lib/kith/admin-data";
import { archiveDate, label, tableMoney } from "@/lib/kith/format";
import type { InstitutionRow } from "@/lib/kith/institutions";

const TONE: Record<InstitutionRow["status"], "neutral" | "accent" | "warn"> = {
  fresh: "accent",
  stale: "warn",
  needs_relink: "warn",
  inactive: "neutral",
  no_feed: "neutral",
};

const EMPTY: Record<InstitutionsPageData["state"], string> = {
  read: "No institutions",
  not_configured: "Finance archive not configured",
  unavailable: "Finance archive unavailable",
};

/** The one place the partial-read tooltip's wording lives. */
export const TRUNCATED_DETAIL =
  "The archive holds more accounts than this read followed. Rows below are a prefix, not the whole inventory.";

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
  const queryClient = useQueryClient();
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
  const [renaming, setRenaming] = useState<InstitutionRow | null>(null);
  const renameTarget: RenameTarget | null =
    renaming === null
      ? null
      : renaming.archive !== null
        ? {
            id: renaming.id,
            label: renaming.name,
            initialValue: renaming.override?.displayName ?? "",
            placeholder: renaming.archive.name,
          }
        : {
            id: renaming.id,
            label: renaming.name,
            // `renaming.name` already is the owner's name when `feedName`
            // is set (`plaidOnlyChild`'s `accountName` is `displayName ??
            // feedName`), so an active override's own text is recovered
            // from it rather than needing a second raw field on the row.
            initialValue: renaming.feedName === null ? "" : renaming.name,
            placeholder: renaming.feedName ?? renaming.name,
          };
  const saveRename = async (row: InstitutionRow, value: string | null) => {
    const response =
      row.archive !== null
        ? await fetch(
            `/api/kith/finance-accounts/${encodeURIComponent(row.id)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                displayName: value,
                accountLast4: row.override?.accountLast4 ?? null,
                accountType: row.override?.accountType ?? null,
                closed: row.override?.closed ?? false,
              }),
            },
          )
        : await fetch(
            `/api/kith/fin-accounts/${encodeURIComponent(row.finAccountId!)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ displayName: value }),
            },
          );
    if (!response.ok) throw new Error("rename failed");
    await queryClient.invalidateQueries({ queryKey: ["institutions"] });
  };
  const institutions = useMemo(
    () =>
      hideEmpty
        ? data.institutions.flatMap((group) => {
            const children = group.children?.filter((child) => !child.empty);
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
        size: 180,
        cell: ({ row }) =>
          row.original.feedName === null ? (
            row.original.name
          ) : (
            <Detail
              label={row.original.name}
              detail={`Originally ${row.original.feedName}`}
            />
          ),
      },
      {
        id: "accountLast4",
        accessorKey: "accountLast4",
        header: "Last 4",
        size: 80,
        meta: { nowrap: true, align: "right" },
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
        // FIN-STATUS-1: the account's current value, from the feed
        // (`kith.fin_accounts`, migration 048_finance_unify.sql) when the
        // account is linked to a live Plaid account, otherwise the
        // archive's own parsed statement figure. `valueSource` (a "feed" or
        // "statement" muted tag in the tooltip) says which, since the same
        // column can no longer be told apart by which of two columns it sat
        // in the way PR 430's separate "Live value" did.
        id: "currentValue",
        accessorKey: "currentValue",
        header: "Current value",
        size: 132,
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) =>
          row.original.currentValue === null ||
          row.original.currentValueCurrency === null ? (
            ""
          ) : (
            <Detail
              label={
                <span
                  className={
                    row.original.currentValueStale ||
                    row.original.status === "inactive"
                      ? "text-kith-text-muted"
                      : undefined
                  }
                >
                  <span className="tabular-nums">
                    {tableMoney(
                      row.original.currentValue,
                      row.original.currentValueCurrency,
                    )}
                  </span>
                </span>
              }
              detail={`as of ${archiveDate(row.original.currentValueAsOf)}${
                row.original.valueSource === null
                  ? ""
                  : ` (${row.original.valueSource})`
              }`}
            />
          ),
      },
      {
        id: "valueInfo",
        header: () => <span className="sr-only">Value information</span>,
        size: 40,
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) => {
          const detail = valueInformationDetail(row.original);
          if (detail === null || row.original.archive === null) return null;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`Show value information for ${row.original.name}`}
                  className="ml-auto inline-flex rounded-control p-1 text-kith-text-muted hover:bg-accent-50 hover:text-kith-action focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-600"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (row.original.archive !== null) setEditing(row.original);
                  }}
                >
                  <Info className="size-4" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{detail}</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "activityFrom",
        accessorKey: "activityFrom",
        size: 110,
        header: "First record",
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) => date(row.original.activityFrom),
      },
      {
        id: "activityTo",
        accessorKey: "activityTo",
        size: 110,
        header: "Latest record",
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) => date(row.original.activityTo),
      },
      {
        id: "latestSnapshotAsOf",
        accessorFn: (row) => row.latestHoldingsObservedAsOf,
        size: 125,
        header: "Holdings as of",
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) => date(row.original.latestHoldingsObservedAsOf),
      },
      {
        id: "status",
        accessorFn: (row) => row.status.replaceAll("_", " "),
        size: 110,
        header: "Status",
        cell: ({ row }) => (
          <Tag tone={TONE[row.original.status]}>
            <Detail
              label={row.original.status.replaceAll("_", " ")}
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
        // A Plaid-only leaf row has no archive record for the Edit drawer to
        // show (`row.archive === null`); it opens the compact Rename dialog
        // instead, the only edit affordance that kind of row has.
        onRowClick={(row) =>
          row.archive === null ? setRenaming(row) : setEditing(row)
        }
        actions={[
          {
            label: "Edit",
            onSelect: setEditing,
            hidden: (row) => row.archive === null,
          },
          {
            label: "Rename",
            onSelect: setRenaming,
            // A group row (an institution header) has no name of its own to
            // rename; every leaf row -- archive-linked or Plaid-only -- does.
            hidden: (row) => row.accounts !== null,
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
      <InstitutionAccountDrawer
        row={editing}
        onClose={() => setEditing(null)}
      />
      <RenameAccountDialog
        target={renameTarget}
        onClose={() => setRenaming(null)}
        onSave={(value) => saveRename(renaming!, value)}
      />
    </div>
  );
}
