import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  action: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = mocks.query;
    action = mocks.action;
    mutation = mocks.mutation;
    setAuth() {}
  },
}));
import { createMcpServer } from "./server";

async function call(name: string, args: Record<string, unknown>) {
  const server = createMcpServer("signed-test-token");
  const client = new Client({ name: "space-contract", version: "1" });
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

describe("MCP space routing", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    vi.resetAllMocks();
    mocks.query.mockResolvedValue([]);
    mocks.action.mockResolvedValue([]);
    mocks.mutation.mockResolvedValue({ factId: "fact", operation: "stored" });
  });
  afterEach(() => vi.unstubAllEnvs());

  test.each([
    ["search_facts", { query: "clinic" }],
    ["search_thoughts", { query: "decision" }],
    ["recall_context", { query: "What did we decide?" }],
    ["browse_recent", { type: "decision", topic: "home" }],
    ["get_thoughts", { ids: ["thought"] }],
    ["timeline_thoughts", { aroundMs: 1000 }],
    ["get_stats", {}],
  ])("forwards selected spaces through %s", async (name, args) => {
    const result = await call(name, { ...args, spaceIds: ["selected-space"] });
    expect(result.isError).not.toBe(true);
    const calls = [...mocks.query.mock.calls, ...mocks.action.mock.calls];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, input] of calls)
      expect(input.spaceIds).toEqual(["selected-space"]);
    if (name === "browse_recent")
      expect(calls[0]?.[1]).toMatchObject({ type: "decision", topic: "home" });
  });

  test("preserves the selected space through recall hydration and output", async () => {
    mocks.action.mockImplementation(async (fn) =>
      getFunctionName(fn).endsWith(":search")
        ? [
            {
              _id: "thought",
              spaceId: "shared",
              userId: "author",
              summary: "Decision",
              snippet: "Decision",
              type: "decision",
              topics: [],
              score: 1,
              createdAt: 1000,
              memoryStatus: "current",
            },
          ]
        : [
            {
              _id: "thought",
              spaceId: "shared",
              userId: "author",
              content: "Decision",
              metadata: {
                type: "decision",
                topics: [],
                people: [],
                actionItems: [],
                summary: "Decision",
              },
              createdAt: 1000,
              memoryStatus: "current",
            },
          ],
    );
    const result = await call("recall_context", {
      query: "Decision",
      spaceIds: ["shared"],
    });
    expect(result.isError).not.toBe(true);
    const hydration = mocks.action.mock.calls.find(([fn]) =>
      getFunctionName(fn).endsWith(":getByIds"),
    );
    expect(hydration?.[1]).toMatchObject({
      spaceIds: ["shared"],
      ids: ["thought"],
    });
    expect(JSON.stringify(result.content)).toContain("spaceId");
    expect(JSON.stringify(result.content)).toContain("author");
  });

  test("forwards explicit write destinations", async () => {
    await call("remember_fact", {
      spaceId: "shared",
      subject: { kind: "person", name: "Alex" },
      predicate: "favorite_color",
      value: { type: "text", value: "blue" },
      sourceType: "user_stated",
    });
    expect(mocks.mutation.mock.calls[0]?.[1].spaceId).toBe("shared");
    mocks.action.mockResolvedValue({
      disposition: "skipped",
      metadata: {
        type: "reference",
        topics: [],
        people: [],
        actionItems: [],
        summary: "",
      },
    });
    await call("capture_thought", {
      spaceId: "shared",
      content: "One synthetic decision.",
      sourceType: "user_stated",
    });
    expect(mocks.action.mock.calls[0]?.[1].spaceId).toBe("shared");
  });

  test("lists server-authorized spaces without caller identity arguments", async () => {
    mocks.query.mockResolvedValue([
      { spaceId: "shared", name: "Family", kind: "shared", role: "reader" },
    ]);
    const result = await call("list_spaces", {});
    expect(mocks.query.mock.calls[0]?.[1]).toEqual({});
    expect(JSON.stringify(result.content)).toContain("Family");
  });
});
