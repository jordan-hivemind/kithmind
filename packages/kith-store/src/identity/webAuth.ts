// The web session: sign up, sign in, the cookie, and the port of
// `packages/convex/convex/lib/webAuth.ts`.
//
// This is the one credential whose implementation moves out of a maintained
// library and into this repository, which is why section 4.3 fixes the review
// scope in advance. What replaces what:
//
//   | Today                                       | Here                              |
//   | ------------------------------------------- | --------------------------------- |
//   | Convex Auth `Password` provider             | `signUp` / `signIn` below         |
//   | Lucia Scrypt secret in `authAccounts.secret`| the same hash, `./scrypt.ts`      |
//   | Convex `authSessions`, 10 year total        | `kith.sessions`, same 10 years    |
//   | Convex-issued JWT in browser storage        | one signed httpOnly cookie        |
//   | `getAuthUserId` plus an issuer check        | `requireWebPrincipal` below       |
//
// The issuer check is the part most likely to be read as redundant and deleted,
// so the reason it existed is worth keeping: `getAuthUserId` derived the account
// from the token's subject alone and ignored the issuer, so a short-lived
// identity minted from an API key was accepted on the dashboard surface, where
// `apiKeys.create` can issue further credentials. `requireWebUserId` refused
// those from one direction and `requireMcpPrincipal` from the other.
//
// The port deletes the JWT bridge (section 1.5: "there is no second backend to
// authenticate to"), which removes the confusion at the root rather than
// re-checking an issuer: a web session is a session row reached by a cookie, an
// MCP caller is an API key hash, and neither function can be handed the other's
// credential because they do not read the same input. The separation is
// structural here, and the tests assert it from both sides anyway.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { newKithId } from "../ids.js";
import { userExists, webPrincipal, type Principal } from "./authorization.js";
import { at, exec, ms, row, type IdentityCtx } from "./db.js";
import { IdentityError, notAuthenticated } from "./errors.js";
import { sha256 as sha256Hex } from "../hash.js";
import { hashPassword, verifyPassword } from "./scrypt.js";

/** The provider id the stored accounts already carry. */
export const PASSWORD_PROVIDER = "password";

/** Session lifetime, unchanged: effectively permanent until explicit logout. */
export const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 365 * 10;

/** The cookie name. Host-prefixed, so a subdomain cannot set it. */
export const SESSION_COOKIE_NAME = "__Host-kith_session";

/** The library's own rule, kept: under 8 characters is not a password. */
const MIN_PASSWORD_LENGTH = 8;

/** What the HMAC key must be, so a short or absent secret cannot be used. */
const MIN_SECRET_LENGTH = 32;

export type SessionConfig = {
  /**
   * The cookie signing key. Read from the environment by the caller, never here:
   * a library that reads its own secret is a library that silently works with
   * the wrong one.
   */
  readonly secret: string;
  /** Set false only for a plain-HTTP local run. `__Host-` requires true. */
  readonly secure?: boolean;
};

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: number;
  revokedAt: number | null;
};

function requireSecret(config: SessionConfig): string {
  if (
    typeof config.secret !== "string" ||
    config.secret.length < MIN_SECRET_LENGTH
  ) {
    throw new IdentityError("Session secret is not configured");
  }
  return config.secret;
}

function sign(config: SessionConfig, token: string): string {
  return createHmac("sha256", requireSecret(config))
    .update(token)
    .digest("base64url");
}

/**
 * The cookie value: `v1.<token>.<mac>`.
 *
 * The token alone would be enough to authenticate, because it is 32 random bytes
 * looked up by hash and revocable server side. The MAC is what lets a forged or
 * truncated cookie be rejected before any database work, and it is the "signed
 * cookie" section 1.5 asks for. Both halves are checked: a valid MAC over an
 * unknown token still fails the lookup, and a known token with a bad MAC never
 * reaches the lookup.
 */
export function serializeSessionToken(
  config: SessionConfig,
  token: string,
): string {
  return `v1.${token}.${sign(config, token)}`;
}

/** The token inside a cookie value, or null when the MAC does not verify. */
export function parseSessionToken(
  config: SessionConfig,
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, token, mac] = parts as [string, string, string];
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const expected = Buffer.from(sign(config, token), "utf8");
  const presented = Buffer.from(mac, "utf8");
  if (expected.length !== presented.length) return null;
  return timingSafeEqual(expected, presented) ? token : null;
}

