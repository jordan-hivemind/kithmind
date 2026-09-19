"use client";

// Screen 5 (Investments): every investment with its computed totals,
// expanding into its entries.
//
// Reactive in both directions the owner asked for. Every add, edit and delete
// applies to the cache before the request is sent and rolls back with a toast
// if the server refuses it, so the frequent action (adding an entry) never
// waits on a round trip. Changes made anywhere else -- the import, another
// tab, the worker -- arrive through the change feed, which invalidates
// `["investments"]` whenever `investments` or `investment_entries` changes.
//
// No total is computed here. `committed`, `sent`, `outstanding`, `fees` and
// `received` are exact decimal strings produced by one SQL aggregation and
// rendered as text; an optimistic row shows the entry immediately and lets the
// refetch correct the totals, rather than doing money arithmetic in JavaScript
// that would disagree with the database by a cent.

import type { admin } from "@repo/kith-store";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";

import {
  emptyEntry,
  emptyInvestment,
  type EntryDraft,
  EntryDrawer,
  type InvestmentDraft,
  InvestmentDrawer,
  today,
} from "@/components/admin/investment-drawers";
import { ImportDrawer } from "@/components/admin/investment-import-drawer";
import { DataTable, Detail, type RowAction, Tag } from "@/components/ui/data-table";
import { buttonClass, primaryButtonClass } from "@/components/ui/drawer";
import type { ImportPreview } from "@/lib/kith/investment-import";
import type { InvestmentsPageData } from "@/lib/kith/investments-data";
import { useLiveChanges } from "@/lib/kith/use-live-changes";

const WATCHED = {
  investments: ["investments", "investment_entries"],
} as const;

type Payload = Omit<InvestmentsPageData, "spaceIds">;

/** One table row: an investment, or one of its entries. The two kinds share a
 * table because an entry is only ever read under its investment. */
type Row =
  | ({ kind: "investment"; children: Row[] } & admin.InvestmentRow & {
        hasDocuments: "yes" | "no";
      })
  | ({ kind: "entry" } & admin.InvestmentEntry);

const STATUS_TONE: Record<string, "neutral" | "accent" | "warn"> = {
  active: "accent",
  closed: "neutral",
  written_off: "warn",
};

function Money({ value }: { value: string }) {
  return <span className="tabular-nums text-gray-900">{value}</span>;
}

async function send(
  url: string,
  method: string,
  body: unknown,
): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(problem.error ?? "Request failed");
  }
  return response;
}

