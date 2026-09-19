"use client";

// A filesystem source account's worker heartbeat, as one tag in the settings
// table: a poll of `GET /api/status/worker` through `useStatusPoll`, fetched
// on mount and every ten seconds after.
//
// Polled rather than driven by the change feed on purpose: "overdue" is a
// function of the clock, and nothing writes a row when a heartbeat fails to
// arrive.
//
// A heartbeat confirms worker contact with Kith Mind. It does not confirm file
// access or record completeness; the tooltip says as much in one line.

import { Detail, Tag } from "@/components/ui/data-table";
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

  if (status === null) return <Tag>loading</Tag>;
  if (status.watcher.state === "not_configured") return <Tag>no watcher</Tag>;
  if (status.watcher.state === "awaiting_heartbeat") return <Tag>awaiting</Tag>;

  const detail = [
    `Last heartbeat ${localTime(status.watcher.lastHeartbeatAt)}`,
    possiblyStale ? "Could not refresh; last known value" : "",
    "Confirms worker contact only, not file access",
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <span className="inline-flex items-center gap-1">
      <Detail
        label={
          <Tag tone={status.stale ? "warn" : "accent"}>
            {status.stale ? "overdue" : "current"}
          </Tag>
        }
        detail={detail}
      />
      {status.incident.state === "open" && (
        <span role="alert">
          <Tag tone="warn">incident open</Tag>
        </span>
      )}
    </span>
  );
}
