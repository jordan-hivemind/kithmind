// The six denial checks P2-39b's parity harness left `pending`.
//
// `packages/kith-migrate/src/parity.ts` declares `AuthDenialSurface` -- six
// zero-argument predicates -- and reports check 6 as pending until something
// supplies it, because "all five need the session/credential/read surface P2-39c
// builds". This is that surface.
//
// Each check builds its own synthetic principals against a real database, drives
// the real service functions, and returns true only when the call was refused for
// the reason the check is named after. Two properties make them worth running
// inside the parity harness rather than only as tests:
//
//   * They are the negative half of the cutover gate. The counts and the hashes
//     prove the data arrived; these prove the authorization did.
//   * They exercise the same functions the web and MCP surfaces call, so a
//     predicate that starts passing for the wrong reason -- a function that stops
//     throwing, an error that changes shape -- shows up as a parity failure.
//
// `denied` is deliberately narrow: it returns true only for the exact refusal
// expected, so a check cannot pass because something unrelated threw. Every
// fixture is synthetic and every id is generated.

import { randomBytes } from "node:crypto";

import { sha256 } from "../hash.js";
import { newKithId } from "../ids.js";
import {
  getAuthorizedReadSpaceIds,
  requireSpaceAccess,
  webPrincipal,
  type Capability,
} from "./authorization.js";
import { exec, identityCtx, type IdentityCtx } from "./db.js";
import { IdentityError } from "./errors.js";
import { requireMcpPrincipal } from "./apiKeys.js";
import {
  requireWebPrincipal,
  revokeSession,
  sessionCookie,
  createSession,
  type SessionConfig,
} from "./webAuth.js";

/** The six predicates `kith-migrate`'s `AuthDenialSurface` expects. */
export type AuthDenialSurface = {
  revokedKeyDenied(): Promise<boolean>;
  writeWithoutCapabilityDenied(): Promise<boolean>;
  crossSpaceKeyDenied(): Promise<boolean>;
  removedMemberDenied(): Promise<boolean>;
  staleSessionDenied(): Promise<boolean>;
  crossSpaceReadReturnsNothing(): Promise<boolean>;
};

/**
 * True when `work` was refused with exactly `message`.
 *
 * Not "threw something": a check that accepts any error passes when the code is
 * broken in an unrelated way, which is the failure mode that makes a denial test
 * worthless.
 */
async function denied(
  work: () => Promise<unknown>,
  message = "Space not found",
): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    return error instanceof IdentityError && error.message === message;
  }
}

const SESSION_CONFIG: SessionConfig = {
  // A per-run key: these checks sign and verify their own cookies and nothing
  // outside this process ever sees one.
  secret: randomBytes(32).toString("hex"),
  secure: false,
};

type Fixture = {
  userId: string;
  otherUserId: string;
  spaceId: string;
  otherSpaceId: string;
};

/** A user, a space they own, and a second user with a space of their own. */
async function fixture(ctx: IdentityCtx): Promise<Fixture> {
  const made: Record<string, string> = {};
  for (const who of ["userId", "otherUserId"] as const) {
    made[who] = newKithId();
    await exec(ctx, "INSERT INTO kith.users (id) VALUES ($1)", [made[who]]);
  }
  const spaces: string[] = [];
  for (const owner of [made.userId!, made.otherUserId!]) {
    const spaceId = newKithId();
    await exec(
      ctx,
      `INSERT INTO kith.spaces (id, kind, name, created_by)
         VALUES ($1, 'shared', 'Synthetic', $2)`,
      [spaceId, owner],
    );
    await exec(
      ctx,
      `INSERT INTO kith.space_members (id, space_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')`,
      [newKithId(), spaceId, owner],
    );
    spaces.push(spaceId);
  }
  return {
    userId: made.userId!,
    otherUserId: made.otherUserId!,
    spaceId: spaces[0]!,
    otherSpaceId: spaces[1]!,
  };
}

