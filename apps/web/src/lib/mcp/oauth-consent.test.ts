// The consent route's own decisions, with the three grant calls stubbed.
//
// i7b repointed this from the Convex mutations onto
// `identity.{begin,finalize,abandon}AuthorizationGrant`, which is what the route
// calls now. What it pins is the route: which refusals are 400 before anything
// is written, that a request without a web session writes nothing, that a failed
// finalize compensates, and that a typed denial keeps its status and names no
// space. The flow against a real database is `oauth-postgres.test.ts`.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  begin: vi.fn(),
  finalize: vi.fn(),
  abandon: vi.fn(),
}));
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
  requireWebPrincipal: mocks.principal,
  beginAuthorizationGrant: mocks.begin,
  finalizeAuthorizationGrant: mocks.finalize,
  abandonAuthorizationGrant: mocks.abandon,
}));

import { IdentityError } from "@repo/kith-store/identity";

import { POST } from "../../app/api/mcp/authorize/complete/route";
import { encryptClientRegistration } from "./oauth";

const PRINCIPAL = { userId: "owner-user", capabilities: ["read"] as const };

function issuedGrant() {
  return {
    status: "issued" as const,
    keyId: "created-key",
    userId: "owner-user",
    rawKey: "ob_" + "a".repeat(64),
    requestHash: "b".repeat(64),
    bindingSeedHash: "c".repeat(64),
    preparationNonce: "d".repeat(64),
    grantExpiresAt: Date.now() + 5 * 60 * 1000,
  };
}

function request(
  grants: Record<string, unknown>,
  redirectUri = "https://client.example.test/callback",
) {
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
      redirectUri,
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
    vi.stubEnv("MCP_PUBLIC_ORIGIN", "https://brain.example.test");
    vi.stubEnv(
      "MCP_OAUTH_ENCRYPTION_KEY",
      Buffer.alloc(32, 7).toString("base64url"),
    );
    vi.stubEnv("KITH_SESSION_SECRET", "s".repeat(32));
    mocks.principal.mockResolvedValue(PRINCIPAL);
    mocks.begin.mockResolvedValue(issuedGrant());
    mocks.finalize.mockResolvedValue(undefined);
    mocks.abandon.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  test.each([
    {},
    { spaceIds: [], capabilities: ["read"] },
    { spaceIds: ["space"], capabilities: [] },
    { spaceIds: ["space"], capabilities: ["ingest"] },
  ])("requires explicit nonempty supported grants", async (grants) => {
    expect((await POST(request(grants))).status).toBe(400);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  test("issues exactly the selected grants through the authenticated call", async () => {
    const response = await POST(
      request({
        spaceIds: ["space"],
        capabilities: ["read"],
        userId: "attacker",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.begin.mock.calls[0]?.[1]).toEqual({
      clientId: expect.any(String),
      redirectUri: "https://client.example.test/callback",
      resource: "https://brain.example.test/api/mcp",
      codeChallenge: "a".repeat(43),
      scope: "open-brain",
      name: "MCP (Synthetic client)",
      spaceIds: ["space"],
      capabilities: ["read"],
      // The session's principal, never the body's `userId`.
      principal: PRINCIPAL,
    });
  });

  test("does not issue credentials without a web session", async () => {
    mocks.principal.mockRejectedValue(new IdentityError("Not authenticated"));
    expect(
      (await POST(request({ spaceIds: ["space"], capabilities: ["read"] })))
        .status,
    ).toBe(401);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  test("abandons the fenced preparation when authorization-code creation fails", async () => {
    mocks.begin.mockImplementation(async () => {
      vi.stubEnv("MCP_OAUTH_ENCRYPTION_KEY", "invalid-after-create");
      return issuedGrant();
    });

    const response = await POST(
      request({ spaceIds: ["space"], capabilities: ["read"] }),
    );

    expect(response.status).toBe(500);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.abandon.mock.calls[0]?.[1]).toEqual({
      keyId: "created-key",
      requestHash: "b".repeat(64),
      preparationNonce: "d".repeat(64),
      principal: PRINCIPAL,
    });
  });

  test("returns the exact stored code for an idempotent pending retry", async () => {
    mocks.begin.mockResolvedValue({
      status: "pending",
      encryptedCode: "obac1.stored-code",
    });
    const response = await POST(
      request({ spaceIds: ["space"], capabilities: ["read"] }),
    );
    expect(response.status).toBe(200);
    const location = new URL((await response.json()).redirect_url);
    expect(location.searchParams.get("code")).toBe("obac1.stored-code");
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  test("requires a fresh authorization request after consumption", async () => {
    mocks.begin.mockResolvedValue({ status: "consumed" });
    const response = await POST(
      request({ spaceIds: ["space"], capabilities: ["read"] }),
    );
    expect(response.status).toBe(409);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  test("maps the typed space_not_found read denial to 403, naming no space", async () => {
    // What `beginAuthorizationGrant` rethrows unchanged when
    // `getAuthorizedReadSpaceIds` refuses a space the session cannot read.
    // `oauthMutationErrorResponse` must map it rather than letting it fall into
    // the 500 default, where a caller could not tell it from an outage.
    mocks.begin.mockRejectedValue(
      new IdentityError("Space not found", {
        type: "space_read_error",
        code: "space_not_found",
        message: "Space not found",
      } as ConstructorParameters<typeof IdentityError>[1]),
    );
    const response = await POST(
      request({
        spaceIds: ["space-the-session-cannot-read"],
        capabilities: ["read"],
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ error: "Selected space is not available" });
    expect(JSON.stringify(body)).not.toContain("space-the-session-cannot-read");
  });

  test("denial redirects to the registered URI with access_denied and state", async () => {
    const response = await POST(
      request({ decision: "deny", state: "opaque-state" }),
    );
    expect(response.status).toBe(200);
    const location = new URL((await response.json()).redirect_url);
    expect(location.origin + location.pathname).toBe(
      "https://client.example.test/callback",
    );
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("opaque-state");
    expect(location.searchParams.has("code")).toBe(false);
    // Nothing is granted: no session lookup, no key, no code.
    expect(mocks.principal).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  test("denial wins over a grant in the same body", async () => {
    const response = await POST(
      request({ decision: "deny", spaceIds: ["space"], capabilities: ["read"] }),
    );
    const location = new URL((await response.json()).redirect_url);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.has("state")).toBe(false);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  test("denial never redirects to an unregistered URI", async () => {
    const response = await POST(
      request({ decision: "deny" }, "https://attacker.example.test/callback"),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty("redirect_url");
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});
