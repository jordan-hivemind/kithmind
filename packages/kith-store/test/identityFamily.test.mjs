// Shared spaces, members and invitations: the denial half of
// `packages/convex/convex/models/family/family.test.ts`.
//
// The invariant worth stating once, because most of the file is it: holding an
// invitation link is never membership. Accepting only marks the invitation as
// awaiting approval, a second owner has to approve it, and an owner cannot
// approve their own acceptance. Everything below is either that rule or the
// bounds around it.

import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptInvitationByToken,
  activeInvitations,
  approveInvitationForOwner,
  changeFamilyMemberRole,
  createInvitation,
  createSharedSpace,
  getFamilySpace,
  leaveSharedSpace,
  normalizeInvitationEmail,
  removeFamilyMember,
  requireSharedMembership,
  requireSharedOwner,
  revokeInvitationForOwner,
  transferSharedSpaceOwnership,
  validateFamilySpaceName,
  validateInvitationToken,
  ensurePersonalSpace,
} from "../dist/identity/index.js";
import { newKithId } from "../dist/index.js";
import {
  identityDatabase,
  makeMember,
  makeSpace,
  makeUser,
  refusal,
  refusalCode,
  skip,
} from "./helpers/identityFixture.mjs";

/** An owner and a shared space they own. */
async function sharedSpace(ctx) {
  const ownerId = await makeUser(ctx, { email: "owner@example.test" });
  const { spaceId, membershipId } = await createSharedSpace(ctx, {
    userId: ownerId,
    name: "A Household",
  });
  return { ownerId, spaceId, membershipId };
}

test(
  "names and emails are validated before they are stored",
  { skip },
  async () => {
    assert.equal(validateFamilySpaceName("  A Household  "), "A Household");
    for (const name of [
      "",
      "   ",
      "n".repeat(101),
      "bad\u0000name",
      "bad\u007f",
      "\ud800",
    ]) {
      assert.equal(
        await refusalCode(async () => validateFamilySpaceName(name)),
        "invalid_input",
        JSON.stringify(name),
      );
    }

    assert.equal(
      normalizeInvitationEmail("  Someone@Example.TEST "),
      "someone@example.test",
    );
    for (const email of [
      "",
      "no-at-sign",
      "two@at@example.test",
      "trailing@",
      "@leading.test",
      "nodot@example",
      "space in@example.test",
      `${"a".repeat(320)}@example.test`,
      "\ud800@example.test",
    ]) {
      assert.equal(
        await refusalCode(async () => normalizeInvitationEmail(email)),
        "invalid_input",
        JSON.stringify(email),
      );
    }

    for (const token of ["", "short", "A".repeat(64), "z".repeat(64)]) {
      assert.equal(
        await refusalCode(async () => validateInvitationToken(token)),
        "invalid_input",
        JSON.stringify(token),
      );
    }
  },
);

test(
  "a personal space is not a family space, for anyone",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const personal = await ensurePersonalSpace(ctx, userId);
      // Its own owner is refused, because the family surface only operates on
      // shared spaces and a personal space must not be reachable through it.
      assert.equal(
        await refusalCode(() => requireSharedMembership(ctx, personal, userId)),
        "space_not_found",
      );
      assert.equal(
        await refusalCode(() =>
          createInvitation(ctx, {
            actorUserId: userId,
            spaceId: personal,
            email: "guest@example.test",
            role: "reader",
          }),
        ),
        "space_not_found",
      );
      // A space that does not exist, and an id that is not an id.
      assert.equal(
        await refusalCode(() =>
          requireSharedMembership(ctx, newKithId(), userId),
        ),
        "space_not_found",
      );
      assert.equal(
        await refusalCode(() =>
          createInvitation(ctx, {
            actorUserId: userId,
            spaceId: "not-an-id",
            email: "guest@example.test",
            role: "reader",
          }),
        ),
        "space_not_found",
      );
    });
  },
);

