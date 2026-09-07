import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export type PersonalSpaceInspection = {
  personalSpace: Doc<"spaces"> | null;
  membership: Doc<"spaceMembers"> | null;
  settings: Doc<"userSpaceSettings"> | null;
  issues: string[];
};

/**
 * Reads a user's personal-space records without relying on Convex `unique()`.
 * Migration inputs may already contain duplicates, so diagnostics must remain
 * readable instead of throwing before the operator can identify the rows.
 */
export async function inspectPersonalSpace(
  ctx: ReadCtx,
  userId: Id<"users">,
): Promise<PersonalSpaceInspection> {
  const personalSpaces = await ctx.db
    .query("spaces")
    .withIndex("by_createdBy_and_kind", (q) =>
      q.eq("createdBy", userId).eq("kind", "personal"),
    )
    .take(2);
  const settingsRows = await ctx.db
    .query("userSpaceSettings")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(2);

  const issues: string[] = [];
  if (personalSpaces.length > 1) issues.push("duplicate personal spaces");
  if (settingsRows.length > 1) issues.push("duplicate user space settings");

  const personalSpace = personalSpaces.length === 1 ? personalSpaces[0]! : null;
  const settings = settingsRows.length === 1 ? settingsRows[0]! : null;

  if (!personalSpace) {
    if (settings) issues.push("settings reference a missing personal space");
    return { personalSpace, membership: null, settings, issues };
  }

  if (settings && settings.personalSpaceId !== personalSpace._id) {
    issues.push("settings reference a foreign personal space");
  }

  const [ownMemberships, allMemberships] = await Promise.all([
    ctx.db
      .query("spaceMembers")
      .withIndex("by_spaceId_and_userId", (q) =>
        q.eq("spaceId", personalSpace._id).eq("userId", userId),
      )
      .take(2),
    ctx.db
      .query("spaceMembers")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", personalSpace._id))
      .take(2),
  ]);

  if (ownMemberships.length > 1) {
    issues.push("duplicate personal-space memberships");
  }
  if (allMemberships.some((membership) => membership.userId !== userId)) {
    issues.push("personal space has a foreign member");
  } else if (allMemberships.length > 1) {
    issues.push("personal space has duplicate memberships");
  }

  const membership = ownMemberships.length === 1 ? ownMemberships[0]! : null;
  if (membership && membership.role !== "owner") {
    issues.push("personal-space membership is not owner");
  }

  if (membership?.personEntityId) {
    const person = await ctx.db.get(membership.personEntityId);
    if (!person) {
      issues.push("personal-space member links a missing person entity");
    } else if (
      person.kind !== "person" ||
      person.userId !== userId ||
      (person.spaceId !== undefined && person.spaceId !== personalSpace._id)
    ) {
      issues.push("personal-space member links a foreign person entity");
    }
  }

  return { personalSpace, membership, settings, issues };
}

export function isPersonalSpaceReady(inspection: PersonalSpaceInspection) {
  return (
    inspection.issues.length === 0 &&
    inspection.personalSpace !== null &&
    inspection.membership?.role === "owner" &&
    inspection.settings?.personalSpaceId === inspection.personalSpace._id
  );
}

export async function insertMissingPersonalSpaceRecords(
  ctx: MutationCtx,
  userId: Id<"users">,
  inspection: PersonalSpaceInspection,
) {
  let personalSpaceId = inspection.personalSpace?._id;
  if (!personalSpaceId) {
    personalSpaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Personal",
      createdBy: userId,
    });
  }

  if (!inspection.membership) {
    await ctx.db.insert("spaceMembers", {
      spaceId: personalSpaceId,
      userId,
      role: "owner",
    });
  }
  if (!inspection.settings) {
    await ctx.db.insert("userSpaceSettings", {
      userId,
      personalSpaceId,
    });
  }

  return personalSpaceId;
}
