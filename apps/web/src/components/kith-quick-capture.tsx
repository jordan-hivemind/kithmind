"use client";

// Quick Capture on the PostgreSQL surface, posting to
// `POST /api/kith/thoughts/capture` (`lib/kith/capture.ts`'s
// `captureThoughtFromWeb`). Renders every disposition that route can return,
// the way `features/thoughts/components/QuickCapture.tsx` (the Convex
// version) renders its own: a stored capture clears the textarea and shows
// its classification, and every other disposition keeps the typed text and
// shows `operationSummary` so the person can edit and resend.

import { useState } from "react";

type CaptureResponse = {
  thoughtId?: string;
  metadata: { type: string; summary: string };
  disposition:
    | "stored"
    | "duplicate"
    | "superseded"
    | "corrected"
    | "needs_confirmation"
    | "skipped";
  operationSummary?: string;
};

export function KithQuickCapture() {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) return;

    setLoading(true);
    setStatus("");
    try {
      const response = await fetch("/api/kith/thoughts/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trimmed }),
      });
      if (response.status === 401) {
        setStatus("Sign in again to capture a thought.");
        return;
      }
      if (!response.ok) {
        setStatus("Failed to capture thought. Please try again.");
        return;
      }
      const result = (await response.json()) as CaptureResponse;
      if (result.disposition === "stored") {
        setStatus(
          `Saved as ${result.metadata.type.replace("_", " ")}: ${result.metadata.summary}`,
        );
        setContent("");
      } else {
        setStatus(
          result.operationSummary ??
            "This was not stored. Try one coherent durable narrative, or use a structured fact.",
        );
      }
    } catch {
      setStatus("Failed to capture thought. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        border: "1px solid #e0e0e0",
        borderRadius: 8,
        padding: 16,
        backgroundColor: "#fafafa",
      }}
    >
      <h3 style={{ marginTop: 0 }}>Quick Capture</h3>
      <form onSubmit={handleSubmit}>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Type a thought, decision, note, or idea..."
          rows={3}
          style={{
            width: "100%",
            padding: 8,
            boxSizing: "border-box",
            borderRadius: 4,
            border: "1px solid #ddd",
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            marginTop: 8,
          }}
        >
          <button
            type="submit"
            disabled={loading || !content.trim()}
            style={{
              padding: "8px 16px",
              cursor: loading ? "wait" : "pointer",
              borderRadius: 4,
            }}
          >
            {loading ? "Saving..." : "Capture"}
          </button>
          {status && <span style={{ fontSize: 14, color: "#666" }}>{status}</span>}
        </div>
      </form>
    </div>
  );
}
