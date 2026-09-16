// The port of `packages/convex/convex/models/sourceAccounts/public.ts` against
// a real migrated schema: create, update and list for the settings page, plus
// the authorization half `authorization.test.ts` covers through
// `requireSourceAccountAccess`.
//
// docs/plans/2026-09-16-web-mcp-postgres-surface.md section 1.5 ("Source
// account create, update, list for the owner UI") and question 1 of section 8
// ("Add the row").
//
// The block below "P2-39i0 follow-up: the enabled-change side effects" covers
// the two Convex side effects the i0 port above left out --
// `advanceSourceAssessmentEpoch` (models/ingestion/model.ts) and
// `onSourceEnabledChanged` (models/diagnostics/model.ts) -- exercised through
// `updateSourceAccount` exactly as the settings page calls it, against
// `kith.worker_watcher_states` and `kith.worker_operational_incidents` rows
// built by hand rather than through the worker protocol's signed requests,
// which is what `../src/workers/diagnostics.ts`'s own suite already exercises.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createSourceAccount,
  listSourceAccounts,
  updateSourceAccount,
} from "../dist/sources/index.js";
import { webPrincipal } from "../dist/identity/index.js";
import { newKithId } from "../dist/index.js";
import { WORKER_HEARTBEAT_OVERDUE_MS } from "../dist/workers/index.js";
import {
  identityDatabase,
  makeMember,
  makeSpace,
  makeUser,
  refusal,
  refusalCode,
  skip,
} from "./helpers/identityFixture.mjs";

const SOURCE_ACCOUNT_NOT_FOUND = "Source account not found";

/** An `active` watcher row, matching `validateWatcher`'s shape for it. */
async function makeActiveWatcher(ctx, fields) {
  const id = newKithId();
  const lastSeenAt = fields.lastSeenAt ?? ctx.now;
  const nextExpectedAt = lastSeenAt + WORKER_HEARTBEAT_OVERDUE_MS;
  await ctx.client.query(
    `INSERT INTO kith.worker_watcher_states
       (id, space_id, source_account_id, watcher_id, state, connector_version,
        actor_user_id, actor_credential_id, last_seen_at, next_expected_at,
        sweep_after, created_at_field, updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,$11)`,
    [
      id,
      fields.spaceId,
      fields.sourceAccountId,
      fields.watcherId,
      fields.connectorVersion ?? "1.0.0",
      fields.actorUserId,
      fields.actorCredentialId ?? newKithId(),
      new Date(lastSeenAt),
      new Date(nextExpectedAt),
      fields.sweepAfter === undefined ? null : new Date(fields.sweepAfter),
      new Date(fields.now ?? ctx.now),
    ],
  );
  return id;
}

/** An open `missing_worker` incident row for a watcher. */
async function makeOpenIncident(ctx, fields) {
  const id = newKithId();
  const openedAt = fields.openedAt ?? ctx.now;
  await ctx.client.query(
    `INSERT INTO kith.worker_operational_incidents
       (id, space_id, source_account_id, watcher_id, kind, state, opened_at, observed_at)
     VALUES ($1,$2,$3,$4,'missing_worker','open',$5,$5)`,
    [
      id,
      fields.spaceId,
      fields.sourceAccountId,
      fields.watcherId,
      new Date(openedAt),
    ],
  );
  return id;
}

async function getWatcher(ctx, sourceAccountId) {
  const result = await ctx.client.query(
    "SELECT * FROM kith.worker_watcher_states WHERE source_account_id = $1",
    [sourceAccountId],
  );
  return result.rows[0] ?? null;
}

async function getIncidents(ctx, sourceAccountId) {
  const result = await ctx.client.query(
    "SELECT * FROM kith.worker_operational_incidents WHERE source_account_id = $1 ORDER BY opened_at",
    [sourceAccountId],
  );
  return result.rows;
}

async function getEpoch(ctx, sourceAccountId) {
  const result = await ctx.client.query(
    "SELECT worker_assessment_epoch FROM kith.source_accounts WHERE id = $1",
    [sourceAccountId],
  );
  const value = result.rows[0]?.worker_assessment_epoch;
  return value === null || value === undefined ? null : Number(value);
}

