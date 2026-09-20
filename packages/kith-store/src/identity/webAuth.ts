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

import { KITH_ID, newKithId } from "../ids.js";
import {
  ensurePersonalSpace,
  userExists,
  webPrincipal,
  type Principal,
} from "./authorization.js";
import { at, exec, ms, row, rows, type IdentityCtx } from "./db.js";
import { IdentityError, notAuthenticated } from "./errors.js";
import { sha256 as sha256Hex } from "../hash.js";
import { hashPassword, verifyPassword } from "./scrypt.js";

/** The provider id the stored accounts already carry. */
export const PASSWORD_PROVIDER = "password";

/** Google accounts are keyed by the immutable OpenID Connect `sub` claim. */
export const GOOGLE_PROVIDER = "google";

/** Session lifetime, unchanged: effectively permanent until explicit logout. */
export const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 365 * 10;

/** The cookie name. Host-prefixed, so a subdomain cannot set it. */
export const SESSION_COOKIE_NAME = "__Host-kith_session";

/** Plain-HTTP development cannot issue a valid `__Host-` cookie. */
export const DEVELOPMENT_SESSION_COOKIE_NAME = "kith_session";

/**
 * How stale `kith.sessions.last_used_at` may get before a resolve refreshes it.
 *
 * Five minutes. The column had no writer at all before P2-39i -- it was set at
 * insert and never updated -- so every session looked last used at the moment it
 * was created, which is the wrong answer for both of its readers: the owner
 * looking at which sessions are still in use, and any future idle-session
 * policy built on it.
 *
 * Refreshing it on every resolve is the obvious fix and the wrong one: a session
 * is resolved once per page load and once per authenticated request, so an
 * unthrottled refresh turns every read into a write, takes a row lock on the hot
 * session row for the length of the request, and makes the write rate a function
 * of traffic rather than of anything anyone wants to know.
 *
 * Five minutes bounds that to at most 12 writes an hour per session no matter
 * how many requests arrive, while keeping the column accurate to within one
 * window. Nothing reads it at finer resolution than "recently, or not": a
 * shorter window would buy precision no consumer uses, and a longer one starts
 * to make a session used twenty minutes ago indistinguishable from one used only
 * at sign-in, which is the state this fixes.
 */
export const SESSION_TOUCH_MIN_MS = 5 * 60 * 1000;

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
  lastUsedAt: number | null;
  revokedAt: number | null;
};

/**
 * Whether a resolve may refresh `last_used_at`.
 *
 * Off by default, and that default is the security-relevant part rather than a
 * convenience. A read path runs inside `withKithReadTransaction`, which issues
 * `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, and the server refuses any
 * write under it with SQLSTATE 25006. A resolve that wrote unconditionally
 * would therefore turn every read-only page into a 25006 failure, and the
 * version of this that "fixed" that by catching the error would abort the
 * transaction anyway, because a failed statement poisons the whole one.
 *
 * So the caller says. A route or a page already inside a read-write
 * `withKithTransaction` passes `touch: true`; anything read-only leaves it
 * alone and reads a `last_used_at` that is at most `SESSION_TOUCH_MIN_MS`
 * stale. The decision is visible at each call site instead of being a property
 * of a function three layers down.
 */
export type SessionResolveOptions = {
  readonly touch?: boolean;
};

/** Production and development use distinct names, so neither accepts the other. */
export function sessionCookieName(
  config: Pick<SessionConfig, "secure">,
): string {
  return config.secure === false
    ? DEVELOPMENT_SESSION_COOKIE_NAME
    : SESSION_COOKIE_NAME;
}

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
    `${sessionCookieName(config)}=${serializeSessionToken(config, token)}`,
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
    `${sessionCookieName(config)}=`,
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
  config: Pick<SessionConfig, "secure"> = {},
): string | null {
  if (typeof header !== "string") return null;
  const name = sessionCookieName(config);
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
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
  options: SessionResolveOptions = {},
): Promise<SessionRecord | null> {
  if (token === null || !/^[0-9a-f]{64}$/.test(token)) return null;
  const record = await row<{
    id: string;
    user_id: string;
    expires_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    ctx,
    `SELECT id, user_id, expires_at, last_used_at, revoked_at FROM kith.sessions
       WHERE token_hash = $1`,
    [sha256Hex(token)],
  );
  if (!record) return null;
  const session: SessionRecord = {
    id: record.id,
    userId: record.user_id,
    expiresAt: ms(record.expires_at)!,
    lastUsedAt: ms(record.last_used_at),
    revokedAt: ms(record.revoked_at),
  };
  if (session.revokedAt !== null || session.expiresAt <= ctx.now) return null;
  // Only a live session is touched. A revoked or expired one keeps the moment
  // it was last genuinely used, which is what makes the column readable after
  // the fact.
  if (options.touch === true) return await touchSession(ctx, session);
  return session;
}

