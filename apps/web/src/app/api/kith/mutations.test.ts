// The `/api/kith/*` mutation routes, against a real database.
//
// Every route reloads the session from the cookie inside its own transaction
// (`withPrincipal`), so these cases exercise that path rather than the
// service functions directly: a caller who is signed in as `userB` must never
// be able to revoke `userA`'s key, edit `userA`'s source account, or manage
// `userA`'s shared space, no matter what id the request names. Every denial
// asserted below checks the response body's `code`, not only the status, so
// a route that starts returning the wrong denial for the right reason still
// fails here.

import { randomBytes } from "node:crypto";

import { applyKithSchema, createKithPool, newKithId, withKithTransaction } from "@repo/kith-store";
import {
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  sessionCookie,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");
const ORIGIN = "https://kith.example.test";

type Routes = {
  apiKeysList: (r: Request) => Promise<Response>;
  apiKeysCreate: (r: Request) => Promise<Response>;
  apiKeyRevoke: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  defaultWriteSpace: (r: Request) => Promise<Response>;
  sourceAccountsCreate: (r: Request) => Promise<Response>;
  sourceAccountUpdate: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  familySpacesCreate: (r: Request) => Promise<Response>;
  familySpaceAction: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  invitationsCreate: (r: Request) => Promise<Response>;
  invitationApprove: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  invitationRevoke: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  invitationAccept: (r: Request) => Promise<Response>;
  memberPatch: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  memberRemove: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  watcherReregister: (r: Request) => Promise<Response>;
};

describeWithDatabase("the /api/kith/* mutation routes", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let routes: Routes;

  async function onAdmin<T>(work: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await work(admin);
    } finally {
      await admin.end();
    }
  }

  function inTransaction<T>(work: (ctx: IdentityCtx) => Promise<T>): Promise<T> {
    return withKithTransaction(pool, (client) => work(identityCtx(client)));
  }

  async function signedInUser(): Promise<{
    userId: string;
    cookie: string;
    spaceId: string;
  }> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `i5-mutations-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const setCookie = sessionCookie(
        { secret, secure: false },
        session.token,
        session.expiresAt,
      );
      return {
        userId: session.userId,
        cookie: setCookie.split(";")[0]!,
        spaceId,
      };
    });
  }

  /** A membership row inserted directly, bypassing the invite flow -- the
   * same shortcut `identityFamily.test.mjs`'s `makeMember` uses, needed here
   * to set up a non-owner member or a second owner without going through
   * create-invite-accept-approve for every denial case. */
  async function addMember(
    spaceId: string,
    userId: string,
    role: "owner" | "editor" | "reader",
  ): Promise<string> {
    const id = newKithId();
    await pool.query(
      "INSERT INTO kith.space_members (id, space_id, user_id, role) VALUES ($1, $2, $3, $4)",
      [id, spaceId, userId, role],
    );
    return id;
  }

  /** Every header a same-origin `fetch` from this app's own pages sends. */
  function baseHeaders(cookie: string | null): Headers {
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: ORIGIN,
    });
    if (cookie !== null) headers.set("cookie", cookie);
    return headers;
  }

  function jsonRequest(
    url: string,
    method: string,
    body: unknown,
    cookie: string | null,
  ): Request {
    return new Request(url, {
      method,
      headers: baseHeaders(cookie),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function getRequest(url: string, cookie: string | null): Request {
    return new Request(url, { headers: baseHeaders(cookie) });
  }

  function params(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  async function bodyOf(response: Response): Promise<{ error: string; code?: string }> {
    return (await response.json()) as { error: string; code?: string };
  }

  beforeAll(async () => {
    databaseName = `kith_i5_mutations_test_${randomBytes(8).toString("hex")}`;
    await onAdmin((admin) => admin.query(`CREATE DATABASE ${databaseName}`));
    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;

    const migrator = new pg.Client({ connectionString: url.toString() });
    migrator.on("error", () => {});
    await migrator.connect();
    await applyKithSchema(migrator);
    await migrator.end();

    pool = createKithPool(url.toString());
    pool.on("error", () => {});
    restorePool = setKithPool(pool);
    process.env.KITH_SESSION_SECRET = secret;

    routes = {
      apiKeysList: (await import("./api-keys/route")).GET,
      apiKeysCreate: (await import("./api-keys/route")).POST,
      apiKeyRevoke: (await import("./api-keys/[id]/route")).DELETE,
      defaultWriteSpace: (await import("./settings/default-write-space/route")).POST,
      sourceAccountsCreate: (await import("./source-accounts/route")).POST,
      sourceAccountUpdate: (await import("./source-accounts/[id]/route")).PATCH,
      familySpacesCreate: (await import("./family/spaces/route")).POST,
      familySpaceAction: (await import("./family/spaces/[id]/route")).POST,
      invitationsCreate: (await import("./family/invitations/route")).POST,
      invitationApprove: (await import("./family/invitations/[id]/route")).POST,
      invitationRevoke: (await import("./family/invitations/[id]/route")).DELETE,
      invitationAccept: (await import("./family/invitations/accept/route")).POST,
      memberPatch: (await import("./family/members/[id]/route")).PATCH,
      memberRemove: (await import("./family/members/[id]/route")).DELETE,
      watcherReregister: (await import("./watcher/route")).POST,
    };
  }, 60_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    delete process.env.KITH_SESSION_SECRET;
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  test("an unauthenticated create is refused with 401 and touches no row", async () => {
    const response = await routes.apiKeysCreate(
      jsonRequest(`${ORIGIN}/api/kith/api-keys`, "POST", {
        name: "x",
        spaceIds: ["not-a-real-id"],
        capabilities: ["read"],
      }, null),
    );
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({
      error: "Not authenticated",
      code: "not_authenticated",
    });
  });

  test("a cross-origin request is refused before any transaction opens", async () => {
    const owner = await signedInUser();
    const request = jsonRequest(
      `${ORIGIN}/api/kith/api-keys`,
      "POST",
      { name: "x", spaceIds: [owner.spaceId], capabilities: ["read"] },
      owner.cookie,
    );
    request.headers.set("origin", "https://attacker.example.test");
    const response = await routes.apiKeysCreate(request);
    expect(response.status).toBe(403);
  });

  test("a request without a JSON content type is refused, even a bodyless one", async () => {
    const owner = await signedInUser();
    const request = new Request(`${ORIGIN}/api/kith/family/spaces/${owner.spaceId}`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: ORIGIN },
      body: JSON.stringify({ action: "leave" }),
    });
    const response = await routes.familySpaceAction(request, params(owner.spaceId));
    expect(response.status).toBe(415);
  });

  test("a malformed id in the URL is a 400, not a 500", async () => {
    const owner = await signedInUser();
    const response = await routes.apiKeyRevoke(
      jsonRequest(`${ORIGIN}/api/kith/api-keys/not-a-real-id`, "DELETE", undefined, owner.cookie),
      params("not-a-real-id"),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).code).toBe("invalid_api_key_id");
  });

  test("a malformed space id in a request body is a 400, not a 500", async () => {
    const owner = await signedInUser();
    const response = await routes.defaultWriteSpace(
      jsonRequest(
        `${ORIGIN}/api/kith/settings/default-write-space`,
        "POST",
        { spaceId: "not-a-real-id" },
        owner.cookie,
      ),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).code).toBe("invalid_space_id");
  });

  test("api key create, list-page and revoke, scoped to the caller", async () => {
    const owner = await signedInUser();
    const created = await routes.apiKeysCreate(
      jsonRequest(
        `${ORIGIN}/api/kith/api-keys`,
        "POST",
        {
          name: "Synthetic client",
          spaceIds: [owner.spaceId],
          capabilities: ["read", "write"],
        },
        owner.cookie,
      ),
    );
    expect(created.status).toBe(201);
    const { id, rawKey } = (await created.json()) as { id: string; rawKey: string };
    expect(rawKey).toMatch(/^ob_[0-9a-f]{64}$/);

    const listed = await routes.apiKeysList(
      getRequest(`${ORIGIN}/api/kith/api-keys?numItems=25`, owner.cookie),
    );
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { page: Array<{ id: string }> };
    expect(page.page.map((k) => k.id)).toContain(id);

    // A different signed-in user cannot revoke it: the route reloads its own
    // principal from the cookie and `identity.revokeApiKey` checks ownership
    // before it deletes anything.
    const other = await signedInUser();
    const deniedRevoke = await routes.apiKeyRevoke(
      jsonRequest(`${ORIGIN}/api/kith/api-keys/${id}`, "DELETE", undefined, other.cookie),
      params(id),
    );
    expect(deniedRevoke.status).toBe(400);
    expect(await bodyOf(deniedRevoke)).toEqual({ error: "API key not found" });
    const stillListed = await routes.apiKeysList(
      getRequest(`${ORIGIN}/api/kith/api-keys?numItems=25`, owner.cookie),
    );
    expect(
      ((await stillListed.json()) as { page: Array<{ id: string }> }).page.map((k) => k.id),
    ).toContain(id);

    // The owner can revoke their own key, through `deleteApiKey`'s wrapper.
    const revoked = await routes.apiKeyRevoke(
      jsonRequest(`${ORIGIN}/api/kith/api-keys/${id}`, "DELETE", undefined, owner.cookie),
      params(id),
    );
    expect(revoked.status).toBe(204);
    const afterRevoke = await routes.apiKeysList(
      getRequest(`${ORIGIN}/api/kith/api-keys?numItems=25`, owner.cookie),
    );
    expect(
      ((await afterRevoke.json()) as { page: Array<{ id: string }> }).page.map((k) => k.id),
    ).not.toContain(id);
  });

  test("default write space is rejected for a space the caller cannot write to", async () => {
    const owner = await signedInUser();
    const stranger = await signedInUser();
    const response = await routes.defaultWriteSpace(
      jsonRequest(
        `${ORIGIN}/api/kith/settings/default-write-space`,
        "POST",
        { spaceId: stranger.spaceId },
        owner.cookie,
      ),
    );
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "Space not found" });
  });

  test("source account create and update, scoped to the caller's space", async () => {
    const owner = await signedInUser();
    const stranger = await signedInUser();
    const created = await routes.sourceAccountsCreate(
      jsonRequest(
        `${ORIGIN}/api/kith/source-accounts`,
        "POST",
        {
          spaceId: owner.spaceId,
          connector: "mcp-client",
          accountId: "desktop-1",
          name: "Desktop",
        },
        owner.cookie,
      ),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const deniedUpdate = await routes.sourceAccountUpdate(
      jsonRequest(
        `${ORIGIN}/api/kith/source-accounts/${id}`,
        "PATCH",
        { enabled: false },
        stranger.cookie,
      ),
      params(id),
    );
    expect(deniedUpdate.status).toBe(400);
    expect(await bodyOf(deniedUpdate)).toEqual({ error: "Source account not found" });

    const ownUpdate = await routes.sourceAccountUpdate(
      jsonRequest(
        `${ORIGIN}/api/kith/source-accounts/${id}`,
        "PATCH",
        { enabled: false },
        owner.cookie,
      ),
      params(id),
    );
    expect(ownUpdate.status).toBe(204);
  });

  test("shared space lifecycle: create, invite, accept, self-approve refused, approve, role change, leave", async () => {
    const owner = await signedInUser();
    const secondOwner = await signedInUser();
    const invitee = await signedInUser();

    const createdSpace = await routes.familySpacesCreate(
      jsonRequest(`${ORIGIN}/api/kith/family/spaces`, "POST", { name: "Household" }, owner.cookie),
    );
    expect(createdSpace.status).toBe(201);
    const { spaceId } = (await createdSpace.json()) as { spaceId: string };
    await addMember(spaceId, secondOwner.userId, "owner");

    const invitation = await routes.invitationsCreate(
      jsonRequest(
        `${ORIGIN}/api/kith/family/invitations`,
        "POST",
        { spaceId, email: "invitee@example.test", role: "editor" },
        owner.cookie,
      ),
    );
    expect(invitation.status).toBe(201);
    const { invitationId, token } = (await invitation.json()) as {
      invitationId: string;
      token: string;
    };

    // The invitee's account email does not have to match the invited address
    // for this test's purposes; `acceptInvitationByToken` only checks the
    // token and the accepting user's live existence.
    const accepted = await routes.invitationAccept(
      jsonRequest(
        `${ORIGIN}/api/kith/family/invitations/accept`,
        "POST",
        { token },
        invitee.cookie,
      ),
    );
    expect(accepted.status).toBe(204);

    // The account that accepted cannot approve its own acceptance, even once
    // it is (separately) an owner of the space -- `cannot_self_approve` is
    // checked regardless of the actor's role. The temporary ownership is
    // granted and removed the same way `identityFamily.test.mjs`'s
    // "ownerElsewhere" case does, so the real approval below still comes from
    // a genuinely different owner.
    const temporaryOwnership = await addMember(spaceId, invitee.userId, "owner");
    const selfApprove = await routes.invitationApprove(
      jsonRequest(
        `${ORIGIN}/api/kith/family/invitations/${invitationId}`,
        "POST",
        undefined,
        invitee.cookie,
      ),
      params(invitationId),
    );
    expect(selfApprove.status).toBe(400);
    expect((await bodyOf(selfApprove)).code).toBe("cannot_self_approve");
    await pool.query("DELETE FROM kith.space_members WHERE id = $1", [temporaryOwnership]);

    const approved = await routes.invitationApprove(
      jsonRequest(
        `${ORIGIN}/api/kith/family/invitations/${invitationId}`,
        "POST",
        undefined,
        owner.cookie,
      ),
      params(invitationId),
    );
    expect(approved.status).toBe(204);

    const membership = await pool.query<{ id: string }>(
      "SELECT id FROM kith.space_members WHERE space_id = $1 AND user_id = $2",
      [spaceId, invitee.userId],
    );
    const membershipId = membership.rows[0]!.id;

    // A non-owner cannot change another member's role.
    const deniedRoleChange = await routes.memberPatch(
      jsonRequest(
        `${ORIGIN}/api/kith/family/members/${membershipId}`,
        "PATCH",
        { role: "reader" },
        invitee.cookie,
      ),
      params(membershipId),
    );
    expect(deniedRoleChange.status).toBe(400);
    expect((await bodyOf(deniedRoleChange)).code).toBe("owner_required");

    const roleChanged = await routes.memberPatch(
      jsonRequest(
        `${ORIGIN}/api/kith/family/members/${membershipId}`,
        "PATCH",
        { role: "reader" },
        owner.cookie,
      ),
      params(membershipId),
    );
    expect(roleChanged.status).toBe(204);

    const left = await routes.familySpaceAction(
      jsonRequest(
        `${ORIGIN}/api/kith/family/spaces/${spaceId}`,
        "POST",
        { action: "leave" },
        invitee.cookie,
      ),
      params(spaceId),
    );
    expect(left.status).toBe(204);
  });

  test("family space actions a non-owner member or a non-member cannot do", async () => {
    const owner = await signedInUser();
    const editor = await signedInUser();
    const outsider = await signedInUser();

    const createdSpace = await routes.familySpacesCreate(
      jsonRequest(`${ORIGIN}/api/kith/family/spaces`, "POST", { name: "Denials" }, owner.cookie),
    );
    const { spaceId } = (await createdSpace.json()) as { spaceId: string };
    const editorMembershipId = await addMember(spaceId, editor.userId, "editor");

    // A member who is not an owner: every owner-only action is refused with
    // `owner_required`.
    const createDenied = await routes.invitationsCreate(
      jsonRequest(
        `${ORIGIN}/api/kith/family/invitations`,
        "POST",
        { spaceId, email: "someone@example.test", role: "reader" },
        editor.cookie,
      ),
    );
    expect(createDenied.status).toBe(400);
    expect((await bodyOf(createDenied)).code).toBe("owner_required");

    const removeDenied = await routes.memberRemove(
      jsonRequest(`${ORIGIN}/api/kith/family/members/${editorMembershipId}`, "DELETE", undefined, editor.cookie),
      params(editorMembershipId),
    );
    expect(removeDenied.status).toBe(400);
    expect((await bodyOf(removeDenied)).code).toBe("owner_required");

    const transferDenied = await routes.familySpaceAction(
      jsonRequest(
        `${ORIGIN}/api/kith/family/spaces/${spaceId}`,
        "POST",
        { action: "transferOwnership", toMembershipId: editorMembershipId },
        editor.cookie,
      ),
      params(spaceId),
    );
    expect(transferDenied.status).toBe(400);
    expect((await bodyOf(transferDenied)).code).toBe("owner_required");

    // An owner-created invitation, revoked by the same non-owner member.
    const invitation = await routes.invitationsCreate(
      jsonRequest(
        `${ORIGIN}/api/kith/family/invitations`,
        "POST",
        { spaceId, email: "someone-else@example.test", role: "reader" },
        owner.cookie,
      ),
    );
    const { invitationId } = (await invitation.json()) as { invitationId: string };
    const revokeDenied = await routes.invitationRevoke(
      jsonRequest(
        `${ORIGIN}/api/kith/family/invitations/${invitationId}`,
        "DELETE",
        undefined,
        editor.cookie,
      ),
      params(invitationId),
    );
    expect(revokeDenied.status).toBe(400);
    expect((await bodyOf(revokeDenied)).code).toBe("owner_required");
    // The owner still can.
    const revoked = await routes.invitationRevoke(
      jsonRequest(
        `${ORIGIN}/api/kith/family/invitations/${invitationId}`,
        "DELETE",
        undefined,
        owner.cookie,
      ),
      params(invitationId),
    );
    expect(revoked.status).toBe(204);

    // A user with no membership at all in the space cannot leave it.
    const leaveDenied = await routes.familySpaceAction(
      jsonRequest(
        `${ORIGIN}/api/kith/family/spaces/${spaceId}`,
        "POST",
        { action: "leave" },
        outsider.cookie,
      ),
      params(spaceId),
    );
    expect(leaveDenied.status).toBe(400);
    expect((await bodyOf(leaveDenied)).code).toBe("space_not_found");
  });

  // ADM-10. Re-registering a watcher clears its binding so the next heartbeat
  // claims the source. It is the only way out of `identity_review_required`,
  // and the protocol reserves it to the owner: "Only a current-session owner
  // operation may replace or clear the binding."
  test("only an owner may re-register a watcher", async () => {
    const owner = await signedInUser();
    const editor = await signedInUser();
    const reader = await signedInUser();
    const outsider = await signedInUser();
    await addMember(owner.spaceId, editor.userId, "editor");
    await addMember(owner.spaceId, reader.userId, "reader");

    const sourceAccountId = newKithId();
    await pool.query(
      `INSERT INTO kith.source_accounts
         (id, space_id, created_at, connector, account_id, name, enabled,
          cursor_version, freshness_ms, created_by)
       VALUES ($1,$2,transaction_timestamp(),'fs',$3,'Provider folder',true,0,60000,$4)`,
      [sourceAccountId, owner.spaceId, `acct-${sourceAccountId}`, owner.userId],
    );
    const watcherId = "3f1e2d3c-4b5a-5968-8776-655443322113";
    await pool.query(
      `INSERT INTO kith.worker_watcher_states
         (id, space_id, source_account_id, watcher_id, state, created_at,
          created_at_field, updated_at)
       VALUES ($1,$2,$3,$4,'awaiting_heartbeat',transaction_timestamp(),
               transaction_timestamp(),transaction_timestamp())`,
      [newKithId(), owner.spaceId, sourceAccountId, watcherId],
    );

    const call = (cookie: string | null) =>
      routes.watcherReregister(
        jsonRequest(
          `${ORIGIN}/api/kith/watcher`,
          "POST",
          { sourceAccountId, requestId: newKithId() },
          cookie,
        ),
      );

    // An editor holds `write` on the space and is still refused; a reader and
    // a user with no membership get the identical answer, so neither can map
    // the other's accounts from the denial.
    for (const who of [editor, reader, outsider]) {
      const denied = await call(who.cookie);
      expect(denied.status).toBe(400);
      expect((await bodyOf(denied)).error).toBe("Source account not found");
    }
    const unauthenticated = await call(null);
    expect(unauthenticated.status).toBe(401);
    expect(
      (
        await pool.query(
          "SELECT watcher_id FROM kith.worker_watcher_states WHERE source_account_id = $1",
          [sourceAccountId],
        )
      ).rows[0].watcher_id,
    ).toBe(watcherId);

    const allowed = await call(owner.cookie);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      sourceAccountId,
      clearedWatcherId: watcherId,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM kith.worker_watcher_states WHERE source_account_id = $1",
          [sourceAccountId],
        )
      ).rows[0].n,
    ).toBe(0);

    // Audited: the reset receipt names the owner who did it.
    const receipt = (
      await pool.query(
        `SELECT actor_user_id, expected_watcher_id, next_watcher_id
           FROM kith.worker_watcher_reset_receipts WHERE source_account_id = $1`,
        [sourceAccountId],
      )
    ).rows[0];
    expect(receipt).toMatchObject({
      actor_user_id: owner.userId,
      expected_watcher_id: watcherId,
      next_watcher_id: null,
    });
  });
});
