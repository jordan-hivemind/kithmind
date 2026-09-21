import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reads: {
    listProfileFields: vi.fn(),
    getProfile: vi.fn(),
  },
  management: {
    manageProfileEntity: vi.fn(),
  },
}));

vi.mock("./reads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reads")>();
  return { ...actual, postgresReads: () => mocks.reads };
});

vi.mock("./management", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./management")>();
  return { ...actual, postgresManagement: () => mocks.management };
});

import type { WithMcpPrincipal } from "./principal";
import { createMcpServer } from "./server";

async function withClient(run: (client: Client) => Promise<void>) {
  const server = createMcpServer(
    {
      surface: "postgres",
      withPrincipal: (() => {
        throw new Error("mocked profile tools must not load a principal");
      }) as unknown as WithMcpPrincipal,
    },
    "profile-tools-test",
  );
  const client = new Client({ name: "profile-tools-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
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

describe("MCP profile tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reads.listProfileFields.mockResolvedValue({
      fields: [{ predicate: "vin" }],
    });
    mocks.reads.getProfile.mockResolvedValue({
      entity: { id: "entity-id" },
      fields: [],
    });
    mocks.management.manageProfileEntity.mockResolvedValue({
      action: "merge",
      conflicts: [],
    });
  });

  test("discovers the catalog independently of an existing entity", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "list_profile_fields",
        arguments: { kind: "vehicle" },
      });
      expect(result.isError).not.toBe(true);
      expect(mocks.reads.listProfileFields).toHaveBeenCalledWith({
        kind: "vehicle",
      });
      expect(JSON.stringify(result.content)).toContain("vin");

      const help = await client.callTool({
        name: "get_kith_help",
        arguments: { topic: "profiles" },
      });
      expect(JSON.stringify(help.content)).toContain("get_profile");
      expect(JSON.stringify(help.content)).toContain("manage_profile_entity");
      expect(JSON.stringify(help.content)).toContain("retire_fact");
    });
  });

  test("forwards name and relationship profile selectors with an explicit space", async () => {
    await withClient(async (client) => {
      await client.callTool({
        name: "get_profile",
        arguments: {
          spaceId: "space-id",
          selector: { relationship: "daughter" },
        },
      });
      expect(mocks.reads.getProfile).toHaveBeenCalledWith({
        spaceId: "space-id",
        selector: { relationship: "daughter" },
      });
    });
  });

  test("forwards explicit merge and supporting-document actions", async () => {
    await withClient(async (client) => {
      await client.callTool({
        name: "manage_profile_entity",
        arguments: {
          request: {
            action: "merge",
            sourceEntityId: "source-id",
            targetEntityId: "target-id",
          },
        },
      });
      await client.callTool({
        name: "manage_profile_entity",
        arguments: {
          request: {
            action: "link_document",
            entityId: "entity-id",
            sourceItemId: "source-id",
          },
        },
      });
      expect(mocks.management.manageProfileEntity).toHaveBeenNthCalledWith(1, {
        action: "merge",
        sourceEntityId: "source-id",
        targetEntityId: "target-id",
      });
      expect(mocks.management.manageProfileEntity).toHaveBeenNthCalledWith(2, {
        action: "link_document",
        entityId: "entity-id",
        sourceItemId: "source-id",
      });
    });
  });
});
