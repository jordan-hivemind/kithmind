import { describe, expect, it } from "vitest";

import { valueInformationDetail } from "./institutions-value-info";

describe("valueInformationDetail", () => {
  it("omits the affordance when the row has no additional value information", () => {
    expect(
      valueInformationDetail({
        currentValueAsOf: null,
        currentValueStale: false,
        status: "fresh",
      }),
    ).toBeNull();
  });

  it("keeps an undated stale value accessible", () => {
    expect(
      valueInformationDetail({
        currentValueAsOf: null,
        currentValueStale: true,
        status: "inactive",
      }),
    ).toBe("Reported value is stale. Account is inactive");
  });

  it("states the reported date when it is available", () => {
    expect(
      valueInformationDetail({
        currentValueAsOf: "2026-09-20",
        currentValueStale: false,
        status: "fresh",
      }),
    ).toBe("As of 9-20-2026");
  });
});
