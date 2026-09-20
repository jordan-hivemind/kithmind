"use client";

// The Needs attention screen (ADM-8a): the first slice of section 5 of
// docs/plans/2026-09-19-investment-document-matching.md -- the quiet,
// dismissible queue itself. Low-priority rows appear by default so the owner
// can discover the working queue, while their `info` severity stays visible.
//
// Owner's principle, quoted here because it drove every default below: this
// is a best-effort personal store; records will be incomplete; do not chase
// the owner for information he does not have; warnings about holes must
// never become so noisy that he misses what he cares about. That is why the
// default view keeps severity visible, lets the owner hide info, and lets an
// item leave quietly when it is not needed.

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { admin } from "@repo/kith-store";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";

import { PageHeader } from "@/components/ui/controls";
import {
  DataTable,
  Detail,
  type RowAction,
  Tag,
} from "@/components/ui/data-table";
import {
  buttonClass,
  Drawer,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
import type {
  AttentionFilter,
  DismissReason,
} from "@/lib/kith/attention-schemas";
import { SNOOZE_PRESETS_DAYS } from "@/lib/kith/attention-schemas";
import { useLiveChanges } from "@/lib/kith/use-live-changes";

const WATCHED = { attention: ["corrections", "attention_mutes"] } as const;
const ATTENTION_KEY = ["attention"];

type Item = admin.AttentionItem;
type AttentionPage = { items: Item[]; nextCursor: string | null };

const SEVERITY_TONE: Record<Item["severity"], "neutral" | "accent" | "warn"> = {
  info: "neutral",
  attention: "accent",
  alert: "warn",
};

const STATE_TONE: Record<Item["state"], "neutral" | "accent" | "warn"> = {
  open: "accent",
  snoozed: "neutral",
  dismissed: "neutral",
  resolved: "neutral",
};

const REASON_COPY: Record<string, string> = {
  quote_not_found: "The quoted evidence could not be found on the cited page.",
  span_unresolved:
    "The quoted evidence was found but could not be linked to a precise passage.",
  unknown_field:
    "The extraction named a field this document type does not use.",
  value_not_in_quote:
    "The extracted value does not appear in the text that was cited for it.",
  money_unparsable: "The extracted amount is not an exact amount and currency.",
  date_unparsable: "The extracted date is not a valid calendar date.",
  date_ambiguous:
    "The extracted numeric date could be read in more than one order.",
  number_unparsable: "The extracted number is not an exact numeric value.",
  line_items_mismatch: "The line items do not add up to the stated total.",
  input_truncated: "Only part of this document was read during extraction.",
  extraction_model_refused:
    "The requested extraction model was unavailable; a default model read the document instead.",
  malformed_statement:
    "The extraction returned a value that could not be used.",
  citation_missing:
    "The extraction gave no supporting citation for this value.",
  correction_orphaned:
    "A previous correction no longer matches the latest extracted line.",
  line_items_partial: "Some line items could not be verified.",
  citation_page_unknown:
    "The extraction cited a page that is not in this document.",
  citation_out_of_range:
    "The extraction cited lines that are not in the cited page.",
  conflicting_values:
    "The extraction returned conflicting values for the same field.",
};

function issueLabel(item: Item): string {
  if (item.detector === "investment_link_date") {
    return "Investment entry date changed";
  }
  if (item.detector !== "extraction") {
    return `Review ${item.targetKind}`;
  }
  const subject = humanize(item.fieldName ?? "this document");
  const kind = humanize(item.document?.kind ?? item.targetKind);
  return `Couldn’t verify ${subject} in this ${kind}`;
}

function issueExplanation(item: Item): string {
  if (item.detector === "investment_link_date") {
    return "A linked document changed this investment entry date.";
  }
  return (
    (item.reason === null ? undefined : REASON_COPY[item.reason]) ??
    "This extraction check needs review."
  );
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function attentionParams(
  showInfo: boolean,
  showEverything: boolean,
  cursor?: string,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("severity", showInfo ? "info,attention,alert" : "attention,alert");
  if (showEverything) params.set("state", "open,snoozed,dismissed,resolved");
  if (cursor !== undefined) params.set("cursor", cursor);
  return params;
}

async function fetchAttention(
  showInfo: boolean,
  showEverything: boolean,
  cursor?: string,
): Promise<AttentionPage> {
  const response = await fetch(
    `/api/kith/attention?${attentionParams(showInfo, showEverything, cursor).toString()}`,
    { headers: { "Content-Type": "application/json" }, cache: "no-store" },
  );
  if (!response.ok) throw new Error("attention fetch failed");
  return (await response.json()) as AttentionPage;
}

function todayPlusDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function ageLabel(createdAt: number, now: number): string {
  const days = Math.max(0, Math.floor((now - createdAt) / 86_400_000));
  return days === 0 ? "today" : `${days}d`;
}

async function send(
  url: string,
  method: string,
  body?: unknown,
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

/** The read-only detail panel a row click, or its own kebab's "Review",
 * opens. There is no value-correction form here yet, so the available actions
 * only defer or remove an item from this queue. */
function AttentionDrawer({
  item,
  onOpenChange,
  onDismiss,
  onSnooze,
  onUndo,
}: {
  item: Item;
  onOpenChange: (open: boolean) => void;
  onDismiss: (reason: DismissReason) => void;
  onSnooze: (until: string) => void;
  onUndo: () => void;
}) {
  return (
    <Drawer open onOpenChange={onOpenChange} title={issueLabel(item)}>
      <div className="flex flex-col gap-2 text-xs text-gray-700">
        <div className="flex items-center gap-2">
          <Tag tone={SEVERITY_TONE[item.severity]}>{item.severity}</Tag>
          <Tag tone={STATE_TONE[item.state]}>{item.state}</Tag>
          <Tag>{item.detector === "extraction" ? "extraction" : "check"}</Tag>
        </div>
        <div>
          <span className="text-gray-400">Why</span> {issueExplanation(item)}
        </div>
        {item.document === null ? null : (
          <div>
            <span className="text-gray-400">Document</span>{" "}
            {item.document.title ?? item.document.sourceItemId}
          </div>
        )}
        {item.detector === "investment_link_date" ? (
          <>
            <div>
              <span className="text-gray-400">Previous date</span>{" "}
              <span className="break-all">
                {JSON.stringify(item.originalValue)}
              </span>
            </div>
            <div>
              <span className="text-gray-400">Updated date</span>{" "}
              <span className="break-all">
                {JSON.stringify(item.correctedValue)}
              </span>
            </div>
          </>
        ) : item.originalValue === null ? null : (
          <div>
            <span className="text-gray-400">Model reading</span>{" "}
            <span className="break-all">
              {JSON.stringify(item.originalValue)}
            </span>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {item.state === "dismissed" ? (
          <button type="button" className={buttonClass} onClick={onUndo}>
            Undo
          </button>
        ) : item.state === "resolved" ? null : (
          <>
            <button
              type="button"
              className={buttonClass}
              onClick={() => onDismiss("not_worth_backfilling")}
            >
              Mark not needed
            </button>
            {SNOOZE_PRESETS_DAYS.map((days) => (
              <button
                key={days}
                type="button"
                className={buttonClass}
                onClick={() => onSnooze(todayPlusDays(days))}
              >
                Snooze {days}d
              </button>
            ))}
          </>
        )}
      </div>
    </Drawer>
  );
}

export function AttentionTable({
  initial,
  spaceId,
}: {
  initial: AttentionPage & { counts: { attention: number; alert: number } };
  /** Where a bulk action or a mute is written. The screen has no space
   * picker: the owner has one household. */
  spaceId: string | null;
}) {
  useLiveChanges(WATCHED);
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  // Current checks include `info` rows, so a severity-only default would make
  // the working queue look empty.
  const [showInfo, setShowInfo] = useState(true);
  const [showEverything, setShowEverything] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [beforeDate, setBeforeDate] = useState("");
  const [confirmBeforeDate, setConfirmBeforeDate] = useState(false);

  // The confirm dialog below states a real count rather than "some": the
  // action is unbounded and owner-visible. Fetched live as the date
  // changes, from the same filter the dismiss itself will use.
  const { data: beforeDateCount } = useQuery({
    queryKey: ["attention-before-date-count", beforeDate, spaceId],
    enabled: beforeDate !== "" && spaceId !== null,
    queryFn: async (): Promise<number> => {
      const response = await fetch("/api/kith/attention/count", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spaceId,
          filter: { kind: "beforeDate", beforeDate },
        }),
      });
      if (!response.ok) throw new Error("count fetch failed");
      return ((await response.json()) as { count: number }).count;
    },
  });

  const queryKey = useMemo(
    () => [...ATTENTION_KEY, { showInfo, showEverything }],
    [showInfo, showEverything],
  );
  const isDefaultView = showInfo && !showEverything;
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey,
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) =>
        fetchAttention(showInfo, showEverything, pageParam),
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      initialData: isDefaultView
        ? {
            pages: [{ items: initial.items, nextCursor: initial.nextCursor }],
            pageParams: [undefined],
          }
        : undefined,
    });
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  const fail = useCallback((error: unknown) => {
    setToast(error instanceof Error ? error.message : "Request failed");
    setTimeout(() => setToast(null), 6_000);
  }, []);
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ATTENTION_KEY }),
    [queryClient],
  );

  const dismissOne = useCallback(
    async (id: string, reason: DismissReason) => {
      try {
        await send("/api/kith/attention", "DELETE", {
          action: "dismiss",
          id,
          reason,
        });
        await refresh();
      } catch (error) {
        fail(error);
      }
    },
    [refresh, fail],
  );
  const snoozeOne = useCallback(
    async (id: string, until: string) => {
      try {
        await send("/api/kith/attention", "PATCH", {
          action: "snooze",
          id,
          until,
        });
        await refresh();
      } catch (error) {
        fail(error);
      }
    },
    [refresh, fail],
  );
  const undoOne = useCallback(
    async (id: string) => {
      try {
        await send("/api/kith/attention", "PATCH", { action: "undo", id });
        await refresh();
      } catch (error) {
        fail(error);
      }
    },
    [refresh, fail],
  );
  const mute = useCallback(
    async (scopeKind: "detector" | "document_kind", scopeValue: string) => {
      if (spaceId === null) return;
      try {
        await send("/api/kith/attention/mutes", "POST", {
          spaceId,
          scopeKind,
          scopeValue,
        });
        await refresh();
      } catch (error) {
        fail(error);
      }
    },
    [spaceId, refresh, fail],
  );
  const dismissByFilter = useCallback(
    async (filter: AttentionFilter, reason: DismissReason) => {
      if (spaceId === null) return;
      try {
        await send("/api/kith/attention", "DELETE", {
          action: "dismissBulk",
          spaceId,
          filter,
          reason,
        });
        await refresh();
      } catch (error) {
        fail(error);
      }
    },
    [spaceId, refresh, fail],
  );
  const snoozeByFilter = useCallback(
    async (filter: AttentionFilter, until: string) => {
      if (spaceId === null) return;
      try {
        await send("/api/kith/attention", "PATCH", {
          action: "snoozeBulk",
          spaceId,
          filter,
          until,
        });
        await refresh();
      } catch (error) {
        fail(error);
      }
    },
    [spaceId, refresh, fail],
  );

  const detail = items.find((item) => item.id === detailId) ?? null;
  const now = Date.now();

  const columns = useMemo<ColumnDef<Item, unknown>[]>(
    () => [
      {
        id: "severity",
        header: "Severity",
        accessorFn: (row) => row.severity,
        cell: ({ row }) => (
          <Tag tone={SEVERITY_TONE[row.original.severity]}>
            {row.original.severity}
          </Tag>
        ),
      },
      {
        id: "what",
        header: "Needs attention",
        accessorFn: issueLabel,
        cell: ({ row }) => (
          <Detail
            label={<span>{issueLabel(row.original)}</span>}
            detail={issueExplanation(row.original)}
          />
        ),
      },
      {
        id: "reason",
        header: "Check",
        accessorFn: (row) => row.detector,
        cell: ({ row }) => <span>{row.original.detector}</span>,
      },
      {
        id: "document",
        header: "Document",
        accessorFn: (row) => row.document?.title ?? "",
        cell: ({ row }) =>
          row.original.document === null ? null : (
            <Detail
              label={
                <span className="truncate">
                  {row.original.document.title ??
                    row.original.document.sourceItemId}
                </span>
              }
              detail={row.original.document.uri}
            />
          ),
      },
      {
        id: "age",
        header: "Age",
        meta: { nowrap: true },
        accessorFn: (row) => row.createdAt,
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-500">
            {ageLabel(row.original.createdAt, now)}
          </span>
        ),
      },
      {
        id: "state",
        header: "State",
        accessorFn: (row) => row.state,
        cell: ({ row }) => (
          <Tag tone={STATE_TONE[row.original.state]}>{row.original.state}</Tag>
        ),
      },
    ],
    [now],
  );

  const actions = useMemo<RowAction<Item>[]>(
    () => [
      { label: "Review", onSelect: (item) => setDetailId(item.id) },
      {
        label: "Mark not needed",
        hidden: (item) =>
          item.state === "dismissed" || item.state === "resolved",
        onSelect: (item) => void dismissOne(item.id, "not_worth_backfilling"),
      },
      {
        label: "Snooze 7 days",
        hidden: (item) =>
          item.state === "dismissed" || item.state === "resolved",
        onSelect: (item) => void snoozeOne(item.id, todayPlusDays(7)),
      },
      {
        label: "Snooze 30 days",
        hidden: (item) =>
          item.state === "dismissed" || item.state === "resolved",
        onSelect: (item) => void snoozeOne(item.id, todayPlusDays(30)),
      },
      {
        label: "Mute this detector",
        hidden: (item) => item.state === "resolved",
        onSelect: (item) => void mute("detector", item.detector),
      },
      {
        label: "Mute this document kind",
        hidden: (item) =>
          item.document?.kind == null || item.state === "resolved",
        onSelect: (item) => void mute("document_kind", item.document!.kind!),
      },
      {
        label: "Undo",
        hidden: (item) => item.state !== "dismissed",
        onSelect: (item) => void undoOne(item.id),
      },
    ],
    [dismissOne, snoozeOne, undoOne, mute],
  );

  const bulkActions = useMemo<RowAction<Item[]>[]>(
    () => [
      {
        label: "Mark selected not needed",
        danger: true,
        onSelect: (rows) =>
          void dismissByFilter(
            { kind: "ids", ids: rows.map((item) => item.id) },
            "not_worth_backfilling",
          ),
      },
      {
        label: "Snooze 7 days",
        onSelect: (rows) =>
          void snoozeByFilter(
            { kind: "ids", ids: rows.map((item) => item.id) },
            todayPlusDays(7),
          ),
      },
      {
        label: "Snooze 30 days",
        onSelect: (rows) =>
          void snoozeByFilter(
            { kind: "ids", ids: rows.map((item) => item.id) },
            todayPlusDays(30),
          ),
      },
    ],
    [dismissByFilter, snoozeByFilter],
  );

  return (
    <div className="flex flex-col gap-2">
      <PageHeader title="Needs attention" />
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={showInfo}
          onClick={() => setShowInfo((current) => !current)}
          className={`rounded-tag border px-1.5 py-0.5 text-meta leading-none ${
            showInfo
              ? "border-accent-600 bg-accent-600 text-white"
              : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300"
          }`}
        >
          {showInfo ? "Hide info" : "Show info"}
        </button>
        <button
          type="button"
          aria-pressed={showEverything}
          onClick={() => setShowEverything((current) => !current)}
          className={`rounded-tag border px-1.5 py-0.5 text-meta leading-none ${
            showEverything
              ? "border-accent-600 bg-accent-600 text-white"
              : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300"
          }`}
        >
          {showEverything ? "Hide history" : "Show history"}
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
        id="admin-attention"
        data={items}
        columns={columns}
        filterColumns={["detector", "state"]}
        initialSorting={[{ id: "age", desc: true }]}
        actions={actions}
        selectable
        bulkActions={bulkActions}
        onRowClick={(item) => setDetailId(item.id)}
        searchPlaceholder="Search attention items"
        empty="Nothing needs attention"
        toolbar={
          <>
            <input
              type="date"
              value={beforeDate}
              onChange={(event) => setBeforeDate(event.target.value)}
              className={`${inputClass} w-32`}
              aria-label="Documents dated before"
            />
            <button
              type="button"
              className={buttonClass}
              disabled={beforeDate === "" || spaceId === null}
              onClick={() => setConfirmBeforeDate(true)}
            >
              Mark older items not needed
            </button>
          </>
        }
      />

      {hasNextPage ? (
        <div>
          <button
            type="button"
            className={buttonClass}
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}

      {detail === null ? null : (
        <AttentionDrawer
          item={detail}
          onOpenChange={(open) => {
            if (!open) setDetailId(null);
          }}
          onDismiss={(reason) => {
            setDetailId(null);
            void dismissOne(detail.id, reason);
          }}
          onSnooze={(until) => {
            setDetailId(null);
            void snoozeOne(detail.id, until);
          }}
          onUndo={() => {
            setDetailId(null);
            void undoOne(detail.id);
          }}
        />
      )}

      <AlertDialog.Root
        open={confirmBeforeDate}
        onOpenChange={setConfirmBeforeDate}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-kith-overlay" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]">
            <AlertDialog.Title className="kith-section-title">
              Mark {beforeDateCount ?? "…"} item
              {beforeDateCount === 1 ? "" : "s"} for documents dated before{" "}
              {beforeDate}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-kith-text-secondary">
              Every open item for a document dated before this date -- by its
              own extracted date, or its file&apos;s modified date when the
              document states none -- is marked not needed. You can restore an
              individual item from the history view.
            </AlertDialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialog.Cancel className={buttonClass}>
                Cancel
              </AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => {
                  void dismissByFilter(
                    { kind: "beforeDate", beforeDate },
                    "not_worth_backfilling",
                  );
                  setConfirmBeforeDate(false);
                  setBeforeDate("");
                }}
                className={primaryButtonClass}
              >
                Mark not needed
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
