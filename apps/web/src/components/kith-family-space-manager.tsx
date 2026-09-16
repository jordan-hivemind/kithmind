"use client";

// The PostgreSQL family space manager.
//
// `app/(authenticated)/spaces/page.tsx` loads `overview` from one read-only
// transaction (`loadFamilyOverview`) and passes it down; every action here is
// a `fetch` to `/api/kith/family/*`, followed by `router.refresh()` so the
// next server render re-reads the space in a fresh transaction rather than
// this component guessing the new state.
//
// Person linking (`models/spaces/people`) is not ported -- see the module
// comment on `lib/kith/family-data.ts` -- so the member table has no "Person"
// column here and shows a note instead of silently omitting the gap.

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { FamilyOverview } from "@/lib/kith/family-data";

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

async function requestJson(
  input: string,
  init: RequestInit,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  const response = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, body };
  const message =
    body !== null &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "That change could not be completed.";
  return { ok: false, message };
}

export function KithFamilySpaceManager({ overview }: { overview: FamilyOverview }) {
  const router = useRouter();
  const { spaces, selected, selectedUnavailable } = overview;
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const selectedSpaceId = selected?.space.spaceId;

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError("");
    setCreating(true);
    const result = await requestJson("/api/kith/family/spaces", {
      method: "POST",
      body: JSON.stringify({ name: trimmed }),
    });
    if (result.ok) {
      const created = result.body as { spaceId: string };
      setName("");
      router.push(`/spaces?space=${encodeURIComponent(created.spaceId)}`);
      router.refresh();
    } else {
      setError(result.message);
    }
    setCreating(false);
  }

  return (
    <div>
      <h1>Spaces</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Create a shared family space, invite members, and manage access.
        Creating or joining a shared space does not change your default write
        destination.
      </p>

      <section style={sectionStyle} aria-labelledby="create-space-title">
        <h2 id="create-space-title" style={{ marginTop: 0 }}>
          Create a shared space
        </h2>
        <form
          onSubmit={(event) => void submitCreate(event)}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <label htmlFor="space-name" style={{ flex: "1 1 240px" }}>
            <span style={{ display: "block", marginBottom: 4 }}>Space name</span>
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
            disabled={creating || !name.trim()}
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
        {spaces.length === 0 ? (
          <p>No spaces available.</p>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {spaces.map((space) => (
              <a
                key={space.spaceId}
                href={`/spaces?space=${encodeURIComponent(space.spaceId)}`}
                aria-current={space.spaceId === selectedSpaceId}
                style={{
                  ...buttonStyle,
                  textDecoration: "none",
                  color: "#111",
                  display: "inline-block",
                  borderColor: space.spaceId === selectedSpaceId ? "#0070f3" : "#bbb",
                }}
              >
                {space.name} · {space.kind === "personal" ? "Personal" : space.role}
              </a>
            ))}
          </div>
        )}
      </section>

      {selectedUnavailable && (
        <p role="alert" style={{ color: "#b45309" }}>
          {selectedUnavailable === "member_limit_reached"
            ? "This space has too many members to display right now."
            : "This space has too many pending invitations to display right now."}
        </p>
      )}
      {selected && (
        <SpaceDetail
          key={selected.space.spaceId}
          detail={selected}
          onChanged={() => router.refresh()}
        />
      )}
    </div>
  );
}

