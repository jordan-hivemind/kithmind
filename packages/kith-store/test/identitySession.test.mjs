// The port of `packages/convex/convex/webAuth.test.ts`, against the session this
// row owns rather than against Convex Auth.
//
// The Convex file asserted three things: an unauthenticated caller is refused, a
// dashboard session is accepted, and an identity minted by the MCP gateway is
// refused on the dashboard surface even though `getAuthUserId` would take it. The
// third has no cookie to build, because there is no JWT bridge any more -- the
// asymmetry is asserted from both directions instead: a session cookie is not a
// credential and an API key is not a session.

import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_DURATION_MS,
  SESSION_TOUCH_MIN_MS,
  changePassword,
  createSession,
  ensurePersonalSpace,
  getPasswordAccount,
  removeExpiredSessions,
  requireMcpPrincipal,
  requireWebPrincipal,
  requireWebSession,
  requireWebUserId,
  resolveSessionToken,
  revokeSession,
  revokeUserSessions,
  sessionCookie,
  signIn,
  signOut,
  signUp,
  verifyPassword,
} from "../dist/identity/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  refusal,
  sessionConfig,
  skip,
} from "./helpers/identityFixture.mjs";

const NOT_AUTHENTICATED = "Not authenticated";

/** The `Cookie` header a browser would send for this token. */
function header(token, expiresAt = Date.now() + SESSION_DURATION_MS) {
  return sessionCookie(sessionConfig, token, expiresAt).split(";")[0];
}

test(
  "signs up, signs in, and stores only a Scrypt hash",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const created = await signUp(ctx, {
        email: "owner@example.test",
        password: "a strong enough password",
        name: "Owner",
      });
      const account = await getPasswordAccount(ctx, "owner@example.test");
      assert.equal(account.userId, created.userId);
      // The password itself is nowhere in the row.
      assert.match(account.secret, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
      assert.equal(account.secret.includes("a strong enough password"), false);
      assert.equal(
        await verifyPassword(account.secret, "a strong enough password"),
        true,
      );

      const signedIn = await signIn(ctx, {
        email: "owner@example.test",
        password: "a strong enough password",
      });
      assert.equal(signedIn.userId, created.userId);
      // Ten years, unchanged from the Convex session's total duration.
      assert.ok(
        Math.abs(signedIn.expiresAt - (ctx.now + SESSION_DURATION_MS)) < 5_000,
      );
      const principal = await requireWebPrincipal(ctx, {
        config: sessionConfig,
        cookieHeader: header(signedIn.token, signedIn.expiresAt),
      });
      assert.equal(principal.userId, created.userId);
      // A web session carries the user's own authority, unnarrowed.
      assert.deepEqual([...principal.capabilities].sort(), [
        "ingest",
        "read",
        "write",
      ]);
      assert.equal(principal.credentialId, undefined);
    });
  },
);

test(
  "a wrong password, an unknown account and a weak password are all refused",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      await signUp(ctx, {
        email: "owner@example.test",
        password: "a strong enough password",
      });

      // One message for a wrong password and for an account that does not exist,
      // so sign-in is not an account-existence oracle.
      assert.equal(
        await refusal(() =>
          signIn(ctx, {
            email: "owner@example.test",
            password: "a strong enough passwore",
          }),
        ),
        "Invalid credentials",
      );
      assert.equal(
        await refusal(() =>
          signIn(ctx, {
            email: "nobody@example.test",
            password: "a strong enough password",
          }),
        ),
        "Invalid credentials",
      );
      // A second sign-up for the same address says the same thing.
      assert.equal(
        await refusal(() =>
          signUp(ctx, {
            email: "owner@example.test",
            password: "another strong password",
          }),
        ),
        "Invalid credentials",
      );

      // Under eight characters is not a password, which is the library's own rule.
      for (const password of ["", "short", "1234567", undefined, 12345678]) {
        assert.equal(
          await refusal(() =>
            signIn(ctx, { email: "owner@example.test", password }),
          ),
          "Invalid password",
          String(password),
        );
      }
      for (const email of [
        "",
        "   ",
        "no-at-sign",
        "a@b",
        "a b@c.test",
        null,
      ]) {
        assert.equal(
          await refusal(() =>
            signIn(ctx, { email, password: "a strong enough password" }),
          ),
          "Invalid email",
          String(email),
        );
      }
    });
  },
);