test(
  "create then list returns the row with the Convex fields, default freshness included",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      const principal = webPrincipal(userId);

      const id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "owner@gmail.example",
        name: "Owner inbox",
      });
      assert.equal(typeof id, "string");

      const listed = await listSourceAccounts(ctx, { principal });
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0], {
        id,
        spaceId,
        name: "Owner inbox",
        connector: "gmail",
        accountId: "owner@gmail.example",
        // Convex's default: `args.freshnessMs ?? 86_400_000`.
        freshnessMs: 86_400_000,
        enabled: true,
      });

      // An explicit freshness is kept as given.
      const secondId = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "second@gmail.example",
        name: "Second inbox",
        freshnessMs: 3_600_000,
      });
      const second = (await listSourceAccounts(ctx, { principal })).find(
        (row) => row.id === secondId,
      );
      assert.equal(second.freshnessMs, 3_600_000);

      // The same (space, connector, account) triple twice is refused, not
      // silently accepted as a second row -- Convex's `source_account_exists`.
      assert.equal(
        await refusalCode(() =>
          createSourceAccount(ctx, {
            principal,
            spaceId,
            connector: "gmail",
            accountId: "owner@gmail.example",
            name: "Duplicate",
          }),
        ),
        "source_account_exists",
      );
    });
  },
);

test(
  "update changes only the permitted fields, and a cross-space update is refused",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const ownerId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: ownerId, role: "owner" });
      const principal = webPrincipal(ownerId);

      const id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "drive",
        accountId: "owner-drive",
        name: "Original name",
        freshnessMs: 7_200_000,
      });

      // Only `name` is given: `freshnessMs`, `connector`, `accountId` and
      // `enabled` are untouched.
      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        name: "Renamed",
      });
      let row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.name, "Renamed");
      assert.equal(row.freshnessMs, 7_200_000);
      assert.equal(row.connector, "drive");
      assert.equal(row.accountId, "owner-drive");
      assert.equal(row.enabled, true);

      // Only `enabled` is given this time: name and freshness stay put.
      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        enabled: false,
      });
      row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.enabled, false);
      assert.equal(row.name, "Renamed");
      assert.equal(row.freshnessMs, 7_200_000);

      // Only `freshnessMs` is given: name and enabled stay put.
      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        freshnessMs: 120_000,
      });
      row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.freshnessMs, 120_000);
      assert.equal(row.name, "Renamed");
      assert.equal(row.enabled, false);

      // A stranger with no membership in the space at all.
      const strangerId = await makeUser(ctx, { email: "stranger@example.test" });
      assert.equal(
        await refusal(() =>
          updateSourceAccount(ctx, {
            principal: webPrincipal(strangerId),
            sourceAccountId: id,
            name: "Hijacked",
          }),
        ),
        SOURCE_ACCOUNT_NOT_FOUND,
      );

      // A member whose role cannot write (reader) is refused the same words:
      // read access to the space does not carry write access to its sources.
      const readerId = await makeUser(ctx, { email: "reader@example.test" });
      await makeMember(ctx, { spaceId, userId: readerId, role: "reader" });
      assert.equal(
        await refusal(() =>
          updateSourceAccount(ctx, {
            principal: webPrincipal(readerId),
            sourceAccountId: id,
            name: "Reader edit",
          }),
        ),
        SOURCE_ACCOUNT_NOT_FOUND,
      );

      // An id that does not exist at all gets the same non-enumerating words.
      assert.equal(
        await refusal(() =>
          updateSourceAccount(ctx, {
            principal,
            sourceAccountId: newKithId(),
            name: "Nobody",
          }),
        ),
        SOURCE_ACCOUNT_NOT_FOUND,
      );

      // The refused updates changed nothing.
      row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.name, "Renamed");
      assert.equal(row.freshnessMs, 120_000);
      assert.equal(row.enabled, false);
    });
  },
);

