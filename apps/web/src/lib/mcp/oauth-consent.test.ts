import { api } from "@repo/db/convex/_generated/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: vi.fn(), mutation: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@convex-dev/auth/nextjs/server", () => ({
  convexAuthNextjsToken: mocks.token,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation = mocks.mutation;
    setAuth() {}
  },
}));
import { POST } from "../../app/api/mcp/authorize/complete/route";
import { encryptClientRegistration } from "./oauth";

function request(grants: Record<string, unknown>) {
  const clientId = encryptClientRegistration({
    clientName: "Synthetic client",
    redirectUris: ["https://client.example.test/callback"],
    issuedAt: Date.now(),
  });
  return new Request("https://brain.example.test/api/mcp/authorize/complete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://brain.example.test",
    },
    body: JSON.stringify({
      clientId,
      redirectUri: "https://client.example.test/callback",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      responseType: "code",
      ...grants,
    }),
  });
}

describe("OAuth space consent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MCP_JWT_ISSUER", "https://brain.example.test");
    vi.stubEnv(
      "MCP_OAUTH_ENCRYPTION_KEY",
      Buffer.alloc(32, 7).toString("base64url"),
    );
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    mocks.token.mockResolvedValue("web-session-token");
    mocks.mutation
      .mockResolvedValueOnce({
        status: "issued",
        keyId: "created-key",
        userId: "owner-user",
        rawKey: "ob_" + "a".repeat(64),
        requestHash: "b".repeat(64),
        bindingSeedHash: "c".repeat(64),
        preparationNonce: "d".repeat(64),
        grantExpiresAt: Date.now() + 5 * 60 * 1000,
      })
      .mockResolvedValueOnce(null);
  });
  afterEach(() => vi.unstubAllEnvs());

  test.each([
    {},
    { spaceIds: [], capabilities: ["read"] },
    { spaceIds: ["space"], capabilities: [] },
    { spaceIds: ["space"], capabilities: ["ingest"] },
  ])("requires explicit nonempty supported grants", async (grants) => {
    expect((await POST(request(grants))).status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  test("issues exactly the selected grants through the authenticated mutation", async () => {
    const response = await POST(
      request({
        spaceIds: ["space"],
        capabilities: ["read"],
        userId: "attacker",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.mutation.mock.calls[0]?.[1]).toEqual({
      clientId: expect.any(String),
      redirectUri: "https://client.example.test/callback",
      resource: "https://brain.example.test/api/mcp",
      codeChallenge: "a".repeat(43),
      scope: "open-brain",
      name: "MCP (Synthetic client)",
      spaceIds: ["space"],
      capabilities: ["read"],
    });
  });
  test("does not issue credentials without a web session", async () => {
    mocks.token.mockResolvedValue(null);
    expect(
      (await POST(request({ spaceIds: ["space"], capabilities: ["read"] })))
        .status,
    ).toBe(401);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  test("abandons the fenced preparation when authorization-code creation fails", async () => {
    mocks.mutation.mockReset();
    mocks.mutation
      .mockImplementationOnce(async () => {
        vi.stubEnv("MCP_OAUTH_ENCRYPTION_KEY", "invalid-after-create");
        return {
          status: "issued",
          keyId: "created-key",
          userId: "owner-user",
          rawKey: "ob_" + "a".repeat(64),
          requestHash: "b".repeat(64),
          bindingSeedHash: "c".repeat(64),
          preparationNonce: "d".repeat(64),
          grantExpiresAt: Date.now() + 5 * 60 * 1000,
        };
      })
      .mockResolvedValueOnce(null);

    const response = await POST(
      request({ spaceIds: ["space"], capabilities: ["read"] }),
    );

    expect(response.status).toBe(500);
    expect(mocks.mutation).toHaveBeenNthCalledWith(
      2,
      api.models.oauth.web.abandonAuthorizationGrant,
      {
        keyId: "created-key",
        requestHash: "b".repeat(64),
        preparationNonce: "d".repeat(64),
      },
    );
  });

  test("returns the exact stored code for an idempotent pending retry", async () => {
    mocks.mutation.mockReset();
    mocks.mutation.mockResolvedValueOnce({
      status: "pending",
      keyId: "created-key",
      encryptedCode: "obac1.stored-code",
      grantExpiresAt: Date.now() + 60_000,
    });
    const response = await POST(
      request({ spaceIds: ["space"], capabilities: ["read"] }),
    );
    expect(response.status).toBe(200);
    const location = new URL((await response.json()).redirect_url);
    expect(location.searchParams.get("code")).toBe("obac1.stored-code");
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
  });

  test("requires a fresh authorization request after consumption", async () => {
    mocks.mutation.mockReset();
    mocks.mutation.mockResolvedValueOnce({ status: "consumed" });
    const response = await POST(
      request({ spaceIds: ["space"], capabilities: ["read"] }),
    );
    expect(response.status).toBe(409);
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
  });
});
