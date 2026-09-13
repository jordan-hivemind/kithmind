import type {
  WorkerDiagnosticsHeartbeatResult,
  WorkerDiagnosticsStatusResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import { newKithId } from "../ids.js";
import { requireWorkerSourceAccount } from "./auth.js";
import { at, exec, row, rows, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";

export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const WORKER_HEARTBEAT_OVERDUE_MS = 180_000;
export const WORKER_HEARTBEAT_MIN_WRITE_MS = 5_000;

type Watcher = {
  id: string;
  spaceId: string;
  sourceAccountId: string;
  watcherId: string;
  state: "awaiting_heartbeat" | "active";
  connectorVersion: string | null;
  actorUserId: string | null;
  actorCredentialId: string | null;
  lastSeenAt: Date | null;
  nextExpectedAt: Date | null;
  sweepAfter: Date | null;
  createdAtField: Date;
  updatedAt: Date;
};

type Incident = {
  id: string;
  spaceId: string;
  sourceAccountId: string;
  watcherId: string;
  kind: string;
  state: string;
  openedAt: Date;
  observedAt: Date;
  resolvedAt: Date | null;
};

function camel(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

function validEpoch(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
  );
}

function validateNow(now: number): void {
  if (!validEpoch(now)) workerProtocolError("invalid_request");
}

function nextExpected(lastSeenAt: number): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER - 1,
    lastSeenAt + WORKER_HEARTBEAT_OVERDUE_MS,
  );
}

async function watcherForSource(
  ctx: WorkerCtx,
  sourceAccountId: string,
  lock = false,
): Promise<Watcher | undefined> {
  const found = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_watcher_states WHERE source_account_id = $1
      ORDER BY created_at, id LIMIT 2${lock ? " FOR UPDATE" : ""}`,
    [sourceAccountId],
  );
  if (found.length > 1) workerProtocolError("scan_conflict");
  return found[0] ? (camel(found[0]) as Watcher) : undefined;
}

async function openIncident(
  ctx: WorkerCtx,
  sourceAccountId: string,
  lock = false,
): Promise<Incident | undefined> {
  const found = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_operational_incidents WHERE source_account_id = $1 AND state = 'open'
      ORDER BY created_at, id LIMIT 2${lock ? " FOR UPDATE" : ""}`,
    [sourceAccountId],
  );
  if (found.length > 1) workerProtocolError("scan_conflict");
  return found[0] ? (camel(found[0]) as Incident) : undefined;
}

function validateWatcher(
  watcher: Watcher,
  source: { spaceId: string; account: { id: string; enabled: boolean | null } },
): void {
  const activeDates =
    watcher.lastSeenAt instanceof Date &&
    watcher.nextExpectedAt instanceof Date;
  if (
    watcher.spaceId !== source.spaceId ||
    watcher.sourceAccountId !== source.account.id ||
    !watcher.watcherId ||
    !(watcher.createdAtField instanceof Date) ||
    !(watcher.updatedAt instanceof Date) ||
    (watcher.state === "awaiting_heartbeat" &&
      (watcher.connectorVersion !== null ||
        watcher.actorUserId !== null ||
        watcher.actorCredentialId !== null ||
        watcher.lastSeenAt !== null ||
        watcher.nextExpectedAt !== null ||
        watcher.sweepAfter !== null)) ||
    (watcher.state === "active" &&
      (!watcher.connectorVersion ||
        !watcher.actorUserId ||
        !watcher.actorCredentialId ||
        !activeDates ||
        watcher.nextExpectedAt!.getTime() !==
          nextExpected(watcher.lastSeenAt!.getTime()) ||
        watcher.nextExpectedAt!.getTime() < watcher.lastSeenAt!.getTime() ||
        (source.account.enabled
          ? !(watcher.sweepAfter instanceof Date)
          : watcher.sweepAfter !== null)))
  )
    workerProtocolError("scan_conflict");
}

function validateIncident(
  incident: Incident,
  source: { spaceId: string; account: { id: string } },
  watcherId: string,
): void {
  if (
    incident.spaceId !== source.spaceId ||
    incident.sourceAccountId !== source.account.id ||
    incident.watcherId !== watcherId ||
    incident.kind !== "missing_worker" ||
    incident.state !== "open" ||
    !(incident.openedAt instanceof Date) ||
    !(incident.observedAt instanceof Date) ||
    incident.observedAt.getTime() < incident.openedAt.getTime() ||
    incident.resolvedAt !== null
  )
    workerProtocolError("scan_conflict");
}

