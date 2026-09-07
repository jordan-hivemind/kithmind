import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  enqueueSourceFetch,
  type EnqueueUrlInput,
  validateEnqueueUrlInput,
} from "./urlQueue";

const issuer = "https://synthetic-mcp.example/convex";
const originalIssuer = process.env.MCP_JWT_ISSUER;
const enqueueMutation = makeFunctionReference<
  "mutation",
  { input: EnqueueUrlInput },
  {
    state: "queued";
    workerRequired: true;
    sourceItemId: Id<"sourceItems">;
    requestId: string;
    fetchRequestId: Id<"sourceFetchRequests">;
  }
>("models/ingestion/urlQueue:enqueue");

beforeAll(() => {
  process.env.MCP_JWT_ISSUER = issuer;
});

afterAll(() => {
  if (originalIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
  else process.env.MCP_JWT_ISSUER = originalIssuer;
});

async function fixture() {
  const t = convexTest(schema, modules);
  const seed = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic URL queue",
      createdBy: userId,
    });
    const membershipId = await ctx.db.insert("spaceMembers", {
      spaceId,
      userId,
      role: "editor",
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "mcp-client",
      accountId: "synthetic-web",
      name: "Synthetic web account",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "a".repeat(64),
      keyPrefix: "url_queue",
      name: "Synthetic URL client",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    return { userId, spaceId, membershipId, sourceAccountId, credentialId };
  });
  const input: EnqueueUrlInput = {
    spaceId: seed.spaceId,
    requestId: "request-1",
    source: {
      connector: "mcp-client",
      accountId: "synthetic-web",
      externalId: "synthetic-page-1",
    },
    url: "https://example.test/records/1",
    title: "Synthetic record",
  };
  const principal = {
    userId: seed.userId,
    credentialId: seed.credentialId,
  };
  const mcp = t.withIdentity({
    issuer,
    subject: seed.userId,
    apiKeyId: seed.credentialId,
  });
  return { t, ...seed, input, principal, mcp };
}

