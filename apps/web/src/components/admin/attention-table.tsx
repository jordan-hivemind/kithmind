"use client";

// The Needs attention screen (ADM-8a): the first slice of section 5 of
// docs/plans/2026-09-19-investment-document-matching.md -- the quiet,
// dismissible queue itself. No matching or detector logic shows up here; the
// only rows today are typed-extraction gate failures (`severity: 'info'` by
// default), so an empty table is the common case until a later slice adds a
// detector that raises one.
//
// Owner's principle, quoted here because it drove every default below: this
// is a best-effort personal store; records will be incomplete; do not chase
// the owner for information he does not have; warnings about holes must
// never become so noisy that he misses what he cares about. That is why the
// default view is narrow (open, `attention`/`alert` only) and why "not worth
// backfilling" is one click with no confirmation on a single row -- the
// owner already decided, twice over, that this table exists so items leave
// it quietly.

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { admin } from "@repo/kith-store";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";

import { DataTable, Detail, type RowAction, Tag } from "@/components/ui/data-table";
import { buttonClass, Drawer, inputClass, primaryButtonClass } from "@/components/ui/drawer";
import type { AttentionFilter, DismissReason } from "@/lib/kith/attention-schemas";
import { SNOOZE_PRESETS_DAYS } from "@/lib/kith/attention-schemas";
import { useLiveChanges } from "@/lib/kith/use-live-changes";

const WATCHED = { attention: ["corrections", "attention_mutes"] } as const;
const ATTENTION_KEY = ["attention"];

type Item = admin.AttentionItem;

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

function todayPlusDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function ageLabel(createdAt: number, now: number): string {
  const days = Math.max(0, Math.floor((now - createdAt) / 86_400_000));
  return days === 0 ? "today" : `${days}d`;
}

async function send(url: string, method: string, body?: unknown): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(problem.error ?? "Request failed");
  }
  return response;
}

