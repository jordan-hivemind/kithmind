// The port of `packages/convex/convex/models/oauth/lifecycle.test.ts` and of the
// activate-once-then-revoke case in `mcpAuth.test.ts`.
//
// The whole point of this flow is that a key exists before it is a credential, so
// most of what is asserted below is that the half-built key does nothing: it does
// not authenticate, it cannot be finalized twice, it cannot be activated with a
// code that does not bind to it, and a replayed exchange takes it away rather than
// handing out a second credential.

import assert from "node:assert/strict";
import test from "node:test";

import {
  abandonAuthorizationGrant,
  activateAuthorizationGrant,
  auditOAuthLifecycle,
  beginAuthorizationGrant,
  finalizeAuthorizationGrant,
  getApiKey,
  grantLifecycle,
  isPendingOAuthKey,
  isPreparingOAuthKey,
  listApiKeys,
  removeExpiredOAuthGrants,
  requireMcpPrincipal,
  webPrincipal,
  ensurePersonalSpace,
} from "../dist/identity/index.js";
import { newKithId, sha256 } from "../dist/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  refusal,
  refusalCode,
  skip,
} from "./helpers/identityFixture.mjs";

/** A consent request. `codeChallenge` is a PKCE S256 challenge's 43 characters. */
function consent(spaceIds, overrides = {}) {
  return {
    clientId: "https://client.example.test/metadata.json",
    redirectUri: "https://client.example.test/callback",
    resource: "https://brain.example.test/api/mcp",
    codeChallenge: "A".repeat(43),
    scope: "open-brain",
    name: "A synthetic client",
    capabilities: ["read"],
    spaceIds,
    ...overrides,
  };
}

/** Finalizes an issued grant the way the web route would. */
async function finalize(ctx, issued, principal, overrides = {}) {
  const encryptedCode = `obac1.${Buffer.from(issued.requestHash).toString("base64url")}`;
  const codeHash = sha256(encryptedCode);
  const bindingHash = sha256(
    `oauth-binding-v1\u0000${issued.bindingSeedHash}\u0000${codeHash}`,
  );
  await finalizeAuthorizationGrant(ctx, {
    principal,
    keyId: issued.keyId,
    requestHash: issued.requestHash,
    preparationNonce: issued.preparationNonce,
    encryptedCode,
    codeHash,
    bindingHash,
    grantExpiresAt: issued.grantExpiresAt,
    ...overrides,
  });
  return { encryptedCode, codeHash, bindingHash };
}

