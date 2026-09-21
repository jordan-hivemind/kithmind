"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
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
type Page = { sources: Source[]; roots: Root[] };
type Tone = "neutral" | "accent" | "warn";
type Row = {
  rowKind: "connection" | "location";
  id: string;
  connection: string;
  connectionType: string;
  location: string | null;
  area: string | null;
  itemCount: number;
  lastReadAt: number | null;
  status: string;
  statusDetail: string;
  tone: Tone;
  enabled: boolean;
  rootState: Root["state"] | null;
  children?: Row[];
};
type Draft = {
  sourceAccountId: string;
  rootAlias: string;
  relativePath: string;
  area: string;
};

const SOURCES_KEY = ["sources"] as const;
const WATCHED = {
  sources: [
    "source_accounts",
    "source_roots",
    "source_root_reports",
    "source_items",
    "worker_watcher_states",
  ],
} as const;
const EMPTY_DRAFT: Draft = {
  sourceAccountId: "",
  rootAlias: "",
  relativePath: "",
  area: "",
};

function connectionType(connector: string): string {
  return connector === "fs"
    ? "Local files"
    : connector === "mcp-client"
      ? "MCP client"
      : connector;
}
function location(root: Root): string | null {
  return root.rootAlias === null || root.relativePath === null
    ? root.lastKnownPath
    : `${root.rootAlias}/${root.relativePath}`;
}
function rootProgress(
  root: Root,
): Pick<Row, "status" | "statusDetail" | "tone"> {
  if (root.state === "paused")
    return {
      status: "Paused",
      statusDetail:
        "Resume watching when this location should be scanned again.",
      tone: "neutral",
    };
  if (root.reportState === null)
    return {
      status: "Waiting for worker",
      statusDetail:
        "No worker has reported this location yet. Check that its connection is enabled and the worker is running.",
      tone: "neutral",
    };
  if (root.reportState === "missing")
    return {
      status: "Action needed",
      statusDetail:
        "The configured host root or folder is unavailable. Check the location on the connected host.",
      tone: "warn",
    };
  if (root.reportState === "unreadable")
    return {
      status: "Action needed",
      statusDetail:
        "The worker cannot read this folder. Check access on the connected host.",
      tone: "warn",
    };
  if (root.reportState === "over_limit")
    return {
      status: "Action needed",
      statusDetail:
        "The folder is too large to scan. Choose a narrower location.",
      tone: "warn",
    };
  return {
    status: "Up to date",
    statusDetail:
      root.reportedAt === null
        ? "The next scan is queued."
        : `Last successful read ${tableDateTime(root.reportedAt)}.`,
    tone: "accent",
  };
}
function toLocation(root: Root): Row {
  return {
    rowKind: "location",
    id: root.id,
    connection: "",
    connectionType: "",
    location: location(root),
    area: root.area,
    itemCount: root.reportItemCount ?? 0,
    lastReadAt: root.reportedAt,
    enabled: true,
    rootState: root.state,
    ...rootProgress(root),
  };
}
async function request(
  url: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined;
  const parsed: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(
      (parsed as { error?: string } | undefined)?.error ?? "Request failed",
    );
  return parsed;
}

