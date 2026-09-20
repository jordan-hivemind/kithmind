import { describe, expect, test } from "vitest";

import { kithSessionConfig } from "./session";

const secret = "s".repeat(32);

describe("web session cookie environment", () => {
  test("uses secure host cookies in production only", () => {
    expect(kithSessionConfig({ KITH_SESSION_SECRET: secret }).secure).toBe(
      true,
    );
    expect(
      kithSessionConfig({ KITH_SESSION_SECRET: secret, NODE_ENV: "production" })
        .secure,
    ).toBe(true);
    expect(
      kithSessionConfig({
        KITH_SESSION_SECRET: secret,
        NODE_ENV: "development",
      }).secure,
    ).toBe(false);
    expect(
      kithSessionConfig({ KITH_SESSION_SECRET: secret, NODE_ENV: "test" })
        .secure,
    ).toBe(false);
  });
});