test(
  "only an owner invites, revokes, changes roles or transfers",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const { ownerId, spaceId } = await sharedSpace(ctx);
      const editorId = await makeUser(ctx);
      const readerId = await makeUser(ctx);
      const strangerId = await makeUser(ctx);
      const editorMembership = await makeMember(ctx, {
        spaceId,
        userId: editorId,
        role: "editor",
      });
      await makeMember(ctx, { spaceId, userId: readerId, role: "reader" });

      for (const [userId, code] of [
        [editorId, "owner_required"],
        [readerId, "owner_required"],
        // A stranger is told the space is not there, not that they are not an
        // owner: membership is not enumerable.
        [strangerId, "space_not_found"],
      ]) {
        assert.equal(
          await refusalCode(() => requireSharedOwner(ctx, spaceId, userId)),
          code,
        );
        assert.equal(
          await refusalCode(() =>
            createInvitation(ctx, {
              actorUserId: userId,
              spaceId,
              email: "guest@example.test",
              role: "reader",
            }),
          ),
          code,
        );
        assert.equal(
          await refusalCode(() =>
            changeFamilyMemberRole(ctx, {
              actorUserId: userId,
              membershipId: editorMembership,
              role: "reader",
            }),
          ),
          code,
        );
        assert.equal(
          await refusalCode(() =>
            removeFamilyMember(ctx, {
              actorUserId: userId,
              membershipId: editorMembership,
            }),
          ),
          code,
        );
      }

      // And a non-owner sees members but never the invitation list.
      await createInvitation(ctx, {
        actorUserId: ownerId,
        spaceId,
        email: "guest@example.test",
        role: "reader",
      });
      const asOwner = await getFamilySpace(ctx, { userId: ownerId, spaceId });
      assert.equal(asOwner.invitations.length, 1);
      assert.equal(asOwner.invitations[0].intendedEmail, "guest@example.test");
      const asEditor = await getFamilySpace(ctx, { userId: editorId, spaceId });
      assert.deepEqual(asEditor.invitations, []);
      assert.equal(asEditor.members.length, 3);
    });
  },
);

test(
  "a token is not membership: accepting awaits another owner's approval",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const { ownerId, spaceId, membershipId } = await sharedSpace(ctx);
      const secondOwnerId = await makeUser(ctx);
      await makeMember(ctx, {
        spaceId,
        userId: secondOwnerId,
        role: "owner",
      });
      const guestId = await makeUser(ctx, { email: "guest@example.test" });

      const invitation = await createInvitation(ctx, {
        actorUserId: ownerId,
        spaceId,
        email: "Guest@Example.test",
        role: "editor",
      });
      assert.match(invitation.token, /^[0-9a-f]{64}$/);

      // Only the hash is stored, so the link cannot be recovered from the row.
      const stored = await ctx.client.query(
        "SELECT token_hash, email_normalized, status FROM kith.family_invitations WHERE id = $1",
        [invitation.invitationId],
      );
      assert.notEqual(stored.rows[0].token_hash, invitation.token);
      assert.equal(stored.rows[0].email_normalized, "guest@example.test");
      assert.equal(stored.rows[0].status, "open");

      const accepted = await acceptInvitationByToken(ctx, {
        userId: guestId,
        token: invitation.token,
      });
      assert.equal(accepted.spaceId, spaceId);
      // Still not a member.
      assert.equal(
        await refusalCode(() => requireSharedMembership(ctx, spaceId, guestId)),
        "space_not_found",
      );

      // The invited account cannot approve itself in, because it is not an owner.
      assert.equal(
        await refusalCode(() =>
          approveInvitationForOwner(ctx, {
            actorUserId: guestId,
            invitationId: invitation.invitationId,
          }),
        ),
        "space_not_found",
      );
      // And it cannot approve itself in even after becoming an owner of the
      // space some other way, which is the only route by which the acceptor and
      // the approver could ever be the same account.
      const ownerElsewhere = await makeMember(ctx, {
        spaceId,
        userId: guestId,
        role: "owner",
      });
      assert.equal(
        await refusalCode(() =>
          approveInvitationForOwner(ctx, {
            actorUserId: guestId,
            invitationId: invitation.invitationId,
          }),
        ),
        "cannot_self_approve",
      );
      await ctx.client.query("DELETE FROM kith.space_members WHERE id = $1", [
        ownerElsewhere,
      ]);

      const approval = await approveInvitationForOwner(ctx, {
        actorUserId: secondOwnerId,
        invitationId: invitation.invitationId,
      });
      assert.equal(approval.userId, guestId);
      assert.equal(approval.role, "editor");
      assert.equal(
        (await requireSharedMembership(ctx, spaceId, guestId)).membership.role,
        "editor",
      );
      // Approving again is idempotent rather than a second membership.
      assert.deepEqual(
        await approveInvitationForOwner(ctx, {
          actorUserId: secondOwnerId,
          invitationId: invitation.invitationId,
        }),
        approval,
      );
      const members = await ctx.client.query(
        "SELECT count(*)::int AS n FROM kith.space_members WHERE space_id = $1 AND user_id = $2",
        [spaceId, guestId],
      );
      assert.equal(members.rows[0].n, 1);
      assert.ok(membershipId);
    });
  },
);

