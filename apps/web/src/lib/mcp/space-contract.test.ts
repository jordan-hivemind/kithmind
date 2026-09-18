// What the tool layer does with a caller's space selection and with a denial.
//
// i7b repointed this from the Convex client to the PostgreSQL `McpReads` and
// `McpWrites` seam, which is what `createMcpServer` builds its tools over now.
// The two properties are the same ones the Convex version held and they belong
// to `server.ts` rather than to a backend: a caller's `spaceIds` reaches the
// read unchanged and is never dropped, and the one typed read denial is
// reported as "Space not found" and nothing else. Anything that is not that
// denial is a defect and must not be laundered into an authorization answer.
//
// The reads are stubbed on purpose. What the store then does with a space set
// is asserted against a real database in `postgres-reads.test.ts`; this suite
// runs without one.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IdentityError } from "@repo/kith-store/identity";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reads: {} as Record<string, ReturnType<typeof vi.fn>>,
  writes: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("./reads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reads")>();
  return { ...actual, postgresReads: () => mocks.reads };
});
vi.mock("./writes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./writes")>();
  return { ...actual, postgresWrites: () => mocks.writes };
});

import { mcpPrincipalLoader } from "./principal";
import { createMcpServer, type McpServerCredential } from "./server";

const credential: McpServerCredential = {
  surface: "postgres",
  withPrincipal: mcpPrincipalLoader({
    userId: "user-test",
    credentialId: "key-test",
  }),
};

