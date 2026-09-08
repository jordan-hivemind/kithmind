"use client";

import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { useQuery } from "convex/react";

function localTime(value: number) {
  return new Date(value).toLocaleString();
}

export function WorkerHeartbeatStatus({
  sourceAccountId,
}: {
  sourceAccountId: Id<"sourceAccounts">;
}) {
  const status = useQuery(api.models.diagnostics.public.status, {
    sourceAccountId,
  });

  if (status === undefined) return <p>Loading worker heartbeat...</p>;
  if (status.source === "disabled") {
    return <p>This source is disabled. Worker heartbeat is unavailable.</p>;
  }
  if (status.watcher.state === "not_configured") {
    return <p>No worker watcher is configured yet.</p>;
  }
  if (status.watcher.state === "awaiting_heartbeat") {
    return <p>Worker watcher is awaiting its first heartbeat.</p>;
  }

  const overdue = status.watcher.state === "overdue";
  return (
    <div>
      <p>
        Worker heartbeat: {overdue ? "overdue" : "current"}. Last successful
        heartbeat: {localTime(status.watcher.lastSeenAt)}.
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