test(
  "an accepted invitation belongs to the account that accepted it",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const { ownerId, spaceId } = await sharedSpace(ctx);
      const guestId = await makeUser(ctx);
      const interloperId = await makeUser(ctx);
      const invitation = await createInvitation(ctx, {
        actorUserId: ownerId,
        spaceId,
        email: "guest@example.test",
        role: "reader",
      });
      await acceptInvitationByToken(ctx, {
        userId: guestId,
        token: invitation.token,
      });
      // Someone else with the same link cannot take it over.
      assert.equal(
        await refusalCode(() =>
          acceptInvitationByToken(ctx, {
            userId: interloperId,
            token: invitation.token,
          }),
        ),
        "invitation_unavailable",
      );
      // The account that accepted can re-accept idempotently.
      assert.equal(
        (
          await acceptInvitationByToken(ctx, {
            userId: guestId,
            token: invitation.token,
          })
        ).invitationId,
        invitation.invitationId,
      );
    });
  },
);

test(
  "an expired, revoked or unknown invitation cannot be used",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const { ownerId, spaceId } = await sharedSpace(ctx);
      const secondOwnerId = await makeUser(ctx);
      await makeMember(ctx, { spaceId, userId: secondOwnerId, role: "owner" });
      const guestId = await makeUser(ctx);

      // Unknown token.
      assert.equal(
        await refusalCode(() =>
          acceptInvitationByToken(ctx, {
            userId: guestId,
            token: "a".repeat(64),
          }),
        ),
        "invitation_not_found",
      );

      // Expired.
      const expiring = await createInvitation(ctx, {
        actorUserId: ownerId,
        spaceId,
        email: "late@example.test",
        role: "reader",
      });
      const later = db.ctx(expiring.expiresAt + 1);
      assert.equal(
        await refusalCode(() =>
          acceptInvitationByToken(later, {
            userId: guestId,
            token: expiring.token,
          }),
        ),
        "invitation_expired",
      );
      assert.deepEqual(await activeInvitations(later, spaceId, later.now), []);

      // Revoked.
      const revoked = await createInvitation(ctx, {
        actorUserId: ownerId,
        spaceId,
        email: "revoked@example.test",
        role: "reader",
      });
      await revokeInvitationForOwner(ctx, {
        actorUserId: ownerId,
        invitationId: revoked.invitationId,
      });
      assert.equal(
        await refusalCode(() =>
          acceptInvitationByToken(ctx, {
            userId: guestId,
            token: revoked.token,
          }),
        ),
        "invitation_unavailable",
      );
      // Revoking twice is refused rather than silently repeated.
      assert.equal(
        await refusalCode(() =>
          revokeInvitationForOwner(ctx, {
            actorUserId: ownerId,
            invitationId: revoked.invitationId,
          }),
        ),
        "invitation_unavailable",
      );
      // A revoked invitation cannot be approved either.
      assert.equal(
        await refusalCode(() =>
          approveInvitationForOwner(ctx, {
            actorUserId: secondOwnerId,
            invitationId: revoked.invitationId,
          }),
        ),
        "invitation_unavailable",
      );
    });
  },
);

