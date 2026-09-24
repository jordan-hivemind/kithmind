// SMART on FHIR standalone launch: PKCE, endpoint discovery, and the token
// exchange/refresh calls.
//
// The app is registered as a confidential client (a client secret), but
// Epic's sandbox has been observed to answer a Basic-authenticated request
// with 401 invalid_client while accepting the same request with no
// Authorization header and `client_id` in the body -- i.e. it treats this
// registration as a public client regardless of the configured secret. The
// code exchange therefore tries HTTP Basic first (when a secret is
// configured) and falls back to a public-client request on invalid_client,
// recording which method actually worked so `refreshAccessToken` can reuse
// it without probing again.
//
// Nothing here prints or logs a code, a verifier, a token or a secret --
// only the shapes callers need to store or compare.

import { createHash, randomBytes } from "node:crypto";

export type Fetch = typeof fetch;

function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** A PKCE code verifier: 43-128 characters, unreserved per RFC 7636. 96
 * random bytes base64url-encodes to 128 characters, the maximum allowed. */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(96));
}

/** S256 code challenge for a given verifier. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** An opaque anti-CSRF `state` value. */
export function generateState(): string {
  return base64url(randomBytes(24));
}

export type SmartConfiguration = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
};

/**
 * Discovers the authorize and token endpoints from
 * `<fhirBase>/.well-known/smart-configuration`, falling back to the R4
 * `/metadata` CapabilityStatement's `rest[0].security.extension` OAuth URIs
 * extension when the well-known document is unavailable (some deployments,
 * including parts of Epic's own sandbox, only publish one of the two).
 */
export async function discoverSmartConfiguration(
  fhirBase: string,
  fetchImpl: Fetch = fetch,
): Promise<SmartConfiguration> {
  const base = fhirBase.endsWith("/") ? fhirBase : `${fhirBase}/`;
  const wellKnown = await tryWellKnown(base, fetchImpl);
  if (wellKnown !== null) return wellKnown;
  return await fromCapabilityStatement(base, fetchImpl);
}

