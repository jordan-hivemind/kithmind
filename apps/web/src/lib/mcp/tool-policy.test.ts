import { describe, expect, it } from "vitest";

import {
  MCP_MEMORY_TOOL_NAMES,
  MCP_TOOL_ANNOTATIONS,
  mcpToolAnnotations,
  resolveEnabledMcpToolNames,
  resolveMcpToolProfile,
} from "./tool-policy";
import { MCP_TOOL_NAME_LIST } from "./tools";

describe("MCP tool profile", () => {
  it("defaults to the full surface so upgrades do not remove tools", () => {
    expect(resolveMcpToolProfile(undefined)).toBe("full");
    expect(resolveMcpToolProfile("")).toBe("full");
    expect(resolveMcpToolProfile("full")).toBe("full");
  });

  it("narrows only on an explicit opt-in", () => {
    expect(resolveMcpToolProfile("memory")).toBe("memory");
  });

  it("rejects unrecognised values rather than guessing", () => {
    expect(() => resolveMcpToolProfile("minimal")).toThrow(
      'MCP_TOOL_PROFILE must be either "memory" or "full"',
    );
  });

  it("resolves the enabled set that discovery and the drift check read", () => {
    expect([...resolveEnabledMcpToolNames("full")].sort()).toEqual(
      [...MCP_TOOL_NAME_LIST].sort(),
    );
    expect([...resolveEnabledMcpToolNames("memory")].sort()).toEqual(
      [...MCP_MEMORY_TOOL_NAMES].sort(),
    );
  });

  it("keeps every annotation identical on the Convex surface", () => {
    for (const name of MCP_TOOL_NAME_LIST) {
      expect(mcpToolAnnotations(name, "convex")).toEqual(
        MCP_TOOL_ANNOTATIONS[name],
      );
    }
  });

  it("drops only capture_thought's idempotent hint on PostgreSQL", () => {
    // The hint says a repeat is safe. On PostgreSQL nothing detects a repeat
    // until the admission gate is ported, so a host that retried a timed-out
    // call would store the memory twice. Every other tool is unchanged, and
    // the difference is one field: the surface must not become a licence to
    // re-annotate the table.
    for (const name of MCP_TOOL_NAME_LIST) {
      const annotations = mcpToolAnnotations(name, "postgres");
      if (name === "capture_thought") {
        expect(annotations).toEqual({
          ...MCP_TOOL_ANNOTATIONS[name],
          idempotentHint: false,
        });
      } else {
        expect(annotations, name).toEqual(MCP_TOOL_ANNOTATIONS[name]);
      }
    }
  });

  it("exposes every read-only memory/document tool in the memory profile", () => {
    const readOnlyTools = Object.entries(MCP_TOOL_ANNOTATIONS)
      .filter(([, annotations]) => annotations.readOnlyHint)
      .map(([name]) => name);

    for (const name of readOnlyTools) {
      expect(MCP_MEMORY_TOOL_NAMES).toContain(name);
    }
  });
});
