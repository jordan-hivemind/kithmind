import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../legacySchema";
import { modules } from "../../test.setup";

const metadata = {
  type: "reference" as const,
  topics: [],
  people: [],
  actionItems: [],
  summary: "Synthetic scope-audit fixture",
};

function entityFields(
  userId: Id<"users">,
  spaceId: Id<"spaces">,
  key: string,
) {
  return {
    userId,
    spaceId,
    key,
    kind: "person" as const,
    canonicalName: key,
    normalizedName: key,
    aliases: [],
    normalizedAliases: [],
  };
}

function factFields(
  userId: Id<"users">,
  spaceId: Id<"spaces">,
  subjectEntityId: Id<"entities">,
) {
  return {
    userId,
    spaceId,
    subjectEntityId,
    predicate: "synthetic_predicate",
    value: { type: "text" as const, value: "Synthetic value" },
    statement: "Synthetic statement.",
    searchText: "synthetic statement",
    sourceType: "user_stated" as const,
    confidence: 1,
    status: "current" as const,
  };
}

function thoughtFields(userId: Id<"users">, spaceId: Id<"spaces">) {
  return {
    userId,
    spaceId,
    content: "Synthetic thought.",
    embedding: Array(1536).fill(0),
    metadata,
    memoryStatus: "current" as const,
  };
}

type AuditTable = "entities" | "facts" | "thoughts";
type AuditPage = {
  examined: number;
  missing: number;
  invalidCount: number;
  invalids: Array<{ id: string; reason: string }>;
  isDone: boolean;
  cursor: string | null;
};

async function runAudit(
  t: ReturnType<typeof convexTest>,
  table: AuditTable,
  batchSize = 1,
) {
  let cursor: string | null = null;
  let examined = 0;
  let missing = 0;
  let invalidCount = 0;
  const invalids: Array<{ id: string; reason: string }> = [];

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result: AuditPage = await t.query(
      internal.models.spaces.scopeAudit.auditContent,
      {
        table,
        batchSize,
        ...(cursor ? { cursor } : {}),
      },
    );
    examined += result.examined;
    missing += result.missing;
    invalidCount += result.invalidCount;
    invalids.push(...result.invalids);
    if (result.isDone) return { examined, missing, invalidCount, invalids };
    expect(result.cursor).not.toBeNull();
    cursor = result.cursor;
  }
  throw new Error("scope audit did not complete within 100 pages");
}

