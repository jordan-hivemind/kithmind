// ADM-10: the watcher identity a heartbeat presents, and the way back from a
// refused one.
//
// The failure this covers, observed on the owner's own machine: the watcher id
// was derived from the worker's configuration fingerprint, so a parser path
// edit minted a new identity, `recordWorkerHeartbeat` answered
// `identity_review_required` before any write, and it kept answering it. The
// host completed a pass every five minutes for seventeen hours while the
// health screen read it as missing, and nothing in the product could clear the
// binding -- `resetWorkerWatcher` had no caller at all.
//
// Against a real database, because every claim here is a claim about the
// `worker_watcher_states` row, its `validateWatcher` invariants, and the
// `space_id` / `source_account_id` predicates `src/workers/diagnostics.ts`
// carries. The isolation tests are the point of the file: a worker credential
// must not be able to adopt, and an owner action must not be able to
// re-register, any watcher but the authorized account's own.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import {
  WATCHER_SPLIT_BRAIN_QUIET_MS,
  WorkerProtocolError,
  getWorkerDiagnosticsStatus,
  recordWorkerHeartbeat,
  reregisterWorkerWatcher,
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

const NOW = Date.parse("2026-09-19T12:00:00Z");
const MINUTE = 60_000;
const OVERDUE_MS = 180_000;
const PROTOCOL = { protocolVersion: 1 };

/** The id the ADM-10 derivation mints, the one the watcher now claims. */
const STABLE = "0f1e2d3c-4b5a-5968-8776-655443322110";
/** The id the old `v1` derivation minted, which the server may still hold. */
const LEGACY = "1f1e2d3c-4b5a-5968-8776-655443322111";
/** A third host entirely. */
const STRANGER = "2f1e2d3c-4b5a-5968-8776-655443322112";

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
    [
      id,
      fields.spaceId,
      `acct-${id}`,
      fields.name ?? "Provider folder",
      fields.userId,
    ],
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
      seen + OVERDUE_MS,
    ],
  );
}

/**
 * One owner, one editor and one reader over a space with a watched account; a
 * second space with its own account and watcher; and a worker credential
 * granted exactly one of the two accounts.
 */
async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const editorId = await makeUser(ctx, { name: "Editor" });
  const readerId = await makeUser(ctx, { name: "Reader" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  await makeMember(ctx, { spaceId, userId: editorId, role: "editor" });
  await makeMember(ctx, { spaceId, userId: readerId, role: "reader" });
  const otherSpaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const sourceAccountId = await makeFsAccount(database, { spaceId, userId });
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
    editorId,
    readerId,
    spaceId,
    otherSpaceId,
    sourceAccountId,
    otherAccountId,
    credentialId: credential.id,
    owner: { userId, credentialId: null },
    editor: { userId: editorId, credentialId: null },
    reader: { userId: readerId, credentialId: null },
    worker: { userId, credentialId: credential.id },
  };
}

function heartbeat(f, overrides = {}) {
  return {
    ...PROTOCOL,
    operation: "diagnostics.heartbeat",
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    watcherId: STABLE,
    connectorVersion: "fs-v1",
    ...overrides,
  };
}

async function storedWatcher(f, sourceAccountId = f.sourceAccountId) {
  const found = await f.client.query(
    `SELECT watcher_id, state, last_seen_at, heartbeat_nonce,
            heartbeat_nonce_previous, split_brain_at
       FROM kith.worker_watcher_states WHERE source_account_id = $1`,
    [sourceAccountId],
  );
  return found.rows[0];
}

/** 32 lowercase hex, the shape the wire and the column both require. */
const nonce = (seed) => seed.repeat(32).slice(0, 32);

