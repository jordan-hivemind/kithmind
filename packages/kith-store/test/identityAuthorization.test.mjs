// The port of `packages/convex/convex/models/spaces/authorization.test.ts` and of
// the credential half of `mcpAuth.test.ts`.
//
// Every denial in those files is a denial here. The Convex versions drove the
// function surface through `convexTest`; these drive the same functions directly
// against a migrated Postgres, which is the only way to find out whether the
// authorization survived the move rather than only the data.

import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateApiKey,
  authorizedSpacePredicate,
  ensurePersonalSpace,
  getAuthorizedReadSpaceIds,
  inspectPersonalSpace,
  listSpaces,
  principalFromApiKey,
  reloadPrincipal,
  requireMcpPrincipal,
  requireSpaceAccess,
  resolveWriteSpace,
  setDefaultWriteSpace,
  validateApiKeyScopes,
  webPrincipal,
  createApiKey,
  listApiKeys,
  listApiKeysPage,
  revokeApiKey,
  updateApiKey,
  getApiKey,
} from "../dist/identity/index.js";
import { newKithId } from "../dist/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeMember,
  makeSourceAccount,
  makeSpace,
  makeUser,
  refusal,
  skip,
} from "./helpers/identityFixture.mjs";

/** Every space failure has to be these exact words. */
const SPACE_NOT_FOUND = "Space not found";
const NOT_AUTHENTICATED = "Not authenticated";

test(
  "bootstraps exactly one personal space, and reruns without making a second",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx, { email: "owner@example.test" });
      const first = await ensurePersonalSpace(ctx, userId);
      const second = await ensurePersonalSpace(ctx, userId);
      assert.equal(second, first);

      const inspection = await inspectPersonalSpace(ctx, userId);
      assert.deepEqual(inspection.issues, []);
      assert.equal(inspection.personalSpace.id, first);
      assert.equal(inspection.membership.role, "owner");
      assert.equal(inspection.settings.personalSpaceId, first);

      // A duplicate personal space is reported rather than silently preferred,
      // and it blocks the bootstrap instead of being resolved arbitrarily.
      await makeSpace(ctx, {
        kind: "personal",
        name: "Personal",
        createdBy: userId,
        role: null,
      });
      const duplicated = await inspectPersonalSpace(ctx, userId);
      // Two issues, not one: with no single personal space to compare against,
      // the existing settings row is also unresolvable, and the inspection says
      // so rather than picking one of the two spaces.
      assert.deepEqual(duplicated.issues, [
        "duplicate personal spaces",
        "settings reference a missing personal space",
      ]);
      assert.match(
        await refusal(() => ensurePersonalSpace(ctx, userId)),
        /Personal space is invalid: duplicate personal spaces/,
      );
    });
  },
);

test(
  "a personal space with a foreign member or a non-owner membership is reported",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const intruderId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      await makeMember(ctx, { spaceId, userId: intruderId, role: "reader" });
      assert.deepEqual((await inspectPersonalSpace(ctx, userId)).issues, [
        "personal space has a foreign member",
      ]);
    });
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      await ctx.client.query(
        "UPDATE kith.space_members SET role = 'reader' WHERE space_id = $1",
        [spaceId],
      );
      assert.deepEqual((await inspectPersonalSpace(ctx, userId)).issues, [
        "personal-space membership is not owner",
      ]);
    });
  },
);

