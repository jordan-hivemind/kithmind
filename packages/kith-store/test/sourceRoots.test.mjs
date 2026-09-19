// ADM-4b: the watched-folder list, from both sides.
//
// The owner's side (`upsertSourceRoot`, `setSourceRootState`,
// `deleteSourceRoot`, `listSourceRoots`) and the watcher's side
// (`source.roots`, `source.rootReport`). Against a real database, because
// every claim here is a claim about migration 028's columns, its unique index
// and the composite foreign keys that make a cross-space row unrepresentable.
//
// The isolation tests are the point of the file. A worker credential is
// granted one source account in one space, and the two operations must be
// unable to read or write a root of any other account or space -- by the
// account's own grant, and again by the `space_id` and `source_account_id`
// predicates every statement in `src/workers/sourceRoots.ts` carries.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import {
  assertSourceRootLocation,
  deleteSourceRoot,
  listSourceRoots,
  listSourcesInventory,
  setSourceRootState,
  upsertSourceRoot,
} from "../dist/admin/index.js";
import {
  WorkerProtocolError,
  getWorkerSourceRoots,
  recordWorkerSourceRootReport,
  workerCtx,
} from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeMember,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const PROTOCOL = { protocolVersion: 1 };

function expectProtocolCode(code) {
  return (error) =>
    error instanceof WorkerProtocolError && error.data.code === code;
}

/**
 * Rows by path, so an assertion is about the set and not about the order.
 *
 * `upsertSourceRoot` stamps every row with the caller's clock, so two roots
 * written in one test share a `created_at` and fall back to their ids, which
 * are random. The order a reader sees is therefore stable per database and
 * arbitrary across them, and a test that asserted it would be asserting the
 * shape of an id.
 */
function byPath(rows, read) {
  return rows.map(read).sort((left, right) => (left[1] < right[1] ? -1 : 1));
}

