import { posix } from "node:path";

export type RelocationPhase =
  | "prepared"
  | "source_verified"
  | "move_requested"
  | "moved"
  | "verified"
  | "rebound"
  | "resumed";
export type RelocationBoundary = Readonly<{ rootPath: string; rootId: string }>;
export type RelocationIntent = Readonly<{
  relocationId: string;
  sourceId: string;
  sourceParentId: string;
  destinationParentId: string;
  destinationName: string;
  oldBoundary: RelocationBoundary;
  newRootPath: string;
}>;
export type RelocationFolder = Readonly<{
  id: string;
  parentId: string;
  name: string;
  path: string;
}>;
export type RelocationArtifact = Readonly<{
  snapshotId: string;
  objectName: string;
  ciphertextSha256: string;
  ciphertextByteLength: number;
}>;
export type ArchiveRelocationState = Readonly<{
  version: 1;
  phase: RelocationPhase;
  intent: RelocationIntent;
  preMoveVerifiedAt?: number;
  preMoveVerifiedArtifacts?: readonly RelocationArtifact[];
  destinationId?: string;
  newBoundary?: RelocationBoundary;
  movedAt?: number;
  verifiedAt?: number;
  verifiedArtifacts?: readonly RelocationArtifact[];
}>;
export type ArchiveRelocationEvidence = Readonly<{
  relocationId: string;
  oldBoundary: RelocationBoundary;
  newBoundary: RelocationBoundary;
  movedAt: number;
  verifiedAt: number;
  verifiedArtifacts: readonly RelocationArtifact[];
}>;

/** The caller owns an exclusive durable store for one relocation identity. */
export interface ArchiveRelocationStore {
  read(): Promise<unknown>;
  write(state: ArchiveRelocationState): Promise<void>;
}
export interface ArchiveRelocationProvider {
  getFolder(id: string): Promise<RelocationFolder | undefined>;
  getChild(
    parentId: string,
    name: string,
  ): Promise<RelocationFolder | undefined>;
  moveFolder(request: {
    sourceId: string;
    expectedSourceParentId: string;
    destinationParentId: string;
    destinationName: string;
  }): Promise<RelocationFolder>;
}
export interface ArchiveRelocationGates {
  requireQuiescent(): Promise<void>;
  verifySourceInventory(
    intent: RelocationIntent,
  ): Promise<readonly RelocationArtifact[]>;
  verifyRelocatedInventory(
    state: Readonly<
      ArchiveRelocationState & {
        destinationId: string;
        newBoundary: RelocationBoundary;
        movedAt: number;
        preMoveVerifiedArtifacts: readonly RelocationArtifact[];
      }
    >,
  ): Promise<readonly RelocationArtifact[]>;
  rebindRootPath(evidence: ArchiveRelocationEvidence): Promise<void>;
  resumeUnchangedScan(evidence: ArchiveRelocationEvidence): Promise<void>;
}
export type ArchiveRelocationFailureCode =
  | "invalid_intent"
  | "state_conflict"
  | "state_invalid"
  | "source_missing"
  | "source_identity_changed"
  | "destination_parent_changed"
  | "destination_collision"
  | "move_response_invalid"
  | "move_outcome_ambiguous"
  | "verification_incomplete"
  | "inventory_changed";
