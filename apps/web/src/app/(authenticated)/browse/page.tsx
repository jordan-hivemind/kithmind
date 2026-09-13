"use client";

import { api } from "@repo/db/convex/_generated/api";
import { useQuery } from "convex/react";
import { useState } from "react";

import { ThoughtsView } from "@/features/thoughts/components/ThoughtsView";

type View = "facts" | "thoughts";

export default function BrowsePage() {
  const [view, setView] = useState<View>("facts");
  const [showHistoricalFacts, setShowHistoricalFacts] = useState(false);

  const facts = useQuery(
    api.models.facts.public.listRecent,
    view === "facts"
      ? { limit: 50, includeHistorical: showHistoricalFacts }
      : "skip",
  );

  return (
    <div>
      {/* Header with toggle */}
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
          <div
            onClick={() => setView("facts")}
            style={{
              padding: "6px 16px",
              background: view === "facts" ? "#333" : "transparent",
              color: view === "facts" ? "#fff" : "#666",
              cursor: "pointer",
            }}
          >
            Facts
          </div>
          <div
            onClick={() => setView("thoughts")}
            style={{
              padding: "6px 16px",
              background: view === "thoughts" ? "#333" : "transparent",
              color: view === "thoughts" ? "#fff" : "#666",
              cursor: "pointer",
            }}
          >
            Thoughts
          </div>
        </div>
      </div>

      {view === "facts" ? (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 16,
            }}
          >
            <p style={{ color: "#666", margin: 0 }}>
              Precise attributes and relationships. Changed values remain
              available as history.
            </p>
            <label style={{ fontSize: 13, color: "#666" }}>
              <input
                type="checkbox"
                checked={showHistoricalFacts}
                onChange={(event) =>
                  setShowHistoricalFacts(event.target.checked)
                }
                style={{ marginRight: 6 }}
              />
              Show history
            </label>
          </div>
          {facts === undefined ? (
            <p style={{ color: "#666" }}>Loading...</p>
          ) : facts.length === 0 ? (
            <p style={{ color: "#666" }}>
              No structured facts yet. AI clients can add exact dates,
              relationships, providers, schools, and other durable attributes.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {facts.map((fact) => (
                <div
                  key={fact.id}
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
                        <span>
                          from {new Date(fact.validFrom).toLocaleDateString()}
                        </span>
                      </>
                    )}
                    {fact.validTo !== undefined && (
                      <>
                        <span>·</span>
                        <span>
                          until {new Date(fact.validTo).toLocaleDateString()}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <ThoughtsView />
      )}
    </div>
  );
}