test(
  "a watcher registered under its legacy id keeps its registration",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await makeWatcher(f, {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      watcherId: LEGACY,
      userId: f.userId,
      credentialId: f.credentialId,
    });

    // Without the legacy id this is exactly the refusal the owner has been
    // living with: the same host, a new derivation, and no way through.
    await assert.rejects(
      recordWorkerHeartbeat(workerCtx(f.client, NOW), f.worker, heartbeat(f)),
      expectProtocolCode("identity_review_required"),
    );
    assert.equal((await storedWatcher(f)).watcher_id, LEGACY);

    // Presenting both is the whole recovery. No owner action, no database edit.
    const accepted = await recordWorkerHeartbeat(
      workerCtx(f.client, NOW),
      f.worker,
      heartbeat(f, { legacyWatcherId: LEGACY }),
    );
    assert.deepEqual(accepted, {
      operation: "diagnostics.heartbeat",
      sourceAccountId: f.sourceAccountId,
      watcherId: STABLE,
      receivedAt: NOW,
      nextExpectedAt: NOW + OVERDUE_MS,
    });
    const stored = await storedWatcher(f);
    assert.equal(stored.watcher_id, STABLE, "the row is carried to the new id");
    assert.equal(stored.state, "active");

    // Once, not on every ping: the row now holds the new id, so the next
    // heartbeat is an ordinary matching one and the legacy id matches nothing.
    const again = await recordWorkerHeartbeat(
      workerCtx(f.client, NOW + 10_000),
      f.worker,
      heartbeat(f, { legacyWatcherId: LEGACY }),
    );
    assert.equal(again.receivedAt, NOW + 10_000);
    assert.equal((await storedWatcher(f)).watcher_id, STABLE);
  },
);

test(
  "a host presenting neither the registered nor the legacy id is still refused",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await makeWatcher(f, {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      watcherId: LEGACY,
      userId: f.userId,
      credentialId: f.credentialId,
    });
    // The protection the identity check exists for: a second host on this
    // credential cannot displace the registered one by heartbeating over it.
    await assert.rejects(
      recordWorkerHeartbeat(
        workerCtx(f.client, NOW),
        f.worker,
        heartbeat(f, { watcherId: STRANGER, legacyWatcherId: STABLE }),
      ),
      expectProtocolCode("identity_review_required"),
    );
    assert.equal((await storedWatcher(f)).watcher_id, LEGACY);
  },
);

test(
  "version skew in both directions leaves the registration alone",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await makeWatcher(f, {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      watcherId: STABLE,
      userId: f.userId,
      credentialId: f.credentialId,
    });
    // An old worker sends no `legacyWatcherId` at all. A new server must
    // handle its heartbeat exactly as before.
    const old = await recordWorkerHeartbeat(
      workerCtx(f.client, NOW),
      f.worker,
      heartbeat(f),
    );
    assert.equal(old.receivedAt, NOW);
    assert.equal((await storedWatcher(f)).watcher_id, STABLE);

    // The other direction -- a new worker's extra keys against an old server --
    // never reaches this function: that server's request parser refuses the
    // unknown key, and `WatchHeartbeat` drops both ADM-10 fields for the rest
    // of the process and retries at once, so the heartbeat survives the skew
    // instead of dying on it. Asserted in `@repo/worker-protocol`'s runtime
    // suite and in the pipeline's `diagnostics` suite.
    //
    // A pass is unaffected either way. `diagnostics.passOutcome` does carry a
    // `watcherId` (ADM-9) and would be refused alongside the heartbeat if the
    // registration were wrong, but neither it nor the heartbeat can fail a
    // pass: both are reported after the work is done and their refusals are
    // swallowed by design.
  },
);

