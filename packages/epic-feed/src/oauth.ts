// SMART on FHIR standalone launch: PKCE, endpoint discovery, and the token
// exchange/refresh calls with HTTP Basic client authentication (a
// confidential client with a client secret, per the task).
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

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

async function postToken(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  body: URLSearchParams,
  fetchImpl: Fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: body.toString(),
  });
  const parsed = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    patient?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok) {
    if (parsed.error === "invalid_grant") {
      throw new InvalidGrantError(parsed.error_description ?? null);
    }
    throw new Error(
      `Epic token request failed (${response.status}): ${parsed.error ?? "unknown_error"} ${parsed.error_description ?? ""}`.trim(),
    );
  }
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
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
};

/** Authorization-code exchange, HTTP Basic client authentication. */
export async function exchangeCode(
  args: ExchangeCodeArgs,
  fetchImpl: Fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
  return await postToken(
    args.tokenEndpoint,
    args.clientId,
    args.clientSecret,
    body,
    fetchImpl,
  );
}

export type RefreshTokenArgs = {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/**
 * Refreshes an access token. Throws `InvalidGrantError` when Epic reports
 * `invalid_grant` (the refresh token is dead -- the caller marks
 * `needs_reauth_at` and reports, never loops on this).
 */
export async function refreshAccessToken(
  args: RefreshTokenArgs,
  fetchImpl: Fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
  });
  return await postToken(
    args.tokenEndpoint,
    args.clientId,
    args.clientSecret,
    body,
    fetchImpl,
  );
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
