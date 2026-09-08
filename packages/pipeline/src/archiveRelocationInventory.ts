import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  parseOwnerArchiveRelocationRecipe,
  type OwnerArchiveRelocationRecipe,
  type ProcessingArtifactBinding,
  type DatabaseReceiptBinding,
} from "./archiveRelocationRecipe.js";
import type { RelocationArtifact } from "./archiveRelocationWorkflow.js";
import {
  RESTIC_VERSION,
  type RemoteBackupBoundary,
  type ResticSnapshotInventory,
  type ResticSnapshotInventoryRow,
  type ResticSnapshotTreeEntry,
  type ResticSnapshotTreeInventory,
} from "./archiveTypes.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SNAPSHOTS = 2_048;
const MAX_ENTRIES = 2_048;
const MAX_PATH_BYTES = 4_096;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export type ReconciledArchiveObject = Readonly<{
  domain: "processing" | "database";
  snapshotId: string;
  treeId: string;
  storedPath: string;
  storedName: string;
  /** Declared by the immutable recipe; content readback is a later gate. */
  expectedCiphertextSha256: string;
  /** Declared by the immutable recipe; content readback is a later gate. */
  expectedCiphertextByteLength: number;
  hostname: string;
  tags: readonly string[];
  inputProvenancePaths: readonly string[];
  identityFingerprint: string;
}>;

export type ArchiveRelocationInventoryManifest = Readonly<{
  version: 1;
  recipeHash: string;
  phase: "old" | "new";
  processingBoundary: RemoteBackupBoundary;
  databaseBoundary: RemoteBackupBoundary;
  processingObjects: readonly ReconciledArchiveObject[];
  databaseObjects: readonly ReconciledArchiveObject[];
  workflowArtifacts: readonly RelocationArtifact[];
  manifestSha256: string;
}>;

export class ArchiveRelocationInventoryError extends Error {
  constructor(readonly code: "invalid_inventory" | "inventory_conflict") {
    super(`Archive relocation inventory failed: ${code}`);
    this.name = "ArchiveRelocationInventoryError";
  }
}

function fail(
  code: ArchiveRelocationInventoryError["code"] = "invalid_inventory",
): never {
  throw new ArchiveRelocationInventoryError(code);
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
  return value;
}

function text(value: unknown, maximum = 1_024): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.normalize("NFC") !== value
  )
    fail();
  return value;
}

function integer(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_ARTIFACT_BYTES
  )
    fail();
  return value as number;
}

function exactKeys(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    actual.some(
      (key) =>
        key === "__proto__" || key === "prototype" || key === "constructor",
    )
  )
    fail();
}

function exactBoundary(
  actual: RemoteBackupBoundary,
  expected: RemoteBackupBoundary,
): void {
  const keys = [
    "mode",
    "readiness",
    "backend",
    "remoteName",
    "rootPath",
    "rootDirectoryIdHash",
    "configIdentityFingerprint",
    "repositoryId",
    "resticVersion",
    "rcloneVersion",
  ] as const;
  exactKeys(actual, keys);
  exactKeys(expected, keys);
  if (keys.some((key) => actual[key] !== expected[key]))
    fail("inventory_conflict");
}

function safeStoredPath(value: unknown): string {
  const path = text(value, MAX_PATH_BYTES);
  if (
    !path.startsWith("/") ||
    path === "/" ||
    path.includes("\\") ||
    posix.normalize(path) !== path ||
    path
      .split("/")
      .some(
        (part, index) => index > 0 && (!part || part === "." || part === ".."),
      )
  )
    fail();
  return path;
}

function safeProvenancePath(value: unknown): string {
  const path = text(value, MAX_PATH_BYTES);
  if (
    path.includes("\\") ||
    posix.normalize(path) !== path ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    fail();
  return path;
}

function sortedUniqueText(
  values: unknown,
  maximum: number,
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && values.length < 1) ||
    values.length > maximum
  )
    fail();
  const result = values.map((value) => text(value, MAX_PATH_BYTES)).sort();
  if (new Set(result).size !== result.length) fail("inventory_conflict");
  return result;
}

