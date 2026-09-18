import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatIssues,
  parseArguments,
  validateWebEnvironment,
  WEB_REQUIRED_VARIABLES,
} from "./check-self-hosting.mjs";

function validWebEnvironment() {
  return {
    MCP_PUBLIC_ORIGIN: "https://brain.example.test",
    MCP_OAUTH_ENCRYPTION_KEY: "A".repeat(43),
    KITH_DATABASE_URL: "postgres://app@127.0.0.1:5432/kith",
    KITH_SESSION_SECRET: "s".repeat(32),
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

function workerFixture(directory) {
  const config = join(directory, "config.json");
  const root = join(directory, "root");
  const journal = join(directory, "journal");
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(
    config,
    JSON.stringify({
      protocolVersion: 1,
      endpoint: "http://127.0.0.1:3100/api/worker",
      spaceId: "space",
      sourceAccountId: "source",
      credentialEnv: "MISSING_SYNTHETIC_TOKEN",
      roots: [{ alias: "test", path: root }],
      journalDir: journal,
    }),
  );
  return { config, root, journal };
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
  assert.deepEqual(
    validateWebEnvironment({}),
    WEB_REQUIRED_VARIABLES.map((name) => ({ name, problem: "missing" })),
  );
});

test("web preflight does not require the deleted JWT bridge or Convex URL", () => {
  // i7b: neither the four `MCP_JWT_*` names nor `NEXT_PUBLIC_CONVEX_URL` is
  // set, and none of them may be reported.
  assert.deepEqual(validateWebEnvironment(validWebEnvironment()), []);
});

test("web preflight rejects malformed values", () => {
  const environment = validWebEnvironment();
  environment.MCP_PUBLIC_ORIGIN = "http://public.example.test";
  environment.KITH_DATABASE_URL = "https://not-a-postgres-url.example.test";
  environment.KITH_SESSION_SECRET = "too-short";
  environment.MCP_OAUTH_ENCRYPTION_KEY = "short";
  environment.MCP_TOOL_PROFILE = "everything";

  assert.deepEqual(validateWebEnvironment(environment), [
    { name: "MCP_PUBLIC_ORIGIN", problem: "invalid" },
    { name: "KITH_DATABASE_URL", problem: "invalid" },
    { name: "KITH_SESSION_SECRET", problem: "invalid" },
    { name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "invalid" },
    { name: "MCP_TOOL_PROFILE", problem: "invalid" },
  ]);
});

test("formatted output cannot include a rejected secret value", () => {
  const secretValue = "a-secret-that-must-not-appear";
  const environment = validWebEnvironment();
  environment.MCP_OAUTH_ENCRYPTION_KEY = secretValue;

  const output = formatIssues("web", validateWebEnvironment(environment)).join(
    "\n",
  );
  assert.match(output, /web: invalid MCP_OAUTH_ENCRYPTION_KEY/u);
  assert.doesNotMatch(output, new RegExp(secretValue, "u"));
});

test("CLI output is ready for a complete environment file", () => {
  const environment = validWebEnvironment();
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./check-self-hosting.mjs", import.meta.url)),
      "--web",
      "--web-env-file",
      "missing-synthetic-environment-file",
    ],
    { encoding: "utf8", env: { ...process.env, ...environment } },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "web: ready\n");
});

test("web environment file alias avoids Node's reserved option", () => {
  assert.equal(
    parseArguments(["--web-env-file", "synthetic.env"]).envFile,
    "synthetic.env",
  );
});

test("worker wrapper arguments reject duplicate and mixed option sets", () => {
  for (const arguments_ of [
    ["--worker", "--worker", "--config", "/tmp/config.json"],
    ["--worker", "--config", "/tmp/a.json", "--config", "/tmp/b.json"],
    ["--worker", "--config", "/tmp/config.json", "--json", "--json"],
    ["--worker", "--config", "/tmp/config.json", "--web"],
    ["--worker", "--config", "/tmp/config.json", "--web-env-file", "/tmp/env"],
    ["--worker", "--config", "/tmp/config.json", "--", "--"],
  ]) {
    assert.throws(() => parseArguments(arguments_));
  }
  assert.throws(() => parseArguments(["--private-value"]), {
    message: "Unknown option",
  });
});

test("CLI output is ready with no profile banner", () => {
  const result = runCli(["--web"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "web: ready\n");
  assert.doesNotMatch(result.stdout, /profile:|configuration only/u);
});

test("worker wrapper emits only one doctor JSON object without web preflight", () => {
  const directory = mkdtempSync(join(tmpdir(), "kithmind-worker-doctor-"));
  try {
    const { config } = workerFixture(directory);
    const result = runCli(["--worker", "--config", config, "--json"]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /profile:/u);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.version, 3);
    assert.equal(parsed.state, "blocked");
    assert.equal(parsed.checks.length, 7);
    assert.doesNotMatch(
      result.stdout,
      new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worker wrapper preserves human mode and redacts bad config path", () => {
  const result = runCli([
    "--worker",
    "--config",
    "/private/synthetic-do-not-print.json",
  ]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /^\{/u);
  assert.match(result.stdout, /config: fail invalid_config/u);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /synthetic-do-not-print/u,
  );
});

test("worker wrapper emits closed JSON for an invalid config", () => {
  const directory = mkdtempSync(join(tmpdir(), "kithmind-worker-invalid-"));
  const config = join(directory, "private-invalid.json");
  try {
    writeFileSync(config, "{not-json");
    const result = runCli(["--worker", "--config", config, "--json"]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.state, "blocked");
    assert.deepEqual(parsed.checks[0], {
      id: "config",
      state: "fail",
      code: "invalid_config",
    });
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-invalid/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pnpm silent doctor alias forwards arguments as one JSON object", () => {
  const directory = mkdtempSync(join(tmpdir(), "kithmind-worker-alias-"));
  try {
    const { config } = workerFixture(directory);
    const repository = fileURLToPath(new URL("..", import.meta.url));
    const result = spawnSync(
      "pnpm",
      ["--silent", "brain:doctor", "--", "--config", config, "--json"],
      {
        cwd: repository,
        encoding: "utf8",
        env: { ...process.env, MISSING_SYNTHETIC_TOKEN: undefined },
      },
    );
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.state, "blocked");
    assert.equal(parsed.checks.length, 7);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.doesNotMatch(result.stdout, /> kithmind@/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