test(
  "logout is server side, and a revoked, expired or unknown token is refused",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const session = await createSession(ctx, userId);
      const cookieHeader = header(session.token, session.expiresAt);
      assert.equal(
        await requireWebUserId(ctx, { config: sessionConfig, cookieHeader }),
        userId,
      );

      // Sign out revokes the row, so clearing the cookie is not what ends the
      // session: a copy of the cookie stops working too.
      const { setCookie } = await signOut(ctx, {
        config: sessionConfig,
        cookieHeader,
      });
      assert.ok(setCookie.includes("Max-Age=0"));
      assert.equal(await resolveSessionToken(ctx, session.token), null);
      assert.equal(
        await refusal(() =>
          requireWebUserId(ctx, { config: sessionConfig, cookieHeader }),
        ),
        NOT_AUTHENTICATED,
      );
      // Signing out again is not an error.
      await signOut(ctx, { config: sessionConfig, cookieHeader });
    });

    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const session = await createSession(ctx, userId);
      // Read at a moment past the expiry rather than by waiting for one.
      const later = db.ctx(session.expiresAt + 1);
      assert.equal(await resolveSessionToken(later, session.token), null);
      assert.equal(
        await refusal(() =>
          requireWebPrincipal(later, {
            config: sessionConfig,
            cookieHeader: header(session.token, session.expiresAt),
          }),
        ),
        NOT_AUTHENTICATED,
      );
      // And an unknown or malformed token, including one of the right shape.
      for (const token of [null, "", "nope", "0".repeat(64), "z".repeat(64)]) {
        assert.equal(
          await resolveSessionToken(ctx, token),
          null,
          String(token),
        );
      }
    });
  },
);

test(
  "a session does not outlive its user, and every session can be ended at once",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const sessions = [
        await createSession(ctx, userId),
        await createSession(ctx, userId),
        await createSession(ctx, userId),
      ];
      // All but one, which is what a password change does.
      await revokeUserSessions(ctx, userId, sessions[0].sessionId);
      assert.notEqual(await resolveSessionToken(ctx, sessions[0].token), null);
      assert.equal(await resolveSessionToken(ctx, sessions[1].token), null);
      assert.equal(await resolveSessionToken(ctx, sessions[2].token), null);

      await revokeUserSessions(ctx, userId);
      assert.equal(await resolveSessionToken(ctx, sessions[0].token), null);
    });

    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const session = await createSession(ctx, userId);
      // The session row goes with the user, so a deleted account has no live
      // session to resolve at all.
      await ctx.client.query("DELETE FROM kith.users WHERE id = $1", [userId]);
      assert.equal(await resolveSessionToken(ctx, session.token), null);
      assert.equal(
        await refusal(() =>
          requireWebPrincipal(ctx, {
            config: sessionConfig,
            cookieHeader: header(session.token, session.expiresAt),
          }),
        ),
        NOT_AUTHENTICATED,
      );
      // A session cannot be opened for a user who is not there.
      assert.equal(
        await refusal(() => createSession(ctx, userId)),
        NOT_AUTHENTICATED,
      );
    });
  },
);