/**
 * Refreshes `last_used_at` when it is at least `SESSION_TOUCH_MIN_MS` stale,
 * and returns the session as it now stands.
 *
 * The throttle is in the `WHERE` as well as in the branch above it, so two
 * concurrent requests reading the same stale row cannot both write: the second
 * one's `UPDATE` matches nothing and it keeps the value it already had.
 */
export async function touchSession(
  ctx: IdentityCtx,
  session: SessionRecord,
): Promise<SessionRecord> {
  if (
    session.lastUsedAt !== null &&
    ctx.now - session.lastUsedAt < SESSION_TOUCH_MIN_MS
  ) {
    return session;
  }
  const updated = await row<{ last_used_at: Date | null }>(
    ctx,
    `UPDATE kith.sessions SET last_used_at = $2
       WHERE id = $1
         AND revoked_at IS NULL
         AND (last_used_at IS NULL OR last_used_at <= $3)
       RETURNING last_used_at`,
    [session.id, at(ctx.now), at(ctx.now - SESSION_TOUCH_MIN_MS)],
  );
  if (!updated) return session;
  return { ...session, lastUsedAt: ms(updated.last_used_at) };
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
  args: SessionRequest,
): Promise<string> {
  return (await requireWebSession(ctx, args)).session.userId;
}

/**
 * The authenticated caller, with the user's own unnarrowed authority.
 *
 * Both this and `requireWebUserId` check the live user row, as the Convex
 * helper did. `requireWebUserId` did not before P2-39i; it does now, because
 * two entry points to one credential that disagree about whether a deleted
 * user's session still authenticates is exactly the kind of difference nobody
 * notices until it matters.
 */
export async function requireWebPrincipal(
  ctx: IdentityCtx,
  args: SessionRequest,
): Promise<Principal> {
  return (await requireWebSession(ctx, args)).principal;
}

/** What every authenticated entry point takes: the key and the cookie header. */
export type SessionRequest = SessionResolveOptions & {
  config: SessionConfig;
  cookieHeader: string | null | undefined;
};

/**
 * The one path from a cookie to an authenticated caller: parse, resolve, check
 * the live user row.
 *
 * `requireWebUserId` and `requireWebPrincipal` are both this function, so there
 * is exactly one place where a cookie becomes authority and no second
 * implementation to keep in step. It also returns the session itself, which
 * `change-password` needs in order to keep the caller signed in on the session
 * they are changing the password from while revoking every other one; deriving
 * that by resolving the same token twice would be a second read of the same row
 * that could, on a non-repeatable-read isolation level, disagree with the first.
 */
