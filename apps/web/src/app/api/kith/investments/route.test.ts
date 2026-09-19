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
  type EntryRoute = (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  let listEntries: EntryRoute;
  let addEntry: EntryRoute;
  let patchEntry: EntryRoute;
  let deleteEntry: EntryRoute;
  let suggest: EntryRoute;

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
    listEntries = entries.GET;
    addEntry = entries.POST;
    patchEntry = entries.PATCH;
    deleteEntry = entries.DELETE;
    suggest = (await import("./[id]/suggestions/route")).POST;
  }, 60_000);

  /** The `{ params }` argument Next.js hands a dynamic route. */
  function on(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  /** One investment, created through the route. */
  async function makeInvestment(
    session: Session,
    name: string,
    fields: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await create(
      request("", session.cookie, "POST", {
        spaceId: session.spaceId,
        name,
        ...fields,
      }),
    );
    expect(response.status, `create ${name}`).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async function investmentsOf(session: Session, query = "") {
    const response = await list(request(query, session.cookie));
    expect(response.status).toBe(200);
    return (
      (await response.json()) as {
        investments: {
          id: string;
          name: string;
          entryCount: number;
          linkedDocumentIds: string[];
          totals: {
            usd: Record<string, string>;
            byCurrency: Record<string, string>[];
          };
        }[];
      }
    ).investments;
  }

  async function entriesOf(session: Session, investmentId: string) {
    const response = await listEntries(
      request(`/${investmentId}/entries`, session.cookie),
      on(investmentId),
    );
    expect(response.status).toBe(200);
    return (
      (await response.json()) as {
        entries: { id: string; amount: string; entryType: string }[];
      }
    ).entries;
  }

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
    const id = await makeInvestment(owner, "Bramble Fund I", {
      category: "Investment Fund",
      signedOn: "2023-01-10",
    });

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
        on(id),
      );
      expect(response.status, JSON.stringify(body)).toBe(201);
    }

    const [investment] = await investmentsOf(owner);
    // Exact decimal strings, never numbers, in both directions. The USD
    // totals are rounded to two places after conversion; the per-currency
    // ones keep the column's own precision.
    expect(investment!.totals.usd.sent).toBe("42500.33");
    expect(investment!.totals.usd.outstanding).toBe("57499.67");
    expect(investment!.totals.usd.overCalled).toBe("0.00");
    expect(
      investment!.totals.byCurrency.find((total) => total.currency === "GBP"),
    ).toMatchObject({ sent: "10000.00" });

    // The list carries no entries at all: they are read per investment.
    const entries = await entriesOf(owner, id);
    expect(entries.length).toBe(3);
    expect(entries.every((entry) => typeof entry.amount === "string")).toBe(true);
  });

  test("an over-call is reported, not floored away", async () => {
    const owner = await signedInUser();
    const id = await makeInvestment(owner, "Overcalled LP");
    for (const body of [
      { entryType: "commitment", entryDate: "2024-01-01", amount: "1000.00" },
      {
        entryType: "capital_call_paid",
        entryDate: "2024-06-01",
        amount: "1500.00",
      },
    ]) {
      expect(
        (
          await addEntry(
            request(`/${id}/entries`, owner.cookie, "POST", body),
            on(id),
          )
        ).status,
      ).toBe(201);
    }
    const [investment] = await investmentsOf(owner);
    // Signed, so "called more than committed" is distinguishable from "fully
    // called", which both used to read 0.
    expect(investment!.totals.usd.outstanding).toBe("-500.00");
    expect(investment!.totals.usd.overCalled).toBe("500.00");
  });

  test("only a commitment change may be negative", async () => {
    const owner = await signedInUser();
    const id = await makeInvestment(owner, "Reduced LP");
    expect(
      (
        await addEntry(
          request(`/${id}/entries`, owner.cookie, "POST", {
            entryType: "commitment",
            entryDate: "2024-01-01",
            amount: "1000.00",
          }),
          on(id),
        )
      ).status,
    ).toBe(201);
    // A reduced commitment: the one signed quantity.
    expect(
      (
        await addEntry(
          request(`/${id}/entries`, owner.cookie, "POST", {
            entryType: "commitment_change",
            entryDate: "2024-07-01",
            amount: "-250.00",
          }),
          on(id),
        )
      ).status,
    ).toBe(201);
    const [investment] = await investmentsOf(owner);
    expect(investment!.totals.usd.committed).toBe("750.00");

    for (const entryType of ["capital_call_paid", "distribution", "fee"]) {
      const response = await addEntry(
        request(`/${id}/entries`, owner.cookie, "POST", {
          entryType,
          entryDate: "2024-08-01",
          amount: "-10.00",
        }),
        on(id),
      );
      expect(response.status, entryType).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe(
        "invalid_input",
      );
    }

    // And a patch that retypes a negative commitment change is refused too,
    // rather than storing a negative fee.
    const [change] = (await entriesOf(owner, id)).filter(
      (entry) => entry.entryType === "commitment_change",
    );
    const retyped = await patchEntry(
      request(`/${id}/entries`, owner.cookie, "PATCH", {
        entryId: change!.id,
        entryType: "fee",
      }),
      on(id),
    );
    expect(retyped.status).toBe(400);
    expect(((await retyped.json()) as { code: string }).code).toBe(
      "negative_amount",
    );
  });

  test("a non-USD amount without a rate is a 400 with a code, not a 500", async () => {
    const owner = await signedInUser();
    const id = await makeInvestment(owner, "Sterling SPV");

    const response = await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", {
        entryType: "capital_call_paid",
        entryDate: "2025-02-02",
        amount: "100.00",
        currency: "GBP",
      }),
      on(id),
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
      on(id),
    );
    expect(float.status).toBe(400);
    expect(((await float.json()) as { code: string }).code).toBe("invalid_input");
  });

  test("a duplicate name is refused by the index, not by a racing read", async () => {
    const owner = await signedInUser();
    await makeInvestment(owner, "Only One");
    const again = await create(
      request("", owner.cookie, "POST", {
        spaceId: owner.spaceId,
        name: "  only one  ",
      }),
    );
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe(
      "duplicate_investment",
    );
  });

  test("an import key makes a second POST of the same row a no-op", async () => {
    const owner = await signedInUser();
    const id = await makeInvestment(owner, "Imported LP");
    const body = {
      entryType: "capital_call_paid",
      entryDate: "2024-05-05",
      amount: "7500.00",
      importKey: "ledger:imported lp:2024-05-05:USD:-7500.00#1",
    };
    const first = await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", body),
      on(id),
    );
    expect(first.status).toBe(201);
    const second = await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", body),
      on(id),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ created: false });

    // The same row with the next occurrence's key is a second entry, because
    // a sheet may legitimately hold the same call twice on the same day.
    const twin = await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", {
        ...body,
        importKey: `${body.importKey.slice(0, -1)}2`,
      }),
      on(id),
    );
    expect(twin.status).toBe(201);
    expect((await entriesOf(owner, id)).length).toBe(2);
  });

  test("an entry may only be changed through its own investment's path", async () => {
    const owner = await signedInUser();
    const mine = await makeInvestment(owner, "Holder");
    const other = await makeInvestment(owner, "Bystander");
    const { id: entryId } = (await (
      await addEntry(
        request(`/${mine}/entries`, owner.cookie, "POST", {
          entryType: "fee",
          entryDate: "2025-01-01",
          amount: "1.00",
        }),
        on(mine),
      )
    ).json()) as { id: string };

    // Same space, same owner, wrong investment in the path: refused, because
    // otherwise the URL would be a lie about what was changed.
    for (const response of [
      await patchEntry(
        request(`/${other}/entries`, owner.cookie, "PATCH", {
          entryId,
          amount: "999.00",
        }),
        on(other),
      ),
      await deleteEntry(
        request(`/${other}/entries`, owner.cookie, "DELETE", { entryId }),
        on(other),
      ),
    ]) {
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        "Investment entry not found",
      );
    }
    expect((await entriesOf(owner, mine))[0]!.amount).toBe("1.00");
  });

  test("another space's investment is invisible and unwritable", async () => {
    const owner = await signedInUser();
    const stranger = await signedInUser();
    const id = await makeInvestment(owner, "Mine Only");
    const { id: entryId } = (await (
      await addEntry(
        request(`/${id}/entries`, owner.cookie, "POST", {
          entryType: "fee",
          entryDate: "2025-01-01",
          amount: "1.00",
        }),
        on(id),
      )
    ).json()) as { id: string };

    expect(await investmentsOf(stranger)).toEqual([]);
    // The entries read is scoped the same way: a stranger asking for this
    // investment's entries gets none rather than a denial that confirms it.
    const strangerEntries = await listEntries(
      request(`/${id}/entries`, stranger.cookie),
      on(id),
    );
    expect(((await strangerEntries.json()) as { entries: [] }).entries).toEqual(
      [],
    );
    // And so is the suggestion read.
    const strangerSuggestions = await suggest(
      request(`/${id}/suggestions`, stranger.cookie, "POST", {
        amount: "1.00",
      }),
      on(id),
    );
    expect(strangerSuggestions.status).toBe(200);
    expect(
      ((await strangerSuggestions.json()) as { suggestions: [] }).suggestions,
    ).toEqual([]);

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
        on(id),
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
        on(id),
      ),
      await deleteEntry(
        request(`/${id}/entries`, stranger.cookie, "DELETE", { entryId }),
        on(id),
      ),
    ]) {
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        "Investment entry not found",
      );
    }

    // And nothing was changed by any of it.
    const mine = await investmentsOf(owner);
    expect(mine.map((row) => row.name)).toEqual(["Mine Only"]);
    expect((await entriesOf(owner, id)).map((row) => row.amount)).toEqual([
      "1.00",
    ]);
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
    const id = await makeInvestment(owner, "Read Only LP");

    // The admin read resolves through `getAdminSpaceIds`, so a reader's own
    // personal space is all they administer and the owner's space is absent.
    expect(await investmentsOf(reader)).toEqual([]);

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
    const id = await makeInvestment(owner, "Closed Fund");
    await addEntry(
      request(`/${id}/entries`, owner.cookie, "POST", {
        entryType: "distribution",
        entryDate: "2025-01-01",
        amount: "10.00",
      }),
      on(id),
    );

    expect(
      (await archive(request("", owner.cookie, "DELETE", { id }))).status,
    ).toBe(204);
    expect((await investmentsOf(owner)).some((row) => row.id === id)).toBe(false);

    const archived = (await investmentsOf(owner, "?includeArchived=1")).find(
      (row) => row.id === id,
    )!;
    expect(archived.totals.usd.received).toBe("10.00");

    // The name is free again once archived, and the index allows it.
    expect(
      (
        await create(
          request("", owner.cookie, "POST", {
            spaceId: owner.spaceId,
            name: "Closed Fund",
          }),
        )
      ).status,
    ).toBe(201);
  });
});
