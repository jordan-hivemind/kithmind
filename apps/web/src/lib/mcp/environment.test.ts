import { describe, expect, it } from "vitest";

import {
  assertMcpEnvironment,
  MCP_JWT_ISSUER_RENAME_ADVICE,
  requiredMcpEnvironmentVariables,
  validateMcpEnvironment,
} from "./environment";

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

/** A deployment on the new name for the public origin. */
function validEnvironment(): Record<string, string> {
  return {
    NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
    MCP_PUBLIC_ORIGIN: "https://brain.example.test",
    MCP_JWT_PRIVATE_JWK: privateJwk,
    MCP_JWT_PUBLIC_JWK: publicJwk,
    MCP_JWT_KEY_ID: "mcp-test-key",
    MCP_OAUTH_ENCRYPTION_KEY: "A".repeat(43),
    MCP_TOOL_PROFILE: "memory",
  };
}

/** The same deployment before the rename, which must still run under convex. */
function legacyEnvironment(): Record<string, string> {
  const environment = validEnvironment();
  delete environment.MCP_PUBLIC_ORIGIN;
  environment.MCP_JWT_ISSUER = "https://brain.example.test";
  return environment;
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
    environment.MCP_PUBLIC_ORIGIN = "http://localhost:3000";

    expect(validateMcpEnvironment(environment)).toEqual([]);
  });

  it("reports missing variables by name without including values", () => {
    const issues = validateMcpEnvironment({});

    expect(issues).toEqual([
      { name: "NEXT_PUBLIC_CONVEX_URL", problem: "missing" },
      { name: "MCP_PUBLIC_ORIGIN", problem: "missing" },
      { name: "MCP_JWT_PRIVATE_JWK", problem: "missing" },
      { name: "MCP_JWT_PUBLIC_JWK", problem: "missing" },
      { name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "missing" },
    ]);
  });

  it("rejects malformed origins, keys, and key IDs", () => {
    const environment = validEnvironment();
    environment.NEXT_PUBLIC_CONVEX_URL = "http://convex.example.test";
    environment.MCP_PUBLIC_ORIGIN = "https://brain.example.test/path";
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
      { name: "MCP_PUBLIC_ORIGIN", problem: "invalid" },
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

  // Section 3.4 and question 5: `MCP_JWT_ISSUER` becomes `MCP_PUBLIC_ORIGIN`.
  // The old name is still read under `convex`, where the JWT bridge is live, and
  // the change is reported by name so a deployment is told to move it.
  it("accepts the old origin name under convex and reports the rename", () => {
    const environment = legacyEnvironment();

    expect(validateMcpEnvironment(environment)).toEqual([
      {
        name: "MCP_JWT_ISSUER",
        problem: "deprecated",
        scope: "web-deployment",
        advice: MCP_JWT_ISSUER_RENAME_ADVICE,
      },
    ]);
    // A rename notice is not a misconfiguration: the deployment works.
    expect(() => assertMcpEnvironment(environment)).not.toThrow();
  });

  // The notice has to name the deployment it is about. `auth.config.ts` on the
  // Convex deployment still reads `MCP_JWT_ISSUER` and drops the customJwt
  // provider when it is absent, so an operator who read this as "delete the
  // variable" would break every MCP tool call under `convex`.
  it("scopes the rename notice to the web deployment", () => {
    const [notice] = validateMcpEnvironment(legacyEnvironment());

    expect(notice!.scope).toBe("web-deployment");
    expect(notice!.advice).toContain("MCP_PUBLIC_ORIGIN on the web deployment");
    expect(notice!.advice).toContain("Keep MCP_JWT_ISSUER set on the Convex");
    // Still names variables only, no values.
    expect(JSON.stringify(notice)).not.toContain("brain.example.test");
  });

  it("validates the old origin name when it is the one being read", () => {
    const environment = legacyEnvironment();
    environment.MCP_JWT_ISSUER = "https://brain.example.test/path";

    expect(validateMcpEnvironment(environment)).toEqual([
      { name: "MCP_JWT_ISSUER", problem: "invalid" },
      {
        name: "MCP_JWT_ISSUER",
        problem: "deprecated",
        scope: "web-deployment",
        advice: MCP_JWT_ISSUER_RENAME_ADVICE,
      },
    ]);
  });

  it("requires the new origin name under the postgres surface", () => {
    const environment = legacyEnvironment();
    environment.KITH_POSTGRES_SURFACE = "postgres";
    environment.KITH_DATABASE_URL = "postgres://example.test/kith";
    environment.KITH_SESSION_SECRET = "s".repeat(32);

    expect(validateMcpEnvironment(environment)).toEqual([
      { name: "MCP_PUBLIC_ORIGIN", problem: "missing" },
    ]);

    environment.MCP_PUBLIC_ORIGIN = "https://brain.example.test";
    // The leftover old name is not reported: nothing reads it on this surface.
    expect(validateMcpEnvironment(environment)).toEqual([]);
  });

  it("refuses two origin names that disagree while the bridge is live", () => {
    const environment = validEnvironment();
    environment.MCP_JWT_ISSUER = "https://other.example.test";

    expect(validateMcpEnvironment(environment)).toEqual([
      { name: "MCP_PUBLIC_ORIGIN", problem: "invalid" },
      { name: "MCP_JWT_ISSUER", problem: "invalid" },
    ]);

    environment.MCP_JWT_ISSUER = environment.MCP_PUBLIC_ORIGIN!;
    expect(validateMcpEnvironment(environment)).toEqual([]);
  });

  // The JWT bridge is dead under postgres, so its key material is not required
  // there. i7 deletes both variables.
  it("does not require the JWT key material under the postgres surface", () => {
    const environment = validEnvironment();
    environment.KITH_POSTGRES_SURFACE = "postgres";
    environment.KITH_DATABASE_URL = "postgres://example.test/kith";
    environment.KITH_SESSION_SECRET = "s".repeat(32);
    delete environment.MCP_JWT_PRIVATE_JWK;
    delete environment.MCP_JWT_PUBLIC_JWK;
    delete environment.MCP_JWT_KEY_ID;

    expect(validateMcpEnvironment(environment)).toEqual([]);
  });

  // The listing and the validator have to agree. Under `convex` either origin
  // name satisfies the validator, so the listing offers the pair rather than
  // naming a variable a working deployment is happy without.
  it("lists the required names for the configured surface", () => {
    expect(requiredMcpEnvironmentVariables(validEnvironment())).toEqual([
      "NEXT_PUBLIC_CONVEX_URL",
      "MCP_OAUTH_ENCRYPTION_KEY",
      ["MCP_PUBLIC_ORIGIN", "MCP_JWT_ISSUER"],
      "MCP_JWT_PRIVATE_JWK",
      "MCP_JWT_PUBLIC_JWK",
    ]);
    expect(
      requiredMcpEnvironmentVariables({ KITH_POSTGRES_SURFACE: "postgres" }),
    ).toEqual([
      "NEXT_PUBLIC_CONVEX_URL",
      "MCP_OAUTH_ENCRYPTION_KEY",
      "MCP_PUBLIC_ORIGIN",
      "KITH_DATABASE_URL",
      "KITH_SESSION_SECRET",
    ]);
  });

  it("requires nothing the listing does not name, on either surface", () => {
    for (const environment of [legacyEnvironment(), validEnvironment()]) {
      // Every alternative in the listing is accepted by the validator: the
      // legacy environment satisfies the pair with the old name, the current one
      // with the new name, and neither is reported missing.
      expect(
        validateMcpEnvironment(environment).filter(
          (issue) => issue.problem === "missing",
        ),
      ).toEqual([]);
    }
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

  it("names the origin variables without returning their values", () => {
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
