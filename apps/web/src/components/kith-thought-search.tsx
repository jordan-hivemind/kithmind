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

import type { memory } from "@repo/kith-store";
import { type ColumnDef } from "@tanstack/react-table";
import { useEffect, useRef, useState } from "react";

import { DataTable, Detail, Tag } from "@/components/ui/data-table";
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
      <span className="text-gray-600 tabular-nums">{shortDate(row.original.createdAt)}</span>
    ),
  },
];

export function KithThoughtSearch({
  initialThoughts,
  type,
  includeHistorical,
  toolbar,
}: {
  initialThoughts: readonly ThoughtWithScore[];
  type: string;
  includeHistorical: boolean;
  toolbar?: React.ReactNode;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ThoughtWithScore[] | null>(null);
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

  const rows = thoughtRows(results ?? initialThoughts);

  return (
    <DataTable
      id="browse-thoughts"
      data={rows}
      columns={columns}
      filterColumns={["type"]}
      initialSorting={[{ id: "createdAt", desc: true }]}
      searchPlaceholder="Keyword search"
      onSearchChange={setQuery}
      empty={results === null ? "No thoughts" : "No matches"}
      toolbar={toolbar}
    />
  );
}
