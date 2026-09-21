"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { coverage } from "@repo/kith-store";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { Button, PageHeader } from "@/components/ui/controls";
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
import { useToast } from "@/components/ui/toast";
import {
  type CoverageGapView,
  coverageGapView,
} from "@/lib/kith/coverage-gaps";
import type { CoverageGapAcknowledgementInput } from "@/lib/kith/coverage-gaps-schemas";
import { mutateJson, optimisticHandlers } from "@/lib/kith/optimistic";
import { useLiveChanges } from "@/lib/kith/use-live-changes";

const QUERY_KEY = ["coverage-gaps"] as const;
const WATCHED = {
  "coverage-gaps": [
    "coverage_gaps",
    "coverage_gap_actions",
    "coverage_windows",
    "source_accounts",
    "entities",
  ],
} as const;

async function fetchCoverageGaps(): Promise<coverage.CoverageGapList> {
  const response = await fetch("/api/kith/coverage-gaps", {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Coverage gaps fetch failed");
  return (await response.json()) as coverage.CoverageGapList;
}

type ActionInput = CoverageGapAcknowledgementInput;

export function CoverageGapsTable({
  initial,
}: {
  initial: coverage.CoverageGapList;
}) {
  useLiveChanges(WATCHED);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchCoverageGaps,
    initialData: initial,
  });
  const rows = useMemo(
    () => data.items.map(coverageGapView),
    [data.items],
  );
  const selected = rows.find((item) => item.id === selectedId) ?? null;

  const action = useMutation({
    mutationFn: (input: ActionInput) =>
      mutateJson("/api/kith/coverage-gaps", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    ...optimisticHandlers<coverage.CoverageGapList, ActionInput>(
      queryClient,
      QUERY_KEY,
      (current, input) => ({
        ...current,
        items: current.items.filter((item) => item.id !== input.id),
      }),
      {
        onFailure: toast,
        resync: () =>
          void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
      },
    ),
    onSuccess: () => setSelectedId(null),
  });

  const columns = useMemo<ColumnDef<CoverageGapView, unknown>[]>(
    () => [
      {
        id: "description",
        accessorKey: "description",
        header: "Gap",
        size: 280,
        cell: ({ row }) => (
          <span className="block max-w-[22rem] font-medium text-kith-text">
            {row.original.description}
          </span>
        ),
      },
      {
        id: "dataType",
        accessorKey: "dataType",
        header: "Data type",
      },
      {
        id: "source",
        accessorKey: "source",
        header: "Source",
        cell: ({ row }) => (
          <Detail label={row.original.source} detail={row.original.account} />
        ),
      },
      {
        id: "expectedRange",
        accessorKey: "expectedRange",
        header: "Expected",
        meta: { nowrap: true },
      },
      {
        id: "observedRange",
        accessorKey: "observedRange",
        header: "Observed",
        meta: { nowrap: true },
      },
      {
        id: "reasonCopy",
        accessorKey: "reasonCopy",
        header: "Reason",
        cell: ({ row }) => (
          <Detail
            label={
              <span className="block max-w-52 truncate">
                {row.original.reasonCopy}
              </span>
            }
            detail={row.original.expectationEvidence}
          />
        ),
      },
      {
        id: "consequence",
        accessorKey: "consequence",
        header: "Consequence",
        cell: ({ row }) => (
          <span className="block max-w-52 text-kith-text-secondary">
            {row.original.consequence}
          </span>
        ),
      },
      {
        id: "detected",
        accessorKey: "detected",
        header: "Detected",
        meta: { nowrap: true },
      },
    ],
    [],
  );
  const actions = useMemo<RowAction<CoverageGapView>[]>(
    () => [{ label: "Inspect", onSelect: (item) => setSelectedId(item.id) }],
    [],
  );

  return (
    <div className="flex flex-col gap-2">
      <PageHeader title="Coverage Gaps" />
      {data.overflow ? (
        <div>
          <Tag tone="warn">More gaps available</Tag>
        </div>
      ) : null}
      <DataTable
        id="coverage-gaps"
        data={rows}
        columns={columns}
        filterColumns={["dataType", "source"]}
        initialSorting={[{ id: "detected", desc: true }]}
        actions={actions}
        onRowClick={(item) => setSelectedId(item.id)}
        searchPlaceholder="Search coverage gaps"
        empty="No open coverage gaps"
      />
      {selected === null ? null : (
        <CoverageGapDrawer
          key={selected.id}
          item={selected}
          pending={action.isPending}
          onOpenChange={(open) => {
            if (!open) setSelectedId(null);
          }}
          onAction={(input) => action.mutate(input)}
        />
      )}
    </div>
  );
}

function CoverageGapDrawer({
  item,
  pending,
  onOpenChange,
  onAction,
}: {
  item: CoverageGapView;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (input: ActionInput) => void;
}) {
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<
    CoverageGapAcknowledgementInput["action"] | null
  >(null);
  const details = [
    ["Data type", item.dataType],
    ["Source", item.source],
    ["Account", item.account],
    ["Expected", item.expectedRange],
    ["Observed", item.observedRange],
    ["Detection reason", item.reasonCopy],
    ["Consequence", item.consequence],
    ["Expectation evidence", item.expectationEvidence],
    ["Detected", item.detected],
  ] as const;

  return (
    <>
      <Drawer
        open
        onOpenChange={onOpenChange}
        title="Coverage gap"
        dirty={note.trim() !== ""}
      >
        <h3 className="text-base font-semibold text-kith-text">
          {item.description}
        </h3>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-3 text-sm">
          {details.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="font-medium text-kith-text-secondary">{term}</dt>
              <dd className="min-w-0 text-kith-text">{value}</dd>
            </div>
          ))}
        </dl>
        <label className="flex flex-col gap-1 text-sm text-kith-text-secondary">
          <span>Audit note</span>
          <textarea
            value={note}
            maxLength={1_000}
            onChange={(event) => setNote(event.target.value)}
            className={`${inputClass} h-20 resize-y py-2`}
          />
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={pending}
            onClick={() => setConfirm("mark_unavailable")}
          >
            Mark unavailable
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => setConfirm("mark_not_expected")}
          >
            Mark not expected
          </Button>
        </div>
      </Drawer>

      <AlertDialog.Root
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-kith-overlay" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-[60] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]">
            <AlertDialog.Title className="kith-section-title">
              {confirm === "mark_unavailable"
                ? "Mark source data unavailable?"
                : "Mark data not expected?"}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-kith-text-secondary">
              This closes the current gap and records the decision in its audit
              history. A later reconciliation can open a new occurrence.
            </AlertDialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialog.Cancel className={buttonClass}>
                Cancel
              </AlertDialog.Cancel>
              <AlertDialog.Action
                disabled={pending}
                className={primaryButtonClass}
                onClick={() => {
                  if (confirm === null) return;
                  onAction({
                    id: item.id,
                    action: confirm,
                    ...(note.trim() === "" ? {} : { note: note.trim() }),
                  });
                }}
              >
                Confirm
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
