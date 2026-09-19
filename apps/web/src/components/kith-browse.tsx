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

import type { memory } from "@repo/kith-store";
import { type ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { KithThoughtSearch } from "@/components/kith-thought-search";
import { inputClass, PageHeader } from "@/components/ui/controls";
import { DataTable, Tag } from "@/components/ui/data-table";
import type { BrowseData, BrowseView } from "@/lib/kith/browse";
import { label, shortDate } from "@/lib/kith/format";
import { useServerData } from "@/lib/kith/use-server-data";

const THOUGHT_TYPES = [
  "decision",
  "person_note",
  "idea",
  "meeting_note",
  "task",
  "reference",
] as const;

const LIVE_TABLES = ["thoughts", "facts"] as const;

function href(view: BrowseView, historical: boolean, type = ""): string {
  const params = new URLSearchParams({ view });
  if (historical) params.set("historical", "1");
  if (type) params.set("type", type);
  return `/browse?${params.toString()}`;
}

/** Square segmented links: the current one filled blue. */
function Segment({
  options,
}: {
  options: readonly { href: string; label: string; active: boolean }[];
}) {
  return (
    <div className="flex rounded-tag border border-gray-300 text-xs">
      {options.map((option) => (
        <Link
          key={option.label}
          href={option.href}
          aria-current={option.active ? "page" : undefined}
          className={`px-3 py-1 focus-visible:outline-2 focus-visible:outline-accent-600 ${
            option.active
              ? "bg-accent-600 text-white"
              : "bg-white text-gray-700 hover:bg-gray-50"
          }`}
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
}

/** History on or off: a link to the other state, styled like a chip. */
function HistoryToggle({ on, to }: { on: boolean; to: string }) {
  return (
    <Link
      href={to}
      aria-label={on ? "Hide history" : "Show history"}
      className={`rounded-tag border px-1.5 py-0.5 text-[11px] leading-none focus-visible:outline-2 focus-visible:outline-accent-600 ${
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
}: {
  facts: readonly memory.HydratedFact[];
  includeHistorical: boolean;
}) {
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
        cell: ({ row }) => (
          <span className={row.original.status === "current" ? "" : "text-gray-500"}>
            {row.original.statement}
          </span>
        ),
      },
      { id: "subject", accessorKey: "subject", header: "Subject" },
      { id: "predicate", accessorKey: "predicate", header: "Predicate" },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
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
        cell: ({ row }) => (row.original.core ? <Tag>core</Tag> : null),
      },
      {
        id: "validFrom",
        accessorKey: "validFrom",
        header: "From",
        meta: { nowrap: true },
        cell: ({ row }) => (
          <span className="text-gray-600 tabular-nums">{shortDate(row.original.validFrom)}</span>
        ),
      },
      {
        id: "validTo",
        accessorKey: "validTo",
        header: "Until",
        meta: { nowrap: true },
        cell: ({ row }) => (
          <span className="text-gray-600 tabular-nums">{shortDate(row.original.validTo)}</span>
        ),
      },
    ],
    [],
  );
  return (
    <DataTable
      id="browse-facts"
      data={rows}
      columns={columns}
      filterColumns={["status", "core", "predicate"]}
      initialSorting={[{ id: "subject", desc: false }]}
      searchPlaceholder="Search facts"
      empty="No facts"
      toolbar={
        <span className="ml-auto">
          <HistoryToggle on={includeHistorical} to={href("facts", !includeHistorical)} />
        </span>
      }
    />
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
  const data = useServerData<BrowseData>(
    ["browse", server.view, type, includeHistorical],
    server,
    LIVE_TABLES,
  );

  return (
    <div>
      <PageHeader title="Browse">
        <Segment
          options={[
            { href: href("facts", includeHistorical), label: "Facts", active: data.view === "facts" },
            {
              href: href("thoughts", includeHistorical, type),
              label: "Thoughts",
              active: data.view === "thoughts",
            },
          ]}
        />
      </PageHeader>

      {data.view === "facts" ? (
        <FactsTable facts={data.facts} includeHistorical={includeHistorical} />
      ) : (
        <KithThoughtSearch
          key={`${type}-${includeHistorical}`}
          initialThoughts={data.thoughts}
          type={type}
          includeHistorical={includeHistorical}
          toolbar={
            <span className="ml-auto flex items-center gap-2">
              <label htmlFor="thought-type" className="sr-only">
                Type
              </label>
              <select
                id="thought-type"
                value={type}
                onChange={(event) =>
                  router.push(href("thoughts", includeHistorical, event.target.value))
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
            </span>
          }
        />
      )}
    </div>
  );
}
