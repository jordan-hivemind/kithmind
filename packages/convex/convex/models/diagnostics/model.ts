import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { PrincipalRef } from "../../lib/spaces";
import { sha256Utf8 } from "../provenance/model";
import { requireWorkerSourceAccount } from "../workers/auth";
import { workerProtocolError } from "../workers/errors";
import type {
  WorkerDiagnosticsHeartbeatResult,
  WorkerDiagnosticsIncident,
  WorkerDiagnosticsStatusResult,
  WorkerDiagnosticsWatcher,
  WorkerRequest,
} from "../workers/protocol";

export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const WORKER_HEARTBEAT_OVERDUE_MS = 180_000;
export const WORKER_HEARTBEAT_SWEEP_INTERVAL_MS = 60_000;
export const WORKER_HEARTBEAT_SWEEP_LIMIT = 100;
export const WORKER_HEARTBEAT_MIN_WRITE_MS = 5_000;

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type SourceRequest = Pick<WorkerRequest, "spaceId" | "sourceAccountId">;

export type DiagnosticsSummary = {
  operation: "diagnostics.status";
  diagnosticsVersion: 1;
  sourceAccountId: Id<"sourceAccounts">;
  source: "enabled" | "disabled";
  watcher: WorkerDiagnosticsWatcher;
  incident: WorkerDiagnosticsIncident;
};

function validEpoch(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < Number.MAX_SAFE_INTEGER
  );
}

function nowPlus(now: number, duration: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER - 1, now + duration);
}

function validateNow(now: number): void {
  if (!validEpoch(now)) throw workerProtocolError("invalid_request");
}

async function watcherForSource(
  ctx: DbCtx,
  sourceAccountId: Id<"sourceAccounts">,
) {
  const rows = await ctx.db
    .query("workerWatcherStates")
    .withIndex("by_sourceAccountId", (q) =>
      q.eq("sourceAccountId", sourceAccountId),
    )
    .take(2);
  if (rows.length > 1) throw workerProtocolError("scan_conflict");
  return rows[0];
}

async function openIncidentForSource(
  ctx: DbCtx,
  sourceAccountId: Id<"sourceAccounts">,
) {
  const rows = await ctx.db
    .query("workerOperationalIncidents")
    .withIndex("by_sourceAccountId_and_state", (q) =>
      q.eq("sourceAccountId", sourceAccountId).eq("state", "open"),
    )
    .take(2);
  if (rows.length > 1) throw workerProtocolError("scan_conflict");
  return rows[0];
}

async function incidentForWatcher(
  ctx: DbCtx,
  sourceAccountId: Id<"sourceAccounts">,
  watcherId: string,
) {
  const rows = await ctx.db
    .query("workerOperationalIncidents")
    .withIndex("by_source_watcher_kind_state", (q) =>
      q
        .eq("sourceAccountId", sourceAccountId)
        .eq("watcherId", watcherId)
        .eq("kind", "missing_worker"),
    )
    .take(2);
  if (rows.length > 1) throw workerProtocolError("scan_conflict");
  return rows[0];
}

function validateWatcher(
  row: Doc<"workerWatcherStates">,
  account: Doc<"sourceAccounts">,
): void {
  if (
    row.sourceAccountId !== account._id ||
    row.spaceId !== account.spaceId ||
    !row.watcherId ||
    !validEpoch(row.createdAt) ||
    !validEpoch(row.updatedAt) ||
    (row.state === "awaiting_heartbeat" &&
      (row.connectorVersion !== undefined ||
        row.actorUserId !== undefined ||
        row.actorCredentialId !== undefined ||
        row.lastSeenAt !== undefined ||
        row.nextExpectedAt !== undefined ||
        row.sweepAfter !== undefined)) ||
    (row.state === "active" &&
      (!row.connectorVersion ||
        !row.actorUserId ||
        !row.actorCredentialId ||
        !validEpoch(row.lastSeenAt) ||
        !validEpoch(row.nextExpectedAt) ||
        row.nextExpectedAt < row.lastSeenAt ||
        row.nextExpectedAt !==
          nowPlus(row.lastSeenAt, WORKER_HEARTBEAT_OVERDUE_MS) ||
        (account.enabled
          ? !validEpoch(row.sweepAfter)
          : row.sweepAfter !== undefined)))
  ) {
    throw workerProtocolError("scan_conflict");
  }
}