test(
  "changing a password rehashes it and ends every other session",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const created = await signUp(ctx, {
        email: "owner@example.test",
        password: "the first password",
      });
      const other = await createSession(ctx, created.userId);
      const before = (await getPasswordAccount(ctx, "owner@example.test"))
        .secret;

      // The current password is required, and a wrong one changes nothing.
      assert.equal(
        await refusal(() =>
          changePassword(ctx, {
            userId: created.userId,
            email: "owner@example.test",
            currentPassword: "not the first password",
            newPassword: "the second password",
          }),
        ),
        "Invalid credentials",
      );
      assert.equal(
        (await getPasswordAccount(ctx, "owner@example.test")).secret,
        before,
      );

      await changePassword(ctx, {
        userId: created.userId,
        email: "owner@example.test",
        currentPassword: "the first password",
        newPassword: "the second password",
        keepSessionId: created.sessionId,
      });
      const after = (await getPasswordAccount(ctx, "owner@example.test"))
        .secret;
      assert.notEqual(after, before);
      assert.equal(await verifyPassword(after, "the second password"), true);
      assert.equal(await verifyPassword(after, "the first password"), false);

      // The session that made the change survives; the other one does not.
      assert.notEqual(await resolveSessionToken(ctx, created.token), null);
      assert.equal(await resolveSessionToken(ctx, other.token), null);
    });
  },
);

test(
  "a session cookie is not a credential and an API key is not a session",
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
      const session = await createSession(ctx, userId);

      // The MCP surface takes a key hash. A session token is not one, even though
      // it is 64 hex characters, and even though it belongs to the same user.
      assert.equal(
        await refusal(() =>
          requireMcpPrincipal(ctx, { keyHash: session.token }),
        ),
        NOT_AUTHENTICATED,
      );
      assert.equal(
        await refusal(() =>
          requireMcpPrincipal(ctx, { rawKey: session.token }),
        ),
        NOT_AUTHENTICATED,
      );

      // The web surface takes a cookie. A raw API key in the cookie is not one,
      // and neither is the key's hash.
      for (const value of [
        key.rawKey,
        header(key.rawKey),
        header("a".repeat(64)),
      ]) {
        assert.equal(
          await refusal(() =>
            requireWebPrincipal(ctx, {
              config: sessionConfig,
              cookieHeader: value,
            }),
          ),
          NOT_AUTHENTICATED,
          String(value).slice(0, 24),
        );
      }
    });
  },
);

test("the expiry sweep removes expired sessions only", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const live = await createSession(ctx, userId);
    const stale = await createSession(ctx, userId);
    await ctx.client.query(
      "UPDATE kith.sessions SET expires_at = $2 WHERE id = $1",
      [stale.sessionId, new Date(ctx.now - 1000)],
    );
    assert.deepEqual(await removeExpiredSessions(ctx), { deleted: 1 });
    assert.notEqual(await resolveSessionToken(ctx, live.token), null);
    assert.equal(await resolveSessionToken(ctx, stale.token), null);
    assert.deepEqual(await removeExpiredSessions(ctx), { deleted: 0 });
    for (const limit of [0, -1, 1001, 1.5]) {
      assert.match(
        await refusal(() => removeExpiredSessions(ctx, limit)),
        /Session cleanup limit is invalid/,
      );
    }
  });
});

test("a revoked session stays revoked", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const session = await createSession(ctx, userId);
    await revokeSession(ctx, session.sessionId);
    const first = await ctx.client.query(
      "SELECT revoked_at FROM kith.sessions WHERE id = $1",
      [session.sessionId],
    );
    // A second revoke does not move the timestamp, so the audit trail keeps the
    // moment the session actually ended.
    await revokeSession(db.ctx(ctx.now + 60_000), session.sessionId);
    const second = await ctx.client.query(
      "SELECT revoked_at FROM kith.sessions WHERE id = $1",
      [session.sessionId],
    );
    assert.deepEqual(second.rows[0].revoked_at, first.rows[0].revoked_at);
  });
});

