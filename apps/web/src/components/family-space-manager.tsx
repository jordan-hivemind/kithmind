"use client";

import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { familyApi, peopleApi } from "@/lib/family-api";

type Role = "editor" | "reader";

const buttonStyle = {
  padding: "7px 12px",
  cursor: "pointer",
  borderRadius: 4,
  border: "1px solid #bbb",
  background: "white",
};
const sectionStyle = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 16,
  marginTop: 20,
};

function messageFor(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = error.data;
    if (
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
    )
      return data.message;
  }
  return fallback;
}

export function FamilySpaceManager() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated } = useConvexAuth();
  const ensurePersonal = useMutation(api.models.spaces.public.ensurePersonal);
  const [ready, setReady] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [setupAttempt, setSetupAttempt] = useState(0);
  const spaces = useQuery(api.models.spaces.public.list, ready ? {} : "skip");
  const createSpace = useMutation(familyApi.createSpace);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const selectedSpaceId = searchParams.get("space");
  const selectedSpace =
    spaces?.find((space) => space.spaceId === selectedSpaceId) ?? null;

  useEffect(() => {
    if (!isAuthenticated) {
      setReady(false);
      return;
    }
    let active = true;
    setSetupError("");
    void ensurePersonal().then(
      () => {
        if (active) setReady(true);
      },
      () => {
        if (active)
          setSetupError(
            "Could not prepare your Personal space. Reload and try again.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [ensurePersonal, isAuthenticated, setupAttempt]);

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError("");
    setCreating(true);
    try {
      const result = await createSpace({ name: trimmed });
      setName("");
      router.replace(`/spaces?space=${encodeURIComponent(result.spaceId)}`);
    } catch (cause) {
      setError(messageFor(cause, "Could not create the shared space."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <h1>Spaces</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Create a shared family space, invite members, and manage access.
        Creating or joining a shared space does not change your default write
        destination.
      </p>
      {setupError && (
        <p role="alert" style={{ color: "#b42318" }}>
          {setupError}{" "}
          <button
            type="button"
            style={buttonStyle}
            onClick={() => setSetupAttempt((attempt) => attempt + 1)}
          >
            Retry
          </button>
        </p>
      )}

      <section style={sectionStyle} aria-labelledby="create-space-title">
        <h2 id="create-space-title" style={{ marginTop: 0 }}>
          Create a shared space
        </h2>
        <form
          onSubmit={submitCreate}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <label htmlFor="space-name" style={{ flex: "1 1 240px" }}>
            <span style={{ display: "block", marginBottom: 4 }}>
              Space name
            </span>
            <input
              id="space-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
              style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
            />
          </label>
          <button
            type="submit"
            disabled={!ready || creating || !name.trim()}
            style={{ ...buttonStyle, alignSelf: "end" }}
          >
            {creating ? "Creating..." : "Create space"}
          </button>
        </form>
        {error && (
          <p role="alert" style={{ color: "#b42318" }}>
            {error}
          </p>
        )}
      </section>

      <section style={sectionStyle} aria-labelledby="your-spaces-title">
        <h2 id="your-spaces-title" style={{ marginTop: 0 }}>
          Your spaces
        </h2>
        {!ready ? (
          <p>Preparing your Personal space...</p>
        ) : spaces === undefined ? (
          <p>Loading spaces...</p>
        ) : spaces.length === 0 ? (
          <p>No spaces available.</p>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {spaces.map((space) => (
              <button
                key={space.spaceId}
                type="button"
                onClick={() =>
                  router.replace(
                    `/spaces?space=${encodeURIComponent(space.spaceId)}`,
                  )
                }
                aria-pressed={space.spaceId === selectedSpaceId}
                style={{
                  ...buttonStyle,
                  borderColor:
                    space.spaceId === selectedSpaceId ? "#0070f3" : "#bbb",
                }}
              >
                {space.name} ·{" "}
                {space.kind === "personal" ? "Personal" : space.role}
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedSpace && (
        <SpaceDetails
          key={selectedSpace.spaceId}
          spaceId={selectedSpace.spaceId}
          kind={selectedSpace.kind}
        />
      )}
    </div>
  );
}

function SpaceDetails({
  spaceId,
  kind,
}: {
  spaceId: Id<"spaces">;
  kind: "personal" | "shared";
}) {
  const detail = useQuery(
    familyApi.getSpace,
    kind === "shared" ? { spaceId } : "skip",
  );
  const people = useQuery(peopleApi.list, { spaceId });
  const createInvitation = useAction(familyApi.createInvitation);
  const approveInvitation = useMutation(familyApi.approveInvitation);
  const revokeInvitation = useMutation(familyApi.revokeInvitation);
  const changeMemberRole = useMutation(familyApi.changeMemberRole);
  const removeMember = useMutation(familyApi.removeMember);
  const leaveSpace = useMutation(familyApi.leaveSpace);
  const transferOwnership = useMutation(familyApi.transferOwnership);
  const createPerson = useMutation(peopleApi.create);
  const setMemberPerson = useMutation(peopleApi.setMemberPerson);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("reader");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [personName, setPersonName] = useState("");
  const [personRequestId, setPersonRequestId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const members =
    kind === "shared"
      ? detail?.members.map((member) => ({
          ...member,
          personEntityId: people?.members.find(
            (personMember) => personMember.userId === member.userId,
          )?.personEntityId,
        }))
      : people?.members;
  const isOwner = kind === "shared" && detail?.viewer.role === "owner";

  async function run(label: string, operation: () => Promise<unknown>) {
    setError("");
    setBusy(label);
    try {
      await operation();
    } catch (cause) {
      setError(messageFor(cause, "That change could not be completed."));
    } finally {
      setBusy("");
    }
  }

  async function submitInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("invite", async () => {
      const result = await createInvitation({
        spaceId,
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      const link = new URL("/invite", window.location.origin);
      link.hash = result.token;
      setInviteLink(link.toString());
      setInviteEmail("");
    });
  }

  return (
    <section style={sectionStyle} aria-live="polite">
      {error && (
        <p role="alert" style={{ color: "#b42318" }}>
          {error}
        </p>
      )}
      {kind === "shared" && detail === undefined && <p>Loading members...</p>}
      {kind === "shared" && detail && (
        <>
          <h2 style={{ marginTop: 0 }}>{detail.space.name}</h2>
          <p>
            Your role: <strong>{detail.viewer.role}</strong>
          </p>
          {isOwner && (
            <form
              onSubmit={submitInvite}
              style={{ ...sectionStyle, marginTop: 12 }}
            >
              <h3 style={{ marginTop: 0 }}>Invite a member</h3>
              <label htmlFor="invite-email">Email</label>
              <br />
              <input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                required
                style={{
                  width: "min(360px, 100%)",
                  padding: 8,
                  margin: "4px 8px 8px 0",
                }}
              />
              <label htmlFor="invite-role">Role</label>{" "}
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as Role)}
                style={{ padding: 8, marginRight: 8 }}
              >
                <option value="reader">Reader</option>
                <option value="editor">Editor</option>
              </select>
              <button
                type="submit"
                disabled={busy === "invite" || !inviteEmail.trim()}
                style={buttonStyle}
              >
                {busy === "invite" ? "Creating..." : "Create invite"}
              </button>
            </form>
          )}
          {inviteLink && (
            <div style={{ ...sectionStyle, background: "#fffbea" }}>
              <strong>Share this secret invite link now.</strong>
              <p style={{ overflowWrap: "anywhere" }}>{inviteLink}</p>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => void navigator.clipboard.writeText(inviteLink)}
              >
                Copy link
              </button>{" "}
              <button
                type="button"
                style={buttonStyle}
                onClick={() => setInviteLink(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          <h3>Members</h3>
        </>
      )}
      {kind === "personal" && (
        <>
          <h2 style={{ marginTop: 0 }}>Personal space</h2>
          <p>Link your account to a person record to use “me” in this space.</p>
          <h3>Members</h3>
        </>
      )}
      {members === undefined ? (
        <p>Loading people...</p>
      ) : (
        <MemberTable
          members={members}
          people={people?.people ?? []}
          canManage={Boolean(people?.canManageLinks)}
          isOwner={Boolean(isOwner)}
          busy={busy}
          onRun={run}
          onChangeRole={(membershipId, role) =>
            changeMemberRole({ membershipId, role })
          }
          onRemove={(membershipId) => removeMember({ membershipId })}
          onTransfer={(membershipId) =>
            transferOwnership({ spaceId, toMembershipId: membershipId })
          }
          onSetPerson={(userId, personEntityId) =>
            setMemberPerson({ spaceId, userId, personEntityId })
          }
        />
      )}
      {kind === "shared" && detail && isOwner && (
        <>
          <h3>Invitations</h3>
          {detail.invitations.length === 0 ? (
            <p>No pending invitations.</p>
          ) : (
            detail.invitations.map((invitation) => (
              <div
                key={invitation.invitationId}
                style={{ padding: "8px 0", borderTop: "1px solid #eee" }}
              >
                <strong>{invitation.intendedEmail}</strong> · {invitation.role}{" "}
                · {invitation.status}
                {invitation.acceptedUser && (
                  <>
                    {" "}
                    · accepted by{" "}
                    {invitation.acceptedUser.email ??
                      invitation.acceptedUser.name ??
                      invitation.acceptedUser.userId}
                  </>
                )}
                <br />
                {invitation.status === "pending_owner_approval" && (
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run("approve", () =>
                        approveInvitation({
                          invitationId: invitation.invitationId,
                        }),
                      )
                    }
                  >
                    Approve account
                  </button>
                )}{" "}
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run("revoke", () =>
                      revokeInvitation({
                        invitationId: invitation.invitationId,
                      }),
                    )
                  }
                >
                  Revoke
                </button>
              </div>
            ))
          )}
        </>
      )}
      {kind === "shared" && detail && (
        <button
          type="button"
          style={{ ...buttonStyle, marginTop: 20 }}
          disabled={Boolean(busy)}
          onClick={() => void run("leave", () => leaveSpace({ spaceId }))}
        >
          Leave space
        </button>
      )}
      {people?.canCreatePeople && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run("person", async () => {
              const requestId = personRequestId ?? crypto.randomUUID();
              setPersonRequestId(requestId);
              await createPerson({
                spaceId,
                name: personName.trim(),
                requestId,
              });
              setPersonName("");
              setPersonRequestId(null);
            });
          }}
          style={sectionStyle}
        >
          <h3 style={{ marginTop: 0 }}>Create a person</h3>
          <label htmlFor="person-name">Name</label>
          <br />
          <input
            id="person-name"
            value={personName}
            onChange={(event) => {
              setPersonName(event.target.value);
              setPersonRequestId(null);
            }}
            required
            style={{ padding: 8, margin: "4px 8px 0 0" }}
          />
          <button
            type="submit"
            disabled={busy === "person" || !personName.trim()}
            style={buttonStyle}
          >
            Create person
          </button>
        </form>
      )}
    </section>
  );
}

function MemberTable({
  members,
  people,
  canManage,
  isOwner,
  busy,
  onRun,
  onChangeRole,
  onRemove,
  onTransfer,
  onSetPerson,
}: {
  members: Array<{
    membershipId?: Id<"spaceMembers">;
    userId: Id<"users">;
    name?: string;
    email?: string;
    role?: "owner" | Role;
    personEntityId?: Id<"entities">;
  }>;
  people: Array<{
    entityId: Id<"entities">;
    name: string;
    linkedUserId?: Id<"users">;
  }>;
  canManage: boolean;
  isOwner: boolean;
  busy: string;
  onRun: (label: string, operation: () => Promise<unknown>) => Promise<void>;
  onChangeRole: (
    membershipId: Id<"spaceMembers">,
    role: Role,
  ) => Promise<unknown>;
  onRemove: (membershipId: Id<"spaceMembers">) => Promise<unknown>;
  onTransfer: (membershipId: Id<"spaceMembers">) => Promise<unknown>;
  onSetPerson: (
    userId: Id<"users">,
    personEntityId?: Id<"entities">,
  ) => Promise<unknown>;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left" }}>
          <th style={{ padding: 8 }}>Member</th>
          <th style={{ padding: 8 }}>Role</th>
          <th style={{ padding: 8 }}>Person</th>
          <th style={{ padding: 8 }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {members.map((member) => (
          <tr key={member.userId} style={{ borderTop: "1px solid #eee" }}>
            <td style={{ padding: 8 }}>
              {member.email ?? member.name ?? "Account"}
            </td>
            <td style={{ padding: 8 }}>{member.role ?? "owner"}</td>
            <td style={{ padding: 8 }}>
              {canManage ? (
                <select
                  aria-label={`Person for ${member.email ?? member.name ?? "member"}`}
                  value={member.personEntityId ?? ""}
                  disabled={Boolean(busy)}
                  onChange={(event) => {
                    const personEntityId = people.find(
                      (person) => person.entityId === event.target.value,
                    )?.entityId;
                    void onRun("person-link", () =>
                      onSetPerson(member.userId, personEntityId),
                    );
                  }}
                >
                  <option value="">Not linked</option>
                  {people.map((person) => (
                    <option key={person.entityId} value={person.entityId}>
                      {person.name}
                      {person.linkedUserId &&
                      person.linkedUserId !== member.userId
                        ? " (linked)"
                        : ""}
                    </option>
                  ))}
                </select>
              ) : (
                (people.find(
                  (person) => person.entityId === member.personEntityId,
                )?.name ?? "Not linked")
              )}
            </td>
            <td style={{ padding: 8 }}>
              {isOwner && member.membershipId && member.role !== "owner" && (
                <>
                  <select
                    aria-label={`Role for ${member.email ?? member.name ?? "member"}`}
                    value={member.role}
                    disabled={Boolean(busy)}
                    onChange={(event) =>
                      void onRun("role", () =>
                        onChangeRole(
                          member.membershipId!,
                          event.target.value as Role,
                        ),
                      )
                    }
                  >
                    <option value="reader">Reader</option>
                    <option value="editor">Editor</option>
                  </select>{" "}
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void onRun("transfer", () =>
                        onTransfer(member.membershipId!),
                      )
                    }
                  >
                    Make owner
                  </button>{" "}
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void onRun("remove", () => onRemove(member.membershipId!))
                    }
                  >
                    Remove
                  </button>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
