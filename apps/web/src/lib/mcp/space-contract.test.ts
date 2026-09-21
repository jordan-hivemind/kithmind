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
import {
  syntheticFinanceReadExchanges,
  syntheticFinanceTrustedContext,
} from "@repo/finance-contract/fixtures";
import { IdentityError } from "@repo/kith-store/identity";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

import type { FinanceArchiveAccess } from "./finance";
import { mcpPrincipalLoader } from "./principal";
import { createMcpServer, type McpServerCredential } from "./server";

const credential: McpServerCredential = {
  surface: "postgres",
  withPrincipal: mcpPrincipalLoader({
    userId: "user-test",
    credentialId: "key-test",
  }),
};

async function call(
  name: string,
  args: Record<string, unknown>,
  financeArchive: FinanceArchiveAccess | null = null,
  principalId = "user-test:key-test",
) {
  const server = createMcpServer(credential, principalId, financeArchive);
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
          "listDocumentSchemas",
          "getDocumentExtractionStatus",
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
    mocks.reads.listDocumentSchemas!.mockResolvedValue({ rows: [], isDone: true });
    mocks.reads.getDocumentExtractionStatus!.mockResolvedValue({ items: [] });
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

  test("get_document bridges a stable source item without calling it a document id", async () => {
    mocks.reads.getDocument!.mockResolvedValue({
      sourceItemId: "source-item",
      documents: [],
    });
    const result = await call("get_document", { sourceItemId: "source-item" });
    expect(result.isError).not.toBe(true);
    expect(mocks.reads.getDocument).toHaveBeenCalledWith({
      sourceItemId: "source-item",
      spaceIds: undefined,
    });
  });

  test.each([
    ["search_facts", { query: "clinic" }, "searchFacts"],
    ["search_documents", { query: "clinic" }, "searchDocuments"],
    ["get_document", { documentId: "document" }, "getDocument"],
    ["list_document_schemas", {}, "listDocumentSchemas"],
    [
      "get_document_extraction_status",
      { sourceItemIds: ["source-item"] },
      "getDocumentExtractionStatus",
    ],
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

// The boundary `registerTool` puts on every handler.
//
// The SDK's tool-call catch sends a thrown error's own `message` to the client,
// so the property under test is one property for every tool: whatever a store,
// a driver or `pg` puts in that message, the client is told "Internal error"
// and nothing else. The four tools that used to carry a `try`/`catch` for the
// space denial are no longer a separate case, which is why the read rows below
// include both a tool that had one and tools that never did.
describe("MCP tool error masking", () => {
  const LEAK = "relation kith.thoughts does not exist for sensitive-space-id";

  const factArgs = {
    subject: { kind: "person", name: "Alex" },
    predicate: "favorite_color",
    value: { type: "text", value: "blue" },
    sourceType: "user_stated",
  };
  const ingestArgs = {
    requestId: "request-1",
    source: {
      connector: "mcp-client",
      accountId: "account-1",
      externalId: "external-1",
    },
    url: "https://example.test/synthetic",
  };
  const recordQuery = {
    operation: "latest_observation",
    spaceId: "sensitive-space-id",
    entityId: "entity-1",
    observationType: "lab_result",
  };

  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const method of [
      "listSpaces",
      "searchDocuments",
      "browseRecent",
      "searchThoughts",
      "queryRecords",
      "authorizedSpaceIds",
    ]) {
      mocks.reads[method] = vi.fn();
    }
    for (const method of ["rememberFact", "captureThought", "ingestUrl"]) {
      mocks.writes[method] = vi.fn();
    }
    mocks.reads.authorizedSpaceIds!.mockResolvedValue([]);
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logged.mockRestore();
  });

  test.each([
    ["reads", "search_documents", { query: "clinic" }, "searchDocuments"],
    ["reads", "list_spaces", {}, "listSpaces"],
    ["reads", "search_thoughts", { query: "ledger" }, "searchThoughts"],
    ["reads", "browse_recent", {}, "browseRecent"],
    ["writes", "remember_fact", factArgs, "rememberFact"],
    [
      "writes",
      "capture_thought",
      { content: "One decision." },
      "captureThought",
    ],
    ["writes", "ingest_url", ingestArgs, "ingestUrl"],
    ["records", "query_records", { query: recordQuery }, "queryRecords"],
  ] as const)(
    "%s: %s masks an unexpected failure",
    async (family, toolName, args, method) => {
      const target = family === "writes" ? mocks.writes : mocks.reads;
      target[method]!.mockRejectedValueOnce(new Error(LEAK));

      const result = await call(toolName, args);

      expect(result.isError).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("sensitive-space-id");
      expect(serialized).not.toContain("kith.thoughts");
      expect(result.content).toEqual([
        { type: "text", text: "Internal error" },
      ]);
    },
  );

  test("finance: query_records masks an archive failure", async () => {
    // The archive leg keeps its own closed-code mapping, so what a non-contract
    // failure becomes is the bare archive text and never the archive's own
    // words. Same property, different fixed string.
    const archiveSpace = syntheticFinanceTrustedContext.authorizedSpaceIds[0]!;
    mocks.reads.authorizedSpaceIds!.mockResolvedValue([archiveSpace]);
    const request = syntheticFinanceReadExchanges.find(
      (exchange) => exchange.request.operation === "list_transactions",
    )!.request;

    const result = await call(
      "query_records",
      { query: { provider: "finance_archive", request } },
      {
        spaceId: archiveSpace,
        read: async () => {
          throw new Error(LEAK);
        },
      },
      syntheticFinanceTrustedContext.principalId,
    );

    // The exact text also proves the archive was reached: an authorization
    // refusal would have answered with a closed code instead.
    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "the financial archive failed to serve this request",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-space-id");
  });

  test.each([
    ["list_spaces", {}, "listSpaces"],
    ["browse_recent", {}, "browseRecent"],
  ] as const)(
    "%s reports a revoked credential with the same words",
    async (toolName, args, method) => {
      // Consistency is the point. `list_spaces` routed its errors through the
      // space-denial helper and `browse_recent` did not, so the same revocation
      // used to reach a client as two different answers.
      mocks.reads[method]!.mockRejectedValueOnce(
        new IdentityError("Not authenticated"),
      );

      const result = await call(toolName, args);

      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Not authenticated" }],
      });
    },
  );

  test("a write denial keeps the store's non-enumerating words", async () => {
    mocks.writes.rememberFact!.mockRejectedValueOnce(
      new IdentityError("Space not found"),
    );

    const result = await call("remember_fact", {
      ...factArgs,
      spaceId: "sensitive-space-id",
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Space not found" }],
    });
  });

  test("the masked original reaches the server log, without the request", async () => {
    mocks.reads.listSpaces!.mockRejectedValueOnce(new Error(LEAK));

    await call("list_spaces", { spaceIds: ["sensitive-space-id"] });

    expect(logged).toHaveBeenCalledWith("MCP tool error", {
      tool: "list_spaces",
      name: "Error",
      message: LEAK,
    });
  });

  test("a message that merely contains a safe literal is still masked", async () => {
    mocks.reads.listSpaces!.mockRejectedValueOnce(
      new Error("Space not found: sensitive-space-id"),
    );

    const result = await call("list_spaces", {});

    expect(result.content).toEqual([{ type: "text", text: "Internal error" }]);
    expect(JSON.stringify(result)).not.toContain("sensitive-space-id");
  });
});
