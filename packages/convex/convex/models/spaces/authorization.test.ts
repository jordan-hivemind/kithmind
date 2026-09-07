import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { requireSpaceAccess, webPrincipal } from "../../lib/spaces";
import schema from "../../legacySchema";
import { modules } from "../../test.setup";

const mcpIssuer = "https://brain.example.test";
const webIssuer = "https://brain.example.test/convex";

async function seedSpaces() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const [userId, otherUserId] = await Promise.all([
      ctx.db.insert("users", { name: "Synthetic owner" }),
      ctx.db.insert("users", { name: "Synthetic other" }),
    ]);
    const personalSpaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Personal",
      createdBy: userId,
    });
    const [editorSpaceId, readerSpaceId, inaccessibleSpaceId] =
      await Promise.all([
        ctx.db.insert("spaces", {
          kind: "shared",
          name: "Editor household",
          createdBy: otherUserId,
        }),
        ctx.db.insert("spaces", {
          kind: "shared",
          name: "Reader household",
          createdBy: otherUserId,
        }),
        ctx.db.insert("spaces", {
          kind: "shared",
          name: "Inaccessible household",
          createdBy: otherUserId,
        }),
      ]);
    await Promise.all([
      ctx.db.insert("spaceMembers", {
        spaceId: personalSpaceId,
        userId,
        role: "owner",
      }),
      ctx.db.insert("spaceMembers", {
        spaceId: editorSpaceId,
        userId,
        role: "editor",
      }),
      ctx.db.insert("spaceMembers", {
        spaceId: readerSpaceId,
        userId,
        role: "reader",
      }),
      ctx.db.insert("userSpaceSettings", { userId, personalSpaceId }),
    ]);
    return {
      userId,
      personalSpaceId,
      editorSpaceId,
      readerSpaceId,
      inaccessibleSpaceId,
    };
  });
  return { t, ...seeded };
}

async function insertKey(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  capabilities: Array<"read" | "write" | "ingest">,
  spaceIds: Id<"spaces">[],
) {
  return await t.run((ctx) =>
    ctx.db.insert("apiKeys", {
      userId,
      keyHash: crypto.randomUUID().replaceAll("-", ""),
      keyPrefix: "ob_test",
      name: "Synthetic key",
      capabilities,
      spaceIds,
    }),
  );
}