export class ArchiveRelocationError extends Error {
  constructor(readonly code: ArchiveRelocationFailureCode) {
    super(`Archive relocation failed: ${code}`);
    this.name = "ArchiveRelocationError";
  }
}
function fail(code: ArchiveRelocationFailureCode): never {
  throw new ArchiveRelocationError(code);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("state_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("state_invalid");
  return value as Record<string, unknown>;
}
function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some(
      (key) =>
        !allowed.has(key) ||
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor",
    )
  )
    fail("state_invalid");
}
function text(value: unknown, code: ArchiveRelocationFailureCode): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1024
  )
    fail(code);
  return value;
}
function path(
  value: unknown,
  code: ArchiveRelocationFailureCode,
  allowRoot = false,
): string {
  const result = text(value, code);
  if (
    !result.startsWith("/") ||
    result !== posix.normalize(result) ||
    result.includes("\0") ||
    (!allowRoot && result === "/")
  )
    fail(code);
  return result;
}
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail("state_invalid");
  return value as number;
}
function boundary(
  value: unknown,
  code: ArchiveRelocationFailureCode,
): RelocationBoundary {
  const row = record(value);
  exact(row, ["rootPath", "rootId"]);
  return { rootPath: path(row.rootPath, code), rootId: text(row.rootId, code) };
}
function parseIntent(
  value: unknown,
  code: ArchiveRelocationFailureCode,
): RelocationIntent {
  const row = record(value);
  exact(row, [
    "relocationId",
    "sourceId",
    "sourceParentId",
    "destinationParentId",
    "destinationName",
    "oldBoundary",
    "newRootPath",
  ]);
  const result = {
    relocationId: text(row.relocationId, code),
    sourceId: text(row.sourceId, code),
    sourceParentId: text(row.sourceParentId, code),
    destinationParentId: text(row.destinationParentId, code),
    destinationName: text(row.destinationName, code),
    oldBoundary: boundary(row.oldBoundary, code),
    newRootPath: path(row.newRootPath, code),
  };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      result.relocationId,
    ) ||
    result.sourceId !== result.oldBoundary.rootId ||
    result.sourceParentId === result.destinationParentId ||
    result.destinationName.includes("/") ||
    result.destinationName === "." ||
    result.destinationName === ".."
  )
    fail(code);
  return result;
}
function artifact(
  value: unknown,
  code: ArchiveRelocationFailureCode,
): RelocationArtifact {
  const row = record(value);
  exact(row, [
    "snapshotId",
    "objectName",
    "ciphertextSha256",
    "ciphertextByteLength",
  ]);
  const sha256 = text(row.ciphertextSha256, code);
  if (
    !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof row.snapshotId !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.snapshotId) ||
    typeof row.objectName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.objectName) ||
    !Number.isSafeInteger(row.ciphertextByteLength) ||
    (row.ciphertextByteLength as number) < 1 ||
    (row.ciphertextByteLength as number) > 64 * 1024 * 1024
  )
    fail(code);
  return {
    snapshotId: text(row.snapshotId, code),
    objectName: text(row.objectName, code),
    ciphertextSha256: sha256,
    ciphertextByteLength: row.ciphertextByteLength as number,
  };
}
function artifacts(
  value: unknown,
  code: ArchiveRelocationFailureCode,
): readonly RelocationArtifact[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2048)
    fail(code);
  const result = value.map((entry) => artifact(entry, code));
  const keys = result.map(
    (entry) => `${entry.snapshotId}\0${entry.objectName}`,
  );
  if (new Set(keys).size !== keys.length) fail(code);
  return result;
}
function parseState(value: unknown): ArchiveRelocationState | undefined {
  if (value === undefined) return undefined;
  const row = record(value);
  exact(
    row,
    ["version", "phase", "intent"],
    [
      "preMoveVerifiedAt",
      "preMoveVerifiedArtifacts",
      "destinationId",
      "newBoundary",
      "movedAt",
      "verifiedAt",
      "verifiedArtifacts",
    ],
  );
  if (row.version !== 1 || typeof row.phase !== "string") fail("state_invalid");
  const intent = parseIntent(row.intent, "state_invalid");
  const phase = row.phase as RelocationPhase;
  const source = ["preMoveVerifiedAt", "preMoveVerifiedArtifacts"];
  const moved = ["destinationId", "newBoundary", "movedAt"];
  const verified = ["verifiedAt", "verifiedArtifacts"];
  const required =
    phase === "prepared"
      ? []
      : phase === "source_verified" || phase === "move_requested"
        ? source
        : phase === "moved"
          ? [...source, ...moved]
          : phase === "verified" || phase === "rebound" || phase === "resumed"
            ? [...source, ...moved, ...verified]
            : fail("state_invalid");
  const all = [...source, ...moved, ...verified];
  if (
    required.some((key) => !(key in row)) ||
    all.some((key) => !required.includes(key) && key in row)
  )
    fail("state_invalid");
  const state: ArchiveRelocationState = {
    version: 1,
    phase,
    intent,
    ...(row.preMoveVerifiedAt === undefined
      ? {}
      : { preMoveVerifiedAt: timestamp(row.preMoveVerifiedAt) }),
    ...(row.preMoveVerifiedArtifacts === undefined
      ? {}
      : {
          preMoveVerifiedArtifacts: artifacts(
            row.preMoveVerifiedArtifacts,
            "state_invalid",
          ),
        }),
    ...(row.destinationId === undefined
      ? {}
      : { destinationId: text(row.destinationId, "state_invalid") }),
    ...(row.newBoundary === undefined
      ? {}
      : { newBoundary: boundary(row.newBoundary, "state_invalid") }),
    ...(row.movedAt === undefined ? {} : { movedAt: timestamp(row.movedAt) }),
    ...(row.verifiedAt === undefined
      ? {}
      : { verifiedAt: timestamp(row.verifiedAt) }),
    ...(row.verifiedArtifacts === undefined
      ? {}
      : {
          verifiedArtifacts: artifacts(row.verifiedArtifacts, "state_invalid"),
        }),
  };
  if (
    state.destinationId !== undefined &&
    state.destinationId !== intent.sourceId
  )
    fail("state_invalid");
  if (
    state.newBoundary !== undefined &&
    (state.newBoundary.rootId !== intent.sourceId ||
      state.newBoundary.rootPath !== intent.newRootPath)
  )
    fail("state_invalid");
  if (
    state.movedAt !== undefined &&
    state.preMoveVerifiedAt !== undefined &&
    state.movedAt < state.preMoveVerifiedAt
  )
    fail("state_invalid");
  if (
    state.verifiedAt !== undefined &&
    state.movedAt !== undefined &&
    state.verifiedAt < state.movedAt
  )
    fail("state_invalid");
  if (
    state.verifiedArtifacts !== undefined &&
    state.preMoveVerifiedArtifacts !== undefined &&
    !sameArtifacts(state.preMoveVerifiedArtifacts, state.verifiedArtifacts)
  )
    fail("state_invalid");
  return state;
}

