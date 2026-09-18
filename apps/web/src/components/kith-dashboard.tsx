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
// Quick Capture (i7a) posts to `POST /api/kith/thoughts/capture`, which runs
// `lib/kith/capture.ts`'s `captureThoughtFromWeb` -- the same model-backed
// admission gate the MCP `capture_thought` tool runs, classifier included,
// not a provider-free approximation of it. See that module's comment for the
// gate's shape (three transactions around two provider calls) and its own
// fail-closed behavior.

import { KithQuickCapture } from "@/components/kith-quick-capture";
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

const typeColors: Record<string, string> = {
  decision: "#e3f2fd",
  person_note: "#f3e5f5",
  idea: "#fff3e0",
  meeting_note: "#e8f5e9",
  task: "#fce4ec",
  reference: "#f5f5f5",
};

// `features/thoughts/components/ThoughtCard.tsx` unchanged except for the row
// shape, which is the store's rather than a Convex document's. It had no
// Convex import and only this one caller, so i7b moved it here instead of
// keeping a directory for it.
function ThoughtCard({ thought }: { thought: DashboardThought }) {
  const date = new Date(thought.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      style={{
        border: "1px solid #e0e0e0",
        borderRadius: 8,
        padding: 16,
        backgroundColor: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 12,
            backgroundColor:
              typeColors[thought.metadata.type] ?? typeColors.reference,
          }}
        >
          {thought.metadata.type.replace("_", " ")}
        </span>
        {thought.metadata.topics.map((topic) => (
          <span
            key={topic}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 12,
              backgroundColor: "#e8eaf6",
            }}
          >
            {topic}
          </span>
        ))}
        {thought.metadata.people.map((person) => (
          <span
            key={person}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 12,
              backgroundColor: "#fce4ec",
            }}
          >
            @{person}
          </span>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#999" }}>
          {date}
        </span>
      </div>
      <p style={{ margin: 0, lineHeight: 1.5 }}>{thought.content}</p>
      {thought.metadata.actionItems.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 20, color: "#666" }}>
          {thought.metadata.actionItems.map((item) => (
            <li key={item} style={{ fontSize: 14 }}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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

      <div style={{ marginTop: 16 }}>
        <KithQuickCapture />
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
            <ThoughtCard key={thought.id} thought={thought} />
          ))}
        </div>
      )}
    </div>
  );
}