test(
  "create and update refuse the same malformed input Convex refused",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      const principal = webPrincipal(userId);

      const badText = ["", "   ", "n".repeat(201), "bad \ud800"];
      for (const name of badText) {
        assert.equal(
          await refusalCode(() =>
            createSourceAccount(ctx, {
              principal,
              spaceId,
              connector: "gmail",
              accountId: "a",
              name,
            }),
          ),
          "invalid_input",
          JSON.stringify(name),
        );
      }
      for (const connector of ["", "   ", "c".repeat(101), "bad \ud800"]) {
        assert.equal(
          await refusalCode(() =>
            createSourceAccount(ctx, {
              principal,
              spaceId,
              connector,
              accountId: "a",
              name: "Valid",
            }),
          ),
          "invalid_input",
          JSON.stringify(connector),
        );
      }
      for (const accountId of ["", "   ", "a".repeat(513), "bad \ud800"]) {
        assert.equal(
          await refusalCode(() =>
            createSourceAccount(ctx, {
              principal,
              spaceId,
              connector: "gmail",
              accountId,
              name: "Valid",
            }),
          ),
          "invalid_input",
          JSON.stringify(accountId),
        );
      }
      // One minute to one year, an integer. 59_999 is just under, the year
      // bound plus one millisecond is just over, and both non-integers are
      // refused the same way.
      for (const freshnessMs of [
        59_999,
        365 * 86_400_000 + 1,
        1.5,
        Number.NaN,
        -1,
      ]) {
        assert.equal(
          await refusalCode(() =>
            createSourceAccount(ctx, {
              principal,
              spaceId,
              connector: "gmail",
              accountId: `fresh-${freshnessMs}`,
              name: "Valid",
              freshnessMs,
            }),
          ),
          "invalid_input",
          JSON.stringify(freshnessMs),
        );
      }

      const id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "valid-account",
        name: "Valid",
      });
      for (const name of badText) {
        assert.equal(
          await refusalCode(() =>
            updateSourceAccount(ctx, { principal, sourceAccountId: id, name }),
          ),
          "invalid_input",
          JSON.stringify(name),
        );
      }
      for (const freshnessMs of [59_999, 365 * 86_400_000 + 1, 1.5]) {
        assert.equal(
          await refusalCode(() =>
            updateSourceAccount(ctx, {
              principal,
              sourceAccountId: id,
              freshnessMs,
            }),
          ),
          "invalid_input",
          JSON.stringify(freshnessMs),
        );
      }
      // A refused update left the valid row valid.
      const row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.name, "Valid");
      assert.equal(row.freshnessMs, 86_400_000);
    });
  },
);

test(
  "list is bounded, space-isolated, and empty rather than an error for no spaces",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      const otherOwnerId = await makeUser(ctx, { email: "other@example.test" });
      const otherSpaceId = await makeSpace(ctx, {
        createdBy: otherOwnerId,
        role: "owner",
      });
      const principal = webPrincipal(userId);

      // A source account in a space this principal cannot read never appears.
      await createSourceAccount(ctx, {
        principal: webPrincipal(otherOwnerId),
        spaceId: otherSpaceId,
        connector: "gmail",
        accountId: "isolated",
        name: "Not mine",
      });
      assert.deepEqual(await listSourceAccounts(ctx, { principal }), []);

      // A principal with read access to no space at all gets an empty list,
      // not the "unauthorized" the bare predicate throws for zero spaces.
      const strangerId = await makeUser(ctx, { email: "no-space@example.test" });
      assert.deepEqual(
        await listSourceAccounts(ctx, { principal: webPrincipal(strangerId) }),
        [],
      );

      // 101 rows in one space: one more than Convex's 100-row bound.
      for (let index = 0; index < 101; index += 1) {
        await createSourceAccount(ctx, {
          principal,
          spaceId,
          connector: "bulk",
          accountId: `bulk-${index}`,
          name: `Bulk ${index}`,
        });
      }
      assert.equal(
        await refusalCode(() => listSourceAccounts(ctx, { principal })),
        "source_account_limit",
      );
      // Filtering to a space with 101 rows is still over the bound.
      assert.equal(
        await refusalCode(() =>
          listSourceAccounts(ctx, { principal, spaceIds: [spaceId] }),
        ),
        "source_account_limit",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// P2-39i0 follow-up: the enabled-change side effects
// ---------------------------------------------------------------------------

test(
  "disabling a source advances the assessment epoch, clears the active watcher's sweep clock, and resolves its open incident",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    const NOW = Date.parse("2026-01-01T00:00:00.000Z");
    await db.tx(async (ctx) => {
      const ownerId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: ownerId, role: "owner" });
      const principal = webPrincipal(ownerId);

      const id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "watched@gmail.example",
        name: "Watched inbox",
      });
      // No update has touched it yet: Convex's `workerAssessmentEpoch` starts
      // absent, `COALESCE(..., 0)` in the epoch statement's own base case.
      assert.equal(await getEpoch(ctx, id), null);

      await makeActiveWatcher(ctx, {
        spaceId,
        sourceAccountId: id,
        watcherId: "watcher-1",
        actorUserId: ownerId,
        lastSeenAt: NOW - 60_000,
        sweepAfter: NOW - 60_000 + WORKER_HEARTBEAT_OVERDUE_MS,
        now: NOW - 60_000,
      });
      await makeOpenIncident(ctx, {
        spaceId,
        sourceAccountId: id,
        watcherId: "watcher-1",
        openedAt: NOW - 30_000,
      });

      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        enabled: false,
      });

      assert.equal(await getEpoch(ctx, id), 1);
      const watcher = await getWatcher(ctx, id);
      assert.equal(watcher.state, "active");
      assert.equal(watcher.sweep_after, null);
      assert.equal(watcher.updated_at.getTime(), NOW);
      const incidents = await getIncidents(ctx, id);
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0].state, "resolved");
      assert.equal(incidents[0].observed_at.getTime(), NOW);
      assert.equal(incidents[0].resolved_at.getTime(), NOW);

      const row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.enabled, false);
    }, NOW);
  },
);

