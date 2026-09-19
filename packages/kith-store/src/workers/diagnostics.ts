import type {
  WorkerDiagnosticsHeartbeatResult,
  WorkerDiagnosticsPassOutcomeResult,
  WorkerDiagnosticsStatusResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import {
  requireSpaceAccess,
  type PrincipalRef,
} from "../identity/authorization.js";

import { newKithId } from "../ids.js";
import { sha256Utf8 } from "../provenance/sql.js";
import { requireWorkerSourceAccount } from "./auth.js";
import { at, exec, row, rows, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";

export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const WORKER_HEARTBEAT_OVERDUE_MS = 180_000;
export const WORKER_HEARTBEAT_MIN_WRITE_MS = 5_000;
/** How many active watchers the daily incident writer inspects per call. */
export const WORKER_MISSING_INCIDENT_SWEEP_LIMIT = 500;

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
  /** ADM-9, migration 029. Null until a pass has reported one. */
  lastPassFinishedAt: Date | null;
  lastPassUnhealthySince: Date | null;
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

/**
 * ADM-10. Whether this heartbeat is the registered watcher under its new id.
 *
 * What the identity check is for. The worker credential is what authorizes a
 * heartbeat at all (`requireWorkerSourceAccount`), so this check is not an
 * authentication control and never was: a holder of the key can already open
 * scans and publish documents. What it protects is the *operational* truth the
 * health screen reads off this row -- that exactly one host is the registered
 * watcher for a source account, so a host that goes silent shows up as missing
 * instead of being masked by a second host's pings. Two hosts on one credential
 * and a stale process left running are the same failure seen twice, and the
 * refusal is what makes either of them visible rather than a race to write
 * last.
 *
 * That is preserved here. A heartbeat presenting neither the registered id nor
 * the id it was registered under is still refused, and re-registration stays an
 * owner action (`resetWorkerWatcher`). What is allowed is exactly one thing: a
 * watcher that presents, as `legacyWatcherId`, the id the row already holds may
 * carry that row to its ADM-10 id. It is the same installation saying the same
 * thing in the new spelling, and a *live* watcher can do it without a gap --
 * gating it on the row being overdue would mean every upgraded worker went
 * missing for the overdue window and opened an incident for it.
 *
 * The trade, stated plainly: a second host on the same credential that reads
 * the registered id from `diagnostics.status` can present it here and take the
 * row over, where before ADM-10 it was refused. It gains the heartbeat row and
 * nothing else, it must already hold a key that can write documents into the
 * space, and the host it displaced is refused from its next ping onward and
 * says so. Set against a derivation that killed the heartbeat on every parser
 * upgrade, that is the better failure.
 */
function adoptsLegacyWatcherId(
  current: Watcher,
  request: Extract<WorkerRequest, { operation: "diagnostics.heartbeat" }>,
): boolean {
  return (
    request.legacyWatcherId !== undefined &&
    current.watcherId === request.legacyWatcherId
  );
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
    if (
      current.watcherId !== request.watcherId &&
      !adoptsLegacyWatcherId(current, request)
    )
      workerProtocolError("identity_review_required");
  }
  const incident = await openIncident(ctx, source.account.id, true);
  // The incident belongs to the *registered* watcher, which on an ADM-10
  // adoption is still the legacy id. It is resolved below in this same
  // transaction, so it is never left pointing at an id no row carries.
  if (incident)
    validateIncident(incident, source, current?.watcherId ?? request.watcherId);
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
    // An adoption is a write even inside the damping window: skipping it here
    // would answer the ping and leave the row on the legacy id, so the next
    // ping outside the window would have to adopt all over again.
    current.watcherId === request.watcherId &&
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
      `UPDATE kith.worker_watcher_states SET state = 'active', watcher_id = $7,
      connector_version = $1,
      actor_user_id = $2, actor_credential_id = $3, last_seen_at = $4, next_expected_at = $5,
      sweep_after = $5, updated_at = $4 WHERE id = $6`,
      [
        request.connectorVersion,
        source.principal.userId,
        source.principal.credentialId,
        at(receivedAt),
        at(nextExpectedAt),
        current.id,
        request.watcherId,
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

/**
 * ADM-9. How the last pass ended, on the watcher row.
 *
 * The gap this closes: PR #313's two circuit breakers end a pass `incomplete`
 * and write nothing -- no scan, so no processing assessment -- and the health
 * screen reads only the heartbeat and the latest assessment. A watcher
 * refusing every pass therefore kept heartbeating and read as healthy. This is
 * the one write that reaches the server on a pass that opened nothing.
 *
 * Authorized exactly as every other operation in this directory is:
 * `requireWorkerSourceAccount` (auth.ts) reloads the credential, requires
 * `ingest` on the space, requires this credential's grant for *this* source
 * account, requires the request's `spaceId` to be the account's, and requires
 * the `fs` connector. Then the only row this can reach is the watcher row of
 * that authorized account (`watcherForSource` selects by
 * `source_account_id`, `validateWatcher` re-checks the row's own `space_id`
 * and `source_account_id`), so a credential for another account or another
 * space can write nothing here. It is a mutation, so it takes the same
 * per-credential-per-source rate limit every other mutation does.
 *
 * `watcherId` is required and must match, for the same reason
 * `recordWorkerHeartbeat` requires it: a second host on the same account is an
 * identity question, not a race to write last.
 *
 * No watcher row means no heartbeat has ever registered a host, and this
 * operation does not create one -- a pass outcome is a fact about a registered
 * watcher, and inventing the registration from it would make the heartbeat's
 * own identity check meaningless. The watcher treats the refusal as "not
 * reported this pass"; the next pass, after a heartbeat, records it.
 */
export async function recordWorkerPassOutcome(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "diagnostics.passOutcome" }>,
): Promise<WorkerDiagnosticsPassOutcomeResult> {
  validateNow(ctx.now);
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const current = await watcherForSource(ctx, source.account.id, true);
  if (!current) workerProtocolError("not_found");
  validateWatcher(current, source);
  if (current.watcherId !== request.watcherId)
    workerProtocolError("identity_review_required");
  // `finishedAt` is the watcher host's clock, and the gate below refuses
  // anything not newer than what is stored. Together those would let one
  // forward clock jump on the host park the row at a future instant that no
  // later pass can beat: the pill and the age would freeze permanently, which
  // is the opposite of what this operation is for. So the host's clock is only
  // ever believed up to the server's own.
  const finishedAt = Math.min(request.finishedAt, ctx.now);
  // A report that is not newer than the one already stored changes nothing.
  // Retries and out-of-order arrivals are ordinary here -- the send is
  // best-effort and never retried in order -- and without this an at-least-once
  // delivery of one pass would restart the run below at its own timestamp.
  const stored = current.lastPassFinishedAt;
  if (stored instanceof Date && finishedAt <= stored.getTime()) {
    return {
      operation: "diagnostics.passOutcome",
      sourceAccountId: source.account.id,
      watcherId: current.watcherId,
      finishedAt: stored.getTime(),
      unhealthySince: current.lastPassUnhealthySince?.getTime() ?? null,
    };
  }
  // When the current run of non-`complete` outcomes began: carried forward
  // while they keep arriving, and dropped the moment a pass completes.
  const unhealthySince =
    request.state === "complete"
      ? null
      : Math.min(
          current.lastPassUnhealthySince?.getTime() ?? finishedAt,
          finishedAt,
        );
  await exec(
    ctx,
    `UPDATE kith.worker_watcher_states
        SET last_pass_state = $1, last_pass_code = $2, last_pass_scanned = $3,
            last_pass_published = $4, last_pass_finished_at = $5,
            last_pass_unhealthy_since = $6, updated_at = $7
      WHERE id = $8`,
    [
      request.state,
      request.code ?? null,
      request.scanned,
      request.published,
      at(finishedAt),
      unhealthySince === null ? null : at(unhealthySince),
      at(ctx.now),
      current.id,
    ],
  );
  return {
    operation: "diagnostics.passOutcome",
    sourceAccountId: source.account.id,
    watcherId: current.watcherId,
    finishedAt,
    unhealthySince,
  };
}

// ---------------------------------------------------------------------------
// P2-39j: missing-worker detection, ported as section 2.6 adopts it -- "a
// read-time predicate over `worker_watcher_states.lastHeartbeatAt`, computed
// when the UI or `brain doctor` asks" -- plus one daily durable incident
// record, rather than `models/diagnostics/private.ts` `sweepMissingWorkers`'
// per-minute `sweepMissingWorkerHeartbeats`. That function inspected active
// watchers on a `sweepAfter` schedule and opened or re-observed an incident on
// every pass it found one overdue; it is not ported here, because the plan
// retires the per-minute cadence itself, not just its implementation. What
// carries over from it: an incident is `missing_worker`, keyed by
// `(sourceAccountId, watcherId)`, and a heartbeat resolves the open one
// (`recordWorkerHeartbeat` above already does that half).
// ---------------------------------------------------------------------------

/**
 * Whether an active watcher counts as overdue as of `now`. The boundary is
 * inclusive of `nextExpectedAt` itself, matching `getWorkerDiagnosticsStatus`
 * above (`now < nextExpectedAt ? "current" : "overdue"`): a watcher becomes
 * overdue the instant its expected-by time passes, not one tick later.
 */
export function isWatcherOverdue(nextExpectedAt: number, now: number): boolean {
  return now >= nextExpectedAt;
}

export type WatcherStaleness =
  | "not_configured"
  | "awaiting_heartbeat"
  | "current"
  | "overdue";

/**
 * The read-time predicate itself, over one watcher row (or its absence). This
 * is what a status route or `brain doctor` calls instead of trusting a
 * per-minute sweep to have run: a host that is down still reports itself
 * stale, because nothing here depends on the sweep having executed.
 */
export function watcherStaleness(
  watcher: Pick<Watcher, "state" | "nextExpectedAt"> | undefined,
  now: number,
): WatcherStaleness {
  if (!watcher) return "not_configured";
  if (watcher.state === "awaiting_heartbeat") return "awaiting_heartbeat";
  if (!watcher.nextExpectedAt) return "awaiting_heartbeat";
  return isWatcherOverdue(watcher.nextExpectedAt.getTime(), now)
    ? "overdue"
    : "current";
}

function dayKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export type MissingWorkerIncidentSweepResult = {
  inspected: number;
  recorded: number;
};

/**
 * The daily durable incident writer: `models/diagnostics/private.ts`
 * `sweepMissingWorkers`'s replacement, run once a day rather than once a
 * minute (section 2.6, and `docs/worker-service.md`'s cloud-cron section for
 * where it actually runs from). For every `active` watcher whose
 * `nextExpectedAt` is at or past `ctx.now`, writes one `missing_worker`
 * incident row -- unless one was already opened for that watcher today
 * (UTC), in which case the watcher is inspected and skipped: "at most one
 * durable incident row per watcher per day".
 *
 * A heartbeat still resolves the open incident immediately
 * (`recordWorkerHeartbeat`), so this writer's job is narrower than the
 * per-minute sweep's was: recording that a watcher was missing today, for
 * alerting, not maintaining an always-current open/resolved state machine.
 */
export async function recordMissingWorkerIncidents(
  ctx: WorkerCtx,
  options: { limit?: number } = {},
): Promise<MissingWorkerIncidentSweepResult> {
  validateNow(ctx.now);
  const limit = options.limit ?? WORKER_MISSING_INCIDENT_SWEEP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    workerProtocolError("invalid_request");
  }
  const overdue = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_watcher_states
       WHERE state = 'active' AND next_expected_at <= $1
       ORDER BY next_expected_at, id
       LIMIT $2`,
    [at(ctx.now), limit],
  );
  const todayStart = at(Date.parse(`${dayKeyUtc(ctx.now)}T00:00:00.000Z`));
  let recorded = 0;
  for (const raw of overdue) {
    const watcher = camel(raw) as Watcher;
    // `worker_operational_incidents_open_idx` allows at most one `open`
    // incident per source account, the same invariant `openIncident` (above)
    // already assumes. A source that is already tracked as missing -- from
    // today or an earlier day the watcher never recovered from -- is touched
    // rather than duplicated: `observed_at` moves forward so an alert reading
    // it knows the condition was still true as of this run.
    const open = await row<{ id: string }>(
      ctx,
      `SELECT id FROM kith.worker_operational_incidents
         WHERE source_account_id = $1 AND state = 'open' LIMIT 1`,
      [watcher.sourceAccountId],
    );
    if (open) {
      await exec(
        ctx,
        "UPDATE kith.worker_operational_incidents SET observed_at = $1 WHERE id = $2",
        [at(ctx.now), open.id],
      );
      continue;
    }
    // No incident is open. If one for this watcher was already opened (and,
    // presumably, resolved by a heartbeat) earlier today, this run does not
    // reopen it: "at most one durable incident row per watcher per day"
    // counts the row this loop would otherwise insert, not a bumped
    // `observed_at` on one that already exists.
    const openedToday = await row<{ id: string }>(
      ctx,
      `SELECT id FROM kith.worker_operational_incidents
         WHERE source_account_id = $1 AND watcher_id = $2 AND kind = 'missing_worker'
           AND opened_at >= $3
         LIMIT 1`,
      [watcher.sourceAccountId, watcher.watcherId, todayStart],
    );
    if (openedToday) continue;
    await exec(
      ctx,
      `INSERT INTO kith.worker_operational_incidents
         (id, space_id, created_at, source_account_id, watcher_id, kind, state,
          opened_at, observed_at)
         VALUES ($1, $2, transaction_timestamp(), $3, $4, 'missing_worker', 'open', $5, $5)`,
      [newKithId(), watcher.spaceId, watcher.sourceAccountId, watcher.watcherId, at(ctx.now)],
    );
    recorded += 1;
  }
  return { inspected: overdue.length, recorded };
}

export type SourceEnabledChangeAccount = {
  readonly id: string;
  readonly spaceId: string;
  /** The account's `enabled` value *before* the caller's change. */
  readonly enabled: boolean;
};

/**
 * `models/diagnostics/model.ts` `onSourceEnabledChanged`.
 *
 * The `sourceAccounts.update` mutation's second side effect (alongside
 * `advanceSourceAssessmentEpoch`, ported beside its caller in
 * `../sources/model.ts`) whenever a caller actually changes `enabled`. Both
 * run in that caller's own transaction, before `kith.source_accounts` itself
 * is patched -- so `account.enabled` here is still the *old* value, which is
 * what `validateWatcher` needs: its `sweepAfter` invariant differs by whether
 * the account is currently enabled, not by what it is about to become.
 *
 * No `ctx.scheduler.runAfter` call exists in the Convex original to port to a
 * `kith.deferred_work` row: every effect here is a synchronous patch to
 * `kith.worker_watcher_states` or `kith.worker_operational_incidents` in the
 * caller's transaction, exactly as Convex's `ctx.db.patch` was.
 *
 * Disabling clears `sweepAfter` (an inactive source is not staleness-swept)
 * and resolves any open `missing_worker` incident for the watcher -- a source
 * nobody is scanning cannot be reported missing. Re-enabling an already
 * `active` watcher does the same incident resolution and restarts the
 * staleness clock from `ctx.now`, the same heartbeat-shaped restart Convex
 * gave it. An `awaiting_heartbeat` watcher, or no watcher row at all, is left
 * untouched either way: there is nothing stale to resolve yet.
 */
export async function onSourceEnabledChanged(
  ctx: WorkerCtx,
  account: SourceEnabledChangeAccount,
  enabled: boolean,
): Promise<void> {
  validateNow(ctx.now);
  const watcher = await watcherForSource(ctx, account.id, true);
  if (!watcher) return;
  const source = {
    spaceId: account.spaceId,
    account: { id: account.id, enabled: account.enabled },
  };
  validateWatcher(watcher, source);
  if (!enabled) {
    await resolveOpenIncidentForWatcher(ctx, account, watcher.watcherId);
    if (watcher.state === "active") {
      await exec(
        ctx,
        "UPDATE kith.worker_watcher_states SET sweep_after = NULL, updated_at = $1 WHERE id = $2",
        [at(ctx.now), watcher.id],
      );
    }
  } else if (watcher.state === "active") {
    await resolveOpenIncidentForWatcher(ctx, account, watcher.watcherId);
    await exec(
      ctx,
      "UPDATE kith.worker_watcher_states SET sweep_after = $1, updated_at = $1 WHERE id = $2",
      [at(ctx.now), watcher.id],
    );
  }
}

/** `resolveOpenIncidentForWatcher` in `models/diagnostics/model.ts`. */
async function resolveOpenIncidentForWatcher(
  ctx: WorkerCtx,
  account: { id: string; spaceId: string },
  watcherId: string,
): Promise<void> {
  const incident = await openIncident(ctx, account.id, true);
  if (!incident) return;
  validateIncident(
    incident,
    { spaceId: account.spaceId, account: { id: account.id } },
    watcherId,
  );
  await exec(
    ctx,
    "UPDATE kith.worker_operational_incidents SET state = 'resolved', observed_at = $1, resolved_at = $1 WHERE id = $2",
    [at(ctx.now), incident.id],
  );
}

export type ResetWatcherArgs = {
  requestId: string;
  expectedWatcherId: string | null;
  nextWatcherId: string | null;
};

export type ResetWatcherResult = {
  sourceAccountId: string;
  watcherId: string | null;
  reused: boolean;
  changedAt: number;
};

/**
 * `models/diagnostics/model.ts` `resetWorkerWatcher`. Ported without its web
 * caller (`models/diagnostics/public.ts` `resetWatcher`, an owner-only
 * mutation that resolves `sourceAccountId` through `requireSourceAccountAccess`
 * and `requireSpaceAccess` before calling this): that authorization belongs to
 * the route that exposes this to the owner, which is `apps/web` and out of
 * this package's scope. `account` here is the caller's already-authorized
 * source account, matching the Convex function's own signature.
 */
export async function resetWorkerWatcher(
  ctx: WorkerCtx,
  account: { id: string; spaceId: string; enabled: boolean },
  actorUserId: string,
  args: ResetWatcherArgs,
): Promise<ResetWatcherResult> {
  validateNow(ctx.now);
  const digest = await sha256Utf8(
    `worker-watcher-reset:v1\0${JSON.stringify([
      account.spaceId,
      account.id,
      args.requestId,
      args.expectedWatcherId,
      args.nextWatcherId,
    ])}`,
  );
  const receipts = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_watcher_reset_receipts
       WHERE source_account_id = $1 AND request_id = $2 LIMIT 2`,
    [account.id, args.requestId],
  );
  if (receipts.length > 1) workerProtocolError("scan_conflict");
  const current = await watcherForSource(ctx, account.id, true);
  if (current) {
    validateWatcher(current, {
      spaceId: account.spaceId,
      account: { id: account.id, enabled: account.enabled },
    });
  }
  const currentIncident = await openIncident(ctx, account.id, true);
  if (currentIncident) {
    if (!current) workerProtocolError("scan_conflict");
    validateIncident(
      currentIncident,
      { spaceId: account.spaceId, account: { id: account.id } },
      current.watcherId,
    );
  }
  const prior = receipts[0] ? camel(receipts[0]) : undefined;
  if (prior) {
    const priorRow = prior as {
      spaceId: string;
      actorUserId: string;
      requestDigest: string;
      expectedWatcherId: string | null;
      nextWatcherId: string | null;
      changedAt: Date;
    };
    if (
      priorRow.spaceId !== account.spaceId ||
      priorRow.actorUserId !== actorUserId ||
      priorRow.requestDigest !== digest ||
      priorRow.expectedWatcherId !== args.expectedWatcherId ||
      priorRow.nextWatcherId !== args.nextWatcherId
    ) {
      workerProtocolError("request_conflict");
    }
    if ((current?.watcherId ?? null) !== args.nextWatcherId) {
      workerProtocolError("request_conflict");
    }
    return {
      sourceAccountId: account.id,
      watcherId: args.nextWatcherId,
      reused: true,
      changedAt: priorRow.changedAt.getTime(),
    };
  }
  if ((current?.watcherId ?? null) !== args.expectedWatcherId) {
    workerProtocolError("identity_review_required");
  }
  if (current?.watcherId !== args.nextWatcherId) {
    if (current && currentIncident) {
      await exec(
        ctx,
        "UPDATE kith.worker_operational_incidents SET state = 'resolved', observed_at = $1, resolved_at = $1 WHERE id = $2",
        [at(ctx.now), currentIncident.id],
      );
    }
    if (args.nextWatcherId === null) {
      if (current) {
        await exec(ctx, "DELETE FROM kith.worker_watcher_states WHERE id = $1", [
          current.id,
        ]);
      }
    } else if (current) {
      await exec(
        ctx,
        `UPDATE kith.worker_watcher_states SET watcher_id = $1, state = 'awaiting_heartbeat',
          connector_version = NULL, actor_user_id = NULL, actor_credential_id = NULL,
          last_seen_at = NULL, next_expected_at = NULL, sweep_after = NULL,
          created_at_field = $2, updated_at = $2 WHERE id = $3`,
        [args.nextWatcherId, at(ctx.now), current.id],
      );
    } else {
      await exec(
        ctx,
        `INSERT INTO kith.worker_watcher_states
          (id, space_id, created_at, source_account_id, watcher_id, state, created_at_field, updated_at)
          VALUES ($1, $2, transaction_timestamp(), $3, $4, 'awaiting_heartbeat', $5, $5)`,
        [newKithId(), account.spaceId, account.id, args.nextWatcherId, at(ctx.now)],
      );
    }
  }
  await exec(
    ctx,
    `INSERT INTO kith.worker_watcher_reset_receipts
       (id, space_id, created_at, source_account_id, request_id, request_digest,
        expected_watcher_id, next_watcher_id, actor_user_id, changed_at)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7, $8, $9)`,
    [
      newKithId(),
      account.spaceId,
      account.id,
      args.requestId,
      digest,
      args.expectedWatcherId,
      args.nextWatcherId,
      actorUserId,
      at(ctx.now),
    ],
  );
  return {
    sourceAccountId: account.id,
    watcherId: args.nextWatcherId,
    reused: false,
    changedAt: ctx.now,
  };
}

