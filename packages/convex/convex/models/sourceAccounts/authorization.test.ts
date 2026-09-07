import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";

async function fixture() {
  const t = convexTest(schema, modules);
  const seed = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic family",
      createdBy: userId,
    });
    const membershipId = await ctx.db.insert("spaceMembers", {
      spaceId,
      userId,
      role: "editor",
    });
    const source = {
      spaceId,
      connector: "synthetic",
      name: "Synthetic account",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 86_400_000,
      createdBy: userId,
    };
    const accountId = await ctx.db.insert("sourceAccounts", {
      ...source,
      accountId: "a",
    });
    const otherAccountId = await ctx.db.insert("sourceAccounts", {
      ...source,
      accountId: "b",
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "synthetic",
      keyPrefix: "ob_test",
      name: "Ingest worker",
      capabilities: ["read", "ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [accountId],
    });
    return {
      userId,
      spaceId,
      membershipId,
      accountId,
      otherAccountId,
      credentialId,
    };
  });
  const ref = { userId: seed.userId, credentialId: seed.credentialId };
  return { t, ...seed, ref };
}

describe("live source account authorization", () => {
  test("ingestion is account-specific while retained reads use space grants", async () => {
    const f = await fixture();
    await expect(
      f.t.run((ctx) => requireSourceAccountAccess(ctx, f.ref, f.accountId)),
    ).resolves.toMatchObject({ _id: f.accountId });
    await expect(
      f.t.run((ctx) =>
        requireSourceAccountAccess(ctx, f.ref, f.otherAccountId),
      ),
    ).rejects.toThrow("Source account not found");
    await expect(
      f.t.run((ctx) =>
        requireSourceAccountAccess(ctx, f.ref, f.otherAccountId, "read"),
      ),
    ).resolves.toMatchObject({ _id: f.otherAccountId });
    await f.t.run((ctx) =>
      ctx.db.patch(f.credentialId, { sourceAccountIds: [f.otherAccountId] }),
    );
    await expect(
      f.t.run((ctx) => requireSourceAccountAccess(ctx, f.ref, f.accountId)),
    ).rejects.toThrow("Source account not found");
  });
  test("disabled accounts retain read access but block both key and web ingestion", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.patch(f.accountId, { enabled: false }));
    for (const ref of [f.ref, { userId: f.userId }]) {
      await expect(
        f.t.run((ctx) => requireSourceAccountAccess(ctx, ref, f.accountId)),
      ).rejects.toThrow("Source account not found");
      await expect(
        f.t.run((ctx) =>
          requireSourceAccountAccess(ctx, ref, f.accountId, "read"),
        ),
      ).resolves.toBeTruthy();
    }
  });
  test("role downgrade, scope removal and revocation invalidate existing references", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.patch(f.membershipId, { role: "reader" }));
    await expect(
      f.t.run((ctx) => requireSourceAccountAccess(ctx, f.ref, f.accountId)),
    ).rejects.toThrow("Source account not found");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.membershipId, { role: "editor" });
      await ctx.db.patch(f.credentialId, { spaceIds: [] });
    });
    await expect(
      f.t.run((ctx) => requireSourceAccountAccess(ctx, f.ref, f.accountId)),
    ).rejects.toThrow("Source account not found");
    await f.t.run((ctx) => ctx.db.delete(f.credentialId));
    await expect(
      f.t.run((ctx) => requireSourceAccountAccess(ctx, f.ref, f.accountId)),
    ).rejects.toThrow("Not authenticated");
  });
  test("missing source grants never become wildcard ingest authority", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch(f.credentialId, { sourceAccountIds: undefined }),
    );
    await expect(
      f.t.run((ctx) => requireSourceAccountAccess(ctx, f.ref, f.accountId)),
    ).rejects.toThrow("Source account not found");
  });
});

describe("source configuration and credential issuance", () => {
  test("source identity is unique and ingest grants must name writable accounts", async () => {
    const f = await fixture();
    const session = f.t.withIdentity({
      issuer: "https://synthetic.example/convex",
      subject: f.userId,
    });
    const args = {
      connector: "synthetic",
      accountId: "a",
      name: "Duplicate",
      spaceId: f.spaceId,
    };
    await expect(
      session.mutation(api.models.sourceAccounts.public.create, args),
    ).rejects.toThrow("already exists");
    await expect(
      session.mutation(api.models.apiKeys.public.create, {
        name: "Unscoped",
        capabilities: ["ingest"],
        spaceIds: [f.spaceId],
      }),
    ).rejects.toThrow("explicit source accounts");
    const grant = await session.mutation(api.models.apiKeys.public.create, {
      name: "Scoped",
      capabilities: ["ingest"],
      spaceIds: [f.spaceId],
      sourceAccountIds: [f.accountId],
    });
    await expect(
      f.t.run((ctx) =>
        requireSourceAccountAccess(
          ctx,
          { userId: f.userId, credentialId: grant.id },
          f.accountId,
        ),
      ),
    ).resolves.toBeTruthy();
    await f.t.run((ctx) => ctx.db.patch(f.membershipId, { role: "reader" }));
    await expect(
      session.mutation(api.models.apiKeys.public.create, {
        name: "Reader",
        capabilities: ["ingest"],
        spaceIds: [f.spaceId],
        sourceAccountIds: [f.accountId],
      }),
    ).rejects.toThrow("Space not found");
    await expect(
      session.mutation(api.models.sourceAccounts.public.update, {
        sourceAccountId: f.accountId,
        enabled: false,
      }),
    ).rejects.toThrow("Source account not found");
  });
});
