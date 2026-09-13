import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  applyKithSchema,
  newKithId,
  records,
  withKithTransaction,
  workers,
} from "../dist/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

const NOW = 1_800_000_000_000;

async function setup(t) {
  const db = await throwawayDatabase(t);
  const client = await connect(db);
  await applyKithSchema(client);
  const pool = db.adopt(new pg.Pool({ connectionString: db.url, max: 4 }));
  const userId = newKithId();
  const spaceId = newKithId();
  const membershipId = newKithId();
  await client.query(
    "INSERT INTO kith.users(id,created_at,name) VALUES ($1,transaction_timestamp(),'Query user')",
    [userId],
  );
  await client.query(
    `INSERT INTO kith.spaces(id,created_at,kind,name,created_by)
     VALUES ($1,transaction_timestamp(),'personal','Query space',$2)`,
    [spaceId, userId],
  );
  await client.query(
    `INSERT INTO kith.space_members(id,space_id,created_at,user_id,role)
     VALUES ($1,$2,transaction_timestamp(),$3,'owner')`,
    [membershipId, spaceId, userId],
  );
  const binding = {
    spaceId,
    userId,
    membershipId,
    authorizationSignature: JSON.stringify({
      userId,
      membershipId,
      role: "owner",
    }),
    operation: "sum_money",
    consistency: "snapshot",
    normalizedFilter: JSON.stringify({ operation: "sum_money", spaceId }),
    sourceAccountIds: [newKithId(), newKithId()].sort(),
  };
  return { client, pool, binding };
}

const accumulator = {
  lastTuple: {
    occurrenceDate: "2026-09-13",
    occurrencePrecision: "datetime",
    occurrenceInstant: NOW - 1_000,
    sortKey: "synthetic-sort",
    stableId: "synthetic-stable",
  },
  totals: [{ currency: "USD", amount: "12.5" }],
  invalidRows: 1,
  ambiguousTimeRows: 2,
  unsupportedValueRows: 3,
  readOverflow: false,
  processedRows: 4,
};

test(
  "snapshot reservation and worker publication share one ordered clock",
  { skip },
  async (t) => {
    const { pool, binding } = await setup(t);
    let release;
    let reserved;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const snapshotStarted = new Promise((resolve) => {
      reserved = resolve;
    });
    let snapshot;
    let cursor;
    const query = withKithTransaction(pool, async (client) => {
      snapshot = await records.beginRecordQuerySnapshot(
        { client, now: NOW },
        binding,
      );
      cursor = await records.createRecordQuerySession(
        { client, now: NOW },
        binding,
        snapshot,
        accumulator,
      );
      reserved();
      await held;
    });
    await snapshotStarted;
    const publication = workers.withWorkerTransaction(
      pool,
      async (ctx) => {
        const activation = await workers.nextWorkerActivation(
          ctx,
          binding.spaceId,
        );
        await workers.recordWorkerActivation(ctx, binding.spaceId, activation);
        return activation;
      },
      NOW,
    );
    release();
    await query;
    const activation = await publication;
    assert.equal(activation.activatedAt, snapshot.snapshotAt + 1);
    assert.equal(activation.activationEpoch, 1);
    const resumed = await withKithTransaction(pool, (client) =>
      records.resolveRecordQueryContext(
        { client, now: NOW + 2 },
        binding,
        cursor,
      ),
    );
    assert.equal(resumed.session.snapshotAt, snapshot.snapshotAt);
  },
);

test(
  "cursor replacement is absolute-TTL, rollback-safe and single-consume under concurrency",
  { skip },
  async (t) => {
    const { client, pool, binding } = await setup(t);
    const created = await withKithTransaction(pool, async (tx) => {
      const context = await records.resolveRecordQueryContext(
        { client: tx, now: NOW },
        binding,
      );
      return records.createRecordQuerySession(
        { client: tx, now: NOW },
        binding,
        context.snapshot,
        accumulator,
      );
    });
    await assert.rejects(
      withKithTransaction(pool, async (tx) => {
        const context = await records.resolveRecordQueryContext(
          { client: tx, now: NOW + 1 },
          binding,
          created,
        );
        await records.advanceRecordQuerySession(
          { client: tx, now: NOW + 1 },
          binding,
          context.session.id,
          accumulator,
        );
        throw new Error("force rollback");
      }),
      /force rollback/,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM kith.record_query_sessions WHERE id=$1",
          [created],
        )
      ).rows[0].n,
      1,
    );

    let release;
    let locked;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const firstLocked = new Promise((resolve) => {
      locked = resolve;
    });
    let replacement;
    const first = withKithTransaction(pool, async (tx) => {
      const context = await records.resolveRecordQueryContext(
        { client: tx, now: NOW + 2 },
        binding,
        created,
      );
      locked();
      await held;
      replacement = await records.advanceRecordQuerySession(
        { client: tx, now: NOW + 2 },
        binding,
        context.session.id,
        {
          ...accumulator,
          totals: [{ currency: "USD", amount: "20" }],
          processedRows: 5,
        },
      );
    });
    await firstLocked;
    const replay = withKithTransaction(pool, async (tx) =>
      records.resolveRecordQueryContext(
        { client: tx, now: NOW + 3 },
        binding,
        created,
      ),
    );
    release();
    await first;
    await assert.rejects(replay, /cursor is invalid/);
    const row = (
      await client.query(
        "SELECT created_at_field,expires_at,totals FROM kith.record_query_sessions WHERE id=$1",
        [replacement],
      )
    ).rows[0];
    assert.equal(row.created_at_field.getTime(), NOW);
    assert.equal(
      row.expires_at.getTime(),
      NOW + records.RECORD_QUERY_SESSION_TTL_MS,
    );
    assert.deepEqual(row.totals, [{ currency: "USD", amount: "20" }]);
  },
);

