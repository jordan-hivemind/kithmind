// The JWT bridge. Deleted in i7, not here.
//
// Section 3.2 of the web and MCP surface plan deletes this file, the JWKS route,
// `packages/convex/convex/auth.config.ts` and the four `MCP_JWT_*` variables,
// because a PostgreSQL surface has no second backend to authenticate to. i2 was
// the slice named for that deletion and moves it to i7 for one reason: the
// surface has to stay dark. `main` deploys, `KITH_POSTGRES_SURFACE` still
// defaults to `convex`, and every page and tool that has not moved yet reaches
// Convex through a token minted here. Deleting the signer before i5 moves the
// pages would take production down rather than leave it unchanged.
//
// So nothing here changes in i2 except the name of the origin variable it reads.
// i7 deletes the file.

import { importJWK, type JWK, SignJWT } from "jose";

import { getMcpPublicOrigin, requireEnvironmentVariable } from "./environment";

export const MCP_JWT_AUDIENCE = "ai-brain-convex-mcp";
export const MCP_JWT_ALGORITHM = "ES256";

type McpIdentity = {
  userId: string;
  keyId: string;
};

export type OAuthExchangeClaims = {
  keyHash: string;
  codeHash: string;
  bindingHash: string;
  requestHash: string;
};

function parseJwk(value: string, variableName: string): JWK {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || !("kty" in parsed)) {
      throw new Error("expected a JSON Web Key");
    }
    return parsed as JWK;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`${variableName} is invalid: ${reason}`);
  }
}

function requireP256Key(key: JWK, variableName: string): void {
  if (key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y) {
    throw new Error(`${variableName} must be an EC P-256 JSON Web Key`);
  }
}

export function getPublicMcpJwk(): JWK & { kid: string } {
  const key = parseJwk(
    requireEnvironmentVariable("MCP_JWT_PUBLIC_JWK"),
    "MCP_JWT_PUBLIC_JWK",
  );
  requireP256Key(key, "MCP_JWT_PUBLIC_JWK");
  if (key.d) {
    throw new Error("MCP_JWT_PUBLIC_JWK must not contain private key material");
  }
  return {
    ...key,
    alg: MCP_JWT_ALGORITHM,
    use: "sig",
    kid: process.env.MCP_JWT_KEY_ID ?? "mcp-1",
  };
}

export async function createConvexMcpToken(
  identity: McpIdentity,
  exchange?: OAuthExchangeClaims,
): Promise<string> {
  const issuer = getMcpPublicOrigin();
  const privateJwk = parseJwk(
    requireEnvironmentVariable("MCP_JWT_PRIVATE_JWK"),
    "MCP_JWT_PRIVATE_JWK",
  );
  requireP256Key(privateJwk, "MCP_JWT_PRIVATE_JWK");
  if (!privateJwk.d) {
    throw new Error("MCP_JWT_PRIVATE_JWK must contain private key material");
  }
  const keyId = process.env.MCP_JWT_KEY_ID ?? "mcp-1";
  const signingKey = await importJWK(privateJwk, MCP_JWT_ALGORITHM);
  const issuedAt = Math.floor(Date.now() / 1000);

  return await new SignJWT({
    apiKeyId: identity.keyId,
    ...(exchange
      ? {
          oauthPurpose: "authorization_code_exchange",
          oauthKeyHash: exchange.keyHash,
          oauthCodeHash: exchange.codeHash,
          oauthBindingHash: exchange.bindingHash,
          oauthRequestHash: exchange.requestHash,
        }
      : {}),
  })
    .setProtectedHeader({
      alg: MCP_JWT_ALGORITHM,
      kid: keyId,
      typ: "JWT",
    })
    .setIssuer(issuer)
    .setAudience(MCP_JWT_AUDIENCE)
    .setSubject(identity.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 60)
    .setJti(crypto.randomUUID())
    .sign(signingKey);
}
