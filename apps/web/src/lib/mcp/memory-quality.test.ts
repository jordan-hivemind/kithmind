import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { WithMcpPrincipal } from "./principal";
import {
  createMcpServer,
  parseValidityTimestamp,
  parseValidityWindow,
} from "./server";
import { MCP_MEMORY_TOOL_NAMES, MCP_TOOL_ANNOTATIONS } from "./tool-policy";
import { MCP_TOOL_NAME_LIST } from "./tools";

describe("MCP memory quality contract", () => {
  beforeEach(() => {
    delete process.env.MCP_TOOL_PROFILE;
  });

  afterEach(() => {
    delete process.env.MCP_TOOL_PROFILE;
  });

  // Every case below lists tools and reads descriptions, so the loader is
  // never called. It throws rather than returning a stub, so a case that grew
  // a tool call would fail instead of quietly reading nothing.
  const credential = {
    surface: "postgres",
    withPrincipal: (() => {
      throw new Error("no tool call expected in this suite");
    }) as unknown as WithMcpPrincipal,
  } as const;

  test("keeps startup routing compact and publishes on-demand help", async () => {
    const server = createMcpServer(credential, "user-test");
    const client = new Client({ name: "memory-quality-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const instructions = client.getInstructions();
      expect(instructions).toContain("kith://help/start");
      expect(instructions).toContain("get_kith_capabilities");
      expect(instructions).toContain("never interchange");
      expect(instructions!.length).toBeLessThan(1_000);

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain(
        "kith://help/start",
      );
      const start = await client.readResource({ uri: "kith://help/start" });
      expect(JSON.stringify(start.contents)).toContain("Use list_spaces");

      // The default profile is "full": narrowing the surface removes tools
      // that connected clients and the bundled skills already call, so it has
      // to be opted into rather than inherited on upgrade.
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...MCP_TOOL_NAME_LIST].sort(),
      );
      for (const tool of tools) {
        expect(tool.annotations).toEqual(
          MCP_TOOL_ANNOTATIONS[tool.name as keyof typeof MCP_TOOL_ANNOTATIONS],
        );
      }
      const recall = tools.find((tool) => tool.name === "recall_context");
      const capture = tools.find((tool) => tool.name === "capture_thought");
      const rememberFact = tools.find((tool) => tool.name === "remember_fact");
      const searchFacts = tools.find((tool) => tool.name === "search_facts");

      expect(recall).toMatchObject({
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
      expect(recall?.description).toContain(
        "complete current message verbatim",
      );
      expect(recall?.description).toContain("core facts/memories");
      expect(recall?.inputSchema.properties).toHaveProperty("query");
      expect(capture?.description).toContain("one atomic durable narrative");
      expect(capture?.description).toContain("biographies");
      expect(capture?.inputSchema.properties).toHaveProperty("validFrom");
      expect(capture?.inputSchema.properties).toHaveProperty("validTo");
      expect(capture?.inputSchema.properties).toHaveProperty("isCore");
      expect(capture?.inputSchema.properties).toHaveProperty("sourceType");
      expect(capture?.inputSchema.properties).toHaveProperty(
        "content.maxLength",
        2_000,
      );
      expect(searchFacts?.annotations?.readOnlyHint).toBe(true);
      expect(rememberFact?.description).toContain("Never store a derived age");
      expect(rememberFact?.inputSchema.properties).toHaveProperty("subject");
      expect(rememberFact?.inputSchema.properties).toHaveProperty("predicate");
      expect(rememberFact?.inputSchema.properties).toHaveProperty("value");
      expect(capture?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });

      const help = await client.callTool({
        name: "get_kith_help",
        arguments: { topic: "corrections" },
      });
      expect(JSON.stringify(help.content)).toContain("sourceItemId");
      expect(JSON.stringify(help.content)).toContain("exactRecordStatus");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("narrows to the memory surface only when explicitly opted in", async () => {
    process.env.MCP_TOOL_PROFILE = "memory";
    const server = createMcpServer(credential, "user-test");
    const client = new Client({ name: "memory-profile-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...MCP_MEMORY_TOOL_NAMES].sort(),
      );
      for (const tool of tools) {
        expect(tool.annotations).toEqual(
          MCP_TOOL_ANNOTATIONS[tool.name as keyof typeof MCP_TOOL_ANNOTATIONS],
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("parses explicit validity dates without using local server time", () => {
    expect(parseValidityTimestamp("2026-08-10")).toBe(Date.UTC(2026, 7, 10));
    expect(parseValidityTimestamp("2026-08-10T15:30:00-07:00")).toBe(
      Date.parse("2026-08-10T22:30:00Z"),
    );
    expect(parseValidityWindow("2026-08-10", "2026-08-11")).toEqual({
      validFrom: Date.UTC(2026, 7, 10),
      validTo: Date.UTC(2026, 7, 11),
    });
  });

  test("rejects inferred-local, impossible, and non-positive validity windows", () => {
    expect(() => parseValidityTimestamp("2026-08-10T15:30:00")).toThrow(
      "timezone-qualified datetime",
    );
    expect(() => parseValidityTimestamp("2026-02-30")).toThrow(
      "not a real calendar date",
    );
    expect(() => parseValidityTimestamp("next Tuesday")).toThrow(
      "ISO-8601 date",
    );
    expect(() => parseValidityWindow("2026-08-11", "2026-08-10")).toThrow(
      "validFrom must be earlier than validTo",
    );
    expect(() => parseValidityWindow("2026-08-10", "2026-08-10")).toThrow(
      "validFrom must be earlier than validTo",
    );
  });
});
