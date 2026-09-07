import crypto from "node:crypto";

import { api } from "@repo/db/convex/_generated/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), sign: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation = mocks.mutation;
    setAuth() {}
  },
}));
vi.mock("./convex-auth", () => ({
  createConvexMcpToken: mocks.sign,
}));

import { POST } from "../../app/api/mcp/token/route";
import {
  encryptAuthCode,
  hashAuthorizationCode,
  hashOAuthBinding,
} from "./oauth";

const verifier = "v".repeat(43);
const challenge = crypto
  .createHash("sha256")
  .update(verifier, "ascii")
  .digest("base64url");

function makeCode() {
  return encryptAuthCode({
    apiKey: `ob_${"a".repeat(64)}`,
    apiKeyId: "key-id",
    userId: "user-id",
    requestHash: "b".repeat(64),
    bindingSeedHash: "c".repeat(64),
    clientId: "client-id",
    redirectUri: "https://client.example.test/callback",
    resource: "https://brain.example.test/api/mcp",
    codeChallenge: challenge,
    scope: "open-brain",
    exp: Date.now() + 5 * 60 * 1000,
  });
}

function request(code: string, codeVerifier = verifier) {
  return new Request("https://brain.example.test/api/mcp/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: "https://client.example.test/callback",
      client_id: "client-id",
      resource: "https://brain.example.test/api/mcp",
    }),
  });
}

describe("OAuth token exchange", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MCP_JWT_ISSUER", "https://brain.example.test");
    vi.stubEnv(
      "MCP_OAUTH_ENCRYPTION_KEY",
      Buffer.alloc(32, 9).toString("base64url"),
    );
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    mocks.sign.mockResolvedValue("exchange-jwt");
    mocks.mutation.mockResolvedValue({ status: "activated" });
  });
  afterEach(() => vi.unstubAllEnvs());

  test("uses a purpose-scoped exchange JWT and activates before returning the key", async () => {
    const code = makeCode();
    const codeHash = hashAuthorizationCode(code);
    const bindingHash = hashOAuthBinding("c".repeat(64), codeHash);
    const response = await POST(request(code));
    expect(response.status).toBe(200);
    expect(mocks.sign).toHaveBeenCalledWith(
      { userId: "user-id", keyId: "key-id" },
      {
        keyHash: hashAuthorizationCode(`ob_${"a".repeat(64)}`),
        codeHash,
        bindingHash,
        requestHash: "b".repeat(64),
      },
    );
    expect(mocks.mutation).toHaveBeenCalledWith(
      api.models.oauth.mcpMutations.activateAuthorizationGrant,
      expect.objectContaining({ codeHash, bindingHash }),
    );
    expect(await response.json()).toMatchObject({
      access_token: `ob_${"a".repeat(64)}`,
      token_type: "Bearer",
    });
  });

  test("never returns token success for a consumed-code replay", async () => {
    mocks.mutation.mockResolvedValue({ status: "replayed" });
    const response = await POST(request(makeCode()));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("rejects invalid PKCE before signing or mutating", async () => {
    const response = await POST(request(makeCode(), "x".repeat(43)));
    expect(response.status).toBe(400);
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
