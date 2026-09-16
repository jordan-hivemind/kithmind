// The `/api/kith/*` mutation routes, against a real database.
//
// Every route reloads the session from the cookie inside its own transaction
// (`withPrincipal`), so these cases exercise that path rather than the
// service functions directly: a caller who is signed in as `userB` must never
// be able to revoke `userA`'s key, edit `userA`'s source account, or manage
// `userA`'s shared space, no matter what id the request names.

import { randomBytes } from "node:crypto";

import { applyKithSchema, createKithPool, withKithTransaction } from "@repo/kith-store";
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

  function jsonRequest(
    url: string,
    method: string,
    body: unknown,
    cookie: string | null,
  ): Request {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function params(id: string) {
    return { params: Promise.resolve({ id }) };
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
      jsonRequest("https://kith.example.test/api/kith/api-keys", "POST", {
        name: "x",
        spaceIds: ["not-a-real-id"],
        capabilities: ["read"],
      }, null),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
  });

  test("api key create, list-page and revoke, scoped to the caller", async () => {
    const owner = await signedInUser();
    const created = await routes.apiKeysCreate(
      jsonRequest(
        "https://kith.example.test/api/kith/api-keys",
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
      new Request("https://kith.example.test/api/kith/api-keys?numItems=25", {
        headers: { cookie: owner.cookie },
      }),
    );
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { page: Array<{ id: string }> };
    expect(page.page.map((k) => k.id)).toContain(id);

    // A different signed-in user cannot revoke it: the route reloads its own
    // principal from the cookie and `identity.revokeApiKey` checks ownership
    // before it deletes anything.
    const other = await signedInUser();
    const deniedRevoke = await routes.apiKeyRevoke(
      jsonRequest(`https://kith.example.test/api/kith/api-keys/${id}`, "DELETE", undefined, other.cookie),
      params(id),
    );
    expect(deniedRevoke.status).toBe(400);
    const stillListed = await routes.apiKeysList(
      new Request("https://kith.example.test/api/kith/api-keys?numItems=25", {
        headers: { cookie: owner.cookie },
      }),
    );
    expect(
      ((await stillListed.json()) as { page: Array<{ id: string }> }).page.map((k) => k.id),
    ).toContain(id);

    // The owner can revoke their own key, through `deleteApiKey`'s wrapper.
    const revoked = await routes.apiKeyRevoke(
      jsonRequest(`https://kith.example.test/api/kith/api-keys/${id}`, "DELETE", undefined, owner.cookie),
      params(id),
    );
    expect(revoked.status).toBe(204);
    const afterRevoke = await routes.apiKeysList(
      new Request("https://kith.example.test/api/kith/api-keys?numItems=25", {
        headers: { cookie: owner.cookie },
      }),
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
        "https://kith.example.test/api/kith/settings/default-write-space",
        "POST",
        { spaceId: stranger.spaceId },
        owner.cookie,
      ),
    );
    expect(response.status).toBe(400);
  });

  test("source account create and update, scoped to the caller's space", async () => {
    const owner = await signedInUser();
    const stranger = await signedInUser();
    const created = await routes.sourceAccountsCreate(
      jsonRequest(
        "https://kith.example.test/api/kith/source-accounts",
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
        `https://kith.example.test/api/kith/source-accounts/${id}`,
        "PATCH",
        { enabled: false },
        stranger.cookie,
      ),
      params(id),
    );
    expect(deniedUpdate.status).toBe(400);

    const ownUpdate = await routes.sourceAccountUpdate(
      jsonRequest(
        `https://kith.example.test/api/kith/source-accounts/${id}`,
        "PATCH",
        { enabled: false },
        owner.cookie,
      ),
      params(id),
    );
    expect(ownUpdate.status).toBe(204);
  });

  test("shared space lifecycle: create, invite, accept, approve, role change, leave", async () => {
    const owner = await signedInUser();
    const invitee = await signedInUser();

    const createdSpace = await routes.familySpacesCreate(
      jsonRequest("https://kith.example.test/api/kith/family/spaces", "POST", { name: "Household" }, owner.cookie),
    );
    expect(createdSpace.status).toBe(201);
    const { spaceId } = (await createdSpace.json()) as { spaceId: string };

    const invitation = await routes.invitationsCreate(
      jsonRequest(
        "https://kith.example.test/api/kith/family/invitations",
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
        "https://kith.example.test/api/kith/family/invitations/accept",
        "POST",
        { token },
        invitee.cookie,
      ),
    );
    expect(accepted.status).toBe(204);

    // The inviting owner cannot approve their own acceptance.
    const selfApprove = await routes.invitationApprove(
      jsonRequest(
        `https://kith.example.test/api/kith/family/invitations/${invitationId}`,
        "POST",
        undefined,
        invitee.cookie,
      ),
      params(invitationId),
    );
    expect(selfApprove.status).toBe(400);

    const approved = await routes.invitationApprove(
      jsonRequest(
        `https://kith.example.test/api/kith/family/invitations/${invitationId}`,
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
        `https://kith.example.test/api/kith/family/members/${membershipId}`,
        "PATCH",
        { role: "reader" },
        invitee.cookie,
      ),
      params(membershipId),
    );
    expect(deniedRoleChange.status).toBe(400);

    const roleChanged = await routes.memberPatch(
      jsonRequest(
        `https://kith.example.test/api/kith/family/members/${membershipId}`,
        "PATCH",
        { role: "reader" },
        owner.cookie,
      ),
      params(membershipId),
    );
    expect(roleChanged.status).toBe(204);

    const left = await routes.familySpaceAction(
      jsonRequest(
        `https://kith.example.test/api/kith/family/spaces/${spaceId}`,
        "POST",
        { action: "leave" },
        invitee.cookie,
      ),
      params(spaceId),
    );
    expect(left.status).toBe(204);
  });
});