describe("space authorization", () => {
  const originalIssuer = process.env.MCP_JWT_ISSUER;

  beforeEach(() => {
    process.env.MCP_JWT_ISSUER = mcpIssuer;
  });

  afterEach(() => {
    if (originalIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
    else process.env.MCP_JWT_ISSUER = originalIssuer;
  });

  test("bootstraps one personal space for a new web user", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const session = t.withIdentity({ issuer: webIssuer, subject: userId });

    const first = await session.mutation(
      api.models.spaces.public.ensurePersonal,
    );
    const second = await session.mutation(
      api.models.spaces.public.ensurePersonal,
    );
    expect(second).toEqual(first);
    const rows = await t.run(async (ctx) => ({
      spaces: await ctx.db.query("spaces").collect(),
      memberships: await ctx.db.query("spaceMembers").collect(),
      settings: await ctx.db.query("userSpaceSettings").collect(),
    }));
    expect(rows.spaces).toHaveLength(1);
    expect(rows.memberships).toHaveLength(1);
    expect(rows.settings).toHaveLength(1);
  });

  test("intersects MCP list results with current membership and key scopes", async () => {
    const { t, userId, personalSpaceId, editorSpaceId, readerSpaceId } =
      await seedSpaces();
    const keyId = await insertKey(
      t,
      userId,
      ["read"],
      [personalSpaceId, readerSpaceId],
    );
    const mcp = t.withIdentity({
      issuer: mcpIssuer,
      subject: userId,
      apiKeyId: keyId,
    });
    const session = t.withIdentity({ issuer: webIssuer, subject: userId });

    await expect(mcp.query(api.models.spaces.mcpQueries.list)).resolves.toEqual(
      [
        expect.objectContaining({ spaceId: personalSpaceId, role: "owner" }),
        expect.objectContaining({ spaceId: readerSpaceId, role: "reader" }),
      ],
    );

    await session.mutation(api.models.apiKeys.public.update, {
      id: keyId,
      capabilities: ["read"],
      spaceIds: [editorSpaceId],
    });
    await expect(mcp.query(api.models.spaces.mcpQueries.list)).resolves.toEqual(
      [expect.objectContaining({ spaceId: editorSpaceId, role: "editor" })],
    );

    await session.mutation(api.models.apiKeys.public.revoke, { id: keyId });
    await expect(mcp.query(api.models.spaces.mcpQueries.list)).rejects.toThrow(
      "Not authenticated",
    );
  });

  test("enforces capability, current role, and exact scope on writes", async () => {
    const { t, userId, editorSpaceId, readerSpaceId, inaccessibleSpaceId } =
      await seedSpaces();
    const keyId = await insertKey(
      t,
      userId,
      ["read", "write"],
      [editorSpaceId, readerSpaceId, inaccessibleSpaceId],
    );
    const principal = { userId, credentialId: keyId };

    await expect(
      t.query(internal.models.spaces.private.authorize, {
        principal,
        spaceId: editorSpaceId,
        operation: "write",
      }),
    ).resolves.toEqual({ role: "editor" });
    await expect(
      t.query(internal.models.spaces.private.authorize, {
        principal,
        spaceId: readerSpaceId,
        operation: "write",
      }),
    ).rejects.toThrow("Space not found");
    await expect(
      t.query(internal.models.spaces.private.authorize, {
        principal,
        spaceId: inaccessibleSpaceId,
        operation: "read",
      }),
    ).rejects.toThrow("Space not found");

    const editorMembershipId = await t.run(
      async (ctx) =>
        (await ctx.db
          .query("spaceMembers")
          .withIndex("by_spaceId_and_userId", (q) =>
            q.eq("spaceId", editorSpaceId).eq("userId", userId),
          )
          .unique())!._id,
    );
    await t.run((ctx) => ctx.db.patch(editorMembershipId, { role: "reader" }));
    await expect(
      t.query(internal.models.spaces.private.authorize, {
        principal,
        spaceId: editorSpaceId,
        operation: "write",
      }),
    ).rejects.toThrow("Space not found");
    await t.run((ctx) => ctx.db.patch(editorMembershipId, { role: "editor" }));

    await t.run((ctx) => ctx.db.patch(keyId, { capabilities: ["read"] }));
    await expect(
      t.query(internal.models.spaces.private.authorize, {
        principal,
        spaceId: editorSpaceId,
        operation: "write",
      }),
    ).rejects.toThrow("Space not found");
  });

  test("rejects a retained credential after its user is deleted", async () => {
    const { t, userId, personalSpaceId } = await seedSpaces();
    const keyId = await insertKey(t, userId, ["read"], [personalSpaceId]);
    const mcp = t.withIdentity({
      issuer: mcpIssuer,
      subject: userId,
      apiKeyId: keyId,
    });

    await t.run((ctx) => ctx.db.delete(userId));
    await expect(mcp.query(api.models.spaces.mcpQueries.list)).rejects.toThrow(
      "Not authenticated",
    );
  });

  test("rejects a web-principal snapshot after its user is deleted", async () => {
    const { t, userId, personalSpaceId } = await seedSpaces();
    const snapshot = webPrincipal(userId);
    await t.run((ctx) => ctx.db.delete(userId));

    await expect(
      t.run((ctx) =>
        requireSpaceAccess(ctx, snapshot, personalSpaceId, "read"),
      ),
    ).rejects.toThrow("Not authenticated");
  });

  test("rejects an unbounded membership fan-out", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      for (let index = 0; index < 101; index += 1) {
        const spaceId = await ctx.db.insert("spaces", {
          kind: "shared",
          name: `Synthetic ${index}`,
          createdBy: id,
        });
        await ctx.db.insert("spaceMembers", {
          spaceId,
          userId: id,
          role: "reader",
        });
      }
      return id;
    });

    await expect(
      t.query(internal.models.spaces.private.listAuthorizedReadSpaceIds, {
        principal: { userId },
      }),
    ).rejects.toThrow("Too many space memberships");
  });

  test("keeps personal features outside a shared-only key scope", async () => {
    const { t, userId, personalSpaceId, editorSpaceId } = await seedSpaces();
    const keyId = await insertKey(t, userId, ["read"], [editorSpaceId]);
    const mcp = t.withIdentity({
      issuer: mcpIssuer,
      subject: userId,
      apiKeyId: keyId,
    });

    await expect(mcp.query(api.models.spaces.mcpQueries.list)).resolves.toEqual(
      [expect.objectContaining({ spaceId: editorSpaceId })],
    );
    await expect(
      mcp.query(api.models.lists.mcpQueries.getLists, {}),
    ).rejects.toThrow("Not authorized");

    await t.run((ctx) => ctx.db.patch(keyId, { spaceIds: [personalSpaceId] }));
    await expect(
      mcp.query(api.models.lists.mcpQueries.getLists, {}),
    ).resolves.toEqual([]);
  });

  test("uses explicit, default, then personal destinations without silent fallback", async () => {
    const {
      t,
      userId,
      personalSpaceId,
      editorSpaceId,
      readerSpaceId,
      inaccessibleSpaceId,
    } = await seedSpaces();
    const principal = { userId };

    await expect(
      t.mutation(internal.models.spaces.private.resolveWriteDestination, {
        principal,
        spaceId: editorSpaceId,
      }),
    ).resolves.toBe(editorSpaceId);
    await expect(
      t.mutation(internal.models.spaces.private.resolveWriteDestination, {
        principal,
        spaceId: inaccessibleSpaceId,
      }),
    ).rejects.toThrow("Space not found");

    const settingsId = await t.run(
      async (ctx) =>
        (await ctx.db
          .query("userSpaceSettings")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique())!._id,
    );
    await t.run((ctx) =>
      ctx.db.patch(settingsId, { defaultWriteSpaceId: editorSpaceId }),
    );
    await expect(
      t.mutation(internal.models.spaces.private.resolveWriteDestination, {
        principal,
      }),
    ).resolves.toBe(editorSpaceId);

    await t.run((ctx) =>
      ctx.db.patch(settingsId, { defaultWriteSpaceId: readerSpaceId }),
    );
    await expect(
      t.mutation(internal.models.spaces.private.resolveWriteDestination, {
        principal,
      }),
    ).rejects.toThrow("Default write space is not available");

    await t.run((ctx) =>
      ctx.db.patch(settingsId, { defaultWriteSpaceId: undefined }),
    );
    await expect(
      t.mutation(internal.models.spaces.private.resolveWriteDestination, {
        principal,
      }),
    ).resolves.toBe(personalSpaceId);
  });

  test("requires explicit new-key grants and source scopes for ingest", async () => {
    const { t, userId, personalSpaceId, editorSpaceId, readerSpaceId } =
      await seedSpaces();
    const session = t.withIdentity({ issuer: webIssuer, subject: userId });

    await expect(
      session.mutation(api.models.apiKeys.public.create, {
        name: "Scoped",
        capabilities: ["read", "write"],
        spaceIds: [editorSpaceId, readerSpaceId],
      }),
    ).resolves.toEqual({
      id: expect.any(String),
      rawKey: expect.stringMatching(/^ob_/),
    });
    await expect(
      session.mutation(api.models.apiKeys.public.create, {
        name: "Unscoped",
        capabilities: ["read"],
        spaceIds: [],
      }),
    ).rejects.toThrow("require bounded capabilities and space scopes");
    await expect(
      session.mutation(api.models.apiKeys.public.create, {
        name: "Ingest",
        capabilities: ["ingest"],
        spaceIds: [personalSpaceId],
      }),
    ).rejects.toThrow("explicit source accounts");
  });
});