export function SourcesTable({
  initial,
  areas,
}: {
  initial: Page;
  areas: readonly string[];
}) {
  useLiveChanges(WATCHED);
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [watchDraft, setWatchDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<Source | null>(null);
  const [editingRoot, setEditingRoot] = useState<Root | null>(null);
  const [deleteRoot, setDeleteRoot] = useState<Root | null>(null);
  const [disconnecting, setDisconnecting] = useState<Source | null>(null);
  const { data } = useQuery({
    queryKey: SOURCES_KEY,
    queryFn: async (): Promise<Page> =>
      request("/api/kith/sources", "GET") as Promise<Page>,
    initialData: initial,
  });
  const mutate = useMutation<
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
      if (previous)
        queryClient.setQueryData<Page>(SOURCES_KEY, apply(previous));
      return { previous };
    },
    onError: (error, _v, context) => {
      if (context?.previous)
        queryClient.setQueryData(SOURCES_KEY, context.previous);
      setFailure(error.message);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: SOURCES_KEY }),
  });
  const updateConnection = useCallback(
    (source: Source, patch: Partial<Pick<Source, "name" | "enabled">>) =>
      mutate.mutate({
        apply: (page) => ({
          ...page,
          sources: page.sources.map((item) =>
            item.id === source.id ? { ...item, ...patch } : item,
          ),
        }),
        run: () =>
          request(`/api/kith/source-accounts/${source.id}`, "PATCH", patch),
      }),
    [mutate],
  );
  const updateRoot = useCallback(
    (id: string, state: "active" | "paused") =>
      mutate.mutate({
        apply: (page) => ({
          ...page,
          roots: page.roots.map((root) =>
            root.id === id ? { ...root, state } : root,
          ),
        }),
        run: () =>
          request("/api/kith/source-roots", "PATCH", {
            sourceRootId: id,
            state,
          }),
      }),
    [mutate],
  );
  const retireRoot = useCallback(
    (id: string) =>
      mutate.mutate({
        apply: (page) => ({
          ...page,
          roots: page.roots.filter((root) => root.id !== id),
        }),
        run: () =>
          request("/api/kith/source-roots", "DELETE", { sourceRootId: id }),
      }),
    [mutate],
  );
  const editRoot = useCallback((root: Root, draft: Draft) => {
    setEditingRoot(null);
    mutate.mutate({ apply: (page) => page, run: () => request("/api/kith/source-roots", "PATCH", { sourceRootId: root.id, rootAlias: draft.rootAlias, relativePath: draft.relativePath, area: draft.area }) });
  }, [mutate]);
  const disconnect = useCallback((source: Source) => {
    setDisconnecting(null);
    mutate.mutate({ apply: (page) => ({ ...page, sources: page.sources.filter((item) => item.id !== source.id), roots: page.roots.filter((root) => root.sourceAccountId !== source.id) }), run: () => request(`/api/kith/source-accounts/${source.id}`, "DELETE") });
  }, [mutate]);
  const createWatch = useCallback(
    (draft: Draft) => {
      setWatchDraft(null);
      mutate.mutate({
        apply: (page) => page,
        run: () =>
          request("/api/kith/source-roots", "POST", {
            sourceAccountId: draft.sourceAccountId,
            rootAlias: draft.rootAlias,
            relativePath: draft.relativePath,
            ...(draft.area ? { area: draft.area } : {}),
          }),
      });
    },
    [mutate],
  );
  const rows = useMemo<Row[]>(
    () =>
      data.sources.map((source) => ({
        rowKind: "connection",
        id: source.id,
        connection: source.name,
        connectionType: connectionType(source.connector),
        location: null,
        area: null,
        itemCount: source.itemCount,
        lastReadAt: source.lastReadAt,
        enabled: source.enabled,
        rootState: null,
        status: source.enabled
          ? source.status === "pending"
            ? "Waiting for worker"
            : source.status === "ok"
              ? "Up to date"
              : "Action needed"
          : "Disabled",
        statusDetail: !source.enabled
          ? "Enable this connection before its watched locations can be scanned."
          : (source.problem ??
            (source.status === "pending"
              ? "No worker has reported this connection yet. Check that the worker is running."
              : "")),
        tone:
          !source.enabled || source.status === "pending"
            ? "neutral"
            : source.status === "ok"
              ? "accent"
              : "warn",
        children: data.roots
          .filter((root) => root.sourceAccountId === source.id)
          .map(toLocation),
      })),
    [data],
  );
  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "connection",
        accessorKey: "connection",
        header: "Connection",
        cell: ({ row }) =>
          row.original.rowKind === "connection" ? (
            <Detail label={row.original.connection} detail={null} />
          ) : null,
      },
      {
        id: "connectionType",
        accessorKey: "connectionType",
        header: "Type",
        cell: ({ row }) =>
          row.original.rowKind === "connection"
            ? row.original.connectionType
            : null,
      },
      {
        id: "location",
        accessorKey: "location",
        header: "Watched location",
        cell: ({ row }) =>
          row.original.rowKind === "location" ? (
            <Detail
              label={row.original.location ?? "Unknown location"}
              detail={null}
            />
          ) : null,
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
        meta: { align: "right", nowrap: true },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {tableInteger(row.original.itemCount)}
          </span>
        ),
      },
      {
        id: "lastReadAt",
        accessorKey: "lastReadAt",
        header: "Last successful read",
        meta: { align: "right", nowrap: true },
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-600">
            {tableDateTime(row.original.lastReadAt)}
          </span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Tag tone={row.original.tone} title={row.original.statusDetail}>
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
        label: "Edit",
        hidden: (row) => row.rowKind !== "connection",
        onSelect: (row) =>
          setEditing(
            data.sources.find((source) => source.id === row.id) ?? null,
          ),
      },
      {
        label: "Disable",
        hidden: (row) => row.rowKind !== "connection" || !row.enabled,
        onSelect: (row) => {
          const source = data.sources.find((item) => item.id === row.id);
          if (source) updateConnection(source, { enabled: false });
        },
      },
      {
        label: "Enable",
        hidden: (row) => row.rowKind !== "connection" || row.enabled,
        onSelect: (row) => {
          const source = data.sources.find((item) => item.id === row.id);
          if (source) updateConnection(source, { enabled: true });
        },
      },
      { label: "Disconnect", danger: true, hidden: (row) => row.rowKind !== "connection", onSelect: (row) => setDisconnecting(data.sources.find((source) => source.id === row.id) ?? null) },
      { label: "Edit", hidden: (row) => row.rowKind !== "location", onSelect: (row) => setEditingRoot(data.roots.find((root) => root.id === row.id) ?? null) },
      {
        label: "Pause",
        hidden: (row) =>
          row.rowKind !== "location" || row.rootState !== "active",
        onSelect: (row) => updateRoot(row.id, "paused"),
      },
      {
        label: "Resume",
        hidden: (row) =>
          row.rowKind !== "location" || row.rootState !== "paused",
        onSelect: (row) => updateRoot(row.id, "active"),
      },
      {
        label: "Delete",
        danger: true,
        hidden: (row) => row.rowKind !== "location",
        onSelect: (row) =>
          setDeleteRoot(data.roots.find((root) => root.id === row.id) ?? null),
      },
    ],
    [data.roots, data.sources, updateConnection, updateRoot],
  );
  const canWatch = data.sources.some((source) => source.enabled && source.allowedRootAliases.length > 0);
  return (
    <>
      <DataTable
        id="admin-sources"
        data={rows}
        columns={columns}
        getSubRows={(row) => row.children}
        actions={actions}
        initialSorting={[{ id: "connection", desc: false }]}
        showSearch={false}
        filterColumns={[]}
        empty="No data sources"
        toolbar={
          <button
            type="button"
            className={primaryButtonClass}
            disabled={!canWatch}
            onClick={() => setWatchDraft(EMPTY_DRAFT)}
          >
            Watch a folder
          </button>
        }
      />
      {!canWatch && data.sources.length > 0 ? (
        <p className="mt-2 text-xs text-kith-text-muted">
          Waiting for an enabled connection's worker to report allowed roots.
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {failure}
        </p>
      ) : null}
      <WatchFolderDrawer
        draft={watchDraft}
        sources={data.sources}
        areas={areas}
        onChange={setWatchDraft}
        onSave={createWatch}
      />
      <EditRootDrawer root={editingRoot} sources={data.sources} areas={areas} onClose={() => setEditingRoot(null)} onSave={editRoot} />
      <EditConnectionDrawer
        source={editing}
        onClose={() => setEditing(null)}
        onSave={(name) => {
          if (editing) updateConnection(editing, { name });
          setEditing(null);
        }}
      />
      <AlertDialog.Root
        open={deleteRoot !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRoot(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-kith-overlay" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]">
            <AlertDialog.Title className="kith-section-title">
              Stop watching this folder?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-kith-text-secondary">
              New and changed files will no longer be imported. Already indexed
              documents and records will remain available.
            </AlertDialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialog.Cancel className={buttonClass}>
                Cancel
              </AlertDialog.Cancel>
              <AlertDialog.Action
                className={primaryButtonClass}
                onClick={() => {
                  if (deleteRoot) retireRoot(deleteRoot.id);
                  setDeleteRoot(null);
                }}
              >
                Stop watching
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <AlertDialog.Root open={disconnecting !== null} onOpenChange={(open) => { if (!open) setDisconnecting(null); }}>
        <AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-50 bg-kith-overlay" /><AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]"><AlertDialog.Title className="kith-section-title">Disconnect this connection?</AlertDialog.Title><AlertDialog.Description className="mt-1 text-sm text-kith-text-secondary">This stops and retires {disconnecting ? data.roots.filter((root) => root.sourceAccountId === disconnecting.id).length : 0} watched locations. Worker access grants remain saved but cannot scan this disconnected connection. Already indexed documents, records, and provenance remain available.</AlertDialog.Description><div className="mt-3 flex justify-end gap-2"><AlertDialog.Cancel className={buttonClass}>Cancel</AlertDialog.Cancel><AlertDialog.Action className={primaryButtonClass} onClick={() => { if (disconnecting) disconnect(disconnecting); }}>Disconnect</AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

function WatchFolderDrawer({
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
  const aliases = draft === null ? [] : sources.find((source) => source.id === draft.sourceAccountId)?.allowedRootAliases ?? [];
  const valid =
    draft !== null &&
    draft.sourceAccountId !== "" &&
    draft.rootAlias !== "" &&
    draft.relativePath.trim() !== "" &&
    draft.area !== "";
  return (
    <Drawer
      open={draft !== null}
      onOpenChange={(open) => onChange(open ? draft : null)}
      title="Watch a folder"
    >
      {draft && (
        <div className="flex flex-col gap-3">
          <Field label="Connection">
            <select
              className={inputClass}
              value={draft.sourceAccountId}
                onChange={(event) =>
                onChange({ ...draft, sourceAccountId: event.target.value, rootAlias: "" })
              }
            >
              <option value="" />
              {sources
                .filter((source) => source.enabled)
                .map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Folder">
            <select
              className={inputClass}
              value={draft.rootAlias}
              onChange={(event) =>
                onChange({ ...draft, rootAlias: event.target.value })
              }
            >
              <option value="">Choose an allowed root</option>
              {aliases.map((alias) => (
                <option key={alias} value={alias}>
                  {alias}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Folder path">
            <input
              className={inputClass}
              value={draft.relativePath}
              onChange={(event) =>
                onChange({ ...draft, relativePath: event.target.value })
              }
              placeholder="Documents"
            />
          </Field>
          <Field label="Organize as">
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
          <div className="rounded-control border border-kith-border-subtle p-3 text-xs text-kith-text-secondary">
            First scan:{" "}
            {draft.rootAlias && draft.relativePath
              ? `${draft.rootAlias}/${draft.relativePath}`
              : "choose a location"}
            . Subfolders are included. New items are saved in the
            connection&apos;s space.
          </div>
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
              Start watching
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function EditRootDrawer({ root, sources, areas, onClose, onSave }: { root: Root | null; sources: Source[]; areas: readonly string[]; onClose: () => void; onSave: (root: Root, draft: Draft) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const value = root && (!draft || draft.sourceAccountId !== root.sourceAccountId) ? { sourceAccountId: root.sourceAccountId, rootAlias: root.rootAlias ?? "", relativePath: root.relativePath ?? "", area: root.area ?? "" } : draft;
  const aliases = root ? sources.find((source) => source.id === root.sourceAccountId)?.allowedRootAliases ?? [] : [];
  return <Drawer open={root !== null} onOpenChange={(open) => { if (!open) { setDraft(null); onClose(); } }} title="Edit watched location">{root && value ? <div className="flex flex-col gap-3"><Field label="Folder"><select className={inputClass} value={value.rootAlias} onChange={(event) => setDraft({ ...value, rootAlias: event.target.value })}><option value="">Choose an allowed root</option>{aliases.map((alias) => <option key={alias} value={alias}>{alias}</option>)}</select></Field><Field label="Folder path"><input className={inputClass} value={value.relativePath} onChange={(event) => setDraft({ ...value, relativePath: event.target.value })} /></Field><Field label="Organize as"><select className={inputClass} value={value.area} onChange={(event) => setDraft({ ...value, area: event.target.value })}><option value="" />{areas.map((area) => <option key={area} value={area}>{area}</option>)}</select></Field><div className="flex justify-end gap-2"><button type="button" className={buttonClass} onClick={onClose}>Cancel</button><button type="button" className={primaryButtonClass} disabled={!value.rootAlias || !value.relativePath || !value.area} onClick={() => onSave(root, value)}>Save</button></div></div> : null}</Drawer>;
}

function EditConnectionDrawer({
  source,
  onClose,
  onSave,
}: {
  source: Source | null;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const open = source !== null;
  const displayName = open && name === "" ? source.name : name;
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName("");
          onClose();
        }
      }}
      title="Edit connection"
    >
      {source && (
        <div className="flex flex-col gap-3">
          <Field label="Connection name">
            <input
              className={inputClass}
              value={displayName}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!displayName.trim()}
              onClick={() => onSave(displayName.trim())}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}