async function call(name: string, args: Record<string, unknown>) {
  const server = createMcpServer(credential, "user-test:key-test", null);
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

/** The denial `spaceReadNotFound()` throws, restated rather than imported. */
function spaceNotFound() {
  return new IdentityError("Space not found", {
    type: "space_read_error",
    code: "space_not_found",
    message: "Space not found",
  } as ConstructorParameters<typeof IdentityError>[1]);
}

describe("MCP space routing", () => {
  beforeEach(() => {
    for (const [target, methods] of [
      [
        mocks.reads,
        [
          "listSpaces",
          "queryRecords",
          "searchDocuments",
          "getDocument",
          "listSources",
          "listInventory",
          "listReviewQueue",
          "searchFacts",
          "searchThoughts",
          "recallContext",
          "browseRecent",
          "getThoughts",
          "timelineThoughts",
          "getStats",
          "authorizedSpaceIds",
        ],
      ],
      [mocks.writes, ["ingestUrl", "rememberFact", "captureThought"]],
    ] as const) {
      for (const method of methods) target[method] = vi.fn();
    }
    mocks.reads.listSpaces!.mockResolvedValue([]);
    mocks.reads.authorizedSpaceIds!.mockResolvedValue([]);
    mocks.reads.searchFacts!.mockResolvedValue([]);
    mocks.reads.browseRecent!.mockResolvedValue([]);
    mocks.reads.getThoughts!.mockResolvedValue([]);
    mocks.reads.timelineThoughts!.mockResolvedValue([]);
    mocks.reads.getStats!.mockResolvedValue({});
    mocks.reads.getDocument!.mockResolvedValue({});
    mocks.reads.searchDocuments!.mockResolvedValue({ results: [] });
    mocks.reads.listSources!.mockResolvedValue({ sources: {} });
    mocks.reads.listInventory!.mockResolvedValue({});
    mocks.reads.listReviewQueue!.mockResolvedValue({});
    mocks.reads.searchThoughts!.mockResolvedValue({
      results: [],
      vectorStatus: "unavailable",
    });
    mocks.reads.recallContext!.mockResolvedValue({
      coreFacts: [],
      coreThoughts: [],
      relevanceFacts: [],
      relevanceThoughts: [],
      vectorStatus: "unavailable",
      empty: true,
    });
    mocks.writes.rememberFact!.mockResolvedValue({
      factId: "fact",
      operation: "stored",
    });
    mocks.writes.captureThought!.mockResolvedValue({
      disposition: "skipped",
      metadata: {
        type: "reference",
        topics: [],
        people: [],
        actionItems: [],
        summary: "",
      },
    });
  });

  test("document evidence and partial status pass through without reinterpretation", async () => {
    const evidence = {
      documentId: "document",
      historical: true,
      contentStatus: "stale",
      originalLinkAvailable: false,
      retainedTextAvailable: true,
      pages: [{ text: "Synthetic retained evidence" }],
    };
    mocks.reads.getDocument!.mockResolvedValue(evidence);
    const result = await call("get_document", {
      documentId: "document",
      includeHistorical: true,
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.reads.getDocument).toHaveBeenCalledWith({
      documentId: "document",
      includeHistorical: true,
      spaceIds: undefined,
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(evidence) },
    ]);
  });

  test.each([
    ["search_facts", { query: "clinic" }, "searchFacts"],
    ["search_documents", { query: "clinic" }, "searchDocuments"],
    ["get_document", { documentId: "document" }, "getDocument"],
    ["list_sources", {}, "listSources"],
    ["list_inventory", { sourceAccountId: "account" }, "listInventory"],
    ["list_review_queue", { sourceAccountId: "account" }, "listReviewQueue"],
    ["search_thoughts", { query: "decision" }, "searchThoughts"],
    ["recall_context", { query: "What did we decide?" }, "recallContext"],
    ["browse_recent", { type: "decision", topic: "home" }, "browseRecent"],
    ["get_thoughts", { ids: ["thought"] }, "getThoughts"],
    ["timeline_thoughts", { aroundMs: 1000 }, "timelineThoughts"],
    ["get_stats", {}, "getStats"],
  ])("forwards selected spaces through %s", async (name, args, method) => {
    const result = await call(name, { ...args, spaceIds: ["selected-space"] });
    expect(result.isError).not.toBe(true);
    const calls = mocks.reads[method]!.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [input] of calls) {
      expect(input.spaceIds).toEqual(["selected-space"]);
    }
    if (name === "browse_recent") {
      expect(calls[0]?.[0]).toMatchObject({ type: "decision", topic: "home" });
    }
  });

  test("forwards provider-free keyword document search mode", async () => {
    const result = await call("search_documents", {
      query: "clinic",
      searchMode: "keyword",
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.reads.searchDocuments).toHaveBeenCalledWith({
      query: "clinic",
      searchMode: "keyword",
      spaceIds: undefined,
    });
  });

  test("forwards inventory filters and the source account id unchanged", async () => {
    const result = await call("list_inventory", {
      sourceAccountId: "account-1",
      folderPath: "reports",
      limit: 5,
      cursor: "opaque-cursor",
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.reads.listInventory).toHaveBeenCalledWith({
      sourceAccountId: "account-1",
      folderPath: "reports",
      limit: 5,
      cursor: "opaque-cursor",
      spaceIds: undefined,
    });
  });

  test("forwards the review queue class and the source account id unchanged", async () => {
    const result = await call("list_review_queue", {
      sourceAccountId: "account-1",
      class: "field_dropped",
      limit: 5,
      cursor: "opaque-cursor",
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.reads.listReviewQueue).toHaveBeenCalledWith({
      sourceAccountId: "account-1",
      class: "field_dropped",
      limit: 5,
      cursor: "opaque-cursor",
      spaceIds: undefined,
    });
  });

  test("preserves the selected space through recall output", async () => {
    mocks.reads.recallContext!.mockResolvedValue({
      coreFacts: [],
      coreThoughts: [],
      relevanceFacts: [],
      relevanceThoughts: [
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
          score: 1,
        },
      ],
      vectorStatus: "unavailable",
      empty: false,
    });
    const result = await call("recall_context", {
      query: "Decision",
      spaceIds: ["shared"],
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.reads.recallContext!.mock.calls[0]?.[0]).toMatchObject({
      spaceIds: ["shared"],
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
    expect(mocks.writes.rememberFact!.mock.calls[0]?.[0].spaceId).toBe(
      "shared",
    );

    await call("capture_thought", {
      spaceId: "shared",
      content: "One synthetic decision.",
      sourceType: "user_stated",
    });
    expect(mocks.writes.captureThought!.mock.calls[0]?.[0].spaceId).toBe(
      "shared",
    );
  });

  test("lists server-authorized spaces without caller identity arguments", async () => {
    mocks.reads.listSpaces!.mockResolvedValue([
      { spaceId: "shared", name: "Family", kind: "shared", role: "reader" },
    ]);
    const result = await call("list_spaces", {});
    expect(mocks.reads.listSpaces!.mock.calls[0]).toEqual([]);
    expect(JSON.stringify(result.content)).toContain("Family");
  });

  test.each([
    ["list_spaces", "listSpaces", {}],
    ["search_documents", "searchDocuments", { query: "clinic" }],
  ] as const)(
    "%s returns the safe typed read denial",
    async (toolName, method, args) => {
      mocks.reads[method]!.mockRejectedValueOnce(spaceNotFound());

      const result = await call(toolName, args);

      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Space not found" }],
      });
      expect(result.content).toHaveLength(1);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("space_read_error");
      expect(serialized).not.toContain("selected-space");
      expect(serialized).not.toContain("ingest");
    },
  );

  test("does not convert an error that is not the typed denial", async () => {
    // A bug must not arrive at a client as an authorization answer, and the
    // space id it carried must not arrive at all.
    mocks.reads.listSpaces!.mockRejectedValueOnce(
      new IdentityError("internal failure on sensitive-space-id"),
    );

    const result = await call("list_spaces", {});

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("Space not found");
    expect(JSON.stringify(result.content)).not.toContain("sensitive-space-id");
  });
});