describe("legacy API-key scope migration", () => {
  test("backfills personal read/write only and reruns cleanly", async () => {
    const { t, userId, personalSpaceId } = await seedSpaces();
    const keyId = await t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        userId,
        keyHash: "a".repeat(64),
        keyPrefix: "ob_legacy",
        name: "Legacy",
      }),
    );

    const dryRun = await t.mutation(
      internal.models.apiKeys.migrations.backfillLegacyScopes,
      { dryRun: true },
    );
    expect(dryRun).toMatchObject({
      changed: 0,
      wouldChange: 1,
      blocked: false,
    });

    const applied = await t.mutation(
      internal.models.apiKeys.migrations.backfillLegacyScopes,
      {},
    );
    expect(applied).toMatchObject({
      changed: 1,
      wouldChange: 1,
      blocked: false,
    });
    expect(await t.run((ctx) => ctx.db.get(keyId))).toMatchObject({
      capabilities: ["read", "write"],
      spaceIds: [personalSpaceId],
    });

    const rerun = await t.mutation(
      internal.models.apiKeys.migrations.backfillLegacyScopes,
      {},
    );
    expect(rerun).toMatchObject({ changed: 0, wouldChange: 0, blocked: false });
    await expect(
      t.query(internal.models.apiKeys.migrations.auditScopes, {}),
    ).resolves.toMatchObject({ invalidCount: 0, blocked: false });
  });

  test("does not partially patch a page with an invalid legacy key", async () => {
    const { t, userId } = await seedSpaces();
    const { validKeyId } = await t.run(async (ctx) => {
      const incompleteUserId = await ctx.db.insert("users", {});
      const validKeyId = await ctx.db.insert("apiKeys", {
        userId,
        keyHash: "b".repeat(64),
        keyPrefix: "ob_valid",
        name: "Valid legacy",
      });
      await ctx.db.insert("apiKeys", {
        userId: incompleteUserId,
        keyHash: "c".repeat(64),
        keyPrefix: "ob_invalid",
        name: "Invalid legacy",
      });
      return { validKeyId };
    });

    const result = await t.mutation(
      internal.models.apiKeys.migrations.backfillLegacyScopes,
      {},
    );
    expect(result).toMatchObject({
      changed: 0,
      wouldChange: 1,
      invalidCount: 1,
      blocked: true,
      isDone: false,
    });
    const validKey = await t.run((ctx) => ctx.db.get(validKeyId));
    expect(validKey?.capabilities).toBeUndefined();
    expect(validKey?.spaceIds).toBeUndefined();
  });
});