function snapshotRows(
  inventory: ResticSnapshotInventory,
  expectedBoundary: RemoteBackupBoundary,
): Map<string, ResticSnapshotInventoryRow> {
  exactKeys(inventory, [
    "repositoryId",
    "resticVersion",
    "boundary",
    "snapshots",
    "verification",
  ]);
  if (
    inventory.verification !== "unfiltered_snapshot_inventory" ||
    inventory.repositoryId !== expectedBoundary.repositoryId ||
    inventory.resticVersion !== RESTIC_VERSION ||
    !Array.isArray(inventory.snapshots) ||
    inventory.snapshots.length < 1 ||
    inventory.snapshots.length > MAX_SNAPSHOTS
  )
    fail("inventory_conflict");
  exactBoundary(inventory.boundary, expectedBoundary);
  const rows = new Map<string, ResticSnapshotInventoryRow>();
  for (const input of inventory.snapshots) {
    exactKeys(input, ["snapshotId", "hostname", "tags", "paths"]);
    const snapshotId = sha(input.snapshotId);
    const hostname = text(input.hostname, 255);
    const tags = sortedUniqueText(input.tags, 128, true);
    const paths = sortedUniqueText(input.paths, 128).map(safeProvenancePath);
    if (rows.has(snapshotId)) fail("inventory_conflict");
    rows.set(snapshotId, { snapshotId, hostname, tags, paths });
  }
  return rows;
}

function exactTree(
  tree: ResticSnapshotTreeInventory,
  expectedBoundary: RemoteBackupBoundary,
  expectedSnapshotId: string,
  expectedPath: string,
  expectedByteLength: number,
): {
  treeId: string;
  file: Extract<ResticSnapshotTreeEntry, { type: "file" }>;
} {
  exactKeys(tree, [
    "repositoryId",
    "resticVersion",
    "boundary",
    "snapshotId",
    "treeId",
    "entries",
    "verification",
  ]);
  if (
    tree.verification !== "exact_snapshot_tree_inventory" ||
    tree.repositoryId !== expectedBoundary.repositoryId ||
    tree.resticVersion !== RESTIC_VERSION ||
    sha(tree.snapshotId) !== expectedSnapshotId ||
    !Array.isArray(tree.entries) ||
    tree.entries.length < 1 ||
    tree.entries.length > MAX_ENTRIES
  )
    fail("inventory_conflict");
  exactBoundary(tree.boundary, expectedBoundary);
  const treeId = sha(tree.treeId);
  const files: Extract<ResticSnapshotTreeEntry, { type: "file" }>[] = [];
  const directories = new Set<string>();
  const seen = new Set<string>();
  for (const input of tree.entries) {
    if (!input || typeof input !== "object") fail();
    exactKeys(
      input,
      input.type === "dir"
        ? ["type", "name", "path"]
        : ["type", "name", "path", "byteLength"],
    );
    const path = safeStoredPath(input.path);
    const name = text(input.name, 255);
    if (name !== posix.basename(path) || seen.has(path))
      fail("inventory_conflict");
    seen.add(path);
    if (input.type === "dir") {
      directories.add(path);
    } else if (input.type === "file") {
      files.push({
        type: "file",
        path,
        name,
        byteLength: integer(input.byteLength),
      });
    } else {
      fail();
    }
  }
  if (
    files.length !== 1 ||
    files[0]!.path !== expectedPath ||
    files[0]!.byteLength !== expectedByteLength
  )
    fail("inventory_conflict");
  const expectedDirectories = new Set<string>();
  let parent = posix.dirname(expectedPath);
  while (parent !== "/") {
    expectedDirectories.add(parent);
    parent = posix.dirname(parent);
  }
  if (
    directories.size !== expectedDirectories.size ||
    [...directories].some((path) => !expectedDirectories.has(path))
  )
    fail("inventory_conflict");
  return { treeId, file: files[0]! };
}

function opaqueArtifact(
  domain: "processing" | "database",
  snapshotId: string,
  storedPath: string,
  ciphertextSha256: string,
  ciphertextByteLength: number,
): RelocationArtifact {
  const objectName = `${domain}-${createHash("sha256")
    .update(`archive-relocation-${domain}:v1\0${snapshotId}\0${storedPath}`)
    .digest("hex")}`;
  return { snapshotId, objectName, ciphertextSha256, ciphertextByteLength };
}

