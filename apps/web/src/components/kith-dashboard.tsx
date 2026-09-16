"use client";

// The PostgreSQL dashboard. `app/(authenticated)/page.tsx` loads `stats` and
// `recent` from one read-only transaction for the first paint and passes
// them in as this component's initial poll value; from there this component
// polls `GET /api/status/dashboard` every 10 seconds for a refresh (plan
// section 5's live-surface design, wired in by i6), through the same
// `useStatusPoll` hook `kith-worker-heartbeat-status.tsx` uses. A failed poll
// keeps the last good stats and thoughts and marks them possibly stale rather
// than blanking the page -- see that hook and `lib/kith/poll.ts` for why.
// This file imports nothing from Convex.
//
// Quick Capture is not ported here. The Convex version's capture button calls
// `thoughts.publicActions.capture`, which classifies raw text into a thought
// (type, topics, people, summary) through an LLM call before it decides
// whether anything is stored at all -- domain logic row i explicitly adds
// none of, and no PostgreSQL equivalent exists yet (`memory.captureThought`
// takes metadata that is already classified). The section stays visible so the
// gap is legible, not silently dropped.

import { ThoughtCard } from "@/features/thoughts/components/ThoughtCard";
import { useStatusPoll } from "@/lib/kith/use-status-poll";

type DashboardStats = {
  totalFacts: number;
  totalThoughts: number;
  byType: Array<{ type: string; count: number }>;
};

type DashboardThought = {
  id: string;
  content: string;
  createdAt: number;
  metadata: {
    type: string;
    topics: readonly string[];
    people: readonly string[];
    actionItems: readonly string[];
    summary: string;
  };
};

type DashboardData = {
  stats: DashboardStats;
  recent: readonly DashboardThought[];
};

export function KithDashboard({ stats, recent }: DashboardData) {
  const { value: data, possiblyStale } = useStatusPoll<DashboardData>(
    "/api/status/dashboard",
    { stats, recent },
  );

  return (
    <div>
      <h1>Dashboard</h1>

      <div
        style={{
          display: "flex",
          gap: 24,
          marginBottom: 8,
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
            {data.stats.totalFacts}
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
            {data.stats.totalThoughts}
          </div>
          <div style={{ color: "#666" }}>thoughts</div>
        </div>
        {data.stats.byType.slice(0, 3).map((t) => (
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
      {possiblyStale && (
        <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>
          Could not refresh just now; showing the last known values.
        </p>
      )}

      <div
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: 8,
          padding: 16,
          backgroundColor: "#fafafa",
          marginTop: 16,
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
      {data.recent.length === 0 ? (
        <p style={{ color: "#666" }}>
          No thoughts yet. Connect an AI client via MCP to capture one.{" "}
          <a href="/getting-started" style={{ color: "#0070f3" }}>
            Check out the Getting Started guide
          </a>{" "}
          to seed your brain.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {data.recent.map((thought) => (
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
