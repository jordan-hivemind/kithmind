// `PATCH /api/kith/finance-accounts/:id`, against a real database.
//
// The archive itself is synthetic: `resolveFinanceArchive` is replaced so the
// route reads a fixed inventory, while `readFinanceArchive` stays real, so the
// membership check and the contract's own request and exchange parsers run for
// every one of these. Only the archive's rows are fake, never the gate.
//
// What it proves: the route writes an override only for an account the archive
// actually lists, only for a caller who may write the archive's own space, and
// refuses rather than writing when the archive will not answer.

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
  createSharedSpace,
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  sessionCookie,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

const financeMock = vi.hoisted(() => ({
  resolve: vi.fn<() => unknown>(() => null),
}));
vi.mock("@/lib/mcp/finance", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveFinanceArchive: () => financeMock.resolve(),
}));

import { PATCH } from "./route";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");
const ORIGIN = "https://kith.example.test";
const HELD_ACCOUNT = "account-synthetic-adm2b";

type Session = { userId: string; cookie: string; spaceId: string };

describeWithDatabase("/api/kith/finance-accounts/[id]", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let owner: Session;
  let archiveSpaceId: string;
  let stranger: Session;

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
        email: `adm2b-${tag}-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const setCookie = sessionCookie(
        { secret, secure: false },
        session.token,
        session.expiresAt,
      );
      return { userId: session.userId, cookie: setCookie.split(";")[0]!, spaceId };
    });
  }

  /** One account, shaped as the archive's read contract requires. */
  function inventoryResponse(spaceId: string, accountIds: readonly string[]) {
    return {
      contractVersion: 1 as const,
      operation: "list_account_inventory" as const,
      spaceId,
      datasetRevision: "rev-synthetic-adm2b",
      coverage: { status: "complete" as const, asOf: 1_788_800_000_000 },
      completeness: "complete" as const,
      truncated: false,
      issues: [],
      items: accountIds.map((accountId) => ({
        account: {
          accountId,
          sourceId: "source-synthetic-adm2b",
          institutionName: "Example Broker",
          accountLast4: "1234",
          displayLabel: "Income",
          accountType: "brokerage",
          baseCurrency: "USD",
          disclosures: [],
        },
        statementCount: 4,
        recordCount: 40,
        activityFrom: "2025-01-02",
        activityTo: "2026-08-31",
        latestSnapshotAsOf: "2026-08-31",
        openReviewCount: 0,
      })),
    };
  }

  function archiveHolding(accountIds: readonly string[]) {
    financeMock.resolve.mockReturnValue({
      spaceId: archiveSpaceId,
      read: async () =>
        Promise.resolve(inventoryResponse(archiveSpaceId, accountIds)),
    });
  }

  function request(cookie: string | null, body: unknown): Request {
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: ORIGIN,
    });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}/api/kith/finance-accounts/x`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
  }

  function on(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  const edit = {
    displayName: "Brokerage",
    accountLast4: null,
    accountType: null,
    closed: false,
  };

  async function overrides(): Promise<admin.AccountOverride[]> {
    return await withKithReadTransaction(pool, (client) =>
      admin.listAccountOverrides(identityCtx(client), {
        spaceId: archiveSpaceId,
      }),
    );
  }

  beforeAll(async () => {
    databaseName = `kith_adm2b_route_test_${randomBytes(8).toString("hex")}`;
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
    archiveSpaceId = (
      await inTransaction((ctx) =>
        createSharedSpace(ctx, { userId: owner.userId, name: "Archive" }),
      )
    ).spaceId;
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
    financeMock.resolve.mockReset();
    financeMock.resolve.mockReturnValue(null);
    await inTransaction((ctx) =>
      ctx.client.query("DELETE FROM kith.finance_account_overrides"),
    );
  });

  test("an account the archive lists can be overridden", async () => {
    archiveHolding([HELD_ACCOUNT]);
    const response = await PATCH(
      request(owner.cookie, edit),
      on(HELD_ACCOUNT),
    );
    expect(response.status).toBe(204);
    expect(await overrides()).toEqual([
      {
        accountId: HELD_ACCOUNT,
        displayName: "Brokerage",
        accountLast4: null,
        accountType: null,
        closed: false,
      },
    ]);
  });

  test("an account the archive does not list is refused, and nothing is written", async () => {
    archiveHolding([HELD_ACCOUNT]);
    const response = await PATCH(
      request(owner.cookie, edit),
      on("account-never-held"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "not_found",
    });
    expect(await overrides()).toEqual([]);
  });

  test("an archive that will not answer refuses the write rather than trusting the id", async () => {
    financeMock.resolve.mockReturnValue({
      spaceId: archiveSpaceId,
      read: async () => {
        throw new Error("archive down");
      },
    });
    const response = await PATCH(
      request(owner.cookie, edit),
      on(HELD_ACCOUNT),
    );
    expect(response.status).toBe(503);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "archive_unavailable",
    });
    expect(await overrides()).toEqual([]);
  });

  test("a caller who is not a member of the archive's space is refused, and the archive is never read", async () => {
    const read = vi.fn(async () =>
      Promise.resolve(inventoryResponse(archiveSpaceId, [HELD_ACCOUNT])),
    );
    financeMock.resolve.mockReturnValue({ spaceId: archiveSpaceId, read });
    const response = await PATCH(
      request(stranger.cookie, edit),
      on(HELD_ACCOUNT),
    );
    // "Space not found", the same answer every `/api/kith/*` route gives a
    // non-member, whether or not the space exists. Deliberately not the 404
    // the unknown-account case returns: that one is about the archive.
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "Space not found",
    });
    // Refused before the archive is touched: the existence of an account id is
    // not something a non-member gets to probe for.
    expect(read).not.toHaveBeenCalled();
    expect(await overrides()).toEqual([]);
  });

  test("a reader of the archive's space may not write it", async () => {
    const reader = await signedInUser("reader");
    await inTransaction((ctx) =>
      ctx.client.query(
        `INSERT INTO kith.space_members (id, space_id, user_id, role)
         SELECT $1, $2, $3, 'reader'`,
        [newKithId(), archiveSpaceId, reader.userId],
      ),
    );
    const read = vi.fn(async () =>
      Promise.resolve(inventoryResponse(archiveSpaceId, [HELD_ACCOUNT])),
    );
    financeMock.resolve.mockReturnValue({ spaceId: archiveSpaceId, read });
    const response = await PATCH(
      request(reader.cookie, edit),
      on(HELD_ACCOUNT),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "Space not found",
    });
    expect(read).not.toHaveBeenCalled();
    expect(await overrides()).toEqual([]);
  });

  test("no session is refused without reading the archive", async () => {
    const read = vi.fn(async () =>
      Promise.resolve(inventoryResponse(archiveSpaceId, [HELD_ACCOUNT])),
    );
    financeMock.resolve.mockReturnValue({ spaceId: archiveSpaceId, read });
    const response = await PATCH(request(null, edit), on(HELD_ACCOUNT));
    expect(response.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  test("a cross-origin request is refused before anything else", async () => {
    archiveHolding([HELD_ACCOUNT]);
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: "https://elsewhere.example",
      cookie: owner.cookie,
    });
    const response = await PATCH(
      new Request(`${ORIGIN}/api/kith/finance-accounts/x`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(edit),
      }),
      on(HELD_ACCOUNT),
    );
    expect(response.status).toBe(403);
    expect(await overrides()).toEqual([]);
  });

  test("clearing every field removes the row", async () => {
    archiveHolding([HELD_ACCOUNT]);
    await PATCH(request(owner.cookie, edit), on(HELD_ACCOUNT));
    expect(await overrides()).toHaveLength(1);
    const cleared = await PATCH(
      request(owner.cookie, {
        displayName: null,
        accountLast4: null,
        accountType: null,
        closed: false,
      }),
      on(HELD_ACCOUNT),
    );
    expect(cleared.status).toBe(204);
    expect(await overrides()).toEqual([]);
  });
});