test(
  "enforces capability, current role, and exact space grant on every operation",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const ownerSpace = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const readerSpace = await makeSpace(ctx, {
        createdBy: userId,
        role: "reader",
      });
      const ungranted = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });

      const full = await makeApiKey(ctx, {
        userId,
        capabilities: ["read", "write"],
        spaceIds: [ownerSpace, readerSpace],
      });
      const principal = await requireMcpPrincipal(ctx, { rawKey: full.rawKey });

      // Granted, member, role high enough.
      assert.equal(
        (await requireSpaceAccess(ctx, principal, ownerSpace, "write")).role,
        "owner",
      );
      assert.equal(
        (await requireSpaceAccess(ctx, principal, readerSpace, "read")).role,
        "reader",
      );
      // A reader may read and may not write, whatever the key grants.
      assert.equal(
        await refusal(() =>
          requireSpaceAccess(ctx, principal, readerSpace, "write"),
        ),
        SPACE_NOT_FOUND,
      );
      // The key has no ingest capability at all.
      assert.equal(
        await refusal(() =>
          requireSpaceAccess(ctx, principal, ownerSpace, "ingest"),
        ),
        SPACE_NOT_FOUND,
      );
      // A space the user owns but the key does not name.
      assert.equal(
        await refusal(() =>
          requireSpaceAccess(ctx, principal, ungranted, "read"),
        ),
        SPACE_NOT_FOUND,
      );
      // The user themselves can reach it, which is what makes the line above a
      // credential boundary and not a membership one.
      assert.equal(
        (await requireSpaceAccess(ctx, webPrincipal(userId), ungranted, "read"))
          .role,
        "owner",
      );

      // A space that does not exist is the same words as one that is off limits.
      assert.equal(
        await refusal(() =>
          requireSpaceAccess(ctx, principal, newKithId(), "read"),
        ),
        SPACE_NOT_FOUND,
      );
    });
  },
);

test(
  "a duplicated membership denies rather than resolving in the caller's favour",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      await makeMember(ctx, { spaceId, userId, role: "reader" });
      assert.equal(
        await refusal(() =>
          requireSpaceAccess(ctx, webPrincipal(userId), spaceId, "read"),
        ),
        SPACE_NOT_FOUND,
      );
      // And it is absent from the authorized set rather than erring there.
      assert.deepEqual(
        await getAuthorizedReadSpaceIds(ctx, webPrincipal(userId)),
        [],
      );
    });
  },
);

test("a membership whose space is gone is not access", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    // The membership row has to outlive its space for this case to exist, so
    // the reference goes first -- before any row is written, because a
    // deferrable constraint with pending events cannot be altered.
    await ctx.client.query(
      "ALTER TABLE kith.space_members DROP CONSTRAINT space_members_space_id_fkey",
    );
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
    await ctx.client.query("DELETE FROM kith.spaces WHERE id = $1", [spaceId]);
    assert.equal(
      await refusal(() =>
        requireSpaceAccess(ctx, webPrincipal(userId), spaceId, "read"),
      ),
      SPACE_NOT_FOUND,
    );
  });
});

test(
  "rejects a retained credential and a retained web snapshot after the user is deleted",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      // A credential and a membership have to outlive their user for this case to
      // exist. The references go first, before any row is written: a deferrable
      // constraint with pending events cannot be altered.
      await ctx.client.query(
        "ALTER TABLE kith.api_keys DROP CONSTRAINT brain_api_keys_user_id_fkey",
      );
      await ctx.client.query(
        "ALTER TABLE kith.space_members DROP CONSTRAINT space_members_user_id_fkey",
      );
      await ctx.client.query(
        "ALTER TABLE kith.spaces DROP CONSTRAINT brain_spaces_created_by_fkey",
      );
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const key = await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [spaceId],
      });
      const credential = await requireMcpPrincipal(ctx, { rawKey: key.rawKey });
      const web = webPrincipal(userId);

      await ctx.client.query("DELETE FROM kith.users WHERE id = $1", [userId]);

      for (const principal of [credential, web]) {
        assert.equal(
          await refusal(() => reloadPrincipal(ctx, principal)),
          NOT_AUTHENTICATED,
        );
        assert.equal(
          await refusal(() =>
            requireSpaceAccess(ctx, principal, spaceId, "read"),
          ),
          NOT_AUTHENTICATED,
        );
      }
      assert.equal(
        await refusal(() => requireMcpPrincipal(ctx, { rawKey: key.rawKey })),
        NOT_AUTHENTICATED,
      );
    });
  },
);