test(
  "a preparing grant is inert, finalizes once, activates once, and revokes on replay",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      const principal = webPrincipal(userId);

      const issued = await beginAuthorizationGrant(ctx, {
        ...consent([spaceId]),
        principal,
      });
      assert.equal(issued.status, "issued");
      assert.match(issued.rawKey, /^ob_[0-9a-f]{64}$/);
      assert.equal(await grantLifecycle(ctx, issued.keyId), "preparing");

      // Inert: the raw key exists but authenticates nothing, and the key is
      // invisible to the dashboard's key list.
      assert.equal(
        await refusal(() =>
          requireMcpPrincipal(ctx, { rawKey: issued.rawKey }),
        ),
        "Not authenticated",
      );
      assert.deepEqual(await listApiKeys(ctx, { principal }), []);

      // Asking again while the preparation lease is live is told to wait rather
      // than handed a second grant.
      const again = await beginAuthorizationGrant(ctx, {
        ...consent([spaceId]),
        principal,
      });
      assert.equal(again.status, "preparing");
      assert.ok(again.retryAfterMs > 0);

      const { codeHash, bindingHash, encryptedCode } = await finalize(
        ctx,
        issued,
        principal,
      );
      assert.equal(await grantLifecycle(ctx, issued.keyId), "pending");
      assert.equal(isPendingOAuthKey(await getApiKey(ctx, issued.keyId)), true);
      // Still not a credential.
      assert.equal(
        await refusal(() =>
          requireMcpPrincipal(ctx, { rawKey: issued.rawKey }),
        ),
        "Not authenticated",
      );

      // A repeat consent now returns the pending code rather than starting over.
      const pending = await beginAuthorizationGrant(ctx, {
        ...consent([spaceId]),
        principal,
      });
      assert.equal(pending.status, "pending");
      assert.equal(pending.keyId, issued.keyId);
      assert.equal(pending.encryptedCode, encryptedCode);

      const exchange = {
        apiKeyId: issued.keyId,
        userId,
        codeHash,
        keyHash: sha256(issued.rawKey),
        bindingHash,
        requestHash: issued.requestHash,
        expiresAt: issued.grantExpiresAt,
      };
      assert.deepEqual(await activateAuthorizationGrant(ctx, exchange), {
        status: "activated",
      });
      // Now it is a credential.
      assert.equal(await grantLifecycle(ctx, issued.keyId), null);
      const credential = await requireMcpPrincipal(ctx, {
        rawKey: issued.rawKey,
      });
      assert.equal(credential.userId, userId);
      assert.deepEqual(credential.capabilities, ["read"]);
      assert.deepEqual(credential.credentialSpaceIds, [spaceId]);
      assert.equal((await listApiKeys(ctx, { principal })).length, 1);

      // A replayed exchange means the code leaked: the key is taken away rather
      // than a second credential being handed out.
      assert.deepEqual(await activateAuthorizationGrant(ctx, exchange), {
        status: "replayed",
      });
      assert.equal(await getApiKey(ctx, issued.keyId), null);
      assert.deepEqual(await listApiKeys(ctx, { principal }), []);

      // The revocation has to be able to commit, and this suite never commits:
      // it rolls every case back, so a `DEFERRABLE INITIALLY DEFERRED` foreign
      // key is checked at a COMMIT these tests do not reach. P2-39i2 found the
      // revocation failing there and not here. `SET CONSTRAINTS ALL IMMEDIATE`
      // runs the deferred checks now, which is what makes the rollback fixture
      // able to prove a commit would have succeeded.
      await ctx.client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await ctx.client.query("SET CONSTRAINTS ALL DEFERRED");

      // And the consumed receipt makes the same consent unusable.
      assert.deepEqual(
        await beginAuthorizationGrant(ctx, {
          ...consent([spaceId]),
          principal,
        }),
        { status: "consumed" },
      );
    });
  },
);

test(
  "a finalize that does not bind exactly is refused",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const otherUserId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      const principal = webPrincipal(userId);
      const issued = await beginAuthorizationGrant(ctx, {
        ...consent([spaceId]),
        principal,
      });
      const encryptedCode = "obac1.synthetic";
      const codeHash = sha256(encryptedCode);
      const good = {
        principal,
        keyId: issued.keyId,
        requestHash: issued.requestHash,
        preparationNonce: issued.preparationNonce,
        encryptedCode,
        codeHash,
        bindingHash: sha256(
          `oauth-binding-v1\u0000${issued.bindingSeedHash}\u0000${codeHash}`,
        ),
        grantExpiresAt: issued.grantExpiresAt,
      };

      const bad = [
        // Malformed inputs.
        [{ requestHash: "nope" }, "invalid_input"],
        [{ preparationNonce: "nope" }, "invalid_input"],
        [{ codeHash: "nope" }, "invalid_input"],
        [{ bindingHash: "nope" }, "invalid_input"],
        [{ encryptedCode: "not-obac1" }, "invalid_input"],
        [{ encryptedCode: `obac1.${"a".repeat(9000)}` }, "invalid_input"],
        // The code hash must be the hash of the code, and the binding hash must
        // be derived from the seed this grant was issued with.
        [{ codeHash: "a".repeat(64) }, "invalid_input"],
        [{ bindingHash: "d".repeat(64) }, "invalid_input"],
        // Wrong grant, wrong nonce, wrong request, wrong owner.
        [{ keyId: newKithId() }, "grant_not_found"],
        [{ preparationNonce: "f".repeat(64) }, "grant_not_found"],
        [{ requestHash: "b".repeat(64) }, "grant_not_found"],
        [{ principal: webPrincipal(otherUserId) }, "grant_not_found"],
        // A changed expiry is a fencing failure, not a rounding difference.
        [{ grantExpiresAt: issued.grantExpiresAt + 1 }, "grant_expired"],
      ];
      for (const [overrides, code] of bad) {
        assert.equal(
          await refusalCode(() =>
            finalizeAuthorizationGrant(ctx, { ...good, ...overrides }),
          ),
          code,
          JSON.stringify(Object.keys(overrides)),
        );
        // Nothing partially applied: the grant is still preparing.
        assert.equal(await grantLifecycle(ctx, issued.keyId), "preparing");
      }

      // The good one works, and works only once.
      await finalizeAuthorizationGrant(ctx, good);
      assert.equal(await grantLifecycle(ctx, issued.keyId), "pending");
      assert.equal(
        await refusalCode(() => finalizeAuthorizationGrant(ctx, good)),
        "grant_not_found",
      );
    });
  },
);

