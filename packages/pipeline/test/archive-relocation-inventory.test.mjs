import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  assertArchiveRelocationInventoryContinuity,
  reconcileArchiveRelocationInventory,
} from "../dist/archiveRelocationInventory.js";

const recipe = JSON.parse(
  await readFile(
    join(
      import.meta.dirname,
      "fixtures/archive-relocation-inventory-recipe.json",
    ),
    "utf8",
  ),
);

function inventory(phase) {
  const processingBoundary = recipe.body.processing[`${phase}Boundary`];
  const databaseBoundary = recipe.body.database[`${phase}Boundary`];
  const processing = recipe.body.processing.artifactBindings[0];
  const database = recipe.body.database.receipts[0].receipt;
  return {
    recipe,
    phase,
    processing: {
      snapshots: {
        repositoryId: processingBoundary.repositoryId,
        resticVersion: "0.19.1",
        boundary: processingBoundary,
        snapshots: [
          {
            snapshotId: processing.snapshotId,
            hostname: "synthetic-worker",
            tags: [],
            paths: [`/private/archive/${processing.objectName}`],
          },
        ],
        verification: "unfiltered_snapshot_inventory",
      },
      trees: [
        {
          repositoryId: processingBoundary.repositoryId,
          resticVersion: "0.19.1",
          boundary: processingBoundary,
          snapshotId: processing.snapshotId,
          treeId: "a".repeat(64),
          entries: [
            {
              type: "file",
              name: processing.objectName,
              path: `/${processing.objectName}`,
              byteLength: processing.ciphertextByteLength,
            },
          ],
          verification: "exact_snapshot_tree_inventory",
        },
      ],
    },
    database: {
      snapshots: {
        repositoryId: databaseBoundary.repositoryId,
        resticVersion: "0.19.1",
        boundary: databaseBoundary,
        snapshots: [
          {
            snapshotId: database.snapshotId,
            hostname: "synthetic-backup",
            tags: [database.snapshotTag],
            paths: [database.objectPath],
          },
        ],
        verification: "unfiltered_snapshot_inventory",
      },
      trees: [
        {
          repositoryId: databaseBoundary.repositoryId,
          resticVersion: "0.19.1",
          boundary: databaseBoundary,
          snapshotId: database.snapshotId,
          treeId: "b".repeat(64),
          entries: [
            { type: "dir", name: "synthetic", path: "/synthetic" },
            {
              type: "dir",
              name: "database",
              path: "/synthetic/database",
            },
            {
              type: "file",
              name: "snapshot-1.age",
              path: database.objectPath,
              byteLength: database.ciphertextByteLength,
            },
          ],
          verification: "exact_snapshot_tree_inventory",
        },
      ],
    },
  };
}

test("reconciles both exact repositories into an opaque workflow union", () => {
  const result = reconcileArchiveRelocationInventory(inventory("old"));
  assert.equal(result.processingObjects.length, 1);
  assert.equal(result.databaseObjects.length, 1);
  assert.equal(result.workflowArtifacts.length, 2);
  assert.match(
    result.workflowArtifacts[0].objectName,
    /^(database|processing)-[a-f0-9]{64}$/,
  );
  assert.match(
    result.workflowArtifacts[1].objectName,
    /^(database|processing)-[a-f0-9]{64}$/,
  );
  assert.equal(result.processingObjects[0].storedPath, "/synthetic.age");
  assert.deepEqual(result.processingObjects[0].inputProvenancePaths, [
    "/private/archive/synthetic.age",
  ]);
  assert.equal(
    result.databaseObjects[0].storedPath,
    "/synthetic/database/snapshot-1.age",
  );
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal("plaintextSha256" in result.processingObjects[0], false);
});

test("source and destination continuity ignores only repository root paths", () => {
  const source = reconcileArchiveRelocationInventory(inventory("old"));
  const destination = reconcileArchiveRelocationInventory(inventory("new"));
  assert.doesNotThrow(() =>
    assertArchiveRelocationInventoryContinuity(source, destination),
  );

  for (const mutate of [
    (value) => (value.processing.trees[0].treeId = "c".repeat(64)),
    (value) =>
      (value.processing.snapshots.snapshots[0].hostname = "other-host"),
    (value) =>
      (value.processing.snapshots.snapshots[0].paths = [
        "/different/synthetic.age",
      ]),
    (value) => {
      value.database.snapshots.repositoryId = "0".repeat(64);
      value.database.snapshots.boundary.repositoryId = "0".repeat(64);
    },
  ]) {
    const changed = structuredClone(inventory("new"));
    mutate(changed);
    if (changed.database.snapshots.boundary.repositoryId === "0".repeat(64)) {
      assert.throws(
        () => reconcileArchiveRelocationInventory(changed),
        /Archive relocation inventory failed/,
      );
    } else {
      const changedManifest = reconcileArchiveRelocationInventory(changed);
      assert.throws(
        () =>
          assertArchiveRelocationInventoryContinuity(source, changedManifest),
        /inventory_conflict/,
      );
    }
  }
});

test("rejects missing, extra, ambiguous, or misbound snapshot trees", () => {
  const cases = [
    (value) => value.processing.snapshots.snapshots.pop(),
    (value) =>
      value.processing.snapshots.snapshots.push(
        structuredClone(value.processing.snapshots.snapshots[0]),
      ),
    (value) =>
      value.processing.trees[0].entries.push({
        type: "dir",
        name: "foreign",
        path: "/foreign",
      }),
    (value) =>
      (value.processing.trees[0].entries[0].path =
        value.processing.snapshots.snapshots[0].paths[0]),
    (value) => (value.processing.trees[0].entries[0].byteLength += 1),
    (value) =>
      (value.processing.snapshots.snapshots[0].paths = [
        "/different/not-the-object.age",
      ]),
    (value) => value.database.snapshots.snapshots[0].tags.push("unexpected"),
    (value) =>
      (value.database.snapshots.snapshots[0].paths[0] =
        "/synthetic/database/other.age"),
    (value) => value.database.trees[0].entries.pop(),
    (value) => (value.database.trees[0].snapshotId = "0".repeat(64)),
  ];
  for (const mutate of cases) {
    const value = structuredClone(inventory("old"));
    mutate(value);
    assert.throws(
      () => reconcileArchiveRelocationInventory(value),
      /inventory_conflict|invalid_inventory/,
    );
  }
});

test("continuity rejects a forged or phase-reversed manifest", () => {
  const source = reconcileArchiveRelocationInventory(inventory("old"));
  const destination = reconcileArchiveRelocationInventory(inventory("new"));
  const forged = structuredClone(destination);
  forged.databaseObjects[0].treeId = "0".repeat(64);
  assert.throws(
    () => assertArchiveRelocationInventoryContinuity(source, forged),
    /inventory_conflict/,
  );
  assert.throws(
    () => assertArchiveRelocationInventoryContinuity(destination, source),
    /inventory_conflict/,
  );
});
