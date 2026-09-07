# Family spaces

Family spaces let independently authenticated accounts share selected Kith
Mind records. The desktop web application is the primary Phase 1 workflow.
Native mobile access is a P2 lane.

## Personal and shared spaces

Every account has a private **Personal** space. Creating or joining a shared
family space does not move, copy, or expose Personal records. A shared space
has explicit memberships and uses the same space boundary for people, facts,
thoughts, source records, and typed observations.

Open **Spaces** to create a shared space and manage its members. The supported
roles are:

| Role   | Access                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------- |
| Owner  | Read and write shared content; invite, approve, revoke, remove, change roles, and transfer ownership |
| Editor | Read and write shared content                                                                        |
| Reader | Read shared content                                                                                  |

Only an owner can manage membership. An owner can make another member an
owner, which changes the original owner to editor, or leave when another live
owner remains. The last owner cannot be removed, demoted, or leave. Removing a
member immediately ends that member's access.

## Inviting an account

1. In **Spaces**, open the shared space as an owner.
2. Enter the invitee's email and choose `Reader` or `Editor`.
3. Create the invitation and copy the secret link immediately. The link is
   shown only at creation time and expires after seven days.
4. The invitee opens the link, signs in or creates an account, and accepts it.
5. The acceptance records the server-authenticated account as
   `pending_owner_approval`. It does not grant access yet.
6. The owner reviews the accepted account in **Invitations** and selects
   **Approve account**.

The current password provider does not prove email ownership. The typed email
is therefore a routing hint. Owner approval is required so the owner confirms
the concrete account that accepted the secret. An invitation can be revoked
while it is open or pending. A shared space supports up to 50 members and up
to 50 active invitations, counting open and pending invitations together.

## Linking people and resolving “me”

In each space, create or select a person record and explicitly link it to a
member in the **Person** column. Names are labels, not identity proof: Kith
Mind never links accounts because names match. A person link belongs to its
space, and the same family member can have a different person record in
Personal and in a shared space.

The `me` reference resolves only through the authenticated member's explicit
link in the selected space. If the link is missing, setup must be completed;
Kith Mind does not guess. Owners manage links for shared-space members. An
account can manage its own Personal link. Each space supports up to 100 people.

## Default write destination

Open **Settings** and choose **Default write destination**. Destination-less
writes resolve in this order: an explicitly supplied authorized space, the
configured writable default, then Personal when no default is configured.
Joining or creating a shared space never selects it automatically, and legacy
writes are not silently shared.

If a configured destination becomes stale or is no longer writable, writes
return an error and Settings shows **Reset to Personal**. Reset the setting or
choose another writable space before creating destination-less content.

## Source accounts and API keys

Settings can register an MCP client source for a selected writable space. This
records a stable connector/account identity and freshness policy. It does not
fetch, poll, or connect to the source; automatic connectors are not available
in Phase 1.

When generating an API key, select its spaces and capabilities:

- `read` permits reads where the current membership is reader, editor, or
  owner.
- `write` permits content changes where the current membership is editor or
  owner.
- `ingest` permits ingestion only for the selected enabled source accounts.

The effective grant is the intersection of the key's capability and space
scopes with the account's current membership. Revoking a key, changing a role,
removing membership, or changing scopes takes effect on the next operation.
Disabling a source account prevents new ingestion; authorized reads of retained
content remain available. An ingest key therefore needs both `ingest`, a
granted writable space, and one or more enabled source accounts in those
spaces. Source accounts and keys are configuration only; real connector
polling and automated ingestion are Phase 2 work.

## Current limits and product boundary

The current supported limits are 50 members per shared space, 50 active
invitations per shared space, and 100 people per space. Desktop is the primary
Phase 1 surface. Native mobile validation is P2. Phase 1 supports bounded
inline text capture and the family, people, destination, source-identity, and
key-scope controls described here. It does not yet provide automatic
connectors, polling, URL fetching, OCR, model extraction, or bulk backfill.

### OAuth and credential management

OAuth consent creates a temporary grant. It becomes an active credential only after the client exchanges the authorization code. Unfinished grants expire after five minutes. Repeating the same pending consent returns the same code; reusing a consumed code is rejected and revokes its associated credential. Start a fresh authorization if a token response was lost.

Settings shows active keys in pages of 25. Use **Load more** to reach older keys; every loaded key can be revoked. Pending grants are not active keys and do not appear in this list. See the [OAuth lifecycle contract](plans/2026-09-07-oauth-lifecycle.md) for limits and deployment behavior.
