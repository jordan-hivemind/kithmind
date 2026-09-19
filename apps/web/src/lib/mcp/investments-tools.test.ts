// `list_investments` and `get_investment` (ADM-3), against a real database.
//
// These are MCP exposure and financial numbers, which is exactly the pair the
// owner's decision says gets a second-model review, so the suite states the
// three properties that review will look for and nothing else:
//
//   * Cross-space isolation. A credential granted space A never sees space B's
//     investment, and naming space B explicitly is refused rather than
//     silently narrowed to A.
//   * Revocation. A credential deleted between two calls denies on the second,
//     because the principal is reloaded inside each call's own transaction.
//   * Decimal exactness. Every amount out of the tools is the string the
//     `numeric` column holds, including the converted USD totals, and no
//     figure round trips through a JavaScript number.
//
// Its own fixture rather than a place in `postgres-reads.test.ts`'s: that
// suite's fixture is shared by every other read tool, and widening it to carry
// investments would make this feature's failure look like theirs.

import { randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  admin,
  applyKithSchema,
  createKithPool,
  newKithId,
  withKithTransaction,
} from "@repo/kith-store";
import {
  createApiKey,
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

import { mcpPrincipalLoader } from "./principal";
import { createMcpServer, type McpServerCredential } from "./server";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";

type Fixture = {
  userId: string;
  keyA: string;
  keyBoth: string;
  spaceA: string;
  spaceB: string;
  investmentA: string;
  investmentB: string;
};

describeWithDatabase("MCP investment read tools", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let fixture: Fixture;

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

  function credentialFor(keyId: string, userId = fixture.userId) {
    return {
      surface: "postgres" as const,
      withPrincipal: mcpPrincipalLoader({ userId, credentialId: keyId }),
    } satisfies McpServerCredential;
  }

  async function call(
    credential: McpServerCredential,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const server = createMcpServer(credential, "user-test:key-test", null);
    const client = new Client({ name: "investment-tools", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
      await server.close();
    }
  }

  function payload(result: unknown): unknown {
    const content = (result as { content?: { text?: string }[] }).content ?? [];
    return JSON.parse(content[0]?.text ?? "null");
  }

  function errorText(result: unknown): string {
    const content = (result as { content?: { text?: string }[] }).content ?? [];
    return content.map((part) => part.text ?? "").join("\n");
  }

  beforeAll(async () => {
    databaseName = `kith_adm3_mcp_test_${randomBytes(8).toString("hex")}`;
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

    fixture = await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `adm3-mcp-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const principal = {
        userId: session.userId,
        capabilities: ["read"] as const,
      };
      const spaceA = await ensurePersonalSpace(ctx, session.userId);
      const spaceB = await inSecondSpace(ctx, session.userId);
      const keyA = await createApiKey(ctx, {
        principal,
        name: "Space A only",
        capabilities: ["read"],
        spaceIds: [spaceA],
      });
      const keyBoth = await createApiKey(ctx, {
        principal,
        name: "Both spaces",
        capabilities: ["read"],
        spaceIds: [spaceA, spaceB],
      });

      const writer = {
        userId: session.userId,
        capabilities: ["read", "write"] as const,
      };
      const investmentA = await admin.createInvestment(ctx, {
        principal: writer,
        spaceId: spaceA,
        name: "Bramble Fund I",
        category: "Investment Fund",
        signedOn: "2023-01-10",
      });
      const investmentB = await admin.createInvestment(ctx, {
        principal: writer,
        spaceId: spaceB,
        name: "Other Space LP",
      });
      for (const entry of [
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
        { entryType: "fee", entryDate: "2024-01-01", amount: "500.01" },
        { entryType: "distribution", entryDate: "2025-06-30", amount: "12345.67" },
      ] as const) {
        await admin.createInvestmentEntry(ctx, {
          principal: writer,
          investmentId: investmentA,
          ...entry,
        });
      }
      return {
        userId: session.userId,
        keyA: keyA.id,
        keyBoth: keyBoth.id,
        spaceA,
        spaceB,
        investmentA,
        investmentB,
      };
    });
  }, 90_000);

  /** A second space the same user owns, so the isolation case is about the
   * credential's grant rather than about membership. Written directly, the way
   * `postgres-reads.test.ts` writes its own second space. */
  async function inSecondSpace(
    ctx: IdentityCtx,
    userId: string,
  ): Promise<string> {
    const spaceId = newKithId();
    await ctx.client.query(
      `INSERT INTO kith.spaces (id, kind, name, created_by)
         VALUES ($1, 'shared', 'Second', $2)`,
      [spaceId, userId],
    );
    await ctx.client.query(
      `INSERT INTO kith.space_members (id, space_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')`,
      [newKithId(), spaceId, userId],
    );
    return spaceId;
  }

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    await onAdmin((client) =>
      client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  test("totals are exact decimal strings, per currency and in USD", async () => {
    const result = payload(
      await call(credentialFor(fixture.keyA), "list_investments", {}),
    ) as {
      investments: {
        name: string;
        entryCount: number;
        totals: {
          usd: Record<string, string>;
          byCurrency: Record<string, string>[];
        };
      }[];
    };
    expect(result.investments.map((row) => row.name)).toEqual(["Bramble Fund I"]);
    const [investment] = result.investments;
    expect(investment!.entryCount).toBe(5);
    // 30000.33 + 10000.00 * 1.25, computed in `numeric` and never in a float.
    expect(investment!.totals.usd.sent).toBe("42500.3300");
    expect(investment!.totals.usd.committed).toBe("100000.00");
    expect(investment!.totals.usd.outstanding).toBe("57499.6700");
    expect(investment!.totals.usd.received).toBe("12345.67");
    // Fees are their own total and are not counted as sent.
    expect(investment!.totals.usd.fees).toBe("500.01");
    expect(
      investment!.totals.byCurrency.find((total) => total.currency === "GBP"),
    ).toMatchObject({ sent: "10000.00", committed: "0" });
    // Every figure is a string. A number here would mean a cent had already
    // been through a float by the time the model saw it.
    for (const value of Object.values(investment!.totals.usd)) {
      expect(typeof value).toBe("string");
    }
  });

  test("filters narrow without widening the space set", async () => {
    const byCategory = payload(
      await call(credentialFor(fixture.keyBoth), "list_investments", {
        category: "Investment Fund",
      }),
    ) as { investments: { name: string }[] };
    expect(byCategory.investments.map((row) => row.name)).toEqual([
      "Bramble Fund I",
    ]);

    const byName = payload(
      await call(credentialFor(fixture.keyBoth), "list_investments", {
        nameContains: "other",
      }),
    ) as { investments: { name: string }[] };
    expect(byName.investments.map((row) => row.name)).toEqual(["Other Space LP"]);
  });

  test("a credential granted one space never sees the other's investment", async () => {
    const onlyA = payload(
      await call(credentialFor(fixture.keyA), "list_investments", {}),
    ) as { investments: { spaceId: string }[] };
    expect(onlyA.investments.every((row) => row.spaceId === fixture.spaceA)).toBe(
      true,
    );

    // Naming the ungranted space explicitly is refused, not narrowed to the
    // granted one: a silently narrowed answer would read as "space B holds no
    // investments".
    const named = await call(credentialFor(fixture.keyA), "list_investments", {
      spaceIds: [fixture.spaceB],
    });
    expect(named.isError).toBe(true);
    expect(errorText(named)).toContain("Space not found");

    // And the other space's investment is unreadable by id, with no hint that
    // the id exists.
    expect(
      payload(
        await call(credentialFor(fixture.keyA), "get_investment", {
          investmentId: fixture.investmentB,
        }),
      ),
    ).toBeNull();
    // The credential granted both spaces reads it.
    expect(
      payload(
        await call(credentialFor(fixture.keyBoth), "get_investment", {
          investmentId: fixture.investmentB,
        }),
      ),
    ).toMatchObject({ name: "Other Space LP" });
  });

  test("get_investment returns the entries with their own currency and rate", async () => {
    const detail = payload(
      await call(credentialFor(fixture.keyA), "get_investment", {
        investmentId: fixture.investmentA,
      }),
    ) as {
      entries: {
        entryType: string;
        amount: string;
        currency: string;
        exchangeRate: string | null;
      }[];
      linkedDocumentIds: string[];
    };
    const sterling = detail.entries.find((entry) => entry.currency === "GBP")!;
    expect(sterling).toMatchObject({
      entryType: "capital_call_paid",
      amount: "10000.00",
      exchangeRate: "1.25",
    });
    // Amounts are positive; the type carries the direction.
    expect(detail.entries.every((entry) => !entry.amount.startsWith("-"))).toBe(
      true,
    );
    expect(detail.linkedDocumentIds).toEqual([]);
  });

  test("a credential revoked between two calls denies on the second", async () => {
    const revoked = await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `adm3-revoked-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const key = await createApiKey(ctx, {
        principal: { userId: session.userId, capabilities: ["read"] as const },
        name: "Synthetic revocable client",
        capabilities: ["read"],
        spaceIds: [spaceId],
      });
      return { userId: session.userId, keyId: key.id };
    });
    const credential = credentialFor(revoked.keyId, revoked.userId);
    const first = await call(credential, "list_investments", {});
    expect(first.isError).not.toBe(true);

    await pool.query("DELETE FROM kith.api_keys WHERE id = $1", [revoked.keyId]);

    const second = await call(credential, "list_investments", {});
    expect(second.isError).toBe(true);
    expect(errorText(second)).toContain("Not authenticated");
    const detail = await call(credential, "get_investment", {
      investmentId: fixture.investmentA,
    });
    expect(detail.isError).toBe(true);
    expect(errorText(detail)).toContain("Not authenticated");
  });
});
