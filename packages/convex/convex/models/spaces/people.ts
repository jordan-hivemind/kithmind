import { ConvexError, v } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../../_generated/server";
import { requireSpaceAccess } from "../../lib/spaces";
import { requireWebPrincipal } from "../../lib/webAuth";
import { normalizeEntityName } from "../facts/model";
import { sha256Hex } from "../ingestion/hash";

const MAX_PEOPLE = 100;
const messages = {
  not_authenticated: "Sign in to continue.",
  space_not_found: "Space is not available.",
  owner_required: "Only a space owner can manage person links.",
  invalid_input: "Enter a valid name and request ID.",
  person_not_found: "Person is not available in this space.",
  person_already_linked: "This person is already linked to another member.",
  request_conflict: "This request was already used for a different person.",
  people_limit_reached: "This space has reached the supported people limit.",
  member_limit_reached: "This space has exceeded the supported member limit.",
} as const;

function fail(code: keyof typeof messages): never {
  throw new ConvexError({ code, message: messages[code] });
}

async function access(ctx: QueryCtx, spaceId: Id<"spaces">, write = false) {
  const principal = await requireWebPrincipal(ctx).catch(() =>
    fail("not_authenticated"),
  );
  const membership = await requireSpaceAccess(
    ctx,
    principal,
    spaceId,
    write ? "write" : "read",
  ).catch(() => fail("space_not_found"));
  const space = await ctx.db.get(spaceId);
  if (
    !space ||
    (space.kind === "personal" && space.createdBy !== principal.userId)
  ) {
    fail("space_not_found");
  }
  return { principal, membership, space };
}

function validText(value: string, max: number): boolean {
  if (!value.trim() || value.length > max) return false;
  // Encoding must not silently replace an unpaired surrogate in stored names.
  return new TextDecoder().decode(new TextEncoder().encode(value)) === value;
}

export const list = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const { principal, membership } = await access(ctx, spaceId);
    const people = await ctx.db
      .query("entities")
      .withIndex("by_spaceId_kind_normalizedName", (q) =>
        q.eq("spaceId", spaceId).eq("kind", "person"),
      )
      .take(MAX_PEOPLE + 1);
    if (people.length > MAX_PEOPLE) fail("people_limit_reached");
    const memberships = await ctx.db
      .query("spaceMembers")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
      .take(101);
    if (memberships.length > 100) fail("member_limit_reached");
    const members: Array<{
      userId: Id<"users">;
      name?: string;
      email?: string;
      personEntityId?: Id<"entities">;
    }> = [];
    for (const member of memberships) {
      const user = await ctx.db.get(member.userId);
      if (!user) continue;
      const person = people.find((row) => row._id === member.personEntityId);
      members.push({
        userId: user._id,
        name: user.name,
        email: user.email,
        personEntityId: person?._id,
      });
    }
    return {
      viewerUserId: principal.userId,
      canManageLinks: membership.role === "owner",
      canCreatePeople: membership.role !== "reader",
      members,
      people: people.map((person) => ({
        entityId: person._id,
        name: person.canonicalName,
        key: person.key,
        linkedUserId: members.find(
          (member) => member.personEntityId === person._id,
        )?.userId,
      })),
    };
  },
});

export const create = mutation({
  args: { spaceId: v.id("spaces"), name: v.string(), requestId: v.string() },
  returns: v.id("entities"),
  handler: async (ctx, { spaceId, name, requestId }) => {
    const { principal } = await access(ctx, spaceId, true);
    if (!validText(name, 200) || !validText(requestId, 128))
      fail("invalid_input");
    const canonicalName = name.trim();
    // Names do not identify people. Bind a retry key to the actor and space.
    const key =
      "person:" +
      (await sha256Hex(JSON.stringify([principal.userId, requestId])));
    const existing = await ctx.db
      .query("entities")
      .withIndex("by_spaceId_and_key", (q) =>
        q.eq("spaceId", spaceId).eq("key", key),
      )
      .unique();
    if (existing) {
      if (
        existing.kind !== "person" ||
        existing.canonicalName !== canonicalName
      )
        fail("request_conflict");
      return existing._id;
    }
    const people = await ctx.db
      .query("entities")
      .withIndex("by_spaceId_kind_normalizedName", (q) =>
        q.eq("spaceId", spaceId).eq("kind", "person"),
      )
      .take(MAX_PEOPLE);
    if (people.length >= MAX_PEOPLE) fail("people_limit_reached");
    return await ctx.db.insert("entities", {
      spaceId,
      userId: principal.userId,
      kind: "person",
      key,
      canonicalName,
      normalizedName: normalizeEntityName(canonicalName),
      aliases: [],
      normalizedAliases: [],
    });
  },
});

export const setMemberPerson = mutation({
  args: {
    spaceId: v.id("spaces"),
    userId: v.id("users"),
    personEntityId: v.optional(v.id("entities")),
  },
  returns: v.null(),
  handler: async (ctx, { spaceId, userId, personEntityId }) => {
    const { principal, membership, space } = await access(ctx, spaceId);
    if (membership.role !== "owner") fail("owner_required");
    if (space.kind === "personal" && userId !== principal.userId)
      fail("space_not_found");
    const members = await ctx.db
      .query("spaceMembers")
      .withIndex("by_spaceId_and_userId", (q) =>
        q.eq("spaceId", spaceId).eq("userId", userId),
      )
      .take(2);
    if (members.length !== 1 || !(await ctx.db.get(userId)))
      fail("space_not_found");
    if (personEntityId !== undefined) {
      const person = await ctx.db.get(personEntityId);
      if (!person || person.spaceId !== spaceId || person.kind !== "person")
        fail("person_not_found");
      const linked = await ctx.db
        .query("spaceMembers")
        .withIndex("by_spaceId_personEntityId", (q) =>
          q.eq("spaceId", spaceId).eq("personEntityId", personEntityId),
        )
        .take(2);
      if (linked.some((member) => member._id !== members[0]!._id))
        fail("person_already_linked");
    }
    await ctx.db.patch(members[0]!._id, { personEntityId });
    return null;
  },
});
