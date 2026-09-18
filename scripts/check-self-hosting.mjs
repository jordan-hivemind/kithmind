#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/**
 * `apps/web/src/lib/mcp/environment.ts`'s `requiredMcpEnvironmentVariables`,
 * kept here as a second, independent implementation because this script runs
 * standalone against a plain `.env` file rather than importing application
 * TypeScript.
 *
 * i7b dropped `NEXT_PUBLIC_CONVEX_URL` and the four `MCP_JWT_*` names with the
 * last Convex import and the JWT bridge. P2-39m2 removed packages/convex and
 * the `--convex` preflight mode along with it. There is one web surface and
 * one database now, so there is one list.
 */
export const WEB_REQUIRED_VARIABLES = [
  "MCP_OAUTH_ENCRYPTION_KEY",
  "MCP_PUBLIC_ORIGIN",
  "KITH_DATABASE_URL",
  "KITH_SESSION_SECRET",
];

/** `apps/web/src/lib/kith/session.ts`'s own floor, restated for the preflight. */
const MIN_KITH_SESSION_SECRET_LENGTH = 32;

function isAllowedOrigin(value) {
  try {
    const url = new URL(value);
    const allowedProtocol =
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
    return (
      allowedProtocol &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      value === url.origin
    );
  } catch {
    return false;
  }
}

function isPostgresConnectionString(value) {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

/** `--web`'s validation. Issues carry variable names and never their values. */
export function validateWebEnvironment(environment) {
  const issues = [];
  for (const name of WEB_REQUIRED_VARIABLES) {
    if (!environment[name]) issues.push({ name, problem: "missing" });
  }

  if (
    environment.MCP_PUBLIC_ORIGIN &&
    !isAllowedOrigin(environment.MCP_PUBLIC_ORIGIN)
  ) {
    issues.push({ name: "MCP_PUBLIC_ORIGIN", problem: "invalid" });
  }
  if (
    environment.KITH_DATABASE_URL &&
    !isPostgresConnectionString(environment.KITH_DATABASE_URL)
  ) {
    issues.push({ name: "KITH_DATABASE_URL", problem: "invalid" });
  }
  if (
    environment.KITH_SESSION_SECRET &&
    environment.KITH_SESSION_SECRET.length < MIN_KITH_SESSION_SECRET_LENGTH
  ) {
    issues.push({ name: "KITH_SESSION_SECRET", problem: "invalid" });
  }
  if (
    environment.MCP_OAUTH_ENCRYPTION_KEY &&
    !BASE64URL_32_BYTES.test(environment.MCP_OAUTH_ENCRYPTION_KEY)
  ) {
    issues.push({ name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "invalid" });
  }

  if (
    environment.MCP_TOOL_PROFILE !== undefined &&
    environment.MCP_TOOL_PROFILE !== "" &&
    environment.MCP_TOOL_PROFILE !== "memory" &&
    environment.MCP_TOOL_PROFILE !== "full"
  ) {
    issues.push({ name: "MCP_TOOL_PROFILE", problem: "invalid" });
  }

  return issues;
}

export function formatIssues(scope, issues) {
  return issues.map(({ name, problem }) => `${scope}: ${problem} ${name}`);
}

export function parseArguments(arguments_) {
  const options = {
    web: false,
    envFile: "apps/web/.env.local",
    worker: false,
    workerConfig: undefined,
    json: false,
  };
  const seen = new Set();
  const once = (name) => {
    if (seen.has(name)) throw new Error(`Duplicate ${name} option`);
    seen.add(name);
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      once("separator");
      continue;
    } else if (argument === "--web") {
      once("--web");
      options.web = true;
    } else if (argument === "--env-file" || argument === "--web-env-file") {
      once("--web-env-file");
      options.envFile = arguments_[index + 1];
      index += 1;
      if (!options.envFile) throw new Error("--env-file requires a path");
    } else if (argument === "--worker") {
      once("--worker");
      options.worker = true;
    } else if (argument === "--config") {
      once("--config");
      options.workerConfig = arguments_[index + 1];
      index += 1;
      if (!options.workerConfig) throw new Error("--config requires a path");
    } else if (argument === "--json") {
      once("--json");
      options.json = true;
    } else if (argument === "--help") {
      once("--help");
      options.help = true;
    } else {
      throw new Error("Unknown option");
    }
  }

  if (!options.web && !options.worker) options.web = true;
  if (
    options.worker &&
    (options.web || seen.has("--web-env-file"))
  ) {
    throw new Error(
      "Worker diagnostics cannot be combined with operator checks",
    );
  }
  if (!options.worker && options.workerConfig !== undefined) {
    throw new Error("--config requires --worker");
  }
  if (!options.worker && options.json) {
    throw new Error("--json requires --worker");
  }
  if (options.help && seen.size !== 1) {
    throw new Error("--help cannot be combined with other options");
  }
  return options;
}

function loadEnvironmentFile(path) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) return;
  try {
    process.loadEnvFile(absolutePath);
  } catch {
    throw new Error(`Unable to load environment file: ${path}`);
  }
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: pnpm check:self-hosting [--web]",
      "",
      "--web                 Validate apps/web/.env.local (default)",
      "--web-env-file PATH   Validate another web environment file",
      "--worker --config PATH Run the scoped pipeline doctor only",
      "--json                Emit the worker doctor JSON unchanged",
    ].join("\n") + "\n",
  );
}

export function runPreflight(options) {
  const results = [];
  if (options.web) {
    loadEnvironmentFile(options.envFile);
    results.push({
      scope: "web",
      issues: validateWebEnvironment(process.env),
    });
  }
  return results;
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

const invokedDirectly = isDirectInvocation();

if (invokedDirectly) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else if (options.worker) {
      if (!options.workerConfig) {
        throw new Error("--worker requires --config PATH");
      }
      const workerArguments = [
        "packages/pipeline/dist/cli.js",
        "doctor",
        "--config",
        options.workerConfig,
        ...(options.json ? ["--json"] : []),
      ];
      const worker = spawnSync(process.execPath, workerArguments, {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (worker.status === null) {
        throw new Error("Worker doctor could not start");
      }
      process.stdout.write(worker.stdout);
      if (worker.status !== 0) {
        process.stderr.write("Worker doctor failed\n");
        process.exitCode = worker.status;
      }
    } else {
      const results = runPreflight(options);
      let hasIssues = false;
      for (const result of results) {
        if (result.issues.length === 0) {
          process.stdout.write(`${result.scope}: ready\n`);
          continue;
        }
        hasIssues = true;
        for (const line of formatIssues(result.scope, result.issues)) {
          process.stdout.write(`${line}\n`);
        }
      }
      if (hasIssues) process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Preflight failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}
