"use client";

// Screen 2 (Sources): every folder, institution and manual source, expanding
// into the watched folders under it.
//
// Two kinds of row in one table, the way ADM-3's investments table holds
// investments over their entries: a source account, and each `source_roots`
// row that hangs off it. They share the columns because a root answers the
// same questions the account does -- where it points, how much it holds, when
// it was last read, and whether the last pass was clean -- only for one
// subtree instead of all of them.
//
// Every value comes from the database. A root's status pill and its tooltip
// are the latest `source_root_reports` row for it, written by the watcher host
// through `source.rootReport`; a root with no report yet is `pending` rather
// than a guess.
//
// The three writes (add, pause/resume, remove) apply to the cache before the
// request is sent and roll back with a message if the server refuses, so the
// table never waits on a round trip. Changes made anywhere else -- the
// watcher, another tab -- arrive through the change feed.

import type { admin } from "@repo/kith-store";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";

import {
  DataTable,
  Detail,
  type RowAction,
  Tag,
} from "@/components/ui/data-table";
import {
  buttonClass,
  Drawer,
  Field,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
import { tableDateTime, tableInteger } from "@/lib/kith/format";
import { useLiveChanges } from "@/lib/kith/use-live-changes";

type Source = admin.SourceInventoryRow;
type Root = admin.SourceRoot;

/** The tables this screen's data is read from. A change on any of them
 * invalidates `["sources"]`. */
const WATCHED = {
  sources: [
    "source_accounts",
    "source_roots",
    "source_root_reports",
    "source_items",
    "worker_watcher_states",
    "worker_processing_assessments",
  ],
} as const;

const SOURCES_KEY = ["sources"] as const;

type Page = { sources: Source[]; roots: Root[] };

type Tone = "neutral" | "accent" | "warn";

const STATUS_TONE: Record<Source["status"], Tone> = {
  ok: "accent",
  pending: "neutral",
  disabled: "neutral",
  overdue: "warn",
  problem: "warn",
};

/** One table row, of either kind, behind one set of column accessors. */
type Row = {
  rowKind: "source" | "root";
  id: string;
  name: string;
  /** The hover detail behind the name. */
  detail: string | null;
  connector: string;
  kind: string | null;
  area: string | null;
  itemCount: number;
  skippedCount: number;
  lastReadAt: number | null;
  status: string;
  tone: Tone;
  /** The status pill's tooltip. */
  note: string | null;
  /** Set on a root row: which of pause and resume it offers. */
  rootState: Root["state"] | null;
  children?: Row[];
};

function when(value: number | null): string {
  return tableDateTime(value);
}

function rootLocation(root: Root): string | null {
  if (root.rootAlias === null || root.relativePath === null) {
    return root.lastKnownPath;
  }
  return `${root.rootAlias}/${root.relativePath}`;
}

/**
 * A root's pill: what the owner set, or failing that what the host last saw.
 *
 * A paused root says so and nothing else -- its last report is about a pass
 * that ran before it was paused, and showing that as the current state would
 * be a stale fact dressed as a live one.
 */
function rootStatus(root: Root): { status: string; tone: Tone; note: string } {
  const seen =
    root.reportedAt === null
      ? "never read"
      : `read ${when(root.reportedAt)}, ${root.reportItemCount ?? 0} items`;
  if (root.state === "paused") {
    return { status: "paused", tone: "neutral", note: seen };
  }
  if (root.state === "retired") {
    return { status: "retired", tone: "neutral", note: seen };
  }
  if (root.reportState === null) {
    return { status: "pending", tone: "neutral", note: seen };
  }
  return {
    status: root.reportState,
    tone: root.reportState === "ok" ? "accent" : "warn",
    note: seen,
  };
}

function toRootRow(root: Root): Row {
  const { status, tone, note } = rootStatus(root);
  return {
    rowKind: "root",
    id: root.id,
    name: rootLocation(root) ?? root.kind,
    detail: root.providerFolderId,
    connector: "",
    kind: root.kind,
    area: root.area,
    itemCount: root.reportItemCount ?? 0,
    skippedCount: 0,
    lastReadAt: root.reportedAt,
    status,
    tone,
    note,
    rootState: root.state,
  };
}

type Draft = {
  sourceAccountId: string;
  rootAlias: string;
  relativePath: string;
  area: string;
};

const EMPTY_DRAFT: Draft = {
  sourceAccountId: "",
  rootAlias: "",
  relativePath: "",
  area: "",
};

async function send(method: string, body: unknown): Promise<unknown> {
  const response = await fetch("/api/kith/source-roots", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return undefined;
  const parsed: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = (parsed ?? {}) as { error?: string };
    throw new Error(failure.error ?? "Request failed");
  }
  return parsed;
}

export function SourcesTable({
  initial,
  areas,
}: {
  initial: Page;
  /** The life areas the Add dialog offers. Passed in from the page: this file
   * is a client component and the list lives in the store. */
  areas: readonly string[];
}) {
  useLiveChanges(WATCHED);
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  /** Set when Add folder named a folder this space already watches. A pill,
   * because the add otherwise looks like it did nothing. */
  const [alreadyWatched, setAlreadyWatched] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const { data } = useQuery({
    queryKey: SOURCES_KEY,
    queryFn: async (): Promise<Page> => {
      const response = await fetch("/api/kith/sources", {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("sources fetch failed");
      return (await response.json()) as Page;
    },
    initialData: initial,
  });

  /** One optimistic mutation shape for all three writes. */
  const optimistic = useMutation<
    void,
    Error,
    { apply: (page: Page) => Page; run: () => Promise<unknown> },
    { previous: Page | undefined }
  >({
    mutationFn: async ({ run }) => {
      await run();
    },
    onMutate: async ({ apply }) => {
      await queryClient.cancelQueries({ queryKey: SOURCES_KEY });
      const previous = queryClient.getQueryData<Page>(SOURCES_KEY);
      if (previous !== undefined) {
        queryClient.setQueryData<Page>(SOURCES_KEY, apply(previous));
      }
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<Page>(SOURCES_KEY, context.previous);
      }
      setFailure(error.message);
      setTimeout(() => setFailure(null), 6_000);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });

  const setState = useCallback(
    (id: string, state: "active" | "paused") => {
      optimistic.mutate({
        apply: (page) => ({
          ...page,
          roots: page.roots.map((root) =>
            root.id === id ? { ...root, state } : root,
          ),
        }),
        run: () => send("PATCH", { sourceRootId: id, state }),
      });
    },
    [optimistic],
  );

  /** Remove is retire: the row leaves this list, the server keeps it. */
  const remove = useCallback(
    (id: string) => {
      optimistic.mutate({
        apply: (page) => ({
          ...page,
          roots: page.roots.filter((root) => root.id !== id),
        }),
        run: () => send("DELETE", { sourceRootId: id }),
      });
    },
    [optimistic],
  );

  const add = useCallback(
    (values: Draft) => {
      setDraft(null);
      setAlreadyWatched(false);
      optimistic.mutate({
        // The row's id is the server's to mint, and a placeholder row would
        // flicker a different row than the one that lands. The refetch in
        // `onSettled` is what shows it.
        apply: (page) => page,
        run: async () => {
          const result = (await send("POST", {
            sourceAccountId: values.sourceAccountId,
            rootAlias: values.rootAlias.trim(),
            relativePath: values.relativePath.trim(),
            ...(values.area === "" ? {} : { area: values.area }),
          })) as { created?: boolean } | undefined;
          // Adding a folder already on the list changes nothing, which without
          // this reads as a dialog that closed and did not work.
          if (result?.created === false) {
            setAlreadyWatched(true);
            setTimeout(() => setAlreadyWatched(false), 6_000);
          }
        },
      });
    },
    [optimistic],
  );

  const rows = useMemo<Row[]>(
    () =>
      data.sources.map((source) => ({
        rowKind: "source" as const,
        id: source.id,
        name: source.name,
        detail: source.location,
        connector: source.connector,
        kind: source.kind,
        area: source.area,
        itemCount: source.itemCount,
        skippedCount: source.skippedCount,
        lastReadAt: source.lastReadAt,
        status: source.status,
        tone: STATUS_TONE[source.status],
        note: source.problem,
        rootState: null,
        children: data.roots
          .filter((root) => root.sourceAccountId === source.id)
          .map(toRootRow),
      })),
    [data],
  );

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Source",
        cell: ({ row }) => (
          <span
            className={row.original.rowKind === "root" ? "text-gray-600" : ""}
          >
            <Detail label={row.original.name} detail={row.original.detail} />
          </span>
        ),
      },
      { id: "connector", accessorKey: "connector", header: "Type" },
      {
        id: "kind",
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) =>
          row.original.kind === null ? null : <Tag>{row.original.kind}</Tag>,
      },
      {
        id: "area",
        accessorKey: "area",
        header: "Area",
        cell: ({ row }) =>
          row.original.area === null ? null : <Tag>{row.original.area}</Tag>,
      },
      {
        id: "itemCount",
        accessorKey: "itemCount",
        header: "Items",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {tableInteger(row.original.itemCount)}
          </span>
        ),
      },
      {
        id: "skippedCount",
        accessorKey: "skippedCount",
        header: "Skipped",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {tableInteger(row.original.skippedCount)}
          </span>
        ),
      },
      {
        id: "lastReadAt",
        accessorKey: "lastReadAt",
        header: "Last read",
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-600">
            {when(row.original.lastReadAt)}
          </span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Tag tone={row.original.tone} title={row.original.note ?? undefined}>
            {row.original.status}
          </Tag>
        ),
      },
    ],
    [],
  );

  const actions = useMemo<RowAction<Row>[]>(
    () => [
      {
        label: "Pause",
        hidden: (row) => row.rowKind !== "root" || row.rootState !== "active",
        onSelect: (row) => setState(row.id, "paused"),
      },
      {
        label: "Resume",
        hidden: (row) => row.rowKind !== "root" || row.rootState !== "paused",
        onSelect: (row) => setState(row.id, "active"),
      },
      {
        label: "Remove",
        danger: true,
        hidden: (row) => row.rowKind !== "root",
        onSelect: (row) => remove(row.id),
      },
    ],
    [remove, setState],
  );

  return (
    <>
      <DataTable
        id="admin-sources"
        data={rows}
        columns={columns}
        getSubRows={(row) => row.children}
        actions={actions}
        filterColumns={["status", "connector", "area"]}
        initialSorting={[{ id: "name", desc: false }]}
        searchPlaceholder="Search sources"
        empty="No sources"
        toolbar={
          <>
            {alreadyWatched ? <Tag>already watched</Tag> : null}
            <button
              type="button"
              className={primaryButtonClass}
              disabled={data.sources.length === 0}
              onClick={() => setDraft(EMPTY_DRAFT)}
            >
              Add folder
            </button>
          </>
        }
      />
      {failure === null ? null : (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {failure}
        </p>
      )}
      <AddFolderDrawer
        draft={draft}
        sources={data.sources}
        areas={areas}
        onChange={setDraft}
        onSave={add}
      />
    </>
  );
}