async function makeFsAccount(database, fields) {
  const id = newKithId();
  await database.client.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, created_by)
     VALUES ($1,$2,transaction_timestamp(),'fs',$3,$4,true,0,60000,$5)`,
    [id, fields.spaceId, `acct-${id}`, fields.name ?? "Provider folder", fields.userId],
  );
  return id;
}

/**
 * Two spaces, each with its own owner, source account and worker credential.
 *
 * The second space's owner is also a member of the first, so a failure below
 * is about the *credential's* grant rather than about the user simply not
 * being in the space: the harder of the two cases to get right.
 */
async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const otherSpaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const sourceAccountId = await makeFsAccount(database, { spaceId, userId });
  const siblingAccountId = await makeFsAccount(database, {
    spaceId,
    userId,
    name: "Second folder",
  });
  const otherAccountId = await makeFsAccount(database, {
    spaceId: otherSpaceId,
    userId,
    name: "Other space folder",
  });
  const credential = await makeApiKey(ctx, {
    userId,
    capabilities: ["ingest"],
    spaceIds: [spaceId, otherSpaceId],
    sourceAccountIds: [sourceAccountId],
  });
  return {
    ...database,
    userId,
    spaceId,
    otherSpaceId,
    sourceAccountId,
    siblingAccountId,
    otherAccountId,
    principal: { userId, credentialId: null },
    worker: { userId, credentialId: credential.id },
  };
}

test("a relative path may not escape the host root", { skip: false }, () => {
  assert.deepEqual(assertSourceRootLocation("dropbox", "Finance/Investing"), {
    rootAlias: "dropbox",
    relativePath: "Finance/Investing",
  });
  for (const [alias, path] of [
    ["dropbox", "/Users/someone/Finance"],
    ["dropbox", "../secrets"],
    ["dropbox", "Finance/../../secrets"],
    ["dropbox", "Finance/./here"],
    ["dropbox", "Finance//Investing"],
    ["dropbox", "Finance/"],
    ["dropbox", ""],
    ["dropbox", "Finance\\Investing"],
    ["dropbox", "Finance/In\u0000vesting"],
    ["dropbox", "Finance/In\nvesting"],
    ["dropbox", "x".repeat(1025)],
    ["Dropbox", "Finance"],
    ["-dropbox", "Finance"],
    ["drop box", "Finance"],
    ["", "Finance"],
  ]) {
    assert.throws(
      () => assertSourceRootLocation(alias, path),
      /Root alias|Path/,
      `${alias} ${JSON.stringify(path)} should be refused`,
    );
  }
});

test("an owner adds, pauses and removes a folder", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const first = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    rootAlias: "dropbox",
    relativePath: "Finance/Investing",
    area: "outside investments",
  });
  const second = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    rootAlias: "dropbox",
    relativePath: "Finance/Statements",
  });
  assert.notEqual(first, second, "one account may hold several roots");

  // The same location again is the same row, not a second one.
  assert.equal(
    await upsertSourceRoot(ctx, {
      principal: f.principal,
      sourceAccountId: f.sourceAccountId,
      kind: "folder",
      rootAlias: "dropbox",
      relativePath: "Finance/Investing",
      area: "taxes",
    }),
    first,
  );

  await setSourceRootState(ctx, {
    principal: f.principal,
    sourceRootId: second,
    state: "paused",
  });
  const roots = await listSourceRoots(ctx, { principal: f.principal });
  assert.deepEqual(
    byPath(roots, (root) => [
      root.id,
      root.relativePath,
      root.rootAlias,
      root.state,
    ]),
    [
      [first, "Finance/Investing", "dropbox", "active"],
      [second, "Finance/Statements", "dropbox", "paused"],
    ],
  );
  assert.equal(
    roots.find((root) => root.id === first).area,
    "taxes",
    "the second upsert of the same location edited the first row",
  );

  // The account still reads as one row on the sources screen, not one per
  // folder.
  const inventory = await listSourcesInventory(ctx, { principal: f.principal });
  assert.equal(
    inventory.filter((row) => row.id === f.sourceAccountId).length,
    1,
  );

  await deleteSourceRoot(ctx, {
    principal: f.principal,
    sourceRootId: second,
  });
  assert.deepEqual(
    (await listSourceRoots(ctx, { principal: f.principal })).map(
      (root) => root.id,
    ),
    [first],
  );
});

test("a path that escapes the host root is never stored", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await assert.rejects(
    upsertSourceRoot(ctx, {
      principal: f.principal,
      sourceAccountId: f.sourceAccountId,
      kind: "folder",
      rootAlias: "dropbox",
      relativePath: "../../etc",
    }),
    /Path/,
  );
  assert.deepEqual(await listSourceRoots(ctx, { principal: f.principal }), []);
});

test("a reader may neither list nor change a root", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const rootId = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    rootAlias: "dropbox",
    relativePath: "Finance",
  });
  const readerId = await makeUser(ctx, { name: "Reader" });
  await makeMember(ctx, {
    spaceId: f.spaceId,
    userId: readerId,
    role: "reader",
  });
  const reader = { userId: readerId, credentialId: null };
  assert.deepEqual(await listSourceRoots(ctx, { principal: reader }), []);
  await assert.rejects(
    setSourceRootState(ctx, {
      principal: reader,
      sourceRootId: rootId,
      state: "paused",
    }),
    /Source root not found/,
  );
  await assert.rejects(
    deleteSourceRoot(ctx, { principal: reader, sourceRootId: rootId }),
    /Source root not found/,
  );
});

test("removing a root leaves the documents alone", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const rootId = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    rootAlias: "dropbox",
    relativePath: "Finance",
  });
  const itemId = newKithId();
  await f.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id)
     VALUES ($1,$2,transaction_timestamp(),$3,$4)`,
    [itemId, f.spaceId, f.sourceAccountId, `ext-${itemId}`],
  );
  await deleteSourceRoot(ctx, { principal: f.principal, sourceRootId: rootId });
  assert.equal(
    (await f.client.query("SELECT count(*)::int AS n FROM kith.source_items"))
      .rows[0].n,
    1,
  );
});

test("a worker reads only its own account's roots", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const mine = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    rootAlias: "dropbox",
    relativePath: "Finance/Investing",
    area: "outside investments",
  });
  const paused = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    rootAlias: "dropbox",
    relativePath: "Finance/Paused",
    state: "paused",
  });
  await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    rootAlias: "dropbox",
    relativePath: "Finance/Retired",
    state: "retired",
  });
  // A sibling account in the same space, and an account in another space.
  // Neither is the credential's.
  for (const [accountId, alias] of [
    [f.siblingAccountId, "sibling"],
    [f.otherAccountId, "elsewhere"],
  ]) {
    await upsertSourceRoot(ctx, {
      principal: f.principal,
      sourceAccountId: accountId,
      kind: "folder",
      rootAlias: alias,
      relativePath: "Finance",
    });
  }

  const worker = workerCtx(f.client, NOW);
  const result = await getWorkerSourceRoots(worker, f.worker, {
    ...PROTOCOL,
    operation: "source.roots",
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  });
  assert.deepEqual(
    byPath(result.roots, (root) => [
      root.sourceRootId,
      root.relativePath,
      root.state,
    ]),
    [
      [mine, "Finance/Investing", "active"],
      [paused, "Finance/Paused", "paused"],
    ],
    "retired roots are omitted and no other account's root appears",
  );
  assert.equal(
    result.roots.find((root) => root.sourceRootId === mine).area,
    "outside investments",
  );

  // The sibling account, which this credential has no grant for.
  await assert.rejects(
    getWorkerSourceRoots(worker, f.worker, {
      ...PROTOCOL,
      operation: "source.roots",
      spaceId: f.spaceId,
      sourceAccountId: f.siblingAccountId,
    }),
    expectProtocolCode("not_authorized"),
  );
  // The other space's account, which it has no grant for either, even though
  // the credential is scoped to that space.
  await assert.rejects(
    getWorkerSourceRoots(worker, f.worker, {
      ...PROTOCOL,
      operation: "source.roots",
      spaceId: f.otherSpaceId,
      sourceAccountId: f.otherAccountId,
    }),
    expectProtocolCode("not_authorized"),
  );
  // Its own account named under the wrong space.
  await assert.rejects(
    getWorkerSourceRoots(worker, f.worker, {
      ...PROTOCOL,
      operation: "source.roots",
      spaceId: f.otherSpaceId,
      sourceAccountId: f.sourceAccountId,
    }),
    expectProtocolCode("not_found"),
  );
});