test(
  "re-enabling a disabled source advances the epoch again and restarts the watcher's staleness clock",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    const NOW = Date.parse("2026-02-01T00:00:00.000Z");
    await db.tx(async (ctx) => {
      const ownerId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: ownerId, role: "owner" });
      const principal = webPrincipal(ownerId);

      const id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "re-enable@gmail.example",
        name: "Re-enable me",
      });
      await makeActiveWatcher(ctx, {
        spaceId,
        sourceAccountId: id,
        watcherId: "watcher-2",
        actorUserId: ownerId,
        lastSeenAt: NOW - 120_000,
        sweepAfter: NOW - 120_000 + WORKER_HEARTBEAT_OVERDUE_MS,
        now: NOW - 120_000,
      });
      await makeOpenIncident(ctx, {
        spaceId,
        sourceAccountId: id,
        watcherId: "watcher-2",
        openedAt: NOW - 90_000,
      });

      // First, disable: leaves the watcher `active` with `sweep_after` cleared
      // -- the shape `validateWatcher` requires of a disabled account's
      // watcher -- and resolves the incident opened above.
      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        enabled: false,
      });
      assert.equal(await getEpoch(ctx, id), 1);
      assert.equal((await getWatcher(ctx, id)).sweep_after, null);

      // A fresh incident opens while the source sits disabled.
      await makeOpenIncident(ctx, {
        spaceId,
        sourceAccountId: id,
        watcherId: "watcher-2",
        openedAt: NOW - 10_000,
      });

      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        enabled: true,
      });

      assert.equal(await getEpoch(ctx, id), 2);
      const watcher = await getWatcher(ctx, id);
      assert.equal(watcher.sweep_after.getTime(), NOW);
      assert.equal(watcher.updated_at.getTime(), NOW);
      const incidents = await getIncidents(ctx, id);
      assert.equal(incidents.length, 2);
      assert.ok(incidents.every((incident) => incident.state === "resolved"));

      const row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.enabled, true);
    }, NOW);
  },
);

test(
  "an update that leaves enabled unchanged advances neither the epoch nor the watcher or incident rows",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    const NOW = Date.parse("2026-03-01T00:00:00.000Z");
    await db.tx(async (ctx) => {
      const ownerId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: ownerId, role: "owner" });
      const principal = webPrincipal(ownerId);

      const id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "steady@gmail.example",
        name: "Steady",
      });
      await makeActiveWatcher(ctx, {
        spaceId,
        sourceAccountId: id,
        watcherId: "watcher-3",
        actorUserId: ownerId,
        lastSeenAt: NOW - 5_000,
        sweepAfter: NOW - 5_000 + WORKER_HEARTBEAT_OVERDUE_MS,
        now: NOW - 5_000,
      });
      await makeOpenIncident(ctx, {
        spaceId,
        sourceAccountId: id,
        watcherId: "watcher-3",
        openedAt: NOW - 1_000,
      });
      const watcherBefore = await getWatcher(ctx, id);
      const incidentsBefore = await getIncidents(ctx, id);

      // No `enabled` given at all.
      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        name: "Renamed steady",
      });
      assert.equal(await getEpoch(ctx, id), null);
      assert.deepEqual(await getWatcher(ctx, id), watcherBefore);
      assert.deepEqual(await getIncidents(ctx, id), incidentsBefore);

      // `enabled` given but equal to the row's current value.
      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        enabled: true,
      });
      assert.equal(await getEpoch(ctx, id), null);
      assert.deepEqual(await getWatcher(ctx, id), watcherBefore);
      assert.deepEqual(await getIncidents(ctx, id), incidentsBefore);
    }, NOW);
  },
);

