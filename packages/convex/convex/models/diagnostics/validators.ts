import { v } from "convex/values";

export const workerWatcherStateValidator = v.union(
  v.object({ state: v.literal("not_configured") }),
  v.object({
    state: v.literal("awaiting_heartbeat"),
    watcherId: v.string(),
  }),
  v.object({
    state: v.union(v.literal("current"), v.literal("overdue")),
    watcherId: v.string(),
    lastSeenAt: v.number(),
    nextExpectedAt: v.number(),
  }),
);

export const workerIncidentSummaryValidator = v.union(
  v.object({ state: v.literal("none") }),
  v.object({
    state: v.literal("open"),
    kind: v.literal("missing_worker"),
    openedAt: v.number(),
  }),
);

export const workerDiagnosticsHeartbeatResultValidator = v.object({
  operation: v.literal("diagnostics.heartbeat"),
  sourceAccountId: v.string(),
  watcherId: v.string(),
  receivedAt: v.number(),
  nextExpectedAt: v.number(),
});

export const workerDiagnosticsStatusResultValidator = v.object({
  operation: v.literal("diagnostics.status"),
  diagnosticsVersion: v.literal(1),
  sourceAccountId: v.string(),
  source: v.literal("enabled"),
  watcher: workerWatcherStateValidator,
  incident: workerIncidentSummaryValidator,
});

export const ownerDiagnosticsStatusResultValidator = v.object({
  operation: v.literal("diagnostics.status"),
  diagnosticsVersion: v.literal(1),
  sourceAccountId: v.id("sourceAccounts"),
  source: v.union(v.literal("enabled"), v.literal("disabled")),
  watcher: workerWatcherStateValidator,
  incident: workerIncidentSummaryValidator,
});

export const ownerResetWatcherResultValidator = v.object({
  sourceAccountId: v.id("sourceAccounts"),
  watcherId: v.union(v.string(), v.null()),
  reused: v.boolean(),
  changedAt: v.number(),
});
