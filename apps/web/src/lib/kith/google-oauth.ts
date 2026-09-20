import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { SessionConfig } from "@repo/kith-store/identity";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_OAUTH_PATH = "/api/auth/google/callback";
const GOOGLE_OAUTH_MAX_AGE_SECONDS = 10 * 60;

export const GOOGLE_OAUTH_COOKIE = "__Host-kith_google_oauth";
export const GOOGLE_OAUTH_DEVELOPMENT_COOKIE = "kith_google_oauth";

type Environment = Readonly<Record<string, string | undefined>>;

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  origin: string;
  redirectUri: string;
};

export type GoogleOAuthAction = "sign-in" | "link";

export type GoogleOAuthTransaction = {
  version: 1;
  action: GoogleOAuthAction;
  state: string;
  nonce: string;
  verifier: string;
  issuedAt: number;
  linkSessionId?: string;
  linkUserId?: string;
};

export type VerifiedGoogleIdentity = {
  subject: string;
  verifiedEmail: string;
};

export class GoogleOAuthError extends Error {
  constructor() {
    super("Google OAuth failed");
    this.name = "GoogleOAuthError";
  }
}

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function productionOrigin(value: string | undefined): string | null {
  if (!present(value)) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== value ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function developmentOrigin(requestUrl: string): string | null {
  try {
    const parsed = new URL(requestUrl);
    const loopback =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const port = Number(parsed.port);
    if (
      parsed.protocol !== "http:" ||
      !loopback ||
      !/^\d+$/.test(parsed.port) ||
      port < 1 ||
      port > 65_535 ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Whether server-rendered pages should offer Google as an auth choice. */
export function googleOAuthEnabled(env: Environment = process.env): boolean {
  if (
    !present(env.GOOGLE_OAUTH_CLIENT_ID) ||
    !present(env.GOOGLE_OAUTH_CLIENT_SECRET)
  ) {
    return false;
  }
  return env.NODE_ENV === "development"
    ? true
    : productionOrigin(env.GOOGLE_OAUTH_ORIGIN) !== null;
}

/**
 * Configuration for one request.
 *
 * Production never trusts the request host for an OAuth redirect. Development
 * deliberately does, after restricting it to an explicit HTTP loopback host
 * and port, so `next dev --port ...` can use the URI registered for that port.
 */
export function googleOAuthConfig(
  requestUrl: string,
  env: Environment = process.env,
): GoogleOAuthConfig {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const origin =
    env.NODE_ENV === "development"
      ? developmentOrigin(requestUrl)
      : productionOrigin(env.GOOGLE_OAUTH_ORIGIN);
  if (!present(clientId) || !present(clientSecret) || origin === null) {
    throw new GoogleOAuthError();
  }
  return {
    clientId,
    clientSecret,
    origin,
    redirectUri: `${origin}${GOOGLE_OAUTH_PATH}`,
  };
}

function randomBase64Url(): string {
  return randomBytes(32).toString("base64url");
}

/** Creates the state, nonce and RFC 7636 S256 challenge for one authorization. */
export function createGoogleOAuthTransaction(
  action: GoogleOAuthAction,
  link: { sessionId: string; userId: string } | null = null,
  now = Date.now(),
): { transaction: GoogleOAuthTransaction; challenge: string } {
  if (action === "link" && link === null) throw new GoogleOAuthError();
  if (action === "sign-in" && link !== null) throw new GoogleOAuthError();
  const verifier = randomBase64Url();
  const transaction: GoogleOAuthTransaction = {
    version: 1,
    action,
    state: randomBase64Url(),
    nonce: randomBase64Url(),
    verifier,
    issuedAt: now,
    ...(link === null
      ? {}
      : { linkSessionId: link.sessionId, linkUserId: link.userId }),
  };
  return {
    transaction,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function googleAuthorizationUrl(
  config: GoogleOAuthConfig,
  transaction: GoogleOAuthTransaction,
  challenge: string,
): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

function signTransaction(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function cookieName(config: SessionConfig): string {
  return config.secure === false
    ? GOOGLE_OAUTH_DEVELOPMENT_COOKIE
    : GOOGLE_OAUTH_COOKIE;
}

export function googleOAuthCookie(
  config: SessionConfig,
  transaction: GoogleOAuthTransaction,
): string {
  const payload = Buffer.from(JSON.stringify(transaction), "utf8").toString(
    "base64url",
  );
  const value = `v1.${payload}.${signTransaction(config.secret, payload)}`;
  const attributes = [
    `${cookieName(config)}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${GOOGLE_OAUTH_MAX_AGE_SECONDS}`,
  ];
  if (config.secure !== false) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedGoogleOAuthCookie(config: SessionConfig): string {
  const attributes = [
    `${cookieName(config)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (config.secure !== false) attributes.push("Secure");
  return attributes.join("; ");
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function transactionShape(
  value: unknown,
  now: number,
): value is GoogleOAuthTransaction {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<GoogleOAuthTransaction>;
  const common =
    candidate.version === 1 &&
    (candidate.action === "sign-in" || candidate.action === "link") &&
    typeof candidate.state === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(candidate.state) &&
    typeof candidate.nonce === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(candidate.nonce) &&
    typeof candidate.verifier === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(candidate.verifier) &&
    typeof candidate.issuedAt === "number" &&
    Number.isSafeInteger(candidate.issuedAt) &&
    candidate.issuedAt <= now + 60_000 &&
    candidate.issuedAt >= now - GOOGLE_OAUTH_MAX_AGE_SECONDS * 1000;
  if (!common) return false;
  return candidate.action === "link"
    ? typeof candidate.linkSessionId === "string" &&
        candidate.linkSessionId.length > 0 &&
        typeof candidate.linkUserId === "string" &&
        candidate.linkUserId.length > 0
    : candidate.linkSessionId === undefined &&
        candidate.linkUserId === undefined;
}

export function readGoogleOAuthTransaction(
  config: SessionConfig,
  cookieHeader: string | null,
  now = Date.now(),
): GoogleOAuthTransaction | null {
  const value = readCookie(cookieHeader, cookieName(config));
  if (value === null) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const payload = parts[1]!;
  const expected = Buffer.from(signTransaction(config.secret, payload));
  const presented = Buffer.from(parts[2]!);
  if (
    expected.length !== presented.length ||
    !timingSafeEqual(expected, presented)
  ) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return transactionShape(decoded, now) ? decoded : null;
  } catch {
    return null;
  }
}

export function googleOAuthStateMatches(
  transaction: GoogleOAuthTransaction,
  presented: string | null,
): boolean {
  if (presented === null) return false;
  const expected = Buffer.from(transaction.state);
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (code.length === 0 || code.length > 4096) throw new GoogleOAuthError();
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GoogleOAuthError();
  }
  if (!response.ok) throw new GoogleOAuthError();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GoogleOAuthError();
  }
  const idToken =
    body !== null && typeof body === "object" && "id_token" in body
      ? (body as { id_token?: unknown }).id_token
      : undefined;
  if (typeof idToken !== "string" || idToken.length > 20_000) {
    throw new GoogleOAuthError();
  }
  return idToken;
}

const googleSigningKeys = createRemoteJWKSet(new URL(GOOGLE_JWKS_ENDPOINT), {
  timeoutDuration: 5_000,
});

/** Verifies Google's signed OIDC identity. Email is metadata; `sub` is identity. */
export async function verifyGoogleIdToken(
  idToken: string,
  config: Pick<GoogleOAuthConfig, "clientId">,
  nonce: string,
  signingKeys: JWTVerifyGetKey = googleSigningKeys,
): Promise<VerifiedGoogleIdentity> {
  try {
    const { payload } = await jwtVerify(idToken, signingKeys, {
      algorithms: ["RS256"],
      audience: config.clientId,
      issuer: GOOGLE_ISSUERS,
    });
    if (
      payload.aud !== config.clientId ||
      typeof payload.exp !== "number" ||
      payload.nonce !== nonce ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      payload.sub.length > 255 ||
      payload.email_verified !== true ||
      typeof payload.email !== "string" ||
      payload.email.length === 0 ||
      payload.email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)
    ) {
      throw new GoogleOAuthError();
    }
    return { subject: payload.sub, verifiedEmail: payload.email };
  } catch {
    throw new GoogleOAuthError();
  }
}