test(
  "the owner re-registers a watcher and the next heartbeat claims it",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await makeWatcher(f, {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      watcherId: STRANGER,
      userId: f.userId,
      credentialId: f.credentialId,
    });
    const requestId = newKithId();
    const cleared = await reregisterWorkerWatcher(
      workerCtx(f.client, NOW),
      f.owner,
      { sourceAccountId: f.sourceAccountId, requestId },
    );
    assert.deepEqual(cleared, {
      sourceAccountId: f.sourceAccountId,
      clearedWatcherId: STRANGER,
      changedAt: NOW,
    });
    assert.equal(await storedWatcher(f), undefined, "the binding is cleared");
    assert.deepEqual(
      (
        await getWorkerDiagnosticsStatus(workerCtx(f.client, NOW), f.worker, {
          ...PROTOCOL,
          operation: "diagnostics.status",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
        })
      ).watcher,
      { state: "not_configured" },
    );

    // A retry of the same request while nothing has changed replays its
    // receipt instead of clearing a second time.
    const replayed = await reregisterWorkerWatcher(
      workerCtx(f.client, NOW + 500),
      f.owner,
      { sourceAccountId: f.sourceAccountId, requestId },
    );
    assert.deepEqual(replayed, {
      sourceAccountId: f.sourceAccountId,
      clearedWatcherId: STRANGER,
      changedAt: NOW,
    });

    // The window this opens is one heartbeat wide, and the first ping to
    // arrive is the host that is up.
    const claimed = await recordWorkerHeartbeat(
      workerCtx(f.client, NOW + 1_000),
      f.worker,
      heartbeat(f),
    );
    assert.equal(claimed.watcherId, STABLE);
    assert.equal((await storedWatcher(f)).watcher_id, STABLE);

    // Replaying that same request *after* the window closed is a conflict, not
    // a second clear: the receipt records the state it was written against,
    // and a retry arriving late must not undo the registration the heartbeat
    // just made.
    await assert.rejects(
      reregisterWorkerWatcher(workerCtx(f.client, NOW + 2_000), f.owner, {
        sourceAccountId: f.sourceAccountId,
        requestId,
      }),
      expectProtocolCode("request_conflict"),
    );
    assert.equal((await storedWatcher(f)).watcher_id, STABLE);
  },
);

test(
  "re-registration is the owner's and nobody else's",
  { skip },
  async (t) => {
    const f = await fixture(t);
    for (const [name, account] of [
      ["own space", f.sourceAccountId],
      ["other space", f.otherAccountId],
    ]) {
      await makeWatcher(f, {
        spaceId: name === "own space" ? f.spaceId : f.otherSpaceId,
        sourceAccountId: account,
        watcherId: STRANGER,
        userId: f.userId,
        credentialId: f.credentialId,
      });
    }

    // An editor holds `write` on the space and is still refused, and a reader
    // and a stranger get the identical answer -- nothing about the denial says
    // whether the account exists.
    for (const [who, principal] of [
      ["editor", f.editor],
      ["reader", f.reader],
      // A worker credential cannot reach this at all: it is the owner action
      // the protocol reserves, and a key's principal is not a space member.
      ["worker key", f.worker],
    ]) {
      await assert.rejects(
        reregisterWorkerWatcher(workerCtx(f.client, NOW), principal, {
          sourceAccountId: f.sourceAccountId,
          requestId: newKithId(),
        }),
        /Source account not found/,
        who,
      );
      assert.equal((await storedWatcher(f)).watcher_id, STRANGER, who);
    }

    // An account that does not exist is the same refusal as one in a space the
    // caller cannot reach, so neither can be enumerated from the other.
    await assert.rejects(
      reregisterWorkerWatcher(workerCtx(f.client, NOW), f.editor, {
        sourceAccountId: newKithId(),
        requestId: newKithId(),
      }),
      /Source account not found/,
    );
  },
);

