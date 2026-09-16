// The PostgreSQL browse page. A server component fed by `loadBrowse`'s one
// read-only transaction: it imports nothing from Convex and needs no client
// JavaScript, because every filter is a plain `GET` form or link over the
// page's own query string.

import type { memory } from "@repo/kith-store";

import type { BrowseData, BrowseView } from "@/lib/kith/browse";

const THOUGHT_TYPES = [
  "decision",
  "person_note",
  "idea",
  "meeting_note",
  "task",
  "reference",
] as const;

function tabLink(view: BrowseView, current: BrowseView) {
  const active = view === current;
  return (
    <a
      href={`/browse?view=${view}`}
      style={{
        padding: "6px 16px",
        background: active ? "#333" : "transparent",
        color: active ? "#fff" : "#666",
        textDecoration: "none",
      }}
    >
      {view === "facts" ? "Facts" : "Thoughts"}
    </a>
  );
}

function FactRow({ fact }: { fact: memory.HydratedFact }) {
  return (
    <div
      style={{
        border: "1px solid #e0e0e0",
        borderRadius: 8,
        padding: "14px 16px",
        background: fact.status === "current" ? "#fff" : "#fafafa",
        opacity: fact.status === "current" ? 1 : 0.72,
      }}
    >
      <div style={{ fontSize: 16 }}>{fact.statement}</div>
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginTop: 8,
          fontSize: 12,
          color: "#666",
        }}
      >
        <span>{fact.subject?.key ?? "unknown subject"}</span>
        <span>·</span>
        <span>{fact.predicate}</span>
        <span>·</span>
        <span>{fact.status}</span>
        {fact.isCore && (
          <>
            <span>·</span>
            <span>core</span>
          </>
        )}
        {fact.validFrom !== undefined && (
          <>
            <span>·</span>
            <span>from {new Date(fact.validFrom).toLocaleDateString()}</span>
          </>
        )}
        {fact.validTo !== undefined && (
          <>
            <span>·</span>
            <span>until {new Date(fact.validTo).toLocaleDateString()}</span>
          </>
        )}
      </div>
    </div>
  );
}

function ThoughtRow({ thought }: { thought: memory.Thought & { score?: number } }) {
  return (
    <div
      style={{
        border: "1px solid #e0e0e0",
        borderRadius: 8,
        padding: 16,
        backgroundColor: "#fff",
      }}
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 12,
            backgroundColor: "#e8eaf6",
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
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#999" }}>
          {new Date(thought.createdAt).toLocaleDateString()}
        </span>
      </div>
      <p style={{ margin: 0, lineHeight: 1.5 }}>{thought.content}</p>
    </div>
  );
}

export function KithBrowse({
  data,
  includeHistorical,
  type,
  query,
}: {
  data: BrowseData;
  includeHistorical: boolean;
  type: string;
  query: string;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <h1 style={{ margin: 0 }}>Browse</h1>
        <div
          style={{
            display: "flex",
            background: "#f0f0f0",
            borderRadius: 6,
            overflow: "hidden",
            fontSize: 14,
          }}
        >
          {tabLink("facts", data.view)}
          {tabLink("thoughts", data.view)}
        </div>
      </div>

      {data.view === "facts" ? (
        <div>
          <form
            method="get"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 16,
            }}
          >
            <input type="hidden" name="view" value="facts" />
            <p style={{ color: "#666", margin: 0 }}>
              Precise attributes and relationships. Changed values remain
              available as history.
            </p>
            <label style={{ fontSize: 13, color: "#666" }}>
              <input
                type="checkbox"
                name="historical"
                value="1"
                defaultChecked={includeHistorical}
                style={{ marginRight: 6 }}
              />
              Show history{" "}
              <button type="submit" style={{ marginLeft: 8 }}>
                Apply
              </button>
            </label>
          </form>
          {data.facts.length === 0 ? (
            <p style={{ color: "#666" }}>
              No structured facts yet. AI clients can add exact dates,
              relationships, providers, schools, and other durable attributes.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {data.facts.map((fact) => (
                <FactRow key={fact.id} fact={fact} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div>
          <form
            method="get"
            style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}
          >
            <input type="hidden" name="view" value="thoughts" />
            <input
              type="text"
              name="q"
              defaultValue={query}
              placeholder="Search your thoughts..."
              style={{
                flex: 1,
                minWidth: 200,
                padding: 10,
                borderRadius: 4,
                border: "1px solid #ddd",
              }}
            />
            <select
              name="type"
              defaultValue={type}
              style={{ padding: 8, borderRadius: 4, border: "1px solid #ddd" }}
            >
              <option value="">All types</option>
              {THOUGHT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace("_", " ")}
                </option>
              ))}
            </select>
            <label style={{ fontSize: 13, color: "#666", alignSelf: "center" }}>
              <input
                type="checkbox"
                name="historical"
                value="1"
                defaultChecked={includeHistorical}
                style={{ marginRight: 6 }}
              />
              Show history
            </label>
            <button type="submit" style={{ padding: "10px 20px", borderRadius: 4 }}>
              Apply
            </button>
          </form>
          {data.thoughts.length === 0 ? (
            <p style={{ color: "#666" }}>
              {data.searching
                ? "No matching thoughts found."
                : "No thoughts found."}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {data.thoughts.map((thought) => (
                <ThoughtRow key={thought.id} thought={thought} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