describe("general content scope audit", () => {
  test("accepts shared cross-author references after an author leaves", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", {});
      const formerEditorId = await ctx.db.insert("users", {});
      const sharedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Synthetic family",
        createdBy: ownerId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: sharedSpaceId,
        userId: ownerId,
        role: "owner",
      });
      const formerMembershipId = await ctx.db.insert("spaceMembers", {
        spaceId: sharedSpaceId,
        userId: formerEditorId,
        role: "editor",
      });
      const subjectId = await ctx.db.insert(
        "entities",
        entityFields(ownerId, sharedSpaceId, "person:alex"),
      );
      const objectId = await ctx.db.insert(
        "entities",
        entityFields(formerEditorId, sharedSpaceId, "person:casey"),
      );
      const previousFactId = await ctx.db.insert("facts", {
        ...factFields(ownerId, sharedSpaceId, subjectId),
        status: "superseded",
      });
      const replacementFactId = await ctx.db.insert("facts", {
        ...factFields(formerEditorId, sharedSpaceId, subjectId),
        value: { type: "entity", entityId: objectId },
        supersedes: [previousFactId],
      });
      await ctx.db.patch(previousFactId, { supersededBy: replacementFactId });

      const previousThoughtId = await ctx.db.insert("thoughts", {
        ...thoughtFields(ownerId, sharedSpaceId),
        memoryStatus: "superseded",
      });
      const replacementThoughtId = await ctx.db.insert("thoughts", {
        ...thoughtFields(formerEditorId, sharedSpaceId),
        supersedes: [previousThoughtId],
      });
      await ctx.db.patch(previousThoughtId, {
        supersededBy: replacementThoughtId,
      });
      await ctx.db.delete(formerMembershipId);
    });

    for (const table of ["entities", "facts", "thoughts"] as const) {
      expect(await runAudit(t, table)).toMatchObject({
        missing: 0,
        invalidCount: 0,
        invalids: [],
      });
    }
  });

  test("reports missing scopes, duplicate keys, and cross-space references", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const [firstAuthorId, secondAuthorId] = await Promise.all([
        ctx.db.insert("users", {}),
        ctx.db.insert("users", {}),
      ]);
      const firstSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "First synthetic family",
        createdBy: firstAuthorId,
      });
      const secondSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Second synthetic family",
        createdBy: secondAuthorId,
      });
      const deletedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Deleted synthetic family",
        createdBy: firstAuthorId,
      });
      const firstEntityId = await ctx.db.insert(
        "entities",
        entityFields(firstAuthorId, firstSpaceId, "person:duplicate"),
      );
      const duplicateEntityId = await ctx.db.insert(
        "entities",
        entityFields(secondAuthorId, firstSpaceId, "person:duplicate"),
      );
      const foreignEntityId = await ctx.db.insert(
        "entities",
        entityFields(secondAuthorId, secondSpaceId, "person:foreign"),
      );
      const danglingSpaceEntityId = await ctx.db.insert(
        "entities",
        entityFields(firstAuthorId, deletedSpaceId, "person:dangling-space"),
      );
      const unscopedEntityId = await ctx.db.insert("entities", {
        userId: firstAuthorId,
        key: "person:unscoped",
        kind: "person",
        canonicalName: "Unscoped",
        normalizedName: "unscoped",
        aliases: [],
        normalizedAliases: [],
      });
      await ctx.db.delete(deletedSpaceId);

      const foreignFactId = await ctx.db.insert(
        "facts",
        factFields(secondAuthorId, secondSpaceId, foreignEntityId),
      );
      const badFactId = await ctx.db.insert("facts", {
        ...factFields(firstAuthorId, firstSpaceId, foreignEntityId),
        value: { type: "entity", entityId: foreignEntityId },
        supersededBy: foreignFactId,
        supersedes: [foreignFactId],
      });
      const foreignThoughtId = await ctx.db.insert(
        "thoughts",
        thoughtFields(secondAuthorId, secondSpaceId),
      );
      const badThoughtId = await ctx.db.insert("thoughts", {
        ...thoughtFields(firstAuthorId, firstSpaceId),
        supersededBy: foreignThoughtId,
        supersedes: [foreignThoughtId],
      });
      return {
        badFactId,
        badThoughtId,
        danglingSpaceEntityId,
        duplicateEntityId,
        firstEntityId,
        unscopedEntityId,
      };
    });

    const entities = await runAudit(t, "entities", 50);
    expect(entities).toMatchObject({ missing: 1, invalidCount: 4 });
    expect(entities.invalids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: seeded.firstEntityId,
          reason: "duplicate entity key in space",
        }),
        expect.objectContaining({
          id: seeded.duplicateEntityId,
          reason: "duplicate entity key in space",
        }),
        expect.objectContaining({
          id: seeded.danglingSpaceEntityId,
          reason: "spaceId references a missing space",
        }),
        expect.objectContaining({
          id: seeded.unscopedEntityId,
          reason: "spaceId is missing",
        }),
      ]),
    );

    const facts = await runAudit(t, "facts", 4);
    expect(facts).toMatchObject({ missing: 0, invalidCount: 1 });
    expect(facts.invalids).toEqual([
      expect.objectContaining({
        id: seeded.badFactId,
        reason: expect.stringContaining(
          "subject references an entity in another space",
        ),
      }),
    ]);
    expect(facts.invalids[0]?.reason).toContain(
      "value references an entity in another space",
    );
    expect(facts.invalids[0]?.reason).toContain(
      "supersededBy references a fact in another space",
    );
    expect(facts.invalids[0]?.reason).toContain(
      "supersedes references a fact in another space",
    );

    const thoughts = await runAudit(t, "thoughts", 4);
    expect(thoughts).toMatchObject({ missing: 0, invalidCount: 1 });
    expect(thoughts.invalids).toEqual([
      expect.objectContaining({
        id: seeded.badThoughtId,
        reason: expect.stringContaining(
          "supersededBy references a thought in another space",
        ),
      }),
    ]);
    expect(thoughts.invalids[0]?.reason).toContain(
      "supersedes references a thought in another space",
    );
  });
});
