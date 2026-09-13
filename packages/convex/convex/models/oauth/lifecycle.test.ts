import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";

const webIssuer = "https://web.synthetic.test";
const mcpIssuer = "https://mcp.synthetic.test";

function hash(value: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) =>
      Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    );
}

async function fixture() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "OAuth owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Shared",
      createdBy: userId,
    });
    const membershipId = await ctx.db.insert("spaceMembers", {
      spaceId,
      userId,
      role: "owner",
    });
    return { userId, spaceId, membershipId };
  });
  return {
    t,
    ...seeded,
    web: t.withIdentity({ issuer: webIssuer, subject: seeded.userId }),
  };
}

function request(
  spaceId: Id<"spaces">,
  state = "state-1",
  capabilities: Array<"read" | "write"> = ["read"],
) {
  return {
    clientId: "client-registration",
    redirectUri: "https://client.example.test/callback",
    resource: "https://brain.example.test/api/mcp",
    codeChallenge: "a".repeat(43),
    scope: "open-brain" as const,
    state,
    name: "MCP (Synthetic)",
    capabilities,
    spaceIds: [String(spaceId)],
  };
}

async function finalize(
  f: Awaited<ReturnType<typeof fixture>>,
  issued: {
    status: "issued";
    keyId: Id<"apiKeys">;
    userId: Id<"users">;
    rawKey: string;
    requestHash: string;
    bindingSeedHash: string;
    preparationNonce: string;
    grantExpiresAt: number;
  },
) {
  const encryptedCode = `obac1.${"x".repeat(80)}`;
  const codeHash = await hash(encryptedCode);
  const bindingHash = await hash(
    `oauth-binding-v1\0${issued.bindingSeedHash}\0${codeHash}`,
  );
  await f.web.mutation(api.models.oauth.web.finalizeAuthorizationGrant, {
    keyId: issued.keyId,
    requestHash: issued.requestHash,
    preparationNonce: issued.preparationNonce,
    encryptedCode,
    codeHash,
    bindingHash,
    grantExpiresAt: issued.grantExpiresAt,
  });
  return { encryptedCode, codeHash, bindingHash };
}

