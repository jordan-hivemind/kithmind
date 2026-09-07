import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";

async function fixture() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Synthetic settings owner" }),
  );
  const client = t.withIdentity({
    subject: userId,
    issuer: "https://synthetic.convex.site",
  });
  const { personalSpaceId } = await client.mutation(
    api.models.spaces.public.ensurePersonal,
    {},
  );
  return { t, client, userId, spaceId: personalSpaceId };
}

describe("desktop source and key configuration", () => {
  test("source identity is retrievable and disabled source can be re-enabled without changing identity", async () => {
    const f = await fixture();
    const id = await f.client.mutation(
      api.models.sourceAccounts.public.create,
      {
        spaceId: f.spaceId,
        connector: "mcp-client",
        accountId: "desktop-capture",
        name: "Desktop",
      },
    );
    await f.client.mutation(api.models.sourceAccounts.public.update, {
      sourceAccountId: id,
      enabled: false,
    });
    await f.client.mutation(api.models.sourceAccounts.public.update, {
      sourceAccountId: id,
      enabled: true,
      name: "Renamed",
      freshnessMs: 120000,
    });
    expect(
      await f.client.query(api.models.sourceAccounts.public.list, {}),
    ).toEqual([
      {
        _id: id,
        spaceId: f.spaceId,
        connector: "mcp-client",
        accountId: "desktop-capture",
        name: "Renamed",
        enabled: true,
        freshnessMs: 120000,
      },
    ]);
  });

  test("malformed source identity and key names are rejected with actionable codes", async () => {
    const f = await fixture();
    await expect(
      f.client.mutation(api.models.sourceAccounts.public.create, {
        spaceId: f.spaceId,
        connector: "mcp-client",
        accountId: "broken\ud800",
        name: "Desktop",
      }),
    ).rejects.toThrow("invalid_input");
    for (const name of [" ", "x".repeat(201), "broken\ud800"]) {
      await expect(
        f.client.mutation(api.models.apiKeys.public.create, {
          name,
          capabilities: ["read"],
          spaceIds: [f.spaceId],
        }),
      ).rejects.toThrow("invalid_input");
    }
    const key = await f.client.mutation(api.models.apiKeys.public.create, {
      name: "Valid",
      capabilities: ["read"],
      spaceIds: [f.spaceId],
    });
    await expect(
      f.client.mutation(api.models.apiKeys.public.update, {
        id: key.id,
        name: " ",
        capabilities: ["read"],
        spaceIds: [f.spaceId],
      }),
    ).rejects.toThrow("invalid_input");
  });
});
