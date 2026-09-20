"use client";

// The browse page: facts or thoughts, fed by `loadBrowse`'s one read-only
// transaction and refreshed live when either table changes.
//
// The view, the history toggle and the thought type are the page's own
// `?view=&historical=&type=` query string, as before, so each is a link or a
// navigation rather than client state: the loader filters on the server and a
// type with more than one page of thoughts is still reachable. The thoughts
// view's free-text search is not in the URL (`lib/kith/browse.ts` says why);
// `kith-thought-search.tsx` posts it instead.
//
// Editing, deleting and retiring are `useOptimisticMutation` against this
// page's own `["browse", view, type, historical]` cache -- owned here, not in
// `FactsTable` or `KithThoughtSearch`, because both read from the one
// `BrowseData` this component holds. `KithThoughtSearch` gets the mutate
// functions as props and additionally patches its own local search-result
// state on success, so an edit or delete made mid-search reaches the rows a
// typed query is currently showing too.

import { type memory } from "@repo/kith-store";
import { type ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import {
  type EditableFactValue,
  type FactChangeKind,
  type FactDraft,
  FactDrawer,
} from "@/components/kith-fact-drawer";
import { KithThoughtSearch } from "@/components/kith-thought-search";
import { inputClass, PageHeader } from "@/components/ui/controls";
import { DataTable, type RowAction, Tag } from "@/components/ui/data-table";
import type { BrowseData, BrowseView } from "@/lib/kith/browse";
import { label, shortDate } from "@/lib/kith/format";
import { mutateJson } from "@/lib/kith/optimistic";
import {
  useOptimisticMutation,
  useServerData,
} from "@/lib/kith/use-server-data";

const THOUGHT_TYPES = [
  "decision",
  "person_note",
  "idea",
  "meeting_note",
  "task",
  "reference",
] as const;

const LIVE_TABLES = ["thoughts", "facts"] as const;

/** Editable value types only -- `entity` and `datetime` facts get no Edit
 * action (see `actions` below), so `FactDrawer` never has to render one.
 * Takes `HydratedFact["value"]` rather than the narrower `memory.FactValue`:
 * its `entity` member carries a resolved entity rather than a bare id, but
 * every other member is identical, which is all this needs. */
function editableValue(
  value: memory.HydratedFact["value"],
): EditableFactValue | null {
  return value.type === "entity" || value.type === "datetime" ? null : value;
}

function factValueBody(
  value: EditableFactValue,
  options: { changeKind: FactChangeKind; validFrom?: number },
): {
  value: unknown;
  unit?: string;
  changeKind: FactChangeKind;
  validFrom?: number;
} {
  return {
    ...(value.type === "number" && value.unit !== undefined
      ? { value: value.value, unit: value.unit }
      : { value: value.value }),
    changeKind: options.changeKind,
    ...(options.validFrom === undefined
      ? {}
      : { validFrom: options.validFrom }),
  };
}

function displayedValue(value: EditableFactValue): string {
  return value.type === "boolean"
    ? value.value
      ? "yes"
      : "no"
    : String(value.value);
}

/** Recomputes a fact's statement after its value changes, without
 * re-deriving `rememberFact`'s subject/predicate formatting: the value is
 * always the text after the statement's last ": ", so only that tail moves. */
function withUpdatedValue(
  fact: memory.HydratedFact,
  value: EditableFactValue,
): memory.HydratedFact {
  const marker = ": ";
  const cut = fact.statement.lastIndexOf(marker);
  const statement =
    cut === -1
      ? fact.statement
      : `${fact.statement.slice(0, cut + marker.length)}${displayedValue(value)}.`;
  return { ...fact, value, statement };
}

function href(view: BrowseView, historical: boolean, type = ""): string {
  const params = new URLSearchParams({ view });
  if (historical) params.set("historical", "1");
  if (type) params.set("type", type);
  return `/browse?${params.toString()}`;
}

/** Segmented links select the current inventory without adding a second toolbar. */
function Segment({
  options,
}: {
  options: readonly { href: string; label: string; active: boolean }[];
}) {
  return (
    <nav
      aria-label="Browse view"
      className="flex rounded-control border border-kith-border-subtle text-sm"
    >
      {options.map((option) => (
        <Link
          key={option.label}
          href={option.href}
          aria-current={option.active ? "page" : undefined}
          className={`px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-accent-600 ${
            option.active
              ? "bg-accent-600 text-white"
              : "bg-white text-gray-700 hover:bg-gray-50"
          }`}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}

/** History on or off: a link to the other state, styled like a chip. */
function HistoryToggle({ on, to }: { on: boolean; to: string }) {
  return (
    <Link
      href={to}
      aria-label={on ? "Hide history" : "Show history"}
      className={`rounded-tag border px-1.5 py-0.5 text-meta leading-none focus-visible:outline-2 focus-visible:outline-accent-600 ${
        on
          ? "border-accent-600 bg-accent-600 text-white"
          : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300"
      }`}
    >
      History
    </Link>
  );
}

type FactRow = {
  id: string;
  statement: string;
  subject: string;
  predicate: string;
  status: string;
  core: string;
  validFrom: number | null;
  validTo: number | null;
};

function FactsTable({
  facts,
  includeHistorical,
  onEdit,
  onRetire,
}: {
  facts: readonly memory.HydratedFact[];
  includeHistorical: boolean;
  onEdit: (
    id: string,
    value: EditableFactValue,
    options: { changeKind: FactChangeKind; validFrom?: number },
  ) => Promise<void>;
  onRetire: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{
    id: string;
    draft: FactDraft;
  } | null>(null);

  const rows = useMemo<FactRow[]>(
    () =>
      facts.map((fact) => ({
        id: fact.id,
        statement: fact.statement,
        subject: fact.subject?.key ?? "",
        predicate: fact.predicate,
        status: fact.status,
        core: fact.isCore ? "core" : "",
        validFrom: fact.validFrom ?? null,
        validTo: fact.validTo ?? null,
      })),
    [facts],
  );
  const columns = useMemo<ColumnDef<FactRow, unknown>[]>(
    () => [
      {
        id: "statement",
        accessorKey: "statement",
        header: "Fact",
        size: 420,
        minSize: 240,
        cell: ({ row }) => (
          <span
            title={row.original.statement}
            className={`block truncate ${
              row.original.status === "current" ? "" : "text-gray-500"
            }`}
          >
            {row.original.statement}
          </span>
        ),
      },
      {
        id: "subject",
        accessorKey: "subject",
        header: "Subject",
        size: 180,
        minSize: 120,
        meta: { nowrap: true },
      },
      {
        id: "predicate",
        accessorKey: "predicate",
        header: "Predicate",
        size: 170,
        minSize: 120,
        meta: { nowrap: true },
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        size: 90,
        minSize: 80,
        cell: ({ row }) => (
          <Tag tone={row.original.status === "current" ? "accent" : "neutral"}>
            {row.original.status}
          </Tag>
        ),
      },
      {
        id: "core",
        accessorKey: "core",
        header: "Core",
        size: 70,
        minSize: 60,
        cell: ({ row }) => (row.original.core ? <Tag>core</Tag> : null),
      },
      {
        id: "validFrom",
        accessorKey: "validFrom",
        header: "From",
        size: 110,
        minSize: 90,
        meta: { nowrap: true },
        cell: ({ row }) => (
          <span className="text-gray-600 tabular-nums">
            {shortDate(row.original.validFrom)}
          </span>
        ),
      },
      {
        id: "validTo",
        accessorKey: "validTo",
        header: "Until",
        size: 110,
        minSize: 90,
        meta: { nowrap: true },
        cell: ({ row }) => (
          <span className="text-gray-600 tabular-nums">
            {shortDate(row.original.validTo)}
          </span>
        ),
      },
    ],
    [],
  );

  const editableFacts = useMemo(
    () => new Map(facts.map((fact) => [fact.id, editableValue(fact.value)])),
    [facts],
  );

  // Shared by the kebab's Edit item and clicking the row. Rows for a fact
  // whose value has no editable form (`entity`, `datetime`) do not open one.
  const openEdit = useCallback(
    (row: FactRow) => {
      const fact = facts.find((item) => item.id === row.id);
      const value = fact ? editableValue(fact.value) : null;
      if (!fact || !value) return;
      setEditing({
        id: row.id,
        draft: {
          statement: fact.statement,
          subject: fact.subject.name,
          predicate: row.predicate,
          value,
          changeKind: "changed",
          validFrom: "",
        },
      });
    },
    [facts],
  );

  const actions = useMemo<RowAction<FactRow>[]>(
    () => [
      {
        label: "Edit",
        hidden: (row) =>
          row.status !== "current" || editableFacts.get(row.id) === null,
        onSelect: openEdit,
      },
      {
        label: "Retire",
        hidden: (row) => row.status !== "current",
        danger: true,
        onSelect: (row) => void onRetire(row.id),
      },
      {
        label: "Copy id",
        onSelect: (row) => void navigator.clipboard.writeText(row.id),
      },
    ],
    [editableFacts, onRetire, openEdit],
  );

  return (
    <>
      <DataTable
        id="browse-facts"
        data={rows}
        columns={columns}
        filterColumns={includeHistorical ? ["status", "core"] : ["core"]}
        initialSorting={[{ id: "subject", desc: false }]}
        actions={actions}
        onRowClick={openEdit}
        searchPlaceholder="Search facts"
        empty="No facts"
        toolbar={
          <HistoryToggle
            on={includeHistorical}
            to={href("facts", !includeHistorical)}
          />
        }
      />

      {editing === null ? null : (
        <FactDrawer
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          initial={editing.draft}
          onSave={async (value, options) => {
            await onEdit(editing.id, value, options);
          }}
        />
      )}
    </>
  );
}

export function KithBrowse({
  data: server,
  includeHistorical,
  type,
}: {
  data: BrowseData;
  includeHistorical: boolean;
  type: string;
}) {
  const router = useRouter();
  const queryKey = useMemo(
    () => ["browse", server.view, type, includeHistorical],
    [server.view, type, includeHistorical],
  );
  const data = useServerData<BrowseData>(queryKey, server, LIVE_TABLES);

  const editFact = useOptimisticMutation<
    BrowseData,
    {
      id: string;
      value: EditableFactValue;
      changeKind: FactChangeKind;
      validFrom?: number;
    }
  >({
    queryKey,
    mutationFn: ({ id, value, ...options }) =>
      mutateJson(`/api/kith/facts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(factValueBody(value, options)),
      }),
    apply: (current, { id, value }) =>
      current.view !== "facts"
        ? current
        : {
            ...current,
            facts: current.facts.map((fact) =>
              fact.id === id ? withUpdatedValue(fact, value) : fact,
            ),
          },
  });

  const retireFact = useOptimisticMutation<BrowseData, string>({
    queryKey,
    mutationFn: (id) =>
      mutateJson(`/api/kith/facts/${id}`, { method: "DELETE" }),
    apply: (current, id) =>
      current.view !== "facts"
        ? current
        : {
            ...current,
            facts: includeHistorical
              ? current.facts.map((fact) =>
                  fact.id === id ? { ...fact, validTo: Date.now() } : fact,
                )
              : current.facts.filter((fact) => fact.id !== id),
          },
  });

  type ThoughtEditVars = {
    id: string;
    content: string;
    type: memory.ThoughtType;
    topics: string[];
    people: string[];
  };

  const editThought = useOptimisticMutation<BrowseData, ThoughtEditVars>({
    queryKey,
    mutationFn: (vars) =>
      mutateJson(`/api/kith/thoughts/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          content: vars.content,
          type: vars.type,
          topics: vars.topics,
          people: vars.people,
        }),
      }),
    apply: (current, vars) =>
      current.view !== "thoughts"
        ? current
        : {
            ...current,
            thoughts: current.thoughts.map((thought) =>
              thought.id === vars.id
                ? {
                    ...thought,
                    content: vars.content,
                    metadata: {
                      ...thought.metadata,
                      type: vars.type,
                      topics: vars.topics,
                      people: vars.people,
                    },
                  }
                : thought,
            ),
          },
  });

  const deleteThought = useOptimisticMutation<BrowseData, string>({
    queryKey,
    mutationFn: (id) =>
      mutateJson(`/api/kith/thoughts/${id}`, { method: "DELETE" }),
    apply: (current, id) =>
      current.view !== "thoughts"
        ? current
        : {
            ...current,
            thoughts: current.thoughts.filter((thought) => thought.id !== id),
          },
  });

  return (
    <div>
      <PageHeader title="Browse" />

      <section
        aria-label="Browse inventory"
        className="kith-tile overflow-hidden"
      >
        <div className="kith-tile-header flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <Segment
            options={[
              {
                href: href("facts", includeHistorical),
                label: "Facts",
                active: data.view === "facts",
              },
              {
                href: href("thoughts", includeHistorical, type),
                label: "Thoughts",
                active: data.view === "thoughts",
              },
            ]}
          />
          <p className="text-meta text-kith-text-secondary" aria-live="polite">
            {data.view === "facts" ? data.facts.length : data.thoughts.length}{" "}
            {data.view}
          </p>
        </div>

        <div className="p-4">
          {data.view === "facts" ? (
            <FactsTable
              facts={data.facts}
              includeHistorical={includeHistorical}
              onEdit={async (id, value, options) => {
                await editFact.mutateAsync({ id, value, ...options });
              }}
              onRetire={async (id) => {
                await retireFact.mutateAsync(id);
              }}
            />
          ) : (
            <KithThoughtSearch
              key={`${type}-${includeHistorical}`}
              initialThoughts={data.thoughts}
              type={type}
              includeHistorical={includeHistorical}
              onEdit={async (id, values) => {
                await editThought.mutateAsync({ id, ...values });
              }}
              onDelete={async (id) => {
                await deleteThought.mutateAsync(id);
              }}
              toolbar={
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="thought-type" className="sr-only">
                    Thought type
                  </label>
                  <select
                    id="thought-type"
                    value={type}
                    onChange={(event) =>
                      router.push(
                        href("thoughts", includeHistorical, event.target.value),
                      )
                    }
                    className={inputClass}
                  >
                    <option value="">All types</option>
                    {THOUGHT_TYPES.map((value) => (
                      <option key={value} value={value}>
                        {label(value)}
                      </option>
                    ))}
                  </select>
                  <HistoryToggle
                    on={includeHistorical}
                    to={href("thoughts", !includeHistorical, type)}
                  />
                </div>
              }
            />
          )}
        </div>
      </section>
    </div>
  );
}
