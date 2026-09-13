import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

const issuer = "https://brain.example.test";

describe("MCP account isolation", () => {
  const originalIssuer = process.env.MCP_JWT_ISSUER;

  beforeEach(() => {
    process.env.MCP_JWT_ISSUER = issuer;
  });

  afterEach(() => {
    if (originalIssuer === undefined) {
      delete process.env.MCP_JWT_ISSUER;
    } else {
      process.env.MCP_JWT_ISSUER = originalIssuer;
    }
  });

  test("rejects missing, untrusted, deleted, and subject-mismatched credentials", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.models.thoughts.mcpQueries.getStats, {}),
    ).rejects.toThrow("Not authenticated");

    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const personalSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: userId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: personalSpaceId,
        userId,
        role: "owner",
      });
      await ctx.db.insert("userSpaceSettings", { userId, personalSpaceId });
      const keyId = await ctx.db.insert("apiKeys", {
        userId,
        keyHash: "1".repeat(64),
        keyPrefix: "ob_valid",
        name: "valid",
        capabilities: ["read", "write"],
        spaceIds: [personalSpaceId],
      });
      const otherId = await ctx.db.insert("users", {});
      return { userId, keyId, otherId };
    });

    const untrusted = t.withIdentity({
      issuer: "https://attacker.example.test",
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });
    await expect(
      untrusted.query(api.models.thoughts.mcpQueries.getStats, {}),
    ).rejects.toThrow("Not authenticated");

    const mismatched = t.withIdentity({
      issuer,
      subject: seeded.otherId,
      apiKeyId: seeded.keyId,
    });
    await expect(
      mismatched.query(api.models.thoughts.mcpQueries.getStats, {}),
    ).rejects.toThrow("Not authenticated");

    await t.run((ctx) => ctx.db.delete(seeded.keyId));
    const deleted = t.withIdentity({
      issuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });
    await expect(
      deleted.query(api.models.thoughts.mcpQueries.getStats, {}),
    ).rejects.toThrow("Not authenticated");
  });

  test("requires read and write capabilities for thought capture", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const personalSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: userId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: personalSpaceId,
        userId,
        role: "owner",
      });
      await ctx.db.insert("userSpaceSettings", { userId, personalSpaceId });
      const createKey = async (
        name: string,
        capabilities: Array<"read" | "write">,
      ) =>
        await ctx.db.insert("apiKeys", {
          userId,
          keyHash: name.repeat(64).slice(0, 64),
          keyPrefix: `ob_${name}`,
          name,
          capabilities,
          spaceIds: [personalSpaceId],
        });
      return {
        userId,
        readKey: await createKey("r", ["read"]),
        writeKey: await createKey("w", ["write"]),
      };
    });
    const asKey = (keyId: typeof seeded.readKey) =>
      t.withIdentity({ issuer, subject: seeded.userId, apiKeyId: keyId });

    for (const keyId of [seeded.readKey, seeded.writeKey]) {
      await expect(
        asKey(keyId).action(api.models.thoughts.mcpActions.capture, {
          content: "A grounded memory",
          sourceType: "user_stated",
        }),
      ).rejects.toThrow("Thought capture requires read and write capabilities");
    }
  });

  test("activates a pending OAuth key once and revokes it on validated replay", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const sharedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Family",
        createdBy: userId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: sharedSpaceId,
        userId,
        role: "reader",
      });
      const keyId = await ctx.db.insert("apiKeys", {
        userId,
        keyHash: "c".repeat(64),
        keyPrefix: "ob_code",
        name: "read shared",
        capabilities: ["read"],
        spaceIds: [sharedSpaceId],
        sourceAccountIds: [],
        oauthLifecycle: "pending",
        oauthRequestHash: "b".repeat(64),
        oauthCodeHash: "a".repeat(64),
        oauthBindingHash: "d".repeat(64),
        oauthBindingSeedHash: "e".repeat(64),
        oauthEncryptedCode: "obac1.synthetic",
        oauthGrantExpiresAt: Date.now() + 5 * 60 * 1000,
      });
      return { userId, keyId };
    });
    const caller = t.withIdentity({
      issuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
      oauthPurpose: "authorization_code_exchange",
      oauthKeyHash: "c".repeat(64),
      oauthCodeHash: "a".repeat(64),
      oauthBindingHash: "d".repeat(64),
      oauthRequestHash: "b".repeat(64),
    });
    const codeHash = "a".repeat(64);
    const expiresAt = await t.run(
      async (ctx) => (await ctx.db.get(seeded.keyId))!.oauthGrantExpiresAt!,
    );
    expect(
      await caller.mutation(
        api.models.oauth.mcpMutations.activateAuthorizationGrant,
        {
          codeHash,
          keyHash: "c".repeat(64),
          bindingHash: "d".repeat(64),
          requestHash: "b".repeat(64),
          expiresAt,
        },
      ),
    ).toEqual({ status: "activated" });
    expect(
      await caller.mutation(
        api.models.oauth.mcpMutations.activateAuthorizationGrant,
        {
          codeHash,
          keyHash: "c".repeat(64),
          bindingHash: "d".repeat(64),
          requestHash: "b".repeat(64),
          expiresAt,
        },
      ),
    ).toEqual({ status: "replayed" });
    expect(await t.run((ctx) => ctx.db.get(seeded.keyId))).toBeNull();
  });
});
