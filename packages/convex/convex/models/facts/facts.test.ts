import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { MAX_CURRENT_FACTS_PER_PREDICATE } from "./model";

const issuer = "https://brain.example.test";
type Harness = ReturnType<typeof convexTest>;

async function createActor(t: Harness, name: string) {
  const records = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name });
    const personalSpaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: `${name} Personal`,
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", {
      spaceId: personalSpaceId,
      userId,
      role: "owner",
    });
    await ctx.db.insert("userSpaceSettings", { userId, personalSpaceId });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: `hash-${name}`,
      keyPrefix: `prefix-${name}`,
      name,
      capabilities: ["read", "write"],
      spaceIds: [personalSpaceId],
    });
    return { userId, personalSpaceId, credentialId };
  });
  return {
    ...records,
    mcp: t.withIdentity({
      issuer,
      subject: records.userId,
      apiKeyId: records.credentialId,
    }),
    web: t.withIdentity({
      issuer: `${issuer}/convex`,
      subject: records.userId,
    }),
  };
}

async function addSharedSpace(
  t: Harness,
  creator: Id<"users">,
  members: Array<{
    userId: Id<"users">;
    credentialId: Id<"apiKeys">;
    role: "owner" | "editor" | "reader";
  }>,
) {
  return await t.run(async (ctx) => {
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic Household",
      createdBy: creator,
    });
    for (const member of members) {
      await ctx.db.insert("spaceMembers", {
        spaceId,
        userId: member.userId,
        role: member.role,
      });
      const key = await ctx.db.get(member.credentialId);
      await ctx.db.patch(member.credentialId, {
        spaceIds: [...(key?.spaceIds ?? []), spaceId],
      });
    }
    return spaceId;
  });
}

const baseFact = {
  subject: { key: "person:rowan", kind: "person" as const, name: "Rowan" },
  predicate: "date_of_birth",
  value: { type: "date" as const, value: "2010-03-04" },
  sourceType: "user_stated" as const,
  isCore: true,
};