function reconcileProcessing(
  recipe: OwnerArchiveRelocationRecipe,
  boundary: RemoteBackupBoundary,
  inventory: ResticSnapshotInventory,
  trees: readonly ResticSnapshotTreeInventory[],
): { objects: ReconciledArchiveObject[]; artifacts: RelocationArtifact[] } {
  const rows = snapshotRows(inventory, boundary);
  const bindings = recipe.body.processing.artifactBindings;
  if (new Set(bindings.map((item) => item.snapshotId)).size !== bindings.length)
    fail("inventory_conflict");
  if (rows.size !== bindings.length || trees.length !== bindings.length)
    fail("inventory_conflict");
  const treesBySnapshot = new Map(trees.map((tree) => [tree.snapshotId, tree]));
  if (treesBySnapshot.size !== trees.length) fail("inventory_conflict");
  const objects = bindings.map((binding: ProcessingArtifactBinding) => {
    const row = rows.get(binding.snapshotId);
    const tree = treesBySnapshot.get(binding.snapshotId);
    if (!row || !tree) fail("inventory_conflict");
    if (
      row.paths.length !== 1 ||
      posix.basename(row.paths[0]!) !== binding.objectName
    )
      fail("inventory_conflict");
    const storedPath = `/${binding.objectName}`;
    const exact = exactTree(
      tree,
      boundary,
      binding.snapshotId,
      storedPath,
      binding.ciphertextByteLength,
    );
    return {
      domain: "processing" as const,
      snapshotId: binding.snapshotId,
      treeId: exact.treeId,
      storedPath,
      storedName: binding.objectName,
      expectedCiphertextSha256: binding.ciphertextSha256,
      expectedCiphertextByteLength: binding.ciphertextByteLength,
      hostname: row.hostname,
      tags: row.tags,
      inputProvenancePaths: row.paths,
      identityFingerprint: createHash("sha256")
        .update(
          `processing-binding:v1\0${binding.kind}\0${binding.catalogId}\0${binding.plaintextSha256}\0${binding.plaintextByteLength}`,
        )
        .digest("hex"),
    };
  });
  const artifacts = objects.map((item) =>
    opaqueArtifact(
      "processing",
      item.snapshotId,
      item.storedPath,
      item.expectedCiphertextSha256,
      item.expectedCiphertextByteLength,
    ),
  );
  return { objects, artifacts };
}

function reconcileDatabase(
  recipe: OwnerArchiveRelocationRecipe,
  boundary: RemoteBackupBoundary,
  inventory: ResticSnapshotInventory,
  trees: readonly ResticSnapshotTreeInventory[],
): { objects: ReconciledArchiveObject[]; artifacts: RelocationArtifact[] } {
  const rows = snapshotRows(inventory, boundary);
  const receipts = recipe.body.database.receipts;
  if (
    new Set(receipts.map((item) => item.receipt.snapshotId)).size !==
    receipts.length
  )
    fail("inventory_conflict");
  if (rows.size !== receipts.length || trees.length !== receipts.length)
    fail("inventory_conflict");
  const treesBySnapshot = new Map(trees.map((tree) => [tree.snapshotId, tree]));
  if (treesBySnapshot.size !== trees.length) fail("inventory_conflict");
  const objects = receipts.map((binding: DatabaseReceiptBinding) => {
    const receipt = binding.receipt;
    const row = rows.get(receipt.snapshotId);
    const tree = treesBySnapshot.get(receipt.snapshotId);
    if (!row || !tree) fail("inventory_conflict");
    if (
      row.tags.length !== 1 ||
      row.tags[0] !== receipt.snapshotTag ||
      row.paths.length !== 1 ||
      row.paths[0] !== receipt.objectPath
    )
      fail("inventory_conflict");
    const exact = exactTree(
      tree,
      boundary,
      receipt.snapshotId,
      receipt.objectPath,
      receipt.ciphertextByteLength,
    );
    return {
      domain: "database" as const,
      snapshotId: receipt.snapshotId,
      treeId: exact.treeId,
      storedPath: receipt.objectPath,
      storedName: posix.basename(receipt.objectPath),
      expectedCiphertextSha256: receipt.ciphertextHash,
      expectedCiphertextByteLength: receipt.ciphertextByteLength,
      hostname: row.hostname,
      tags: row.tags,
      inputProvenancePaths: row.paths,
      identityFingerprint: binding.receiptFingerprint,
    };
  });
  const artifacts = objects.map((item) =>
    opaqueArtifact(
      "database",
      item.snapshotId,
      item.storedPath,
      item.expectedCiphertextSha256,
      item.expectedCiphertextByteLength,
    ),
  );
  return { objects, artifacts };
}

