// The token endpoint's own decisions, with the exchange stubbed.
//
// i7b deleted the purpose-scoped JWT the route used to mint, so what it asserts
// is the pair that replaced it: `requireOAuthExchangeIdentity` and
// `activateAuthorizationGrant` both run, on the same hashes, and neither runs
// before PKCE has been verified. The full flow against a real database is
// `oauth-postgres.test.ts`.

import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireExchange: vi.fn(), activate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/kith/pool", () => ({ kithPool: () => ({}) }));
vi.mock("@repo/kith-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/kith-store")>()),
  withKithTransaction: async (
    _pool: unknown,
    work: (client: unknown) => Promise<unknown>,
  ) => await work({}),
}));
vi.mock("@repo/kith-store/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/kith-store/identity")>()),
  identityCtx: () => ({}),
  requireOAuthExchangeIdentity: mocks.requireExchange,
  activateAuthorizationGrant: mocks.activate,
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
    vi.stubEnv("MCP_PUBLIC_ORIGIN", "https://brain.example.test");
    vi.stubEnv(
      "MCP_OAUTH_ENCRYPTION_KEY",
      Buffer.alloc(32, 9).toString("base64url"),
    );
    mocks.requireExchange.mockResolvedValue(undefined);
    mocks.activate.mockResolvedValue({ status: "activated" });
  });
  afterEach(() => vi.unstubAllEnvs());

  test("proves the exchange identity and activates before returning the key", async () => {
    const code = makeCode();
    const codeHash = hashAuthorizationCode(code);
    const bindingHash = hashOAuthBinding("c".repeat(64), codeHash);
    const response = await POST(request(code));
    expect(response.status).toBe(200);
    const exchange = {
      apiKeyId: "key-id",
      userId: "user-id",
      codeHash,
      keyHash: hashAuthorizationCode(`ob_${"a".repeat(64)}`),
      bindingHash,
      requestHash: "b".repeat(64),
      expiresAt: expect.any(Number),
    };
    expect(mocks.requireExchange.mock.calls[0]?.[1]).toEqual(exchange);
    // The same hashes, on the same client, in the same transaction.
    expect(mocks.activate.mock.calls[0]?.[1]).toEqual(exchange);
    expect(await response.json()).toMatchObject({
      access_token: `ob_${"a".repeat(64)}`,
      token_type: "Bearer",
    });
  });

  test("never returns token success for a consumed-code replay", async () => {
    mocks.activate.mockResolvedValue({ status: "replayed" });
    const response = await POST(request(makeCode()));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("rejects invalid PKCE before proving or activating anything", async () => {
    const response = await POST(request(makeCode(), "x".repeat(43)));
    expect(response.status).toBe(400);
    expect(mocks.requireExchange).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});
