import assert from "node:assert/strict";
import test from "node:test";

import {
  ArchiveRelocationError,
  ArchiveRelocationWorkflow,
} from "../dist/archiveRelocationWorkflow.js";

const intent = () => ({
  relocationId: "relocation-1",
  sourceId: "legacy-root",
  sourceParentId: "legacy-parent",
  destinationParentId: "managed-parent",
  destinationName: "backups",
  oldBoundary: { rootPath: "/Kith Mind Backups", rootId: "legacy-root" },
  newRootPath: "/Kith Mind/backups",
});

function fixture({ moveThrowsAfterApplying = false } = {}) {
  let state;
  const writes = [];
  const folders = new Map([
    [
      "legacy-root",
      {
        id: "legacy-root",
        parentId: "legacy-parent",
        name: "Kith Mind Backups",
        path: "/Kith Mind Backups",
      },
    ],
    [
      "legacy-parent",
      {
        id: "legacy-parent",
        parentId: "root",
        name: "root",
        path: "/",
      },
    ],
    [
      "managed-parent",
      {
        id: "managed-parent",
        parentId: "root",
        name: "Kith Mind",
        path: "/Kith Mind",
      },
    ],
  ]);
  let moves = 0;
  const calls = [];
  const store = {
    async read() {
      return state;
    },
    async write(next) {
      state = structuredClone(next);
      writes.push(state.phase);
    },
  };
  const provider = {
    async getFolder(id) {
      return folders.get(id);
    },
    async getChild(parentId, name) {
      return [...folders.values()].find(
        (folder) => folder.parentId === parentId && folder.name === name,
      );
    },
    async moveFolder(request) {
      moves += 1;
      calls.push("move");
      const folder = folders.get(request.sourceId);
      assert.deepEqual(request, {
        sourceId: "legacy-root",
        expectedSourceParentId: "legacy-parent",
        destinationParentId: "managed-parent",
        destinationName: "backups",
      });
      folder.parentId = request.destinationParentId;
      folder.name = request.destinationName;
      folder.path = `${folders.get(request.destinationParentId).path}/${request.destinationName}`;
      if (moveThrowsAfterApplying && moves === 1) {
        throw new Error("connection lost after provider accepted move");
      }
      return folder;
    },
  };
  const gates = {
    async requireQuiescent() {
      calls.push("quiescent");
    },
    async verifySourceInventory() {
      calls.push("source-verify");
      return [
        {
          snapshotId: "snapshot-1",
          objectName: "object-1.age",
          ciphertextSha256: "a".repeat(64),
          ciphertextByteLength: 10,
        },
      ];
    },
    async verifyRelocatedInventory() {
      calls.push("verify");
      return [
        {
          snapshotId: "snapshot-1",
          objectName: "object-1.age",
          ciphertextSha256: "a".repeat(64),
          ciphertextByteLength: 10,
        },
      ];
    },
    async rebindRootPath(evidence) {
      calls.push("rebind");
      assert.equal(evidence.newBoundary.rootId, "legacy-root");
      assert.equal(evidence.verifiedArtifacts.length, 1);
    },
    async resumeUnchangedScan() {
      calls.push("resume");
    },
  };
  let clock = 100;
  return {
    workflow: new ArchiveRelocationWorkflow(
      store,
      provider,
      gates,
      () => clock++,
    ),
    calls,
    folders,
    get moves() {
      return moves;
    },
    get state() {
      return state;
    },
    writes,
    gates,
  };
}

test("persists move intent before sending one exact provider move", async () => {
  const f = fixture();
  await f.workflow.prepare(intent());
  const result = await f.workflow.resume();

  assert.equal(result.phase, "resumed");
  assert.deepEqual(f.writes, [
    "prepared",
    "source_verified",
    "move_requested",
    "moved",
    "verified",
    "rebound",
    "resumed",
  ]);
  assert.deepEqual(f.calls, [
    "quiescent",
    "source-verify",
    "move",
    "verify",
    "rebind",
    "resume",
  ]);
  assert.equal(f.moves, 1);
});

test("rejects a destination collision before persisting a move request", async () => {
  const f = fixture();
  f.folders.set("occupied", {
    id: "occupied",
    parentId: "managed-parent",
    name: "backups",
    path: "/Kith Mind/backups",
  });
  await f.workflow.prepare(intent());

  await assert.rejects(
    () => f.workflow.resume(),
    (error) =>
      error instanceof ArchiveRelocationError &&
      error.code === "destination_collision",
  );
  assert.deepEqual(f.writes, ["prepared"]);
  assert.equal(f.moves, 0);
});