export function InvestmentsTable({
  initial,
  spaceId,
}: {
  initial: Payload;
  /** Where a new investment is created. Absent when the session administers
   * no space, in which case the add buttons are disabled. */
  spaceId: string | null;
}) {
  useLiveChanges(WATCHED);
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [investmentDraft, setInvestmentDraft] =
    useState<InvestmentDraft | null>(null);
  const [editingInvestmentId, setEditingInvestmentId] = useState<string | null>(
    null,
  );
  const [importing, setImporting] = useState(false);

  const { data } = useQuery({
    queryKey: ["investments"],
    queryFn: async (): Promise<Payload> => {
      const response = await fetch("/api/kith/investments", {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("investments fetch failed");
      return (await response.json()) as Payload;
    },
    initialData: initial,
  });

  /**
   * One optimistic mutation shape for all six writes.
   *
   * `onMutate` cancels in-flight refetches, snapshots the cache and applies
   * `apply` to it; `onError` puts the snapshot back and says why; `onSettled`
   * invalidates so the server's own totals replace the optimistic rows. This
   * is TanStack Query's documented rollback pattern, written once rather than
   * six times.
   */
  const optimistic = useMutation<
    void,
    Error,
    { apply: (current: Payload) => Payload; run: () => Promise<unknown> },
    { previous: Payload | undefined }
  >({
    mutationFn: async ({ run }) => {
      await run();
    },
    onMutate: async ({ apply }) => {
      await queryClient.cancelQueries({ queryKey: ["investments"] });
      const previous = queryClient.getQueryData<Payload>(["investments"]);
      if (previous) {
        queryClient.setQueryData<Payload>(["investments"], apply(previous));
      }
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["investments"], context.previous);
      }
      setToast(error.message);
      setTimeout(() => setToast(null), 6_000);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["investments"] });
    },
  });

  const rows = useMemo<Row[]>(
    () =>
      data.investments.map((investment) => ({
        ...investment,
        kind: "investment" as const,
        hasDocuments: investment.documentCount > 0 ? ("yes" as const) : ("no" as const),
        children: data.entries
          .filter((entry) => entry.investmentId === investment.id)
          .map((entry) => ({ ...entry, kind: "entry" as const })),
      })),
    [data],
  );

  const saveEntry = useCallback(
    async (draft: EntryDraft) => {
      const body = {
        entryType: draft.entryType,
        entryDate: draft.entryDate,
        amount: draft.amount,
        currency: draft.currency,
        exchangeRate: draft.currency === "USD" ? null : draft.exchangeRate,
        note: draft.note.trim() === "" ? null : draft.note.trim(),
        documentId: draft.documentId,
      };
      if (editingEntryId !== null) {
        const entryId = editingEntryId;
        await optimistic.mutateAsync({
          apply: (current) => ({
            ...current,
            entries: current.entries.map((entry) =>
              entry.id === entryId
                ? { ...entry, ...body, exchangeRate: body.exchangeRate }
                : entry,
            ),
          }),
          run: () =>
            send(
              `/api/kith/investments/${draft.investmentId}/entries`,
              "PATCH",
              { entryId, ...body },
            ),
        });
        return;
      }
      // The optimistic row carries a placeholder id. The refetch in
      // `onSettled` replaces it with the stored row, so nothing downstream
      // ever writes against this id.
      const placeholder = `pending:${Date.now()}`;
      await optimistic.mutateAsync({
        apply: (current) => ({
          ...current,
          entries: [
            ...current.entries,
            {
              id: placeholder,
              spaceId: "",
              investmentId: draft.investmentId,
              evidenceSpanId: null,
              ...body,
            } as admin.InvestmentEntry,
          ],
        }),
        run: () =>
          send(`/api/kith/investments/${draft.investmentId}/entries`, "POST", body),
      });
    },
    [editingEntryId, optimistic],
  );

  const saveInvestment = useCallback(
    async (draft: InvestmentDraft) => {
      const body = {
        name: draft.name.trim(),
        category: draft.category.trim() === "" ? null : draft.category.trim(),
        signedOn: draft.signedOn === "" ? null : draft.signedOn,
        status: draft.status,
        notes: draft.notes.trim() === "" ? null : draft.notes.trim(),
      };
      if (editingInvestmentId !== null) {
        const id = editingInvestmentId;
        await optimistic.mutateAsync({
          apply: (current) => ({
            ...current,
            investments: current.investments.map((investment) =>
              investment.id === id ? { ...investment, ...body } : investment,
            ),
          }),
          run: () => send("/api/kith/investments", "PATCH", { id, ...body }),
        });
        return;
      }
      if (spaceId === null) return;
      await optimistic.mutateAsync({
        apply: (current) => current,
        run: () => send("/api/kith/investments", "POST", { spaceId, ...body }),
      });
    },
    [editingInvestmentId, optimistic, spaceId],
  );

  /**
   * The import, run from the approved preview.
   *
   * Sequential rather than concurrent: the ledger rows need the investment ids
   * the summary rows create, and 39 investments with a few hundred entries is
   * not worth a dependency graph. Every write carries its row key, so a run
   * interrupted halfway is resumed by importing the same file again.
   */
  const runImport = useCallback(
    async (preview: ImportPreview) => {
      const byName = new Map(
        data.investments.map((investment) => [
          investment.name.toLowerCase(),
          investment.id,
        ]),
      );
      let created = 0;
      let entries = 0;

      const ensure = async (
        name: string,
        fields?: Partial<InvestmentDraft>,
      ): Promise<string | null> => {
        const key = name.toLowerCase();
        const known = byName.get(key);
        if (known !== undefined) return known;
        if (spaceId === null) return null;
        try {
          const response = await send("/api/kith/investments", "POST", {
            spaceId,
            name,
            category: fields?.category ?? null,
            signedOn: fields?.signedOn === "" ? null : (fields?.signedOn ?? null),
            status: fields?.status ?? "active",
            notes: fields?.notes ?? null,
          });
          const { id } = (await response.json()) as { id: string };
          byName.set(key, id);
          created += 1;
          return id;
        } catch {
          // Another run created it, or the name collided. Neither is a reason
          // to stop: the rest of the file is still importable.
          return null;
        }
      };

      for (const investment of preview.summary) {
        const id = await ensure(investment.name, {
          category: investment.category ?? "",
          signedOn: investment.signedOn ?? "",
          status: investment.status,
          notes: investment.notes ?? "",
        });
        if (id === null || investment.committed === null) continue;
        await send(`/api/kith/investments/${id}/entries`, "POST", {
          entryType: "commitment",
          entryDate: investment.signedOn ?? today(),
          amount: investment.committed,
          currency: "USD",
          importKey: investment.importKey,
        }).then(() => {
          entries += 1;
        });
      }

      for (const entry of preview.ledger) {
        const id = await ensure(entry.investmentName);
        if (id === null) continue;
        await send(`/api/kith/investments/${id}/entries`, "POST", {
          entryType: entry.entryType,
          entryDate: entry.entryDate,
          amount: entry.amount,
          currency: entry.currency,
          exchangeRate: entry.exchangeRate,
          note: entry.note,
          importKey: entry.importKey,
        }).then(() => {
          entries += 1;
        });
      }

      await queryClient.invalidateQueries({ queryKey: ["investments"] });
      return { investments: created, entries };
    },
    [data.investments, queryClient, spaceId],
  );

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) =>
          row.kind === "investment" ? row.name : row.entryDate,
        header: "Investment",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Detail
              label={row.original.name}
              detail={row.original.notes}
            />
          ) : (
            <span className="tabular-nums text-gray-500">
              {row.original.entryDate}
            </span>
          ),
      },
      {
        id: "category",
        accessorFn: (row) =>
          row.kind === "investment" ? (row.category ?? "") : row.entryType,
        header: "Category",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            row.original.category === null ? null : (
              <Tag>{row.original.category}</Tag>
            )
          ) : (
            <Tag>{row.original.entryType}</Tag>
          ),
      },
      {
        id: "signedOn",
        accessorFn: (row) =>
          row.kind === "investment" ? (row.signedOn ?? "") : row.amount,
        header: "Signed",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <span className="tabular-nums text-gray-600">
              {row.original.signedOn ?? ""}
            </span>
          ) : (
            <span className="tabular-nums">
              {row.original.amount} {row.original.currency}
            </span>
          ),
      },
      {
        id: "committed",
        header: "Committed",
        accessorFn: (row) =>
          row.kind === "investment" ? row.totals.usd.committed : "",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Money value={row.original.totals.usd.committed} />
          ) : row.original.currency === "USD" ? null : (
            // The USD value of a non-USD entry, at the rate stored with it.
            <Detail
              label={
                <span className="tabular-nums text-gray-500">
                  {row.original.currency} × {row.original.exchangeRate}
                </span>
              }
              detail="Converted at the rate recorded with this entry"
            />
          ),
      },
      {
        id: "sent",
        header: "Sent",
        accessorFn: (row) => (row.kind === "investment" ? row.totals.usd.sent : ""),
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Detail
              label={<Money value={row.original.totals.usd.sent} />}
              detail={`Capital calls only. Fees ${row.original.totals.usd.fees}.`}
            />
          ) : (
            <span className="truncate text-gray-600">
              {row.original.note ?? ""}
            </span>
          ),
      },
      {
        id: "outstanding",
        header: "Outstanding",
        accessorFn: (row) =>
          row.kind === "investment" ? row.totals.usd.outstanding : "",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Detail
              label={<Money value={row.original.totals.usd.outstanding} />}
              detail="Computed: committed minus sent, never below zero"
            />
          ) : null,
      },
      {
        id: "received",
        header: "Received",
        accessorFn: (row) =>
          row.kind === "investment" ? row.totals.usd.received : "",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Money value={row.original.totals.usd.received} />
          ) : null,
      },
      {
        id: "documents",
        header: "Docs",
        accessorFn: (row) =>
          row.kind === "investment" ? row.documentCount : (row.documentId ?? ""),
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Detail
              label={
                <span className="tabular-nums">{row.original.documentCount}</span>
              }
              detail={
                row.original.unlinkedDocumentCount === 0
                  ? null
                  : `${row.original.unlinkedDocumentCount} unlinked`
              }
            />
          ) : row.original.documentId === null ? null : (
            <Tag tone="accent" title={row.original.documentId}>
              linked
            </Tag>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (row) => (row.kind === "investment" ? row.status : ""),
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Tag tone={STATUS_TONE[row.original.status] ?? "neutral"}>
              {row.original.status}
            </Tag>
          ) : null,
      },
    ],
    [],
  );

  const actions = useMemo<RowAction<Row>[]>(
    () => [
      {
        label: "Edit",
        hidden: () => false,
        onSelect: (row) => {
          if (row.kind === "investment") {
            setEditingInvestmentId(row.id);
            setInvestmentDraft({
              name: row.name,
              category: row.category ?? "",
              signedOn: row.signedOn ?? "",
              status: row.status,
              notes: row.notes ?? "",
            });
          } else {
            setEditingEntryId(row.id);
            setEntryDraft({
              investmentId: row.investmentId,
              entryType: row.entryType,
              entryDate: row.entryDate,
              amount: row.amount,
              currency: row.currency,
              exchangeRate: row.exchangeRate ?? "",
              note: row.note ?? "",
              documentId: row.documentId,
            });
          }
        },
      },
      {
        label: "Archive",
        hidden: (row) => row.kind !== "investment",
        onSelect: (row) => {
          if (row.kind !== "investment") return;
          void optimistic.mutateAsync({
            apply: (current) => ({
              ...current,
              investments: current.investments.filter(
                (investment) => investment.id !== row.id,
              ),
            }),
            run: () => send("/api/kith/investments", "DELETE", { id: row.id }),
          });
        },
      },
      {
        label: "Delete",
        hidden: (row) => row.kind !== "entry",
        onSelect: (row) => {
          if (row.kind !== "entry") return;
          void optimistic.mutateAsync({
            apply: (current) => ({
              ...current,
              entries: current.entries.filter((entry) => entry.id !== row.id),
            }),
            run: () =>
              send(
                `/api/kith/investments/${row.investmentId}/entries`,
                "DELETE",
                { entryId: row.id },
              ),
          });
        },
      },
    ],
    [optimistic],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={data.investments.length === 0}
          onClick={() => {
            setEditingEntryId(null);
            setEntryDraft(emptyEntry(data.investments[0]?.id ?? ""));
          }}
        >
          Add entry
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={spaceId === null}
          onClick={() => {
            setEditingInvestmentId(null);
            setInvestmentDraft(emptyInvestment());
          }}
        >
          Add investment
        </button>
        <button
          type="button"
          aria-label="More"
          className={buttonClass}
          disabled={spaceId === null}
          onClick={() => setImporting(true)}
        >
          &#8942;
        </button>
        {toast === null ? null : (
          <span
            role="status"
            className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800"
          >
            {toast}
          </span>
        )}
      </div>

      <DataTable
        data={rows}
        columns={columns}
        getSubRows={(row) => (row.kind === "investment" ? row.children : undefined)}
        filterColumns={["category", "status", "hasDocuments"]}
        initialSorting={[{ id: "name", desc: false }]}
        actions={actions}
        searchPlaceholder="Search investments"
        empty="No investments"
      />

      {entryDraft === null ? null : (
        <EntryDrawer
          open
          onOpenChange={(open) => {
            if (!open) {
              setEntryDraft(null);
              setEditingEntryId(null);
            }
          }}
          investments={data.investments}
          initial={entryDraft}
          editingEntryId={editingEntryId}
          onSave={saveEntry}
        />
      )}

      {investmentDraft === null ? null : (
        <InvestmentDrawer
          open
          onOpenChange={(open) => {
            if (!open) {
              setInvestmentDraft(null);
              setEditingInvestmentId(null);
            }
          }}
          initial={investmentDraft}
          editingId={editingInvestmentId}
          onSave={saveInvestment}
        />
      )}

      <ImportDrawer
        open={importing}
        onOpenChange={setImporting}
        onImport={runImport}
      />
    </div>
  );
}