/** Closed validation for durable owner orchestration stores. */
export function validateArchiveRelocationState(
  value: unknown,
): ArchiveRelocationState | undefined {
  return parseState(value);
}
function parseFolder(
  value: RelocationFolder | undefined,
): RelocationFolder | undefined {
  if (value === undefined) return undefined;
  const row = record(value);
  exact(row, ["id", "parentId", "name", "path"]);
  const result = {
    id: text(row.id, "move_response_invalid"),
    parentId: text(row.parentId, "move_response_invalid"),
    name: text(row.name, "move_response_invalid"),
    path: path(row.path, "move_response_invalid", true),
  };
  if (result.name.includes("/") || result.name === "." || result.name === "..")
    fail("move_response_invalid");
  return result;
}
function sameArtifacts(
  before: readonly RelocationArtifact[],
  after: readonly RelocationArtifact[],
): boolean {
  const canonical = (items: readonly RelocationArtifact[]) =>
    [...items]
      .sort((left, right) =>
        `${left.snapshotId}\0${left.objectName}`.localeCompare(
          `${right.snapshotId}\0${right.objectName}`,
        ),
      )
      .map((entry) => JSON.stringify(entry));
  return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
}
function evidence(state: ArchiveRelocationState): ArchiveRelocationEvidence {
  if (
    state.newBoundary === undefined ||
    state.movedAt === undefined ||
    state.verifiedAt === undefined ||
    state.verifiedArtifacts === undefined
  )
    fail("verification_incomplete");
  return {
    relocationId: state.intent.relocationId,
    oldBoundary: state.intent.oldBoundary,
    newBoundary: state.newBoundary,
    movedAt: state.movedAt,
    verifiedAt: state.verifiedAt,
    verifiedArtifacts: state.verifiedArtifacts,
  };
}

/**
 * Owner-only orchestration. The caller must hold one exclusive lease across
 * every prepare/resume transition; the injected store must durably persist
 * each write. This module does not provide locking or provider credentials.
 */