export async function requireWebSession(
  ctx: IdentityCtx,
  args: SessionRequest,
): Promise<{ principal: Principal; session: SessionRecord }> {
  const token = parseSessionToken(
    args.config,
    readSessionCookie(args.cookieHeader, args.config),
  );
  const session = await resolveSessionToken(ctx, token, {
    touch: args.touch,
  });
  if (!session) notAuthenticated();
  if (!(await userExists(ctx, session.userId))) notAuthenticated();
  return { principal: webPrincipal(session.userId), session };
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

/** The Google identity with this immutable provider subject, or null. */
export async function getGoogleAccount(
  ctx: IdentityCtx,
  providerAccountId: string,
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
    [GOOGLE_PROVIDER, providerAccountId],
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

async function googleAccountsForUser(
  ctx: IdentityCtx,
  userId: string,
): Promise<AuthAccount[]> {
  const records = await rows<{
    id: string;
    user_id: string;
    provider: string;
    provider_account_id: string;
    secret: string | null;
    email_verified: string | null;
  }>(
    ctx,
    `SELECT id, user_id, provider, provider_account_id, secret, email_verified
       FROM kith.auth_accounts
      WHERE provider = $1 AND user_id = $2
      ORDER BY created_at, id
      LIMIT 2`,
    [GOOGLE_PROVIDER, userId],
  );
  return records.map((record) => ({
    id: record.id,
    userId: record.user_id,
    provider: record.provider,
    providerAccountId: record.provider_account_id,
    secret: record.secret,
    emailVerified: record.email_verified,
  }));
}

/** Whether this Kith user has exactly one Google identity linked. */
export async function isGoogleAccountLinked(
  ctx: IdentityCtx,
  userId: string,
): Promise<boolean> {
  const accounts = await googleAccountsForUser(ctx, userId);
  // Multiple identities are not a state the linking path creates. Fail closed
  // rather than letting the UI imply that an ambiguous identity is healthy.
  if (accounts.length > 1) throw new IdentityError("Invalid credentials");
  return accounts.length === 1;
}

function requireGoogleSubject(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new IdentityError("Invalid credentials");
  }
  return value;
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

/**
 * A new account, its user, its personal space records and a session.
 *
 * The personal space records are created here rather than only at the route,
 * which is the defect P2-39i's plan found in section 1.5: this doc comment
 * already promised them and the function did not create them. Both fixes keep
 * one transaction per sign-up, because the route wraps the whole thing in one
 * `withKithTransaction` either way, so that is not what decides it. What decides
 * it is that this is the only place a `kith.users` row is created. If the
 * personal space is the caller's job then every future creator of a user -- a
 * seed script, a test, an invitation path -- has to remember a second call, and
 * forgetting it fails silently: the user signs in, and the missing
 * `user_space_settings` row surfaces much later and somewhere else as "Personal
 * space is not configured". Making it unconditional here makes that
 * unrepresentable.
 *
 * `ensurePersonalSpace` is idempotent, so the sign-up route calling it again per
 * section 2.2 of the surface plan stays correct and costs one extra read in the
 * same transaction.
 */
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
  await ensurePersonalSpace(ctx, userId);
  return { userId, ...(await createSession(ctx, userId)) };
}

/**
 * Links one verified Google identity to an already authenticated Kith user.
 *
 * The caller proves the Kith side by resolving the live web session before it
 * calls this function. The Google callback proves the provider side with a
 * signed ID token. Email is retained as verified provider metadata, but is not
 * account authority: it may differ from the password address and can change
 * without changing Google's immutable `sub`.
 */
export async function linkGoogleAccount(
  ctx: IdentityCtx,
  args: { userId: string; providerAccountId: string; verifiedEmail: string },
): Promise<void> {
  const providerAccountId = requireGoogleSubject(args.providerAccountId);
  const verifiedEmail = requireValidEmail(args.verifiedEmail);
  if (!(await userExists(ctx, args.userId))) {
    throw new IdentityError("Invalid credentials");
  }

  const subjectAccount = await getGoogleAccount(ctx, providerAccountId);
  if (subjectAccount) {
    // A retry of the same completed callback is harmless. The same provider
    // identity can never move between Kith users through this path.
    if (subjectAccount.userId === args.userId) return;
    throw new IdentityError("Invalid credentials");
  }

  const userAccounts = await googleAccountsForUser(ctx, args.userId);
  if (userAccounts.length !== 0) {
    // Replacing a linked identity needs a separate authenticated recovery flow.
    // Treat it as invalid here so a callback cannot silently switch accounts.
    throw new IdentityError("Invalid credentials");
  }

  await exec(
    ctx,
    `INSERT INTO kith.auth_accounts
       (id, user_id, provider, provider_account_id, email_verified)
       VALUES ($1, $2, $3, $4, $5)`,
    [
      newKithId(),
      args.userId,
      GOOGLE_PROVIDER,
      providerAccountId,
      verifiedEmail,
    ],
  );
}

function requireGoogleHostedDomain(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      value,
    )
  ) {
    throw new IdentityError("Invalid credentials");
  }
  return value;
}