function validateIncident(
  incident: Doc<"workerOperationalIncidents">,
  account: Doc<"sourceAccounts">,
  watcherId: string,
): void {
  if (
    incident.sourceAccountId !== account._id ||
    incident.spaceId !== account.spaceId ||
    incident.watcherId !== watcherId ||
    incident.kind !== "missing_worker" ||
    incident.state !== "open" ||
    !validEpoch(incident.openedAt) ||
    !validEpoch(incident.observedAt) ||
    incident.observedAt < incident.openedAt ||
    incident.resolvedAt !== undefined
  ) {
    throw workerProtocolError("scan_conflict");
  }
}

export async function diagnosticsSummary(
  ctx: DbCtx,
  account: Doc<"sourceAccounts">,
  now: number,
): Promise<DiagnosticsSummary> {
  validateNow(now);
  const watcher = await watcherForSource(ctx, account._id);
  const incident = await openIncidentForSource(ctx, account._id);
  if (!watcher) {
    if (incident) throw workerProtocolError("scan_conflict");
    return {
      operation: "diagnostics.status",
      diagnosticsVersion: 1,
      sourceAccountId: account._id,
      source: account.enabled ? "enabled" : "disabled",
      watcher: { state: "not_configured" },
      incident: { state: "none" },
    };
  }
  validateWatcher(watcher, account);
  if (incident) validateIncident(incident, account, watcher.watcherId);
  if (watcher.state === "awaiting_heartbeat") {
    if (incident) throw workerProtocolError("scan_conflict");
    return {
      operation: "diagnostics.status",
      diagnosticsVersion: 1,
      sourceAccountId: account._id,
      source: account.enabled ? "enabled" : "disabled",
      watcher: {
        state: "awaiting_heartbeat",
        watcherId: watcher.watcherId,
      },
      incident: { state: "none" },
    };
  }
  const state = now < watcher.nextExpectedAt! ? "current" : "overdue";
  if (incident && incident.openedAt < watcher.nextExpectedAt!) {
    throw workerProtocolError("scan_conflict");
  }
  if (state === "current" && incident) {
    throw workerProtocolError("scan_conflict");
  }
  return {
    operation: "diagnostics.status",
    diagnosticsVersion: 1,
    sourceAccountId: account._id,
    source: account.enabled ? "enabled" : "disabled",
    watcher: {
      state,
      watcherId: watcher.watcherId,
      lastSeenAt: watcher.lastSeenAt!,
      nextExpectedAt: watcher.nextExpectedAt!,
    },
    incident: incident
      ? { state: "open", kind: "missing_worker", openedAt: incident.openedAt }
      : { state: "none" },
  };
}

export async function getWorkerDiagnosticsStatus(
  ctx: QueryCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "diagnostics.status" }>,
  now: number,
): Promise<WorkerDiagnosticsStatusResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const result = await diagnosticsSummary(ctx, source.account, now);
  if (result.source !== "enabled")
    throw workerProtocolError("source_unavailable");
  return result as WorkerDiagnosticsStatusResult;
}

export async function recordWorkerHeartbeat(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "diagnostics.heartbeat" }>,
  now: number,
): Promise<WorkerDiagnosticsHeartbeatResult> {
  validateNow(now);
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const current = await watcherForSource(ctx, source.account._id);
  if (current) {
    validateWatcher(current, source.account);
    if (current.watcherId !== request.watcherId) {
      throw workerProtocolError("identity_review_required");
    }
  }
  const incident = await openIncidentForSource(ctx, source.account._id);
  if (incident) validateIncident(incident, source.account, request.watcherId);
  if (
    incident &&
    current?.state === "active" &&
    incident.openedAt < current.nextExpectedAt!
  ) {
    throw workerProtocolError("scan_conflict");
  }
  if (
    current?.state === "active" &&
    !incident &&
    now >= current.lastSeenAt! &&
    now - current.lastSeenAt! < WORKER_HEARTBEAT_MIN_WRITE_MS
  ) {
    return {
      operation: "diagnostics.heartbeat",
      sourceAccountId: source.account._id,
      watcherId: request.watcherId,
      receivedAt: current.lastSeenAt!,
      nextExpectedAt: current.nextExpectedAt!,
    };
  }
  const receivedAt = Math.max(now, current?.lastSeenAt ?? 0);
  const nextExpectedAt = nowPlus(receivedAt, WORKER_HEARTBEAT_OVERDUE_MS);
  if (current) {
    await ctx.db.patch(current._id, {
      state: "active",
      connectorVersion: request.connectorVersion,
      actorUserId: source.principal.userId,
      actorCredentialId: source.principal.credentialId,
      lastSeenAt: receivedAt,
      nextExpectedAt,
      sweepAfter: nextExpectedAt,
      updatedAt: receivedAt,
    });
  } else {
    await ctx.db.insert("workerWatcherStates", {
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      watcherId: request.watcherId,
      state: "active",
      connectorVersion: request.connectorVersion,
      actorUserId: source.principal.userId,
      actorCredentialId: source.principal.credentialId,
      lastSeenAt: receivedAt,
      nextExpectedAt,
      sweepAfter: nextExpectedAt,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    });
  }
  if (incident) {
    await ctx.db.patch(incident._id, {
      state: "resolved",
      observedAt: receivedAt,
      resolvedAt: receivedAt,
    });
  }
  return {
    operation: "diagnostics.heartbeat",
    sourceAccountId: source.account._id,
    watcherId: request.watcherId,
    receivedAt,
    nextExpectedAt,
  };
}

