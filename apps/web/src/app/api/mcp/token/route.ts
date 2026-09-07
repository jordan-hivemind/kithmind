import { api } from "@repo/db/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";

import { createConvexMcpToken } from "@/lib/mcp/convex-auth";
import { getMcpResourceUri, isMcpResourceUri } from "@/lib/mcp/environment";
import {
  assertOAuthEncryptionConfigured,
  decryptAuthCode,
  hashApiKeyCredential,
  hashAuthorizationCode,
  hashOAuthBinding,
  OAUTH_NO_STORE_HEADERS,
  readLimitedOAuthBody,
  verifyCodeChallenge,
} from "@/lib/mcp/oauth";
import { tokenRequestSchema } from "@/lib/mcp/oauth-validation";

function tokenError(
  error: "invalid_request" | "invalid_grant" | "invalid_target",
  description: string,
  status = 400,
) {
  return Response.json(
    { error, error_description: description },
    { status, headers: OAUTH_NO_STORE_HEADERS },
  );
}

async function readTokenParameters(req: Request): Promise<unknown> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const body = await readLimitedOAuthBody(req);

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const searchParams = new URLSearchParams(body);
    const params: Record<string, string> = {};
    for (const key of searchParams.keys()) {
      const values = searchParams.getAll(key);
      if (values.length !== 1) throw new Error("Duplicate OAuth parameter");
      params[key] = values[0]!;
    }
    return params;
  }

  if (contentType.includes("application/json")) {
    return JSON.parse(body) as unknown;
  }

  throw new Error("Unsupported content type");
}

export async function POST(req: Request) {
  let input: unknown;
  try {
    assertOAuthEncryptionConfigured();
    input = await readTokenParameters(req);
  } catch {
    return tokenError("invalid_request", "Invalid token request");
  }

  const parsed = tokenRequestSchema.safeParse(input);
  if (!parsed.success) {
    return tokenError("invalid_request", "Invalid token request");
  }

  const request = parsed.data;
  if (request.resource !== undefined && !isMcpResourceUri(request.resource)) {
    return tokenError("invalid_target", "Invalid MCP resource");
  }
  // Compare canonical forms; codes always store the canonical resource.
  const resource = getMcpResourceUri();
  const data = decryptAuthCode(request.code);
  if (!data || Date.now() > data.exp) {
    return tokenError("invalid_grant", "Invalid or expired authorization code");
  }
  if (
    request.client_id !== data.clientId ||
    request.redirect_uri !== data.redirectUri ||
    resource !== data.resource
  ) {
    return tokenError("invalid_grant", "Authorization request mismatch");
  }
  if (!verifyCodeChallenge(request.code_verifier, data.codeChallenge)) {
    return tokenError("invalid_grant", "Invalid code verifier");
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return tokenError(
      "invalid_grant",
      "Authorization grant is no longer valid",
    );
  }

  try {
    const codeHash = hashAuthorizationCode(request.code);
    const keyHash = hashApiKeyCredential(data.apiKey);
    const bindingHash = hashOAuthBinding(data.bindingSeedHash, codeHash);
    const convexToken = await createConvexMcpToken(
      {
        userId: data.userId,
        keyId: data.apiKeyId,
      },
      { keyHash, codeHash, bindingHash, requestHash: data.requestHash },
    );
    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(convexToken);
    const result = await convex.mutation(
      api.models.oauth.mcpMutations.activateAuthorizationGrant,
      {
        codeHash,
        keyHash,
        bindingHash,
        requestHash: data.requestHash,
        expiresAt: data.exp,
      },
    );
    if (result.status !== "activated") {
      return tokenError(
        "invalid_grant",
        "Authorization code is invalid or was already used",
      );
    }
  } catch {
    return tokenError(
      "invalid_grant",
      "Authorization code is invalid or was already used",
    );
  }

  return Response.json(
    {
      access_token: data.apiKey,
      token_type: "Bearer",
      scope: data.scope,
    },
    { headers: OAUTH_NO_STORE_HEADERS },
  );
}