test(
  "an unmigrated legacy key is refused, and an unknown capability is not ignored",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const legacy = await makeApiKey(ctx, {
        userId,
        capabilities: null,
        spaceIds: [spaceId],
      });
      const record = await getApiKey(ctx, legacy.id);
      assert.equal(record.capabilities, null);
      assert.equal(
        await refusal(() => principalFromApiKey(record)),
        "API key migration required",
      );
      // The MCP path turns that into a plain authentication failure rather than
      // leaking the operator problem to a client.
      assert.match(
        await refusal(() =>
          requireMcpPrincipal(ctx, { rawKey: legacy.rawKey }),
        ),
        /API key migration required/,
      );
    });
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const odd = await makeApiKey(ctx, {
        userId,
        capabilities: ["read", "admin"],
        spaceIds: [spaceId],
      });
      // A capability this build does not know is refused, not filtered out: the
      // alternative is a key that silently means something else here.
      assert.equal(
        await refusal(() => getApiKey(ctx, odd.id)),
        NOT_AUTHENTICATED,
      );
    });
  },
);

test("an in-flight OAuth key authenticates nothing", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
    for (const lifecycle of ["preparing", "pending"]) {
      const key = await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [spaceId],
        oauthLifecycle: lifecycle,
        oauthRequestHash: "b".repeat(64),
        oauthBindingSeedHash: "e".repeat(64),
        oauthGrantExpiresAt: Date.now() + 60_000,
        ...(lifecycle === "preparing"
          ? {
              oauthPreparationExpiresAt: Date.now() + 30_000,
              oauthPreparationNonce: "f".repeat(64),
            }
          : {
              oauthCodeHash: "a".repeat(64),
              oauthBindingHash: "d".repeat(64),
              oauthEncryptedCode: "obac1.synthetic",
            }),
      });
      assert.equal(
        await refusal(() => requireMcpPrincipal(ctx, { rawKey: key.rawKey })),
        NOT_AUTHENTICATED,
        `${lifecycle} key must not authenticate`,
      );
    }
  });
});

test(
  "an unknown, malformed or empty key hash is refused",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      for (const args of [
        {},
        { rawKey: "" },
        { rawKey: "ob_not_a_real_key" },
        { keyHash: "" },
        { keyHash: "zz" },
        { keyHash: "A".repeat(64) },
        { keyHash: "0".repeat(64) },
      ]) {
        assert.equal(
          await refusal(() => requireMcpPrincipal(ctx, args)),
          NOT_AUTHENTICATED,
          JSON.stringify(args),
        );
      }
    });
  },
);

test(
  "intersects the authorized read set with current membership and key scope",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const a = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
        name: "Aaa",
      });
      const b = await makeSpace(ctx, {
        createdBy: userId,
        role: "reader",
        name: "Bbb",
      });
      const unmembered = await makeSpace(ctx, {
        createdBy: await makeUser(ctx),
        role: "owner",
        name: "Ccc",
      });

      const key = await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [a, unmembered],
      });
      const principal = await requireMcpPrincipal(ctx, { rawKey: key.rawKey });

      // Granted and a member: a. Granted but not a member: unmembered. A member
      // but not granted: b.
      assert.deepEqual(await getAuthorizedReadSpaceIds(ctx, principal), [a]);
      assert.deepEqual(
        (await getAuthorizedReadSpaceIds(ctx, webPrincipal(userId))).sort(),
        [a, b].sort(),
      );
      assert.deepEqual(
        (await listSpaces(ctx, { principal })).map((space) => space.name),
        ["Aaa"],
      );

      // An explicit filter for a space outside the intersection is the typed read
      // denial, and an unknown id is indistinguishable from it.
      for (const spaceId of [b, unmembered, newKithId()]) {
        assert.equal(
          await refusal(() =>
            getAuthorizedReadSpaceIds(ctx, principal, [spaceId]),
          ),
          SPACE_NOT_FOUND,
        );
      }
      // A write-only key has no read set at all.
      const writeOnly = await makeApiKey(ctx, {
        userId,
        capabilities: ["write"],
        spaceIds: [a],
      });
      const writer = await requireMcpPrincipal(ctx, {
        rawKey: writeOnly.rawKey,
      });
      assert.equal(
        await refusal(() => getAuthorizedReadSpaceIds(ctx, writer)),
        SPACE_NOT_FOUND,
      );
    });
  },
);

