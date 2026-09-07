import { describe, expect, it } from "vitest";

import { sourceAccountGrantsForCapabilities } from "./api-key-scopes";

describe("sourceAccountGrantsForCapabilities", () => {
  it("does not submit stale source grants after ingest is removed", () => {
    expect(
      sourceAccountGrantsForCapabilities(["read", "write"], ["source-1"]),
    ).toEqual([]);
  });

  it("retains explicit source grants for ingest credentials", () => {
    expect(
      sourceAccountGrantsForCapabilities(["ingest"], ["source-1"]),
    ).toEqual(["source-1"]);
  });
});