test(
  "fresh caller scope, expiry, activation and visibility epochs invalidate cursors",
  { skip },
  async (t) => {
    const { pool, binding } = await setup(t);
    async function create(bound = binding, now = NOW) {
      return withKithTransaction(pool, async (tx) => {
        const context = await records.resolveRecordQueryContext(
          { client: tx, now },
          bound,
        );
        return records.createRecordQuerySession(
          { client: tx, now },
          bound,
          context.snapshot,
          accumulator,
        );
      });
    }
    const wrongScope = await create();
    for (const changed of [
      { ...binding, userId: newKithId() },
      { ...binding, credentialId: newKithId() },
      { ...binding, membershipId: newKithId() },
      { ...binding, authorizationSignature: "changed" },
      { ...binding, operation: "list_events" },
      { ...binding, consistency: "current" },
      { ...binding, normalizedFilter: "changed" },
      { ...binding, sourceAccountIds: [newKithId()] },
    ]) {
      await assert.rejects(
        withKithTransaction(pool, (tx) =>
          records.resolveRecordQueryContext(
            { client: tx, now: NOW + 1 },
            changed,
            wrongScope,
          ),
        ),
        /cursor is invalid/,
      );
    }
    const expired = await create();
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.resolveRecordQueryContext(
          { client: tx, now: NOW + records.RECORD_QUERY_SESSION_TTL_MS },
          binding,
          expired,
        ),
      ),
      /cursor is invalid/,
    );

    const currentBinding = { ...binding, consistency: "current" };
    const current = await create(currentBinding);
    await workers.withWorkerTransaction(
      pool,
      async (ctx) => {
        const activation = await workers.nextWorkerActivation(
          ctx,
          binding.spaceId,
        );
        await workers.recordWorkerActivation(ctx, binding.spaceId, activation);
      },
      NOW + 2,
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.resolveRecordQueryContext(
          { client: tx, now: NOW + 3 },
          currentBinding,
          current,
        ),
      ),
      /cursor is invalid/,
    );

    const snapshot = await create();
    await withKithTransaction(pool, (tx) =>
      records.resolveRecordQueryContext(
        { client: tx, now: NOW + 3 },
        binding,
        snapshot,
      ),
    );
    await withKithTransaction(pool, (tx) =>
      records.invalidateRecordQueriesForForget(
        { client: tx, now: NOW + 4 },
        binding,
      ),
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.resolveRecordQueryContext(
          { client: tx, now: NOW + 5 },
          binding,
          snapshot,
        ),
      ),
      /cursor is invalid/,
    );
    const purged = await withKithTransaction(pool, (tx) =>
      records.purgeRecordQuerySessionsForSpaceBatch(
        { client: tx, now: NOW + 5 },
        binding,
        2,
      ),
    );
    assert.equal(purged.deleted, 2);
    assert.equal(purged.done, false);
  },
);

