"use client";

// The spaces page: the caller's spaces, and for a selected shared space its
// members and (for its owner) pending invitations.
//
// `app/(authenticated)/spaces/page.tsx` loads `overview` from one read-only
// transaction. Every action is a `fetch` to the same `/api/kith/family/*`
// route as before, each of which reloads the session and checks the caller's
// role for itself. The tables change at once and roll back with a toast if the
// route refuses (`useOptimisticMutation`), then resync from the server render.
// A membership change from elsewhere arrives through the change feed
// (`space_members`, migration 024). Invitations are deliberately not in the
// feed, so an acceptance shows up on the next action or visit.
//
// Person linking is not ported (see `lib/kith/family-data.ts`), so there is no
// Person column.

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  Button,
  ErrorText,
  Field,
  inputClass,
  linkClass,
  PageHeader,
  Panel,
  Section,
} from "@/components/ui/controls";
import { CopyButton } from "@/components/ui/copy-button";
import { DataTable, Detail, type RowAction, Tag } from "@/components/ui/data-table";
import type { FamilyOverview } from "@/lib/kith/family-data";
import { shortDate } from "@/lib/kith/format";
import { isPendingId, mutateJson, pendingId, requestJson } from "@/lib/kith/optimistic";
import { useOptimisticMutation, useServerData } from "@/lib/kith/use-server-data";

type Role = "editor" | "reader";
type SpaceView = NonNullable<FamilyOverview["selected"]>;
type SpaceRow = FamilyOverview["spaces"][number];
type MemberRow = SpaceView["members"][number] & { who: string };
type InvitationRow = SpaceView["invitations"][number] & { acceptedBy: string };

const LIVE_TABLES = ["space_members"] as const;

const FAILED = "That change could not be completed.";

/** Applies `change` to the selected space's detail, if there is one. */
function withSelected(
  current: FamilyOverview,
  change: (detail: SpaceView) => SpaceView,
): FamilyOverview {
  return current.selected === null
    ? current
    : { ...current, selected: change(current.selected) };
}

export function KithFamilySpaceManager({ overview: server }: { overview: FamilyOverview }) {
  const router = useRouter();
  const selectedSpaceId = server.selected?.space.spaceId ?? null;
  const queryKey = ["spaces", selectedSpaceId];
  const overview = useServerData<FamilyOverview>(queryKey, server, LIVE_TABLES);
  const { spaces, selected, selectedUnavailable } = overview;
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const create = useOptimisticMutation<FamilyOverview, SpaceRow>({
    queryKey,
    mutationFn: (row) =>
      mutateJson(
        "/api/kith/family/spaces",
        { method: "POST", body: JSON.stringify({ name: row.name }) },
        FAILED,
      ),
    apply: (current, row) => ({ ...current, spaces: [...current.spaces, row] }),
    onSuccess: (result) => {
      const created = result as { spaceId: string };
      router.push(`/spaces?space=${encodeURIComponent(created.spaceId)}`);
    },
  });

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate({ spaceId: pendingId(), name: trimmed, kind: "shared", role: "owner" });
    setName("");
    setCreating(false);
  }

  const columns = useMemo<ColumnDef<SpaceRow, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Space",
        cell: ({ row }) =>
          isPendingId(row.original.spaceId) || row.original.kind === "personal" ? (
            <span>{row.original.name}</span>
          ) : (
            <Link
              href={`/spaces?space=${encodeURIComponent(row.original.spaceId)}`}
              aria-current={row.original.spaceId === selectedSpaceId ? "page" : undefined}
              className={`${linkClass} ${row.original.spaceId === selectedSpaceId ? "font-semibold" : ""}`}
            >
              {row.original.name}
            </Link>
          ),
      },
      {
        id: "kind",
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => <Tag>{row.original.kind}</Tag>,
      },
      {
        id: "role",
        accessorKey: "role",
        header: "Your role",
        cell: ({ row }) => (
          <Tag tone={row.original.role === "owner" ? "accent" : "neutral"}>
            {row.original.role}
          </Tag>
        ),
      },
    ],
    [selectedSpaceId],
  );

  const actions = useMemo<RowAction<SpaceRow>[]>(
    () => [
      {
        label: "Open",
        disabled: (row) => isPendingId(row.spaceId) || row.kind === "personal",
        onSelect: (row) => router.push(`/spaces?space=${encodeURIComponent(row.spaceId)}`),
      },
    ],
    [router],
  );

  return (
    <div>
      <PageHeader title="Spaces">
        <Button variant="primary" onClick={() => setCreating((open) => !open)}>
          {creating ? "Close" : "New space"}
        </Button>
      </PageHeader>

      {creating && (
        <Panel>
          <form onSubmit={submitCreate} className="flex flex-wrap items-end gap-2">
            <Field label="Space name" htmlFor="space-name">
              <input
                id="space-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
                className={`${inputClass} w-64`}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              Create space
            </Button>
          </form>
        </Panel>
      )}

      <div className="mb-8">
        <DataTable
          data={spaces}
          columns={columns}
          actions={actions}
          filterColumns={["kind", "role"]}
          initialSorting={[{ id: "name", desc: false }]}
          searchPlaceholder="Search spaces"
          empty="No spaces"
        />
      </div>

      {selectedUnavailable && (
        <p role="alert" className="mb-4 text-xs text-red-700">
          {selectedUnavailable === "member_limit_reached"
            ? "This space has too many members to display right now."
            : "This space has too many pending invitations to display right now."}
        </p>
      )}
      {selected && (
        <SpaceDetail
          key={selected.space.spaceId}
          detail={selected}
          queryKey={queryKey}
        />
      )}
    </div>
  );
}

