// The worker heartbeat status the web app shows, computed at read time.
//
// This is the web app's read side of P2-39j's read-time staleness predicate
// (`workers.watcherStaleness`, `packages/kith-store/src/workers/diagnostics.ts`):
// a host that is down reports itself stale without needing to be up, because
// nothing here depends on a per-minute sweep having run. Nothing in this
// module writes a heartbeat or an incident; that stays the worker protocol's
// `POST /api/worker` path (i4, out of i6's scope).
//
// Authorization: `sources.listSourceAccounts` returns only source accounts in
// the caller's own authorized spaces (`getAuthorizedReadSpaceIds` runs inside
// it), never a space id taken from the request. `sourceAccountId` is looked up
// in that already-authorized list rather than loaded by id and checked
// second, so a source account that exists but is in a space the caller
// cannot read is indistinguishable from one that does not exist at all.

import { sources, workers } from "@repo/kith-store";
import { type IdentityCtx, IdentityError, type Principal } from "@repo/kith-store/identity";

export type WorkerStatusWatcher =
  | { state: "not_configured" }
  | { state: "awaiting_heartbeat"; watcherId: string }
  | {
      state: "current" | "overdue";
      watcherId: string;
      lastHeartbeatAt: number;
      nextExpectedAt: number;
    };

export type WorkerStatus = {
  sourceAccountId: string;
  watcher: WorkerStatusWatcher;
  /** `WORKER_HEARTBEAT_OVERDUE_MS`, the window a heartbeat is judged against. */
  windowMs: number;
  /** `true` exactly when `watcher.state === "overdue"`, spelled out for a caller that does not want to pattern-match the union. */
  stale: boolean;
  incident: { state: "open"; openedAt: number } | { state: "none" };
};

type WatcherRow = {
  watcher_id: string;
  state: string;
  last_seen_at: Date | null;
  next_expected_at: Date | null;
};

type IncidentRow = { opened_at: Date };

/**
 * The status for one source account, or an `IdentityError` ("Source account
 * not found") when it does not exist or is outside every space `principal`
 * can read.
 */
export async function loadWorkerStatus(
  ctx: IdentityCtx,
  principal: Principal,
  sourceAccountId: string,
): Promise<WorkerStatus> {
  const accounts = await sources.listSourceAccounts(ctx, { principal });
  if (!accounts.some((account) => account.id === sourceAccountId)) {
    throw new IdentityError("Source account not found");
  }

  const watcherRow = (
    await workers.rows<WatcherRow>(
      ctx,
      `SELECT watcher_id, state, last_seen_at, next_expected_at
         FROM kith.worker_watcher_states WHERE source_account_id = $1 LIMIT 1`,
      [sourceAccountId],
    )
  )[0];
  const incidentRow = (
    await workers.rows<IncidentRow>(
      ctx,
      `SELECT opened_at FROM kith.worker_operational_incidents
         WHERE source_account_id = $1 AND state = 'open' LIMIT 1`,
      [sourceAccountId],
    )
  )[0];

  const incident: WorkerStatus["incident"] = incidentRow
    ? { state: "open", openedAt: incidentRow.opened_at.getTime() }
    : { state: "none" };

  if (!watcherRow) {
    return {
      sourceAccountId,
      watcher: { state: "not_configured" },
      windowMs: workers.WORKER_HEARTBEAT_OVERDUE_MS,
      stale: false,
      incident,
    };
  }

  const staleness = workers.watcherStaleness(
    {
      state: watcherRow.state as "awaiting_heartbeat" | "active",
      nextExpectedAt: watcherRow.next_expected_at,
    },
    ctx.now,
  );

  if (staleness === "not_configured" || staleness === "awaiting_heartbeat") {
    return {
      sourceAccountId,
      watcher: { state: "awaiting_heartbeat", watcherId: watcherRow.watcher_id },
      windowMs: workers.WORKER_HEARTBEAT_OVERDUE_MS,
      stale: false,
      incident,
    };
  }

  return {
    sourceAccountId,
    watcher: {
      state: staleness,
      watcherId: watcherRow.watcher_id,
      lastHeartbeatAt: watcherRow.last_seen_at!.getTime(),
      nextExpectedAt: watcherRow.next_expected_at!.getTime(),
    },
    windowMs: workers.WORKER_HEARTBEAT_OVERDUE_MS,
    stale: staleness === "overdue",
    incident,
  };
}
