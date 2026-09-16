"use client";

// The browse page's thought search, on PostgreSQL.
//
// The search text is never put in the URL (`lib/kith/browse.ts` says why):
// this component posts it to `/api/kith/thoughts/search` and swaps the
// rendered list for the response, entirely client-side. The type filter and
// history toggle stay a plain `GET` form on the page around this component
// (bounded, enumerated values, not the free-text search), so changing either
// still reloads the page and remounts this component with fresh initial
// props; only the search box itself avoids a navigation.

import type { memory } from "@repo/kith-store";
import { useState } from "react";

import { ThoughtRow } from "@/components/kith-browse";

type ThoughtWithScore = memory.Thought & { score?: number };

type SearchResponse = {
  thoughts: ThoughtWithScore[];
  vectorStatus: "ready" | "unavailable";
};

export function KithThoughtSearch({
  initialThoughts,
  type,
  includeHistorical,
}: {
  initialThoughts: readonly ThoughtWithScore[];
  type: string;
  includeHistorical: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ThoughtWithScore[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    setSearching(true);
    setError("");
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
      setResults(body.thoughts);
    } catch {
      setError("Search failed. Try again.");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setQuery("");
    setResults(null);
    setError("");
  }

  const showingSearch = results !== null;
  const thoughts = showingSearch ? results : initialThoughts;

  return (
    <div>
      <form
        onSubmit={(event) => void runSearch(event)}
        style={{ display: "flex", gap: 8, marginBottom: 8 }}
      >
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your thoughts..."
          style={{
            flex: 1,
            minWidth: 200,
            padding: 10,
            borderRadius: 4,
            border: "1px solid #ddd",
          }}
        />
        <button
          type="submit"
          disabled={searching || !query.trim()}
          style={{ padding: "10px 20px", borderRadius: 4 }}
        >
          {searching ? "Searching..." : "Search"}
        </button>
        {showingSearch && (
          <button
            type="button"
            onClick={clearSearch}
            style={{
              padding: "10px 16px",
              borderRadius: 4,
              background: "none",
              border: "1px solid #ddd",
              color: "#666",
            }}
          >
            Clear
          </button>
        )}
      </form>
      <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>
        Search matches by keyword only on this surface. Full semantic search
        is available through an MCP client.
      </p>
      {error && (
        <p role="alert" style={{ color: "#b42318" }}>
          {error}
        </p>
      )}
      {thoughts.length === 0 ? (
        <p style={{ color: "#666" }}>
          {showingSearch ? "No matching thoughts found." : "No thoughts found."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {thoughts.map((thought) => (
            <ThoughtRow key={thought.id} thought={thought} />
          ))}
        </div>
      )}
    </div>
  );
}