test(
  "an expired preparation cannot be finalized, and is replaced rather than reused",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      const principal = webPrincipal(userId);
      const issued = await beginAuthorizationGrant(ctx, {
        ...consent([spaceId]),
        principal,
      });

      // Past the 30 second preparation lease but inside the 5 minute grant.
      const later = db.ctx(ctx.now + 60_000);
      assert.equal(
        await refusalCode(() => finalize(later, issued, principal)),
        "grant_expired",
      );
      // A fresh consent replaces the dead preparation with a new grant.
      const replaced = await beginAuthorizationGrant(later, {
        ...consent([spaceId]),
        principal,
      });
      assert.equal(replaced.status, "issued");
      assert.notEqual(replaced.keyId, issued.keyId);
      assert.equal(await getApiKey(later, issued.keyId), null);

      // And the abandoned original cannot be cleaned up by a stale caller.
      await abandonAuthorizationGrant(later, {
        principal,
        keyId: issued.keyId,
        requestHash: issued.requestHash,
        preparationNonce: issued.preparationNonce,
      });
      assert.notEqual(await getApiKey(later, replaced.keyId), null);
    });
  },
);

test(
  "abandon only removes the caller's own matching preparation",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const otherUserId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      const principal = webPrincipal(userId);
      const issued = await beginAuthorizationGrant(ctx, {
        ...consent([spaceId]),
        principal,
      });
      const base = {
        principal,
        keyId: issued.keyId,
        requestHash: issued.requestHash,
        preparationNonce: issued.preparationNonce,
      };
      // Another account, a wrong nonce, a wrong request hash: all no-ops, none an
      // error, because abandon must not become an existence oracle either.
      for (const overrides of [
        { principal: webPrincipal(otherUserId) },
        { preparationNonce: "f".repeat(64) },
        { requestHash: "b".repeat(64) },
        { keyId: newKithId() },
      ]) {
        await abandonAuthorizationGrant(ctx, { ...base, ...overrides });
        assert.notEqual(await getApiKey(ctx, issued.keyId), null);
      }
      await abandonAuthorizationGrant(ctx, base);
      assert.equal(await getApiKey(ctx, issued.keyId), null);
    });
  },
);

test(
  "consent refuses ingest, unreadable spaces and malformed requests",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      const stranger = await makeSpace(ctx, {
        createdBy: await makeUser(ctx),
        role: "owner",
      });
      const principal = webPrincipal(userId);

      const bad = [
        // An OAuth client may never be granted ingest. Two checks refuse it and
        // the scope validator gets there first: ingest without explicit source
        // accounts is not a grantable scope at all, which reads as the access
        // being unavailable. `canonicalConsent` refuses it again behind that, so
        // removing either one still leaves it refused.
        [
          consent([spaceId], { capabilities: ["ingest"] }),
          "authorization_revoked",
        ],
        [
          consent([spaceId], { capabilities: ["read", "write", "ingest"] }),
          "authorization_revoked",
        ],
        // PKCE challenge shape.
        [consent([spaceId], { codeChallenge: "short" }), "invalid_input"],
        [
          consent([spaceId], { codeChallenge: "!".repeat(43) }),
          "invalid_input",
        ],
        // Bounded strings.
        [consent([spaceId], { clientId: "" }), "invalid_input"],
        [
          consent([spaceId], { redirectUri: "x".repeat(2049) }),
          "invalid_input",
        ],
        [consent([spaceId], { state: "s".repeat(1025) }), "invalid_input"],
        // Space lists.
        [consent([]), "invalid_input"],
        [consent([spaceId, spaceId]), "invalid_input"],
        [consent(["not-an-id"]), "invalid_input"],
        // A space the caller cannot read is a read denial, not a consent error.
        [consent([stranger]), "space_not_found"],
      ];
      for (const [args, code] of bad) {
        assert.equal(
          await refusalCode(() =>
            beginAuthorizationGrant(ctx, { ...args, principal }),
          ),
          code,
          JSON.stringify({
            capabilities: args.capabilities,
            spaceIds: args.spaceIds.length,
          }),
        );
      }
      // Nothing was written by any of them.
      const keys = await ctx.client.query(
        "SELECT count(*)::int AS n FROM kith.api_keys",
      );
      assert.equal(keys.rows[0].n, 0);
    });
  },
);

