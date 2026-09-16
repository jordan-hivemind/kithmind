// The MCP gateway's configuration, validated by name and never by value.
//
// Section 3.4 of the web and MCP surface plan, plus question 5, which the owner
// answered "rename": the public origin is `MCP_PUBLIC_ORIGIN` from i2 onward.
// That variable is not the JWT issuer that happened to share its name. It is the
// origin this gateway is published at -- the `WWW-Authenticate` resource
// metadata URL, the OAuth metadata documents and the resource identifier -- and
// it outlives the JWT bridge that i7 deletes.
//
// The rename is therefore a read preference rather than a cutover:
//
//   * `MCP_PUBLIC_ORIGIN` is read first, in both surface modes.
//   * Under `convex`, `MCP_JWT_ISSUER` is still accepted when the new name is
//     absent, and `validateMcpEnvironment` reports that by name as `deprecated`
//     so the deployment is told to move it without being called misconfigured.
//   * Under `postgres`, `MCP_PUBLIC_ORIGIN` is required. There is no signer left
//     to share a name with, so accepting the old one would only preserve the
//     confusion the rename exists to end.
//
// Only the variable that is actually read is validated. A `MCP_JWT_ISSUER` left
// behind under `postgres` is not reported, because nothing reads it and an issue
// about an unread variable sends an operator to fix the wrong thing.

import { kithPostgresSurface, type PostgresSurface } from "@/lib/kith/surface";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const KEY_ID = /^[A-Za-z0-9._~-]{1,128}$/;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Required in every deployment, whichever surface it reads.
 *
 * `NEXT_PUBLIC_CONVEX_URL` is still here under `postgres`, deliberately: i2
 * moves authentication off Convex and leaves the 17 tools on it until i3 and i4.
 * A `postgres` deployment that dropped the variable today would authenticate and
 * then fail at the first tool call. i7 removes it from this list, because i7 is
 * the slice that removes the last Convex import from `apps/web`.
 */
const ALWAYS_REQUIRED = [
  "NEXT_PUBLIC_CONVEX_URL",
  "MCP_OAUTH_ENCRYPTION_KEY",
] as const;

/**
 * The JWT bridge's key material. Required only under `convex`.
 *
 * i7 deletes all four `MCP_JWT_*` variables together with `convex-auth.ts`, the
 * JWKS route and `auth.config.ts`. i2 stops requiring them on the surface that
 * has neither a signer nor a verifier, and stops nothing else: the bridge must
 * keep working under `convex` until the pages move, which is what the dark
 * deploy is for.
 */
const CONVEX_ONLY_REQUIRED = [
  "MCP_JWT_PRIVATE_JWK",
  "MCP_JWT_PUBLIC_JWK",
] as const;

/** What the PostgreSQL surface cannot run without. Section 3.4. */
const POSTGRES_ONLY_REQUIRED = [
  "KITH_DATABASE_URL",
  "KITH_SESSION_SECRET",
] as const;

export type McpEnvironmentVariable =
  | (typeof ALWAYS_REQUIRED)[number]
  | (typeof CONVEX_ONLY_REQUIRED)[number]
  | (typeof POSTGRES_ONLY_REQUIRED)[number]
  | "MCP_PUBLIC_ORIGIN"
  | "MCP_JWT_ISSUER"
  | "MCP_JWT_KEY_ID"
  | "MCP_TOOL_PROFILE"
  | "KITH_POSTGRES_SURFACE";

/**
 * The names a deployment must set, for the surface it is configured to read.
 *
 * Exported so a health response or a deployment check can list them without
 * reimplementing the surface rule, and so the rename has one source.
 *
 * The public origin is one entry with two acceptable names under `convex` and
 * one under `postgres`, which is exactly what `validateMcpEnvironment` accepts.
 * A flat list that always said `MCP_PUBLIC_ORIGIN` would tell an operator a
 * working deployment is missing a variable the validator is happy without.
 */
