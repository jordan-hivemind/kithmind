import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { rememberFact, resolveEntity } from "../facts/model";

async function fixture() {
  const t = convexTest(schema, modules);
  const data = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Alex Owner" });
    const editor = await ctx.db.insert("users", { name: "Alex Member" });
    const reader = await ctx.db.insert("users", { name: "Reader" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic household",
      createdBy: owner,
    });
    const personalId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Personal",
      createdBy: owner,
    });
    for (const [userId, role] of [
      [owner, "owner"],
      [editor, "editor"],
      [reader, "reader"],
    ] as const) {
      await ctx.db.insert("spaceMembers", { spaceId, userId, role });
    }
    await ctx.db.insert("spaceMembers", {
      spaceId: personalId,
      userId: owner,
      role: "owner",
    });
    return { owner, editor, reader, spaceId, personalId };
  });
  const identity = (subject: string) =>
    t.withIdentity({ subject, issuer: "https://synthetic.convex.site" });
  return {
    t,
    ...data,
    ownerClient: identity(data.owner),
    editorClient: identity(data.editor),
    readerClient: identity(data.reader),
  };
}

describe("explicit member person links", () => {
  beforeEach(() => vi.stubEnv("MCP_JWT_ISSUER", "https://mcp.synthetic.test"));
  afterEach(() => vi.unstubAllEnvs());

  test("two authenticated accounts read the same shared vehicle and person IDs", async () => {
    const f = await fixture();
    const { factId } = await f.t.run((ctx) =>
      rememberFact(ctx, f.owner, f.spaceId, {
        subject: { kind: "person", name: "Rowan", key: "person:rowan" },
        predicate: "owns_vehicle",
        value: {
          type: "entity",
          entity: {
            kind: "other",
            name: "Family car",
            key: "other:family-car",
          },
        },
        sourceType: "user_stated",
      }),
    );
    const args = { factId, spaceIds: [f.spaceId] };
    const ownerResult = await f.ownerClient.query(
      api.models.facts.public.getById,
      args,
    );
    const memberResult = await f.editorClient.query(
      api.models.facts.public.getById,
      args,
    );
    expect(ownerResult).not.toBeNull();
    expect(memberResult).toEqual(ownerResult);
    expect(memberResult?.subject.key).toBe("person:rowan");
    expect(memberResult?.value.type).toBe("entity");
  });

  test("same names stay distinct; retry is stable and conflicting retry rejected", async () => {
    const f = await fixture();
    const args = { spaceId: f.spaceId, name: "Alex", requestId: "first" };
    const first = await f.ownerClient.mutation(
      api.models.spaces.people.create,
      args,
    );
    expect(
      await f.ownerClient.mutation(api.models.spaces.people.create, args),
    ).toBe(first);
    const second = await f.ownerClient.mutation(
      api.models.spaces.people.create,
      { ...args, requestId: "second" },
    );
    expect(second).not.toBe(first);
    await expect(
      f.ownerClient.mutation(api.models.spaces.people.create, {
        ...args,
        name: "Changed",
      }),
    ).rejects.toThrow("request_conflict");
    expect(
      (
        await f.editorClient.query(api.models.spaces.people.list, {
          spaceId: f.spaceId,
        })
      ).people,
    ).toHaveLength(2);
  });

  test("two members resolve me distinctly and one person cannot be linked twice", async () => {
    const f = await fixture();
    const first = await f.ownerClient.mutation(
      api.models.spaces.people.create,
      { spaceId: f.spaceId, name: "Alex", requestId: "a" },
    );
    const second = await f.ownerClient.mutation(
      api.models.spaces.people.create,
      { spaceId: f.spaceId, name: "Alex", requestId: "b" },
    );
    await f.ownerClient.mutation(api.models.spaces.people.setMemberPerson, {
      spaceId: f.spaceId,
      userId: f.owner,
      personEntityId: first,
    });
    await expect(
      f.ownerClient.mutation(api.models.spaces.people.setMemberPerson, {
        spaceId: f.spaceId,
        userId: f.editor,
        personEntityId: first,
      }),
    ).rejects.toThrow("person_already_linked");
    await f.ownerClient.mutation(api.models.spaces.people.setMemberPerson, {
      spaceId: f.spaceId,
      userId: f.editor,
      personEntityId: second,
    });
    for (const [userId, expected] of [
      [f.owner, first],
      [f.editor, second],
    ] as const) {
      expect(
        (
          await f.t.run((ctx) =>
            resolveEntity(ctx, userId, f.spaceId, {
              kind: "person",
              name: "me",
            }),
          )
        )._id,
      ).toBe(expected);
    }
    await f.ownerClient.mutation(api.models.spaces.people.setMemberPerson, {
      spaceId: f.spaceId,
      userId: f.owner,
    });
    await expect(
      f.t.run((ctx) =>
        resolveEntity(ctx, f.owner, f.spaceId, { kind: "person", name: "me" }),
      ),
    ).rejects.toThrow("not linked");
  });

  test("Personal setup is explicit and private people cannot be shared by linking", async () => {
    const f = await fixture();
    const person = await f.ownerClient.mutation(
      api.models.spaces.people.create,
      { spaceId: f.personalId, name: "Personal person", requestId: "p" },
    );
    await f.ownerClient.mutation(api.models.spaces.people.setMemberPerson, {
      spaceId: f.personalId,
      userId: f.owner,
      personEntityId: person,
    });
    await expect(
      f.ownerClient.mutation(api.models.spaces.people.setMemberPerson, {
        spaceId: f.spaceId,
        userId: f.owner,
        personEntityId: person,
      }),
    ).rejects.toThrow("person_not_found");
    await expect(
      f.editorClient.query(api.models.spaces.people.list, {
        spaceId: f.personalId,
      }),
    ).rejects.toThrow("space_not_found");
  });

  test("reader cannot create; editor cannot link; removed membership and MCP cannot manage", async () => {
    const f = await fixture();
    const person = await f.editorClient.mutation(
      api.models.spaces.people.create,
      { spaceId: f.spaceId, name: "Member", requestId: "p" },
    );
    await expect(
      f.readerClient.mutation(api.models.spaces.people.create, {
        spaceId: f.spaceId,
        name: "Reader",
        requestId: "r",
      }),
    ).rejects.toThrow("space_not_found");
    await expect(
      f.editorClient.mutation(api.models.spaces.people.setMemberPerson, {
        spaceId: f.spaceId,
        userId: f.editor,
        personEntityId: person,
      }),
    ).rejects.toThrow("owner_required");
    await expect(
      f.t
        .withIdentity({
          subject: f.owner,
          issuer: "https://mcp.synthetic.test",
        })
        .query(api.models.spaces.people.list, { spaceId: f.spaceId }),
    ).rejects.toThrow("not_authenticated");
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("spaceMembers")
        .withIndex("by_spaceId_and_userId", (q) =>
          q.eq("spaceId", f.spaceId).eq("userId", f.editor),
        )
        .unique();
      await ctx.db.delete(row!._id);
    });
    await expect(
      f.editorClient.query(api.models.spaces.people.list, {
        spaceId: f.spaceId,
      }),
    ).rejects.toThrow("space_not_found");
  });

  test("non-person entities and malformed names cannot become person links", async () => {
    const f = await fixture();
    const vehicle = await f.t.run((ctx) =>
      resolveEntity(ctx, f.owner, f.spaceId, {
        kind: "other",
        name: "Car",
        key: "other:car",
      }),
    );
    await expect(
      f.ownerClient.mutation(api.models.spaces.people.setMemberPerson, {
        spaceId: f.spaceId,
        userId: f.owner,
        personEntityId: vehicle._id,
      }),
    ).rejects.toThrow("person_not_found");
    for (const name of [" ", "x".repeat(201), "broken\ud800"]) {
      await expect(
        f.ownerClient.mutation(api.models.spaces.people.create, {
          spaceId: f.spaceId,
          name,
          requestId: "bad",
        }),
      ).rejects.toThrow("invalid_input");
    }
  });
});