test(
  "an adoption cannot cross a source account or a space",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await makeWatcher(f, {
      spaceId: f.otherSpaceId,
      sourceAccountId: f.otherAccountId,
      watcherId: LEGACY,
      userId: f.userId,
      credentialId: f.credentialId,
    });
    // The credential holds `ingest` on both spaces but is granted only
    // `sourceAccountId`. Naming the other account -- with the right space id,
    // and with the legacy id that account's row actually holds -- must not
    // adopt it.
    await assert.rejects(
      recordWorkerHeartbeat(
        workerCtx(f.client, NOW),
        f.worker,
        heartbeat(f, {
          spaceId: f.otherSpaceId,
          sourceAccountId: f.otherAccountId,
          legacyWatcherId: LEGACY,
        }),
      ),
      (error) => error instanceof WorkerProtocolError,
    );
    assert.equal(
      (await storedWatcher(f, f.otherAccountId)).watcher_id,
      LEGACY,
      "the other space's watcher is untouched",
    );

    // And the mirror: this account's id under the other space's id, which the
    // account does not belong to.
    await assert.rejects(
      recordWorkerHeartbeat(
        workerCtx(f.client, NOW),
        f.worker,
        heartbeat(f, { spaceId: f.otherSpaceId }),
      ),
      (error) => error instanceof WorkerProtocolError,
    );
  },
);

// ADM-10 review, finding 1. Two live hosts on one copied journal.
//
// Removing `configFingerprint` from the identity was right and it removed an
// accidental tripwire with it: two hosts used to disagree about their roots'
// absolute paths and register as two watchers. They are now the same watcher
// by design, which is what makes a host move work, and nothing else on the
// heartbeat separates them. The owner is about to copy a journal from his
// laptop to an always-on host, and the journal lock is a loopback port.

test(
  "two live hosts on one journal are found, and a restart is not",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const ping = (nonceValue, now) =>
      recordWorkerHeartbeat(
        workerCtx(f.client, now),
        f.worker,
        heartbeat(f, { heartbeatNonce: nonceValue }),
      );
    const A = nonce("a");
    const B = nonce("b");
    const C = nonce("c");

    // One host, pinging steadily: nothing to report.
    await ping(A, NOW);
    await ping(A, NOW + 30_000);
    let stored = await storedWatcher(f);
    assert.equal(stored.heartbeat_nonce, A);
    assert.equal(stored.heartbeat_nonce_previous, null);
    assert.equal(stored.split_brain_at, null);

    // An ordinary restart: a new process, a nonce never seen before. This is
    // the case a count of changes inside a window would have flagged.
    await ping(B, NOW + 60_000);
    stored = await storedWatcher(f);
    assert.equal(stored.heartbeat_nonce, B);
    assert.equal(stored.heartbeat_nonce_previous, A);
    assert.equal(stored.split_brain_at, null, "a restart is not a split brain");

    // A nonce coming *back* after a different one: the only way that happens
    // is a process that already heartbeated heartbeating again, which is two
    // live processes.
    await ping(A, NOW + 75_000);
    stored = await storedWatcher(f);
    assert.equal(
      stored.split_brain_at.getTime(),
      NOW + 75_000,
      "an alternating pair is caught on its third ping",
    );

    // It keeps re-proving itself while both hosts are up, rather than settling
    // into a state that reads as resolved.
    await ping(B, NOW + 90_000);
    assert.equal(
      (await storedWatcher(f)).split_brain_at.getTime(),
      NOW + 90_000,
    );

    // And heartbeats are still accepted throughout. Refusing one of the two
    // would put the watcher straight back into the state ADM-10 removes, and
    // would hide the second host rather than name it.
    const accepted = await ping(B, NOW + 120_000);
    assert.equal(accepted.receivedAt, NOW + 120_000);
    assert.equal((await storedWatcher(f)).state, "active");
  },
);

test(
  "a crash loop is never mistaken for a second host",
  { skip },
  async (t) => {
    const f = await fixture(t);
    // Four processes in a row, each with a fresh nonce and none returning.
    let now = NOW;
    for (const seed of ["a", "b", "c", "d", "e"]) {
      await recordWorkerHeartbeat(
        workerCtx(f.client, now),
        f.worker,
        heartbeat(f, { heartbeatNonce: nonce(seed) }),
      );
      now += 30_000;
    }
    assert.equal(
      (await storedWatcher(f)).split_brain_at,
      null,
      "restarting repeatedly is a different problem, and not this one",
    );
  },
);