test("rejects a changed source parent before moving", async () => {
  const f = fixture();
  f.folders.get("legacy-root").parentId = "wrong-parent";
  await f.workflow.prepare(intent());

  await assert.rejects(
    () => f.workflow.resume(),
    (error) =>
      error instanceof ArchiveRelocationError &&
      error.code === "source_identity_changed",
  );
  assert.deepEqual(f.writes, ["prepared"]);
  assert.equal(f.moves, 0);
});

test("recovers an uncertain move response by stable identity without another move", async () => {
  const f = fixture({ moveThrowsAfterApplying: true });
  await f.workflow.prepare(intent());

  await assert.rejects(() => f.workflow.resume(), /connection lost/);
  assert.equal(f.state.phase, "move_requested");
  assert.equal(f.moves, 1);

  const result = await f.workflow.resume();
  assert.equal(result.phase, "resumed");
  assert.equal(f.moves, 1);
  assert.deepEqual(f.calls, [
    "quiescent",
    "source-verify",
    "move",
    "quiescent",
    "verify",
    "rebind",
    "resume",
  ]);
});

test("does not rebind or resume until relocated inventory verification passes", async () => {
  const f = fixture();
  f.gates.verifyRelocatedInventory = async () => {
    f.calls.push("verify");
    throw new Error("ciphertext identity changed");
  };
  await f.workflow.prepare(intent());

  await assert.rejects(
    () => f.workflow.resume(),
    /ciphertext identity changed/,
  );
  assert.equal(f.state.phase, "moved");
  assert.deepEqual(f.calls, ["quiescent", "source-verify", "move", "verify"]);

  f.gates.verifyRelocatedInventory = async () => [
    {
      snapshotId: "snapshot-1",
      objectName: "object-1.age",
      ciphertextSha256: "a".repeat(64),
      ciphertextByteLength: 10,
    },
  ];
  const result = await f.workflow.resume();
  assert.equal(result.phase, "resumed");
  assert.deepEqual(f.calls, [
    "quiescent",
    "source-verify",
    "move",
    "verify",
    "quiescent",
    "rebind",
    "resume",
  ]);
});

test("rejects a post-move inventory that differs from the durable baseline", async () => {
  const f = fixture();
  f.gates.verifyRelocatedInventory = async () => [
    {
      snapshotId: "snapshot-1",
      objectName: "object-1.age",
      ciphertextSha256: "b".repeat(64),
      ciphertextByteLength: 10,
    },
  ];
  await f.workflow.prepare(intent());

  await assert.rejects(
    () => f.workflow.resume(),
    (error) =>
      error instanceof ArchiveRelocationError &&
      error.code === "inventory_changed",
  );
  assert.equal(f.state.phase, "moved");
  assert.equal(f.calls.includes("rebind"), false);
  assert.equal(f.calls.includes("resume"), false);
});

test("rejects a forged verified state whose inventory differs from its baseline", async () => {
  const f = fixture();
  await f.workflow.prepare(intent());
  Object.assign(f.state, {
    phase: "verified",
    preMoveVerifiedAt: 1,
    preMoveVerifiedArtifacts: [
      {
        snapshotId: "snapshot-1",
        objectName: "object-1.age",
        ciphertextSha256: "a".repeat(64),
        ciphertextByteLength: 10,
      },
    ],
    destinationId: "legacy-root",
    newBoundary: { rootPath: "/Kith Mind/backups", rootId: "legacy-root" },
    movedAt: 2,
    verifiedAt: 3,
    verifiedArtifacts: [
      {
        snapshotId: "snapshot-1",
        objectName: "object-1.age",
        ciphertextSha256: "b".repeat(64),
        ciphertextByteLength: 10,
      },
    ],
  });

  await assert.rejects(
    () => f.workflow.resume(),
    (error) =>
      error instanceof ArchiveRelocationError && error.code === "state_invalid",
  );
  assert.deepEqual(f.calls, []);
});

test("requires an identical intent when reusing a relocation identity", async () => {
  const f = fixture();
  await f.workflow.prepare(intent());

  await assert.rejects(
    () => f.workflow.prepare({ ...intent(), newRootPath: "/other/backups" }),
    (error) =>
      error instanceof ArchiveRelocationError &&
      error.code === "state_conflict",
  );
});