test(
  "activation rechecks live space access and refuses a mismatched exchange",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const otherUserId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      await ensurePersonalSpace(ctx, userId);
      const principal = webPrincipal(userId);
      const issued = await beginAuthorizationGrant(ctx, {
        ...consent([spaceId]),
        principal,
      });
      const { codeHash, bindingHash } = await finalize(ctx, issued, principal);
      const good = {
        apiKeyId: issued.keyId,
        userId,
        codeHash,
        keyHash: sha256(issued.rawKey),
        bindingHash,
        requestHash: issued.requestHash,
        expiresAt: issued.grantExpiresAt,
      };

      for (const overrides of [
        { codeHash: "a".repeat(64) },
        { keyHash: "c".repeat(64) },
        { bindingHash: "d".repeat(64) },
        { requestHash: "b".repeat(64) },
        // Expiry must be the grant's own, inside the 10 minute code lifetime.
        { expiresAt: issued.grantExpiresAt + 1 },
        { expiresAt: ctx.now - 1 },
        { expiresAt: ctx.now + 11 * 60 * 1000 },
        { expiresAt: Number.MAX_SAFE_INTEGER },
      ]) {
        assert.equal(
          await refusalCode(() =>
            activateAuthorizationGrant(ctx, { ...good, ...overrides }),
          ),
          "invalid_grant",
          JSON.stringify(overrides),
        );
      }
      // A key that belongs to another user, and an unknown key, are refused
      // before any grant check.
      for (const overrides of [
        { userId: otherUserId },
        { apiKeyId: newKithId() },
        { apiKeyId: "not-an-id" },
      ]) {
        assert.equal(
          await refusal(() =>
            activateAuthorizationGrant(ctx, { ...good, ...overrides }),
          ),
          "Not authenticated",
          JSON.stringify(overrides),
        );
      }

      // Membership removed between consent and exchange: the grant dies with it.
      await ctx.client.query(
        "DELETE FROM kith.space_members WHERE space_id = $1 AND user_id = $2",
        [spaceId, userId],
      );
      assert.equal(
        await refusalCode(() => activateAuthorizationGrant(ctx, good)),
        "invalid_grant",
      );
      assert.equal(await grantLifecycle(ctx, issued.keyId), "pending");
    });
  },
);

