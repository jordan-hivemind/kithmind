import { describe, expect, it } from "vitest";

import {
  MCP_MEMORY_TOOL_NAMES,
  MCP_TOOL_ANNOTATIONS,
  resolveEnabledMcpToolNames,
  resolveMcpToolProfile,
} from "./tool-policy";
import { MCP_TOOL_NAME_LIST, MCP_TOOL_NAMES } from "./tools";

// The insights and lists tools are a separate, full-profile-only feature
// area (README: "`create_list`, `get_open_items`, and the list tools |
// Simple shared lists"), so their read-only members are exempt from the
// memory-profile check below.
const FULL_PROFILE_ONLY_READ_ONLY_TOOLS = new Set<string>([
  MCP_TOOL_NAMES.getInsights,
  MCP_TOOL_NAMES.getLists,
  MCP_TOOL_NAMES.getList,
  MCP_TOOL_NAMES.getOpenItems,
]);

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

  it("exposes every read-only memory/document tool in the memory profile", () => {
    const readOnlyTools = Object.entries(MCP_TOOL_ANNOTATIONS)
      .filter(([, annotations]) => annotations.readOnlyHint)
      .map(([name]) => name)
      .filter((name) => !FULL_PROFILE_ONLY_READ_ONLY_TOOLS.has(name));

    for (const name of readOnlyTools) {
      expect(MCP_MEMORY_TOOL_NAMES).toContain(name);
    }
  });
});
