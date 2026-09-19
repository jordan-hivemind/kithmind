"use client";

// The browse page's thoughts table, with search as you type.
//
// The listing is the page's own server read (the latest thoughts, filtered by
// type and history on the server). Typing searches on the server instead of
// filtering those rows: `POST /api/kith/thoughts/search` covers every thought
// in the caller's spaces, not only the ones on screen. The search text is
// never put in the URL (`lib/kith/browse.ts` says why).
//
// Requests are debounced, and a response that arrives after a newer one was
// sent is dropped, so typing fast cannot leave an older result on screen.
//
// Edit and delete are `KithBrowse`'s own optimistic mutations against the
// page's `["browse", ...]` cache, passed down as `onEdit`/`onDelete`: this
// component holds the search box and its results, not a data cache, so it has
// nothing of its own to roll back on failure. When a search is active,
// `handleEdit`/`handleDelete` additionally patch `results` once the parent's
// mutation has resolved, so a row edited or deleted mid-search leaves the list
// the typed query produced rather than only the page's unfiltered one.

import { type memory } from "@repo/kith-store";
import { type ColumnDef } from "@tanstack/react-table";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type ThoughtDraft,
  ThoughtDrawer,
} from "@/components/kith-thought-drawer";
import {
  DataTable,
  Detail,
  type RowAction,
  Tag,
} from "@/components/ui/data-table";
import { useToast } from "@/components/ui/toast";
import { label, shortDate } from "@/lib/kith/format";

type ThoughtWithScore = memory.Thought & { score?: number };

type SearchResponse = {
  thoughts: ThoughtWithScore[];
  vectorStatus: "ready" | "unavailable";
};

type ThoughtRow = {
  id: string;
  content: string;
  type: string;
  topics: string;
  createdAt: number;
};

type ThoughtEditValues = {
  content: string;
  type: memory.ThoughtType;
  topics: string[];
  people: string[];
};

const DEBOUNCE_MS = 250;

function thoughtRows(thoughts: readonly memory.Thought[]): ThoughtRow[] {
  return thoughts.map((thought) => ({
    id: thought.id,
    content: thought.content,
    type: label(thought.metadata.type),
    topics: thought.metadata.topics.join(", "),
    createdAt: thought.createdAt,
  }));
}

export function KithThoughtSearch({
  initialThoughts,
  type,
  includeHistorical,
  onEdit,
  onDelete,
  toolbar,
}: {
  initialThoughts: readonly ThoughtWithScore[];
  type: string;
  includeHistorical: boolean;
  /** The parent's optimistic mutation against its own cache. Resolves once
   * the write has been sent (and the cache patched); rejects, with nothing
   * applied, on failure. */
  onEdit: (id: string, values: ThoughtEditValues) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  toolbar?: React.ReactNode;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ThoughtWithScore[] | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    draft: ThoughtDraft;
  } | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    const request = ++latest.current;
    if (!trimmed) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/kith/thoughts/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: trimmed,
              includeHistorical,
              ...(type ? { type } : {}),
            }),
          });
          if (!response.ok) throw new Error("search failed");
          const body = (await response.json()) as SearchResponse;
          if (request === latest.current) setResults(body.thoughts);
        } catch {
          if (request === latest.current) {
            setResults([]);
            toast("Search failed. Try again.");
          }
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, type, includeHistorical, toast]);

  const thoughts = results ?? initialThoughts;
  const rows = thoughtRows(thoughts);

  const handleEdit = useCallback(
    async (id: string, values: ThoughtEditValues) => {
      await onEdit(id, values);
      setResults((current) =>
        current === null
          ? current
          : current.map((thought) =>
              thought.id === id
                ? {
                    ...thought,
                    content: values.content,
                    metadata: { ...thought.metadata, ...values },
                  }
                : thought,
            ),
      );
    },
    [onEdit],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await onDelete(id);
      setResults((current) =>
        current === null
          ? current
          : current.filter((thought) => thought.id !== id),
      );
    },
    [onDelete],
  );

  // Shared by the kebab's Edit item and clicking the row.
  const openEdit = useCallback(
    (row: ThoughtRow) => {
      const thought = thoughts.find((item) => item.id === row.id);
      if (!thought) return;
      setEditing({
        id: row.id,
        draft: {
          content: thought.content,
          type: thought.metadata.type,
          topics: thought.metadata.topics.join(", "),
          people: thought.metadata.people.join(", "),
        },
      });
    },
    [thoughts],
  );

  const columns: ColumnDef<ThoughtRow, unknown>[] = [
    {
      id: "content",
      accessorKey: "content",
      header: "Thought",
      cell: ({ row }) => (
        <span className="line-clamp-1 max-w-2xl">
          <Detail label={row.original.content} detail={row.original.content} />
        </span>
      ),
    },
    {
      id: "type",
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => <Tag>{row.original.type}</Tag>,
    },
    { id: "topics", accessorKey: "topics", header: "Topics" },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: "Created",
      meta: { nowrap: true },
      cell: ({ row }) => (
        <span className="text-gray-600 tabular-nums">
          {shortDate(row.original.createdAt)}
        </span>
      ),
    },
  ];

  const actions: RowAction<ThoughtRow>[] = [
    { label: "Edit", onSelect: openEdit },
    {
      label: "Delete",
      danger: true,
      onSelect: (row) => void handleDelete(row.id),
    },
    {
      label: "Copy id",
      onSelect: (row) => void navigator.clipboard.writeText(row.id),
    },
  ];

  return (
    <>
      <DataTable
        id="browse-thoughts"
        data={rows}
        columns={columns}
        filterColumns={["type"]}
        initialSorting={[{ id: "createdAt", desc: true }]}
        actions={actions}
        onRowClick={openEdit}
        searchPlaceholder="Keyword search"
        onSearchChange={setQuery}
        empty={results === null ? "No thoughts" : "No matches"}
        toolbar={toolbar}
      />

      {editing === null ? null : (
        <ThoughtDrawer
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          initial={editing.draft}
          onSave={async (values) => {
            await handleEdit(editing.id, values);
          }}
        />
      )}
    </>
  );
}
