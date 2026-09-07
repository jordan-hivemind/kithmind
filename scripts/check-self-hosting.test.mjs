import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatIssues,
  parseArguments,
  validateConvexVariableNames,
  validateWebEnvironment,
} from "./check-self-hosting.mjs";

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

function validWebEnvironment() {
  return {
    NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
    MCP_JWT_ISSUER: "https://brain.example.test",
    MCP_JWT_PRIVATE_JWK: privateJwk,
    MCP_JWT_PUBLIC_JWK: publicJwk,
    MCP_JWT_KEY_ID: "mcp-test",
    MCP_OAUTH_ENCRYPTION_KEY: "A".repeat(43),
    MCP_TOOL_PROFILE: "memory",
  };
}

function runCli(arguments_) {
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./check-self-hosting.mjs", import.meta.url)),
      ...arguments_,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...validWebEnvironment() },
    },
  );
}

test("self-hosting preflight runs when invoked through a symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "kithmind-preflight-"));
  const script = fileURLToPath(
    new URL("./check-self-hosting.mjs", import.meta.url),
  );
  const link = join(directory, "check-self-hosting.mjs");
  try {
    symlinkSync(realpathSync(script), link);
    const result = spawnSync(process.execPath, [link, "--web"], {
      encoding: "utf8",
      env: { ...process.env, ...validWebEnvironment() },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /web: ready/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("web preflight accepts complete configuration", () => {
  assert.deepEqual(validateWebEnvironment(validWebEnvironment()), []);
});

test("web preflight accepts an empty tool profile as the default", () => {
  const environment = validWebEnvironment();
  environment.MCP_TOOL_PROFILE = "";

  assert.deepEqual(validateWebEnvironment(environment), []);
});

test("web preflight returns names only for missing variables", () => {
  assert.deepEqual(validateWebEnvironment({}), [
    { name: "NEXT_PUBLIC_CONVEX_URL", problem: "missing" },
    { name: "MCP_JWT_ISSUER", problem: "missing" },
    { name: "MCP_JWT_PRIVATE_JWK", problem: "missing" },
    { name: "MCP_JWT_PUBLIC_JWK", problem: "missing" },
    { name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "missing" },
  ]);
});

test("web preflight rejects malformed and mismatched values", () => {
  const environment = validWebEnvironment();
  environment.MCP_JWT_ISSUER = "http://public.example.test";
  environment.MCP_JWT_PUBLIC_JWK = JSON.stringify({
    ...JSON.parse(publicJwk),
    y: `${"D".repeat(42)}M`,
  });
  environment.MCP_OAUTH_ENCRYPTION_KEY = "short";
  environment.MCP_TOOL_PROFILE = "everything";

  assert.deepEqual(validateWebEnvironment(environment), [
    { name: "MCP_JWT_ISSUER", problem: "invalid" },
    { name: "MCP_JWT_PRIVATE_JWK", problem: "invalid" },
    { name: "MCP_JWT_PUBLIC_JWK", problem: "invalid" },
    { name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "invalid" },
    { name: "MCP_TOOL_PROFILE", problem: "invalid" },
  ]);
});

test("formatted output cannot include a rejected secret value", () => {
  const secretValue = "a-secret-that-must-not-appear";
  const environment = validWebEnvironment();
  environment.MCP_JWT_PRIVATE_JWK = secretValue;

  const output = formatIssues("web", validateWebEnvironment(environment)).join(
    "\n",
  );
  assert.match(output, /web: invalid MCP_JWT_PRIVATE_JWK/u);
  assert.doesNotMatch(output, new RegExp(secretValue, "u"));
});

test("Convex preflight checks names without needing values", () => {
  assert.deepEqual(
    validateConvexVariableNames(["OPENAI_API_KEY", "MCP_JWT_ISSUER"]),
    [
      { name: "ANTHROPIC_API_KEY", problem: "missing" },
      { name: "SITE_URL", problem: "missing" },
      { name: "JWT_PRIVATE_KEY", problem: "missing" },
      { name: "JWKS", problem: "missing" },
    ],
  );
});

test("full is the default profile and preserves provider requirements", () => {
  assert.equal(parseArguments(["--convex"]).profile, "full");
  assert.deepEqual(
    validateConvexVariableNames([
      "MCP_JWT_ISSUER",
      "SITE_URL",
      "JWT_PRIVATE_KEY",
      "JWKS",
    ]),
    [
      { name: "OPENAI_API_KEY", problem: "missing" },
      { name: "ANTHROPIC_API_KEY", problem: "missing" },
    ],
  );
});

test("core profile requires auth configuration without model providers", () => {
  const options = parseArguments(["--convex", "--profile", "core"]);
  assert.equal(options.profile, "core");
  assert.deepEqual(
    validateConvexVariableNames(
      ["MCP_JWT_ISSUER", "SITE_URL", "JWT_PRIVATE_KEY", "JWKS"],
      options.profile,
    ),
    [],
  );
});

test("web environment file alias avoids Node's reserved option", () => {
  assert.equal(
    parseArguments(["--web-env-file", "synthetic.env"]).envFile,
    "synthetic.env",
  );
});

test("core profile reports missing authentication variables", () => {
  assert.deepEqual(validateConvexVariableNames(["MCP_JWT_ISSUER"], "core"), [
    { name: "SITE_URL", problem: "missing" },
    { name: "JWT_PRIVATE_KEY", problem: "missing" },
    { name: "JWKS", problem: "missing" },
  ]);
});

test("invalid or missing profiles are rejected without echoing other input", () => {
  assert.throws(() => parseArguments(["--profile", "enterprise-secret"]), {
    message: "--profile must be core or full",
  });
  assert.throws(() => parseArguments(["--profile"]), {
    message: "--profile must be core or full",
  });
  assert.throws(() => validateConvexVariableNames([], "enterprise-secret"), {
    message: "--profile must be core or full",
  });
});

test("CLI output identifies core mode and its configuration-only scope", () => {
  const result = runCli([
    "--web",
    "--web-env-file",
    "missing-synthetic-environment-file",
    "--profile",
    "core",
  ]);
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    [
      "profile: core",
      "core: validates configuration only; live source access is not checked",
      "web: ready",
      "",
    ].join("\n"),
  );
});

test("CLI output identifies the default full profile", () => {
  const result = runCli(["--web"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "profile: full\nweb: ready\n");
  assert.doesNotMatch(result.stdout, /configuration only/u);
});
