"use client";

// The Banking & Cards screen: one row per `kith.fin_accounts` depository,
// credit, or loan account (see `admin.BANKING_ACCOUNT_TYPES`), a transactions
// table beneath it, and a per-account drawer with recent transactions and a
// balance history.
//
// Not on the change feed, the same reason `balances-table.tsx` is not: the
// unified ledger's tables carry no `kith.changes` triggers. Refetches on
// mount and window refocus, TanStack Query's default -- the right cadence
// for a feed a daily `pull` changes at most once a day.

import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { inputClass, PageHeader, Section } from "@/components/ui/controls";
import { DataTable, Detail, Tag } from "@/components/ui/data-table";
import { Drawer } from "@/components/ui/drawer";
import type {
  BankingAccountDetailData,
  BankingPageData,
  BankingTransactionsPageData,
} from "@/lib/kith/admin-data";
import {
  archiveDate,
  label,
  tableInteger,
  tableMoney,
  tablePercent,
} from "@/lib/kith/format";

type AccountRow = BankingPageData["accounts"][number];
type TransactionRow = BankingPageData["transactions"][number];

const WINDOW_OPTIONS = [
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 180 days" },
  { value: "365", label: "Last year" },
  { value: "all", label: "All time" },
] as const;

type WindowChoice = (typeof WINDOW_OPTIONS)[number]["value"];

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${url} fetch failed`);
  return (await response.json()) as T;
}

function fetchBanking(): Promise<BankingPageData> {
  return fetchJson("/api/kith/admin/banking");
}

function fetchWidenedTransactions(
  days: number | null,
): Promise<BankingTransactionsPageData> {
  return fetchJson(
    days === null
      ? "/api/kith/admin/banking-transactions"
      : `/api/kith/admin/banking-transactions?days=${days}`,
  );
}

function fetchAccountDetail(accountId: string): Promise<BankingAccountDetailData> {
  return fetchJson(
    `/api/kith/admin/banking-accounts/${encodeURIComponent(accountId)}`,
  );
}

function date(value: string | null) {
  return <span className="tabular-nums text-gray-600">{archiveDate(value)}</span>;
}

function money(amount: number | null, currency: string | null) {
  if (amount === null || currency === null) return "";
  return <span className="tabular-nums">{tableMoney(amount, currency)}</span>;
}

/**
 * The stored balance, unsigned -- the same raw figure the Balances page
 * shows. A credit or loan account's `current` is Plaid's own "amount owed"
 * convention (positive), not negated here: two screens reading the same
 * account with opposite signs would read as a bug, not as two views of the
 * same fact. The account's own type tag (credit/loan/mortgage, from the
 * adjacent Type column) is what marks a row as a liability.
 */
function balanceCell(row: AccountRow) {
  return money(row.currentBalance, row.currency);
}

/** Available (depository) or limit and utilization (credit); blank for a
 * loan, which has neither. */
function limitCell(row: AccountRow) {
  const type = (row.type ?? "").toLowerCase();
  if (type === "depository") {
    return row.availableBalance === null || row.currency === null ? (
      ""
    ) : (
      <span className="tabular-nums">
        {tableMoney(row.availableBalance, row.currency)}
      </span>
    );
  }
  if (type === "credit") {
    if (row.limitAmount === null || row.currency === null) return "";
    const utilization =
      row.currentBalance === null
        ? ""
        : ` (${tablePercent(row.currentBalance, row.limitAmount)})`;
    return (
      <span className="tabular-nums">
        {tableMoney(row.limitAmount, row.currency)}
        {utilization}
      </span>
    );
  }
  return "";
}

function accountNameCell(row: AccountRow) {
  const suffix = row.mask === null ? "" : ` ••••${row.mask}`;
  const shownName = `${row.accountName}${suffix}`;
  return row.feedName === row.accountName ? (
    shownName
  ) : (
    <Detail label={shownName} detail={`Originally ${row.feedName}`} />
  );
}

function accountColumns(): ColumnDef<AccountRow, unknown>[] {
  return [
    { id: "institutionName", accessorKey: "institutionName", header: "Institution", size: 150 },
    {
      id: "accountName",
      accessorFn: (row) => `${row.accountName} ${row.mask ?? ""}`,
      header: "Name",
      size: 220,
      cell: ({ row }) => accountNameCell(row.original),
    },
    {
      id: "type",
      accessorFn: (row) => row.subtype ?? row.type ?? "",
      header: "Type",
      size: 130,
      cell: ({ row }) => {
        const value = row.original.subtype ?? row.original.type;
        return value === null ? "" : <Tag>{label(value)}</Tag>;
      },
    },
    {
      id: "currentBalance",
      header: "Balance",
      size: 130,
      meta: { nowrap: true, align: "right" },
      cell: ({ row }) => balanceCell(row.original),
    },
    {
      id: "limit",
      header: "Available / Limit",
      size: 150,
      meta: { nowrap: true, align: "right" },
      cell: ({ row }) => limitCell(row.original),
    },
    {
      id: "balanceAsOf",
      accessorKey: "balanceAsOf",
      header: "Balance as of",
      size: 120,
      meta: { nowrap: true, align: "right" },
      cell: ({ row }) => date(row.original.balanceAsOf),
    },
    {
      id: "lastTransactionAt",
      accessorKey: "lastTransactionAt",
      header: "Last transaction",
      size: 130,
      meta: { nowrap: true, align: "right" },
      cell: ({ row }) => date(row.original.lastTransactionAt),
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
  ];
}

function transactionColumns(): ColumnDef<TransactionRow, unknown>[] {
  return [
    {
      id: "date",
      accessorKey: "date",
      header: "Date",
      size: 110,
      meta: { nowrap: true, align: "right" },
      cell: ({ row }) => date(row.original.date),
    },
    {
      id: "accountName",
      accessorKey: "accountName",
      header: "Account",
      size: 200,
    },
    {
      id: "description",
      accessorFn: (row) => row.description ?? "",
      header: "Description",
      size: 320,
    },
    {
      id: "amount",
      header: "Amount",
      size: 120,
      meta: { nowrap: true, align: "right" },
      cell: ({ row }) => money(row.original.amount, row.original.currency),
    },
    {
      id: "pending",
      header: "",
      size: 90,
      cell: ({ row }) =>
        row.original.pending ? <Tag tone="warn">pending</Tag> : null,
    },
  ];
}

function BalanceHistoryTable({ history }: { history: BankingAccountDetailData["balanceHistory"] }) {
  if (history.length === 0) {
    return <p className="text-sm text-kith-text-muted">No balance history</p>;
  }
  return (
    <table className="w-full text-[13.5px]">
      <thead className="border-b border-kith-border-subtle text-left text-kith-text-secondary">
        <tr>
          <th scope="col" className="py-1 font-medium">As of</th>
          <th scope="col" className="py-1 text-right font-medium">Balance</th>
        </tr>
      </thead>
      <tbody>
        {history.map((point) => (
          <tr key={point.asOf} className="border-b border-kith-border-subtle last:border-b-0">
            <td className="py-1 tabular-nums text-gray-600">{archiveDate(point.asOf)}</td>
            <td className="py-1 text-right tabular-nums">
              {point.current === null || point.currency === null
                ? ""
                : tableMoney(point.current, point.currency)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AccountDrawer({
  account,
  onClose,
}: {
  account: AccountRow | null;
  onClose: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["banking-account-detail", account?.accountId],
    queryFn: () => fetchAccountDetail(account!.accountId),
    enabled: account !== null,
  });

  return (
    <Drawer
      open={account !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={account === null ? "" : `${account.accountName}`}
    >
      {account === null ? null : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 rounded-control border border-kith-border-subtle bg-kith-surface-muted p-3 text-sm">
            <span className="text-kith-text-muted">Institution</span>
            <span className="text-right">{account.institutionName}</span>
            <span className="text-kith-text-muted">Balance</span>
            <span className="text-right tabular-nums">{balanceCell(account)}</span>
            <span className="text-kith-text-muted">Balance as of</span>
            <span className="text-right tabular-nums">{archiveDate(account.balanceAsOf)}</span>
          </div>
          <section>
            <h3 className="kith-section-title mb-2 text-sm">Recent transactions</h3>
            {data === undefined ? (
              <p className="text-sm text-kith-text-muted">Loading…</p>
            ) : (
              <DataTable
                id="admin-banking-account-transactions"
                data={data.transactions}
                columns={transactionColumns().filter((column) => column.id !== "accountName")}
                initialSorting={[{ id: "date", desc: true }]}
                empty="No transactions"
                showSearch={false}
              />
            )}
          </section>
          <section>
            <h3 className="kith-section-title mb-2 text-sm">Balance history</h3>
            {data === undefined ? (
              <p className="text-sm text-kith-text-muted">Loading…</p>
            ) : (
              <BalanceHistoryTable history={data.balanceHistory} />
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

export function BankingTable({ initial }: { initial: BankingPageData }) {
  const { data } = useQuery({
    queryKey: ["banking"],
    queryFn: fetchBanking,
    initialData: initial,
  });

  const [windowChoice, setWindowChoice] = useState<WindowChoice>("90");
  const widened = windowChoice !== "90";
  const { data: widenedData } = useQuery({
    queryKey: ["banking-transactions", windowChoice],
    queryFn: () =>
      fetchWidenedTransactions(windowChoice === "all" ? null : Number(windowChoice)),
    enabled: widened,
  });

  const transactions = widened
    ? (widenedData?.transactions ?? [])
    : data.transactions;
  const transactionsTotal = widened
    ? (widenedData?.total ?? 0)
    : data.transactionsTotal;
  const loadingWidened = widened && widenedData === undefined;

  const [openAccountId, setOpenAccountId] = useState<string | null>(null);
  const openAccount = useMemo(
    () => data.accounts.find((row) => row.accountId === openAccountId) ?? null,
    [data.accounts, openAccountId],
  );

  const accountColumnsMemo = useMemo(() => accountColumns(), []);
  const transactionColumnsMemo = useMemo(() => transactionColumns(), []);

  const windowLabel =
    WINDOW_OPTIONS.find((option) => option.value === windowChoice)?.label ??
    "Last 90 days";

  return (
    <>
      <PageHeader title="Banking & Cards" />
      <Section id="banking-accounts" title="Accounts">
        <DataTable
          id="admin-banking-accounts"
          data={data.accounts}
          columns={accountColumnsMemo}
          initialSorting={[{ id: "institutionName", desc: false }]}
          onRowClick={(row) => setOpenAccountId(row.accountId)}
          searchPlaceholder="Search accounts"
          empty="No banking or card accounts"
        />
      </Section>
      <Section
        id="banking-transactions"
        title="Transactions"
        actions={
          <select
            className={inputClass}
            value={windowChoice}
            onChange={(event) => setWindowChoice(event.target.value as WindowChoice)}
          >
            {WINDOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        }
      >
        <DataTable
          id="admin-banking-transactions"
          data={loadingWidened ? [] : transactions}
          columns={transactionColumnsMemo}
          filterColumns={["accountName"]}
          initialSorting={[{ id: "date", desc: true }]}
          searchPlaceholder="Search description"
          empty={loadingWidened ? "Loading…" : "No transactions"}
        />
        <p className="mt-2 text-xs text-kith-text-muted">
          Showing {tableInteger(transactions.length)} of{" "}
          {tableInteger(transactionsTotal)} transactions ({windowLabel.toLowerCase()})
          {transactions.length < transactionsTotal ? ", capped" : ""}
        </p>
      </Section>
      <AccountDrawer account={openAccount} onClose={() => setOpenAccountId(null)} />
    </>
  );
}