export async function getWorkerDiagnosticsStatus(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "diagnostics.status" }>,
): Promise<WorkerDiagnosticsStatusResult> {
  validateNow(ctx.now);
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const watcher = await watcherForSource(ctx, source.account.id);
  const incident = await openIncident(ctx, source.account.id);
  if (!watcher) {
    if (incident) workerProtocolError("scan_conflict");
    return {
      operation: "diagnostics.status",
      diagnosticsVersion: 1,
      sourceAccountId: source.account.id,
      source: "enabled",
      watcher: { state: "not_configured" },
      incident: { state: "none" },
    };
  }
  validateWatcher(watcher, source);
  if (incident) validateIncident(incident, source, watcher.watcherId);
  if (watcher.state === "awaiting_heartbeat") {
    if (incident) workerProtocolError("scan_conflict");
    return {
      operation: "diagnostics.status",
      diagnosticsVersion: 1,
      sourceAccountId: source.account.id,
      source: "enabled",
      watcher: { state: "awaiting_heartbeat", watcherId: watcher.watcherId },
      incident: { state: "none" },
    };
  }
  const state =
    ctx.now < watcher.nextExpectedAt!.getTime() ? "current" : "overdue";
  if (
    incident &&
    incident.openedAt.getTime() < watcher.nextExpectedAt!.getTime()
  )
    workerProtocolError("scan_conflict");
  if (state === "current" && incident) workerProtocolError("scan_conflict");
  return {
    operation: "diagnostics.status",
    diagnosticsVersion: 1,
    sourceAccountId: source.account.id,
    source: "enabled",
    watcher: {
      state,
      watcherId: watcher.watcherId,
      lastSeenAt: watcher.lastSeenAt!.getTime(),
      nextExpectedAt: watcher.nextExpectedAt!.getTime(),
    },
    incident: incident
      ? {
          state: "open",
          kind: "missing_worker",
          openedAt: incident.openedAt.getTime(),
        }
      : { state: "none" },
  };
}

export async function recordWorkerHeartbeat(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "diagnostics.heartbeat" }>,
): Promise<WorkerDiagnosticsHeartbeatResult> {
  validateNow(ctx.now);
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  // Serialize the absent-row case as well as updates. Migration 010 adds the
  // unique source watcher constraint; this source lock keeps replay safe now.
  await row(
    ctx,
    "SELECT id FROM kith.source_accounts WHERE id = $1 FOR UPDATE",
    [source.account.id],
  );
  const current = await watcherForSource(ctx, source.account.id, true);
  if (current) {
    validateWatcher(current, source);
    if (current.watcherId !== request.watcherId)
      workerProtocolError("identity_review_required");
  }
  const incident = await openIncident(ctx, source.account.id, true);
  if (incident) validateIncident(incident, source, request.watcherId);
  if (
    incident &&
    current?.state === "active" &&
    incident.openedAt.getTime() < current.nextExpectedAt!.getTime()
  ) {
    workerProtocolError("scan_conflict");
  }
  if (
    current?.state === "active" &&
    !incident &&
    ctx.now >= current.lastSeenAt!.getTime() &&
    ctx.now - current.lastSeenAt!.getTime() < WORKER_HEARTBEAT_MIN_WRITE_MS
  ) {
    return {
      operation: "diagnostics.heartbeat",
      sourceAccountId: source.account.id,
      watcherId: request.watcherId,
      receivedAt: current.lastSeenAt!.getTime(),
      nextExpectedAt: current.nextExpectedAt!.getTime(),
    };
  }
  const receivedAt = Math.max(ctx.now, current?.lastSeenAt?.getTime() ?? 0);
  const nextExpectedAt = nextExpected(receivedAt);
  if (current) {
    await exec(
      ctx,
      `UPDATE kith.worker_watcher_states SET state = 'active', connector_version = $1,
      actor_user_id = $2, actor_credential_id = $3, last_seen_at = $4, next_expected_at = $5,
      sweep_after = $5, updated_at = $4 WHERE id = $6`,
      [
        request.connectorVersion,
        source.principal.userId,
        source.principal.credentialId,
        at(receivedAt),
        at(nextExpectedAt),
        current.id,
      ],
    );
  } else {
    await exec(
      ctx,
      `INSERT INTO kith.worker_watcher_states
      (id, space_id, created_at, source_account_id, watcher_id, state, connector_version,
       actor_user_id, actor_credential_id, last_seen_at, next_expected_at, sweep_after, created_at_field, updated_at)
      VALUES ($1,$2,transaction_timestamp(),$3,$4,'active',$5,$6,$7,$8,$9,$9,$8,$8)`,
      [
        newKithId(),
        source.spaceId,
        source.account.id,
        request.watcherId,
        request.connectorVersion,
        source.principal.userId,
        source.principal.credentialId,
        at(receivedAt),
        at(nextExpectedAt),
      ],
    );
  }
  if (incident) {
    await exec(
      ctx,
      "UPDATE kith.worker_operational_incidents SET state = 'resolved', observed_at = $1, resolved_at = $1 WHERE id = $2",
      [at(receivedAt), incident.id],
    );
  }
  return {
    operation: "diagnostics.heartbeat",
    sourceAccountId: source.account.id,
    watcherId: request.watcherId,
    receivedAt,
    nextExpectedAt,
  };
}