async function resolveOpenIncidentForWatcher(
  ctx: MutationCtx,
  account: Doc<"sourceAccounts">,
  watcherId: string,
  now: number,
): Promise<void> {
  const incident = await openIncidentForSource(ctx, account._id);
  if (!incident) return;
  validateIncident(incident, account, watcherId);
  await ctx.db.patch(incident._id, {
    state: "resolved",
    observedAt: now,
    resolvedAt: now,
  });
}

export async function onSourceEnabledChanged(
  ctx: MutationCtx,
  account: Doc<"sourceAccounts">,
  enabled: boolean,
  now: number,
): Promise<void> {
  validateNow(now);
  const watcher = await watcherForSource(ctx, account._id);
  if (!watcher) return;
  validateWatcher(watcher, account);
  if (!enabled) {
    await resolveOpenIncidentForWatcher(ctx, account, watcher.watcherId, now);
    if (watcher.state === "active") {
      await ctx.db.patch(watcher._id, {
        sweepAfter: undefined,
        updatedAt: now,
      });
    }
  } else if (watcher.state === "active") {
    await resolveOpenIncidentForWatcher(ctx, account, watcher.watcherId, now);
    await ctx.db.patch(watcher._id, { sweepAfter: now, updatedAt: now });
  }
}

export type ResetWatcherArgs = {
  sourceAccountId: Id<"sourceAccounts">;
  requestId: string;
  expectedWatcherId: string | null;
  nextWatcherId: string | null;
};

export type ResetWatcherResult = {
  sourceAccountId: Id<"sourceAccounts">;
  watcherId: string | null;
  reused: boolean;
  changedAt: number;
};