function SpaceDetail({
  detail,
  onChanged,
}: {
  detail: NonNullable<FamilyOverview["selected"]>;
  onChanged: () => void;
}) {
  const isOwner = detail.viewer.role === "owner";
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("reader");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function run(
    label: string,
    work: () => ReturnType<typeof requestJson>,
  ) {
    setError("");
    setBusy(label);
    const result = await work();
    if (!result.ok) setError(result.message);
    setBusy("");
    if (result.ok) onChanged();
  }

  async function submitInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy("invite");
    const result = await requestJson("/api/kith/family/invitations", {
      method: "POST",
      body: JSON.stringify({
        spaceId: detail.space.spaceId,
        email: inviteEmail.trim(),
        role: inviteRole,
      }),
    });
    setBusy("");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const created = result.body as { token: string };
    const link = new URL("/invite", window.location.origin);
    link.hash = created.token;
    setInviteLink(link.toString());
    setInviteEmail("");
    onChanged();
  }

  return (
    <section style={sectionStyle} aria-live="polite">
      {error && (
        <p role="alert" style={{ color: "#b42318" }}>
          {error}
        </p>
      )}
      <h2 style={{ marginTop: 0 }}>{detail.space.name}</h2>
      <p>
        Your role: <strong>{detail.viewer.role}</strong>
      </p>
      <p style={{ color: "#666", fontSize: 13 }}>
        Linking a member to a person record is not available on this surface
        yet.
      </p>

      {isOwner && (
        <form onSubmit={(event) => void submitInvite(event)} style={{ ...sectionStyle, marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Invite a member</h3>
          <label htmlFor="invite-email">Email</label>
          <br />
          <input
            id="invite-email"
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            required
            style={{ width: "min(360px, 100%)", padding: 8, margin: "4px 8px 8px 0" }}
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
          <button type="submit" disabled={busy === "invite" || !inviteEmail.trim()} style={buttonStyle}>
            {busy === "invite" ? "Creating..." : "Create invite"}
          </button>
        </form>
      )}
      {inviteLink && (
        <div style={{ ...sectionStyle, background: "#fffbea" }}>
          <strong>Share this secret invite link now.</strong>
          <p style={{ overflowWrap: "anywhere" }}>{inviteLink}</p>
          <button type="button" style={buttonStyle} onClick={() => void navigator.clipboard.writeText(inviteLink)}>
            Copy link
          </button>{" "}
          <button type="button" style={buttonStyle} onClick={() => setInviteLink(null)}>
            Dismiss
          </button>
        </div>
      )}

      <h3>Members</h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th style={{ padding: 8 }}>Member</th>
            <th style={{ padding: 8 }}>Role</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {detail.members.map((member) => (
            <tr key={member.userId} style={{ borderTop: "1px solid #eee" }}>
              <td style={{ padding: 8 }}>{member.email ?? member.name ?? "Account"}</td>
              <td style={{ padding: 8 }}>{member.role}</td>
              <td style={{ padding: 8 }}>
                {isOwner && member.role !== "owner" && (
                  <>
                    <select
                      aria-label={`Role for ${member.email ?? member.name ?? "member"}`}
                      defaultValue={member.role}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        void run("role", () =>
                          requestJson(`/api/kith/family/members/${member.membershipId}`, {
                            method: "PATCH",
                            body: JSON.stringify({ role: event.target.value }),
                          }),
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
                        void run("transfer", () =>
                          requestJson(`/api/kith/family/spaces/${detail.space.spaceId}`, {
                            method: "POST",
                            body: JSON.stringify({
                              action: "transferOwnership",
                              toMembershipId: member.membershipId,
                            }),
                          }),
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
                        void run("remove", () =>
                          requestJson(`/api/kith/family/members/${member.membershipId}`, {
                            method: "DELETE",
                          }),
                        )
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

      {isOwner && (
        <>
          <h3>Invitations</h3>
          {detail.invitations.length === 0 ? (
            <p>No pending invitations.</p>
          ) : (
            detail.invitations.map((invitation) => (
              <div key={invitation.invitationId} style={{ padding: "8px 0", borderTop: "1px solid #eee" }}>
                <strong>{invitation.intendedEmail}</strong> · {invitation.role} · {invitation.status}
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
                        requestJson(`/api/kith/family/invitations/${invitation.invitationId}`, {
                          method: "POST",
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
                      requestJson(`/api/kith/family/invitations/${invitation.invitationId}`, {
                        method: "DELETE",
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

      <button
        type="button"
        style={{ ...buttonStyle, marginTop: 20 }}
        disabled={Boolean(busy)}
        onClick={() =>
          void run("leave", () =>
            requestJson(`/api/kith/family/spaces/${detail.space.spaceId}`, {
              method: "POST",
              body: JSON.stringify({ action: "leave" }),
            }),
          )
        }
      >
        Leave space
      </button>
    </section>
  );
}
