// What `/api/mcp` binds the server to, on both surfaces.
//
// The property is the same in either mode and is the reason this test exists:
// the server is built from the credential that authenticated and from nothing in
// the request body. The body below names a principal and a key; neither reaches
// `createMcpServer`, because `authenticateApiKey` reads one header and the route
// reads nothing else.
//
// Under `convex` the credential is the minted identity token. Under `postgres`
// nothing is minted at all: the route passes a loader built over the reference
// `{ userId, credentialId }`, which carries no authority of its own.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  token: vi.fn(),
  createServer: vi.fn(),
  connect: vi.fn(),
  handle: vi.fn(),
}));
vi.mock("./auth", () => ({ authenticateApiKey: mocks.authenticate }));
vi.mock("./convex-auth", () => ({ createConvexMcpToken: mocks.token }));
vi.mock("./server", () => ({ createMcpServer: mocks.createServer }));
vi.mock("./environment", () => ({
  getMcpPublicOrigin: () => "https://example.test",
}));
vi.mock(
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  () => ({
    WebStandardStreamableHTTPServerTransport: class {
      handleRequest = mocks.handle;
    },
  }),
);
import { POST } from "../../app/api/mcp/route";

function requestNaming(identity: Record<string, string>) {
  return new Request("https://example.test/api/mcp", {
    method: "POST",
    headers: { authorization: "Bearer synthetic-key" },
    body: JSON.stringify(identity),
  });
}

describe("finance gateway credential binding", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.token.mockResolvedValue("synthetic-convex-token");
    mocks.createServer.mockReturnValue({ connect: mocks.connect });
    mocks.handle.mockResolvedValue(new Response("{}", { status: 200 }));
  });
  afterEach(() => vi.unstubAllEnvs());

  test("each request binds the authenticated credential, ignoring body identity", async () => {
    for (const keyId of ["key-a", "key-b"]) {
      mocks.authenticate.mockResolvedValue({ userId: "user-a", keyId });
      expect(
        (
          await POST(
            requestNaming({ principalId: "forged", keyId: "forged" }),
          )
        ).status,
      ).toBe(200);
      expect(mocks.createServer).toHaveBeenLastCalledWith(
        { surface: "convex", convexAuthToken: "synthetic-convex-token" },
        `user-a:${keyId}`,
      );
    }
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    mocks.authenticate.mockResolvedValue(null);
    expect(
      (
        await POST(
          new Request("https://example.test/api/mcp", { method: "POST" }),
        )
      ).status,
    ).toBe(401);
    expect(mocks.createServer).toHaveBeenCalledTimes(2);
  });

  test("the postgres surface binds a loader and mints no token", async () => {
    vi.stubEnv("KITH_POSTGRES_SURFACE", "postgres");
    mocks.authenticate.mockResolvedValue({
      userId: "user-a",
      keyId: "key-a",
    });

    expect(
      (
        await POST(requestNaming({ userId: "forged", keyId: "forged" }))
      ).status,
    ).toBe(200);

    // No JWT is minted on this surface, which is what makes i7's deletion of
    // `convex-auth.ts` a deletion rather than a behavior change.
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.createServer).toHaveBeenCalledTimes(1);
    const [credential, principalId] = mocks.createServer.mock.calls[0]!;
    expect(principalId).toBe("user-a:key-a");
    expect(credential).toEqual({
      surface: "postgres",
      withPrincipal: expect.any(Function),
    });

    mocks.authenticate.mockResolvedValue(null);
    expect(
      (
        await POST(
          new Request("https://example.test/api/mcp", { method: "POST" }),
        )
      ).status,
    ).toBe(401);
    expect(mocks.createServer).toHaveBeenCalledTimes(1);
  });

  // Finding 1 of the second-model review: an authenticator that throws is an
  // outage, not a denial, and a 401 would send a client with a valid key back
  // through the OAuth flow.
  test("an authenticator failure is 503, not 401, and builds no server", async () => {
    mocks.authenticate.mockRejectedValue(
      Object.assign(new Error("serialization failure"), { code: "40001" }),
    );

    const response = await POST(
      requestNaming({ principalId: "forged", keyId: "forged" }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toMatchObject({
      error: "authentication_unavailable",
    });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});