export type ReregisterWatcherResult = {
  sourceAccountId: string;
  /** The id that was cleared, or null when nothing was registered. */
  clearedWatcherId: string | null;
  changedAt: number;
};

/**
 * ADM-10. The owner's re-registration: clear the binding so the next heartbeat
 * claims it.
 *
 * This is the supported way out of `identity_review_required`, and it is the
 * only one. Section "Worker heartbeat diagnostics" of the worker protocol plan
 * settles who may do it: "A worker cannot approve an ambiguous identity mapping
 * itself", and "Only a current-session owner operation may replace or clear the
 * binding". A worker-credential subcommand that re-registered its own host --
 * even gated on the registered watcher being overdue -- is exactly the
 * self-approval that sentence forbids, so there is no `reregister-watcher` CLI
 * on the worker and this is the whole surface. It costs nothing to do without
 * one: the owner is already on the health screen looking at the pill that told
 * him, and the watcher recovers on its next ping, within thirty seconds.
 *
 * `nextWatcherId: null` rather than a replacement id, because the server cannot
 * derive the worker's id and must not be told one over this route: the
 * heartbeat is the only thing that knows it, and `recordWorkerHeartbeat`'s
 * first-heartbeat path claims an unbound source. So the window this opens is
 * one heartbeat interval wide and closes on the first ping that arrives -- and
 * the first ping to arrive is the host that is up.
 *
 * Authorization, in order: the account is loaded by id and its *own* space is
 * what `requireSpaceAccess` is asked about, so no space id crosses the wire;
 * `write` is required before the role is looked at, so a reader is refused by
 * the same path an outsider is; and then the membership must be `owner`, which
 * denies an editor. Every refusal is the same `Source account not found` the
 * rest of this surface gives, so a caller cannot map another space's accounts
 * by reading the denial.
 */
