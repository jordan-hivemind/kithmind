// The MCP gateway's configuration, validated by name and never by value.
//
// Section 3.4 of the web and MCP surface plan, plus question 5, which the owner
// answered "rename": the public origin is `MCP_PUBLIC_ORIGIN`. That variable is
// not the JWT issuer that happened to share its name. It is the origin this
// gateway is published at -- the `WWW-Authenticate` resource metadata URL, the
// OAuth metadata documents and the resource identifier -- and it outlived the
// JWT bridge i7b deleted.
//
// i7b also removed `NEXT_PUBLIC_CONVEX_URL` and the four `MCP_JWT_*` names from
// this file. Nothing in `apps/web` reads Convex or mints a token for it any
// more, and validating a variable no process reads sends an operator to fix the
// wrong thing. `KITH_POSTGRES_SURFACE` is gone from here for the same reason:
// there is one surface, so the flag that chose between two selects nothing.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

type Environment = Readonly<Record<string, string | undefined>>;

/** What this deployment cannot run without. Section 3.4. */
const REQUIRED = [
  "MCP_OAUTH_ENCRYPTION_KEY",
  "MCP_PUBLIC_ORIGIN",
  "KITH_DATABASE_URL",
  "KITH_SESSION_SECRET",
] as const;

export type McpEnvironmentVariable =
  | (typeof REQUIRED)[number]
  | "MCP_TOOL_PROFILE";

/**
 * The names a deployment must set.
 *
 * Exported so a health response or a deployment check can list them without
 * restating them, and so there is one source for the set.
 */
export function requiredMcpEnvironmentVariables(): readonly McpEnvironmentVariable[] {
  return REQUIRED;
}

/** What `KITH_SESSION_SECRET` must be, restated from `lib/kith/session.ts`. */
const MIN_KITH_SESSION_SECRET_LENGTH = 32;

function isPostgresConnectionString(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

export type McpEnvironmentIssue = {
  name: McpEnvironmentVariable;
  problem: "missing" | "invalid";
};

export function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function isAllowedOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const isSecure = url.protocol === "https:";
    const isLoopbackDevelopmentOrigin =
      url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);

    return (
      (isSecure || isLoopbackDevelopmentOrigin) &&
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

/**
 * Validates the complete Next.js MCP gateway configuration without returning
 * or interpolating any configured values. This is safe to expose from a
 * health check or log because issues contain variable names only.
 */
export function validateMcpEnvironment(
  environment: Environment = process.env,
): McpEnvironmentIssue[] {
  const issues: McpEnvironmentIssue[] = [];

  const origin = environment.MCP_PUBLIC_ORIGIN;
  if (!origin) {
    issues.push({ name: "MCP_PUBLIC_ORIGIN", problem: "missing" });
  } else if (!isAllowedOrigin(origin)) {
    issues.push({ name: "MCP_PUBLIC_ORIGIN", problem: "invalid" });
  }

  const encryptionKey = environment.MCP_OAUTH_ENCRYPTION_KEY;
  if (!encryptionKey) {
    issues.push({ name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "missing" });
  } else if (!BASE64URL_32_BYTES.test(encryptionKey)) {
    issues.push({ name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "invalid" });
  }

  const toolProfile = environment.MCP_TOOL_PROFILE;
  if (
    toolProfile !== undefined &&
    toolProfile !== "" &&
    toolProfile !== "memory" &&
    toolProfile !== "full"
  ) {
    issues.push({ name: "MCP_TOOL_PROFILE", problem: "invalid" });
  }

  const databaseUrl = environment.KITH_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    issues.push({ name: "KITH_DATABASE_URL", problem: "missing" });
  } else if (!isPostgresConnectionString(databaseUrl)) {
    issues.push({ name: "KITH_DATABASE_URL", problem: "invalid" });
  }

  const sessionSecret = environment.KITH_SESSION_SECRET;
  if (sessionSecret === undefined || sessionSecret === "") {
    issues.push({ name: "KITH_SESSION_SECRET", problem: "missing" });
  } else if (sessionSecret.length < MIN_KITH_SESSION_SECRET_LENGTH) {
    issues.push({ name: "KITH_SESSION_SECRET", problem: "invalid" });
  }

  return issues;
}

export function assertMcpEnvironment(
  environment: Environment = process.env,
): void {
  const issues = validateMcpEnvironment(environment);
  if (issues.length > 0) {
    const summary = issues
      .map(({ name, problem }) => `${problem}: ${name}`)
      .join(", ");
    throw new Error(`Invalid MCP environment configuration (${summary})`);
  }
}

/**
 * The origin this gateway is published at.
 *
 * Named for what it is rather than for the JWT claim it used to fill. Neither
 * error carries the configured value.
 */
export function getMcpPublicOrigin(): string {
  const value = process.env.MCP_PUBLIC_ORIGIN;
  if (!value) {
    throw new Error("MCP_PUBLIC_ORIGIN is not set");
  }
  if (!isAllowedOrigin(value)) {
    throw new Error(
      "MCP_PUBLIC_ORIGIN must be an HTTPS origin without a path or trailing slash",
    );
  }
  return new URL(value).origin;
}

export function getMcpResourceUri(): string {
  return `${getMcpPublicOrigin()}/api/mcp`;
}

export function isMcpResourceUri(value: string): boolean {
  try {
    const resource = new URL(value);
    return (
      !resource.username &&
      !resource.password &&
      !resource.search &&
      !resource.hash &&
      `${resource.origin}${resource.pathname}` === getMcpResourceUri()
    );
  } catch {
    return false;
  }
}
