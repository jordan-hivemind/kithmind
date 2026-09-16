// The OAuth token endpoint: an authorization code becomes the API key.
//
// Section 3.2. Under `convex` the exchange is authorized by a purpose-scoped
// ES256 token this route mints and Convex verifies. Under `postgres` there is no
// token: `identity.requireOAuthExchangeIdentity` takes the same four hashes as
// arguments and runs the same checks on them, and the activation that follows
// runs on the same client inside the same transaction.
//
// Two properties the exchange has to keep, in both modes:
//
//   * A consumed code that is presented again revokes the key it issued. The
//     store does that inside `activateAuthorizationGrant` and reports
//     `replayed`, so the route returns the replay status from the transaction
//     rather than throwing out of it: an error here would roll the revocation
//     back and leave a leaked code's key live.
//   * The exchange identity is never a credential. It is four hashes and two
//     identifiers, held for the length of one transaction, and it is not the
//     bearer of anything. The key it names still carries `oauth_lifecycle`
//     `pending` until this activation clears it, and `requireMcpPrincipal`
//     refuses a key whose lifecycle is set.

import { api } from "@repo/db/convex/_generated/api";
import { withKithTransaction } from "@repo/kith-store";
import {
  activateAuthorizationGrant,
  identityCtx,
  requireOAuthExchangeIdentity,
} from "@repo/kith-store/identity";
import { ConvexHttpClient } from "convex/browser";

import { kithPool } from "@/lib/kith/pool";
import { kithPostgresSurface } from "@/lib/kith/surface";
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

export const runtime = "nodejs";

/** Everything the exchange is authorized by. No token, on either surface. */
type ExchangeArgs = {
  apiKeyId: string;
  userId: string;
  codeHash: string;
  keyHash: string;
  bindingHash: string;
  requestHash: string;
  expiresAt: number;
};

/** One transaction: prove the exchange identity, then activate on that client. */
async function activateOnPostgres(
  exchange: ExchangeArgs,
): Promise<{ status: "activated" | "replayed" }> {
  return await withKithTransaction(kithPool(), async (client) => {
    const ctx = identityCtx(client);
    // The exchange identity as its own step, where the minted token used to be:
    // the key exists, it belongs to the named user, and that user is still
    // there. `activateAuthorizationGrant` rechecks it on the same client, which
    // is the one thing that must not become two reads of the same rows.
    await requireOAuthExchangeIdentity(ctx, exchange);
    return await activateAuthorizationGrant(ctx, exchange);
  });
}

/** The JWT bridge. Deleted in i7 with `convex-auth.ts`. */
async function activateOnConvex(
  convexUrl: string,
  exchange: ExchangeArgs,
): Promise<{ status: string }> {
  const convexToken = await createConvexMcpToken(
    { userId: exchange.userId, keyId: exchange.apiKeyId },
    {
      keyHash: exchange.keyHash,
      codeHash: exchange.codeHash,
      bindingHash: exchange.bindingHash,
      requestHash: exchange.requestHash,
    },
  );
  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(convexToken);
  return await convex.mutation(
    api.models.oauth.mcpMutations.activateAuthorizationGrant,
    {
      codeHash: exchange.codeHash,
      keyHash: exchange.keyHash,
      bindingHash: exchange.bindingHash,
      requestHash: exchange.requestHash,
      expiresAt: exchange.expiresAt,
    },
  );
}

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

  const onPostgres = kithPostgresSurface() === "postgres";
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!onPostgres && !convexUrl) {
    return tokenError(
      "invalid_grant",
      "Authorization grant is no longer valid",
    );
  }

  try {
    const codeHash = hashAuthorizationCode(request.code);
    const keyHash = hashApiKeyCredential(data.apiKey);
    const bindingHash = hashOAuthBinding(data.bindingSeedHash, codeHash);
    const exchange = {
      apiKeyId: data.apiKeyId,
      userId: data.userId,
      codeHash,
      keyHash,
      bindingHash,
      requestHash: data.requestHash,
      expiresAt: data.exp,
    };

    const result = onPostgres
      ? await activateOnPostgres(exchange)
      : await activateOnConvex(convexUrl!, exchange);

    // `replayed` is a committed outcome, not a failure to throw past: the store
    // deleted the key the leaked code had activated, and rolling that back would
    // leave it live. The client is told the same thing either way.
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
