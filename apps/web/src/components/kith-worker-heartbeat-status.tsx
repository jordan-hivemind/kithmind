"use client";

// The PostgreSQL worker heartbeat status: a poll of `GET /api/status/worker`
// through `useStatusPoll` instead of the Convex subscription
// `convex-worker-heartbeat-status.tsx` uses. Presentation matches that file
// so the two surfaces read the same to someone watching the settings page,
// modulo the "possibly stale" marker a failed poll adds here and a Convex
// subscription never needed.
//
// No initial value comes from the settings page's own loader (`settings-data.ts`
// is unchanged by i6), so this starts in the same "Loading worker
// heartbeat..." state the Convex version's `status === undefined` case
// rendered, and fetches immediately on mount rather than waiting for the
// first ten-second tick.

import { useStatusPoll } from "@/lib/kith/use-status-poll";

type WorkerStatusResponse = {
  watcher:
    | { state: "not_configured" }
    | { state: "awaiting_heartbeat"; watcherId: string }
    | {
        state: "current" | "overdue";
        watcherId: string;
        lastHeartbeatAt: number;
        nextExpectedAt: number;
      };
  stale: boolean;
  incident: { state: "open"; openedAt: number } | { state: "none" };
};

function localTime(value: number) {
  return new Date(value).toLocaleString();
}

export function WorkerHeartbeatStatus({
  sourceAccountId,
}: {
  sourceAccountId: string;
}) {
  const { value: status, possiblyStale } = useStatusPoll<WorkerStatusResponse | null>(
    `/api/status/worker?sourceAccountId=${encodeURIComponent(sourceAccountId)}`,
    null,
    { immediate: true },
  );

  if (status === null) return <p>Loading worker heartbeat...</p>;
  if (status.watcher.state === "not_configured") {
    return <p>No worker watcher is configured yet.</p>;
  }
  if (status.watcher.state === "awaiting_heartbeat") {
    return <p>Worker watcher is awaiting its first heartbeat.</p>;
  }

  return (
    <div>
      <p>
        Worker heartbeat: {status.stale ? "overdue" : "current"}. Last
        successful heartbeat: {localTime(status.watcher.lastHeartbeatAt)}.
        {possiblyStale && (
          <> (Could not refresh just now; showing the last known value.)</>
        )}
      </p>
      {status.incident.state === "open" && (
        <p role="alert">Missing-worker incident is open.</p>
      )}
      <p style={{ color: "#666", fontSize: 13 }}>
        A heartbeat confirms worker contact with Kith Mind. It does not confirm
        file access or record completeness.
      </p>
    </div>
  );
}