function nullable(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

export async function resetWorkerWatcher(
  ctx: MutationCtx,
  account: Doc<"sourceAccounts">,
  actorUserId: Id<"users">,
  args: ResetWatcherArgs,
  now: number,
): Promise<ResetWatcherResult> {
  validateNow(now);
  const digest = await sha256Utf8(
    `worker-watcher-reset:v1\0${JSON.stringify([
      account.spaceId,
      account._id,
      args.requestId,
      args.expectedWatcherId,
      args.nextWatcherId,
    ])}`,
  );
  const receipts = await ctx.db
    .query("workerWatcherResetReceipts")
    .withIndex("by_sourceAccountId_and_requestId", (q) =>
      q.eq("sourceAccountId", account._id).eq("requestId", args.requestId),
    )
    .take(2);
  if (receipts.length > 1) throw workerProtocolError("scan_conflict");
  const current = await watcherForSource(ctx, account._id);
  if (current) validateWatcher(current, account);
  const currentIncident = await openIncidentForSource(ctx, account._id);
  if (currentIncident) {
    if (!current) throw workerProtocolError("scan_conflict");
    validateIncident(currentIncident, account, current.watcherId);
  }
  const prior = receipts[0];
  if (prior) {
    if (
      prior.spaceId !== account.spaceId ||
      prior.actorUserId !== actorUserId ||
      prior.requestDigest !== digest ||
      prior.expectedWatcherId !== nullable(args.expectedWatcherId) ||
      prior.nextWatcherId !== nullable(args.nextWatcherId)
    ) {
      throw workerProtocolError("request_conflict");
    }
    if ((current?.watcherId ?? null) !== args.nextWatcherId) {
      throw workerProtocolError("request_conflict");
    }
    return {
      sourceAccountId: account._id,
      watcherId: args.nextWatcherId,
      reused: true,
      changedAt: prior.changedAt,
    };
  }
  if ((current?.watcherId ?? null) !== args.expectedWatcherId) {
    throw workerProtocolError("identity_review_required");
  }
  if (current?.watcherId !== args.nextWatcherId) {
    if (current) {
      await resolveOpenIncidentForWatcher(ctx, account, current.watcherId, now);
    }
    if (args.nextWatcherId === null) {
      if (current) await ctx.db.delete(current._id);
    } else if (current) {
      await ctx.db.patch(current._id, {
        watcherId: args.nextWatcherId,
        state: "awaiting_heartbeat",
        connectorVersion: undefined,
        actorUserId: undefined,
        actorCredentialId: undefined,
        lastSeenAt: undefined,
        nextExpectedAt: undefined,
        sweepAfter: undefined,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("workerWatcherStates", {
        spaceId: account.spaceId,
        sourceAccountId: account._id,
        watcherId: args.nextWatcherId,
        state: "awaiting_heartbeat",
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  await ctx.db.insert("workerWatcherResetReceipts", {
    spaceId: account.spaceId,
    sourceAccountId: account._id,
    requestId: args.requestId,
    requestDigest: digest,
    expectedWatcherId: nullable(args.expectedWatcherId),
    nextWatcherId: nullable(args.nextWatcherId),
    actorUserId,
    changedAt: now,
  });
  return {
    sourceAccountId: account._id,
    watcherId: args.nextWatcherId,
    reused: false,
    changedAt: now,
  };
}

export async function sweepMissingWorkerHeartbeats(
  ctx: MutationCtx,
  now: number,
): Promise<{ inspected: number; opened: number; observed: number }> {
  validateNow(now);
  const rows = await ctx.db
    .query("workerWatcherStates")
    .withIndex("by_state_and_sweepAfter", (q) =>
      q.eq("state", "active").gte("sweepAfter", 0).lte("sweepAfter", now),
    )
    .take(WORKER_HEARTBEAT_SWEEP_LIMIT);
  let opened = 0;
  let observed = 0;
  for (const row of rows) {
    const account = await ctx.db.get(row.sourceAccountId);
    if (!account || account.spaceId !== row.spaceId) {
      throw workerProtocolError("scan_conflict");
    }
    validateWatcher(row, account);
    if (!account.enabled) {
      await resolveOpenIncidentForWatcher(ctx, account, row.watcherId, now);
      await ctx.db.patch(row._id, { sweepAfter: undefined, updatedAt: now });
      continue;
    }
    if (row.nextExpectedAt! > now) {
      await ctx.db.patch(row._id, { sweepAfter: row.nextExpectedAt });
      continue;
    }
    const incident = await openIncidentForSource(ctx, account._id);
    if (incident) {
      validateIncident(incident, account, row.watcherId);
      if (incident.openedAt < row.nextExpectedAt!) {
        throw workerProtocolError("scan_conflict");
      }
      await ctx.db.patch(incident._id, { observedAt: now });
      observed += 1;
    } else {
      const prior = await incidentForWatcher(ctx, account._id, row.watcherId);
      if (prior) {
        if (
          prior.spaceId !== account.spaceId ||
          prior.state !== "resolved" ||
          !validEpoch(prior.openedAt) ||
          !validEpoch(prior.observedAt) ||
          !validEpoch(prior.resolvedAt) ||
          prior.observedAt < prior.openedAt ||
          prior.resolvedAt < prior.observedAt
        ) {
          throw workerProtocolError("scan_conflict");
        }
        await ctx.db.patch(prior._id, {
          state: "open",
          openedAt: now,
          observedAt: now,
          resolvedAt: undefined,
        });
      } else {
        await ctx.db.insert("workerOperationalIncidents", {
          spaceId: account.spaceId,
          sourceAccountId: account._id,
          watcherId: row.watcherId,
          kind: "missing_worker",
          state: "open",
          openedAt: now,
          observedAt: now,
        });
      }
      opened += 1;
    }
    await ctx.db.patch(row._id, {
      sweepAfter: nowPlus(now, WORKER_HEARTBEAT_SWEEP_INTERVAL_MS),
      updatedAt: now,
    });
  }
  return { inspected: rows.length, opened, observed };
}
