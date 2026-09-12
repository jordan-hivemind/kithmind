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
  const server = createMcpServer("signed-test-token", "user-test");
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

const spaceReadErrorData = {
  type: "space_read_error",
  code: "space_not_found",
  message: "Space not found",
} as const;

function convexFailure(data: unknown) {
  return Object.assign(new Error("[Request ID: synthetic] Server Error"), {
    data,
  });
}

describe("MCP space routing", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    vi.resetAllMocks();
    mocks.query.mockResolvedValue([]);
    mocks.action.mockImplementation(async (fn) =>
      getFunctionName(fn).endsWith(":searchWithStatus")
        ? { results: [], vectorStatus: "unavailable" }
        : [],
    );
    mocks.mutation.mockResolvedValue({ factId: "fact", operation: "stored" });
  });
  afterEach(() => vi.unstubAllEnvs());

  test("document evidence and partial status pass through without reinterpretation", async () => {
    const evidence = {
      documentId: "document",
      historical: true,
      contentStatus: "stale",
      originalLinkAvailable: false,
      retainedTextAvailable: true,
      pages: [{ text: "Synthetic retained evidence" }],
    };
    mocks.query.mockResolvedValue(evidence);
    const result = await call("get_document", {
      documentId: "document",
      includeHistorical: true,
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
      documentId: "document",
      includeHistorical: true,
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(evidence) },
    ]);
  });

  test.each([
    ["search_facts", { query: "clinic" }],
    ["search_documents", { query: "clinic" }],
    ["get_document", { documentId: "document" }],
    ["list_sources", {}],
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

  test("forwards provider-free keyword document search mode", async () => {
    const result = await call("search_documents", {
      query: "clinic",
      searchMode: "keyword",
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.action).toHaveBeenCalledWith(expect.anything(), {
      query: "clinic",
      searchMode: "keyword",
    });
  });

  test("preserves the selected space through recall hydration and output", async () => {
    mocks.action.mockImplementation(async (fn) =>
      getFunctionName(fn).endsWith(":searchWithStatus")
        ? {
            vectorStatus: "unavailable",
            results: [
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
            ],
          }
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

  test("empty keyword fallback preserves vector availability status", async () => {
    const result = await call("search_thoughts", {
      query: "synthetic missing",
    });
    expect(result.isError).not.toBe(true);
    expect(
      JSON.parse((result.content as Array<{ text: string }>)[0]!.text),
    ).toMatchObject({ results: [], vectorStatus: "unavailable" });
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

  test.each([
    ["list_spaces", "query", {}],
    ["search_documents", "action", { query: "clinic" }],
  ] as const)(
    "%s returns the safe typed read denial",
    async (toolName, method, args) => {
      mocks[method].mockRejectedValueOnce(convexFailure(spaceReadErrorData));

      const result = await call(toolName, args);

      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Space not found" }],
      });
      expect(result.content).toHaveLength(1);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("Request ID");
      expect(serialized).not.toContain("Server Error");
      expect(serialized).not.toContain("space_read_error");
      expect(serialized).not.toContain("selected-space");
      expect(serialized).not.toContain("ingest");
    },
  );

  test("does not convert malformed structured errors", async () => {
    mocks.query.mockRejectedValueOnce(
      convexFailure({ ...spaceReadErrorData, spaceId: "sensitive-space-id" }),
    );

    const result = await call("list_spaces", {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "[Request ID: synthetic] Server Error",
      },
    ]);
    expect(JSON.stringify(result.content)).not.toContain("sensitive-space-id");
    expect(JSON.stringify(result.content)).not.toContain("Space not found");
  });
});
