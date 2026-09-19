// ADM-9: the terminal outcome of one watcher pass, from both sides.
//
// The watcher's side (`diagnostics.passOutcome`) and the screen's side
// (`readHealthFacts`). Against a real database, because every claim here is a
// claim about migration 029's columns and their CHECKs, and about the
// `space_id` / `source_account_id` predicates `src/workers/diagnostics.ts`
// carries.
//
// The isolation tests are the point of the file, as they are in
// `sourceRoots.test.mjs`. A worker credential is granted one source account in
// one space, and it must be unable to write the outcome of any other account
// or any other space -- by the account's own grant first, and again by the
// watcher row being selected only by the authorized account's id.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import { deriveHealthChecks, readHealthFacts } from "../dist/admin/index.js";
import {
  WorkerProtocolError,
  recordWorkerPassOutcome,
  workerCtx,
} from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-19T12:00:00Z");
const MINUTE = 60_000;
const PROTOCOL = { protocolVersion: 1 };

function expectProtocolCode(code) {
  return (error) =>
    error instanceof WorkerProtocolError && error.data.code === code;
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

/** An `active` watcher row, the shape a heartbeat leaves behind. */
async function makeWatcher(database, fields) {
  const seen = fields.lastSeenAt ?? NOW - MINUTE;
  await database.client.query(
    `INSERT INTO kith.worker_watcher_states
       (id, space_id, source_account_id, watcher_id, state, connector_version,
        actor_user_id, actor_credential_id, last_seen_at, next_expected_at,
        sweep_after, created_at, created_at_field, updated_at)
     VALUES ($1,$2,$3,$4,'active','1.0.0',$5,$6,
             to_timestamp($7/1000.0), to_timestamp($8/1000.0),
             to_timestamp($8/1000.0), transaction_timestamp(),
             to_timestamp($7/1000.0), to_timestamp($7/1000.0))`,
    [
      newKithId(),
      fields.spaceId,
      fields.sourceAccountId,
      fields.watcherId,
      fields.userId,
      fields.credentialId,
      seen,
      // `validateWatcher` recomputes this from `last_seen_at`, so the fixture
      // has to use the same 180s deadline the heartbeat writer does.
      seen + 180_000,
    ],
  );
}

const HOST = "0f1e2d3c-4b5a-4968-8776-655443322110";
const OTHER_HOST = "1f1e2d3c-4b5a-4968-8776-655443322111";

/**
 * Two spaces, each with its own source account and registered watcher, and one
 * worker credential granted exactly one of the three accounts.
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
  for (const [accountSpace, account] of [
    [spaceId, sourceAccountId],
    [spaceId, siblingAccountId],
    [otherSpaceId, otherAccountId],
  ]) {
    await makeWatcher(database, {
      spaceId: accountSpace,
      sourceAccountId: account,
      watcherId: HOST,
      userId,
      credentialId: credential.id,
    });
  }
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

function outcome(f, overrides = {}) {
  return {
    ...PROTOCOL,
    operation: "diagnostics.passOutcome",
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    watcherId: HOST,
    state: "incomplete",
    code: "root_contents_collapsed",
    scanned: 0,
    published: 0,
    finishedAt: NOW,
    ...overrides,
  };
}

async function storedOutcome(f, sourceAccountId = f.sourceAccountId) {
  const found = await f.client.query(
    `SELECT last_pass_state, last_pass_code, last_pass_scanned,
            last_pass_published, last_pass_finished_at,
            last_pass_unhealthy_streak
       FROM kith.worker_watcher_states WHERE source_account_id = $1`,
    [sourceAccountId],
  );
  return found.rows[0];
}

test("a refused pass reaches the server even though it opened no scan", { skip }, async (t) => {
  const f = await fixture(t);
  const written = await recordWorkerPassOutcome(
    workerCtx(f.client, NOW),
    f.worker,
    outcome(f),
  );
  assert.deepEqual(written, {
    operation: "diagnostics.passOutcome",
    sourceAccountId: f.sourceAccountId,
    watcherId: HOST,
    finishedAt: NOW,
    unhealthyPasses: 1,
  });
  const stored = await storedOutcome(f);
  assert.equal(stored.last_pass_state, "incomplete");
  assert.equal(stored.last_pass_code, "root_contents_collapsed");
  assert.equal(stored.last_pass_scanned, 0);
  assert.equal(stored.last_pass_published, 0);
  assert.equal(stored.last_pass_finished_at.getTime(), NOW);
  assert.equal(stored.last_pass_unhealthy_streak, 1);
});

test("the streak counts consecutive passes and a clean one clears it", { skip }, async (t) => {
  const f = await fixture(t);
  const send = (overrides) =>
    recordWorkerPassOutcome(workerCtx(f.client, NOW), f.worker, {
      ...outcome(f),
      ...overrides,
    });

  await send({ finishedAt: NOW, code: "items_need_attention" });
  const second = await send({
    finishedAt: NOW + MINUTE,
    code: "items_need_attention",
  });
  assert.equal(second.unhealthyPasses, 2);

  // An at-least-once delivery of a pass already recorded is not a second pass.
  const replayed = await send({
    finishedAt: NOW + MINUTE,
    code: "items_need_attention",
  });
  assert.equal(replayed.unhealthyPasses, 2);
  assert.equal(replayed.finishedAt, NOW + MINUTE);
  // Nor is a report that arrives after a newer one.
  const stale = await send({ finishedAt: NOW - MINUTE, state: "failed" });
  assert.equal(stale.unhealthyPasses, 2);
  assert.equal((await storedOutcome(f)).last_pass_state, "incomplete");

  const clean = await send({
    finishedAt: NOW + 2 * MINUTE,
    state: "complete",
    code: undefined,
    scanned: 12,
    published: 3,
  });
  assert.equal(clean.unhealthyPasses, 0);
  const stored = await storedOutcome(f);
  assert.equal(stored.last_pass_state, "complete");
  assert.equal(stored.last_pass_code, null);
  assert.equal(stored.last_pass_scanned, 12);
  assert.equal(stored.last_pass_unhealthy_streak, 0);
});

test("a worker key writes its own account's outcome and no other", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = workerCtx(f.client, NOW);

  // Another account in the same space, named on the credential's own envelope:
  // the account id is not a capability.
  await assert.rejects(
    recordWorkerPassOutcome(ctx, f.worker, {
      ...outcome(f),
      sourceAccountId: f.siblingAccountId,
    }),
    expectProtocolCode("not_authorized"),
  );
  // Another space's account, likewise -- and with that space's own id on the
  // envelope, which the credential is a member of.
  await assert.rejects(
    recordWorkerPassOutcome(ctx, f.worker, {
      ...outcome(f),
      spaceId: f.otherSpaceId,
      sourceAccountId: f.otherAccountId,
    }),
    expectProtocolCode("not_authorized"),
  );
  // The credential's own account under the wrong space id is not a way in.
  await assert.rejects(
    recordWorkerPassOutcome(ctx, f.worker, {
      ...outcome(f),
      spaceId: f.otherSpaceId,
    }),
    expectProtocolCode("not_found"),
  );
  // A web session is not a worker principal at all.
  await assert.rejects(
    recordWorkerPassOutcome(ctx, f.principal, outcome(f)),
    expectProtocolCode("not_authenticated"),
  );
  // A second host reporting on a registered watcher is an identity question.
  await assert.rejects(
    recordWorkerPassOutcome(ctx, f.worker, {
      ...outcome(f),
      watcherId: OTHER_HOST,
    }),
    expectProtocolCode("identity_review_required"),
  );

  for (const account of [
    f.sourceAccountId,
    f.siblingAccountId,
    f.otherAccountId,
  ]) {
    assert.equal(
      (await storedOutcome(f, account)).last_pass_state,
      null,
      "no refused report wrote a row",
    );
  }
});

test("an unregistered watcher is refused rather than invented", { skip }, async (t) => {
  const f = await fixture(t);
  await f.client.query(
    "DELETE FROM kith.worker_watcher_states WHERE source_account_id = $1",
    [f.sourceAccountId],
  );
  await assert.rejects(
    recordWorkerPassOutcome(workerCtx(f.client, NOW), f.worker, outcome(f)),
    expectProtocolCode("not_found"),
  );
  assert.equal(
    (
      await f.client.query(
        "SELECT count(*)::int AS n FROM kith.worker_watcher_states WHERE source_account_id = $1",
        [f.sourceAccountId],
      )
    ).rows[0].n,
    0,
  );
});

test("the health screen reads the refused pass and calls it a problem", { skip }, async (t) => {
  const f = await fixture(t);
  await recordWorkerPassOutcome(workerCtx(f.client, NOW), f.worker, outcome(f));

  const facts = await readHealthFacts(f.ctx(NOW), { principal: f.principal });
  const watcher = facts.watchers.find(
    (row) => row.sourceAccountId === f.sourceAccountId,
  );
  assert.equal(watcher.lastPassState, "incomplete");
  assert.equal(watcher.lastPassCode, "root_contents_collapsed");
  assert.equal(watcher.lastPassAt, NOW);
  assert.equal(watcher.unhealthyPasses, 1);

  // The heartbeat is current and there is no assessment at all, which is
  // exactly the state that read `ok` before ADM-9.
  const check = deriveHealthChecks(facts, NOW).find(
    (row) => row.id === "documents_watcher",
  );
  assert.equal(check.status, "problem");
  assert.equal(check.pass.code, "root_contents_collapsed");
  assert.match(check.detail, /stuck/);
});

test("the column refuses a code the wire would never send", { skip }, async (t) => {
  const f = await fixture(t);
  // The wire pattern is the first gate (`WORKER_PASS_CODE`); this is the one
  // under it, for a row that somehow bypassed it.
  for (const code of ["/Users/someone/Finance", "Statement.PDF", "a b"]) {
    await assert.rejects(
      f.client.query(
        `UPDATE kith.worker_watcher_states
            SET last_pass_state = 'failed', last_pass_code = $1
          WHERE source_account_id = $2`,
        [code, f.sourceAccountId],
      ),
      /last_pass_code/,
    );
  }
});