test(
  "an existing member cannot be re-invited into membership",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const { ownerId, spaceId } = await sharedSpace(ctx);
      const memberId = await makeUser(ctx);
      await makeMember(ctx, { spaceId, userId: memberId, role: "reader" });
      const invitation = await createInvitation(ctx, {
        actorUserId: ownerId,
        spaceId,
        email: "member@example.test",
        role: "editor",
      });
      assert.equal(
        await refusalCode(() =>
          acceptInvitationByToken(ctx, {
            userId: memberId,
            token: invitation.token,
          }),
        ),
        "already_member",
      );
      // A second live invitation for the same address is refused.
      assert.equal(
        await refusalCode(() =>
          createInvitation(ctx, {
            actorUserId: ownerId,
            spaceId,
            email: "member@example.test",
            role: "reader",
          }),
        ),
        "invitation_unavailable",
      );
    });
  },
);

test("a family space keeps at least one owner", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const { ownerId, spaceId, membershipId } = await sharedSpace(ctx);
    const editorId = await makeUser(ctx);
    const editorMembership = await makeMember(ctx, {
      spaceId,
      userId: editorId,
      role: "editor",
    });

    // The only owner cannot leave, cannot be removed, and cannot be demoted.
    assert.equal(
      await refusalCode(() =>
        leaveSharedSpace(ctx, { userId: ownerId, spaceId }),
      ),
      "last_owner",
    );
    assert.equal(
      await refusalCode(() =>
        removeFamilyMember(ctx, { actorUserId: ownerId, membershipId }),
      ),
      "last_owner",
    );
    assert.equal(
      await refusalCode(() =>
        changeFamilyMemberRole(ctx, {
          actorUserId: ownerId,
          membershipId,
          role: "editor",
        }),
      ),
      "last_owner",
    );

    // Transfer moves ownership and demotes the previous owner in one step, so
    // there is exactly one owner at every point.
    await transferSharedSpaceOwnership(ctx, {
      actorUserId: ownerId,
      spaceId,
      toMembershipId: editorMembership,
    });
    assert.equal(
      (await requireSharedMembership(ctx, spaceId, editorId)).membership.role,
      "owner",
    );
    assert.equal(
      (await requireSharedMembership(ctx, spaceId, ownerId)).membership.role,
      "editor",
    );
    // Now the former owner may leave.
    await leaveSharedSpace(ctx, { userId: ownerId, spaceId });
    assert.equal(
      await refusalCode(() => requireSharedMembership(ctx, spaceId, ownerId)),
      "space_not_found",
    );
  });
});

test(
  "a transfer needs a real, unique membership in the same space",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const { ownerId, spaceId, membershipId } = await sharedSpace(ctx);
      const otherSpace = await makeSpace(ctx, {
        createdBy: ownerId,
        role: "owner",
      });
      const outsiderId = await makeUser(ctx);
      const foreignMembership = await makeMember(ctx, {
        spaceId: otherSpace,
        userId: outsiderId,
        role: "editor",
      });
      const duplicatedId = await makeUser(ctx);
      const duplicated = await makeMember(ctx, {
        spaceId,
        userId: duplicatedId,
        role: "editor",
      });
      await makeMember(ctx, { spaceId, userId: duplicatedId, role: "reader" });

      for (const [toMembershipId, code] of [
        // To themselves.
        [membershipId, "invalid_input"],
        // A membership in another space, an unknown one, and a malformed id.
        [foreignMembership, "space_not_found"],
        [newKithId(), "space_not_found"],
        ["not-an-id", "space_not_found"],
        // A member with two membership rows is a defect, not a transfer target.
        [duplicated, "space_not_found"],
      ]) {
        assert.equal(
          await refusalCode(() =>
            transferSharedSpaceOwnership(ctx, {
              actorUserId: ownerId,
              spaceId,
              toMembershipId,
            }),
          ),
          code,
          String(toMembershipId),
        );
        // Ownership did not move.
        assert.equal(
          (await requireSharedMembership(ctx, spaceId, ownerId)).membership
            .role,
          "owner",
        );
      }
    });
  },
);

