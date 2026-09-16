// The PostgreSQL dashboard. A server component: `app/(authenticated)/page.tsx`
// already loaded `stats` and `recent` from one read-only transaction, so this
// file only renders them. It imports nothing from Convex.
//
// Quick Capture is not ported here. The Convex version's capture button calls
// `thoughts.publicActions.capture`, which classifies raw text into a thought
// (type, topics, people, summary) through an LLM call before it decides
// whether anything is stored at all -- domain logic row i explicitly adds
// none of, and no PostgreSQL equivalent exists yet (`memory.captureThought`
// takes metadata that is already classified). The section stays visible so the
// gap is legible, not silently dropped.

import type { memory } from "@repo/kith-store";

import { ThoughtCard } from "@/features/thoughts/components/ThoughtCard";

export function KithDashboard({
  stats,
  recent,
}: {
  stats: memory.SpaceStats;
  recent: readonly memory.Thought[];
}) {
  return (
    <div>
      <h1>Dashboard</h1>

      <div
        style={{
          display: "flex",
          gap: 24,
          marginBottom: 24,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            padding: 16,
            border: "1px solid #eee",
            borderRadius: 8,
            minWidth: 120,
          }}
        >
          <div style={{ fontSize: 32, fontWeight: "bold" }}>
            {stats.totalFacts}
          </div>
          <div style={{ color: "#666" }}>facts</div>
        </div>
        <div
          style={{
            padding: 16,
            border: "1px solid #eee",
            borderRadius: 8,
            minWidth: 120,
          }}
        >
          <div style={{ fontSize: 32, fontWeight: "bold" }}>
            {stats.totalThoughts}
          </div>
          <div style={{ color: "#666" }}>thoughts</div>
        </div>
        {stats.byType.slice(0, 3).map((t) => (
          <div
            key={t.type}
            style={{
              padding: 16,
              border: "1px solid #eee",
              borderRadius: 8,
              minWidth: 120,
            }}
          >
            <div style={{ fontSize: 32, fontWeight: "bold" }}>{t.count}</div>
            <div style={{ color: "#666" }}>{t.type.replace("_", " ")}</div>
          </div>
        ))}
      </div>

      <div
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: 8,
          padding: 16,
          backgroundColor: "#fafafa",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Quick Capture</h3>
        <p style={{ color: "#666", margin: 0 }}>
          Quick Capture is not available on this surface yet. Use an MCP
          client&apos;s <code>capture_thought</code> tool, or the Getting
          Started guide, to add a thought.
        </p>
      </div>

      <h2 style={{ marginTop: 32 }}>Recent Thoughts</h2>
      {recent.length === 0 ? (
        <p style={{ color: "#666" }}>
          No thoughts yet. Connect an AI client via MCP to capture one.{" "}
          <a href="/getting-started" style={{ color: "#0070f3" }}>
            Check out the Getting Started guide
          </a>{" "}
          to seed your brain.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {recent.map((thought) => (
            <ThoughtCard
              key={thought.id}
              thought={{
                _id: thought.id,
                _creationTime: thought.createdAt,
                content: thought.content,
                metadata: {
                  type: thought.metadata.type,
                  topics: [...thought.metadata.topics],
                  people: [...thought.metadata.people],
                  actionItems: [...thought.metadata.actionItems],
                  summary: thought.metadata.summary,
                },
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