test(
  "toggling one source account's enabled state never advances another space's epoch, watcher, or incident rows",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    const NOW = Date.parse("2026-04-01T00:00:00.000Z");
    await db.tx(async (ctx) => {
      const ownerA = await makeUser(ctx, { email: "owner-a@example.test" });
      const spaceA = await makeSpace(ctx, { createdBy: ownerA, role: "owner" });
      const principalA = webPrincipal(ownerA);
      const ownerB = await makeUser(ctx, { email: "owner-b@example.test" });
      const spaceB = await makeSpace(ctx, { createdBy: ownerB, role: "owner" });
      const principalB = webPrincipal(ownerB);

      const idA = await createSourceAccount(ctx, {
        principal: principalA,
        spaceId: spaceA,
        connector: "gmail",
        accountId: "a@gmail.example",
        name: "Space A",
      });
      const idB = await createSourceAccount(ctx, {
        principal: principalB,
        spaceId: spaceB,
        connector: "gmail",
        accountId: "b@gmail.example",
        name: "Space B",
      });
      await makeActiveWatcher(ctx, {
        spaceId: spaceA,
        sourceAccountId: idA,
        watcherId: "watcher-a",
        actorUserId: ownerA,
        lastSeenAt: NOW - 5_000,
        sweepAfter: NOW - 5_000 + WORKER_HEARTBEAT_OVERDUE_MS,
        now: NOW - 5_000,
      });
      await makeOpenIncident(ctx, {
        spaceId: spaceA,
        sourceAccountId: idA,
        watcherId: "watcher-a",
        openedAt: NOW - 1_000,
      });
      await makeActiveWatcher(ctx, {
        spaceId: spaceB,
        sourceAccountId: idB,
        watcherId: "watcher-b",
        actorUserId: ownerB,
        lastSeenAt: NOW - 5_000,
        sweepAfter: NOW - 5_000 + WORKER_HEARTBEAT_OVERDUE_MS,
        now: NOW - 5_000,
      });
      await makeOpenIncident(ctx, {
        spaceId: spaceB,
        sourceAccountId: idB,
        watcherId: "watcher-b",
        openedAt: NOW - 1_000,
      });

      const watcherBBefore = await getWatcher(ctx, idB);
      const incidentsBBefore = await getIncidents(ctx, idB);

      await updateSourceAccount(ctx, {
        principal: principalA,
        sourceAccountId: idA,
        enabled: false,
      });

      assert.equal(await getEpoch(ctx, idA), 1);
      const watcherA = await getWatcher(ctx, idA);
      assert.equal(watcherA.sweep_after, null);
      const incidentsA = await getIncidents(ctx, idA);
      assert.equal(incidentsA[0].state, "resolved");

      // Space B's rows are byte-for-byte what they were before space A's
      // source account changed.
      assert.equal(await getEpoch(ctx, idB), null);
      assert.deepEqual(await getWatcher(ctx, idB), watcherBBefore);
      assert.deepEqual(await getIncidents(ctx, idB), incidentsBBefore);
    }, NOW);
  },
);

test(
  "the enabled-change side effects roll back together with the caller's transaction",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    const NOW = Date.parse("2026-05-01T00:00:00.000Z");
    let id;
    await db.tx(async (ctx) => {
      const ownerId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: ownerId, role: "owner" });
      const principal = webPrincipal(ownerId);

      id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "rollback@gmail.example",
        name: "Rollback me",
      });
      await makeActiveWatcher(ctx, {
        spaceId,
        sourceAccountId: id,
        watcherId: "watcher-rb",
        actorUserId: ownerId,
        lastSeenAt: NOW - 5_000,
        sweepAfter: NOW - 5_000 + WORKER_HEARTBEAT_OVERDUE_MS,
        now: NOW - 5_000,
      });
      await makeOpenIncident(ctx, {
        spaceId,
        sourceAccountId: id,
        watcherId: "watcher-rb",
        openedAt: NOW - 1_000,
      });

      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        enabled: false,
      });

      // Applied inside this transaction.
      assert.equal(await getEpoch(ctx, id), 1);
      assert.equal((await getWatcher(ctx, id)).sweep_after, null);
      assert.equal((await getIncidents(ctx, id))[0].state, "resolved");
    }, NOW);

    // `db.tx` always rolls back. Querying the same client afterwards, outside
    // any transaction, reads the database's actually committed state -- if
    // any of the epoch bump, the watcher patch or the incident resolution had
    // escaped the transaction, the source account row itself would have too.
    const result = await db.client.query(
      "SELECT id FROM kith.source_accounts WHERE id = $1",
      [id],
    );
    assert.equal(result.rowCount, 0);
  },
);
