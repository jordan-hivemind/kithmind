import { describe, expect, it } from "vitest";

import { flagTone, pulledStatusText, truncatedDetail } from "./medical-format";

describe("flagTone", () => {
  it("renders no tag when there is no flag", () => {
    expect(flagTone(null)).toBeNull();
    expect(flagTone("")).toBeNull();
  });

  it("treats an explicit normal flag as neutral", () => {
    expect(flagTone("N")).toBe("neutral");
    expect(flagTone("n")).toBe("neutral");
  });

  it("treats any other flag as abnormal", () => {
    expect(flagTone("H")).toBe("warn");
    expect(flagTone("L")).toBe("warn");
    expect(flagTone("A")).toBe("warn");
  });
});

describe("pulledStatusText", () => {
  it("says a source has never pulled rather than showing an empty date", () => {
    expect(pulledStatusText(null)).toBe("Not yet pulled");
  });

  it("states the last pull time when one is available", () => {
    expect(pulledStatusText(Date.parse("2026-09-25T06:00:00Z"))).toContain("Last pulled");
  });
});

describe("truncatedDetail", () => {
  it("omits the tooltip when the summary is already the full list", () => {
    expect(truncatedDetail("Potassium, Sodium", "Potassium, Sodium")).toBeNull();
  });

  it("gives the full list when the summary was truncated", () => {
    expect(truncatedDetail("Potassium, Sodium…", "Potassium, Sodium, Glucose")).toBe(
      "Potassium, Sodium, Glucose",
    );
  });
});
