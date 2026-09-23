// `PATCH /api/kith/fin-accounts/:id`, against a real database.
//
// What it proves: the route writes `kith.fin_accounts.display_name` only for
// a caller who administers at least one space, only for an account id that
// exists, and a blank name clears the override rather than writing an empty
// string.

import { randomBytes } from "node:crypto";

import {
  admin,
  applyKithSchema,
  createKithPool,
  newKithId,
  withKithReadTransaction,
  withKithTransaction,
} from "@repo/kith-store";
import {
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  sessionCookie,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

import { PATCH } from "./route";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");
const ORIGIN = "https://kith.example.test";

type Session = { userId: string; cookie: string; spaceId: string };

describeWithDatabase("/api/kith/fin-accounts/[id]", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let owner: Session;
  let stranger: Session;
  let accountId: string;

  async function onAdmin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  function inTransaction<T>(work: (ctx: IdentityCtx) => Promise<T>): Promise<T> {
    return withKithTransaction(pool, (client) => work(identityCtx(client)));
  }

  async function signedInUser(tag: string): Promise<Session> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `fin5-${tag}-${randomBytes(4).toString("hex")}@example.test`,
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

  function request(cookie: string | null, body: unknown): Request {
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: ORIGIN,
    });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}/api/kith/fin-accounts/x`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
  }

  function on(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  async function fetchDisplayName(id: string): Promise<string | null> {
    const result = await withKithReadTransaction(pool, (client) =>
      client.query<{ display_name: string | null }>(
        "SELECT display_name FROM kith.fin_accounts WHERE id = $1",
        [id],
      ),
    );
    return result.rows[0]?.display_name ?? null;
  }

  async function finAccountRow(id: string): Promise<admin.FinAccountRow | undefined> {
    const found = await withKithReadTransaction(pool, (client) =>
      admin.listFinAccounts(identityCtx(client)),
    );
    return found.find((row) => row.accountId === id);
  }

  beforeAll(async () => {
    databaseName = `kith_fin5_route_test_${randomBytes(8).toString("hex")}`;
    await onAdmin((client) => client.query(`CREATE DATABASE ${databaseName}`));
    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;

    const migrator = new pg.Client({ connectionString: url.toString() });
    migrator.on("error", () => {});
    await migrator.connect();
    await applyKithSchema(migrator);
    await migrator.end();

    pool = createKithPool(url.toString(), 5);
    pool.on("error", () => {});
    restorePool = setKithPool(pool);
    process.env.KITH_SESSION_SECRET = secret;

    owner = await signedInUser("owner");
    stranger = await signedInUser("stranger");
  }, 60_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    delete process.env.KITH_SESSION_SECRET;
    await onAdmin((client) =>
      client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  afterEach(async () => {
    await inTransaction((ctx) =>
      ctx.client.query("DELETE FROM kith.fin_accounts"),
    );
  });

  async function seedFeedOnlyAccount(): Promise<string> {
    return await inTransaction(async (ctx) => {
      const id = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.fin_accounts (id, institution_name, name, plaid_account_id)
         VALUES ($1, 'Example Bank', 'Mortgage Loan', $2)`,
        [id, `plaid-${id}`],
      );
      return id;
    });
  }

  test("an administered caller can rename a feed-only account", async () => {
    accountId = await seedFeedOnlyAccount();
    const response = await PATCH(
      request(owner.cookie, { displayName: "Rental property mortgage" }),
      on(accountId),
    );
    expect(response.status).toBe(204);
    expect(await fetchDisplayName(accountId)).toBe("Rental property mortgage");
    const row = await finAccountRow(accountId);
    expect(row?.accountName).toBe("Rental property mortgage");
    expect(row?.feedName).toBe("Mortgage Loan");
  });

  test("a blank name clears the override rather than storing an empty string", async () => {
    accountId = await seedFeedOnlyAccount();
    await PATCH(request(owner.cookie, { displayName: "Renamed" }), on(accountId));
    const cleared = await PATCH(
      request(owner.cookie, { displayName: "   " }),
      on(accountId),
    );
    expect(cleared.status).toBe(204);
    expect(await fetchDisplayName(accountId)).toBeNull();
  });

  test("an unknown account id is refused, and nothing is written", async () => {
    const response = await PATCH(
      request(owner.cookie, { displayName: "Anything" }),
      on(newKithId()),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "not_found",
    });
  });

  test("a caller who administers no space is refused", async () => {
    accountId = await seedFeedOnlyAccount();
    // `stranger`'s own personal space would otherwise make it an admin of
    // something -- every signed-up user owns one (`signUp` calls
    // `ensurePersonalSpace`) -- so this demotes that one membership to
    // `reader` directly, the only way to construct a principal
    // `getAdminSpaceIds` returns empty for.
    await inTransaction((ctx) =>
      ctx.client.query(
        "UPDATE kith.space_members SET role = 'reader' WHERE space_id = $1 AND user_id = $2",
        [stranger.spaceId, stranger.userId],
      ),
    );
    const response = await PATCH(
      request(stranger.cookie, { displayName: "Anything" }),
      on(accountId),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "not_authorized",
    });
    expect(await fetchDisplayName(accountId)).toBeNull();
  });

  test("no session is refused", async () => {
    accountId = await seedFeedOnlyAccount();
    const response = await PATCH(
      request(null, { displayName: "Anything" }),
      on(accountId),
    );
    expect(response.status).toBe(401);
  });

  test("a cross-origin request is refused before anything else", async () => {
    accountId = await seedFeedOnlyAccount();
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: "https://elsewhere.example",
      cookie: owner.cookie,
    });
    const response = await PATCH(
      new Request(`${ORIGIN}/api/kith/fin-accounts/x`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ displayName: "Anything" }),
      }),
      on(accountId),
    );
    expect(response.status).toBe(403);
    expect(await fetchDisplayName(accountId)).toBeNull();
  });
});
