import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { ConvexHttpClient } from "convex/browser";

import { getMcpResourceUri, isMcpResourceUri } from "@/lib/mcp/environment";
import {
  assertOAuthEncryptionConfigured,
  decryptClientRegistration,
  encryptAuthCode,
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

  let rawKey: string;
  let keyId: Id<"apiKeys">;
  try {
    const result = await convex.mutation(api.models.apiKeys.public.create, {
      name: `MCP (${registration.clientName})`,
      capabilities: request.capabilities,
      spaceIds: request.spaceIds as Id<"spaces">[],
    });
    rawKey = result.rawKey;
    keyId = result.id;
  } catch {
    return errorResponse("Failed to create API key", 500);
  }

  try {
    const code = encryptAuthCode({
      apiKey: rawKey,
      clientId: request.clientId,
      codeChallenge: request.codeChallenge,
      redirectUri: request.redirectUri,
      resource,
      scope: request.scope ?? "open-brain",
      exp: Date.now() + 5 * 60 * 1000,
    });

    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code);
    if (request.state) redirect.searchParams.set("state", request.state);

    return Response.json(
      { redirect_url: redirect.toString() },
      { headers: OAUTH_NO_STORE_HEADERS },
    );
  } catch {
    try {
      await convex.mutation(api.models.apiKeys.public.revoke, { id: keyId });
    } catch {
      // One bounded compensation attempt avoids hiding the original failure.
    }
    return errorResponse("Failed to complete authorization", 500);
  }
}
