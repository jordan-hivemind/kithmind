import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { ConvexHttpClient } from "convex/browser";

import { getMcpResourceUri, isMcpResourceUri } from "@/lib/mcp/environment";
import {
  assertOAuthEncryptionConfigured,
  decryptClientRegistration,
  encryptAuthCode,
  hashAuthorizationCode,
  hashOAuthBinding,
  hasTrustedOAuthOrigin,
  OAUTH_NO_STORE_HEADERS,
  readLimitedOAuthBody,
} from "@/lib/mcp/oauth";
import { authorizationConsentSchema } from "@/lib/mcp/oauth-validation";

function errorResponse(message: string, status: number) {
  return Response.json(
    { error: message },
    { status, headers: OAUTH_NO_STORE_HEADERS },
  );
}

function convexErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return undefined;
  }
  const data = error.data;
  return typeof data === "object" && data !== null && "code" in data
    ? String(data.code)
    : undefined;
}

function oauthMutationErrorResponse(error: unknown): Response | undefined {
  switch (convexErrorCode(error)) {
    case "not_authenticated":
      return errorResponse("Not authenticated", 401);
    case "invalid_input":
      return errorResponse("Invalid authorization request", 400);
    case "authorization_revoked":
      return errorResponse("Selected access is no longer available", 403);
    case "grant_not_found":
    case "grant_expired":
    case "grant_consumed":
      return errorResponse("Start a fresh authorization request", 409);
    case "grant_preparing":
      return errorResponse("Authorization is still being prepared", 409);
    case "grant_limit_reached":
      return errorResponse("Too many authorizations are pending", 429);
    default:
      return undefined;
  }
}

export async function POST(req: Request) {
  if (!hasTrustedOAuthOrigin(req)) {
    return errorResponse("Invalid request origin", 403);
  }
  if (
    !req.headers.get("content-type")?.toLowerCase().includes("application/json")
  ) {
    return errorResponse("Content-Type must be application/json", 415);
  }

  let input: unknown;
  try {
    assertOAuthEncryptionConfigured();
    input = JSON.parse(await readLimitedOAuthBody(req)) as unknown;
  } catch {
    return errorResponse("Invalid authorization request", 400);
  }

  const parsed = authorizationConsentSchema.safeParse(input);
  if (!parsed.success) {
    return errorResponse("Invalid authorization request", 400);
  }

  const request = parsed.data;
  if (request.resource !== undefined && !isMcpResourceUri(request.resource)) {
    return errorResponse("Invalid MCP resource", 400);
  }
  // Store the canonical form, not the caller's spelling. `isMcpResourceUri`
  // accepts origin-case variants, so persisting the raw value would make the
  // token endpoint's equality check fail for a client that sends the resource
  // at authorize and omits it at token exchange.
  const resource = getMcpResourceUri();
  const registration = decryptClientRegistration(request.clientId);
  if (
    !registration ||
    !registration.redirectUris.includes(request.redirectUri)
  ) {
    return errorResponse("Client or redirect URI is not registered", 400);
  }

  const token = await convexAuthNextjsToken();
  if (!token) {
    return errorResponse("Not authenticated", 401);
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return errorResponse("Authorization service is not configured", 500);
  }
  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(token);

  let grant:
    | {
        status: "issued";
        keyId: Id<"apiKeys">;
        userId: Id<"users">;
        rawKey: string;
        requestHash: string;
        bindingSeedHash: string;
        preparationNonce: string;
        grantExpiresAt: number;
      }
    | { status: "pending"; encryptedCode: string }
    | { status: "preparing"; retryAfterMs: number }
    | { status: "consumed" };
  try {
    grant = await convex.mutation(
      api.models.oauth.web.beginAuthorizationGrant,
      {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        resource,
        codeChallenge: request.codeChallenge,
        scope: request.scope ?? "open-brain",
        ...(request.state === undefined ? {} : { state: request.state }),
        name: `MCP (${registration.clientName})`,
        capabilities: request.capabilities,
        spaceIds: request.spaceIds as Id<"spaces">[],
      },
    );
  } catch (error) {
    return (
      oauthMutationErrorResponse(error) ??
      errorResponse("Failed to create API key", 500)
    );
  }

  if (grant.status === "consumed") {
    return errorResponse("Start a fresh authorization request", 409);
  }
  if (grant.status === "preparing") {
    return Response.json(
      { error: "Authorization is still being prepared" },
      {
        status: 409,
        headers: {
          ...OAUTH_NO_STORE_HEADERS,
          "Retry-After": String(
            Math.max(1, Math.ceil(grant.retryAfterMs / 1000)),
          ),
        },
      },
    );
  }

  const redirectWithCode = (code: string) => {
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code);
    if (request.state) redirect.searchParams.set("state", request.state);
    return Response.json(
      { redirect_url: redirect.toString() },
      { headers: OAUTH_NO_STORE_HEADERS },
    );
  };
  if (grant.status === "pending") {
    return redirectWithCode(grant.encryptedCode);
  }

  try {
    const code = encryptAuthCode({
      apiKey: grant.rawKey,
      apiKeyId: grant.keyId,
      userId: grant.userId,
      requestHash: grant.requestHash,
      bindingSeedHash: grant.bindingSeedHash,
      clientId: request.clientId,
      codeChallenge: request.codeChallenge,
      redirectUri: request.redirectUri,
      resource,
      scope: request.scope ?? "open-brain",
      exp: grant.grantExpiresAt,
    });
    const codeHash = hashAuthorizationCode(code);
    const bindingHash = hashOAuthBinding(grant.bindingSeedHash, codeHash);
    await convex.mutation(api.models.oauth.web.finalizeAuthorizationGrant, {
      keyId: grant.keyId,
      requestHash: grant.requestHash,
      preparationNonce: grant.preparationNonce,
      encryptedCode: code,
      codeHash,
      bindingHash,
      grantExpiresAt: grant.grantExpiresAt,
    });
    return redirectWithCode(code);
  } catch (error) {
    try {
      await convex.mutation(api.models.oauth.web.abandonAuthorizationGrant, {
        keyId: grant.keyId,
        requestHash: grant.requestHash,
        preparationNonce: grant.preparationNonce,
      });
    } catch {
      // One bounded compensation attempt avoids hiding the original failure.
    }
    return (
      oauthMutationErrorResponse(error) ??
      errorResponse("Failed to complete authorization", 500)
    );
  }
}
