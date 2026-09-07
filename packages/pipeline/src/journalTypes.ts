export const JOURNAL_OPERATIONS = [
  "source.inventoryPage",
  "scan.begin",
  "scan.appendPage",
  "scan.seal",
  "scan.reconcile",
  "discovery.reserve",
  "discovery.admitUtf8",
  "jobs.reserve",
  "jobs.renew",
  "jobs.stageUtf8",
  "jobs.activate",
  "jobs.fail",
  "processing.assessBegin",
  "processing.assessPage",
] as const;

export type JournalOperation = (typeof JOURNAL_OPERATIONS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JournalBinding = {
  protocolVersion: 1;
  endpoint: string;
  spaceId: string;
  sourceAccountId: string;
  configFingerprint: string;
  credentialSlot: string;
};

export type JournalResult<R extends JsonValue> = {
  value: R;
  digest: string;
  receivedAt: number;
};

export type PendingRequest<R extends JsonValue> = {
  operation: JournalOperation;
  requestId: string;
  requestBody: string;
  requestDigest: string;
  createdAt: number;
  result?: JournalResult<R>;
};

export type JournalCredentialStatus = "current" | "changed_quiescent";

export type JournalInspection =
  | { state: "not_initialized" }
  | { state: "contended" }
  | {
      state: "safe";
      activity: "idle" | "scan" | "processing" | "assessment" | "terminal";
      pending: boolean;
      cachedResult: boolean;
      credentialSessionActive: boolean;
      credentialBinding:
        "current" | "changed_quiescent" | "changed_active" | "unverified";
      recoveryArtifactCount: number;
      manualRecoveryRequired: boolean;
    }
  | {
      state: "unsafe";
      code:
        | "unsupported_platform"
        | "invalid_directory"
        | "invalid_permissions"
        | "invalid_state"
        | "binding_mismatch"
        | "capacity_exceeded";
    };

export type JournalCodec<C extends JsonValue, R extends JsonValue> = {
  parseCheckpoint(value: unknown): C;
  parseResult(operation: JournalOperation, value: unknown): R;
};

export type PlanRequest = {
  operation: JournalOperation;
  requestId: string;
  requestBody: string;
  createdAt: number;
};

export type CheckpointTransition<C extends JsonValue> = {
  checkpoint: C;
  credentialSessionActive: boolean;
};
