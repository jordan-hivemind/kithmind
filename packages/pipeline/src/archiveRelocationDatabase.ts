import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  parseOwnerArchiveRelocationRecipe,
  relocationIntentFromRecipe,
  type LegacyDatabaseBackupReceipt,
  type OwnerArchiveRelocationRecipe,
} from "./archiveRelocationRecipe.js";
import {
  validateArchiveRelocationState,
  type ArchiveRelocationState,
  type RelocationArtifact,
} from "./archiveRelocationWorkflow.js";
import type { RemoteBackupBoundary } from "./archiveTypes.js";

const SHA256 = /^[a-f0-9]{64}$/;

export type RelocatedDatabaseReceipt = Readonly<{
  version: 1;
  provenance: "recipe_bound_verified_relocation";
  recipeHash: string;
  workflowRelocationId: string;
  verifiedAt: number;
  receiptFingerprint: string;
  repositoryBoundary: RemoteBackupBoundary;
  receipt: LegacyDatabaseBackupReceipt;
}>;

export class ArchiveRelocationDatabaseError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "state_not_verified"
      | "state_conflict"
      | "receipt_not_found",
  ) {
    super(`Archive relocation database receipt failed: ${code}`);
    this.name = "ArchiveRelocationDatabaseError";
  }
}

function fail(code: ArchiveRelocationDatabaseError["code"]): never {
  throw new ArchiveRelocationDatabaseError(code);
}

function opaqueArtifact(
  domain: "processing" | "database",
  snapshotId: string,
  storedPath: string,
  ciphertextSha256: string,
  ciphertextByteLength: number,
): RelocationArtifact {
  return {
    snapshotId,
    objectName: `${domain}-${createHash("sha256")
      .update(`archive-relocation-${domain}:v1\0${snapshotId}\0${storedPath}`)
      .digest("hex")}`,
    ciphertextSha256,
    ciphertextByteLength,
  };
}

function recipeArtifacts(
  recipe: OwnerArchiveRelocationRecipe,
): RelocationArtifact[] {
  const processing = recipe.body.processing.artifactBindings.map((binding) =>
    opaqueArtifact(
      "processing",
      binding.snapshotId,
      `/${binding.objectName}`,
      binding.ciphertextSha256,
      binding.ciphertextByteLength,
    ),
  );
  const database = recipe.body.database.receipts.map(({ receipt }) =>
    opaqueArtifact(
      "database",
      receipt.snapshotId,
      receipt.objectPath,
      receipt.ciphertextHash,
      receipt.ciphertextByteLength,
    ),
  );
  const combined = [...processing, ...database].sort((left, right) =>
    `${left.snapshotId}\0${left.objectName}`.localeCompare(
      `${right.snapshotId}\0${right.objectName}`,
    ),
  );
  const identities = combined.map(
    (artifact) => `${artifact.snapshotId}\0${artifact.objectName}`,
  );
  if (new Set(identities).size !== identities.length) fail("state_conflict");
  return combined;
}

function sortedArtifacts(
  artifacts: readonly RelocationArtifact[],
): RelocationArtifact[] {
  return [...artifacts].sort((left, right) =>
    `${left.snapshotId}\0${left.objectName}`.localeCompare(
      `${right.snapshotId}\0${right.objectName}`,
    ),
  );
}

/**
 * Resolves a historical receipt through a recipe-bound, verified move. The
 * caller must obtain state from the held session's protected store. A checksum
 * or deserialized state supplied without that authority is not authentication.
 */
export function resolveRelocatedDatabaseReceipt(input: {
  recipe: OwnerArchiveRelocationRecipe;
  state: ArchiveRelocationState;
  receiptFingerprint: string;
}): RelocatedDatabaseReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("invalid_input");
  let recipe: OwnerArchiveRelocationRecipe;
  let state: ArchiveRelocationState | undefined;
  try {
    recipe = parseOwnerArchiveRelocationRecipe(input.recipe);
    state = validateArchiveRelocationState(input.state);
  } catch {
    fail("state_conflict");
  }
  if (state === undefined) fail("state_conflict");
  if (
    state.phase !== "verified" &&
    state.phase !== "rebound" &&
    state.phase !== "resumed"
  )
    fail("state_not_verified");
  if (
    state.destinationId !== recipe.body.wholeRoot.sourceId ||
    !isDeepStrictEqual(state.intent, relocationIntentFromRecipe(recipe)) ||
    !isDeepStrictEqual(state.newBoundary, {
      rootPath: recipe.body.wholeRoot.newRootPath,
      rootId: recipe.body.wholeRoot.sourceId,
    }) ||
    !Number.isSafeInteger(state.verifiedAt) ||
    state.verifiedAt === undefined ||
    state.verifiedAt < 0 ||
    state.preMoveVerifiedArtifacts === undefined ||
    state.verifiedArtifacts === undefined
  )
    fail("state_conflict");
  const expectedArtifacts = recipeArtifacts(recipe);
  if (
    !isDeepStrictEqual(
      sortedArtifacts(state.preMoveVerifiedArtifacts),
      expectedArtifacts,
    ) ||
    !isDeepStrictEqual(
      sortedArtifacts(state.verifiedArtifacts),
      expectedArtifacts,
    )
  )
    fail("state_conflict");
  if (
    typeof input.receiptFingerprint !== "string" ||
    !SHA256.test(input.receiptFingerprint)
  )
    fail("invalid_input");
  const binding = recipe.body.database.receipts.find(
    ({ receiptFingerprint }) => receiptFingerprint === input.receiptFingerprint,
  );
  if (!binding) fail("receipt_not_found");
  return {
    version: 1,
    provenance: "recipe_bound_verified_relocation",
    recipeHash: recipe.recipeHash,
    workflowRelocationId: recipe.workflowRelocationId,
    verifiedAt: state.verifiedAt,
    receiptFingerprint: binding.receiptFingerprint,
    repositoryBoundary: structuredClone(recipe.body.database.newBoundary),
    receipt: structuredClone(binding.receipt),
  };
}
