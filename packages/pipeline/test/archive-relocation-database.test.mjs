import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ArchiveRelocationDatabaseError,
  resolveRelocatedDatabaseReceipt,
} from "../dist/archiveRelocationDatabase.js";
import { relocationIntentFromRecipe } from "../dist/archiveRelocationRecipe.js";

const recipe = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/archive-relocation-inventory-recipe.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function opaqueArtifact(
  domain,
  snapshotId,
  storedPath,
  ciphertextSha256,
  ciphertextByteLength,
) {
  return {
    snapshotId,
    objectName: `${domain}-${createHash("sha256")
      .update(`archive-relocation-${domain}:v1\0${snapshotId}\0${storedPath}`)
      .digest("hex")}`,
    ciphertextSha256,
    ciphertextByteLength,
  };
}

function combinedArtifacts(value = recipe) {
  return [
    ...value.body.processing.artifactBindings.map((binding) =>
      opaqueArtifact(
        "processing",
        binding.snapshotId,
        `/${binding.objectName}`,
        binding.ciphertextSha256,
        binding.ciphertextByteLength,
      ),
    ),
    ...value.body.database.receipts.map(({ receipt }) =>
      opaqueArtifact(
        "database",
        receipt.snapshotId,
        receipt.objectPath,
        receipt.ciphertextHash,
        receipt.ciphertextByteLength,
      ),
    ),
  ].sort((left, right) =>
    `${left.snapshotId}\0${left.objectName}`.localeCompare(
      `${right.snapshotId}\0${right.objectName}`,
    ),
  );
}

function verifiedState(value = recipe, phase = "verified") {
  const artifacts = combinedArtifacts(value);
  return {
    version: 1,
    phase,
    intent: relocationIntentFromRecipe(value),
    preMoveVerifiedAt: 1_789_000_000_000,
    preMoveVerifiedArtifacts: structuredClone(artifacts),
    destinationId: value.body.wholeRoot.sourceId,
    newBoundary: {
      rootPath: value.body.wholeRoot.newRootPath,
      rootId: value.body.wholeRoot.sourceId,
    },
    movedAt: 1_789_000_001_000,
    verifiedAt: 1_789_000_002_000,
    verifiedArtifacts: structuredClone(artifacts),
  };
}

function movedState(value = recipe) {
  const artifacts = combinedArtifacts(value);
  return {
    version: 1,
    phase: "moved",
    intent: relocationIntentFromRecipe(value),
    preMoveVerifiedAt: 1_789_000_000_000,
    preMoveVerifiedArtifacts: artifacts,
    destinationId: value.body.wholeRoot.sourceId,
    newBoundary: {
      rootPath: value.body.wholeRoot.newRootPath,
      rootId: value.body.wholeRoot.sourceId,
    },
    movedAt: 1_789_000_001_000,
  };
}

function resolve(value = recipe, state = verifiedState(value), fingerprint) {
  return resolveRelocatedDatabaseReceipt({
    recipe: value,
    state,
    receiptFingerprint:
      fingerprint ?? value.body.database.receipts[0].receiptFingerprint,
  });
}

test("resolves only the exact historical receipt at the verified new boundary", () => {
  for (const phase of ["verified", "rebound", "resumed"]) {
    const result = resolve(recipe, verifiedState(recipe, phase));
    const binding = recipe.body.database.receipts[0];
    assert.deepEqual(result, {
      version: 1,
      provenance: "recipe_bound_verified_relocation",
      recipeHash: recipe.recipeHash,
      workflowRelocationId: recipe.workflowRelocationId,
      verifiedAt: 1_789_000_002_000,
      receiptFingerprint: binding.receiptFingerprint,
      repositoryBoundary: recipe.body.database.newBoundary,
      receipt: binding.receipt,
    });
    assert.equal(result.receipt.snapshotId, binding.receipt.snapshotId);
    assert.equal(result.receipt.objectPath, binding.receipt.objectPath);
  }
});

test("rejects unknown receipt and pre-verification state", () => {
  assert.throws(
    () => resolve(recipe, verifiedState(), "0".repeat(64)),
    (error) =>
      error instanceof ArchiveRelocationDatabaseError &&
      error.code === "receipt_not_found",
  );
  assert.throws(
    () => resolve(recipe, movedState()),
    (error) =>
      error instanceof ArchiveRelocationDatabaseError &&
      error.code === "state_not_verified",
  );
});

test("rejects altered intent and internally consistent destination identity", () => {
  const intent = verifiedState();
  intent.intent.sourceParentId = "different-source-parent";
  assert.throws(
    () => resolve(recipe, intent),
    (error) =>
      error instanceof ArchiveRelocationDatabaseError &&
      error.code === "state_conflict",
  );

  const destination = verifiedState();
  destination.intent.sourceId = "different-root";
  destination.intent.oldBoundary.rootId = "different-root";
  destination.destinationId = "different-root";
  destination.newBoundary.rootId = "different-root";
  assert.throws(
    () => resolve(recipe, destination),
    (error) =>
      error instanceof ArchiveRelocationDatabaseError &&
      error.code === "state_conflict",
  );

  const boundary = verifiedState();
  boundary.intent.newRootPath = "/Kith Mind/other-backups";
  boundary.newBoundary.rootPath = "/Kith Mind/other-backups";
  assert.throws(
    () => resolve(recipe, boundary),
    (error) =>
      error instanceof ArchiveRelocationDatabaseError &&
      error.code === "state_conflict",
  );
});

test("rejects altered combined processing or database artifact evidence", () => {
  for (const index of [0, combinedArtifacts().length - 1]) {
    const state = verifiedState();
    state.preMoveVerifiedArtifacts[index].ciphertextSha256 = "f".repeat(64);
    state.verifiedArtifacts[index].ciphertextSha256 = "f".repeat(64);
    assert.throws(
      () => resolve(recipe, state),
      (error) =>
        error instanceof ArchiveRelocationDatabaseError &&
        error.code === "state_conflict",
    );
  }
});

test("rejects a receipt changed outside the immutable recipe identity", () => {
  const changed = structuredClone(recipe);
  changed.body.database.receipts[0].receipt.status = "changed";
  assert.throws(
    () => resolve(changed, verifiedState(recipe)),
    (error) =>
      error instanceof ArchiveRelocationDatabaseError &&
      error.code === "state_conflict",
  );
});