/** The read-only detail panel a row click, or its own kebab's "Resolve",
 * opens. There is no value-correction form here yet -- that is the
 * extraction corrections editor the plan expects to reuse once it exists --
 * so this is the evidence side: what fired, on what, and why. */
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
    <Drawer open onOpenChange={onOpenChange} title="Attention item">
      <div className="flex flex-col gap-2 text-xs text-gray-700">
        <div className="flex items-center gap-2">
          <Tag tone={SEVERITY_TONE[item.severity]}>{item.severity}</Tag>
          <Tag tone={STATE_TONE[item.state]}>{item.state}</Tag>
          <Tag>{item.detector}</Tag>
        </div>
        <div>
          <span className="text-gray-400">What</span>{" "}
          {item.document?.kind ?? item.targetKind}
          {item.fieldName === null ? "" : ` · ${item.fieldName}`}
        </div>
        {item.reason === null ? null : (
          <div>
            <span className="text-gray-400">Reason</span> {item.reason.replaceAll("_", " ")}
          </div>
        )}
        {item.document === null ? null : (
          <div>
            <span className="text-gray-400">Document</span>{" "}
            {item.document.title ?? item.document.sourceItemId}
          </div>
        )}
        {item.originalValue === null ? null : (
          <div>
            <span className="text-gray-400">Reading</span>{" "}
            <span className="break-all">{JSON.stringify(item.originalValue)}</span>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {item.state === "dismissed" ? (
          <button type="button" className={buttonClass} onClick={onUndo}>
            Undo
          </button>
        ) : (
          <>
            <button
              type="button"
              className={buttonClass}
              onClick={() => onDismiss("not_worth_backfilling")}
            >
              Not worth backfilling
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
  initial: { items: Item[]; counts: { attention: number; alert: number } };
  /** Where a bulk action or a mute is written. The screen has no space
   * picker: the owner has one household. */
  spaceId: string | null;
}) {
  useLiveChanges(WATCHED);
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
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
  const isDefaultView = !showInfo && !showEverything;
  const { data } = useQuery({
    queryKey,
    queryFn: async (): Promise<Item[]> => {
      const params = new URLSearchParams();
      // The store defaults severity to attention/alert when the param is
      // absent, so "show info too" has to name every severity explicitly
      // rather than omitting the filter.
      params.set("severity", showInfo ? "info,attention,alert" : "attention,alert");
      if (showEverything) params.set("state", "open,snoozed,dismissed");
      const response = await fetch(`/api/kith/attention?${params.toString()}`, {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("attention fetch failed");
      return ((await response.json()) as { items: Item[] }).items;
    },
    initialData: isDefaultView ? initial.items : undefined,
  });
  const items = data ?? [];

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
        await send("/api/kith/attention", "DELETE", { action: "dismiss", id, reason });
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
        await send("/api/kith/attention", "PATCH", { action: "snooze", id, until });
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
        await send("/api/kith/attention/mutes", "POST", { spaceId, scopeKind, scopeValue });
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
          <Tag tone={SEVERITY_TONE[row.original.severity]}>{row.original.severity}</Tag>
        ),
      },
      {
        id: "what",
        header: "What",
        accessorFn: (row) =>
          `${row.document?.kind ?? row.targetKind}${row.fieldName ? ` ${row.fieldName}` : ""}`,
        cell: ({ row }) => (
          <Detail
            label={
              <span>
                {row.original.document?.kind ?? row.original.targetKind}
                {row.original.fieldName === null ? "" : ` · ${row.original.fieldName}`}
              </span>
            }
            detail={row.original.targetId}
          />
        ),
      },
      {
        id: "reason",
        header: "Reason",
        accessorFn: (row) => row.reason ?? "",
        cell: ({ row }) => <span>{row.original.reason?.replaceAll("_", " ") ?? ""}</span>,
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
                  {row.original.document.title ?? row.original.document.sourceItemId}
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
      { label: "Resolve", onSelect: (item) => setDetailId(item.id) },
      {
        label: "Not worth backfilling",
        hidden: (item) => item.state === "dismissed",
        onSelect: (item) => void dismissOne(item.id, "not_worth_backfilling"),
      },
      {
        label: "Snooze 7 days",
        hidden: (item) => item.state === "dismissed",
        onSelect: (item) => void snoozeOne(item.id, todayPlusDays(7)),
      },
      {
        label: "Snooze 30 days",
        hidden: (item) => item.state === "dismissed",
        onSelect: (item) => void snoozeOne(item.id, todayPlusDays(30)),
      },
      {
        label: "Mute this detector",
        onSelect: (item) => void mute("detector", item.detector),
      },
      {
        label: "Mute this document kind",
        hidden: (item) => item.document?.kind == null,
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
        label: "Not worth backfilling",
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={showInfo}
          onClick={() => setShowInfo((current) => !current)}
          className={`rounded-tag border px-1.5 py-0.5 text-[11px] leading-none ${
            showInfo
              ? "border-accent-600 bg-accent-600 text-white"
              : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300"
          }`}
        >
          Show info
        </button>
        <button
          type="button"
          aria-pressed={showEverything}
          onClick={() => setShowEverything((current) => !current)}
          className={`rounded-tag border px-1.5 py-0.5 text-[11px] leading-none ${
            showEverything
              ? "border-accent-600 bg-accent-600 text-white"
              : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300"
          }`}
        >
          Show snoozed &amp; dismissed
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
              Documents dated before
            </button>
          </>
        }
      />

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

      <AlertDialog.Root open={confirmBeforeDate} onOpenChange={setConfirmBeforeDate}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-gray-900/20" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-tag border border-gray-200 bg-white p-4 shadow-xl">
            <AlertDialog.Title className="text-sm font-medium text-gray-900">
              Dismiss {beforeDateCount ?? "…"} item
              {beforeDateCount === 1 ? "" : "s"} for documents dated before {beforeDate}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-xs text-gray-600">
              This can&apos;t be undone. Every open item for a document dated before
              this date -- by its own extracted date, or its file's modified date
              when the document states none -- is marked not worth backfilling.
            </AlertDialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialog.Cancel className={buttonClass}>Cancel</AlertDialog.Cancel>
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
                Dismiss
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
