"use client";

// The "Attention" nav link's own count badge (ADM-8a section 5's "counts by
// severity for a nav badge that counts ONLY attention and alert, never
// info"). Shown on every admin page, not just the attention screen, so it
// lives in the layout rather than the screen's own table.
//
// Live the same way every other admin count is: an initial value from the
// server component that renders it, then `useLiveChanges` invalidates on a
// `corrections` change and the query refetches. Hidden entirely at zero --
// the owner's screen should say nothing when there is nothing to say.

import { useQuery } from "@tanstack/react-query";

import { useLiveChanges } from "@/lib/kith/use-live-changes";

const WATCHED = { "attention-counts": ["corrections"] } as const;

export function AttentionBadge({
  initial,
}: {
  initial: { attention: number; alert: number };
}) {
  useLiveChanges(WATCHED);
  const { data } = useQuery({
    queryKey: ["attention-counts"],
    queryFn: async (): Promise<{ attention: number; alert: number }> => {
      const response = await fetch("/api/kith/attention/counts", {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("attention counts fetch failed");
      return (await response.json()) as { attention: number; alert: number };
    },
    initialData: initial,
  });
  const total = data.attention + data.alert;
  if (total === 0) return null;
  return (
    <span
      className={`ml-1 inline-flex min-w-4 items-center justify-center rounded-tag border px-1 text-[10px] leading-none ${
        data.alert > 0
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-accent-200 bg-accent-50 text-accent-700"
      }`}
    >
      {total}
    </span>
  );
}
