#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const KEY_ID = /^[A-Za-z0-9._~-]{1,128}$/;

export const WEB_REQUIRED_VARIABLES = [
  "NEXT_PUBLIC_CONVEX_URL",
  "MCP_JWT_ISSUER",
  "MCP_JWT_PRIVATE_JWK",
  "MCP_JWT_PUBLIC_JWK",
  "MCP_OAUTH_ENCRYPTION_KEY",
];

export const CORE_CONVEX_REQUIRED_VARIABLES = [
  "MCP_JWT_ISSUER",
  "SITE_URL",
  "JWT_PRIVATE_KEY",
  "JWKS",
];

export const CONVEX_REQUIRED_VARIABLES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  ...CORE_CONVEX_REQUIRED_VARIABLES,
];

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

function parseP256Jwk(value, privateKey) {
  try {
    const key = JSON.parse(value);
    if (
      !key ||
      typeof key !== "object" ||
      key.kty !== "EC" ||
      key.crv !== "P-256" ||
      typeof key.x !== "string" ||
      !BASE64URL_32_BYTES.test(key.x) ||
      typeof key.y !== "string" ||
      !BASE64URL_32_BYTES.test(key.y) ||
      (privateKey
        ? typeof key.d !== "string" || !BASE64URL_32_BYTES.test(key.d)
        : "d" in key)
    ) {
      return undefined;
    }
    return { x: key.x, y: key.y };
  } catch {
    return undefined;
  }
}

export function validateWebEnvironment(environment) {
  const issues = [];
  for (const name of WEB_REQUIRED_VARIABLES) {
    if (!environment[name]) issues.push({ name, problem: "missing" });
  }

  if (
    environment.NEXT_PUBLIC_CONVEX_URL &&
    !isAllowedOrigin(environment.NEXT_PUBLIC_CONVEX_URL)
  ) {
    issues.push({ name: "NEXT_PUBLIC_CONVEX_URL", problem: "invalid" });
  }
  if (
    environment.MCP_JWT_ISSUER &&
    !isAllowedOrigin(environment.MCP_JWT_ISSUER)
  ) {
    issues.push({ name: "MCP_JWT_ISSUER", problem: "invalid" });
  }

  const privateJwk = environment.MCP_JWT_PRIVATE_JWK
    ? parseP256Jwk(environment.MCP_JWT_PRIVATE_JWK, true)
    : undefined;
  if (environment.MCP_JWT_PRIVATE_JWK && !privateJwk) {
    issues.push({ name: "MCP_JWT_PRIVATE_JWK", problem: "invalid" });
  }

  const publicJwk = environment.MCP_JWT_PUBLIC_JWK
    ? parseP256Jwk(environment.MCP_JWT_PUBLIC_JWK, false)
    : undefined;
  if (environment.MCP_JWT_PUBLIC_JWK && !publicJwk) {
    issues.push({ name: "MCP_JWT_PUBLIC_JWK", problem: "invalid" });
  }

  if (
    privateJwk &&
    publicJwk &&
    (privateJwk.x !== publicJwk.x || privateJwk.y !== publicJwk.y)
  ) {
    issues.push({ name: "MCP_JWT_PRIVATE_JWK", problem: "invalid" });
    issues.push({ name: "MCP_JWT_PUBLIC_JWK", problem: "invalid" });
  }

  if (
    environment.MCP_OAUTH_ENCRYPTION_KEY &&
    !BASE64URL_32_BYTES.test(environment.MCP_OAUTH_ENCRYPTION_KEY)
  ) {
    issues.push({ name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "invalid" });
  }
  if (
    environment.MCP_JWT_KEY_ID !== undefined &&
    !KEY_ID.test(environment.MCP_JWT_KEY_ID)
  ) {
    issues.push({ name: "MCP_JWT_KEY_ID", problem: "invalid" });
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

export function validateConvexVariableNames(names, profile = "full") {
  if (profile !== "core" && profile !== "full") {
    throw new Error("--profile must be core or full");
  }
  const configured = new Set(names);
  const required =
    profile === "core"
      ? CORE_CONVEX_REQUIRED_VARIABLES
      : CONVEX_REQUIRED_VARIABLES;
  return required
    .filter((name) => !configured.has(name))
    .map((name) => ({ name, problem: "missing" }));
}

export function formatIssues(scope, issues) {
  return issues.map(({ name, problem }) => `${scope}: ${problem} ${name}`);
}

export function parseArguments(arguments_) {
  const options = {
    web: false,
    convex: false,
    production: false,
    deployment: undefined,
    envFile: "apps/web/.env.local",
    profile: "full",
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    else if (argument === "--web") options.web = true;
    else if (argument === "--convex") options.convex = true;
    else if (argument === "--prod") options.production = true;
    else if (argument === "--profile") {
      const profile = arguments_[index + 1];
      index += 1;
      if (profile !== "core" && profile !== "full") {
        throw new Error("--profile must be core or full");
      }
      options.profile = profile;
    } else if (argument === "--deployment") {
      options.deployment = arguments_[index + 1];
      index += 1;
      if (!options.deployment) throw new Error("--deployment requires a name");
    } else if (argument === "--env-file" || argument === "--web-env-file") {
      options.envFile = arguments_[index + 1];
      index += 1;
      if (!options.envFile) throw new Error("--env-file requires a path");
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!options.web && !options.convex) options.web = true;
  if (options.production && options.deployment) {
    throw new Error("Use either --prod or --deployment, not both");
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

function getConvexVariableNames(options) {
  const arguments_ = [
    "--filter",
    "@repo/db",
    "exec",
    "convex",
    "env",
    "list",
    "--names-only",
  ];
  if (options.production) arguments_.push("--prod");
  if (options.deployment) {
    arguments_.push("--deployment", options.deployment);
  }

  const result = spawnSync("pnpm", arguments_, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      "Unable to inspect Convex environment names; link the intended deployment first",
    );
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter((name) => /^[A-Z][A-Z0-9_]*$/u.test(name));
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: pnpm check:self-hosting [--web] [--convex] [--prod]",
      "",
      "--web                 Validate apps/web/.env.local (default)",
      "--web-env-file PATH   Validate another web environment file",
      "--convex              Inspect Convex environment names only",
      "--prod                Inspect the default production deployment",
      "--deployment NAME     Inspect a specific Convex deployment",
      "--profile PROFILE     Validate core or full requirements (default: full)",
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
  if (options.convex) {
    results.push({
      scope: "convex",
      issues: validateConvexVariableNames(
        getConvexVariableNames(options),
        options.profile,
      ),
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
    } else {
      process.stdout.write(`profile: ${options.profile}\n`);
      if (options.profile === "core") {
        process.stdout.write(
          "core: validates configuration only; live source access is not checked\n",
        );
      }
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