test(
  "active limit, legacy duplicates and corrupt nullable rows are refused",
  { skip },
  async (t) => {
    const { client, pool, binding } = await setup(t);
    const cursors = [];
    for (
      let index = 0;
      index < records.MAX_ACTIVE_RECORD_QUERY_SESSIONS;
      index += 1
    ) {
      cursors.push(
        await withKithTransaction(pool, async (tx) => {
          const context = await records.resolveRecordQueryContext(
            { client: tx, now: NOW },
            binding,
          );
          return records.createRecordQuerySession(
            { client: tx, now: NOW },
            binding,
            context.snapshot,
            accumulator,
          );
        }),
      );
    }
    await assert.rejects(
      withKithTransaction(pool, async (tx) => {
        const context = await records.resolveRecordQueryContext(
          { client: tx, now: NOW },
          binding,
        );
        return records.createRecordQuerySession(
          { client: tx, now: NOW },
          binding,
          context.snapshot,
          accumulator,
        );
      }),
      /Too many active/,
    );
    await client.query(
      "UPDATE kith.record_query_sessions SET totals=NULL WHERE id=$1",
      [cursors[0]],
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.resolveRecordQueryContext(
          { client: tx, now: NOW + 1 },
          binding,
          cursors[0],
        ),
      ),
      /totals is corrupt/,
    );

    const valid = cursors[1];
    const forged = await withKithTransaction(pool, (tx) =>
      records.resolveRecordQueryContext(
        { client: tx, now: NOW + 1 },
        binding,
        valid,
      ),
    );
    await withKithTransaction(pool, (tx) =>
      records.invalidateRecordQueriesForForget(
        { client: tx, now: NOW + 2 },
        binding,
      ),
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.advanceRecordQuerySession(
          { client: tx, now: NOW + 3 },
          binding,
          forged.session.id,
          accumulator,
        ),
      ),
      /cursor is invalid/,
    );
    const expired = await withKithTransaction(pool, (tx) =>
      records.deleteExpiredRecordQuerySessions(
        {
          client: tx,
          now: NOW + records.RECORD_QUERY_SESSION_TTL_MS,
        },
        binding,
      ),
    );
    assert.equal(expired, records.MAX_ACTIVE_RECORD_QUERY_SESSIONS);
    await client.query(
      `INSERT INTO kith.record_query_space_state
     (id,space_id,created_at,visibility_epoch,snapshot_clock,updated_at)
     VALUES ($1,$2,transaction_timestamp(),0,$3,$4)`,
      [newKithId(), binding.spaceId, NOW, new Date(NOW)],
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.beginRecordQuerySnapshot({ client: tx, now: NOW }, binding),
      ),
      /Duplicate record query space state/,
    );
  },
);

test(
  "cursor tuple and accumulator values are canonical without losing pre-1970 instants",
  { skip },
  async (t) => {
    const { pool, binding } = await setup(t);
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.createRecordQuerySession(
          { client: tx, now: NOW },
          binding,
          { snapshotAt: NOW, activationEpoch: 0, visibilityEpoch: 0 },
          accumulator,
        ),
      ),
      /snapshot was not reserved/,
    );
    const snapshot = await withKithTransaction(pool, (tx) =>
      records.beginRecordQuerySnapshot({ client: tx, now: NOW }, binding),
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.createRecordQuerySession(
          { client: tx, now: NOW },
          binding,
          { ...snapshot, snapshotAt: snapshot.snapshotAt + 1 },
          accumulator,
        ),
      ),
      /snapshot is invalid/,
    );
    const create = (changed) =>
      withKithTransaction(pool, (tx) =>
        records.createRecordQuerySession(
          { client: tx, now: NOW },
          binding,
          snapshot,
          { ...accumulator, ...changed },
        ),
      );
    const preEpoch = await create({
      lastTuple: { ...accumulator.lastTuple, occurrenceInstant: -1 },
    });
    const roundTrip = await withKithTransaction(pool, (tx) =>
      records.resolveRecordQueryContext(
        { client: tx, now: NOW + 1 },
        binding,
        preEpoch,
      ),
    );
    assert.equal(roundTrip.session.lastTuple.occurrenceInstant, -1);
    for (const changed of [
      { lastTuple: { ...accumulator.lastTuple, occurrenceDate: "2026-02-30" } },
      { lastTuple: { ...accumulator.lastTuple, occurrenceInstant: undefined } },
      {
        lastTuple: {
          ...accumulator.lastTuple,
          occurrencePrecision: "date",
          occurrenceInstant: NOW,
        },
      },
      { totals: [{ currency: "USD", amount: "01.0" }] },
      {
        totals: [
          { currency: "USD", amount: "1" },
          { currency: "EUR", amount: "1" },
        ],
      },
      { invalidRows: -1 },
    ]) {
      await assert.rejects(create(changed));
    }
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.createRecordQuerySession(
          { client: tx, now: NOW },
          {
            ...binding,
            sourceAccountIds: Array.from({ length: 33 }, () =>
              newKithId(),
            ).sort(),
          },
          snapshot,
          accumulator,
        ),
      ),
      /sourceAccountIds/,
    );

    const foreignSpaceId = newKithId();
    const foreignMembershipId = newKithId();
    await withKithTransaction(pool, async (tx) => {
      await tx.query(
        `INSERT INTO kith.spaces(id,created_at,kind,name,created_by)
         VALUES ($1,transaction_timestamp(),'shared','Foreign query space',$2)`,
        [foreignSpaceId, binding.userId],
      );
      await tx.query(
        `INSERT INTO kith.space_members(id,space_id,created_at,user_id,role)
         VALUES ($1,$2,transaction_timestamp(),$3,'owner')`,
        [foreignMembershipId, foreignSpaceId, binding.userId],
      );
      await tx.query(
        `UPDATE kith.record_query_sessions
         SET space_id=$1,membership_id=$2,totals=NULL WHERE id=$3`,
        [foreignSpaceId, foreignMembershipId, preEpoch],
      );
    });
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.resolveRecordQueryContext(
          { client: tx, now: NOW + 2 },
          binding,
          preEpoch,
        ),
      ),
      /cursor is invalid; restart/,
    );
  },
);