test(
  "rejects an unbounded membership fan-out and an oversized explicit filter",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceIds = [];
      for (let index = 0; index < 101; index += 1) {
        spaceIds.push(
          await makeSpace(ctx, {
            createdBy: userId,
            role: "reader",
            name: `S${index}`,
          }),
        );
      }
      assert.equal(
        await refusal(() =>
          getAuthorizedReadSpaceIds(ctx, webPrincipal(userId)),
        ),
        "Too many space memberships",
      );
      assert.equal(
        await refusal(() =>
          getAuthorizedReadSpaceIds(ctx, webPrincipal(userId), spaceIds),
        ),
        "Space filter is too large",
      );
    });
  },
);

test(
  "uses explicit, default, then personal write destinations without silent fallback",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const personal = await ensurePersonalSpace(ctx, userId);
      const shared = await makeSpace(ctx, {
        createdBy: userId,
        role: "editor",
      });
      const readOnly = await makeSpace(ctx, {
        createdBy: userId,
        role: "reader",
      });
      const principal = webPrincipal(userId);

      // No default configured: personal.
      assert.equal(await resolveWriteSpace(ctx, principal), personal);
      // Explicit wins, and must be writable.
      assert.equal(await resolveWriteSpace(ctx, principal, shared), shared);
      assert.equal(
        await refusal(() => resolveWriteSpace(ctx, principal, readOnly)),
        SPACE_NOT_FOUND,
      );

      // Configured default wins over personal.
      await setDefaultWriteSpace(ctx, { principal, spaceId: shared });
      assert.equal(await resolveWriteSpace(ctx, principal), shared);

      // A default that stops being writable is named, not quietly replaced by
      // the personal space: a write landing somewhere unexpected is worse than a
      // refusal the caller can see.
      await ctx.client.query(
        "UPDATE kith.space_members SET role = 'reader' WHERE space_id = $1 AND user_id = $2",
        [shared, userId],
      );
      assert.equal(
        await refusal(() => resolveWriteSpace(ctx, principal)),
        "Default write space is not available",
      );

      // A default the caller cannot write to cannot be set in the first place.
      assert.equal(
        await refusal(() =>
          setDefaultWriteSpace(ctx, { principal, spaceId: readOnly }),
        ),
        SPACE_NOT_FOUND,
      );
    });
  },
);

test(
  "requires explicit, reachable grants and source scopes for a new key",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const personal = await ensurePersonalSpace(ctx, userId);
      const strangerSpace = await makeSpace(ctx, {
        createdBy: await makeUser(ctx),
        role: "owner",
      });
      const principal = webPrincipal(userId);
      const enabled = await makeSourceAccount(ctx, { spaceId: personal });
      const disabled = await makeSourceAccount(ctx, {
        spaceId: personal,
        enabled: false,
      });
      const foreign = await makeSourceAccount(ctx, { spaceId: strangerSpace });

      const bad = [
        [[], [personal], [], /bounded capabilities and space scopes/],
        [["read"], [], [], /bounded capabilities and space scopes/],
        [["read", "read"], [personal], [], /must be unique/],
        [["read"], [personal, personal], [], /must be unique/],
        // Ingest and source accounts imply each other, both ways.
        [["ingest"], [personal], [], /Ingest capability requires/],
        [["read"], [personal], [enabled], /Ingest capability requires/],
        // A source account that is disabled, in another space, or unknown.
        [["ingest"], [personal], [disabled], /Source account not found/],
        [["ingest"], [personal], [foreign], /Source account not found/],
        [["ingest"], [personal], [newKithId()], /Source account not found/],
        // A space the caller cannot read.
        [["read"], [strangerSpace], [], /Space not found/],
      ];
      for (const [capabilities, spaceIds, sourceAccountIds, expected] of bad) {
        assert.match(
          await refusal(() =>
            validateApiKeyScopes(
              ctx,
              principal,
              capabilities,
              spaceIds,
              sourceAccountIds,
            ),
          ),
          expected,
          JSON.stringify({ capabilities, spaceIds, sourceAccountIds }),
        );
      }

      // The one combination that is allowed, end to end through create.
      const created = await createApiKey(ctx, {
        principal,
        name: "ingest key",
        capabilities: ["ingest"],
        spaceIds: [personal],
        sourceAccountIds: [enabled],
      });
      assert.match(created.rawKey, /^ob_[0-9a-f]{64}$/);
      const summaries = await listApiKeys(ctx, { principal });
      assert.equal(summaries.length, 1);
      assert.deepEqual(summaries[0].capabilities, ["ingest"]);
      assert.deepEqual(summaries[0].spaceIds, [personal]);
      assert.deepEqual(summaries[0].sourceAccountIds, [enabled]);
      assert.equal(summaries[0].keyPrefix, created.rawKey.slice(0, 11));
      // The raw key is never readable again.
      assert.equal("rawKey" in summaries[0], false);
    });
  },
);

