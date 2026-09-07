import type { FunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import schema from "../../legacySchema";
import { modules } from "../../test.setup";

type TestBackend = ReturnType<typeof convexTest>;
type MigrationResult = {
  changed: number;
  wouldChange: number;
  invalidCount: number;
  blocked: boolean;
  isDone: boolean;
  cursor: string | null;
};
type MigrationReference = FunctionReference<
  "mutation",
  "internal",
  { cursor?: string; batchSize?: number; dryRun?: boolean },
  MigrationResult
>;

const metadata = {
  type: "reference" as const,
  topics: [],
  people: [],
  actionItems: [],
  summary: "Synthetic migration fixture",
};

async function runMigration(
  t: TestBackend,
  fn: MigrationReference,
  options: { batchSize?: number; dryRun?: boolean } = {},
) {
  let cursor: string | null = null;
  let changed = 0;
  let wouldChange = 0;
  let pages = 0;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result: MigrationResult = await t.mutation(fn, {
      ...options,
      ...(cursor ? { cursor } : {}),
    });
    pages += 1;
    changed += result.changed;
    wouldChange += result.wouldChange;
    expect(result.invalidCount).toBe(0);
    expect(result.blocked).toBe(false);
    if (result.isDone) return { changed, wouldChange, pages };
    expect(result.cursor).not.toBeNull();
    cursor = result.cursor;
  }
  throw new Error("migration did not complete within 100 pages");
}

async function seedLegacyContent(t: TestBackend) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const subjectEntityId = await ctx.db.insert("entities", {
      userId,
      key: "person:alex",
      kind: "person",
      canonicalName: "Alex",
      normalizedName: "alex",
      aliases: [],
      normalizedAliases: [],
    });
    const valueEntityId = await ctx.db.insert("entities", {
      userId,
      key: "organization:clinic",
      kind: "organization",
      canonicalName: "Clinic",
      normalizedName: "clinic",
      aliases: [],
      normalizedAliases: [],
    });
    const factId = await ctx.db.insert("facts", {
      userId,
      subjectEntityId,
      predicate: "primary_care_provider",
      value: { type: "entity", entityId: valueEntityId },
      statement: "Alex's primary care provider is Clinic.",
      searchText: "Alex primary care provider Clinic",
      sourceType: "user_stated",
      sourceRef: "legacy-reference",
      confidence: 1,
      status: "current",
    });
    const thoughtId = await ctx.db.insert("thoughts", {
      userId,
      content: "Synthetic legacy memory",
      embedding: Array(1536).fill(0.25),
      metadata,
      sourceRef: "legacy-thought-reference",
    });
    return { userId, subjectEntityId, valueEntityId, factId, thoughtId };
  });
}