test(
  "stopping the second host clears the split brain on its own",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const A = nonce("a");
    const B = nonce("b");
    const ping = (nonceValue, now) =>
      recordWorkerHeartbeat(
        workerCtx(f.client, now),
        f.worker,
        heartbeat(f, { heartbeatNonce: nonceValue }),
      );
    await ping(A, NOW);
    await ping(B, NOW + 30_000);
    await ping(A, NOW + 60_000);
    const detectedAt = NOW + 60_000;
    assert.equal(
      (await storedWatcher(f)).split_brain_at.getTime(),
      detectedAt,
    );

    // Host B is stopped. A keeps pinging alone; just short of the quiet
    // window the screen still says so. One heartbeat interval short, not one
    // second: two pings a second apart are damped by
    // WORKER_HEARTBEAT_MIN_WRITE_MS, so the second would not write at all and
    // the clear below would be attributed to the wrong thing.
    await ping(A, detectedAt + WATCHER_SPLIT_BRAIN_QUIET_MS - 30_000);
    assert.notEqual((await storedWatcher(f)).split_brain_at, null);

    // Past it, one process has held the heartbeat alone for twenty pings and
    // the owner does not have to click anything.
    await ping(A, detectedAt + WATCHER_SPLIT_BRAIN_QUIET_MS);
    assert.equal((await storedWatcher(f)).split_brain_at, null);
  },
);

test(
  "the write damping never hides a second host",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const A = nonce("a");
    const B = nonce("b");
    await recordWorkerHeartbeat(
      workerCtx(f.client, NOW),
      f.worker,
      heartbeat(f, { heartbeatNonce: A }),
    );
    // Inside WORKER_HEARTBEAT_MIN_WRITE_MS. The same process is damped, as it
    // has always been -- this is the write budget the heartbeat is held to.
    await recordWorkerHeartbeat(
      workerCtx(f.client, NOW + 1_000),
      f.worker,
      heartbeat(f, { heartbeatNonce: A }),
    );
    assert.equal((await storedWatcher(f)).last_seen_at.getTime(), NOW);

    // A different process inside the same window is not damped: two hosts that
    // happen to land within five seconds of each other would otherwise never
    // have their nonces recorded, and the damping would hide exactly what it
    // is being asked to notice.
    await recordWorkerHeartbeat(
      workerCtx(f.client, NOW + 2_000),
      f.worker,
      heartbeat(f, { heartbeatNonce: B }),
    );
    const stored = await storedWatcher(f);
    assert.equal(stored.heartbeat_nonce, B);
    assert.equal(stored.heartbeat_nonce_previous, A);
  },
);

test(
  "a worker too old to send a nonce changes nothing it does not know about",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const A = nonce("a");
    const B = nonce("b");
    const ping = (nonceValue, now) =>
      recordWorkerHeartbeat(
        workerCtx(f.client, now),
        f.worker,
        heartbeat(f, { heartbeatNonce: nonceValue }),
      );
    await ping(A, NOW);
    await ping(B, NOW + 30_000);
    await ping(A, NOW + 60_000);
    const detectedAt = NOW + 60_000;

    // An ADM-9 worker, or one that downgraded against an old server, sends no
    // nonce. That is not evidence the second host went away, so the record
    // stands rather than being nulled by a client that cannot speak to it.
    const old = await recordWorkerHeartbeat(
      workerCtx(f.client, NOW + 90_000),
      f.worker,
      heartbeat(f),
    );
    assert.equal(old.receivedAt, NOW + 90_000);
    const stored = await storedWatcher(f);
    assert.equal(stored.heartbeat_nonce, A);
    assert.equal(stored.heartbeat_nonce_previous, B);
    assert.equal(stored.split_brain_at.getTime(), detectedAt);
  },
);