test(
  "resolving refreshes last_used_at, at most once per touch window",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const session = await createSession(ctx, userId);
      const lastUsedAt = async () =>
        (
          await ctx.client.query(
            "SELECT last_used_at FROM kith.sessions WHERE id = $1",
            [session.sessionId],
          )
        ).rows[0].last_used_at.getTime();
      const opened = await lastUsedAt();
      assert.equal(opened, ctx.now);

      // A read path never writes. That default is what keeps
      // `withKithReadTransaction`'s `READ ONLY` usable on a page that
      // authenticates: the server would refuse the write with 25006.
      await resolveSessionToken(
        db.ctx(ctx.now + SESSION_TOUCH_MIN_MS * 2),
        session.token,
      );
      assert.equal(await lastUsedAt(), opened);

      // Inside the window, an opted-in resolve still does not write: the column
      // is already accurate to within one window, and a session resolved on
      // every request must not mean a row written on every request.
      const early = db.ctx(ctx.now + SESSION_TOUCH_MIN_MS - 1);
      const unchanged = await resolveSessionToken(early, session.token, {
        touch: true,
      });
      assert.equal(unchanged.lastUsedAt, opened);
      assert.equal(await lastUsedAt(), opened);

      // Past the window it writes once, and the refreshed value is the one the
      // caller is handed rather than the stale one it read.
      const later = db.ctx(ctx.now + SESSION_TOUCH_MIN_MS);
      const touched = await resolveSessionToken(later, session.token, {
        touch: true,
      });
      assert.equal(touched.lastUsedAt, later.now);
      assert.equal(await lastUsedAt(), later.now);

      // And having written, the next resolve in the new window does not.
      await resolveSessionToken(db.ctx(later.now + 1), session.token, {
        touch: true,
      });
      assert.equal(await lastUsedAt(), later.now);
    });
  },
);

test(
  "a revoked session is never touched, and requireWebSession returns the session",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const session = await createSession(ctx, userId);
      const cookieHeader = header(session.token, session.expiresAt);

      const resolved = await requireWebSession(ctx, {
        config: sessionConfig,
        cookieHeader,
      });
      assert.equal(resolved.principal.userId, userId);
      assert.equal(resolved.session.id, session.sessionId);

      await revokeSession(ctx, session.sessionId);
      const later = db.ctx(ctx.now + SESSION_TOUCH_MIN_MS * 4);
      assert.equal(
        await refusal(() =>
          requireWebSession(later, {
            config: sessionConfig,
            cookieHeader,
            touch: true,
          }),
        ),
        NOT_AUTHENTICATED,
      );
      // The revoked row keeps the moment it was last genuinely used.
      const stored = await later.client.query(
        "SELECT last_used_at FROM kith.sessions WHERE id = $1",
        [session.sessionId],
      );
      assert.equal(stored.rows[0].last_used_at.getTime(), ctx.now);
    });
  },
);

test(
  "signing up creates the personal space records it documents",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const created = await signUp(ctx, {
        email: "personal@example.test",
        password: "a strong enough password",
      });

      // The space, the owner membership and the settings row, all in the same
      // transaction as the user row and the account row.
      const settings = await ctx.client.query(
        `SELECT s.kind, m.role, u.personal_space_id
           FROM kith.user_space_settings u
           JOIN kith.spaces s ON s.id = u.personal_space_id
           JOIN kith.space_members m
             ON m.space_id = s.id AND m.user_id = u.user_id
          WHERE u.user_id = $1`,
        [created.userId],
      );
      assert.equal(settings.rows.length, 1);
      assert.equal(settings.rows[0].kind, "personal");
      assert.equal(settings.rows[0].role, "owner");

      // And the sign-up route calling `ensurePersonalSpace` again, per section
      // 2.2 of the surface plan, is idempotent rather than a second space.
      assert.equal(
        await ensurePersonalSpace(ctx, created.userId),
        settings.rows[0].personal_space_id,
      );
      const spaces = await ctx.client.query(
        "SELECT count(*)::int AS count FROM kith.spaces WHERE created_by = $1",
        [created.userId],
      );
      assert.equal(spaces.rows[0].count, 1);
    });
  },
);