export class ArchiveRelocationWorkflow {
  constructor(
    private readonly store: ArchiveRelocationStore,
    private readonly provider: ArchiveRelocationProvider,
    private readonly gates: ArchiveRelocationGates,
    private readonly now: () => number = Date.now,
  ) {}
  async prepare(intent: RelocationIntent): Promise<ArchiveRelocationState> {
    const validated = parseIntent(intent, "invalid_intent");
    const current = parseState(await this.store.read());
    if (current !== undefined) {
      if (JSON.stringify(current.intent) !== JSON.stringify(validated))
        fail("state_conflict");
      return current;
    }
    const state: ArchiveRelocationState = {
      version: 1,
      phase: "prepared",
      intent: validated,
    };
    await this.persist(state);
    return state;
  }
  async resume(): Promise<ArchiveRelocationState> {
    let state = parseState(await this.store.read());
    if (state === undefined) fail("state_conflict");
    if (state.phase !== "resumed") await this.gates.requireQuiescent();
    if (state.phase === "prepared") {
      await this.assertSourceAndDestination(state.intent);
      const baseline = artifacts(
        await this.gates.verifySourceInventory(state.intent),
        "inventory_changed",
      );
      state = {
        ...state,
        phase: "source_verified",
        preMoveVerifiedAt: this.now(),
        preMoveVerifiedArtifacts: baseline,
      };
      await this.persist(state);
    }
    if (state.phase === "source_verified") {
      await this.assertSourceAndDestination(state.intent);
      state = { ...state, phase: "move_requested" };
      await this.persist(state);
    }
    if (state.phase === "move_requested") {
      state = await this.completeOrRecoverMove(
        state as ArchiveRelocationState & { phase: "move_requested" },
      );
      await this.persist(state);
    }
    if (state.phase === "moved") {
      const after = artifacts(
        await this.gates.verifyRelocatedInventory(
          state as ArchiveRelocationState & {
            destinationId: string;
            newBoundary: RelocationBoundary;
            movedAt: number;
            preMoveVerifiedArtifacts: readonly RelocationArtifact[];
          },
        ),
        "inventory_changed",
      );
      if (!sameArtifacts(state.preMoveVerifiedArtifacts!, after))
        fail("inventory_changed");
      state = {
        ...state,
        phase: "verified",
        verifiedAt: this.now(),
        verifiedArtifacts: after,
      };
      await this.persist(state);
    }
    if (state.phase === "verified") {
      await this.gates.rebindRootPath(evidence(state));
      state = { ...state, phase: "rebound" };
      await this.persist(state);
    }
    if (state.phase === "rebound") {
      await this.gates.resumeUnchangedScan(evidence(state));
      state = { ...state, phase: "resumed" };
      await this.persist(state);
    }
    return state;
  }
  private async persist(state: ArchiveRelocationState): Promise<void> {
    // Apply the same invariants to new transitions and recovered state.
    await this.store.write(parseState(state)!);
  }
  private async assertSourceAndDestination(
    intent: RelocationIntent,
  ): Promise<void> {
    const [source, sourceParent, destinationParent, destination] =
      await Promise.all([
        this.provider.getFolder(intent.sourceId),
        this.provider.getFolder(intent.sourceParentId),
        this.provider.getFolder(intent.destinationParentId),
        this.provider.getChild(
          intent.destinationParentId,
          intent.destinationName,
        ),
      ]).then((values) => values.map(parseFolder));
    if (source === undefined || sourceParent === undefined)
      fail("source_missing");
    if (destinationParent === undefined) fail("destination_parent_changed");
    if (
      source.id !== intent.sourceId ||
      sourceParent.id !== intent.sourceParentId ||
      destinationParent.id !== intent.destinationParentId ||
      source.parentId !== intent.sourceParentId ||
      source.path !== intent.oldBoundary.rootPath ||
      posix.join(sourceParent.path, source.name) !== source.path
    )
      fail("source_identity_changed");
    if (
      posix.join(destinationParent.path, intent.destinationName) !==
      intent.newRootPath
    )
      fail("destination_parent_changed");
    if (destination !== undefined) fail("destination_collision");
  }
  private async completeOrRecoverMove(
    state: ArchiveRelocationState & { phase: "move_requested" },
  ): Promise<ArchiveRelocationState> {
    const intent = state.intent;
    const [source, destination, destinationParent] = await Promise.all([
      this.provider.getFolder(intent.sourceId),
      this.provider.getChild(
        intent.destinationParentId,
        intent.destinationName,
      ),
      this.provider.getFolder(intent.destinationParentId),
    ]).then((values) => values.map(parseFolder));
    if (
      destinationParent === undefined ||
      destinationParent.id !== intent.destinationParentId ||
      posix.join(destinationParent.path, intent.destinationName) !==
        intent.newRootPath
    )
      fail("destination_parent_changed");
    if (
      destination?.id === intent.sourceId &&
      destination.parentId === intent.destinationParentId &&
      destination.name === intent.destinationName &&
      destination.path === intent.newRootPath &&
      source?.id === intent.sourceId &&
      source.parentId === intent.destinationParentId &&
      source.name === intent.destinationName &&
      source.path === intent.newRootPath
    )
      return this.moved(state, destination);
    if (destination !== undefined) fail("destination_collision");
    if (
      source === undefined ||
      source.id !== intent.sourceId ||
      source.parentId !== intent.sourceParentId ||
      source.path !== intent.oldBoundary.rootPath
    )
      fail("move_outcome_ambiguous");
    const moved = parseFolder(
      await this.provider.moveFolder({
        sourceId: intent.sourceId,
        expectedSourceParentId: intent.sourceParentId,
        destinationParentId: intent.destinationParentId,
        destinationName: intent.destinationName,
      }),
    );
    if (
      moved === undefined ||
      moved.id !== intent.sourceId ||
      moved.parentId !== intent.destinationParentId ||
      moved.name !== intent.destinationName ||
      moved.path !== intent.newRootPath
    )
      fail("move_response_invalid");
    return this.moved(state, moved);
  }
  private moved(
    state: ArchiveRelocationState,
    destination: RelocationFolder,
  ): ArchiveRelocationState {
    return {
      ...state,
      phase: "moved",
      destinationId: destination.id,
      newBoundary: { rootPath: destination.path, rootId: destination.id },
      movedAt: this.now(),
    };
  }
}
