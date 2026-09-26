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
import { Check } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  emptyEntry,
  emptyInvestment,
  type EntryDraft,
  EntryDrawer,
  type InvestmentDraft,
  InvestmentDrawer,
  type InvestmentDrawerContext,
  today,
} from "@/components/admin/investment-drawers";
import { ImportDrawer } from "@/components/admin/investment-import-drawer";
import {
  DataTable,
  Detail,
  type RowAction,
  Tag,
} from "@/components/ui/data-table";
import { buttonClass, primaryButtonClass } from "@/components/ui/drawer";
import {
  archiveDate,
  tableAccountingMoney,
  tableDecimal,
} from "@/lib/kith/format";
import {
  COMMITMENT_ENTRY_TYPE,
  commitmentWrite,
} from "@/lib/kith/investment-commitment";
import { entryPatchFields } from "@/lib/kith/investment-entry-patch";
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
  | ({ kind: "entry" } & Entry)
  /** Stands in for the entries of an expanded investment that has none, so
   * that every investment row expands on click. */
  | { kind: "empty"; id: string; investmentId: string };

const STATUS_TONE: Record<string, "neutral" | "accent" | "warn"> = {
  active: "accent",
  closed: "neutral",
  written_off: "warn",
};

function Money({ value }: { value: string }) {
  return (
    <span className="tabular-nums text-gray-900">
      {tableAccountingMoney(value)}
    </span>
  );
}

