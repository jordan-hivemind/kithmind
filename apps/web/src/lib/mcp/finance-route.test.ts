// What `/api/mcp` binds the server to.
//
// The property this test exists for: the server is built from the credential
// that authenticated and from nothing in the request body. The body below names
// a principal and a key; neither reaches `createMcpServer`, because
// `authenticateApiKey` reads one header and the route reads nothing else.
//
// Nothing is minted any more. The route passes a loader built over the
// reference `{ userId, credentialId }`, which carries no authority of its own,
// which is what makes i7b's deletion of `convex-auth.ts` a deletion rather than
// a behavior change.

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  createServer: vi.fn(),
  connect: vi.fn(),
  handle: vi.fn(),
}));
vi.mock("./auth", () => ({ authenticateApiKey: mocks.authenticate }));
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
    mocks.createServer.mockReturnValue({ connect: mocks.connect });
    mocks.handle.mockResolvedValue(new Response("{}", { status: 200 }));
  });

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
      const [credential, principalId] = mocks.createServer.mock.lastCall!;
      expect(principalId).toBe(`user-a:${keyId}`);
      expect(credential).toEqual({
        surface: "postgres",
        withPrincipal: expect.any(Function),
      });
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