test("a worker reports only on its own account's roots", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const mine = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    rootAlias: "dropbox",
    relativePath: "Finance",
  });
  const sibling = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.siblingAccountId,
    kind: "folder",
    rootAlias: "sibling",
    relativePath: "Finance",
  });
  const elsewhere = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.otherAccountId,
    kind: "folder",
    rootAlias: "elsewhere",
    relativePath: "Finance",
  });

  const worker = workerCtx(f.client, NOW);
  const report = (sourceRootId, overrides = {}) => ({
    ...PROTOCOL,
    operation: "source.rootReport",
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    sourceRootId,
    observedAt: NOW,
    itemCount: 7,
    state: "ok",
    ...overrides,
  });

  const written = await recordWorkerSourceRootReport(
    worker,
    f.worker,
    report(mine, { providerFolderId: "provider-9" }),
  );
  assert.equal(written.sourceRootId, mine);
  // The provider id is written back onto the root: section 6's self-repair
  // keys the folder by the provider's id rather than by its path.
  assert.equal(
    (
      await f.client.query(
        "SELECT provider_folder_id FROM kith.source_roots WHERE id = $1",
        [mine],
      )
    ).rows[0].provider_folder_id,
    "provider-9",
  );

  // A retry of the same pass replaces its row rather than adding one.
  const retried = await recordWorkerSourceRootReport(
    worker,
    f.worker,
    report(mine, { itemCount: 9, state: "unreadable" }),
  );
  assert.equal(retried.reportId, written.reportId);
  const stored = await f.client.query(
    "SELECT item_count, state FROM kith.source_root_reports WHERE source_root_id = $1",
    [mine],
  );
  assert.deepEqual(
    stored.rows.map((row) => [row.item_count, row.state]),
    [[9, "unreadable"]],
  );

  // Another account's root in the same space, named on this credential's own
  // envelope: the id is not a capability.
  await assert.rejects(
    recordWorkerSourceRootReport(worker, f.worker, report(sibling)),
    expectProtocolCode("not_found"),
  );
  // Another space's root, likewise.
  await assert.rejects(
    recordWorkerSourceRootReport(worker, f.worker, report(elsewhere)),
    expectProtocolCode("not_found"),
  );
  // And a root that does not exist reads the same as both of those.
  await assert.rejects(
    recordWorkerSourceRootReport(worker, f.worker, report(newKithId())),
    expectProtocolCode("not_found"),
  );
  assert.equal(
    (
      await f.client.query(
        "SELECT count(*)::int AS n FROM kith.source_root_reports",
      )
    ).rows[0].n,
    1,
    "no refused report wrote a row",
  );
});

test("a watcher's state reaches the sources screen", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const rootId = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    rootAlias: "dropbox",
    relativePath: "Finance",
  });
  await recordWorkerSourceRootReport(workerCtx(f.client, NOW), f.worker, {
    ...PROTOCOL,
    operation: "source.rootReport",
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    sourceRootId: rootId,
    observedAt: NOW,
    itemCount: 3,
    state: "missing",
  });
  const [root] = await listSourceRoots(ctx, { principal: f.principal });
  assert.deepEqual(
    [root.reportState, root.reportItemCount, root.reportedAt],
    ["missing", 3, NOW],
  );
  const source = (
    await listSourcesInventory(ctx, {
      principal: f.principal,
      spaceIds: [f.spaceId],
    })
  ).find((row) => row.id === f.sourceAccountId);
  assert.equal(source.status, "problem");
  assert.equal(source.problem, "missing");
});
