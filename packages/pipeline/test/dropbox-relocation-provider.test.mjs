import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createDropboxRelocationProvider,
  dropboxNamespaceRootId,
} from "../dist/dropboxRelocationProvider.js";
import { ArchiveRelocationWorkflow } from "../dist/archiveRelocationWorkflow.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const accountId = "dbid:synthetic_account";
const accountHash = sha(accountId);
const rootId = dropboxNamespaceRootId(accountHash);
const sourceId = "id:legacy_root";
const destinationParentId = "id:kith_mind";

function folder(id, name, path) {
  return {
    ".tag": "folder",
    id,
    name,
    path_display: path,
    path_lower: path.toLowerCase(),
  };
}

function syntheticProvider({ rewrite } = {}) {
  const folders = new Map([
    [sourceId, folder(sourceId, "Kith Mind Backups", "/Kith Mind Backups")],
    [
      destinationParentId,
      folder(destinationParentId, "Kith Mind", "/Kith Mind"),
    ],
  ]);
  const moveBodies = [];
  const fetch = async (url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.match(options.headers.Authorization, /^Bearer /);
    const route = new URL(url).pathname.split("/").at(-1);
    const body = JSON.parse(options.body);
    let value;
    if (route === "get_current_account") {
      value = {
        account_id: accountId,
        disabled: false,
        extra_future_field: true,
      };
    } else if (route === "get_metadata") {
      value = [...folders.values()].find(
        (entry) => entry.id === body.path || entry.path_display === body.path,
      );
      if (!value)
        return new Response(JSON.stringify({ error_summary: "not_found" }), {
          status: 409,
        });
    } else if (route === "list_folder") {
      const parent =
        body.path === ""
          ? { id: rootId, path_display: "/" }
          : folders.get(body.path);
      assert.ok(parent);
      const entries = [...folders.values()].filter((entry) => {
        const parentPath =
          entry.path_display.slice(0, entry.path_display.lastIndexOf("/")) ||
          "/";
        return parentPath === parent.path_display;
      });
      value = { entries, has_more: false, cursor: "opaque-future-cursor" };
    } else if (route === "move_v2") {
      moveBodies.push(body);
      assert.equal(body.from_path, sourceId);
      assert.equal(body.to_path, `${destinationParentId}/backups`);
      assert.equal(body.autorename, false);
      assert.equal(body.allow_ownership_transfer, false);
      const source = folders.get(sourceId);
      source.name = "backups";
      source.path_display = "/Kith Mind/backups";
      source.path_lower = "/kith mind/backups";
      value = { metadata: source, extra_future_field: true };
    } else {
      assert.fail(`unexpected route ${route}`);
    }
    return new Response(
      JSON.stringify(
        rewrite ? rewrite(route, body, structuredClone(value)) : value,
      ),
      { status: 200 },
    );
  };
  const provider = createDropboxRelocationProvider(
    {
      credentials: {},
      refreshPath: "/synthetic",
      expectedAccountIdHash: accountHash,
    },
    {
      withAccessToken: async (_config, _path, use) =>
        await use("synthetic-token"),
      fetch,
    },
  );
  return { provider, moveBodies, folders };
}

test("uses stable IDs through a mixed-case root relocation workflow", async () => {
  const { provider, moveBodies } = syntheticProvider();
  let state;
  const artifact = {
    snapshotId: "1".repeat(64),
    objectName: "object-1",
    ciphertextSha256: "a".repeat(64),
    ciphertextByteLength: 1,
  };
  const workflow = new ArchiveRelocationWorkflow(
    {
      read: async () => state,
      write: async (next) => {
        state = structuredClone(next);
      },
    },
    provider,
    {
      requireQuiescent: async () => {},
      verifySourceInventory: async () => [artifact],
      verifyRelocatedInventory: async () => [artifact],
      rebindRootPath: async () => {},
      resumeUnchangedScan: async () => {},
    },
    () => 100,
  );
  await workflow.prepare({
    relocationId: "11111111-1111-8111-8111-111111111111",
    sourceId,
    sourceParentId: rootId,
    destinationParentId,
    destinationName: "backups",
    oldBoundary: { rootId: sourceId, rootPath: "/Kith Mind Backups" },
    newRootPath: "/Kith Mind/backups",
  });
  const complete = await workflow.resume();
  assert.equal(complete.phase, "resumed");
  assert.deepEqual(moveBodies, [
    {
      from_path: sourceId,
      to_path: `${destinationParentId}/backups`,
      autorename: false,
      allow_ownership_transfer: false,
    },
  ]);
});

test("rejects an account-bound root sentinel from another account", async () => {
  const { provider } = syntheticProvider();
  await assert.rejects(
    () => provider.getFolder(dropboxNamespaceRootId("b".repeat(64))),
    /folder identity is invalid/,
  );
});

test("rejects unsafe destination names and namespace-root destinations before moving", async () => {
  const { provider, moveBodies } = syntheticProvider();
  for (const destinationName of [".", "..", "../other", "backups "]) {
    await assert.rejects(() =>
      provider.moveFolder({
        sourceId,
        expectedSourceParentId: rootId,
        destinationParentId,
        destinationName,
      }),
    );
  }
  await assert.rejects(() =>
    provider.moveFolder({
      sourceId,
      expectedSourceParentId: rootId,
      destinationParentId: rootId,
      destinationName: "backups",
    }),
  );
  await assert.rejects(() => provider.getChild(rootId, "backups"));
  assert.equal(moveBodies.length, 0);
});

test("rejects substituted folder IDs and account mismatch before a move", async () => {
  for (const target of [sourceId, destinationParentId, "account"]) {
    const f = syntheticProvider({
      rewrite(route, body, value) {
        if (route === "get_metadata" && body.path === target)
          value.id = "id:substituted";
        if (route === "get_current_account" && target === "account")
          value.account_id = "dbid:other";
        return value;
      },
    });
    await assert.rejects(() =>
      f.provider.moveFolder({
        sourceId,
        expectedSourceParentId: rootId,
        destinationParentId,
        destinationName: "backups",
      }),
    );
    assert.equal(f.moveBodies.length, 0);
  }
});

test("detects case-insensitive Dropbox destination collisions", async () => {
  const f = syntheticProvider();
  f.folders.set(
    "id:existing",
    folder("id:existing", "Backups", "/Kith Mind/Backups"),
  );
  assert.equal(
    (await f.provider.getChild(destinationParentId, "backups")).id,
    "id:existing",
  );
  assert.equal(f.moveBodies.length, 0);
});
