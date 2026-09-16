// `KITH_POSTGRES_SURFACE`: which backend a ported surface reads.
//
// Section 6 of the web and MCP surface plan makes this the dark-deploy switch
// for every slice of row i: the variable defaults to `convex`, each ported route
// or page reads it once and picks a backend, and the PostgreSQL branch is
// exercised in preview and by tests while production still reads Convex. The
// flag flips in row m.
//
// The plan marks slice i1 "not dark", on the grounds that a browser holds one
// session cookie and the app cannot authenticate two ways at once for one
// request. That is true of one *request* and not of one *build*, and the
// difference decides merge safety: `main` deploys, and i1 lands before the
// pages move in i5, so removing the Convex provider outright would break every
// page that still calls a Convex hook. So i1 ships behind this flag like every
// other slice. The correction is recorded in section 6 of the plan.

export type PostgresSurface = "convex" | "postgres";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The configured surface, defaulting to `convex`.
 *
 * Only the exact string `postgres` selects PostgreSQL. Anything else reads as
 * `convex`, so a typo in the deployment configuration cannot half-enable the
 * new path; `validateMcpEnvironment` reports the typo by name instead, which is
 * where a configuration mistake belongs rather than in a redirect loop.
 */
export function kithPostgresSurface(
  env: Environment = process.env,
): PostgresSurface {
  return env.KITH_POSTGRES_SURFACE === "postgres" ? "postgres" : "convex";
}