async function tryWellKnown(
  base: string,
  fetchImpl: Fetch,
): Promise<SmartConfiguration | null> {
  try {
    const response = await fetchImpl(`${base}.well-known/smart-configuration`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    if (!body.authorization_endpoint || !body.token_endpoint) return null;
    return {
      authorizationEndpoint: body.authorization_endpoint,
      tokenEndpoint: body.token_endpoint,
    };
  } catch {
    return null;
  }
}

const OAUTH_URIS_EXTENSION =
  "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris";

async function fromCapabilityStatement(
  base: string,
  fetchImpl: Fetch,
): Promise<SmartConfiguration> {
  const response = await fetchImpl(`${base}metadata`, {
    headers: { accept: "application/fhir+json" },
  });
  if (!response.ok) {
    throw new Error(
      `SMART discovery failed: /metadata returned ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    rest?: Array<{
      security?: {
        extension?: Array<{
          url?: string;
          extension?: Array<{ url?: string; valueUri?: string }>;
        }>;
      };
    }>;
  };
  const security = body.rest?.[0]?.security;
  const oauthUris = security?.extension?.find(
    (item) => item.url === OAUTH_URIS_EXTENSION,
  );
  const authorizationEndpoint = oauthUris?.extension?.find(
    (item) => item.url === "authorize",
  )?.valueUri;
  const tokenEndpoint = oauthUris?.extension?.find(
    (item) => item.url === "token",
  )?.valueUri;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(
      "SMART discovery failed: /metadata has no oauth-uris authorize/token extension",
    );
  }
  return { authorizationEndpoint, tokenEndpoint };
}

export type AuthorizationUrlArgs = {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  aud: string;
};

/** The URL to open for a standalone SMART launch, PKCE S256, `aud` pinned to
 * the FHIR base per the task. */
export function buildAuthorizationUrl(args: AuthorizationUrlArgs): string {
  const url = new URL(args.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", args.scopes.join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("aud", args.aud);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  patientFhirId: string | null;
  scope: string | null;
};

/** Thrown by `refreshAccessToken` on an `invalid_grant` response: the
 * refresh token itself is dead and the caller must not retry it. */
export class InvalidGrantError extends Error {
  constructor(description: string | null) {
    super(description ?? "invalid_grant");
    this.name = "InvalidGrantError";
  }
}

/** Which way the token endpoint accepted this client: `"secret"` for HTTP
 * Basic with the configured client secret, `"public"` for no Authorization
 * header and `client_id` in the form body (RFC 6749 2.3.1's "public
 * client" case, which is what Epic's sandbox has been observed to require
 * for this app's registration). Stored alongside a person's token so a
 * later refresh uses the same method without re-probing. */
export type ClientAuthMethod = "secret" | "public";

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

type RawTokenBody = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  patient?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type TokenRequestResult = {
  ok: boolean;
  status: number;
  parsed: RawTokenBody;
};

/** POSTs one token request, either with an `authorization` header (Basic,
 * client-secret auth) or without one (public-client auth, `client_id`
 * already set on `body` by the caller). Never throws on a non-2xx response
 * -- the caller decides whether to retry, so this only reports the shape. */
async function requestToken(
  tokenEndpoint: string,
  body: URLSearchParams,
  fetchImpl: Fetch,
  authorizationHeader: string | null,
): Promise<TokenRequestResult> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (authorizationHeader !== null) headers.authorization = authorizationHeader;
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  const parsed = (await response.json().catch(() => ({}))) as RawTokenBody;
  return { ok: response.ok, status: response.status, parsed };
}

/** A 400 or 401 with `error=invalid_client` -- Epic's sandbox answers this
 * way to a Basic-authenticated request for a registration it treats as a
 * public client, regardless of the configured secret. */
function isInvalidClient(result: TokenRequestResult): boolean {
  return (
    (result.status === 400 || result.status === 401) &&
    result.parsed.error === "invalid_client"
  );
}

function throwTokenError(result: TokenRequestResult): never {
  if (result.parsed.error === "invalid_grant") {
    throw new InvalidGrantError(result.parsed.error_description ?? null);
  }
  throw new Error(
    `Epic token request failed (${result.status}): ${result.parsed.error ?? "unknown_error"} ${result.parsed.error_description ?? ""}`.trim(),
  );
}

function toTokenResponse(parsed: RawTokenBody): TokenResponse {
  if (!parsed.access_token) {
    throw new Error("Epic token response had no access_token");
  }
  const expiresInSeconds = parsed.expires_in ?? 3600;
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    patientFhirId: parsed.patient ?? null,
    scope: parsed.scope ?? null,
  };
}

export type ExchangeCodeArgs = {
  tokenEndpoint: string;
  clientId: string;
  /** `null` when no client secret is configured at all (no env, no
   * Keychain) -- the exchange then goes straight to the public-client
   * request instead of failing. */
  clientSecret: string | null;
  code: string;
  redirectUri: string;
  codeVerifier: string;
};

export type ExchangeCodeResult = TokenResponse & { clientAuth: ClientAuthMethod };

/**
 * Authorization-code exchange. Tries HTTP Basic client authentication
 * first when a client secret is configured; on a 400/401 `invalid_client`
 * response (or when no secret is configured at all), retries once as a
 * public client -- no Authorization header, `client_id` in the form body,
 * the same code, redirect_uri and code_verifier. The result records which
 * method actually succeeded.
 */
export async function exchangeCode(
  args: ExchangeCodeArgs,
  fetchImpl: Fetch = fetch,
): Promise<ExchangeCodeResult> {
  const baseBody = (): URLSearchParams =>
    new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
    });

  if (args.clientSecret !== null) {
    const basicResult = await requestToken(
      args.tokenEndpoint,
      baseBody(),
      fetchImpl,
      basicAuthHeader(args.clientId, args.clientSecret),
    );
    if (basicResult.ok) {
      return { ...toTokenResponse(basicResult.parsed), clientAuth: "secret" };
    }
    if (!isInvalidClient(basicResult)) {
      throwTokenError(basicResult);
    }
    // Falls through to the public-client retry below.
  }

  const publicBody = baseBody();
  publicBody.set("client_id", args.clientId);
  const publicResult = await requestToken(args.tokenEndpoint, publicBody, fetchImpl, null);
  if (!publicResult.ok) throwTokenError(publicResult);
  return { ...toTokenResponse(publicResult.parsed), clientAuth: "public" };
}

export type RefreshTokenArgs = {
  tokenEndpoint: string;
  clientId: string;
  /** `null` when no client secret is configured; only valid together with
   * `clientAuth: "public"` (a `"secret"` refresh with no secret throws). */
  clientSecret: string | null;
  refreshToken: string;
  /** The method the token being refreshed was originally obtained with --
   * refresh always reuses it rather than probing again. */
  clientAuth: ClientAuthMethod;
};

/**
 * Refreshes an access token, using the same client authentication method
 * the token was originally exchanged with (Basic for `"secret"`,
 * `client_id` in the body for `"public"`). Throws `InvalidGrantError` when
 * Epic reports `invalid_grant` (the refresh token is dead -- the caller
 * marks `needs_reauth_at` and reports, never loops on this).
 */
export async function refreshAccessToken(
  args: RefreshTokenArgs,
  fetchImpl: Fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
  });
  let authorizationHeader: string | null = null;
  if (args.clientAuth === "secret") {
    if (args.clientSecret === null) {
      throw new Error(
        "Epic refresh needs a client secret (this token was obtained as a " +
          "confidential client) but none is configured",
      );
    }
    authorizationHeader = basicAuthHeader(args.clientId, args.clientSecret);
  } else {
    body.set("client_id", args.clientId);
  }
  const result = await requestToken(args.tokenEndpoint, body, fetchImpl, authorizationHeader);
  if (!result.ok) throwTokenError(result);
  return toTokenResponse(result.parsed);
}

export type ProbeTokenArgs = {
  tokenEndpoint: string;
  clientId: string;
  /** `null` sends the request as a public client (no Authorization header,
   * `client_id` in the form body); any other value sends it with HTTP
   * Basic client-secret authentication. This is the one deliberate
   * difference from `exchangeCode`: that function tries Basic first and
   * automatically falls back to public on `invalid_client`, collapsing the
   * two shapes into one outcome. `probeTokenRequest` sends exactly the one
   * shape the caller asked for and never falls back, so `check` can run
   * both shapes itself and compare their two outcomes. */
  clientSecret: string | null;
  /** A deliberately bogus authorization code -- this call is never expected
   * to succeed; `check` only reads which error Epic returns. */
  code: string;
  redirectUri: string;
};

export type TokenErrorProbe = {
  status: number;
  error: string | null;
  errorDescription: string | null;
};

/**
 * Sends one `authorization_code` token request with a bogus code and
 * reports Epic's error back verbatim -- never throws, since `check`'s whole
 * job is to look at the error Epic returns rather than treat it as a
 * failure. Used only by `check`; `authorize`'s real code exchange is
 * `exchangeCode` above.
 */
export async function probeTokenRequest(
  args: ProbeTokenArgs,
  fetchImpl: Fetch = fetch,
): Promise<TokenErrorProbe> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    // No real PKCE flow produced this code, so no real verifier exists;
    // this call is never expected to reach PKCE validation since the code
    // itself is bogus.
    code_verifier: "check-command-has-no-real-pkce-verifier",
  });
  let authorizationHeader: string | null = null;
  if (args.clientSecret !== null) {
    authorizationHeader = basicAuthHeader(args.clientId, args.clientSecret);
  } else {
    body.set("client_id", args.clientId);
  }
  const result = await requestToken(args.tokenEndpoint, body, fetchImpl, authorizationHeader);
  return {
    status: result.status,
    error: result.parsed.error ?? null,
    errorDescription: result.parsed.error_description ?? null,
  };
}

/** Parses either a bare authorization code or a full pasted callback URL
 * (`...?code=...&state=...`), and validates `state` when the URL carries
 * one. */
export function parsePastedCode(
  input: string,
  expectedState: string,
): { code: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) throw new Error("Pasted URL had no code parameter");
    if (state !== null && state !== expectedState) {
      throw new Error("Pasted URL's state does not match this authorization request");
    }
    return { code };
  }
  if (trimmed === "") throw new Error("No code was entered");
  return { code: trimmed };
}
