"use client";

// Quick Capture, posting to `POST /api/kith/thoughts/capture`
// (`lib/kith/capture.ts`'s `captureThoughtFromWeb`).
//
// Not optimistic, deliberately: the route runs a classifier and an admission
// gate, and may store, merge, supersede or refuse the text. Guessing the
// outcome would show a thought that then vanishes. A stored capture clears the
// box and shows its classification; the recent list picks it up from the change
// feed. Every other disposition keeps the text and shows `operationSummary` so
// it can be edited and resent.

import { useState } from "react";

import { Button, inputClass } from "@/components/ui/controls";

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
  const [status, setStatus] = useState<{
    text: string;
    failed: boolean;
  } | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) return;

    setLoading(true);
    setStatus(null);
    try {
      const response = await fetch("/api/kith/thoughts/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trimmed }),
      });
      if (response.status === 401) {
        setStatus({
          text: "Sign in again to capture a thought.",
          failed: true,
        });
        return;
      }
      if (!response.ok) {
        setStatus({
          text: "Failed to capture thought. Please try again.",
          failed: true,
        });
        return;
      }
      const result = (await response.json()) as CaptureResponse;
      if (result.disposition === "stored") {
        setStatus({
          text: `Saved as ${result.metadata.type.replaceAll("_", " ")}: ${result.metadata.summary}`,
          failed: false,
        });
        setContent("");
      } else {
        setStatus({
          text:
            result.operationSummary ??
            "This was not stored. Try one coherent durable narrative, or use a structured fact.",
          failed: true,
        });
      }
    } catch {
      setStatus({
        text: "Failed to capture thought. Please try again.",
        failed: true,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="flex flex-col gap-1.5"
    >
      <label
        htmlFor="quick-capture"
        className="text-sm font-medium text-gray-600"
      >
        Capture
      </label>
      <div className="flex items-start gap-2">
        <textarea
          id="quick-capture"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Thought, decision, note or idea"
          rows={2}
          className={`${inputClass} h-auto min-h-14 flex-1 resize-y py-1.5`}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={loading || !content.trim()}
        >
          {loading ? "Saving..." : "Capture"}
        </Button>
      </div>
      {status && (
        <p
          role={status.failed ? "alert" : "status"}
          className={`text-xs ${status.failed ? "text-red-700" : "text-gray-600"}`}
        >
          {status.text}
        </p>
      )}
    </form>
  );
}