/** An API key with the given capabilities and space grants. Returns the raw key. */
async function keyFor(
  ctx: IdentityCtx,
  userId: string,
  capabilities: readonly Capability[],
  spaceIds: readonly string[],
): Promise<{ id: string; rawKey: string }> {
  const rawKey = `ob_${randomBytes(32).toString("hex")}`;
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.api_keys (id, user_id, key_hash, key_prefix, name, capabilities)
       VALUES ($1, $2, $3, $4, 'synthetic', $5::jsonb)`,
    [
      id,
      userId,
      sha256(rawKey),
      rawKey.slice(0, 11),
      JSON.stringify([...capabilities]),
    ],
  );
  for (const spaceId of spaceIds) {
    await exec(
      ctx,
      `INSERT INTO kith.api_key_spaces (id, api_key_id, space_id) VALUES ($1, $2, $3)`,
      [newKithId(), id, spaceId],
    );
  }
  return { id, rawKey };
}

/**
 * The denial surface, as the parity harness should use it: one transaction per
 * check, always rolled back.
 *
 * Rolled back rather than committed, and this is the part that matters. The
 * harness runs its six checks alongside a row-count check over every migrated
 * table, so a surface that committed its synthetic users and spaces would make
 * the counts disagree with the export and fail a different check than the one it
 * was testing. Nothing here needs to persist: every predicate asserts a refusal.
 */
export function authDenialSurfaceOnPool(pool: {
  connect(): Promise<{
    query(sql: string, values?: unknown[]): Promise<unknown>;
    release(): void;
  }>;
}): AuthDenialSurface {
  return authDenialSurface(async (work) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      try {
        return await work(identityCtx(client as never));
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
  });
}

/**
 * The denial surface over a caller-supplied unit of work.
 *
 * `run` is what gives each check its own transaction, and a caller that is not
 * the parity harness has to decide whether that transaction commits.
 * `authDenialSurfaceOnPool` above is the answer for the harness; a test that wants
 * to watch the statements can pass its own.
 */
export function authDenialSurface(
  run: <T>(work: (ctx: IdentityCtx) => Promise<T>) => Promise<T>,
): AuthDenialSurface {
  return {
    /** A key deleted between two requests loses access on the second. */
    async revokedKeyDenied() {
      return await run(async (ctx) => {
        const f = await fixture(ctx);
        const key = await keyFor(ctx, f.userId, ["read", "write"], [f.spaceId]);
        // Works first, to prove the denial is the revocation and not the fixture.
        const principal = await requireMcpPrincipal(ctx, {
          rawKey: key.rawKey,
        });
        await requireSpaceAccess(ctx, principal, f.spaceId, "read");
        await exec(ctx, "DELETE FROM kith.api_keys WHERE id = $1", [key.id]);
        return (
          (await denied(
            () => requireMcpPrincipal(ctx, { rawKey: key.rawKey }),
            "Not authenticated",
          )) &&
          // And the retained snapshot is refused too: a principal that was
          // resolved before the revocation must not still work.
          (await denied(
            () => requireSpaceAccess(ctx, principal, f.spaceId, "read"),
            "Not authenticated",
          ))
        );
      });
    },

    /** A read-only key cannot write, in a space it is fully granted. */
    async writeWithoutCapabilityDenied() {
      return await run(async (ctx) => {
        const f = await fixture(ctx);
        const key = await keyFor(ctx, f.userId, ["read"], [f.spaceId]);
        const principal = await requireMcpPrincipal(ctx, {
          rawKey: key.rawKey,
        });
        await requireSpaceAccess(ctx, principal, f.spaceId, "read");
        return await denied(() =>
          requireSpaceAccess(ctx, principal, f.spaceId, "write"),
        );
      });
    },

    /**
     * A key scoped to one space cannot reach another the same user can.
     *
     * The user is a member of both, so this isolates the credential's grant from
     * the user's authority: the narrowing has to hold even when the person behind
     * the key is allowed in.
     */
    async crossSpaceKeyDenied() {
      return await run(async (ctx) => {
        const f = await fixture(ctx);
        const second = newKithId();
        await exec(
          ctx,
          `INSERT INTO kith.spaces (id, kind, name, created_by)
             VALUES ($1, 'shared', 'Second', $2)`,
          [second, f.userId],
        );
        await exec(
          ctx,
          `INSERT INTO kith.space_members (id, space_id, user_id, role)
             VALUES ($1, $2, $3, 'owner')`,
          [newKithId(), second, f.userId],
        );
        const key = await keyFor(ctx, f.userId, ["read", "write"], [f.spaceId]);
        const principal = await requireMcpPrincipal(ctx, {
          rawKey: key.rawKey,
        });
        await requireSpaceAccess(ctx, principal, f.spaceId, "read");
        // The user can read it; the key cannot.
        await requireSpaceAccess(ctx, webPrincipal(f.userId), second, "read");
        return await denied(() =>
          requireSpaceAccess(ctx, principal, second, "read"),
        );
      });
    },

    /** Removing the membership removes the access within one request. */
    async removedMemberDenied() {
      return await run(async (ctx) => {
        const f = await fixture(ctx);
        const memberId = newKithId();
        await exec(
          ctx,
          `INSERT INTO kith.space_members (id, space_id, user_id, role)
             VALUES ($1, $2, $3, 'editor')`,
          [memberId, f.spaceId, f.otherUserId],
        );
        const key = await keyFor(
          ctx,
          f.otherUserId,
          ["read", "write"],
          [f.spaceId],
        );
        const principal = await requireMcpPrincipal(ctx, {
          rawKey: key.rawKey,
        });
        await requireSpaceAccess(ctx, principal, f.spaceId, "write");
        await exec(ctx, "DELETE FROM kith.space_members WHERE id = $1", [
          memberId,
        ]);
        return (
          // The key's grant still names the space; the membership is what is gone.
          (await denied(() =>
            requireSpaceAccess(ctx, principal, f.spaceId, "write"),
          )) &&
          (await denied(() =>
            requireSpaceAccess(
              ctx,
              webPrincipal(f.otherUserId),
              f.spaceId,
              "read",
            ),
          ))
        );
      });
    },

    /**
     * A revoked, expired or forged cookie does not authenticate.
     *
     * All three, because "stale" has three shapes and only one of them is the
     * one a logout produces.
     */
    async staleSessionDenied() {
      return await run(async (ctx) => {
        const f = await fixture(ctx);
        const session = await createSession(ctx, f.userId);
        const cookieHeader = `${
          sessionCookie(SESSION_CONFIG, session.token, session.expiresAt).split(
            ";",
          )[0]
        }`;
        const live = await requireWebPrincipal(ctx, {
          config: SESSION_CONFIG,
          cookieHeader,
        });
        if (live.userId !== f.userId) return false;

        await revokeSession(ctx, session.sessionId);
        const revokedDenied = await denied(
          () =>
            requireWebPrincipal(ctx, { config: SESSION_CONFIG, cookieHeader }),
          "Not authenticated",
        );

        // Expired: a second session, read back at a later `now`.
        const future = await createSession(ctx, f.userId);
        const futureHeader = sessionCookie(
          SESSION_CONFIG,
          future.token,
          future.expiresAt,
        ).split(";")[0]!;
        const laterCtx = identityCtx(ctx.client, future.expiresAt + 1);
        const expiredDenied = await denied(
          () =>
            requireWebPrincipal(laterCtx, {
              config: SESSION_CONFIG,
              cookieHeader: futureHeader,
            }),
          "Not authenticated",
        );

        // Forged: the right token, signed with the wrong key.
        const forged = sessionCookie(
          { secret: randomBytes(32).toString("hex"), secure: false },
          future.token,
          future.expiresAt,
        ).split(";")[0]!;
        const forgedDenied = await denied(
          () =>
            requireWebPrincipal(ctx, {
              config: SESSION_CONFIG,
              cookieHeader: forged,
            }),
          "Not authenticated",
        );

        return revokedDenied && expiredDenied && forgedDenied;
      });
    },

    /**
     * The read surface returns nothing cross-space rather than erring.
     *
     * Two halves, because a read path can leak either way: the authorized set
     * must exclude a space the principal cannot reach, and an explicit request
     * for that space must be refused with the same words an unknown id gets.
     */
    async crossSpaceReadReturnsNothing() {
      return await run(async (ctx) => {
        const f = await fixture(ctx);
        const key = await keyFor(ctx, f.userId, ["read"], [f.spaceId]);
        const principal = await requireMcpPrincipal(ctx, {
          rawKey: key.rawKey,
        });
        const authorized = await getAuthorizedReadSpaceIds(ctx, principal);
        if (authorized.length !== 1 || authorized[0] !== f.spaceId)
          return false;
        if (authorized.includes(f.otherSpaceId)) return false;
        // An unknown id and an inaccessible one are indistinguishable.
        const unknown = newKithId();
        return (
          (await denied(
            () => getAuthorizedReadSpaceIds(ctx, principal, [f.otherSpaceId]),
            "Space not found",
          )) &&
          (await denied(
            () => getAuthorizedReadSpaceIds(ctx, principal, [unknown]),
            "Space not found",
          ))
        );
      });
    },
  };
}
