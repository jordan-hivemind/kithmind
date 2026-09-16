import { describe, expect, it } from "vitest";

import { assertMcpEnvironment, validateMcpEnvironment } from "./environment";

const privateJwk = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: "A".repeat(43),
  y: `${"B".repeat(42)}E`,
  d: `${"C".repeat(42)}I`,
});
const publicJwk = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: "A".repeat(43),
  y: `${"B".repeat(42)}E`,
});

function validEnvironment(): Record<string, string> {
  return {
    NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
    MCP_JWT_ISSUER: "https://brain.example.test",
    MCP_JWT_PRIVATE_JWK: privateJwk,
    MCP_JWT_PUBLIC_JWK: publicJwk,
    MCP_JWT_KEY_ID: "mcp-test-key",
    MCP_OAUTH_ENCRYPTION_KEY: "A".repeat(43),
    MCP_TOOL_PROFILE: "memory",
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
    environment.NEXT_PUBLIC_CONVEX_URL = "http://127.0.0.1:3210";
    environment.MCP_JWT_ISSUER = "http://localhost:3000";

    expect(validateMcpEnvironment(environment)).toEqual([]);
  });

  it("reports missing variables by name without including values", () => {
    const issues = validateMcpEnvironment({});

    expect(issues).toEqual([
      { name: "NEXT_PUBLIC_CONVEX_URL", problem: "missing" },
      { name: "MCP_JWT_ISSUER", problem: "missing" },
      { name: "MCP_JWT_PRIVATE_JWK", problem: "missing" },
      { name: "MCP_JWT_PUBLIC_JWK", problem: "missing" },
      { name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "missing" },
    ]);
  });

  it("rejects malformed origins, keys, and key IDs", () => {
    const environment = validEnvironment();
    environment.NEXT_PUBLIC_CONVEX_URL = "http://convex.example.test";
    environment.MCP_JWT_ISSUER = "https://brain.example.test/path";
    environment.MCP_JWT_PRIVATE_JWK = "not-json";
    environment.MCP_JWT_PUBLIC_JWK = JSON.stringify({
      ...JSON.parse(publicJwk),
      d: "private-material",
    });
    environment.MCP_JWT_KEY_ID = "contains spaces";
    environment.MCP_OAUTH_ENCRYPTION_KEY = "too-short";
    environment.MCP_TOOL_PROFILE = "everything";

    expect(validateMcpEnvironment(environment)).toEqual([
      { name: "NEXT_PUBLIC_CONVEX_URL", problem: "invalid" },
      { name: "MCP_JWT_ISSUER", problem: "invalid" },
      { name: "MCP_JWT_PRIVATE_JWK", problem: "invalid" },
      { name: "MCP_JWT_PUBLIC_JWK", problem: "invalid" },
      { name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "invalid" },
      { name: "MCP_JWT_KEY_ID", problem: "invalid" },
      { name: "MCP_TOOL_PROFILE", problem: "invalid" },
    ]);
  });

  it("rejects a public key that does not match the private key", () => {
    const environment = validEnvironment();
    environment.MCP_JWT_PUBLIC_JWK = JSON.stringify({
      ...JSON.parse(publicJwk),
      x: `${"D".repeat(42)}M`,
    });

    expect(validateMcpEnvironment(environment)).toEqual([
      { name: "MCP_JWT_PRIVATE_JWK", problem: "invalid" },
      { name: "MCP_JWT_PUBLIC_JWK", problem: "invalid" },
    ]);
  });

  // The three variables P2-39i adds (surface plan section 3.4). They are not in
  // the required list while `KITH_POSTGRES_SURFACE` still defaults to `convex`,
  // which is the whole point of the dark deploy.
  it("does not require the kith variables under the convex surface", () => {
    expect(validateMcpEnvironment(validEnvironment())).toEqual([]);

    const convex = validEnvironment();
    convex.KITH_POSTGRES_SURFACE = "convex";
    expect(validateMcpEnvironment(convex)).toEqual([]);
  });

  it("requires the kith variables under the postgres surface", () => {
    const environment = validEnvironment();
    environment.KITH_POSTGRES_SURFACE = "postgres";

    expect(validateMcpEnvironment(environment)).toEqual([
      { name: "KITH_DATABASE_URL", problem: "missing" },
      { name: "KITH_SESSION_SECRET", problem: "missing" },
    ]);

    environment.KITH_DATABASE_URL = "postgres://example.test/kith";
    environment.KITH_SESSION_SECRET = "s".repeat(32);
    expect(validateMcpEnvironment(environment)).toEqual([]);
  });

  it("rejects a malformed kith value in either surface mode", () => {
    for (const surface of ["convex", "postgres"]) {
      const environment = validEnvironment();
      environment.KITH_POSTGRES_SURFACE = surface;
      environment.KITH_DATABASE_URL = "not-a-connection-string";
      // A secret too short to sign with under `convex` is a secret that would
      // still be too short the moment the flag flips, so it is reported now.
      environment.KITH_SESSION_SECRET = "s".repeat(31);

      expect(validateMcpEnvironment(environment)).toEqual([
        { name: "KITH_DATABASE_URL", problem: "invalid" },
        { name: "KITH_SESSION_SECRET", problem: "invalid" },
      ]);
    }
  });

  it("rejects a surface value that is neither backend", () => {
    const environment = validEnvironment();
    environment.KITH_POSTGRES_SURFACE = "postgresql";

    expect(validateMcpEnvironment(environment)).toEqual([
      { name: "KITH_POSTGRES_SURFACE", problem: "invalid" },
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

  it("throws an error containing names only", () => {
    const secretValue = "do-not-leak-this-value";
    const environment = validEnvironment();
    environment.MCP_JWT_PRIVATE_JWK = secretValue;

    expect(() => assertMcpEnvironment(environment)).toThrow(
      "invalid: MCP_JWT_PRIVATE_JWK",
    );
    try {
      assertMcpEnvironment(environment);
    } catch (error) {
      expect(String(error)).not.toContain(secretValue);
    }
  });
});