function AddFolderDrawer({
  draft,
  sources,
  areas,
  onChange,
  onSave,
}: {
  draft: Draft | null;
  sources: Source[];
  areas: readonly string[];
  onChange: (draft: Draft | null) => void;
  onSave: (draft: Draft) => void;
}) {
  const valid =
    draft !== null &&
    draft.sourceAccountId !== "" &&
    draft.rootAlias.trim() !== "" &&
    draft.relativePath.trim() !== "";
  return (
    <Drawer
      open={draft !== null}
      onOpenChange={(open) => onChange(open ? draft : null)}
      title="Add folder"
    >
      {draft === null ? null : (
        <>
          <Field label="Source">
            <select
              className={inputClass}
              value={draft.sourceAccountId}
              onChange={(event) =>
                onChange({ ...draft, sourceAccountId: event.target.value })
              }
            >
              <option value="" />
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Host root">
            <input
              className={inputClass}
              value={draft.rootAlias}
              onChange={(event) =>
                onChange({ ...draft, rootAlias: event.target.value })
              }
            />
          </Field>
          <Field label="Path">
            <input
              className={inputClass}
              value={draft.relativePath}
              onChange={(event) =>
                onChange({ ...draft, relativePath: event.target.value })
              }
            />
          </Field>
          <Field label="Area">
            <select
              className={inputClass}
              value={draft.area}
              onChange={(event) =>
                onChange({ ...draft, area: event.target.value })
              }
            >
              <option value="" />
              {areas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => onChange(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!valid}
              onClick={() => onSave(draft)}
            >
              Add
            </button>
          </div>
        </>
      )}
    </Drawer>
  );
}
