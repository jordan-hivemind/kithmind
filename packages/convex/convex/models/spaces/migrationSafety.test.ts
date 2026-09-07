import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import schema from "../../legacySchema";
import { modules } from "../../test.setup";

const metadata = {
  type: "reference" as const,
  topics: [],
  people: [],
  actionItems: [],
  summary: "synthetic migration fixture",
};

function factFields(
  subjectEntityId: Id<"entities">,
  value: Doc<"facts">["value"] = { type: "text", value: "value" },
) {
  return {
    subjectEntityId,
    predicate: "synthetic_predicate",
    value,
    statement: "Synthetic statement.",
    searchText: "synthetic statement",
    sourceType: "user_stated" as const,
    confidence: 1,
    status: "current" as const,
  };
}

function entityFields(
  userId: Id<"users">,
  key: string,
  spaceId?: Id<"spaces">,
) {
  return {
    userId,
    ...(spaceId === undefined ? {} : { spaceId }),
    key,
    kind: "person" as const,
    canonicalName: key,
    normalizedName: key,
    aliases: [],
    normalizedAliases: [],
  };
}

function thoughtFields(userId: Id<"users">, spaceId?: Id<"spaces">) {
  return {
    userId,
    ...(spaceId === undefined ? {} : { spaceId }),
    content: "Synthetic thought.",
    embedding: Array(1536).fill(0),
    metadata,
  };
}

async function seedPersonalPair(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const [ownerId, otherId] = await Promise.all([
      ctx.db.insert("users", {}),
      ctx.db.insert("users", {}),
    ]);
    const ownerSpaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Owner personal",
      createdBy: ownerId,
    });
    const otherSpaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Other personal",
      createdBy: otherId,
    });
    await Promise.all([
      ctx.db.insert("spaceMembers", {
        spaceId: ownerSpaceId,
        userId: ownerId,
        role: "owner",
      }),
      ctx.db.insert("spaceMembers", {
        spaceId: otherSpaceId,
        userId: otherId,
        role: "owner",
      }),
      ctx.db.insert("userSpaceSettings", {
        userId: ownerId,
        personalSpaceId: ownerSpaceId,
      }),
      ctx.db.insert("userSpaceSettings", {
        userId: otherId,
        personalSpaceId: otherSpaceId,
      }),
    ]);
    return { ownerId, otherId, ownerSpaceId, otherSpaceId };
  });
}