describe("OAuth grant lifecycle", () => {
  beforeEach(() => vi.stubEnv("MCP_JWT_ISSUER", mcpIssuer));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("keeps preparation inert, retries finalized consent, activates once, and revokes replay", async () => {
    const f = await fixture();
    const issued = await f.web.mutation(
      api.models.oauth.web.beginAuthorizationGrant,
      request(f.spaceId),
    );
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("expected issuance");
    const keyHash = await hash(issued.rawKey);
    expect(
      await f.t.action(api.models.apiKeys.mcpAuth.authenticateKeyHash, {
        keyHash,
      }),
    ).toBeNull();

    const finalized = await finalize(f, issued);
    const retry = await f.web.mutation(
      api.models.oauth.web.beginAuthorizationGrant,
      request(f.spaceId),
    );
    expect(retry).toMatchObject({
      status: "pending",
      keyId: issued.keyId,
      encryptedCode: finalized.encryptedCode,
    });

    const exchange = f.t.withIdentity({
      issuer: mcpIssuer,
      subject: f.userId,
      apiKeyId: issued.keyId,
      oauthPurpose: "authorization_code_exchange",
      oauthKeyHash: keyHash,
      oauthCodeHash: finalized.codeHash,
      oauthBindingHash: finalized.bindingHash,
      oauthRequestHash: issued.requestHash,
    });
    const activationArgs = {
      codeHash: finalized.codeHash,
      keyHash,
      bindingHash: finalized.bindingHash,
      requestHash: issued.requestHash,
      expiresAt: issued.grantExpiresAt,
    };
    await expect(
      exchange.query(api.models.thoughts.mcpQueries.getStats, {}),
    ).rejects.toThrow("Not authenticated");
    expect(
      await exchange.mutation(
        api.models.oauth.mcpMutations.activateAuthorizationGrant,
        activationArgs,
      ),
    ).toEqual({ status: "activated" });
    expect(
      await f.web.mutation(
        api.models.oauth.web.beginAuthorizationGrant,
        request(f.spaceId),
      ),
    ).toEqual({ status: "consumed" });
    expect(
      await exchange.mutation(
        api.models.oauth.mcpMutations.activateAuthorizationGrant,
        activationArgs,
      ),
    ).toEqual({ status: "replayed" });
    expect(await f.t.run((ctx) => ctx.db.get(issued.keyId))).toBeNull();
  });

  test("rejects stale finalize fencing and live scope revocation", async () => {
    const f = await fixture();
    const issued = await f.web.mutation(
      api.models.oauth.web.beginAuthorizationGrant,
      request(f.spaceId),
    );
    if (issued.status !== "issued") throw new Error("expected issuance");
    const encryptedCode = `obac1.${"z".repeat(80)}`;
    const codeHash = await hash(encryptedCode);
    const bindingHash = await hash(
      `oauth-binding-v1\0${issued.bindingSeedHash}\0${codeHash}`,
    );
    await expect(
      f.web.mutation(api.models.oauth.web.finalizeAuthorizationGrant, {
        keyId: issued.keyId,
        requestHash: issued.requestHash,
        preparationNonce: "f".repeat(64),
        encryptedCode,
        codeHash,
        bindingHash,
        grantExpiresAt: issued.grantExpiresAt,
      }),
    ).rejects.toThrow();
    await f.t.run((ctx) => ctx.db.delete(f.membershipId));
    await expect(finalize(f, issued)).rejects.toThrow();
    const keyId: Id<"apiKeys"> = issued.keyId;
    const key = await f.t.run((ctx) => ctx.db.get(keyId));
    expect(key?.oauthLifecycle).toBe("preparing");
  });

  test("replaces an expired preparation lease without allowing stale cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T08:00:00.000Z"));
    const f = await fixture();
    const first = await f.web.mutation(
      api.models.oauth.web.beginAuthorizationGrant,
      request(f.spaceId),
    );
    if (first.status !== "issued") throw new Error("expected issuance");
    vi.advanceTimersByTime(31_000);
    const replacement = await f.web.mutation(
      api.models.oauth.web.beginAuthorizationGrant,
      request(f.spaceId),
    );
    if (replacement.status !== "issued")
      throw new Error("expected replacement");
    expect(replacement.keyId).not.toBe(first.keyId);
    await f.web.mutation(api.models.oauth.web.abandonAuthorizationGrant, {
      keyId: first.keyId,
      requestHash: first.requestHash,
      preparationNonce: first.preparationNonce,
    });
    const replacementKeyId: Id<"apiKeys"> = replacement.keyId;
    expect(await f.t.run((ctx) => ctx.db.get(replacementKeyId))).not.toBeNull();
  });

  test("rechecks live space access during atomic activation", async () => {
    const f = await fixture();
    const issued = await f.web.mutation(
      api.models.oauth.web.beginAuthorizationGrant,
      request(f.spaceId),
    );
    if (issued.status !== "issued") throw new Error("expected issuance");
    const finalized = await finalize(f, issued);
    const keyHash = await hash(issued.rawKey);
    await f.t.run((ctx) => ctx.db.delete(f.membershipId));
    const exchange = f.t.withIdentity({
      issuer: mcpIssuer,
      subject: f.userId,
      apiKeyId: issued.keyId,
      oauthPurpose: "authorization_code_exchange",
      oauthKeyHash: keyHash,
      oauthCodeHash: finalized.codeHash,
      oauthBindingHash: finalized.bindingHash,
      oauthRequestHash: issued.requestHash,
    });
    await expect(
      exchange.mutation(
        api.models.oauth.mcpMutations.activateAuthorizationGrant,
        {
          codeHash: finalized.codeHash,
          keyHash,
          bindingHash: finalized.bindingHash,
          requestHash: issued.requestHash,
          expiresAt: issued.grantExpiresAt,
        },
      ),
    ).rejects.toThrow("Authorization code is invalid");
    const keyId: Id<"apiKeys"> = issued.keyId;
    expect((await f.t.run((ctx) => ctx.db.get(keyId)))?.oauthLifecycle).toBe(
      "pending",
    );
  });

  test("activates read-write scope for a readable reader space", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.patch(f.membershipId, { role: "reader" }));
    const issued = await f.web.mutation(
      api.models.oauth.web.beginAuthorizationGrant,
      request(f.spaceId, "reader", ["read", "write"]),
    );
    if (issued.status !== "issued") throw new Error("expected issuance");
    const finalized = await finalize(f, issued);
    const keyHash = await hash(issued.rawKey);
    const exchange = f.t.withIdentity({
      issuer: mcpIssuer,
      subject: f.userId,
      apiKeyId: issued.keyId,
      oauthPurpose: "authorization_code_exchange",
      oauthKeyHash: keyHash,
      oauthCodeHash: finalized.codeHash,
      oauthBindingHash: finalized.bindingHash,
      oauthRequestHash: issued.requestHash,
    });
    expect(
      await exchange.mutation(
        api.models.oauth.mcpMutations.activateAuthorizationGrant,
        {
          codeHash: finalized.codeHash,
          keyHash,
          bindingHash: finalized.bindingHash,
          requestHash: issued.requestHash,
          expiresAt: issued.grantExpiresAt,
        },
      ),
    ).toEqual({ status: "activated" });
  });

  test("fails closed for malformed lifecycle metadata", async () => {
    const f = await fixture();
    const malformed = await f.t.run(async (ctx) => {
      return await ctx.db.insert("apiKeys", {
        userId: f.userId,
        keyHash: "9".repeat(64),
        keyPrefix: "ob_invalid",
        name: "Malformed",
        capabilities: ["read"],
        spaceIds: [f.spaceId],
        oauthRequestHash: "a".repeat(64),
      });
    });
    expect(
      await f.t.action(api.models.apiKeys.mcpAuth.authenticateKeyHash, {
        keyHash: "9".repeat(64),
      }),
    ).toBeNull();
    await expect(
      f.web.query(api.models.apiKeys.public.listPage, {
        paginationOpts: { cursor: null, numItems: 25 },
      }),
    ).rejects.toThrow("API key lifecycle data is invalid");
    expect(await f.t.run((ctx) => ctx.db.get(malformed))).not.toBeNull();
  });

  test("audits invalid OAuth lifecycle expiry ordering", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("apiKeys", {
        userId: f.userId,
        keyHash: "a".repeat(64),
        keyPrefix: "ob_expiry",
        name: "Invalid expiry",
        capabilities: ["read"],
        spaceIds: [f.spaceId],
        oauthLifecycle: "preparing",
        oauthRequestHash: "b".repeat(64),
        oauthBindingSeedHash: "c".repeat(64),
        oauthGrantExpiresAt: 100,
        oauthPreparationExpiresAt: 101,
        oauthPreparationNonce: "d".repeat(64),
      });
    });
    const audit = await f.t.query(
      internal.models.apiKeys.migrations.auditOAuthLifecycle,
      { batchSize: 50 },
    );
    expect(audit).toMatchObject({ invalidCount: 1, blocked: true });
  });

  test("paginates active keys, hides pending keys, and bounds the legacy list", async () => {
    const f = await fixture();
    const pendingId = await f.t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("apiKeys", {
          userId: f.userId,
          keyHash: index.toString(16).padStart(64, "0"),
          keyPrefix: `ob_${index}`,
          name: `Key ${index}`,
          capabilities: ["read"],
          spaceIds: [f.spaceId],
        });
      }
      return await ctx.db.insert("apiKeys", {
        userId: f.userId,
        keyHash: "f".repeat(64),
        keyPrefix: "ob_pending",
        name: "Pending",
        capabilities: ["read"],
        spaceIds: [f.spaceId],
        oauthLifecycle: "preparing",
        oauthRequestHash: "1".repeat(64),
        oauthBindingSeedHash: "2".repeat(64),
        oauthGrantExpiresAt: Date.now() + 60_000,
        oauthPreparationExpiresAt: Date.now() + 30_000,
        oauthPreparationNonce: "3".repeat(64),
      });
    });
    await expect(
      f.web.query(api.models.apiKeys.public.list, {}),
    ).rejects.toThrow("Too many API keys");
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const page: {
        page: Array<{ _id: Id<"apiKeys"> }>;
        isDone: boolean;
        continueCursor: string;
      } = await f.web.query(api.models.apiKeys.public.listPage, {
        paginationOpts: { cursor, numItems: 17 },
      });
      ids.push(...page.page.map((key) => key._id));
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    expect(ids).toHaveLength(101);
    expect(ids).not.toContain(pendingId);
  });

  test("bounds live grants independently of older active keys", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let index = 0; index < 102; index += 1) {
        await ctx.db.insert("apiKeys", {
          userId: f.userId,
          keyHash: index.toString(16).padStart(64, "0"),
          keyPrefix: `ob_${index}`,
          name: `Active ${index}`,
          capabilities: ["read"],
          spaceIds: [f.spaceId],
        });
      }
      for (let index = 0; index < 20; index += 1) {
        await ctx.db.insert("apiKeys", {
          userId: f.userId,
          keyHash: (index + 500).toString(16).padStart(64, "0"),
          keyPrefix: `ob_pending_${index}`,
          name: `Pending ${index}`,
          capabilities: ["read"],
          spaceIds: [f.spaceId],
          oauthLifecycle: "preparing",
          oauthRequestHash: (index + 1000).toString(16).padStart(64, "0"),
          oauthBindingSeedHash: (index + 2000).toString(16).padStart(64, "0"),
          oauthGrantExpiresAt: Date.now() + 60_000,
          oauthPreparationExpiresAt: Date.now() + 30_000,
          oauthPreparationNonce: (index + 3000).toString(16).padStart(64, "0"),
        });
      }
    });
    await expect(
      f.web.mutation(
        api.models.oauth.web.beginAuthorizationGrant,
        request(f.spaceId, "distinct"),
      ),
    ).rejects.toThrow("Too many OAuth authorization grants");
  });

  test("cleanup is bounded across grant and receipt states", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("apiKeys", {
        userId: f.userId,
        keyHash: "7".repeat(64),
        keyPrefix: "ob_expired",
        name: "Expired",
        capabilities: ["read"],
        spaceIds: [f.spaceId],
        oauthLifecycle: "pending",
        oauthRequestHash: "4".repeat(64),
        oauthCodeHash: "5".repeat(64),
        oauthBindingHash: "6".repeat(64),
        oauthBindingSeedHash: "7".repeat(64),
        oauthEncryptedCode: "obac1.expired",
        oauthGrantExpiresAt: Date.now() - 1,
      });
      await ctx.db.insert("consumedOAuthCodes", {
        userId: f.userId,
        codeHash: "8".repeat(64),
        expiresAt: Date.now() - 1,
      });
    });
    expect(
      await f.t.mutation(internal.models.oauth.cleanup.removeExpired, {
        limit: 1,
      }),
    ).toEqual({ deleted: 1, hasMore: true });
    expect(
      await f.t.mutation(internal.models.oauth.cleanup.removeExpired, {
        limit: 1,
      }),
    ).toEqual({ deleted: 1, hasMore: true });
  });
});
