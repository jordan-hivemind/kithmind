import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { sha256Hex } from "../ingestion/hash";
import { parseFamilyErrorData } from "./errors";
import {
  FAMILY_INVITATION_TTL_MS,
  MAX_FAMILY_INVITATIONS,
  MAX_FAMILY_MEMBERS,
} from "./model";

const webIssuer = "https://synthetic.convex.site";
const mcpIssuer = "https://mcp.synthetic.test";

async function fixture() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", {
      name: "Owner Account",
      email: "owner@example.test",
    });
    const invitedId = await ctx.db.insert("users", {
      name: "Actual Account",
      email: "different-account@example.test",
    });
    const otherId = await ctx.db.insert("users", {
      name: "Other Account",
      email: "other@example.test",
    });
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
      defaultWriteSpaceId: personalSpaceId,
    });
    return { ownerId, invitedId, otherId, personalSpaceId };
  });
  const as = (userId: Id<"users">, issuer = webIssuer) =>
    t.withIdentity({ issuer, subject: userId });
  return {
    t,
    ...seeded,
    owner: as(seeded.ownerId),
    invited: as(seeded.invitedId),
    other: as(seeded.otherId),
    mcpOwner: as(seeded.ownerId, mcpIssuer),
  };
}

async function expectFamilyCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected family error");
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    const data = parseFamilyErrorData((error as { data: unknown }).data);
    expect(data?.code).toBe(code);
  }
}

async function createFamily(f: Awaited<ReturnType<typeof fixture>>) {
  return await f.owner.mutation(api.models.family.public.createSpace, {
    name: "Synthetic Family",
  });
}

async function inviteAndAccept(
  f: Awaited<ReturnType<typeof fixture>>,
  spaceId: Id<"spaces">,
  role: "editor" | "reader" = "editor",
) {
  const invitation = await f.owner.action(
    api.models.family.public.createInvitation,
    {
      spaceId,
      email: "hint@example.test",
      role,
    },
  );
  const acceptance = await f.invited.mutation(
    api.models.family.public.acceptInvitation,
    { token: invitation.token },
  );
  return { invitation, acceptance };
}