export async function reregisterWorkerWatcher(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  args: { sourceAccountId: string; requestId: string },
): Promise<ReregisterWatcherResult> {
  validateNow(ctx.now);
  const account = await row<{
    id: string;
    space_id: string;
    enabled: boolean | null;
  }>(ctx, "SELECT id, space_id, enabled FROM kith.source_accounts WHERE id = $1", [
    args.sourceAccountId,
  ]);
  if (!account) throw new Error("Source account not found");
  let membership;
  try {
    membership = await requireSpaceAccess(
      ctx,
      principal,
      account.space_id,
      "write",
    );
  } catch {
    throw new Error("Source account not found");
  }
  if (membership.role !== "owner") throw new Error("Source account not found");

  // `resetWorkerWatcher` is a compare-and-set, and the id to compare against
  // is whatever is registered right now. A retry of the same request would
  // therefore compute a *different* expectation -- the row this call already
  // deleted -- and be answered `request_conflict` by its own receipt. So a
  // replay reuses the expectation the receipt recorded, which is what makes a
  // lost response safe to retry instead of merely safe to repeat.
  const prior = await row<{ expected_watcher_id: string | null }>(
    ctx,
    `SELECT expected_watcher_id FROM kith.worker_watcher_reset_receipts
       WHERE source_account_id = $1 AND request_id = $2 LIMIT 1`,
    [args.sourceAccountId, args.requestId],
  );
  const current = await watcherForSource(ctx, account.id, true);
  const expectedWatcherId = prior
    ? prior.expected_watcher_id
    : (current?.watcherId ?? null);
  const reset = await resetWorkerWatcher(
    ctx,
    {
      id: account.id,
      spaceId: account.space_id,
      enabled: account.enabled === true,
    },
    membership.userId,
    {
      requestId: args.requestId,
      expectedWatcherId,
      nextWatcherId: null,
    },
  );
  return {
    sourceAccountId: account.id,
    clearedWatcherId: expectedWatcherId,
    changedAt: reset.changedAt,
  };
}
