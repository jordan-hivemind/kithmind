export type GapCode =
  | "empty"
  | "enumeration_interrupted"
  | "oversized"
  | "permission_denied"
  | "unreadable"
  | "unstable"
  | "unsupported";

export type RootConfig = { alias: string; path: string };
export type PipelineConfig = {
  protocolVersion: 1;
  endpoint: string;
  spaceId: string;
  sourceAccountId: string;
  credentialEnv: string;
  roots: RootConfig[];
  journalDir: string;
  hostAffinity?: string;
  watchIntervalMs: number;
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
};

export type DiscoveryFile = {
  rootAlias: string;
  relativePath: string;
  uri: string;
  sourceModifiedAt: number;
  sha256: string;
  byteLength: number;
  text: string;
};

export type IdentityBinding = {
  rootAlias: string;
  relativePath: string;
  externalId: string;
};

export type PipelineRunResult = {
  state: "complete" | "incomplete" | "failed";
  code?: string;
  scanned?: number;
  published?: number;
};

export type WorkerErrorCode =
  | "not_authenticated"
  | "not_authorized"
  | "invalid_request"
  | "not_found"
  | "source_unavailable"
  | "request_conflict"
  | "scan_conflict"
  | "scan_not_ready"
  | "identity_review_required"
  | "rate_limited"
  | "reservation_expired"
  | "stale_observation"
  | "desired_processing_epoch_conflict"
  | "lease_conflict";
export type WorkerError = { error: { code: WorkerErrorCode } };
export type WorkerResponse = Record<string, unknown> | WorkerError;

export interface WorkerTransport {
  call(request: Record<string, unknown>): Promise<WorkerResponse>;
}