describe("family spaces", () => {
  beforeEach(() => {
    vi.stubEnv("MCP_JWT_ISSUER", mcpIssuer);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("creates a shared owner membership without changing defaults", async () => {
    const f = await fixture();
    const created = await createFamily(f);

    expect(created.viewerRole).toBe("owner");
    const stored = await f.t.run(async (ctx) => ({
      space: await ctx.db.get(created.spaceId),
      membership: await ctx.db.get(created.membershipId),
      settings: await ctx.db
        .query("userSpaceSettings")
        .withIndex("by_userId", (q) => q.eq("userId", f.ownerId))
        .unique(),
    }));
    expect(stored.space).toMatchObject({
      kind: "shared",
      name: "Synthetic Family",
      createdBy: f.ownerId,
    });
    expect(stored.membership).toMatchObject({
      spaceId: created.spaceId,
      userId: f.ownerId,
      role: "owner",
    });
    expect(stored.settings?.defaultWriteSpaceId).toBe(f.personalSpaceId);
  });

  test("keeps the 256-bit invitation secret out of storage", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    const usersBefore = await f.t.run((ctx) => ctx.db.query("users").collect());
    const before = Date.now();
    const invitation = await f.owner.action(
      api.models.family.public.createInvitation,
      {
        spaceId: created.spaceId,
        email: "  Person@Example.Test ",
        role: "reader",
      },
    );

    expect(invitation.token).toMatch(/^[0-9a-f]{64}$/u);
    const stored = await f.t.run((ctx) => ctx.db.get(invitation.invitationId));
    expect(stored).toMatchObject({
      spaceId: created.spaceId,
      emailNormalized: "person@example.test",
      tokenHash: await sha256Hex(invitation.token),
      status: "open",
      role: "reader",
    });
    expect(JSON.stringify(stored)).not.toContain(invitation.token);
    const usersAfter = await f.t.run((ctx) => ctx.db.query("users").collect());
    expect(usersAfter).toHaveLength(usersBefore.length);
    expect(invitation.expiresAt).toBeGreaterThanOrEqual(
      before + FAMILY_INVITATION_TTL_MS,
    );
  });

  test("acceptance stays pending until an owner approves the concrete account", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    const { invitation, acceptance } = await inviteAndAccept(
      f,
      created.spaceId,
    );

    expect(acceptance).toMatchObject({
      invitationId: invitation.invitationId,
      spaceId: created.spaceId,
      status: "pending_owner_approval",
      viewerUserId: f.invitedId,
    });
    await expectFamilyCode(
      f.invited.query(api.models.family.public.getSpace, {
        spaceId: created.spaceId,
      }),
      "space_not_found",
    );

    const ownerView = await f.owner.query(api.models.family.public.getSpace, {
      spaceId: created.spaceId,
    });
    expect(ownerView.viewer).toEqual({
      membershipId: created.membershipId,
      userId: f.ownerId,
      role: "owner",
    });
    expect(ownerView.invitations[0]).toMatchObject({
      intendedEmail: "hint@example.test",
      status: "pending_owner_approval",
      acceptedUser: {
        userId: f.invitedId,
        name: "Actual Account",
        email: "different-account@example.test",
      },
    });

    const approved = await f.owner.mutation(
      api.models.family.public.approveInvitation,
      { invitationId: invitation.invitationId },
    );
    expect(approved).toMatchObject({
      spaceId: created.spaceId,
      userId: f.invitedId,
      role: "editor",
    });
    expect(
      await f.owner.mutation(api.models.family.public.approveInvitation, {
        invitationId: invitation.invitationId,
      }),
    ).toEqual(approved);
    const memberView = await f.invited.query(
      api.models.family.public.getSpace,
      { spaceId: created.spaceId },
    );
    expect(memberView.viewer.role).toBe("editor");
    expect(memberView.invitations).toEqual([]);
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("userSpaceSettings")
          .withIndex("by_userId", (q) => q.eq("userId", f.invitedId))
          .unique(),
      ),
    ).toBeNull();
  });

  test("never lets the accepted account approve itself", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    const invitationId = await f.t.run(async (ctx) =>
      ctx.db.insert("familyInvitations", {
        spaceId: created.spaceId,
        emailNormalized: "owner-hint@example.test",
        tokenHash: "cd".repeat(32),
        role: "reader",
        status: "pending_owner_approval",
        createdBy: f.ownerId,
        createdAt: Date.now(),
        expiresAt: Date.now() + FAMILY_INVITATION_TTL_MS,
        acceptedBy: f.ownerId,
        acceptedAt: Date.now(),
      }),
    );
    await expectFamilyCode(
      f.owner.mutation(api.models.family.public.approveInvitation, {
        invitationId,
      }),
      "cannot_self_approve",
    );
  });

  test("revocation and expiry make invitation secrets unusable", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    const revoked = await f.owner.action(
      api.models.family.public.createInvitation,
      {
        spaceId: created.spaceId,
        email: "revoked@example.test",
        role: "reader",
      },
    );
    await f.owner.mutation(api.models.family.public.revokeInvitation, {
      invitationId: revoked.invitationId,
    });
    await expectFamilyCode(
      f.invited.mutation(api.models.family.public.acceptInvitation, {
        token: revoked.token,
      }),
      "invitation_unavailable",
    );

    const expiredToken = "ab".repeat(32);
    await f.t.run(async (ctx) => {
      await ctx.db.insert("familyInvitations", {
        spaceId: created.spaceId,
        emailNormalized: "expired@example.test",
        tokenHash: await sha256Hex(expiredToken),
        role: "reader",
        status: "open",
        createdBy: f.ownerId,
        createdAt: 1,
        expiresAt: 2,
      });
    });
    await expectFamilyCode(
      f.invited.mutation(api.models.family.public.acceptInvitation, {
        token: expiredToken,
      }),
      "invitation_expired",
    );
  });

  test("role changes, removal, leave, and ownership transfer enforce owner rules", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    const { invitation } = await inviteAndAccept(f, created.spaceId, "reader");
    const approved = await f.owner.mutation(
      api.models.family.public.approveInvitation,
      { invitationId: invitation.invitationId },
    );

    await expectFamilyCode(
      f.invited.mutation(api.models.family.public.changeMemberRole, {
        membershipId: approved.membershipId,
        role: "editor",
      }),
      "owner_required",
    );
    await f.owner.mutation(api.models.family.public.changeMemberRole, {
      membershipId: approved.membershipId,
      role: "editor",
    });
    await expectFamilyCode(
      f.owner.mutation(api.models.family.public.leaveSpace, {
        spaceId: created.spaceId,
      }),
      "last_owner",
    );

    await f.owner.mutation(api.models.family.public.transferOwnership, {
      spaceId: created.spaceId,
      toMembershipId: approved.membershipId,
    });
    const roles = await f.t.run(async (ctx) => ({
      oldOwner: await ctx.db.get(created.membershipId),
      newOwner: await ctx.db.get(approved.membershipId),
    }));
    expect(roles.oldOwner?.role).toBe("editor");
    expect(roles.newOwner?.role).toBe("owner");
    await expectFamilyCode(
      f.owner.mutation(api.models.family.public.removeMember, {
        membershipId: approved.membershipId,
      }),
      "owner_required",
    );
    await f.owner.mutation(api.models.family.public.leaveSpace, {
      spaceId: created.spaceId,
    });
    await expectFamilyCode(
      f.owner.query(api.models.family.public.getSpace, {
        spaceId: created.spaceId,
      }),
      "space_not_found",
    );
  });

  test("MCP identities cannot reach any family management surface", async () => {
    const f = await fixture();
    await expectFamilyCode(
      f.mcpOwner.mutation(api.models.family.public.createSpace, {
        name: "Escalated",
      }),
      "not_authenticated",
    );
    await expectFamilyCode(
      f.mcpOwner.action(api.models.family.public.createInvitation, {
        spaceId: f.personalSpaceId,
        email: "person@example.test",
        role: "reader",
      }),
      "not_authenticated",
    );
  });

  test("bounds member and invitation growth", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    await f.t.run(async (ctx) => {
      for (let index = 1; index < MAX_FAMILY_MEMBERS; index += 1) {
        const userId = await ctx.db.insert("users", {
          name: `Member ${index}`,
        });
        await ctx.db.insert("spaceMembers", {
          spaceId: created.spaceId,
          userId,
          role: "reader",
        });
      }
    });
    const { invitation } = await inviteAndAccept(f, created.spaceId);
    await expectFamilyCode(
      f.owner.mutation(api.models.family.public.approveInvitation, {
        invitationId: invitation.invitationId,
      }),
      "member_limit_reached",
    );

    const second = await createFamily(f);
    await f.t.run(async (ctx) => {
      for (let index = 0; index < MAX_FAMILY_INVITATIONS + 5; index += 1) {
        await ctx.db.insert("familyInvitations", {
          spaceId: second.spaceId,
          emailNormalized: `existing-${index}@example.test`,
          tokenHash: index.toString(16).padStart(64, "0"),
          role: "reader",
          status: "revoked",
          createdBy: f.ownerId,
          createdAt: index,
          expiresAt: index,
        });
      }
    });
    await expect(
      f.owner.action(api.models.family.public.createInvitation, {
        spaceId: second.spaceId,
        email: "new-after-history@example.test",
        role: "reader",
      }),
    ).resolves.toMatchObject({
      token: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const third = await createFamily(f);
    await f.t.run(async (ctx) => {
      for (let index = 0; index < MAX_FAMILY_INVITATIONS; index += 1) {
        await ctx.db.insert("familyInvitations", {
          spaceId: third.spaceId,
          emailNormalized: `active-${index}@example.test`,
          tokenHash: (index + 1_000).toString(16).padStart(64, "0"),
          role: "reader",
          status: "open",
          createdBy: f.ownerId,
          createdAt: Date.now(),
          expiresAt: Date.now() + FAMILY_INVITATION_TTL_MS,
        });
      }
    });
    await expectFamilyCode(
      f.owner.action(api.models.family.public.createInvitation, {
        spaceId: third.spaceId,
        email: "overflow@example.test",
        role: "reader",
      }),
      "invitation_limit_reached",
    );
  });

  test("concurrent approvals cannot create duplicate memberships", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    const { invitation } = await inviteAndAccept(f, created.spaceId);
    const approvals = await Promise.allSettled([
      f.owner.mutation(api.models.family.public.approveInvitation, {
        invitationId: invitation.invitationId,
      }),
      f.owner.mutation(api.models.family.public.approveInvitation, {
        invitationId: invitation.invitationId,
      }),
    ]);
    expect(approvals.every((result) => result.status === "fulfilled")).toBe(
      true,
    );
    const memberships = await f.t.run((ctx) =>
      ctx.db
        .query("spaceMembers")
        .withIndex("by_spaceId_and_userId", (q) =>
          q.eq("spaceId", created.spaceId).eq("userId", f.invitedId),
        )
        .collect(),
    );
    expect(memberships).toHaveLength(1);
  });

  test("concurrent acceptance binds a token to only one authenticated account", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    const invitation = await f.owner.action(
      api.models.family.public.createInvitation,
      {
        spaceId: created.spaceId,
        email: "shared-hint@example.test",
        role: "reader",
      },
    );
    const attempts = await Promise.allSettled([
      f.invited.mutation(api.models.family.public.acceptInvitation, {
        token: invitation.token,
      }),
      f.other.mutation(api.models.family.public.acceptInvitation, {
        token: invitation.token,
      }),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const stored = await f.t.run((ctx) => ctx.db.get(invitation.invitationId));
    expect([f.invitedId, f.otherId]).toContain(stored?.acceptedBy);
    expect(stored?.status).toBe("pending_owner_approval");
  });

  test("ownership cannot be transferred to a deleted account", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    const staleMembershipId = await f.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "Deleted member" });
      const membershipId = await ctx.db.insert("spaceMembers", {
        spaceId: created.spaceId,
        userId,
        role: "editor",
      });
      await ctx.db.delete(userId);
      return membershipId;
    });
    await expectFamilyCode(
      f.owner.mutation(api.models.family.public.transferOwnership, {
        spaceId: created.spaceId,
        toMembershipId: staleMembershipId,
      }),
      "space_not_found",
    );
    expect(
      await f.t.run((ctx) => ctx.db.get(created.membershipId)),
    ).toMatchObject({ role: "owner" });
  });

  test("a stale owner row cannot let the sole live owner leave", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    await f.t.run(async (ctx) => {
      const deletedOwner = await ctx.db.insert("users", {
        name: "Deleted owner",
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: created.spaceId,
        userId: deletedOwner,
        role: "owner",
      });
      await ctx.db.delete(deletedOwner);
    });
    await expectFamilyCode(
      f.owner.mutation(api.models.family.public.leaveSpace, {
        spaceId: created.spaceId,
      }),
      "last_owner",
    );
    expect(
      await f.t.run((ctx) => ctx.db.get(created.membershipId)),
    ).toMatchObject({ role: "owner" });
  });

  test("ownership cannot transfer to a user with duplicate memberships", async () => {
    const f = await fixture();
    const created = await createFamily(f);
    const targetMembershipId = await f.t.run(async (ctx) => {
      const targetUserId = await ctx.db.insert("users", {
        name: "Duplicate member",
      });
      const target = await ctx.db.insert("spaceMembers", {
        spaceId: created.spaceId,
        userId: targetUserId,
        role: "editor",
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: created.spaceId,
        userId: targetUserId,
        role: "reader",
      });
      return target;
    });
    await expectFamilyCode(
      f.owner.mutation(api.models.family.public.transferOwnership, {
        spaceId: created.spaceId,
        toMembershipId: targetMembershipId,
      }),
      "space_not_found",
    );
    expect(
      await f.t.run((ctx) => ctx.db.get(created.membershipId)),
    ).toMatchObject({ role: "owner" });
  });

  test("returns only fixed structured errors for invalid family input", async () => {
    const f = await fixture();
    await expectFamilyCode(
      f.owner.mutation(api.models.family.public.createSpace, { name: "   " }),
      "invalid_input",
    );
    await expectFamilyCode(
      f.owner.query(api.models.family.public.getSpace, {
        spaceId: "x".repeat(257),
      }),
      "invalid_input",
    );
    await expectFamilyCode(
      f.invited.mutation(api.models.family.public.acceptInvitation, {
        token: "not-a-token",
      }),
      "invalid_input",
    );
  });
});