/** The `Set-Cookie` value for a fresh session. */
export function sessionCookie(
  config: SessionConfig,
  token: string,
  expiresAt: number,
): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${serializeSessionToken(config, token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (config.secure !== false) attributes.push("Secure");
  return attributes.join("; ");
}

/** The `Set-Cookie` value that ends a session in the browser. */
export function clearedSessionCookie(config: SessionConfig): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (config.secure !== false) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * The session cookie's raw value out of a `Cookie` header.
 *
 * Written out rather than taken from a parser dependency because the header is a
 * trust boundary: only the exact cookie name matches, a repeated cookie takes the
 * first value as browsers send it, and nothing else in the header is read.
 */
export function readSessionCookie(
  header: string | null | undefined,
): string | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

/** A new session row and the token that reaches it. */
export async function createSession(
  ctx: IdentityCtx,
  userId: string,
): Promise<{ sessionId: string; token: string; expiresAt: number }> {
  if (!(await userExists(ctx, userId))) notAuthenticated();
  const token = randomBytes(32).toString("hex");
  const sessionId = newKithId();
  const expiresAt = ctx.now + SESSION_DURATION_MS;
  await exec(
    ctx,
    `INSERT INTO kith.sessions (id, user_id, token_hash, expires_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, userId, sha256Hex(token), at(expiresAt), at(ctx.now)],
  );
  return { sessionId, token, expiresAt };
}

/**
 * The live session a token names, or null.
 *
 * Four reasons to return null and every one of them is a test: the token is not
 * a token, no session has that hash, the session expired, the session was
 * revoked. The user row is checked by the caller, so a deleted user's live
 * session still fails to authenticate.
 */
export async function resolveSessionToken(
  ctx: IdentityCtx,
  token: string | null,
): Promise<SessionRecord | null> {
  if (token === null || !/^[0-9a-f]{64}$/.test(token)) return null;
  const record = await row<{
    id: string;
    user_id: string;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    ctx,
    `SELECT id, user_id, expires_at, revoked_at FROM kith.sessions
       WHERE token_hash = $1`,
    [sha256Hex(token)],
  );
  if (!record) return null;
  const session: SessionRecord = {
    id: record.id,
    userId: record.user_id,
    expiresAt: ms(record.expires_at)!,
    revokedAt: ms(record.revoked_at),
  };
  if (session.revokedAt !== null || session.expiresAt <= ctx.now) return null;
  return session;
}

/** Revokes one session. Logout, server side, not a cleared cookie. */
export async function revokeSession(
  ctx: IdentityCtx,
  sessionId: string,
): Promise<void> {
  await exec(
    ctx,
    `UPDATE kith.sessions SET revoked_at = $2
       WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, at(ctx.now)],
  );
}

/** Revokes every session a user holds, optionally keeping one. */
export async function revokeUserSessions(
  ctx: IdentityCtx,
  userId: string,
  except?: string,
): Promise<void> {
  await exec(
    ctx,
    `UPDATE kith.sessions SET revoked_at = $2
       WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR id <> $3)`,
    [userId, at(ctx.now), except ?? null],
  );
}

/** Deletes sessions that expired. The sweep P2-39j schedules. */
export async function removeExpiredSessions(
  ctx: IdentityCtx,
  limit = 100,
): Promise<{ deleted: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Session cleanup limit is invalid");
  }
  const deleted = await row<{ deleted: string }>(
    ctx,
    `WITH doomed AS (
       SELECT id FROM kith.sessions WHERE expires_at < $1 LIMIT $2
     ), removed AS (
       DELETE FROM kith.sessions WHERE id IN (SELECT id FROM doomed) RETURNING 1
     ) SELECT count(*)::text AS deleted FROM removed`,
    [at(ctx.now), limit],
  );
  return { deleted: Number(deleted?.deleted ?? 0) };
}

/**
 * Session identity for the dashboard's own function surface.
 *
 * The replacement for `requireWebUserId`: the cookie is the only input, so there
 * is no issuer to confuse and no API-key-minted identity that can arrive here.
 */
export async function requireWebUserId(
  ctx: IdentityCtx,
  args: { config: SessionConfig; cookieHeader: string | null | undefined },
): Promise<string> {
  const token = parseSessionToken(
    args.config,
    readSessionCookie(args.cookieHeader),
  );
  const session = await resolveSessionToken(ctx, token);
  if (!session) notAuthenticated();
  return session.userId;
}

/** `requireWebUserId` plus the live user row, as the Convex helper did. */
export async function requireWebPrincipal(
  ctx: IdentityCtx,
  args: { config: SessionConfig; cookieHeader: string | null | undefined },
): Promise<Principal> {
  const userId = await requireWebUserId(ctx, args);
  if (!(await userExists(ctx, userId))) notAuthenticated();
  return webPrincipal(userId);
}