test(
  "a key belongs to its owner for update and revoke, and paging is stable",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const otherId = await makeUser(ctx);
      const personal = await ensurePersonalSpace(ctx, userId);
      const strangerPersonal = await ensurePersonalSpace(ctx, otherId);
      const principal = webPrincipal(userId);
      const stranger = webPrincipal(otherId);

      const created = [];
      for (let index = 0; index < 3; index += 1) {
        created.push(
          await createApiKey(ctx, {
            principal,
            name: `key ${index}`,
            capabilities: ["read"],
            spaceIds: [personal],
          }),
        );
      }

      // Another account's key is "not found", not "forbidden".
      for (const key of created) {
        assert.equal(
          await refusal(() =>
            revokeApiKey(ctx, { principal: stranger, id: key.id }),
          ),
          "API key not found",
        );
        // Scopes the stranger really holds, so ownership is what refuses rather
        // than the space check. Asking for another account's space refuses too,
        // one step earlier and with the space wording.
        assert.equal(
          await refusal(() =>
            updateApiKey(ctx, {
              principal: stranger,
              id: key.id,
              capabilities: ["read"],
              spaceIds: [strangerPersonal],
            }),
          ),
          "API key not found",
        );
        assert.equal(
          await refusal(() =>
            updateApiKey(ctx, {
              principal: stranger,
              id: key.id,
              capabilities: ["read"],
              spaceIds: [personal],
            }),
          ),
          SPACE_NOT_FOUND,
        );
      }

      // A keyset cursor walks every key once.
      const first = await listApiKeysPage(ctx, { principal, numItems: 2 });
      assert.equal(first.page.length, 2);
      assert.equal(first.isDone, false);
      const second = await listApiKeysPage(ctx, {
        principal,
        numItems: 2,
        cursor: first.continueCursor,
      });
      assert.equal(second.page.length, 1);
      assert.equal(second.isDone, true);
      assert.deepEqual(
        [...first.page, ...second.page].map((key) => key.name).sort(),
        ["key 0", "key 1", "key 2"],
      );
      for (const numItems of [0, 51, 1.5, Number.NaN]) {
        assert.match(
          await refusal(() => listApiKeysPage(ctx, { principal, numItems })),
          /Pagination size must be between 1 and 50/,
        );
      }
      assert.match(
        await refusal(() =>
          listApiKeysPage(ctx, {
            principal,
            numItems: 2,
            cursor: "not-a-cursor",
          }),
        ),
        /Pagination cursor is invalid/,
      );

      // Revoking removes the key and its grant rows with it.
      await revokeApiKey(ctx, { principal, id: created[0].id });
      assert.equal(await getApiKey(ctx, created[0].id), null);
      const grants = await ctx.client.query(
        "SELECT count(*)::int AS n FROM kith.api_key_spaces WHERE api_key_id = $1",
        [created[0].id],
      );
      assert.equal(grants.rows[0].n, 0);
      assert.equal((await listApiKeys(ctx, { principal })).length, 2);
    });
  },
);

test(
  "an update cannot widen a key past what the granting principal holds",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const personal = await ensurePersonalSpace(ctx, userId);
      const stranger = await makeSpace(ctx, {
        createdBy: await makeUser(ctx),
        role: "owner",
      });
      const principal = webPrincipal(userId);
      const key = await createApiKey(ctx, {
        principal,
        name: "narrow",
        capabilities: ["read"],
        spaceIds: [personal],
      });
      assert.equal(
        await refusal(() =>
          updateApiKey(ctx, {
            principal,
            id: key.id,
            capabilities: ["read"],
            spaceIds: [personal, stranger],
          }),
        ),
        SPACE_NOT_FOUND,
      );
      // The refused update changed nothing.
      assert.deepEqual((await getApiKey(ctx, key.id)).spaceIds, [personal]);

      // A name that is blank, too long, or has an unpaired surrogate.
      for (const name of ["", "   ", "n".repeat(201), "bad \ud800"]) {
        assert.match(
          await refusal(() =>
            updateApiKey(ctx, {
              principal,
              id: key.id,
              name,
              capabilities: ["read"],
              spaceIds: [personal],
            }),
          ),
          /API key name must contain 1 to 200 valid characters/,
          JSON.stringify(name),
        );
      }
    });
  },
);