function Amount({ value, currency }: { value: string; currency: string }) {
  return (
    <span className="tabular-nums text-gray-900">
      {currency === "USD"
        ? tableAccountingMoney(value)
        : `${tableDecimal(value)} ${currency}`}
    </span>
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
  /**
   * The entry's document, date and estimated marker as they were when the
   * drawer opened.
   *
   * A ref and not state, deliberately: nothing renders from it and a re-render
   * must not reset it. It is what `entryPatchFields` compares the draft
   * against, so that a link landing from the change feed while the drawer is
   * open cannot become a write the owner never made.
   */
  const entryAtOpen = useRef<{
    documentId: string | null;
    entryDate: string;
    dateIsEstimated: boolean;
  } | null>(null);
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
      investments.map((investment) => {
        // The commitment is a property of the investment, edited in its
        // drawer and shown in the Committed column, not a ledger event.
        const children: Row[] = (entries ?? [])
          .filter(
            (entry) =>
              entry.investmentId === investment.id &&
              entry.entryType !== COMMITMENT_ENTRY_TYPE,
          )
          .map((entry) => ({ ...entry, kind: "entry" as const }));
        return {
          ...investment,
          kind: "investment" as const,
          hasDocuments:
            investment.documentCount > 0 ? ("yes" as const) : ("no" as const),
          children:
            children.length === 0 && entries !== undefined
              ? [
                  {
                    kind: "empty" as const,
                    id: `empty:${investment.id}`,
                    investmentId: investment.id,
                  },
                ]
              : children,
        };
      }),
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
        // `documentId`, `entryDate` and `dateIsEstimated` go only when the
        // owner changed them, measured against the values the drawer was
        // OPENED with -- never against the live row, which the change feed
        // refreshes underneath an open drawer. `entryPatchFields` is that
        // rule, and it has its own test.
        const patch = entryPatchFields(
          { ...body, dateIsEstimated: draft.dateIsEstimated },
          entryAtOpen.current ?? {
            documentId: body.documentId,
            entryDate: body.entryDate,
            dateIsEstimated: draft.dateIsEstimated,
          },
        );
        await optimistic.mutateAsync({
          apply: () =>
            patchEntries((current) =>
              current.map((entry) =>
                entry.id === entryId ? { ...entry, ...patch } : entry,
              ),
            ),
          run: () =>
            send(
              `/api/kith/investments/${draft.investmentId}/entries`,
              "PATCH",
              { entryId, ...patch },
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
    async (draft: InvestmentDraft, context: InvestmentDrawerContext) => {
      const body = {
        name: draft.name.trim(),
        category: draft.category.trim() === "" ? null : draft.category.trim(),
        signedOn: draft.signedOn === "" ? null : draft.signedOn,
        status: draft.status,
        notes: draft.notes.trim() === "" ? null : draft.notes.trim(),
      };
      // The commitment is stored as the investment's `commitment` entry;
      // `commitmentWrite` picks the one entry write that makes it match.
      const writeCommitment = async (investmentId: string) => {
        const write = commitmentWrite({
          entries: context.entries,
          amount: draft.commitment,
          currency: context.commitmentCurrency,
          signedOn: body.signedOn,
          today: today(),
        });
        if (write === null) return;
        await send(
          `/api/kith/investments/${investmentId}/entries`,
          write.method,
          write.body,
        );
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
          run: async () => {
            await send("/api/kith/investments", "PATCH", { id, ...body });
            await writeCommitment(id);
          },
        });
        return;
      }
      if (spaceId === null) return;
      await optimistic.mutateAsync({
        // Nothing to show optimistically: the new row's id and its computed
        // totals are the server's to mint, and inventing a row without them
        // would flicker a different row than the one that lands.
        apply: () => {},
        run: async () => {
          const response = await send("/api/kith/investments", "POST", {
            spaceId,
            ...body,
          });
          const { id } = (await response.json()) as { id: string };
          await writeCommitment(id);
        },
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
          row.kind === "investment"
            ? row.name
            : row.kind === "entry"
              ? row.entryDate
              : "",
        header: "Investment",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Detail label={row.original.name} detail={row.original.notes} />
          ) : row.original.kind === "entry" ? (
            // Inline, not a block: the table puts an indent span before a
            // child row's first cell, and a block beside it drops to a second
            // line and sits below the rest of the row.
            <span className="tabular-nums text-gray-500">
              {archiveDate(row.original.entryDate)}
            </span>
          ) : (
            <span className="text-gray-400">No entries</span>
          ),
      },
      {
        id: "category",
        accessorFn: (row) =>
          row.kind === "investment"
            ? (row.category ?? "")
            : row.kind === "entry"
              ? row.entryType
              : "",
        header: "Category",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            row.original.category === null ? null : (
              <Tag>{row.original.category}</Tag>
            )
          ) : row.original.kind === "entry" ? (
            <Tag>{row.original.entryType}</Tag>
          ) : null,
      },
      {
        id: "amount",
        accessorFn: (row) => (row.kind === "entry" ? row.amount : ""),
        header: "Amount",
        meta: { nowrap: true, align: "right" },
        cell: ({ row }) =>
          row.original.kind !== "entry" ? null : (
            <Amount
              value={row.original.amount}
              currency={row.original.currency}
            />
          ),
      },
      {
        id: "committed",
        header: "Committed",
        meta: { nowrap: true, align: "right" },
        accessorFn: (row) =>
          row.kind === "investment" ? row.totals.usd.committed : "",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Money value={row.original.totals.usd.committed} />
          ) : row.original.kind !== "entry" ||
            row.original.currency === "USD" ? null : (
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
        meta: { nowrap: true, align: "right" },
        accessorFn: (row) =>
          row.kind === "investment" ? row.totals.usd.sent : "",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Detail
              label={<Money value={row.original.totals.usd.sent} />}
              detail={`Capital calls only. Fees ${tableDecimal(row.original.totals.usd.fees)}.`}
            />
          ) : row.original.kind === "entry" ? (
            <span className="truncate text-gray-600">
              {row.original.note ?? ""}
            </span>
          ) : null,
      },
      {
        id: "outstanding",
        header: "Outstanding",
        meta: { nowrap: true, align: "right" },
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
        meta: { nowrap: true, align: "right" },
        accessorFn: (row) =>
          row.kind === "investment" ? row.totals.usd.received : "",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            <Money value={row.original.totals.usd.received} />
          ) : null,
      },
      {
        id: "documents",
        header: "Documents",
        meta: { nowrap: true, align: "right" },
        accessorFn: (row) =>
          row.kind === "investment"
            ? row.documentCount
            : row.kind === "entry"
              ? (row.documentId ?? "")
              : "",
        cell: ({ row }) =>
          row.original.kind === "investment" ? (
            row.original.documentCount > 0 ? (
              <span
                role="img"
                aria-label="Has documents"
                className="ml-auto inline-flex text-emerald-600"
              >
                <Check className="size-4" aria-hidden="true" />
              </span>
            ) : null
          ) : row.original.kind !== "entry" ||
            row.original.documentId === null ? null : (
            <span
              role="img"
              aria-label="Has documents"
              className="ml-auto inline-flex text-emerald-600"
            >
              <Check className="size-4" aria-hidden="true" />
            </span>
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

  // The kebab's Edit item on any row, and a click on an entry row. A click on
  // an investment row expands it instead (every investment row can expand).
  const openEdit = useCallback((row: Row) => {
    if (row.kind === "empty") return;
    if (row.kind === "investment") {
      setEditingInvestmentId(row.id);
      setInvestmentDraft({
        name: row.name,
        category: row.category ?? "",
        signedOn: row.signedOn ?? "",
        status: row.status,
        notes: row.notes ?? "",
        // Filled in by the drawer from the investment's entries.
        commitment: "",
      });
    } else {
      setEditingEntryId(row.id);
      // The snapshot `entryPatchFields` measures against. Taken once, here,
      // when the row goes into the drawer: the live row moves under an open
      // drawer and this must not.
      entryAtOpen.current = {
        documentId: row.documentId,
        entryDate: row.entryDate,
        dateIsEstimated: row.dateIsEstimated,
      };
      setEntryDraft({
        investmentId: row.investmentId,
        entryType: row.entryType,
        entryDate: row.entryDate,
        amount: row.amount,
        currency: row.currency,
        exchangeRate: row.exchangeRate ?? "",
        note: row.note ?? "",
        documentId: row.documentId,
        dateIsEstimated: row.dateIsEstimated,
      });
    }
  }, []);

  const actions = useMemo<RowAction<Row>[]>(
    () => [
      {
        label: "Edit",
        hidden: (row) => row.kind === "empty",
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
            className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-meta text-amber-800"
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
        canExpand={(row) => row.kind === "investment"}
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
