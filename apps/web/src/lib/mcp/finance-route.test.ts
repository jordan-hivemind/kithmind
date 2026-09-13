import { beforeEach, describe, expect, test, vi } from "vitest";

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
  getMcpIssuer: () => "https://example.test",
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

describe("finance gateway credential binding", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.token.mockResolvedValue("synthetic-convex-token");
    mocks.createServer.mockReturnValue({ connect: mocks.connect });
    mocks.handle.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  test("each request binds the authenticated credential, ignoring body identity", async () => {
    for (const keyId of ["key-a", "key-b"]) {
      mocks.authenticate.mockResolvedValue({ userId: "user-a", keyId });
      const request = new Request("https://example.test/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer synthetic-key" },
        body: JSON.stringify({ principalId: "forged", keyId: "forged" }),
      });
      expect((await POST(request)).status).toBe(200);
      expect(mocks.createServer).toHaveBeenLastCalledWith(
        "synthetic-convex-token",
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
});
