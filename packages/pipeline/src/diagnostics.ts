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

export class WatchHeartbeat {
  private stopped = false;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;

  constructor(
    private readonly config: PipelineConfig,
    private transport: WorkerTransport,
    readonly watcherId: string,
  ) {}

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
      const result = await this.transport.call(
        {
          protocolVersion: 1,
          operation: "diagnostics.heartbeat",
          spaceId: this.config.spaceId,
          sourceAccountId: this.config.sourceAccountId,
          watcherId: this.watcherId,
          connectorVersion: "kithmind-filesystem-worker-v1",
        },
        controller.signal,
      );
      if (!this.stopped)
        parseHeartbeatResponse(
          result,
          this.config.sourceAccountId,
          this.watcherId,
        );
    } catch {
      // A worker heartbeat has no durable replay state and exposes no remote detail.
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
      this.inFlight = false;
      this.schedule(HEARTBEAT_INTERVAL_MS);
    }
  }
}