test(
  "a receipt that does not bind to this key is invalid rather than a replay",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      const principal = webPrincipal(userId);
      const issued = await beginAuthorizationGrant(ctx, {
        ...consent([spaceId]),
        principal,
      });
      const { codeHash, bindingHash } = await finalize(ctx, issued, principal);
      // A receipt for this code hash that names a different key: this is the
      // shape a cross-grant code substitution would take.
      await ctx.client.query(
        `INSERT INTO kith.consumed_oauth_codes
           (id, user_id, api_key_id, request_hash, code_hash, binding_hash,
            key_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newKithId(),
          userId,
          newKithId(),
          issued.requestHash,
          codeHash,
          bindingHash,
          sha256("something else"),
          new Date(issued.grantExpiresAt),
        ],
      );
      assert.equal(
        await refusalCode(() =>
          activateAuthorizationGrant(ctx, {
            apiKeyId: issued.keyId,
            userId,
            codeHash,
            keyHash: sha256(issued.rawKey),
            bindingHash,
            requestHash: issued.requestHash,
            expiresAt: issued.grantExpiresAt,
          }),
        ),
        "invalid_grant",
      );
      // The key is untouched: still pending, still not a credential.
      assert.equal(await grantLifecycle(ctx, issued.keyId), "pending");
    });
  },
);

test("live grants per user are bounded", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await ensurePersonalSpace(ctx, userId);
    const principal = webPrincipal(userId);
    // Nineteen live preparations, then the twentieth consent is refused. Each
    // needs its own consent, so the client id varies.
    for (let index = 0; index < 19; index += 1) {
      await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [spaceId],
        oauthLifecycle: "preparing",
        oauthRequestHash: sha256(`request ${index}`),
        oauthBindingSeedHash: sha256(`seed ${index}`),
        oauthGrantExpiresAt: ctx.now + 60_000,
        oauthPreparationExpiresAt: ctx.now + 30_000,
        oauthPreparationNonce: sha256(`nonce ${index}`),
      });
    }
    // An older active key does not count against the bound.
    await makeApiKey(ctx, {
      userId,
      capabilities: ["read"],
      spaceIds: [spaceId],
    });
    const twentieth = await beginAuthorizationGrant(ctx, {
      ...consent([spaceId]),
      principal,
    });
    assert.equal(twentieth.status, "issued");
    assert.equal(
      await refusalCode(() =>
        beginAuthorizationGrant(ctx, {
          ...consent([spaceId], {
            clientId: "https://other.example.test/m.json",
          }),
          principal,
        }),
      ),
      "grant_limit_reached",
    );
  });
});

test(
  "cleanup removes expired grants and receipts, and nothing live",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      const live = await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [spaceId],
      });
      const expiredPending = await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [spaceId],
        oauthLifecycle: "pending",
        oauthRequestHash: sha256("r1"),
        oauthCodeHash: sha256("c1"),
        oauthBindingHash: sha256("b1"),
        oauthBindingSeedHash: sha256("s1"),
        oauthEncryptedCode: "obac1.one",
        oauthGrantExpiresAt: ctx.now - 1000,
      });
      const livePreparing = await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [spaceId],
        oauthLifecycle: "preparing",
        oauthRequestHash: sha256("r2"),
        oauthBindingSeedHash: sha256("s2"),
        oauthGrantExpiresAt: ctx.now + 60_000,
        oauthPreparationExpiresAt: ctx.now + 30_000,
        oauthPreparationNonce: sha256("n2"),
      });
      await ctx.client.query(
        `INSERT INTO kith.consumed_oauth_codes (id, user_id, code_hash, expires_at)
           VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)`,
        [
          newKithId(),
          userId,
          sha256("old receipt"),
          new Date(ctx.now - 1000),
          newKithId(),
          sha256("new receipt"),
          new Date(ctx.now + 60_000),
        ],
      );

      assert.deepEqual(await removeExpiredOAuthGrants(ctx), {
        deleted: 2,
        hasMore: false,
      });
      assert.equal(await getApiKey(ctx, expiredPending.id), null);
      assert.notEqual(await getApiKey(ctx, live.id), null);
      assert.notEqual(await getApiKey(ctx, livePreparing.id), null);
      const receipts = await ctx.client.query(
        "SELECT count(*)::int AS n FROM kith.consumed_oauth_codes",
      );
      assert.equal(receipts.rows[0].n, 1);

      for (const limit of [0, 201, 1.5]) {
        assert.match(
          await refusal(() => removeExpiredOAuthGrants(ctx, { limit })),
          /OAuth cleanup limit is invalid/,
        );
      }
    });
  },
);

test(
  "the lifecycle audit reports a structurally impossible grant",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await ensurePersonalSpace(ctx, userId);
      const sound = await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [spaceId],
      });
      // Preparing with a preparation lease that outlives its grant: neither state
      // predicate accepts it, so it is reported rather than silently honoured.
      const broken = await makeApiKey(ctx, {
        userId,
        capabilities: ["read"],
        spaceIds: [spaceId],
        oauthLifecycle: "preparing",
        oauthRequestHash: sha256("r"),
        oauthBindingSeedHash: sha256("s"),
        oauthGrantExpiresAt: ctx.now + 1000,
        oauthPreparationExpiresAt: ctx.now + 60_000,
        oauthPreparationNonce: sha256("n"),
      });
      const record = await getApiKey(ctx, broken.id);
      assert.equal(isPreparingOAuthKey(record), false);
      assert.equal(isPendingOAuthKey(record), false);

      const audit = await auditOAuthLifecycle(ctx);
      assert.equal(audit.examined, 2);
      assert.deepEqual(
        audit.invalid.map((row) => row.id),
        [broken.id],
      );
      assert.equal(audit.invalid[0].reason, "invalid OAuth lifecycle fields");
      assert.notEqual(sound.id, broken.id);
    });
  },
);