test(
  "the space predicate a read carries is the authorized set, and never an empty one",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const granted = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const ungranted = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const key = await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [granted],
      });
      const principal = await requireMcpPrincipal(ctx, { rawKey: key.rawKey });

      const predicate = await authorizedSpacePredicate(ctx, principal, 1);
      assert.equal(predicate.sql, "space_id = ANY($1::text[])");
      assert.deepEqual(predicate.value, [granted]);

      // Run a real read with it rather than trusting its text. `space_members` is
      // space-scoped and already has a row in each of the two spaces.
      const visible = await ctx.client.query(
        `SELECT space_id FROM kith.space_members WHERE ${predicate.sql}`,
        [predicate.value],
      );
      assert.deepEqual(
        visible.rows.map((row) => row.space_id),
        [granted],
      );
      assert.equal(
        visible.rows.some((row) => row.space_id === ungranted),
        false,
      );

      // A different parameter index and a qualified column, because a real read
      // carries the predicate beside its own parameters.
      const qualified = await authorizedSpacePredicate(ctx, principal, 3, {
        column: "m.space_id",
      });
      assert.equal(qualified.sql, "m.space_id = ANY($3::text[])");

      // An explicit filter still goes through requireSpaceAccess.
      assert.equal(
        await refusal(() =>
          authorizedSpacePredicate(ctx, principal, 1, {
            explicitSpaceIds: [ungranted],
          }),
        ),
        SPACE_NOT_FOUND,
      );

      // A principal with nothing readable throws rather than producing a
      // predicate that matches nothing: an empty result would hide the
      // authorization failure behind "no rows".
      const writeOnly = await makeApiKey(ctx, {
        userId,
        capabilities: ["write"],
        spaceIds: [granted],
      });
      const writer = await requireMcpPrincipal(ctx, {
        rawKey: writeOnly.rawKey,
      });
      assert.equal(
        await refusal(() => authorizedSpacePredicate(ctx, writer, 1)),
        SPACE_NOT_FOUND,
      );
      const stranger = await makeUser(ctx);
      assert.equal(
        await refusal(() =>
          authorizedSpacePredicate(ctx, webPrincipal(stranger), 1),
        ),
        SPACE_NOT_FOUND,
      );
    });
  },
);

test(
  "the route authenticator returns a principal or null, never a distinguishable error",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const key = await makeApiKey(ctx, {
        userId,
        capabilities: ["read", "write"],
        spaceIds: [spaceId],
      });

      const accepted = await authenticateApiKey(ctx, { rawKey: key.rawKey });
      assert.equal(accepted.userId, userId);
      assert.equal(accepted.keyId, key.id);
      assert.deepEqual(accepted.principal.credentialSpaceIds, [spaceId]);
      // Authenticating records the use, as the Convex action did.
      assert.notEqual((await getApiKey(ctx, key.id)).lastUsedAt, null);

      // Every failure is the same `null`. A route that could tell "no such key"
      // from "key belongs to a deleted user" would leak which keys exist.
      for (const args of [
        {},
        { rawKey: "" },
        { rawKey: "ob_nonsense" },
        { keyHash: "0".repeat(64) },
        { keyHash: "not-a-hash" },
      ]) {
        assert.equal(
          await authenticateApiKey(ctx, args),
          null,
          JSON.stringify(args),
        );
      }

      // Including a legacy key, whose refusal is an operator problem and must not
      // reach a client as a different answer.
      const legacy = await makeApiKey(ctx, {
        userId,
        capabilities: null,
        spaceIds: [spaceId],
      });
      assert.equal(
        await authenticateApiKey(ctx, { rawKey: legacy.rawKey }),
        null,
      );
    });
  },
);