export function requiredMcpEnvironmentVariables(
  environment: Environment = process.env,
): readonly (McpEnvironmentVariable | readonly McpEnvironmentVariable[])[] {
  const onPostgres = kithPostgresSurface(environment) === "postgres";
  return [
    ...ALWAYS_REQUIRED,
    onPostgres
      ? "MCP_PUBLIC_ORIGIN"
      : (["MCP_PUBLIC_ORIGIN", "MCP_JWT_ISSUER"] as const),
    ...(onPostgres ? POSTGRES_ONLY_REQUIRED : CONVEX_ONLY_REQUIRED),
  ];
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

/**
 * What is wrong with a variable.
 *
 * `deprecated` is the third kind and the only non-blocking one: the value is
 * present, valid and being read, under a name i7 removes.
 * `assertMcpEnvironment` and the health route ignore it, because a deployment
 * that works must not be reported as broken for using the old spelling.
 *
 * `scope` is what stops the notice from being read as "remove this variable".
 * `MCP_JWT_ISSUER` is set on two deployments. On the web deployment it is the
 * old spelling of the public origin and `MCP_PUBLIC_ORIGIN` replaces it. On the
 * Convex deployment `auth.config.ts` still reads it, and drops the customJwt
 * provider entirely when it is absent, which would break every MCP tool call
 * under `convex`. The notice names the web deployment and says to leave the
 * Convex one alone until i7 deletes the bridge.
 */
export type McpEnvironmentIssue = {
  name: McpEnvironmentVariable;
  problem: "missing" | "invalid" | "deprecated";
  /** Present on a `deprecated` notice: which deployment it is about. */
  scope?: "web-deployment";
  /** Present on a `deprecated` notice: the one-line instruction. */
  advice?: string;
};

/** The one wording for the rename notice, so it cannot be half-stated. */
export const MCP_JWT_ISSUER_RENAME_ADVICE =
  "Set MCP_PUBLIC_ORIGIN on the web deployment. Keep MCP_JWT_ISSUER set on the Convex deployment until P2-39i7 deletes the JWT bridge.";

type P256JwkCoordinates = {
  x: string;
  y: string;
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

type ResolvedOrigin = {
  /** The variable the value came from, which is the name any issue carries. */
  name: "MCP_PUBLIC_ORIGIN" | "MCP_JWT_ISSUER";
  value: string;
};

/**
 * The public origin and the variable it was read from, or null.
 *
 * One function, used by both the validator and `getMcpPublicOrigin`, so the
 * fallback cannot be accepted in one place and refused in the other.
 */
function resolvePublicOrigin(
  environment: Environment,
  surface: PostgresSurface,
): ResolvedOrigin | null {
  const preferred = environment.MCP_PUBLIC_ORIGIN;
  if (preferred) return { name: "MCP_PUBLIC_ORIGIN", value: preferred };
  if (surface === "postgres") return null;
  const legacy = environment.MCP_JWT_ISSUER;
  return legacy ? { name: "MCP_JWT_ISSUER", value: legacy } : null;
}

function parseP256Jwk(
  value: string,
  privateKey: boolean,
): P256JwkCoordinates | undefined {
  try {
    const key = JSON.parse(value) as Record<string, unknown>;
    if (
      !key ||
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

/**
 * Validates the complete Next.js MCP gateway configuration without returning
 * or interpolating any configured values. This is safe to expose from a
 * health check or log because issues contain variable names only.
 */
export function validateMcpEnvironment(
  environment: Environment = process.env,
): McpEnvironmentIssue[] {
  const issues: McpEnvironmentIssue[] = [];

  const surfaceValue = environment.KITH_POSTGRES_SURFACE;
  const surfaceIsNamed =
    surfaceValue === undefined ||
    surfaceValue === "" ||
    surfaceValue === "convex" ||
    surfaceValue === "postgres";
  const surface = kithPostgresSurface(environment);
  const onPostgres = surface === "postgres";

  const convexUrl = environment.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    issues.push({ name: "NEXT_PUBLIC_CONVEX_URL", problem: "missing" });
  } else if (!isAllowedOrigin(convexUrl)) {
    issues.push({ name: "NEXT_PUBLIC_CONVEX_URL", problem: "invalid" });
  }

  const origin = resolvePublicOrigin(environment, surface);
  if (!origin) {
    issues.push({ name: "MCP_PUBLIC_ORIGIN", problem: "missing" });
  } else {
    if (!isAllowedOrigin(origin.value)) {
      issues.push({ name: origin.name, problem: "invalid" });
    }
    if (origin.name === "MCP_JWT_ISSUER") {
      issues.push({
        name: "MCP_JWT_ISSUER",
        problem: "deprecated",
        scope: "web-deployment",
        advice: MCP_JWT_ISSUER_RENAME_ADVICE,
      });
    }
    // Under `convex` the bridge is still live, and Convex verifies the token
    // against its own `MCP_JWT_ISSUER`. Two names holding two different origins
    // would mean the gateway signs one issuer and Convex expects another, which
    // fails at the first tool call rather than at deployment. Naming it here is
    // the only place that can see both.
    if (
      !onPostgres &&
      origin.name === "MCP_PUBLIC_ORIGIN" &&
      environment.MCP_JWT_ISSUER !== undefined &&
      environment.MCP_JWT_ISSUER !== "" &&
      environment.MCP_JWT_ISSUER !== origin.value
    ) {
      issues.push({ name: "MCP_PUBLIC_ORIGIN", problem: "invalid" });
      issues.push({ name: "MCP_JWT_ISSUER", problem: "invalid" });
    }
  }

  // Present is validated in both modes; required only under `convex`. A key that
  // is malformed now is a key that is still malformed if the flag is flipped
  // back, and reporting it is cheaper than discovering it during a rollback.
  const privateJwkValue = environment.MCP_JWT_PRIVATE_JWK;
  if (!privateJwkValue && !onPostgres) {
    issues.push({ name: "MCP_JWT_PRIVATE_JWK", problem: "missing" });
  }
  const privateJwk = privateJwkValue
    ? parseP256Jwk(privateJwkValue, true)
    : undefined;
  if (privateJwkValue && !privateJwk) {
    issues.push({ name: "MCP_JWT_PRIVATE_JWK", problem: "invalid" });
  }

  const publicJwkValue = environment.MCP_JWT_PUBLIC_JWK;
  if (!publicJwkValue && !onPostgres) {
    issues.push({ name: "MCP_JWT_PUBLIC_JWK", problem: "missing" });
  }
  const publicJwk = publicJwkValue
    ? parseP256Jwk(publicJwkValue, false)
    : undefined;
  if (publicJwkValue && !publicJwk) {
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

  const encryptionKey = environment.MCP_OAUTH_ENCRYPTION_KEY;
  if (!encryptionKey) {
    issues.push({ name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "missing" });
  } else if (!BASE64URL_32_BYTES.test(encryptionKey)) {
    issues.push({ name: "MCP_OAUTH_ENCRYPTION_KEY", problem: "invalid" });
  }

  const keyId = environment.MCP_JWT_KEY_ID;
  if (keyId !== undefined && !KEY_ID.test(keyId)) {
    issues.push({ name: "MCP_JWT_KEY_ID", problem: "invalid" });
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

  if (!surfaceIsNamed) {
    issues.push({ name: "KITH_POSTGRES_SURFACE", problem: "invalid" });
  }

  const databaseUrl = environment.KITH_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    if (onPostgres) {
      issues.push({ name: "KITH_DATABASE_URL", problem: "missing" });
    }
  } else if (!isPostgresConnectionString(databaseUrl)) {
    issues.push({ name: "KITH_DATABASE_URL", problem: "invalid" });
  }

  const sessionSecret = environment.KITH_SESSION_SECRET;
  if (sessionSecret === undefined || sessionSecret === "") {
    if (onPostgres) {
      issues.push({ name: "KITH_SESSION_SECRET", problem: "missing" });
    }
  } else if (sessionSecret.length < MIN_KITH_SESSION_SECRET_LENGTH) {
    issues.push({ name: "KITH_SESSION_SECRET", problem: "invalid" });
  }

  return issues;
}

/** The issues that make a deployment unusable, without the rename notices. */
export function blockingMcpEnvironmentIssues(
  issues: readonly McpEnvironmentIssue[],
): McpEnvironmentIssue[] {
  return issues.filter((issue) => issue.problem !== "deprecated");
}

export function assertMcpEnvironment(
  environment: Environment = process.env,
): void {
  const issues = blockingMcpEnvironmentIssues(
    validateMcpEnvironment(environment),
  );
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
 * Named for what it is rather than for the JWT claim it used to fill. The error
 * names the variable that was read, so an operator who still has the old name
 * configured is told which one the process actually used, and neither error
 * carries the configured value.
 */
export function getMcpPublicOrigin(): string {
  const resolved = resolvePublicOrigin(process.env, kithPostgresSurface());
  if (!resolved) {
    throw new Error("MCP_PUBLIC_ORIGIN is not set");
  }
  if (!isAllowedOrigin(resolved.value)) {
    throw new Error(
      `${resolved.name} must be an HTTPS origin without a path or trailing slash`,
    );
  }
  return new URL(resolved.value).origin;
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