function withoutManifestHash(
  manifest: ArchiveRelocationInventoryManifest,
): Omit<ArchiveRelocationInventoryManifest, "manifestSha256"> {
  const { manifestSha256: _hash, ...body } = manifest;
  return body;
}

export function reconcileArchiveRelocationInventory(args: {
  recipe: unknown;
  phase: "old" | "new";
  processing: {
    snapshots: ResticSnapshotInventory;
    trees: readonly ResticSnapshotTreeInventory[];
  };
  database: {
    snapshots: ResticSnapshotInventory;
    trees: readonly ResticSnapshotTreeInventory[];
  };
}): ArchiveRelocationInventoryManifest {
  try {
    const recipe = parseOwnerArchiveRelocationRecipe(args.recipe);
    if (args.phase !== "old" && args.phase !== "new") fail();
    const processingBoundary =
      args.phase === "old"
        ? recipe.body.processing.oldBoundary
        : recipe.body.processing.newBoundary;
    const databaseBoundary =
      args.phase === "old"
        ? recipe.body.database.oldBoundary
        : recipe.body.database.newBoundary;
    const processing = reconcileProcessing(
      recipe,
      processingBoundary,
      args.processing.snapshots,
      args.processing.trees,
    );
    const database = reconcileDatabase(
      recipe,
      databaseBoundary,
      args.database.snapshots,
      args.database.trees,
    );
    const workflowArtifacts = [
      ...processing.artifacts,
      ...database.artifacts,
    ].sort((left, right) =>
      `${left.snapshotId}\0${left.objectName}`.localeCompare(
        `${right.snapshotId}\0${right.objectName}`,
      ),
    );
    if (
      new Set(
        workflowArtifacts.map(
          (item) => `${item.snapshotId}\0${item.objectName}`,
        ),
      ).size !== workflowArtifacts.length
    )
      fail("inventory_conflict");
    const body = {
      version: 1 as const,
      recipeHash: recipe.recipeHash,
      phase: args.phase,
      processingBoundary,
      databaseBoundary,
      processingObjects: processing.objects.sort((left, right) =>
        left.snapshotId.localeCompare(right.snapshotId),
      ),
      databaseObjects: database.objects.sort((left, right) =>
        left.snapshotId.localeCompare(right.snapshotId),
      ),
      workflowArtifacts,
    };
    return {
      ...body,
      manifestSha256: createHash("sha256")
        .update(`archive-relocation-inventory:v1\0${JSON.stringify(body)}`)
        .digest("hex"),
    };
  } catch (error) {
    if (error instanceof ArchiveRelocationInventoryError) throw error;
    fail();
  }
}

/**
 * Compares fresh, in-process reconciler outputs. This is not a parser or
 * authenticity check for a persisted manifest; persisted evidence must be
 * rebuilt from its immutable recipe and fresh inventories.
 */
export function assertArchiveRelocationInventoryContinuity(
  source: ArchiveRelocationInventoryManifest,
  destination: ArchiveRelocationInventoryManifest,
): void {
  for (const manifest of [source, destination]) {
    const body = withoutManifestHash(manifest);
    const expected = createHash("sha256")
      .update(`archive-relocation-inventory:v1\0${JSON.stringify(body)}`)
      .digest("hex");
    if (manifest.manifestSha256 !== expected) fail("inventory_conflict");
  }
  if (source.phase !== "old" || destination.phase !== "new")
    fail("inventory_conflict");
  const normalized = (manifest: ArchiveRelocationInventoryManifest) => {
    const body = withoutManifestHash(manifest);
    return {
      ...body,
      phase: "relocated",
      processingBoundary: {
        ...body.processingBoundary,
        rootPath: "<relocated-root>",
      },
      databaseBoundary: {
        ...body.databaseBoundary,
        rootPath: "<relocated-root>",
      },
    };
  };
  if (
    JSON.stringify(normalized(source)) !==
    JSON.stringify(normalized(destination))
  )
    fail("inventory_conflict");
}
