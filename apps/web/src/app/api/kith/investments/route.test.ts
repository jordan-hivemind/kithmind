// The investments routes, against a real database.
//
// These are the routes that change financial numbers, so the cases that
// matter are who may change them and whether an exact decimal survives the
// round trip. Two signed-in users in one database: an owner with an
// investment, a stranger who must not see or touch it, and a reader of the
// owner's own space who may read the space but must not administer it.

import { randomBytes } from "node:crypto";

import {
  applyKithSchema,
  createKithPool,
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
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");
const ORIGIN = "https://kith.example.test";

type Session = { cookie: string; spaceId: string; userId: string };

describeWithDatabase("/api/kith/investments", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let list: (request: Request) => Promise<Response>;
  let create: (request: Request) => Promise<Response>;
  let patch: (request: Request) => Promise<Response>;
  let archive: (request: Request) => Promise<Response>;
  let addEntry: (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  let patchEntry: (request: Request) => Promise<Response>;
  let deleteEntry: (request: Request) => Promise<Response>;

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

  async function signedInUser(): Promise<Session> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `adm3-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const setCookie = sessionCookie(
        { secret, secure: false },
        session.token,
        session.expiresAt,
      );
      return {
        cookie: setCookie.split(";")[0]!,
        spaceId,
        userId: session.userId,
      };
    });
  }

  function request(
    path: string,
    cookie: string | null,
    method = "GET",
    body?: unknown,
  ): Request {
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: ORIGIN,
    });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}/api/kith/investments${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  beforeAll(async () => {
    databaseName = `kith_adm3_investments_test_${randomBytes(8).toString("hex")}`;
    await onAdmin((admin) => admin.query(`CREATE DATABASE ${databaseName}`));
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
    const route = await import("./route");
    list = route.GET;
    create = route.POST;
    patch = route.PATCH;
    archive = route.DELETE;
    const entries = await import("./[id]/entries/route");
    addEntry = entries.POST;
    patchEntry = entries.PATCH;
    deleteEntry = entries.DELETE;
  }, 60_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    delete process.env.KITH_SESSION_SECRET;
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  test("the shared gate applies: no session, cross-origin, wrong content type", async () => {
    expect((await list(request("", null))).status).toBe(401);

    const crossOrigin = new Request(`${ORIGIN}/api/kith/investments`, {
      headers: {
        "Content-Type": "application/json",
        origin: "https://elsewhere.test",
      },
    });
    expect((await list(crossOrigin)).status).toBe(403);

    const noContentType = new Request(`${ORIGIN}/api/kith/investments`, {
      headers: { origin: ORIGIN },
    });
    expect((await list(noContentType)).status).toBe(415);
  });

  test("an investment round trips with exact decimals and computed totals", async () => {
    const owner = await signedInUser();
    const created = await create(
      request("", owner.cookie, "POST", {
        spaceId: owner.spaceId,
        name: "Bramble Fund I",
        category: "Investment Fund",
        signedOn: "2023-01-10",
      }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    for (const body of [
      { entryType: "commitment", entryDate: "2023-01-10", amount: "100000.00" },
      {
        entryType: "capital_call_paid",
        entryDate: "2023-04-01",
        amount: "30000.33",
      },
      {
        entryType: "capital_call_paid",
        entryDate: "2025-01-15",
        amount: "10000.00",
        currency: "GBP",
        exchangeRate: "1.25",
      },
    ]) {
      const response = await addEntry(
        request(`/${id}/entries`, owner.cookie, "POST", body),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status, JSON.stringify(body)).toBe(201);
    }

    const payload = (await (await list(request("", owner.cookie))).json()) as {
      investments: {
        id: string;
        totals: {
          usd: Record<string, string>;
          byCurrency: Record<string, string>[];
        };
      }[];
      entries: { amount: string; exchangeRate: string | null }[];
    };
    const investment = payload.investments.find((row) => row.id === id)!;
    // Exact decimal strings, never numbers, in both directions.
    expect(investment.totals.usd.sent).toBe("42500.3300");
    expect(investment.totals.usd.outstanding).toBe("57499.6700");
    expect(
      investment.totals.byCurrency.find((total) => total.currency === "GBP"),
    ).toMatchObject({ sent: "10000.00" });
    expect(payload.entries.every((entry) => typeof entry.amount === "string")).toBe(
      true,
    );
  });

  test("a non-USD amount without a rate is a 400 with a code, not a 500", async () => {
    const owner = await signedInUser();
    const { id } = (await (
      await create(
        request("", owner.cookie, "POST", {
          spaceId: owner.spaceId,
          name: "Sterling SPV",
        }),
      )
    ).json()) as { id: string };

    const response = await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", {
        entryType: "capital_call_paid",
        entryDate: "2025-02-02",
        amount: "100.00",
        currency: "GBP",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "exchange_rate_required",
    );

    // A float amount never reaches the database: zod refuses the body.
    const float = await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", {
        entryType: "fee",
        entryDate: "2025-02-02",
        amount: 100.5,
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(float.status).toBe(400);
    expect(((await float.json()) as { code: string }).code).toBe("invalid_input");
  });

  test("an import key makes a second POST of the same row a no-op", async () => {
    const owner = await signedInUser();
    const { id } = (await (
      await create(
        request("", owner.cookie, "POST", {
          spaceId: owner.spaceId,
          name: "Imported LP",
        }),
      )
    ).json()) as { id: string };
    const body = {
      entryType: "capital_call_paid",
      entryDate: "2024-05-05",
      amount: "7500.00",
      importKey: "ledger:imported lp:2024-05-05:USD:-7500.00",
    };
    const first = await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", body),
      { params: Promise.resolve({ id }) },
    );
    expect(first.status).toBe(201);
    const second = await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", body),
      { params: Promise.resolve({ id }) },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ created: false });
  });

  test("another space's investment is invisible and unwritable", async () => {
    const owner = await signedInUser();
    const stranger = await signedInUser();
    const { id } = (await (
      await create(
        request("", owner.cookie, "POST", {
          spaceId: owner.spaceId,
          name: "Mine Only",
        }),
      )
    ).json()) as { id: string };
    const { id: entryId } = (await (
      await addEntry(
        request(`/${id}/entries`, owner.cookie, "POST", {
          entryType: "fee",
          entryDate: "2025-01-01",
          amount: "1.00",
        }),
        { params: Promise.resolve({ id }) },
      )
    ).json()) as { id: string };

    const theirs = (await (
      await list(request("", stranger.cookie))
    ).json()) as { investments: { id: string }[] };
    expect(theirs.investments).toEqual([]);

    // Every write denies with the same non-enumerating message, so a stranger
    // cannot tell an investment they may not touch from one that is not there.
    for (const response of [
      await patch(
        request("", stranger.cookie, "PATCH", { id, name: "Stolen" }),
      ),
      await archive(request("", stranger.cookie, "DELETE", { id })),
      await addEntry(
        request(`/${id}/entries`, stranger.cookie, "POST", {
          entryType: "fee",
          entryDate: "2025-01-01",
          amount: "1.00",
        }),
        { params: Promise.resolve({ id }) },
      ),
    ]) {
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        "Investment not found",
      );
    }
    for (const response of [
      await patchEntry(
        request(`/${id}/entries`, stranger.cookie, "PATCH", {
          entryId,
          amount: "999.00",
        }),
      ),
      await deleteEntry(
        request(`/${id}/entries`, stranger.cookie, "DELETE", { entryId }),
      ),
    ]) {
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        "Investment entry not found",
      );
    }

    // And nothing was changed by any of it.
    const mine = (await (await list(request("", owner.cookie))).json()) as {
      investments: { name: string }[];
      entries: { amount: string }[];
    };
    expect(mine.investments.map((row) => row.name)).toEqual(["Mine Only"]);
    expect(mine.entries.map((row) => row.amount)).toEqual(["1.00"]);
  });

  test("a reader of the space sees no admin list and may not write", async () => {
    const owner = await signedInUser();
    const reader = await signedInUser();
    await inTransaction(async (ctx) => {
      await ctx.client.query(
        `INSERT INTO kith.space_members (id, space_id, user_id, role)
         SELECT $1, $2, $3, 'reader'`,
        [
          (await import("@repo/kith-store")).newKithId(),
          owner.spaceId,
          reader.userId,
        ],
      );
    });
    const { id } = (await (
      await create(
        request("", owner.cookie, "POST", {
          spaceId: owner.spaceId,
          name: "Read Only LP",
        }),
      )
    ).json()) as { id: string };

    // The admin read resolves through `getAdminSpaceIds`, so a reader's own
    // personal space is all they administer and the owner's space is absent.
    const seen = (await (await list(request("", reader.cookie))).json()) as {
      investments: { id: string }[];
    };
    expect(seen.investments).toEqual([]);

    const created = await create(
      request("", reader.cookie, "POST", {
        spaceId: owner.spaceId,
        name: "Reader's LP",
      }),
    );
    expect(created.status).toBe(400);
    expect(((await created.json()) as { error: string }).error).toBe(
      "Space not found",
    );

    const edited = await patch(
      request("", reader.cookie, "PATCH", { id, name: "Renamed" }),
    );
    expect(edited.status).toBe(400);
    expect(((await edited.json()) as { error: string }).error).toBe(
      "Investment not found",
    );
  });

  test("archive hides the investment and keeps its entries", async () => {
    const owner = await signedInUser();
    const { id } = (await (
      await create(
        request("", owner.cookie, "POST", {
          spaceId: owner.spaceId,
          name: "Closed Fund",
        }),
      )
    ).json()) as { id: string };
    await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", {
        entryType: "distribution",
        entryDate: "2025-01-01",
        amount: "10.00",
      }),
      { params: Promise.resolve({ id }) },
    );

    expect((await archive(request("", owner.cookie, "DELETE", { id }))).status).toBe(
      204,
    );
    const after = (await (await list(request("", owner.cookie))).json()) as {
      investments: { id: string }[];
    };
    expect(after.investments.some((row) => row.id === id)).toBe(false);

    const withArchived = (await (
      await list(request("?includeArchived=1", owner.cookie))
    ).json()) as {
      investments: { id: string; totals: { usd: Record<string, string> } }[];
    };
    const archived = withArchived.investments.find((row) => row.id === id)!;
    expect(archived.totals.usd.received).toBe("10.00");
  });
});