describe("personal-space migration", () => {
  test("dry-runs, paginates, creates one personal setup, and reruns cleanly", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < 7; index += 1) {
        await ctx.db.insert("users", { name: `Synthetic ${index}` });
      }
    });

    const dryRun = await runMigration(
      t,
      internal.models.spaces.migrations.bootstrapPersonalSpaces,
      { batchSize: 2, dryRun: true },
    );
    expect(dryRun).toMatchObject({ changed: 0, wouldChange: 7 });
    expect(dryRun.pages).toBeGreaterThan(1);
    expect(
      await t.run(async (ctx) => await ctx.db.query("spaces").collect()),
    ).toHaveLength(0);

    const applied = await runMigration(
      t,
      internal.models.spaces.migrations.bootstrapPersonalSpaces,
      { batchSize: 2 },
    );
    expect(applied.changed).toBe(7);
    expect(applied.pages).toBeGreaterThan(1);

    const records = await t.run(async (ctx) => ({
      spaces: await ctx.db.query("spaces").collect(),
      members: await ctx.db.query("spaceMembers").collect(),
      settings: await ctx.db.query("userSpaceSettings").collect(),
    }));
    expect(records.spaces).toHaveLength(7);
    expect(records.spaces.every((space) => space.kind === "personal")).toBe(
      true,
    );
    expect(records.members).toHaveLength(7);
    expect(records.members.every((member) => member.role === "owner")).toBe(
      true,
    );
    expect(records.settings).toHaveLength(7);

    const rerun = await runMigration(
      t,
      internal.models.spaces.migrations.bootstrapPersonalSpaces,
      { batchSize: 3 },
    );
    expect(rerun.changed).toBe(0);

    const audit = await t.query(
      internal.models.spaces.migrations.auditPersonalSpaces,
      { batchSize: 200 },
    );
    expect(audit).toMatchObject({
      missingSpaces: 0,
      missingMemberships: 0,
      missingSettings: 0,
      invalidCount: 0,
      isDone: true,
    });
  });

  test("preserves a configured default destination", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const personalSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: userId,
      });
      const sharedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Household",
        createdBy: userId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: personalSpaceId,
        userId,
        role: "owner",
      });
      const settingsId = await ctx.db.insert("userSpaceSettings", {
        userId,
        personalSpaceId,
        defaultWriteSpaceId: sharedSpaceId,
      });
      return { settingsId, sharedSpaceId };
    });

    const result = await runMigration(
      t,
      internal.models.spaces.migrations.bootstrapPersonalSpaces,
    );
    expect(result.changed).toBe(0);
    const settings = await t.run((ctx) => ctx.db.get(seeded.settingsId));
    expect(settings?.defaultWriteSpaceId).toBe(seeded.sharedSpaceId);
  });

  test("overlapping bootstrap requests create one setup per user", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("users", {}));

    const [first, second] = await Promise.all([
      t.mutation(internal.models.spaces.migrations.bootstrapPersonalSpaces, {}),
      t.mutation(internal.models.spaces.migrations.bootstrapPersonalSpaces, {}),
    ]);
    expect(first.changed + second.changed).toBe(1);

    const records = await t.run(async (ctx) => ({
      spaces: await ctx.db.query("spaces").collect(),
      memberships: await ctx.db.query("spaceMembers").collect(),
      settings: await ctx.db.query("userSpaceSettings").collect(),
    }));
    expect(records.spaces).toHaveLength(1);
    expect(records.memberships).toHaveLength(1);
    expect(records.settings).toHaveLength(1);
  });

  test("backfills legacy content only to Personal and preserves payloads", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedLegacyContent(t);
    const sharedSpaceId = await t.run(async (ctx) => {
      const spaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Household",
        createdBy: seeded.userId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId,
        userId: seeded.userId,
        role: "owner",
      });
      return spaceId;
    });

    await runMigration(
      t,
      internal.models.spaces.migrations.bootstrapPersonalSpaces,
    );

    const entityDryRun = await runMigration(
      t,
      internal.models.spaces.migrations.backfillEntitySpaceIds,
      { batchSize: 1, dryRun: true },
    );
    expect(entityDryRun).toMatchObject({ changed: 0, wouldChange: 2 });
    expect(
      await t.run((ctx) => ctx.db.get(seeded.subjectEntityId)),
    ).not.toHaveProperty("spaceId");

    expect(
      (
        await runMigration(
          t,
          internal.models.spaces.migrations.backfillEntitySpaceIds,
          { batchSize: 1 },
        )
      ).changed,
    ).toBe(2);
    expect(
      (
        await runMigration(
          t,
          internal.models.spaces.migrations.backfillFactSpaceIds,
          { batchSize: 1 },
        )
      ).changed,
    ).toBe(1);
    expect(
      (
        await runMigration(
          t,
          internal.models.spaces.migrations.backfillThoughtSpaceIds,
          { batchSize: 1 },
        )
      ).changed,
    ).toBe(1);

    const stored = await t.run(async (ctx) => {
      const settings = await ctx.db
        .query("userSpaceSettings")
        .withIndex("by_userId", (q) => q.eq("userId", seeded.userId))
        .first();
      return {
        settings,
        subject: await ctx.db.get(seeded.subjectEntityId),
        value: await ctx.db.get(seeded.valueEntityId),
        fact: await ctx.db.get(seeded.factId),
        thought: await ctx.db.get(seeded.thoughtId),
      };
    });
    const personalSpaceId = stored.settings?.personalSpaceId;
    expect(personalSpaceId).toBeDefined();
    expect(personalSpaceId).not.toBe(sharedSpaceId);
    expect(stored.subject?.spaceId).toBe(personalSpaceId);
    expect(stored.value?.spaceId).toBe(personalSpaceId);
    expect(stored.fact).toMatchObject({
      spaceId: personalSpaceId,
      sourceRef: "legacy-reference",
    });
    expect(stored.thought).toMatchObject({
      spaceId: personalSpaceId,
      sourceRef: "legacy-thought-reference",
      embedding: Array(1536).fill(0.25),
    });

    for (const fn of [
      internal.models.spaces.migrations.backfillEntitySpaceIds,
      internal.models.spaces.migrations.backfillFactSpaceIds,
      internal.models.spaces.migrations.backfillThoughtSpaceIds,
    ]) {
      expect((await runMigration(t, fn)).changed).toBe(0);
    }

    for (const fn of [
      internal.models.spaces.migrations.auditEntitySpaceIds,
      internal.models.spaces.migrations.auditFactSpaceIds,
      internal.models.spaces.migrations.auditThoughtSpaceIds,
    ]) {
      const audit = await t.query(fn, { batchSize: 200 });
      expect(audit).toMatchObject({
        missing: 0,
        invalidCount: 0,
        isDone: true,
      });
    }
  });
});
