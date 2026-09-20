"use client";

// Screen 5 (Investments): every investment with its computed totals,
// expanding into its entries.
//
// Two reads, not one. The investments and their totals come from
// `["investments"]`; an investment's entries are fetched when its row is
// expanded, under `["investment-entries", ...]`. Loading every entry in the
// household up front was the earlier shape and had a ceiling the owner could
// walk into and never clear.
//
// Reactive in both directions the owner asked for. Every add, edit and delete
// applies to the cache before the request is sent and rolls back with a toast
// if the server refuses it, so the frequent action (adding an entry) never
// waits on a round trip. Changes made anywhere else -- the import, another
// tab, the worker -- arrive through the change feed.
//
// No total is computed here. `committed`, `sent`, `outstanding`, `fees` and
// `received` are exact decimal strings produced by one SQL aggregation and
// rendered as text; an optimistic write shows the entry immediately and lets
// the refetch correct the totals, rather than doing money arithmetic in
// JavaScript that would disagree with the database by a cent.

import type { admin } from "@repo/kith-store";
import {
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";

import {
  emptyEntry,
  emptyInvestment,
  type EntryDraft,
  EntryDrawer,
  type InvestmentDraft,
  InvestmentDrawer,
} from "@/components/admin/investment-drawers";
import { ImportDrawer } from "@/components/admin/investment-import-drawer";
import {
  DataTable,
  Detail,
  type RowAction,
  Tag,
} from "@/components/ui/data-table";
import { buttonClass, primaryButtonClass } from "@/components/ui/drawer";
import { archiveDate, tableDecimal, tableInteger } from "@/lib/kith/format";
import {
  type ImportPreview,
  type ImportWriter,
  planImport,
  runImport,
} from "@/lib/kith/investment-import";
import { useLiveChanges } from "@/lib/kith/use-live-changes";

const WATCHED = {
  investments: ["investments", "investment_entries"],
  "investment-entries": ["investment_entries"],
} as const;

const INVESTMENTS_KEY: QueryKey = ["investments"];
const ENTRIES_KEY: QueryKey = ["investment-entries"];

type Investment = admin.InvestmentRow;
type Entry = admin.InvestmentEntry;

/** One table row: an investment, or one of its entries. The two kinds share a
 * table because an entry is only ever read under its investment. */
type Row =
  | ({ kind: "investment"; children: Row[] } & Investment & {
        hasDocuments: "yes" | "no";
      })
  | ({ kind: "entry" } & Entry);

const STATUS_TONE: Record<string, "neutral" | "accent" | "warn"> = {
  active: "accent",
  closed: "neutral",
  written_off: "warn",
};

function Money({ value }: { value: string }) {
  return (
    <span className="tabular-nums text-gray-900">{tableDecimal(value)}</span>
  );
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
  initial: Investment[];
  /** Where a new investment is created. Absent when the session administers
   * no space, in which case the add buttons are disabled. */
  spaceId: string | null;
}) {
  useLiveChanges(WATCHED);
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [investmentDraft, setInvestmentDraft] =
    useState<InvestmentDraft | null>(null);
  const [editingInvestmentId, setEditingInvestmentId] = useState<string | null>(
    null,
  );
  const [importing, setImporting] = useState(false);

  const { data: investments } = useQuery({
    queryKey: INVESTMENTS_KEY,
    queryFn: async (): Promise<Investment[]> => {
      const response = await fetch("/api/kith/investments", {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("investments fetch failed");
      return ((await response.json()) as { investments: Investment[] })
        .investments;
    },
    initialData: initial,
  });

  // The entries of the rows that are open, and only those. The key carries the
  // sorted id list, so opening a second row is a new query rather than a
  // mutation of this one, and the change feed invalidates the whole prefix.
  const openIds = useMemo(() => [...expandedIds].sort(), [expandedIds]);
  const { data: entries } = useQuery({
    queryKey: [...ENTRIES_KEY, openIds],
    enabled: openIds.length > 0,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<Entry[]> => {
      const pages = await Promise.all(
        openIds.map(async (id) => {
          const response = await fetch(`/api/kith/investments/${id}/entries`, {
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
          });
          if (!response.ok) throw new Error("entries fetch failed");
          return ((await response.json()) as { entries: Entry[] }).entries;
        }),
      );
      return pages.flat();
    },
  });

  /**
   * One optimistic mutation shape for all six writes.
   *
   * `onMutate` cancels in-flight refetches, snapshots every investments and
   * entries query, then lets `apply` edit the caches; `onError` puts every
   * snapshot back and says why; `onSettled` invalidates so the server's own
   * totals replace the optimistic rows. Both caches are snapshotted because an
   * entry write changes the entries list *and* the investment's totals, and a
   * rollback that restored one of them would leave the screen inconsistent
   * with itself.
   */
  const optimistic = useMutation<
    void,
    Error,
    { apply: () => void; run: () => Promise<unknown> },
    { previous: [QueryKey, unknown][] }
  >({
    mutationFn: async ({ run }) => {
      await run();
    },
    onMutate: async ({ apply }) => {
      await queryClient.cancelQueries({ queryKey: INVESTMENTS_KEY });
      await queryClient.cancelQueries({ queryKey: ENTRIES_KEY });
      const previous = [
        ...queryClient.getQueriesData({ queryKey: INVESTMENTS_KEY }),
        ...queryClient.getQueriesData({ queryKey: ENTRIES_KEY }),
      ];
      apply();
      return { previous };
    },
    onError: (error, _variables, context) => {
      for (const [key, value] of context?.previous ?? []) {
        queryClient.setQueryData(key, value);
      }
      setToast(error.message);
      setTimeout(() => setToast(null), 6_000);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: INVESTMENTS_KEY });
      void queryClient.invalidateQueries({ queryKey: ENTRIES_KEY });
    },
  });

  const patchEntries = useCallback(
    (change: (rows: Entry[]) => Entry[]) => {
      queryClient.setQueriesData<Entry[]>({ queryKey: ENTRIES_KEY }, (rows) =>
        rows === undefined ? rows : change(rows),
      );
    },
    [queryClient],
  );

  const rows = useMemo<Row[]>(
    () =>
      investments.map((investment) => ({
        ...investment,
        kind: "investment" as const,
        hasDocuments:
          investment.documentCount > 0 ? ("yes" as const) : ("no" as const),
        children: (entries ?? [])
          .filter((entry) => entry.investmentId === investment.id)
          .map((entry) => ({ ...entry, kind: "entry" as const })),
      })),
    [investments, entries],
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
          apply: () =>
            patchEntries((current) =>
              current.map((entry) =>
                entry.id === entryId ? { ...entry, ...body } : entry,
              ),
            ),
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
        apply: () =>
          patchEntries((current) => [
            ...current,
            {
              id: placeholder,
              spaceId: "",
              investmentId: draft.investmentId,
              evidenceSpanId: null,
              ...body,
            } as Entry,
          ]),
        run: () =>
          send(
            `/api/kith/investments/${draft.investmentId}/entries`,
            "POST",
            body,
          ),
      });
    },
    [editingEntryId, optimistic, patchEntries],
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
          apply: () =>
            queryClient.setQueryData<Investment[]>(INVESTMENTS_KEY, (current) =>
              current?.map((investment) =>
                investment.id === id ? { ...investment, ...body } : investment,
              ),
            ),
          run: () => send("/api/kith/investments", "PATCH", { id, ...body }),
        });
        return;
      }
      if (spaceId === null) return;
      await optimistic.mutateAsync({
        // Nothing to show optimistically: the new row's id and its computed
        // totals are the server's to mint, and inventing a row without them
        // would flicker a different row than the one that lands.
        apply: () => {},
        run: () => send("/api/kith/investments", "POST", { spaceId, ...body }),
      });
    },
    [editingInvestmentId, optimistic, queryClient, spaceId],
  );

  /**
   * The import: plan it, then perform it row by row, then report every row.
   *
   * The orchestration itself is `runImport` in `lib/kith/investment-import.ts`
   * and is tested there against a fake writer. What lives here is only the
   * three things it needs from the network.
   */
  const performImport = useCallback(
    async (preview: ImportPreview) => {
      // Read again, including the archived. The screen's own list excludes
      // them, and a sheet naming an investment the owner archived would then
      // create a live second one beside it: the unique index is partial on
      // live rows, so nothing would have refused the duplicate.
      const response = await fetch("/api/kith/investments?includeArchived=1", {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("investments fetch failed");
      const all = ((await response.json()) as { investments: Investment[] })
        .investments;
      const writer: ImportWriter = {
        existing: new Map(
          all.map((investment) => [
            investment.name.toLowerCase(),
            investment.id,
          ]),
        ),
        createInvestment: async (fields) => {
          if (spaceId === null) throw new Error("No space to import into");
          const response = await send("/api/kith/investments", "POST", {
            spaceId,
            ...fields,
          });
          const { id } = (await response.json()) as { id: string };
          return { id, created: true };
        },
        createEntry: async (investmentId, entryBody) => {
          const response = await send(
            `/api/kith/investments/${investmentId}/entries`,
            "POST",
            entryBody,
          );
          const result = (await response.json()) as { created: boolean };
          return { created: result.created };
        },
      };
      const outcome = await runImport(planImport(preview), writer);
      await queryClient.invalidateQueries({ queryKey: INVESTMENTS_KEY });
      await queryClient.invalidateQueries({ queryKey: ENTRIES_KEY });
      return outcome;
    },
    [queryClient, spaceId],
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
            <Detail label={row.original.name} detail={row.original.notes} />
          ) : (
            <span className="tabular-nums text-gray-500">
              {archiveDate(row.original.entryDate)}
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
        meta: { nowrap: true },
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <span className="tabular-nums text-gray-600">
              {archiveDate(row.original.signedOn)}
            </span>
          ) : (
            <span className="tabular-nums">
              {tableDecimal(row.original.amount)} {row.original.currency}
            </span>
          ),
      },
      {
        id: "committed",
        header: "Committed",
        meta: { nowrap: true },
        accessorFn: (row) =>
          row.kind === "investment" ? row.totals.usd.committed : "",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Money value={row.original.totals.usd.committed} />
          ) : row.original.currency === "USD" ? null : (
            <Detail
              label={
                <span className="tabular-nums text-gray-500">
                  {row.original.exchangeRate === null
                    ? ""
                    : `x ${tableDecimal(row.original.exchangeRate)}`}
                </span>
              }
              detail="Converted at the rate recorded with this entry"
            />
          ),
      },
      {
        id: "sent",
        header: "Sent",
        meta: { nowrap: true },
        accessorFn: (row) =>
          row.kind === "investment" ? row.totals.usd.sent : "",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Detail
              label={<Money value={row.original.totals.usd.sent} />}
              detail={`Capital calls only. Fees ${tableDecimal(row.original.totals.usd.fees)}.`}
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
        meta: { nowrap: true },
        accessorFn: (row) =>
          row.kind === "investment" ? row.totals.usd.outstanding : "",
        cell: ({ row }) => {
          if (row.original.kind !== "investment") return null;
          const { outstanding, overCalled } = row.original.totals.usd;
          // An over-call is the one case a bare number reads backwards, so it
          // gets a tag of its own rather than a minus sign to notice.
          if (overCalled !== "0.00") {
            return (
              <Detail
                label={
                  <Tag tone="warn">over-called {tableDecimal(overCalled)}</Tag>
                }
                detail="Computed: sent exceeds committed by this much"
              />
            );
          }
          return (
            <Detail
              label={<Money value={outstanding} />}
              detail="Computed: committed minus sent"
            />
          );
        },
      },
      {
        id: "received",
        header: "Received",
        meta: { nowrap: true },
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
        meta: { nowrap: true },
        accessorFn: (row) =>
          row.kind === "investment"
            ? row.documentCount
            : (row.documentId ?? ""),
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Detail
              label={
                <span className="tabular-nums">
                  {tableInteger(row.original.documentCount)}
                </span>
              }
              detail={
                row.original.unlinkedDocumentCount === 0
                  ? null
                  : `${tableInteger(row.original.unlinkedDocumentCount)} unlinked`
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

  // Shared by the kebab's Edit item and clicking the row: opening the same
  // drawer either way is the point of making the row itself a target.
  const openEdit = useCallback((row: Row) => {
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
  }, []);

  const actions = useMemo<RowAction<Row>[]>(
    () => [
      {
        label: "Edit",
        onSelect: openEdit,
      },
      {
        label: "Archive",
        hidden: (row) => row.kind !== "investment",
        danger: true,
        onSelect: (row) => {
          if (row.kind !== "investment") return;
          void optimistic.mutateAsync({
            apply: () =>
              queryClient.setQueryData<Investment[]>(
                INVESTMENTS_KEY,
                (current) =>
                  current?.filter((investment) => investment.id !== row.id),
              ),
            run: () => send("/api/kith/investments", "DELETE", { id: row.id }),
          });
        },
      },
      {
        label: "Delete",
        hidden: (row) => row.kind !== "entry",
        danger: true,
        onSelect: (row) => {
          if (row.kind !== "entry") return;
          void optimistic.mutateAsync({
            apply: () =>
              patchEntries((current) =>
                current.filter((entry) => entry.id !== row.id),
              ),
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
    [openEdit, optimistic, patchEntries, queryClient],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={investments.length === 0}
          onClick={() => {
            setEditingEntryId(null);
            setEntryDraft(emptyEntry(investments[0]?.id ?? ""));
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
        id="admin-investments"
        data={rows}
        columns={columns}
        getSubRows={(row) =>
          row.kind === "investment" ? row.children : undefined
        }
        canExpand={(row) => row.kind === "investment" && row.entryCount > 0}
        onExpandChange={(row, expanded) => {
          if (row.kind !== "investment") return;
          setExpandedIds((current) =>
            expanded
              ? current.includes(row.id)
                ? current
                : [...current, row.id]
              : current.filter((id) => id !== row.id),
          );
        }}
        filterColumns={["category", "status", "hasDocuments"]}
        initialSorting={[{ id: "name", desc: false }]}
        actions={actions}
        onRowClick={openEdit}
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
          investments={investments}
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
        onImport={performImport}
      />
    </div>
  );
}
