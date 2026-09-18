import { describe, expect, it } from "vitest";

import {
  assertMcpEnvironment,
  requiredMcpEnvironmentVariables,
  validateMcpEnvironment,
} from "./environment";

/** A complete deployment, as i7b leaves it: no Convex, no JWT bridge. */
function validEnvironment(): Record<string, string> {
  return {
    MCP_PUBLIC_ORIGIN: "https://brain.example.test",
    MCP_OAUTH_ENCRYPTION_KEY: "A".repeat(43),
    MCP_TOOL_PROFILE: "memory",
    KITH_DATABASE_URL: "postgres://example.test/kith",
    KITH_SESSION_SECRET: "s".repeat(32),
  };
}

describe("validateMcpEnvironment", () => {
  it("accepts a complete production configuration", () => {
    expect(validateMcpEnvironment(validEnvironment())).toEqual([]);
    expect(() => assertMcpEnvironment(validEnvironment())).not.toThrow();
  });

  it("accepts an empty tool profile as the full-profile default", () => {
    const environment = validEnvironment();
    environment.MCP_TOOL_PROFILE = "";

    expect(validateMcpEnvironment(environment)).toEqual([]);
  });

  it("accepts HTTP only for loopback development origins", () => {
    const environment = validEnvironment();
    environment.MCP_PUBLIC_ORIGIN = "http://localhost:3000";

    expect(validateMcpEnvironment(environment)).toEqual([]);
  });

  it("reports missing variables by name without including values", () => {
    expect(validateMcpEnvironment({})).toEqual([
      { name: "MCP_PUBLIC_ORIGIN", problem: "missing" },
      { name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "missing" },
      { name: "KITH_DATABASE_URL", problem: "missing" },
      { name: "KITH_SESSION_SECRET", problem: "missing" },
    ]);
  });

  it("rejects malformed origins, keys and profiles", () => {
    const environment = validEnvironment();
    environment.MCP_PUBLIC_ORIGIN = "https://brain.example.test/path";
    environment.MCP_OAUTH_ENCRYPTION_KEY = "too-short";
    environment.MCP_TOOL_PROFILE = "everything";

    expect(validateMcpEnvironment(environment)).toEqual([
      { name: "MCP_PUBLIC_ORIGIN", problem: "invalid" },
      { name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "invalid" },
      { name: "MCP_TOOL_PROFILE", problem: "invalid" },
    ]);
  });

  // i7b: the JWT bridge and the Convex client are gone, so their variables are
  // neither required nor validated. A deployment that still has them set is not
  // reported, because nothing reads them and an issue about an unread variable
  // sends an operator to fix the wrong thing.
  it("ignores the variables i7b removed, set or not", () => {
    const environment = validEnvironment();
    environment.NEXT_PUBLIC_CONVEX_URL = "not-an-origin";
    environment.MCP_JWT_ISSUER = "not-an-origin";
    environment.MCP_JWT_PRIVATE_JWK = "not-json";
    environment.MCP_JWT_PUBLIC_JWK = "not-json";
    environment.MCP_JWT_KEY_ID = "contains spaces";
    environment.KITH_POSTGRES_SURFACE = "convex";

    expect(validateMcpEnvironment(environment)).toEqual([]);
  });

  it("lists exactly the names it requires", () => {
    expect(requiredMcpEnvironmentVariables()).toEqual([
      "MCP_OAUTH_ENCRYPTION_KEY",
      "MCP_PUBLIC_ORIGIN",
      "KITH_DATABASE_URL",
      "KITH_SESSION_SECRET",
    ]);
    // The listing and the validator have to agree: every name above is one the
    // validator reports missing from an empty environment, and no other.
    expect(
      validateMcpEnvironment({})
        .map((issue) => issue.name)
        .sort(),
    ).toEqual([...requiredMcpEnvironmentVariables()].sort());
  });

  it("rejects a malformed kith value", () => {
    const environment = validEnvironment();
    environment.KITH_DATABASE_URL = "not-a-connection-string";
    environment.KITH_SESSION_SECRET = "s".repeat(31);

    expect(validateMcpEnvironment(environment)).toEqual([
      { name: "KITH_DATABASE_URL", problem: "invalid" },
      { name: "KITH_SESSION_SECRET", problem: "invalid" },
    ]);
  });

  it("names the kith variables without returning their values", () => {
    const environment = validEnvironment();
    environment.KITH_DATABASE_URL = "postgres://owner:do-not-leak@host/kith";
    environment.KITH_SESSION_SECRET = "short";

    const issues = validateMcpEnvironment(environment);
    expect(issues).toEqual([
      { name: "KITH_SESSION_SECRET", problem: "invalid" },
    ]);
    expect(JSON.stringify(issues)).not.toContain("do-not-leak");
    try {
      assertMcpEnvironment(environment);
    } catch (error) {
      expect(String(error)).not.toContain("do-not-leak");
      expect(String(error)).not.toContain("short");
    }
  });

  it("names the origin variable without returning its value", () => {
    const environment = validEnvironment();
    environment.MCP_PUBLIC_ORIGIN = "https://do-not-leak.example.test/path";

    const issues = validateMcpEnvironment(environment);
    expect(issues).toEqual([
      { name: "MCP_PUBLIC_ORIGIN", problem: "invalid" },
    ]);
    expect(JSON.stringify(issues)).not.toContain("do-not-leak");
  });

  it("throws an error containing names only", () => {
    const secretValue = "do-not-leak-this-value";
    const environment = validEnvironment();
    environment.MCP_OAUTH_ENCRYPTION_KEY = secretValue;

    expect(() => assertMcpEnvironment(environment)).toThrow(
      "invalid: MCP_OAUTH_ENCRYPTION_KEY",
    );
    try {
      assertMcpEnvironment(environment);
    } catch (error) {
      expect(String(error)).not.toContain(secretValue);
    }
  });
});
