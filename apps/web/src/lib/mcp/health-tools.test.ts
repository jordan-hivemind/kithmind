// Epic MyChart feed: `list_health_records` and `get_health_document` forward
// their exact arguments to `reads.ts` and wrap its answer as MCP content,
// and the server advertises the version this release bumped to. `reads.ts`
// itself (the authorization gate against `admin.healthPersonSpaceId`/
// `healthDocumentSpaceId`) is exercised against a real database by
// `@repo/epic-feed`'s own Postgres test, not re-proven here with a mock.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reads: {
    listHealthRecords: vi.fn(),
    getHealthDocument: vi.fn(),
  },
}));

vi.mock("./reads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reads")>();
  return { ...actual, postgresReads: () => mocks.reads };
});

import type { WithMcpPrincipal } from "./principal";
import { createMcpServer } from "./server";

async function withClient(run: (client: Client) => Promise<void>) {
  const server = createMcpServer(
    {
      surface: "postgres",
      withPrincipal: (() => {
        throw new Error("mocked health tools must not load a principal");
      }) as unknown as WithMcpPrincipal,
    },
    "health-tools-test",
  );
  const client = new Client({ name: "health-tools-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP health tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reads.listHealthRecords.mockResolvedValue({ records: [], nextCursor: null });
    mocks.reads.getHealthDocument.mockResolvedValue(null);
  });

  test("advertises the Epic MyChart release version", async () => {
    await withClient(async (client) => {
      expect(client.getServerVersion()?.version).toBe("1.5.0");
    });
  });

  test("list_health_records forwards personId, resourceType, since and limit", async () => {
    mocks.reads.listHealthRecords.mockResolvedValue({
      records: [{ id: "record-1", resourceType: "Observation" }],
      nextCursor: null,
    });
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "list_health_records",
        arguments: {
          personId: "person-1",
          resourceType: "Observation",
          since: "2026-01-01",
          limit: 25,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(mocks.reads.listHealthRecords).toHaveBeenCalledWith({
        personId: "person-1",
        resourceType: "Observation",
        since: "2026-01-01",
        limit: 25,
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            records: [{ id: "record-1", resourceType: "Observation" }],
            nextCursor: null,
          }),
        },
      ]);
    });
  });

  test("list_health_records works with only the required personId", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "list_health_records",
        arguments: { personId: "person-1" },
      });
      expect(result.isError).not.toBe(true);
      expect(mocks.reads.listHealthRecords).toHaveBeenCalledWith({ personId: "person-1" });
    });
  });

  test("get_health_document forwards documentId and returns null for an unknown document", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "get_health_document",
        arguments: { documentId: "doc-1" },
      });
      expect(result.isError).not.toBe(true);
      expect(mocks.reads.getHealthDocument).toHaveBeenCalledWith({ documentId: "doc-1" });
      expect(result.content).toEqual([{ type: "text", text: "null" }]);
    });
  });

  test("get_health_document returns the document's fields", async () => {
    mocks.reads.getHealthDocument.mockResolvedValue({
      id: "doc-1",
      recordId: "record-1",
      personId: "person-1",
      contentType: "text/plain",
      byteLength: 17,
      text: "Visit went well.",
      storageNote: null,
      createdAt: "2026-09-01T10:00:00Z",
    });
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "get_health_document",
        arguments: { documentId: "doc-1" },
      });
      expect(result.isError).not.toBe(true);
      const [content] = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content!.text)).toMatchObject({
        id: "doc-1",
        text: "Visit went well.",
      });
    });
  });
});