describe("URL fetch queue", () => {
  test("enqueues a stable source item without fabricating fetched content", async () => {
    const f = await fixture();
    const queued = await f.mcp.mutation(enqueueMutation, { input: f.input });
    expect(queued).toMatchObject({
      state: "queued",
      workerRequired: true,
      requestId: "request-1",
    });
    const stored = await f.t.run(async (ctx) => ({
      request: await ctx.db.get(queued.fetchRequestId),
      item: await ctx.db.get(queued.sourceItemId),
      revisions: await ctx.db.query("sourceRevisions").collect(),
      generations: await ctx.db.query("processingGenerations").collect(),
      documents: await ctx.db.query("documents").collect(),
      jobs: await ctx.db.query("ingestJobs").collect(),
    }));
    expect(stored.request).toMatchObject({
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: queued.sourceItemId,
      actorUserId: f.userId,
      actorCredentialId: f.credentialId,
      requestId: "request-1",
      url: f.input.url,
      title: f.input.title,
      state: "queued",
    });
    expect(stored.request?.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored.item).toMatchObject({
      sourceAccountId: f.sourceAccountId,
      externalId: "synthetic-page-1",
      uri: f.input.url,
      lifecycle: "available",
    });
    expect(stored.item?.title).toBeUndefined();
    expect(stored.revisions).toEqual([]);
    expect(stored.generations).toEqual([]);
    expect(stored.documents).toEqual([]);
    expect(stored.jobs).toEqual([]);
  });

  test("replays an identical request and conflicts on changed content", async () => {
    const f = await fixture();
    const first = await f.t.run((ctx) =>
      enqueueSourceFetch(ctx, {
        principal: f.principal,
        input: f.input,
        now: 1_000,
      }),
    );
    const replay = await f.t.run((ctx) =>
      enqueueSourceFetch(ctx, {
        principal: f.principal,
        input: f.input,
        now: 2_000,
      }),
    );
    expect(replay).toEqual(first);
    const counts = await f.t.run(async (ctx) => ({
      requests: (await ctx.db.query("sourceFetchRequests").collect()).length,
      items: (await ctx.db.query("sourceItems").collect()).length,
      rate: await ctx.db
        .query("ingestRateLimits")
        .withIndex("by_credentialId", (q) =>
          q.eq("credentialId", f.credentialId),
        )
        .unique(),
    }));
    expect(counts).toMatchObject({ requests: 1, items: 1 });
    expect(counts.rate?.count).toBe(1);
    await expect(
      f.t.run((ctx) =>
        enqueueSourceFetch(ctx, {
          principal: f.principal,
          input: { ...f.input, url: "https://example.test/changed" },
          now: 3_000,
        }),
      ),
    ).rejects.toThrow("requestId conflicts with a different request");
  });

  test("rechecks live MCP, space, and source-account grants", async () => {
    const f = await fixture();
    await expect(
      f.t.mutation(enqueueMutation, { input: f.input }),
    ).rejects.toThrow("Not authenticated");
    await f.mcp.mutation(enqueueMutation, { input: f.input });

    await f.t.run((ctx) => ctx.db.patch(f.membershipId, { role: "reader" }));
    await expect(
      f.mcp.mutation(enqueueMutation, { input: f.input }),
    ).rejects.toThrow("Space not found");
    await f.t.run((ctx) => ctx.db.patch(f.membershipId, { role: "editor" }));

    await f.t.run((ctx) =>
      ctx.db.patch(f.credentialId, { sourceAccountIds: [] }),
    );
    await expect(
      f.mcp.mutation(enqueueMutation, { input: f.input }),
    ).rejects.toThrow("Source account not found");
    await f.t.run((ctx) =>
      ctx.db.patch(f.credentialId, {
        sourceAccountIds: [f.sourceAccountId],
        capabilities: ["read"],
      }),
    );
    await expect(
      f.mcp.mutation(enqueueMutation, { input: f.input }),
    ).rejects.toThrow("Space not found");
  });

  test("rejects malformed strings and unsafe URL syntax before admission", async () => {
    const f = await fixture();
    const invalid: Array<[string, EnqueueUrlInput]> = [
      ["scheme", { ...f.input, url: "ftp://example.test/source" }],
      ["scheme shorthand", { ...f.input, url: "http:example.test/source" }],
      ["userinfo", { ...f.input, url: "https://user@example.test/source" }],
      ["empty userinfo", { ...f.input, url: "https://@example.test/source" }],
      ["backslash", { ...f.input, url: "https://example.test\\source" }],
      ["control", { ...f.input, url: "https://example.test/\nsource" }],
      ["request bytes", { ...f.input, requestId: "r".repeat(129) }],
      [
        "account bytes",
        {
          ...f.input,
          source: { ...f.input.source, accountId: "a".repeat(513) },
        },
      ],
      [
        "external bytes",
        {
          ...f.input,
          source: { ...f.input.source, externalId: "e".repeat(2_049) },
        },
      ],
      ["title bytes", { ...f.input, title: "t".repeat(2_049) }],
      [
        "URL bytes",
        { ...f.input, url: `https://example.test/${"u".repeat(2_049)}` },
      ],
      ["request UTF-16", { ...f.input, requestId: "request-\ud800" }],
      [
        "account UTF-16",
        {
          ...f.input,
          source: { ...f.input.source, accountId: "account-\ud800" },
        },
      ],
      [
        "external UTF-16",
        {
          ...f.input,
          source: { ...f.input.source, externalId: "external-\ud800" },
        },
      ],
      ["title UTF-16", { ...f.input, title: "title-\ud800" }],
      ["URL UTF-16", { ...f.input, url: "https://example.test/\ud800" }],
    ];
    for (const [label, input] of invalid) {
      expect(() => validateEnqueueUrlInput(input), label).toThrow();
    }
    expect(
      await f.t.run((ctx) => ctx.db.query("sourceFetchRequests").collect()),
    ).toEqual([]);
  });

  test("accepts the documented title bound without publishing it as fetched metadata", async () => {
    const f = await fixture();
    const title = "t".repeat(2_048);
    const queued = await f.t.run((ctx) =>
      enqueueSourceFetch(ctx, {
        principal: f.principal,
        input: { ...f.input, title },
        now: 1_000,
      }),
    );
    const stored = await f.t.run(async (ctx) => ({
      request: await ctx.db.get(queued.fetchRequestId),
      item: await ctx.db.get(queued.sourceItemId),
    }));
    expect(stored.request?.title).toBe(title);
    expect(stored.item?.title).toBeUndefined();
  });

  test("a forgotten source cannot be replayed or resurrected", async () => {
    const f = await fixture();
    const first = await f.t.run((ctx) =>
      enqueueSourceFetch(ctx, {
        principal: f.principal,
        input: f.input,
        now: 1_000,
      }),
    );
    await f.t.run((ctx) =>
      ctx.db.patch(first.sourceItemId, {
        lifecycle: "forgotten",
        originalLinkAvailable: false,
        forgottenAt: 1_500,
        forgottenBy: f.userId,
      }),
    );
    await expect(
      f.t.run((ctx) =>
        enqueueSourceFetch(ctx, {
          principal: f.principal,
          input: f.input,
          now: 2_000,
        }),
      ),
    ).rejects.toThrow("Source item is forgotten");
    await expect(
      f.t.run((ctx) =>
        enqueueSourceFetch(ctx, {
          principal: f.principal,
          input: { ...f.input, requestId: "request-2" },
          now: 2_000,
        }),
      ),
    ).rejects.toThrow("Source item is forgotten");
    expect(
      await f.t.run((ctx) => ctx.db.query("sourceFetchRequests").collect()),
    ).toHaveLength(1);
  });
});
