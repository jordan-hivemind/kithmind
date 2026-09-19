"use client";

// Screen 1 (Health), read-only: one row per check, with its status, the one
// line behind it, and when it was last checked.
//
// Every value comes from the database or from the finance archive's own read
// contract. There is no mock check and no placeholder status: a check with
// nothing to report says `unknown` or `not configured`, which are different
// answers from `ok` and are shown as such.

import type { admin } from "@repo/kith-store";
import { type ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo, useRef, useState } from "react";

import { useAdminScreen } from "@/components/admin/admin-query";
import {
  DataTable,
  Detail,
  type RowAction,
  Tag,
} from "@/components/ui/data-table";

type Check = admin.HealthCheck;

/** The tables each check is derived from. Any change invalidates `health`. */
const WATCHED = {
  health: [
    "worker_watcher_states",
    "worker_processing_assessments",
    "source_accounts",
    "deferred_work",
    "card_entity_bindings",
    "card_field_drops",
  ],
} as const;

const TONE: Record<Check["status"], "neutral" | "accent" | "warn"> = {
  ok: "accent",
  attention: "warn",
  problem: "warn",
  unknown: "neutral",
  not_configured: "neutral",
};

const LABEL: Record<Check["status"], string> = {
  ok: "ok",
  attention: "attention",
  problem: "problem",
  unknown: "unknown",
  not_configured: "not configured",
};

function when(value: number | null): string {
  if (value === null) return "";
  return new Date(value).toISOString().slice(0, 16).replace("T", " ");
}

export function HealthTable({ initial }: { initial: { checks: Check[] } }) {
  const data = useAdminScreen("health", WATCHED, initial);

  const columns = useMemo<ColumnDef<Check, unknown>[]>(
    () => [
      { id: "name", accessorKey: "name", header: "Check" },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          // ADM-9: the watcher row carries a second pill, how its last pass
          // ended, with the pass code as its tooltip. A pass that trips one of
          // the watcher's circuit breakers writes no scan and no assessment,
          // so this pill is the only place that pass is visible at all.
          <span className="inline-flex items-center gap-1">
            <Tag tone={TONE[row.original.status]}>
              {LABEL[row.original.status]}
            </Tag>
            {row.original.pass && (
              <Tag
                tone={row.original.pass.problem ? "warn" : "neutral"}
                title={row.original.pass.code ?? undefined}
              >
                {row.original.pass.state}
              </Tag>
            )}
            {/* ADM-10: a heartbeat being refused is not the same failure as
                one that stopped arriving, and it has a different fix -- "Re-
                register watcher", in this row's kebab. The code is the
                tooltip, as the pass pill's is. */}
            {row.original.watcher?.identity && (
              <Tag tone="warn" title="identity_review_required">
                identity
              </Tag>
            )}
            {/* ADM-10 review: two hosts heartbeating as one watcher. The
                opposite failure from the other two -- the heartbeat is
                arriving, twice -- and the fix is to stop one host, so it is
                its own pill and not a variant of theirs. */}
            {row.original.watcher?.splitBrain && (
              <Tag tone="warn" title="watcher_split_brain">
                2 hosts
              </Tag>
            )}
          </span>
        ),
      },
      {
        id: "detail",
        accessorKey: "detail",
        header: "Detail",
        cell: ({ row }) => (
          <Detail label={row.original.detail} detail={row.original.tooltip} />
        ),
      },
      {
        id: "lastCheckedAt",
        accessorKey: "lastCheckedAt",
        header: "Last checked",
        meta: { nowrap: true },
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-600">
            {when(row.original.lastCheckedAt)}
          </span>
        ),
      },
    ],
    [],
  );

  // ADM-10. Clearing the registration so the next heartbeat claims the source.
  // Owner-only, enforced by the route's store function and not by hiding the
  // kebab: an editor who calls it anyway gets the same "not found" a stranger
  // does. Offered only on a watcher that has actually stopped reporting, so a
  // healthy registration cannot be cleared by a slip of the mouse.
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // ADM-10 review, finding 2. One request id per source account for the life
  // of this screen, not one per click. `resetWorkerWatcher` is a
  // compare-and-set keyed on that id, so a fresh id on a second click is a
  // fresh reset that clears whatever is registered *then* -- and after the
  // first click the thing registered then is the new registration the
  // watcher's own heartbeat just made. A stable id makes the second click
  // replay the first one's receipt instead. `pending` covers the other half,
  // the double click that lands before the first request returns.
  const requestIds = useRef(new Map<string, string>());
  const reregister = useCallback(async (check: Check) => {
    setFailure(null);
    setPending(true);
    try {
      for (const sourceAccountId of check.watcher?.stuck ?? []) {
        let requestId = requestIds.current.get(sourceAccountId);
        if (requestId === undefined) {
          requestId = crypto.randomUUID();
          requestIds.current.set(sourceAccountId, requestId);
        }
        const response = await fetch("/api/kith/watcher", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceAccountId, requestId }),
        });
        if (!response.ok) {
          setFailure("Could not re-register the watcher");
          return;
        }
      }
    } finally {
      setPending(false);
    }
  }, []);

  const actions = useMemo<RowAction<Check>[]>(
    () => [
      {
        label: "Re-register watcher",
        danger: true,
        // Offered on any watcher that has stopped reporting, not only one the
        // `identity` pill has diagnosed: the derived identity state needs both
        // a missed deadline and a newer assessment, so a quiet source whose
        // heartbeat is refused reads as plain `overdue` and still needs this.
        hidden: (row) => (row.watcher?.stuck.length ?? 0) === 0,
        disabled: () => pending,
        onSelect: (row) => void reregister(row),
      },
    ],
    [pending, reregister],
  );

  return (
    <>
      <DataTable
        id="admin-health"
        data={data.checks}
        columns={columns}
        actions={actions}
        filterColumns={["status"]}
        searchPlaceholder="Search checks"
        empty="No checks"
      />
      {failure === null ? null : (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {failure}
        </p>
      )}
    </>
  );
}
