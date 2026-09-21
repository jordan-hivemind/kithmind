import { randomBytes } from "node:crypto";

import type {
  PipelineConfig,
  WorkerErrorCode,
  WorkerResponse,
  WorkerTransport,
} from "./types.js";

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_DEADLINE_MS = 180_000;
const HEARTBEAT_REQUEST_TIMEOUT_MS = 15_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,256}$/;

export type DiagnosticsWatcher =
  | { state: "not_configured" }
  | { state: "awaiting_heartbeat"; watcherId: string }
  | {
      state: "current" | "overdue";
      watcherId: string;
      lastSeenAt: number;
      nextExpectedAt: number;
    };
export type DiagnosticsIncident =
  | { state: "none" }
  | { state: "open"; kind: "missing_worker"; openedAt: number };
export type DiagnosticsStatus = {
  operation: "diagnostics.status";
  diagnosticsVersion: 1;
  sourceAccountId: string;
  source: "enabled";
  watcher: DiagnosticsWatcher;
  incident: DiagnosticsIncident;
};

function fail(): never {
  throw new Error("Worker diagnostics response is invalid");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  if (
    fields.some((field) => !(field in value)) ||
    Object.keys(value).some((field) => !fields.includes(field))
  )
    fail();
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail();
  return value;
}
function time(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
  return value as number;
}
function errorCode(value: WorkerResponse): WorkerErrorCode | undefined {
  if (
    !("error" in value) ||
    !value.error ||
    typeof value.error !== "object" ||
    Object.keys(value).length !== 1 ||
    Object.keys(value.error).length !== 1 ||
    typeof (value.error as { code?: unknown }).code !== "string"
  )
    return undefined;
  return (value.error as { code: WorkerErrorCode }).code;
}

function response(
  value: WorkerResponse,
  operation: string,
): Record<string, unknown> {
  if (errorCode(value) !== undefined) fail();
  const result = record(value);
  if (result.operation !== operation) fail();
  return result;
}

export function parseDiagnosticsStatus(
  value: WorkerResponse,
): DiagnosticsStatus {
  const result = response(value, "diagnostics.status");
  exact(result, [
    "operation",
    "diagnosticsVersion",
    "sourceAccountId",
    "source",
    "watcher",
    "incident",
  ]);
  if (result.diagnosticsVersion !== 1 || result.source !== "enabled") fail();
  if (
    typeof result.sourceAccountId !== "string" ||
    !ID.test(result.sourceAccountId)
  )
    fail();

  const watcher = record(result.watcher);
  let parsedWatcher: DiagnosticsWatcher;
  if (watcher.state === "not_configured") {
    exact(watcher, ["state"]);
    parsedWatcher = { state: "not_configured" };
  } else if (watcher.state === "awaiting_heartbeat") {
    exact(watcher, ["state", "watcherId"]);
    parsedWatcher = {
      state: "awaiting_heartbeat",
      watcherId: id(watcher.watcherId),
    };
  } else if (watcher.state === "current" || watcher.state === "overdue") {
    exact(watcher, ["state", "watcherId", "lastSeenAt", "nextExpectedAt"]);
    const lastSeenAt = time(watcher.lastSeenAt);
    const nextExpectedAt = time(watcher.nextExpectedAt);
    if (nextExpectedAt !== lastSeenAt + HEARTBEAT_DEADLINE_MS) fail();
    parsedWatcher = {
      state: watcher.state,
      watcherId: id(watcher.watcherId),
      lastSeenAt,
      nextExpectedAt,
    };
  } else fail();

  const incident = record(result.incident);
  let parsedIncident: DiagnosticsIncident;
  if (incident.state === "none") {
    exact(incident, ["state"]);
    parsedIncident = { state: "none" };
  } else if (incident.state === "open") {
    exact(incident, ["state", "kind", "openedAt"]);
    if (incident.kind !== "missing_worker") fail();
    parsedIncident = {
      state: "open",
      kind: "missing_worker",
      openedAt: time(incident.openedAt),
    };
  } else fail();
  if (
    (parsedWatcher.state === "not_configured" ||
      parsedWatcher.state === "awaiting_heartbeat") &&
    parsedIncident.state !== "none"
  )
    fail();
  if (parsedWatcher.state === "current" && parsedIncident.state !== "none")
    fail();
  return {
    operation: "diagnostics.status",
    diagnosticsVersion: 1,
    sourceAccountId: result.sourceAccountId,
    source: "enabled",
    watcher: parsedWatcher,
    incident: parsedIncident,
  };
}

export function parseHeartbeatResponse(
  value: WorkerResponse,
  sourceAccountId: string,
  watcherId: string,
): void {
  const result = response(value, "diagnostics.heartbeat");
  exact(result, [
    "operation",
    "sourceAccountId",
    "watcherId",
    "receivedAt",
    "nextExpectedAt",
  ]);
  if (
    result.sourceAccountId !== sourceAccountId ||
    result.watcherId !== watcherId
  )
    fail();
  const receivedAt = time(result.receivedAt);
  const nextExpectedAt = time(result.nextExpectedAt);
  if (nextExpectedAt !== receivedAt + HEARTBEAT_DEADLINE_MS) fail();
}