export type AuthAccount = {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  secret: string | null;
  emailVerified: string | null;
};

/** The password account for an email address, or null. */
export async function getPasswordAccount(
  ctx: IdentityCtx,
  email: string,
): Promise<AuthAccount | null> {
  const record = await row<{
    id: string;
    user_id: string;
    provider: string;
    provider_account_id: string;
    secret: string | null;
    email_verified: string | null;
  }>(
    ctx,
    `SELECT id, user_id, provider, provider_account_id, secret, email_verified
       FROM kith.auth_accounts WHERE provider = $1 AND provider_account_id = $2`,
    [PASSWORD_PROVIDER, email],
  );
  return record
    ? {
        id: record.id,
        userId: record.user_id,
        provider: record.provider,
        providerAccountId: record.provider_account_id,
        secret: record.secret,
        emailVerified: record.email_verified,
      }
    : null;
}

function requireValidPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    // The library's message, unchanged, so a client already matching on it
    // continues to.
    throw new IdentityError("Invalid password");
  }
  return password;
}

function requireValidEmail(email: unknown): string {
  if (
    typeof email !== "string" ||
    email.trim() !== email ||
    email.length === 0 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new IdentityError("Invalid email");
  }
  return email;
}

/** A new account, its user, its personal space records and a session. */
export async function signUp(
  ctx: IdentityCtx,
  args: { email: string; password: string; name?: string },
): Promise<{
  userId: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}> {
  const email = requireValidEmail(args.email);
  const password = requireValidPassword(args.password);
  // Same words as a wrong password on sign-in would give, so this does not
  // become an account-existence oracle.
  if (await getPasswordAccount(ctx, email)) {
    throw new IdentityError("Invalid credentials");
  }
  const userId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.users (id, email, name) VALUES ($1, $2, $3)`,
    [userId, email, args.name ?? null],
  );
  await exec(
    ctx,
    `INSERT INTO kith.auth_accounts
       (id, user_id, provider, provider_account_id, secret)
       VALUES ($1, $2, $3, $4, $5)`,
    [
      newKithId(),
      userId,
      PASSWORD_PROVIDER,
      email,
      await hashPassword(password),
    ],
  );
  return { userId, ...(await createSession(ctx, userId)) };
}

/**
 * Verifies a password against the stored Scrypt hash and opens a session.
 *
 * One message for an unknown account and for a wrong password. The work is not
 * constant time between those two cases -- a missing account skips the KDF -- and
 * that is the same shape the library had; closing the timing channel is a
 * separate change from this port and is noted rather than smuggled in.
 */
export async function signIn(
  ctx: IdentityCtx,
  args: { email: string; password: string },
): Promise<{
  userId: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}> {
  const email = requireValidEmail(args.email);
  const password = requireValidPassword(args.password);
  const account = await getPasswordAccount(ctx, email);
  if (!account || !(await verifyPassword(account.secret, password))) {
    throw new IdentityError("Invalid credentials");
  }
  if (!(await userExists(ctx, account.userId))) {
    throw new IdentityError("Invalid credentials");
  }
  return {
    userId: account.userId,
    ...(await createSession(ctx, account.userId)),
  };
}

/** Changes a password and ends every other session, as the library did. */
export async function changePassword(
  ctx: IdentityCtx,
  args: {
    userId: string;
    email: string;
    currentPassword: string;
    newPassword: string;
    keepSessionId?: string;
  },
): Promise<void> {
  const email = requireValidEmail(args.email);
  const next = requireValidPassword(args.newPassword);
  const account = await getPasswordAccount(ctx, email);
  if (
    !account ||
    account.userId !== args.userId ||
    !(await verifyPassword(account.secret, args.currentPassword))
  ) {
    throw new IdentityError("Invalid credentials");
  }
  await exec(ctx, `UPDATE kith.auth_accounts SET secret = $2 WHERE id = $1`, [
    account.id,
    await hashPassword(next),
  ]);
  await revokeUserSessions(ctx, account.userId, args.keepSessionId);
}

/** Ends the session the cookie names. Returns the cookie that clears it. */
export async function signOut(
  ctx: IdentityCtx,
  args: { config: SessionConfig; cookieHeader: string | null | undefined },
): Promise<{ setCookie: string }> {
  const token = parseSessionToken(
    args.config,
    readSessionCookie(args.cookieHeader),
  );
  const session = await resolveSessionToken(ctx, token);
  if (session) await revokeSession(ctx, session.id);
  return { setCookie: clearedSessionCookie(args.config) };
}