function SpaceDetail({
  detail,
  queryKey,
}: {
  detail: SpaceView;
  queryKey: readonly unknown[];
}) {
  const router = useRouter();
  const isOwner = detail.viewer.role === "owner";
  const spaceId = detail.space.spaceId;
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("reader");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState("");
  const [sending, setSending] = useState(false);

  const setRole = useOptimisticMutation<FamilyOverview, { membershipId: string; role: Role }>({
    queryKey,
    mutationFn: ({ membershipId, role }) =>
      mutateJson(
        `/api/kith/family/members/${membershipId}`,
        { method: "PATCH", body: JSON.stringify({ role }) },
        FAILED,
      ),
    apply: (current, { membershipId, role }) =>
      withSelected(current, (space) => ({
        ...space,
        members: space.members.map((member) =>
          member.membershipId === membershipId ? { ...member, role } : member,
        ),
      })),
  });

  const remove = useOptimisticMutation<FamilyOverview, string>({
    queryKey,
    mutationFn: (membershipId) =>
      mutateJson(`/api/kith/family/members/${membershipId}`, { method: "DELETE" }, FAILED),
    apply: (current, membershipId) =>
      withSelected(current, (space) => ({
        ...space,
        members: space.members.filter((member) => member.membershipId !== membershipId),
      })),
  });

  // The previous owner becomes an editor (`identity/family.ts`).
  const transfer = useOptimisticMutation<FamilyOverview, string>({
    queryKey,
    mutationFn: (membershipId) =>
      mutateJson(
        `/api/kith/family/spaces/${spaceId}`,
        {
          method: "POST",
          body: JSON.stringify({ action: "transferOwnership", toMembershipId: membershipId }),
        },
        FAILED,
      ),
    apply: (current, membershipId) =>
      withSelected(current, (space) => ({
        ...space,
        viewer: { ...space.viewer, role: "editor" },
        members: space.members.map((member) =>
          member.membershipId === membershipId
            ? { ...member, role: "owner" }
            : member.membershipId === space.viewer.membershipId
              ? { ...member, role: "editor" }
              : member,
        ),
      })),
  });

  // An approved invitation leaves the pending list; the new member arrives
  // with the resync.
  const approve = useOptimisticMutation<FamilyOverview, string>({
    queryKey,
    mutationFn: (invitationId) =>
      mutateJson(`/api/kith/family/invitations/${invitationId}`, { method: "POST" }, FAILED),
    apply: (current, invitationId) =>
      withSelected(current, (space) => ({
        ...space,
        invitations: space.invitations.filter(
          (invitation) => invitation.invitationId !== invitationId,
        ),
      })),
  });

  const revoke = useOptimisticMutation<FamilyOverview, string>({
    queryKey,
    mutationFn: (invitationId) =>
      mutateJson(`/api/kith/family/invitations/${invitationId}`, { method: "DELETE" }, FAILED),
    apply: (current, invitationId) =>
      withSelected(current, (space) => ({
        ...space,
        invitations: space.invitations.filter(
          (invitation) => invitation.invitationId !== invitationId,
        ),
      })),
  });

  const leave = useOptimisticMutation<FamilyOverview, void>({
    queryKey,
    mutationFn: () =>
      mutateJson(
        `/api/kith/family/spaces/${spaceId}`,
        { method: "POST", body: JSON.stringify({ action: "leave" }) },
        FAILED,
      ),
    apply: (current) => ({
      ...current,
      spaces: current.spaces.filter((space) => space.spaceId !== spaceId),
      selected: null,
    }),
    onSuccess: () => router.push("/spaces"),
  });

  // Not optimistic: the secret link only exists once the route has answered.
  async function submitInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviteError("");
    setSending(true);
    const result = await requestJson(
      "/api/kith/family/invitations",
      {
        method: "POST",
        body: JSON.stringify({ spaceId, email: inviteEmail.trim(), role: inviteRole }),
      },
      FAILED,
    );
    setSending(false);
    if (!result.ok) {
      setInviteError(result.message);
      return;
    }
    const created = result.body as { token: string };
    const link = new URL("/invite", window.location.origin);
    link.hash = created.token;
    setInviteLink(link.toString());
    setInviteEmail("");
    setInviting(false);
    router.refresh();
  }

  const members = useMemo<MemberRow[]>(
    () =>
      detail.members.map((member) => ({
        ...member,
        who: member.email ?? member.name ?? "Account",
      })),
    [detail.members],
  );

  const invitations = useMemo<InvitationRow[]>(
    () =>
      detail.invitations.map((invitation) => ({
        ...invitation,
        acceptedBy: invitation.acceptedUser
          ? (invitation.acceptedUser.email ??
            invitation.acceptedUser.name ??
            invitation.acceptedUser.userId)
          : "",
      })),
    [detail.invitations],
  );

  const memberColumns = useMemo<ColumnDef<MemberRow, unknown>[]>(
    () => [
      { id: "who", accessorKey: "who", header: "Member" },
      {
        id: "role",
        accessorKey: "role",
        header: "Role",
        cell: ({ row }) => (
          <Tag tone={row.original.role === "owner" ? "accent" : "neutral"}>
            {row.original.role}
          </Tag>
        ),
      },
    ],
    [],
  );

  const memberActions = useMemo<RowAction<MemberRow>[]>(() => {
    if (!isOwner) return [];
    const isOwnerRow = (member: MemberRow) => member.role === "owner";
    return [
      {
        label: "Make editor",
        disabled: (member) => isOwnerRow(member) || member.role === "editor",
        onSelect: (member) =>
          setRole.mutate({ membershipId: member.membershipId, role: "editor" }),
      },
      {
        label: "Make reader",
        disabled: (member) => isOwnerRow(member) || member.role === "reader",
        onSelect: (member) =>
          setRole.mutate({ membershipId: member.membershipId, role: "reader" }),
      },
      {
        label: "Make owner",
        disabled: isOwnerRow,
        onSelect: (member) => transfer.mutate(member.membershipId),
      },
      {
        label: "Remove",
        disabled: isOwnerRow,
        onSelect: (member) => remove.mutate(member.membershipId),
      },
    ];
  }, [isOwner, setRole, transfer, remove]);

  const invitationColumns = useMemo<ColumnDef<InvitationRow, unknown>[]>(
    () => [
      { id: "intendedEmail", accessorKey: "intendedEmail", header: "Email" },
      {
        id: "role",
        accessorKey: "role",
        header: "Role",
        cell: ({ row }) => <Tag>{row.original.role}</Tag>,
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Tag tone={row.original.status === "pending_owner_approval" ? "warn" : "neutral"}>
            {row.original.status === "pending_owner_approval" ? "needs approval" : "open"}
          </Tag>
        ),
      },
      {
        id: "acceptedBy",
        accessorKey: "acceptedBy",
        header: "Accepted by",
        cell: ({ row }) =>
          row.original.acceptedBy ? (
            <Detail
              label={row.original.acceptedBy}
              detail={row.original.acceptedAt ? `Accepted ${shortDate(row.original.acceptedAt)}` : null}
            />
          ) : null,
      },
      {
        id: "expiresAt",
        accessorKey: "expiresAt",
        header: "Expires",
        cell: ({ row }) => (
          <span className="text-gray-600 tabular-nums">{shortDate(row.original.expiresAt)}</span>
        ),
      },
    ],
    [],
  );

  const invitationActions = useMemo<RowAction<InvitationRow>[]>(
    () => [
      {
        label: "Approve account",
        disabled: (invitation) => invitation.status !== "pending_owner_approval",
        onSelect: (invitation) => approve.mutate(invitation.invitationId),
      },
      {
        label: "Revoke",
        onSelect: (invitation) => revoke.mutate(invitation.invitationId),
      },
    ],
    [approve, revoke],
  );

  return (
    <div>
      <Section
        id="space-detail"
        title={
          <span className="flex items-center gap-2">
            {detail.space.name}
            <Tag tone="accent">{detail.viewer.role}</Tag>
          </span>
        }
        actions={
          <>
            {isOwner && (
              <Button variant="primary" onClick={() => setInviting((open) => !open)}>
                {inviting ? "Close" : "Invite"}
              </Button>
            )}
            <Button variant="danger" onClick={() => leave.mutate()}>
              Leave space
            </Button>
          </>
        }
      >
        {inviting && (
          <Panel>
            <form
              onSubmit={(event) => void submitInvite(event)}
              className="flex flex-wrap items-end gap-2"
            >
              <Field label="Email" htmlFor="invite-email">
                <input
                  id="invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  required
                  className={`${inputClass} w-64`}
                />
              </Field>
              <Field label="Role" htmlFor="invite-role">
                <select
                  id="invite-role"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as Role)}
                  className={inputClass}
                >
                  <option value="reader">Reader</option>
                  <option value="editor">Editor</option>
                </select>
              </Field>
              <Button type="submit" variant="primary" disabled={sending || !inviteEmail.trim()}>
                {sending ? "Creating..." : "Create invite"}
              </Button>
            </form>
            <ErrorText>{inviteError}</ErrorText>
          </Panel>
        )}
        {inviteLink && (
          <Panel tone="accent">
            <div className="mb-2 text-xs font-medium">Secret invite link. Share it now.</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-tag border border-accent-200 bg-white px-2 py-1 font-mono text-[11px] break-all">
                {inviteLink}
              </code>
              <CopyButton text={inviteLink} label="Copy link" />
              <Button onClick={() => setInviteLink(null)}>Dismiss</Button>
            </div>
          </Panel>
        )}
        <h3 className="mb-1 text-xs font-semibold text-gray-700">Members</h3>
        <DataTable
          data={members}
          columns={memberColumns}
          actions={memberActions}
          filterColumns={["role"]}
          initialSorting={[{ id: "who", desc: false }]}
          searchPlaceholder="Search members"
          empty="No members"
        />
        {isOwner && (
          <>
            <h3 className="mt-6 mb-1 text-xs font-semibold text-gray-700">Invitations</h3>
            <DataTable
              data={invitations}
              columns={invitationColumns}
              actions={invitationActions}
              filterColumns={["status", "role"]}
              initialSorting={[{ id: "expiresAt", desc: false }]}
              searchPlaceholder="Search invitations"
              empty="No pending invitations"
            />
          </>
        )}
      </Section>
    </div>
  );
}