/**
 * Opens a Google session, linking one organization account when safe.
 *
 * An existing subject is authoritative and is resolved before any current
 * email or hosted-domain metadata. A new subject may link only when Google's
 * verified email names exactly one existing Kith user after lowercase
 * normalization, that user is the operator-pinned auto-link account, and
 * Google's signed `hd` claim exactly equals the configured organization
 * domain. The user-id pin prevents a public signup from pre-registering a
 * victim's email and retaining password access after that victim signs in with
 * Google. This is intentionally not Gmail alias normalization:
 * dots, plus suffixes and other provider rules do not identify a Kith user.
 *
 * Password-created users do not carry a separate Kith email-verification
 * timestamp. The signed, verified organization email is the proof here; the
 * stored user email is only the exact normalized locator. A missing or
 * ambiguous locator fails closed and never creates a user.
 */
export async function signInOrAutoLinkGoogle(
  ctx: IdentityCtx,
  args: {
    providerAccountId: string;
    verifiedEmail: string;
    hostedDomain: string | null;
    allowedHostedDomain: string | null;
    autoLinkUserId: string | null;
  },
): Promise<{
  userId: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}> {
  const providerAccountId = requireGoogleSubject(args.providerAccountId);
  const account = await getGoogleAccount(ctx, providerAccountId);
  if (account) {
    if (!(await userExists(ctx, account.userId))) {
      throw new IdentityError("Invalid credentials");
    }
    return {
      userId: account.userId,
      ...(await createSession(ctx, account.userId)),
    };
  }

  const verifiedEmail = requireValidEmail(args.verifiedEmail);
  if (
    args.allowedHostedDomain === null ||
    args.hostedDomain === null ||
    args.autoLinkUserId === null ||
    !KITH_ID.test(args.autoLinkUserId)
  ) {
    throw new IdentityError("Invalid credentials");
  }
  const allowedHostedDomain = requireGoogleHostedDomain(
    args.allowedHostedDomain,
  );
  if (args.hostedDomain !== allowedHostedDomain) {
    throw new IdentityError("Invalid credentials");
  }

  const candidates = await rows<{ id: string }>(
    ctx,
    `SELECT id FROM kith.users
      WHERE email IS NOT NULL AND lower(email) = $1
      ORDER BY id
      LIMIT 2`,
    [verifiedEmail.toLowerCase()],
  );
  if (candidates.length !== 1 || candidates[0]!.id !== args.autoLinkUserId) {
    throw new IdentityError("Invalid credentials");
  }
  const userId = candidates[0]!.id;
  await linkGoogleAccount(ctx, {
    userId,
    providerAccountId,
    verifiedEmail,
  });
  return { userId, ...(await createSession(ctx, userId)) };
}

/** Opens an ordinary Kith web session for an explicitly linked Google subject. */
export async function signInWithGoogle(
  ctx: IdentityCtx,
  args: { providerAccountId: string },
): Promise<{
  userId: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}> {
  const account = await getGoogleAccount(
    ctx,
    requireGoogleSubject(args.providerAccountId),
  );
  if (!account || !(await userExists(ctx, account.userId))) {
    throw new IdentityError("Invalid credentials");
  }
  return {
    userId: account.userId,
    ...(await createSession(ctx, account.userId)),
  };
}

/**
 * A well-formed stored secret that no password produces. When the account
 * does not exist, the sign-in verifies the supplied password against this
 * value instead of skipping the KDF, so an unknown email costs the same
 * Scrypt derivation as a wrong password. Without it the identical error
 * message hides nothing: the response time alone said whether the account
 * existed. Zeros, not a random value, so the cost is the same on every
 * instance and nothing secret has to be generated or stored.
 */
const UNKNOWN_ACCOUNT_SECRET = `${"0".repeat(32)}:${"0".repeat(128)}`;

/**
 * Verifies a password against the stored Scrypt hash and opens a session.
 *
 * One message for an unknown account and for a wrong password, and the same
 * work: a missing account derives against `UNKNOWN_ACCOUNT_SECRET` rather
 * than returning early, closing the timing channel the library left open.
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
  const verified = await verifyPassword(
    account ? account.secret : UNKNOWN_ACCOUNT_SECRET,
    password,
  );
  if (!account || !verified) {
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
    readSessionCookie(args.cookieHeader, args.config),
  );
  const session = await resolveSessionToken(ctx, token);
  if (session) await revokeSession(ctx, session.id);
  return { setCookie: clearedSessionCookie(args.config) };
}