describe("space migration safety", () => {
  test("blocks an invalid entity page without patching its valid unscoped neighbor", async () => {
    const t = convexTest(schema, modules);
    const { invalidId, validId } = await t.run(async (ctx) => {
      const [ownerId, otherId] = await Promise.all([
        ctx.db.insert("users", {}),
        ctx.db.insert("users", {}),
      ]);
      const personalSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Owner personal",
        createdBy: ownerId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: personalSpaceId,
        userId: ownerId,
        role: "owner",
      });
      await ctx.db.insert("userSpaceSettings", {
        userId: ownerId,
        personalSpaceId,
      });
      const sharedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Other shared",
        createdBy: otherId,
      });
      const invalidId = await ctx.db.insert(
        "entities",
        entityFields(ownerId, "invalid-pre-scoped", sharedSpaceId),
      );
      const validId = await ctx.db.insert(
        "entities",
        entityFields(ownerId, "valid-unscoped"),
      );
      return { invalidId, validId };
    });

    const result = await t.mutation(
      internal.models.spaces.migrations.backfillEntitySpaceIds,
      { batchSize: 10 },
    );

    expect(result).toMatchObject({
      examined: 2,
      changed: 0,
      wouldChange: 1,
      invalidCount: 1,
      blocked: true,
      isDone: false,
    });
    expect(result.invalids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: invalidId,
          reason: expect.stringContaining(
            "entity is assigned outside its author's personal space",
          ),
        }),
      ]),
    );
    const [invalid, valid] = await t.run(async (ctx) => [
      await ctx.db.get(invalidId),
      await ctx.db.get(validId),
    ]);
    expect(invalid?.spaceId).toBeDefined();
    expect(valid?.spaceId).toBeUndefined();
  });

  test("detects duplicate legacy and personal-space entity keys before writing", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const spaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: userId,
      });
      await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
      await ctx.db.insert("userSpaceSettings", {
        userId,
        personalSpaceId: spaceId,
      });
      await ctx.db.insert("entities", entityFields(userId, "legacy-duplicate"));
      await ctx.db.insert("entities", entityFields(userId, "legacy-duplicate"));
      await ctx.db.insert(
        "entities",
        entityFields(userId, "target-duplicate", spaceId),
      );
      await ctx.db.insert("entities", entityFields(userId, "target-duplicate"));
    });

    const result = await t.mutation(
      internal.models.spaces.migrations.backfillEntitySpaceIds,
      { batchSize: 10 },
    );

    expect(result).toMatchObject({
      changed: 0,
      wouldChange: 0,
      invalidCount: 4,
      blocked: true,
    });
    expect(
      result.invalids.map((invalid) => invalid.reason).join("\n"),
    ).toContain("duplicate legacy entity key for author");
    expect(
      result.invalids.map((invalid) => invalid.reason).join("\n"),
    ).toContain("entity key already exists in personal space");
  });

  test("rejects entities, facts, and thoughts assigned to another space", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const [ownerId, otherId] = await Promise.all([
        ctx.db.insert("users", {}),
        ctx.db.insert("users", {}),
      ]);
      const personalSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: ownerId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: personalSpaceId,
        userId: ownerId,
        role: "owner",
      });
      await ctx.db.insert("userSpaceSettings", {
        userId: ownerId,
        personalSpaceId,
      });
      const sharedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Foreign shared",
        createdBy: otherId,
      });
      const localSubjectId = await ctx.db.insert(
        "entities",
        entityFields(ownerId, "local-subject", personalSpaceId),
      );
      await ctx.db.insert(
        "entities",
        entityFields(ownerId, "foreign-entity", sharedSpaceId),
      );
      await ctx.db.insert("facts", {
        userId: ownerId,
        spaceId: sharedSpaceId,
        ...factFields(localSubjectId),
      });
      await ctx.db.insert("thoughts", thoughtFields(ownerId, sharedSpaceId));
    });

    const [entities, facts, thoughts] = await Promise.all([
      t.mutation(internal.models.spaces.migrations.backfillEntitySpaceIds, {
        batchSize: 10,
      }),
      t.mutation(internal.models.spaces.migrations.backfillFactSpaceIds, {
        batchSize: 10,
      }),
      t.mutation(internal.models.spaces.migrations.backfillThoughtSpaceIds, {
        batchSize: 10,
      }),
    ]);

    for (const result of [entities, facts, thoughts]) {
      expect(result).toMatchObject({
        changed: 0,
        invalidCount: 1,
        blocked: true,
      });
      expect(result.invalids[0]?.reason).toContain(
        "assigned outside its author's personal space",
      );
    }
  });

  test("rejects missing and cross-user subject and entity-value references", async () => {
    const cases = [
      ["subject references a missing entity", "missing-subject"],
      ["subject references another user's entity", "foreign-subject"],
      ["value references a missing entity", "missing-value"],
      ["value references another user's entity", "foreign-value"],
    ] as const;

    for (const [expectedReason, kind] of cases) {
      const t = convexTest(schema, modules);
      const { ownerId, otherId, ownerSpaceId, otherSpaceId } =
        await seedPersonalPair(t);
      await t.run(async (ctx) => {
        const ownerEntityId = await ctx.db.insert(
          "entities",
          entityFields(ownerId, "owner", ownerSpaceId),
        );
        const otherEntityId = await ctx.db.insert(
          "entities",
          entityFields(otherId, "other", otherSpaceId),
        );
        if (kind === "missing-subject") {
          const id = await ctx.db.insert(
            "entities",
            entityFields(ownerId, "missing-subject", ownerSpaceId),
          );
          await ctx.db.insert("facts", { userId: ownerId, ...factFields(id) });
          await ctx.db.delete(id);
        } else if (kind === "foreign-subject") {
          await ctx.db.insert("facts", {
            userId: ownerId,
            ...factFields(otherEntityId),
          });
        } else {
          const valueId =
            kind === "missing-value"
              ? await ctx.db.insert(
                  "entities",
                  entityFields(ownerId, "missing-value", ownerSpaceId),
                )
              : otherEntityId;
          await ctx.db.insert("facts", {
            userId: ownerId,
            ...factFields(ownerEntityId, { type: "entity", entityId: valueId }),
          });
          if (kind === "missing-value") await ctx.db.delete(valueId);
        }
      });

      const result = await t.mutation(
        internal.models.spaces.migrations.backfillFactSpaceIds,
        { batchSize: 10 },
      );
      expect(result).toMatchObject({
        changed: 0,
        wouldChange: 0,
        invalidCount: 1,
        blocked: true,
      });
      expect(result.invalids[0]?.reason).toContain(expectedReason);
    }
  });

  test("rejects missing and cross-user supersession links for facts and thoughts", async () => {
    const cases = [
      ["facts", "missing"],
      ["facts", "foreign"],
      ["thoughts", "missing"],
      ["thoughts", "foreign"],
    ] as const;

    for (const [table, kind] of cases) {
      const t = convexTest(schema, modules);
      const { ownerId, otherId, ownerSpaceId, otherSpaceId } =
        await seedPersonalPair(t);
      await t.run(async (ctx) => {
        if (table === "facts") {
          const ownerEntityId = await ctx.db.insert(
            "entities",
            entityFields(ownerId, "owner", ownerSpaceId),
          );
          const otherEntityId = await ctx.db.insert(
            "entities",
            entityFields(otherId, "other", otherSpaceId),
          );
          const referenceId = await ctx.db.insert("facts", {
            userId: kind === "missing" ? ownerId : otherId,
            ...(kind === "missing" ? {} : { spaceId: otherSpaceId }),
            ...factFields(kind === "missing" ? ownerEntityId : otherEntityId),
          });
          await ctx.db.insert("facts", {
            userId: ownerId,
            ...factFields(ownerEntityId),
            supersededBy: referenceId,
            supersedes: [referenceId],
          });
          if (kind === "missing") await ctx.db.delete(referenceId);
        } else {
          const referenceId = await ctx.db.insert(
            "thoughts",
            thoughtFields(
              kind === "missing" ? ownerId : otherId,
              kind === "missing" ? undefined : otherSpaceId,
            ),
          );
          await ctx.db.insert("thoughts", {
            ...thoughtFields(ownerId),
            supersededBy: referenceId,
            supersedes: [referenceId],
          });
          if (kind === "missing") await ctx.db.delete(referenceId);
        }
      });

      const result =
        table === "facts"
          ? await t.mutation(
              internal.models.spaces.migrations.backfillFactSpaceIds,
              {
                batchSize: 10,
              },
            )
          : await t.mutation(
              internal.models.spaces.migrations.backfillThoughtSpaceIds,
              { batchSize: 10 },
            );
      expect(result).toMatchObject({
        changed: 0,
        wouldChange: 0,
        invalidCount: 1,
        blocked: true,
      });
      const absent =
        kind === "missing"
          ? "references a missing"
          : "references another user's";
      expect(result.invalids[0]?.reason).toContain(`supersededBy ${absent}`);
      expect(result.invalids[0]?.reason).toContain(`supersedes ${absent}`);
    }
  });

  test("blocks stale rows whose author was deleted", async () => {
    const t = convexTest(schema, modules);
    const { ownerId } = await seedPersonalPair(t);
    const entityId = await t.run(async (ctx) => {
      const entityId = await ctx.db.insert(
        "entities",
        entityFields(ownerId, "stale-author"),
      );
      await ctx.db.delete(ownerId);
      return entityId;
    });

    const result = await t.mutation(
      internal.models.spaces.migrations.backfillEntitySpaceIds,
      { batchSize: 10 },
    );

    expect(result).toMatchObject({
      changed: 0,
      wouldChange: 0,
      invalidCount: 1,
      blocked: true,
    });
    expect(result.invalids).toEqual([
      expect.objectContaining({
        id: entityId,
        reason: "author references a missing user",
      }),
    ]);
  });

  test("rejects oversized histories and page reference-budget exhaustion without writes", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, ownerSpaceId } = await seedPersonalPair(t);
    const { oversizedId, budgetId, targetIds } = await t.run(async (ctx) => {
      const subjectId = await ctx.db.insert(
        "entities",
        entityFields(ownerId, "owner", ownerSpaceId),
      );
      const oversizedId = await ctx.db.insert("facts", {
        userId: ownerId,
        ...factFields(subjectId),
      });
      const firstId = await ctx.db.insert("facts", {
        userId: ownerId,
        ...factFields(subjectId),
      });
      const budgetId = await ctx.db.insert("facts", {
        userId: ownerId,
        ...factFields(subjectId),
      });
      const references = await Promise.all(
        Array.from({ length: 14 }, (_, index) =>
          ctx.db.insert("facts", {
            userId: ownerId,
            spaceId: ownerSpaceId,
            ...factFields(subjectId, {
              type: "text",
              value: `reference-${index}`,
            }),
          }),
        ),
      );
      await ctx.db.patch(oversizedId, {
        supersedes: Array(11).fill(references[0]!),
      });
      await ctx.db.patch(firstId, { supersedes: references.slice(0, 10) });
      await ctx.db.patch(budgetId, {
        supersedes: [...references.slice(10), references[10]!, references[11]!],
      });
      return {
        oversizedId,
        budgetId,
        targetIds: [oversizedId, firstId, budgetId],
      };
    });

    const result = await t.mutation(
      internal.models.spaces.migrations.backfillFactSpaceIds,
      { batchSize: 4 },
    );

    expect(result).toMatchObject({ changed: 0, blocked: true });
    expect(result.invalids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: oversizedId,
          reason: expect.stringContaining(
            "supersedes exceeds the migration reference limit",
          ),
        }),
        expect.objectContaining({
          id: budgetId,
          reason: expect.stringContaining(
            "page reference budget exceeded; rerun with a smaller batchSize",
          ),
        }),
      ]),
    );
    const targets = await t.run(async (ctx) =>
      Promise.all(targetIds.map((id) => ctx.db.get(id))),
    );
    expect(targets.map((target) => target?.spaceId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("keeps migrated legacy facts and thoughts visible only to their authenticated owner", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, otherId } = await seedPersonalPair(t);
    const { ownerFactId, ownerThoughtId, otherFactId, otherThoughtId } =
      await t.run(async (ctx) => {
        const ownerEntityId = await ctx.db.insert(
          "entities",
          entityFields(ownerId, "owner"),
        );
        const otherEntityId = await ctx.db.insert(
          "entities",
          entityFields(otherId, "other"),
        );
        const ownerFactId = await ctx.db.insert("facts", {
          userId: ownerId,
          ...factFields(ownerEntityId),
        });
        const otherFactId = await ctx.db.insert("facts", {
          userId: otherId,
          ...factFields(otherEntityId),
        });
        const ownerThoughtId = await ctx.db.insert(
          "thoughts",
          thoughtFields(ownerId),
        );
        const otherThoughtId = await ctx.db.insert(
          "thoughts",
          thoughtFields(otherId),
        );
        return { ownerFactId, ownerThoughtId, otherFactId, otherThoughtId };
      });

    expect(
      await t.mutation(
        internal.models.spaces.migrations.backfillEntitySpaceIds,
        {
          batchSize: 10,
        },
      ),
    ).toMatchObject({ changed: 2, invalidCount: 0 });
    expect(
      await t.mutation(internal.models.spaces.migrations.backfillFactSpaceIds, {
        batchSize: 10,
      }),
    ).toMatchObject({ changed: 2, invalidCount: 0 });
    expect(
      await t.mutation(
        internal.models.spaces.migrations.backfillThoughtSpaceIds,
        {
          batchSize: 10,
        },
      ),
    ).toMatchObject({ changed: 2, invalidCount: 0 });

    const owner = t.withIdentity({
      issuer: "https://brain.example.test/convex",
      subject: ownerId,
    });
    const other = t.withIdentity({
      issuer: "https://brain.example.test/convex",
      subject: otherId,
    });
    const [ownerFacts, ownerThoughts, otherFacts, otherThoughts] =
      await Promise.all([
        owner.query(api.models.facts.public.listRecent, {}),
        owner.query(api.models.thoughts.public.listRecent, {}),
        other.query(api.models.facts.public.listRecent, {}),
        other.query(api.models.thoughts.public.listRecent, {}),
      ]);

    expect(ownerFacts.map((fact) => fact.id)).toContain(ownerFactId);
    expect(ownerFacts.map((fact) => fact.id)).not.toContain(otherFactId);
    expect(ownerThoughts.map((thought) => thought._id)).toContain(
      ownerThoughtId,
    );
    expect(ownerThoughts.map((thought) => thought._id)).not.toContain(
      otherThoughtId,
    );
    expect(otherFacts.map((fact) => fact.id)).toContain(otherFactId);
    expect(otherThoughts.map((thought) => thought._id)).toContain(
      otherThoughtId,
    );
  });

  test("audits malformed personal spaces, settings, memberships, and person links", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const duplicateSpacesUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("spaces", {
        kind: "personal",
        name: "One",
        createdBy: duplicateSpacesUserId,
      });
      await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Two",
        createdBy: duplicateSpacesUserId,
      });

      const foreignSettingsUserId = await ctx.db.insert("users", {});
      const foreignSettingsSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Settings owner",
        createdBy: foreignSettingsUserId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: foreignSettingsSpaceId,
        userId: foreignSettingsUserId,
        role: "owner",
      });
      const foreignSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Foreign",
        createdBy: foreignSettingsUserId,
      });
      await ctx.db.insert("userSpaceSettings", {
        userId: foreignSettingsUserId,
        personalSpaceId: foreignSpaceId,
      });

      const foreignMemberUserId = await ctx.db.insert("users", {});
      const foreignMemberSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Members",
        createdBy: foreignMemberUserId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: foreignMemberSpaceId,
        userId: foreignMemberUserId,
        role: "owner",
      });
      const unrelatedUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("spaceMembers", {
        spaceId: foreignMemberSpaceId,
        userId: unrelatedUserId,
        role: "reader",
      });
      await ctx.db.insert("userSpaceSettings", {
        userId: foreignMemberUserId,
        personalSpaceId: foreignMemberSpaceId,
      });

      const nonOwnerUserId = await ctx.db.insert("users", {});
      const nonOwnerSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Wrong role",
        createdBy: nonOwnerUserId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: nonOwnerSpaceId,
        userId: nonOwnerUserId,
        role: "editor",
      });
      await ctx.db.insert("userSpaceSettings", {
        userId: nonOwnerUserId,
        personalSpaceId: nonOwnerSpaceId,
      });

      const invalidPersonUserId = await ctx.db.insert("users", {});
      const invalidPersonSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Wrong person",
        createdBy: invalidPersonUserId,
      });
      const nonPersonEntityId = await ctx.db.insert("entities", {
        ...entityFields(
          invalidPersonUserId,
          "not-a-person",
          invalidPersonSpaceId,
        ),
        kind: "organization",
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: invalidPersonSpaceId,
        userId: invalidPersonUserId,
        role: "owner",
        personEntityId: nonPersonEntityId,
      });
      await ctx.db.insert("userSpaceSettings", {
        userId: invalidPersonUserId,
        personalSpaceId: invalidPersonSpaceId,
      });
    });

    const result = await t.query(
      internal.models.spaces.migrations.auditPersonalSpaces,
      { batchSize: 20 },
    );

    expect(result.invalidCount).toBe(5);
    const reasons = result.invalids.map((invalid) => invalid.reason).join("\n");
    expect(reasons).toContain("duplicate personal spaces");
    expect(reasons).toContain("settings reference a foreign personal space");
    expect(reasons).toContain("personal space has a foreign member");
    expect(reasons).toContain("personal-space membership is not owner");
    expect(reasons).toContain(
      "personal-space member links a foreign person entity",
    );
  });
});