/**
 * ADM-9 follow-up. A heartbeat that is being refused says so, once.
 *
 * `ping` used to swallow every failure with a bare `catch {}`, and that hid a
 * real incident: a watcher whose `watcherId` no longer matches the registered
 * one is answered `identity_review_required` by `recordWorkerHeartbeat` on
 * every tick, forever. The id is derived from a random salt in the journal's
 * state file (`credentialSalt`, journal.ts), so recreating the journal
 * directory changes it; passes carry on working, because the one other
 * operation that carries a `watcherId` (ADM-9's `diagnostics.passOutcome`) is
 * reported after the work is done and its refusal is swallowed too, so the
 * only symptom is
 * `worker_watcher_states.last_seen_at` frozen at the instant the journal
 * changed while the watcher looks busy and healthy from the host.
 *
 * Once per process rather than once per tick: at 30 seconds a repeating line
 * is a log nobody reads, and none of the conditions worth naming here resolve
 * on their own.
 */
let downgradeWarned = false;
function warnDowngradeOnce(): void {
  if (downgradeWarned) return;
  downgradeWarned = true;
  console.warn(
    "[pipeline] this server is older than ADM-10 and refuses the heartbeat's watcher-identity fields; sending without them, so a legacy registration will not be adopted and two live hosts will not be detected until the server is updated. Not repeating this warning.",
  );
}

let heartbeatWarned = false;
function warnHeartbeatOnce(reason: string): void {
  if (heartbeatWarned) return;
  heartbeatWarned = true;
  console.warn(
    `[pipeline] the watcher heartbeat is not being accepted (${reason}); passes continue but this host will read as missing until it is re-registered. Not repeating this warning.`,
  );
}

export class WatchHeartbeat {
  private stopped = false;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;

  constructor(
    private readonly config: PipelineConfig,
    private transport: WorkerTransport,
    readonly watcherId: string,
    /**
     * ADM-10. `journal.legacyWatcherId`. Left out only by a caller that has
     * none, in which case a server holding the legacy id refuses this watcher
     * until the owner re-registers it.
     */
    readonly legacyWatcherId?: string,
    /**
     * ADM-10 review. One value per worker process, so that two hosts sharing a
     * copied journal -- which now present the same `watcherId` on purpose --
     * are still two things on the wire. Defaulted here rather than passed in
     * because "once per process" is the whole property: a caller that
     * constructed two of these with two nonces would be inventing the split
     * brain this exists to find.
     */
    readonly heartbeatNonce: string = randomBytes(16).toString("hex"),
  ) {}

  /** Whether this server has been seen to accept the ADM-10 fields. */
  private extended = true;

  private request(): Record<string, unknown> {
    return {
      protocolVersion: 1,
      operation: "diagnostics.heartbeat",
      spaceId: this.config.spaceId,
      sourceAccountId: this.config.sourceAccountId,
      watcherId: this.watcherId,
      ...(!this.extended ||
      this.legacyWatcherId === undefined ||
      this.legacyWatcherId === this.watcherId
        ? {}
        : { legacyWatcherId: this.legacyWatcherId }),
      ...(this.extended ? { heartbeatNonce: this.heartbeatNonce } : {}),
      ...(this.extended
        ? {
            allowedRootAliases: this.config.roots
              .map((root) => root.alias)
              .sort(),
          }
        : {}),
      connectorVersion: "kithmind-filesystem-worker-v1",
    };
  }

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.ping(), delay);
  }

  private async ping(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(
      () => controller.abort(),
      HEARTBEAT_REQUEST_TIMEOUT_MS,
    );
    try {
      let result = await this.transport.call(this.request(), controller.signal);
      // ADM-9 follow-up. The refusal code, before the parser turns every
      // failure into one indistinguishable throw: it is the only thing that
      // tells a stopped heartbeat apart from a broken one.
      let refused = errorCode(result);
      // ADM-10 review, version skew. A server older than ADM-10 has never
      // heard of `legacyWatcherId` or `heartbeatNonce`, and its request parser
      // refuses an unknown key outright rather than ignoring it. That would
      // kill the heartbeat -- which is the bug this whole task exists to fix --
      // so the first `invalid_request` drops both fields for the rest of the
      // process and retries at once. The result is a worker that is safe to
      // deploy before or after its server, in either order, with no capability
      // handshake and no extra round trip in the steady state.
      //
      // `invalid_request` is the right signal to key on: every other value in
      // this request is a constant or comes from the journal, all of them
      // already valid, so the shape is the only thing left for the server to
      // object to. A false positive costs the split-brain nonce and nothing
      // else, and the worker says so once.
      if (refused === "invalid_request" && this.extended && !this.stopped) {
        this.extended = false;
        // Its own one-shot line, deliberately not `warnHeartbeatOnce`: that
        // one means "this host is not being counted", and after the retry
        // below it is. Spending it here would swallow the next genuine
        // refusal, which is the message that matters.
        warnDowngradeOnce();
        result = await this.transport.call(this.request(), controller.signal);
        refused = errorCode(result);
      }
      if (refused !== undefined) warnHeartbeatOnce(refused);
      if (!this.stopped && refused === undefined)
        parseHeartbeatResponse(
          result,
          this.config.sourceAccountId,
          this.watcherId,
        );
    } catch (error) {
      // A worker heartbeat has no durable replay state and exposes no remote
      // detail, so this stays broad and the loop carries on: the next tick
      // tries again in 30 seconds.
      if (!this.stopped)
        warnHeartbeatOnce(
          error instanceof Error ? error.message : "unknown error",
        );
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
      this.inFlight = false;
      this.schedule(HEARTBEAT_INTERVAL_MS);
    }
  }
}