test(
  "an owner whose user is gone does not count as the last owner",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      // The membership has to outlive the user, so the reference goes first.
      await ctx.client.query(
        "ALTER TABLE kith.space_members DROP CONSTRAINT space_members_user_id_fkey",
      );
      await ctx.client.query(
        "ALTER TABLE kith.spaces DROP CONSTRAINT brain_spaces_created_by_fkey",
      );
      const { ownerId, spaceId } = await sharedSpace(ctx);
      const ghostId = await makeUser(ctx);
      await makeMember(ctx, { spaceId, userId: ghostId, role: "owner" });
      // A second owner, so leaving would be allowed if the count were naive.
      assert.equal(
        await refusalCode(() =>
          leaveSharedSpace(ctx, { userId: ownerId, spaceId }),
        ),
        null,
      );
      await makeMember(ctx, { spaceId, userId: ownerId, role: "owner" });
      await ctx.client.query("DELETE FROM kith.users WHERE id = $1", [ghostId]);

      // Two owner rows remain but only one is a live account, so the live one
      // still cannot leave: a space must keep an owner someone can sign in as.
      assert.equal(
        await refusalCode(() =>
          leaveSharedSpace(ctx, { userId: ownerId, spaceId }),
        ),
        "last_owner",
      );
    });
  },
);

test("membership and invitation counts are bounded", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const { ownerId, spaceId } = await sharedSpace(ctx);
    // Fifty members is the cap, and the owner is one of them.
    for (let index = 0; index < 50; index += 1) {
      await makeMember(ctx, {
        spaceId,
        userId: await makeUser(ctx),
        role: "reader",
      });
    }
    assert.equal(
      await refusalCode(() =>
        getFamilySpace(ctx, { userId: ownerId, spaceId }),
      ),
      "member_limit_reached",
    );
  });

  await db.tx(async (ctx) => {
    const { ownerId, spaceId } = await sharedSpace(ctx);
    for (let index = 0; index < 51; index += 1) {
      await ctx.client.query(
        `INSERT INTO kith.family_invitations
           (id, space_id, email_normalized, token_hash, role, status, created_by,
            created_at_field, expires_at)
           VALUES ($1, $2, $3, $4, 'reader', 'open', $5, $6, $7)`,
        [
          newKithId(),
          spaceId,
          `guest${index}@example.test`,
          index.toString(16).padStart(64, "0"),
          ownerId,
          new Date(ctx.now),
          new Date(ctx.now + 60_000),
        ],
      );
    }
    assert.equal(
      await refusalCode(() => activeInvitations(ctx, spaceId, ctx.now)),
      "invitation_limit_reached",
    );
  });
});

test(
  "a shared space cannot be created past the per-user membership bound",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      for (let index = 0; index < 100; index += 1) {
        await makeSpace(ctx, {
          createdBy: userId,
          role: "owner",
          name: `Space ${index}`,
        });
      }
      assert.equal(
        await refusalCode(() =>
          createSharedSpace(ctx, { userId, name: "One too many" }),
        ),
        "member_limit_reached",
      );
      // And a user who is not there cannot create one at all.
      assert.equal(
        await refusalCode(() =>
          createSharedSpace(ctx, { userId: newKithId(), name: "Nobody" }),
        ),
        "not_authenticated",
      );
    });
  },
);