describe("space-scoped facts and entities", () => {
  const originalIssuer = process.env.MCP_JWT_ISSUER;
  beforeEach(() => {
    process.env.MCP_JWT_ISSUER = issuer;
  });
  afterEach(() => {
    if (originalIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
    else process.env.MCP_JWT_ISSUER = originalIssuer;
  });

  test("stores in Personal and returns space and author separately", async () => {
    const t = convexTest(schema, modules);
    const actor = await createActor(t, "Owner");
    const result = await actor.mcp.mutation(
      api.models.facts.mcpActions.remember,
      baseFact,
    );
    expect(result).toMatchObject({
      operation: "stored",
      statement: "Rowan — date of birth: 2010-03-04.",
    });
    expect(
      await actor.mcp.query(api.models.facts.mcpQueries.getById, {
        factId: result.factId,
      }),
    ).toMatchObject({
      id: result.factId,
      userId: actor.userId,
      spaceId: actor.personalSpaceId,
    });
    await expect(
      actor.mcp.mutation(api.models.facts.mcpActions.remember, {
        ...baseFact,
        predicate: "age",
        value: { type: "number", value: 16 },
      }),
    ).rejects.toThrow("Do not store a derived age");
  });

  test("shares one entity key across authors and denies reader writes", async () => {
    const t = convexTest(schema, modules);
    const owner = await createActor(t, "Owner");
    const editor = await createActor(t, "Editor");
    const reader = await createActor(t, "Reader");
    const spaceId = await addSharedSpace(t, owner.userId, [
      { ...owner, role: "owner" },
      { ...editor, role: "editor" },
      { ...reader, role: "reader" },
    ]);
    const first = await owner.mcp.mutation(
      api.models.facts.mcpActions.remember,
      {
        ...baseFact,
        predicate: "home_city",
        value: { type: "text", value: "Portland" },
        cardinality: "multiple",
        spaceId,
      },
    );
    const second = await editor.mcp.mutation(
      api.models.facts.mcpActions.remember,
      {
        ...baseFact,
        subject: { ...baseFact.subject, name: "Rowan Chen", aliases: ["R"] },
        predicate: "school",
        value: { type: "text", value: "Synthetic Academy" },
        spaceId,
      },
    );
    const visible = await reader.mcp.query(api.models.facts.mcpQueries.search, {
      query: "Rowan",
      spaceIds: [spaceId],
    });
    expect(visible.map((fact) => fact.id)).toEqual(
      expect.arrayContaining([first.factId, second.factId]),
    );
    expect(visible.map((fact) => fact.userId)).toEqual(
      expect.arrayContaining([owner.userId, editor.userId]),
    );
    const core = await reader.mcp.query(api.models.facts.mcpQueries.listCore, {
      spaceIds: [spaceId],
    });
    expect(core.map((fact) => fact.id)).toEqual(
      expect.arrayContaining([first.factId, second.factId]),
    );
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("entities")
          .withIndex("by_spaceId_and_key", (q) =>
            q.eq("spaceId", spaceId).eq("key", "person:rowan"),
          )
          .collect(),
      ),
    ).toHaveLength(1);
    await expect(
      reader.mcp.mutation(api.models.facts.mcpActions.remember, {
        ...baseFact,
        spaceId,
      }),
    ).rejects.toThrow("Space not found");
    await t.run(async (ctx) => {
      const key = await ctx.db.get(reader.credentialId);
      await ctx.db.patch(reader.credentialId, {
        spaceIds: key!.spaceIds!.filter((id) => id !== spaceId),
      });
    });
    await expect(
      reader.mcp.query(api.models.facts.mcpQueries.search, {
        query: "Rowan",
        spaceIds: [spaceId],
      }),
    ).rejects.toThrow("Space not found");
  });

  test("resolves me to each member-linked person in the selected space", async () => {
    const t = convexTest(schema, modules);
    const first = await createActor(t, "First");
    const second = await createActor(t, "Second");
    const spaceId = await addSharedSpace(t, first.userId, [
      { ...first, role: "owner" },
      { ...second, role: "editor" },
    ]);
    await expect(
      first.mcp.mutation(api.models.facts.mcpActions.remember, {
        subject: { key: "me", kind: "person", name: "Me" },
        predicate: "favorite_color",
        value: { type: "text", value: "blue" },
        sourceType: "user_stated",
        spaceId,
      }),
    ).rejects.toThrow("Me is not linked to a person in this space");
    const personIds = await t.run(async (ctx) => {
      const ids = await Promise.all(
        [first, second].map((actor) =>
          ctx.db.insert("entities", {
            userId: actor.userId,
            spaceId,
            key: `person:${actor.userId}`,
            kind: "person",
            canonicalName: `${actor.userId} Person`,
            normalizedName: `${actor.userId} person`,
            aliases: [],
            normalizedAliases: [],
          }),
        ),
      );
      for (const [actor, personEntityId] of [
        [first, ids[0]],
        [second, ids[1]],
      ] as const) {
        const membership = await ctx.db
          .query("spaceMembers")
          .withIndex("by_spaceId_and_userId", (q) =>
            q.eq("spaceId", spaceId).eq("userId", actor.userId),
          )
          .unique();
        await ctx.db.patch(membership!._id, { personEntityId });
      }
      return ids;
    });
    const remember = (actor: typeof first, value: string) =>
      actor.mcp.mutation(api.models.facts.mcpActions.remember, {
        subject: { key: "me", kind: "person", name: "Me" },
        predicate: "favorite_color",
        value: { type: "text", value },
        sourceType: "user_stated",
        spaceId,
      });
    const [one, two] = await Promise.all([
      remember(first, "blue"),
      remember(second, "green"),
    ]);
    expect(
      await t.run(async (ctx) => [
        (await ctx.db.get(one.factId))?.subjectEntityId,
        (await ctx.db.get(two.factId))?.subjectEntityId,
      ]),
    ).toEqual(personIds);
  });

  test("uses explicit, valid default, and Personal destinations and rejects a stale default", async () => {
    const t = convexTest(schema, modules);
    const actor = await createActor(t, "Owner");
    const outsider = await createActor(t, "Outsider");
    const sharedId = await addSharedSpace(t, actor.userId, [
      { ...actor, role: "owner" },
    ]);
    const explicit = await actor.mcp.mutation(
      api.models.facts.mcpActions.remember,
      { ...baseFact, predicate: "explicit_value", spaceId: sharedId },
    );
    const settingsId = await t.run(async (ctx) => {
      const settings = await ctx.db
        .query("userSpaceSettings")
        .withIndex("by_userId", (q) => q.eq("userId", actor.userId))
        .unique();
      await ctx.db.patch(settings!._id, { defaultWriteSpaceId: sharedId });
      return settings!._id;
    });
    const defaulted = await actor.mcp.mutation(
      api.models.facts.mcpActions.remember,
      { ...baseFact, predicate: "default_value" },
    );
    await t.run((ctx) =>
      ctx.db.patch(settingsId, { defaultWriteSpaceId: undefined }),
    );
    const personal = await actor.mcp.mutation(
      api.models.facts.mcpActions.remember,
      { ...baseFact, predicate: "personal_value" },
    );
    expect(
      await t.run(async (ctx) =>
        Promise.all(
          [explicit, defaulted, personal].map(
            async ({ factId }) => (await ctx.db.get(factId))?.spaceId,
          ),
        ),
      ),
    ).toEqual([sharedId, sharedId, actor.personalSpaceId]);
    const foreignId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Foreign",
        createdBy: outsider.userId,
      });
      await ctx.db.patch(settingsId, { defaultWriteSpaceId: id });
      return id;
    });
    expect(foreignId).toBeDefined();
    await expect(
      actor.mcp.mutation(api.models.facts.mcpActions.remember, {
        ...baseFact,
        predicate: "must_not_fallback",
      }),
    ).rejects.toThrow("Default write space is not available");
  });

  test("rejects cross-space object and history hydration on search and direct get", async () => {
    const t = convexTest(schema, modules);
    const actor = await createActor(t, "Owner");
    const other = await createActor(t, "Other");
    const sharedId = await addSharedSpace(t, actor.userId, [
      { ...actor, role: "owner" },
    ]);
    const ids = await t.run(async (ctx) => {
      const sharedSubject = await ctx.db.insert("entities", {
        userId: actor.userId,
        spaceId: sharedId,
        key: "person:shared",
        kind: "person",
        canonicalName: "Shared",
        normalizedName: "shared",
        aliases: [],
        normalizedAliases: [],
      });
      const privateEntity = await ctx.db.insert("entities", {
        userId: other.userId,
        spaceId: other.personalSpaceId,
        key: "person:private",
        kind: "person",
        canonicalName: "Private",
        normalizedName: "private",
        aliases: [],
        normalizedAliases: [],
      });
      const privateFact = await ctx.db.insert("facts", {
        userId: other.userId,
        spaceId: other.personalSpaceId,
        subjectEntityId: privateEntity,
        predicate: "private_value",
        value: { type: "text", value: "Private" },
        statement: "Private.",
        searchText: "private",
        sourceType: "user_stated",
        confidence: 1,
        status: "current",
      });
      const object = await ctx.db.insert("facts", {
        userId: actor.userId,
        spaceId: sharedId,
        subjectEntityId: sharedSubject,
        predicate: "doctor",
        value: { type: "entity", entityId: privateEntity },
        statement: "Cross-space object.",
        searchText: "cross scope sentinel object",
        sourceType: "user_stated",
        confidence: 1,
        status: "current",
      });
      const history = await ctx.db.insert("facts", {
        userId: actor.userId,
        spaceId: sharedId,
        subjectEntityId: sharedSubject,
        predicate: "school",
        value: { type: "text", value: "School" },
        statement: "Cross-space history.",
        searchText: "cross scope sentinel history",
        sourceType: "user_stated",
        confidence: 1,
        status: "current",
        supersedes: [privateFact],
      });
      return { privateFact, object, history };
    });
    for (const factId of Object.values(ids)) {
      expect(
        await actor.mcp.query(api.models.facts.mcpQueries.getById, {
          factId,
          spaceIds: [sharedId],
        }),
      ).toBeNull();
    }
    expect(
      await actor.mcp.query(api.models.facts.mcpQueries.search, {
        query: "cross scope sentinel",
        spaceIds: [sharedId],
      }),
    ).toEqual([]);
  });

  test("keeps correction history scoped and bounds current-value transitions", async () => {
    const t = convexTest(schema, modules);
    const actor = await createActor(t, "Owner");
    const wrong = await actor.mcp.mutation(
      api.models.facts.mcpActions.remember,
      { ...baseFact, value: { type: "date", value: "2009-05-11" } },
    );
    const corrected = await actor.mcp.mutation(
      api.models.facts.mcpActions.remember,
      { ...baseFact, changeKind: "corrected" },
    );
    const covering = await t.run((ctx) =>
      ctx.runQuery(internal.models.facts.private.searchCoveringFacts, {
        principal: {
          userId: actor.userId,
          credentialId: actor.credentialId,
        },
        query: "Rowan date of birth",
      }),
    );
    expect(covering.map((fact) => fact.id)).toContain(corrected.factId);
    expect(covering.map((fact) => fact.id)).not.toContain(wrong.factId);

    const subjectEntityId = (await t.run((ctx) =>
      ctx.db.get(corrected.factId),
    ))!.subjectEntityId;
    await t.run(async (ctx) => {
      for (
        let index = 0;
        index <= MAX_CURRENT_FACTS_PER_PREDICATE;
        index += 1
      ) {
        await ctx.db.insert("facts", {
          userId: actor.userId,
          spaceId: actor.personalSpaceId,
          subjectEntityId,
          predicate: "favorite_place",
          value: { type: "text", value: `Place ${index}` },
          statement: `Rowan — favorite place: Place ${index}.`,
          searchText: `overflow place ${index}`,
          sourceType: "user_stated",
          confidence: 1,
          status: "current",
        });
      }
    });
    await expect(
      actor.mcp.mutation(api.models.facts.mcpActions.remember, {
        ...baseFact,
        predicate: "favorite_place",
        value: { type: "text", value: "New Place" },
      }),
    ).rejects.toThrow(
      `Fact transition exceeds the ${MAX_CURRENT_FACTS_PER_PREDICATE}-record current-value limit`,
    );
    const current = await t.run((ctx) =>
      ctx.db
        .query("facts")
        .withIndex("by_spaceId_subject_predicate_status", (q) =>
          q
            .eq("spaceId", actor.personalSpaceId)
            .eq("subjectEntityId", subjectEntityId)
            .eq("predicate", "favorite_place")
            .eq("status", "current"),
        )
        .collect(),
    );
    expect(current).toHaveLength(MAX_CURRENT_FACTS_PER_PREDICATE + 1);
  });

  test("hydrates a maximum-size transition after it is later superseded", async () => {
    const t = convexTest(schema, modules);
    const actor = await createActor(t, "Owner");
    const subjectEntityId = await t.run((ctx) =>
      ctx.db.insert("entities", {
        userId: actor.userId,
        spaceId: actor.personalSpaceId,
        key: "person:bounded-history",
        kind: "person",
        canonicalName: "Bounded History",
        normalizedName: "bounded history",
        aliases: [],
        normalizedAliases: [],
      }),
    );
    await t.run(async (ctx) => {
      for (let index = 0; index < MAX_CURRENT_FACTS_PER_PREDICATE; index += 1) {
        await ctx.db.insert("facts", {
          userId: actor.userId,
          spaceId: actor.personalSpaceId,
          subjectEntityId,
          predicate: "bounded_history",
          value: { type: "text", value: `Value ${index}` },
          statement: `Bounded History — bounded history: Value ${index}.`,
          searchText: `bounded history value ${index}`,
          sourceType: "user_stated",
          confidence: 1,
          status: "current",
        });
      }
    });
    await expect(
      actor.mcp.mutation(api.models.facts.mcpActions.remember, {
        subject: {
          key: "person:bounded-history",
          kind: "person",
          name: "Bounded History",
        },
        predicate: "bounded_history",
        value: { type: "text", value: "Must not exceed the bound" },
        sourceType: "user_stated",
        cardinality: "multiple",
      }),
    ).rejects.toThrow(
      `Fact current-value limit of ${MAX_CURRENT_FACTS_PER_PREDICATE} reached`,
    );
    const maximum = await actor.mcp.mutation(
      api.models.facts.mcpActions.remember,
      {
        subject: {
          key: "person:bounded-history",
          kind: "person",
          name: "Bounded History",
        },
        predicate: "bounded_history",
        value: { type: "text", value: "Maximum transition" },
        sourceType: "user_stated",
      },
    );
    await actor.mcp.mutation(api.models.facts.mcpActions.remember, {
      subject: {
        key: "person:bounded-history",
        kind: "person",
        name: "Bounded History",
      },
      predicate: "bounded_history",
      value: { type: "text", value: "Later transition" },
      sourceType: "user_stated",
    });
    const hydrated = await actor.mcp.query(
      api.models.facts.mcpQueries.getById,
      { factId: maximum.factId },
    );
    expect(hydrated).toMatchObject({ id: maximum.factId });
    expect(hydrated?.supersedes).toHaveLength(MAX_CURRENT_FACTS_PER_PREDICATE);
    expect(hydrated?.supersededBy).toBeDefined();
  });

  test("applies one deterministic limit after searching all authorized spaces", async () => {
    const t = convexTest(schema, modules);
    const actor = await createActor(t, "Owner");
    const sharedId = await addSharedSpace(t, actor.userId, [
      { ...actor, role: "owner" },
    ]);
    for (const [spaceId, value] of [
      [actor.personalSpaceId, "personal"],
      [sharedId, "shared"],
    ] as const) {
      await actor.mcp.mutation(api.models.facts.mcpActions.remember, {
        ...baseFact,
        predicate: "search_marker",
        value: { type: "text", value: `deterministic sentinel ${value}` },
        spaceId,
      });
    }
    const args = { query: "deterministic sentinel", limit: 1 };
    const first = await actor.mcp.query(
      api.models.facts.mcpQueries.search,
      args,
    );
    const second = await actor.mcp.query(
      api.models.facts.mcpQueries.search,
      args,
    );
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  test("keeps dashboard and MCP identity domains separate", async () => {
    const t = convexTest(schema, modules);
    const actor = await createActor(t, "Owner");
    await actor.mcp.mutation(api.models.facts.mcpActions.remember, baseFact);
    await expect(
      actor.mcp.query(api.models.facts.public.listRecent, {}),
    ).rejects.toThrow("Not authenticated");
    expect(
      await actor.web.query(api.models.facts.public.listRecent, {}),
    ).toHaveLength(1);
  });
});
