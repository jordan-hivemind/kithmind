// The financial archive as a provider behind this gateway (F1-10), so the
// owner asks one server rather than running a second finance MCP server beside
// it.
//
// The archive owns canonical financial identity (issue 57, boundary agreed in
// #54/#55). Kith Mind consumes its records and retained evidence and does not
// build a competing ledger, so nothing here reshapes, re-groups, re-decimalises
// or merges a row. A finance response reaches the caller as the archive built
// it: coverage, completeness, truncation, issues and evidence intact, money
// still a decimal string. The pinned `NUMERIC` decoding in `createArchivePool`
// is what keeps that last part true at the driver, before any of this code
// sees a value.
//
// Two values configure the provider, and both must be present before a single
// row is served:
//
//   FINANCE_ARCHIVE_READER_DATABASE_URL  the hosted archive, as the reader role
//   FINANCE_ARCHIVE_SPACE_ID             the one space that archive holds
//
// The space id is not redundant configuration. The archive database has no
// space column at all: it holds exactly one space's data and names that space
// in configuration, exactly as `src/mcp/run.ts` does for the standalone
// server. Serving it under whichever authorized space a caller happened to
// name would hand the owner's personal ledger to a shared family space under
// that space's label. So the archive's space is pinned here, membership in
// *that* space is what is checked, and a request naming any other space is
// refused rather than answered.

import { serveFinanceRead } from "@repo/finance-archive/read";
import { createArchivePool } from "@repo/finance-archive/store";
import {
  authorizeFinanceReadRequest,
  FinanceContractError,
  type FinanceReadRequest,
  type FinanceReadResponse,
} from "@repo/finance-contract";

/**
 * The archive this deployment reads, and the one space it holds.
 *
 * `read` is the whole seam. Production supplies the reader-role Postgres
 * connection; a test supplies a fake. There is deliberately no interface
 * beyond this: everything above it is the contract's own types.
 */
export type FinanceArchiveAccess = {
  spaceId: string;
  read(request: FinanceReadRequest): Promise<FinanceReadResponse>;
};

/**
 * The gateway's own authenticated context. Never deserialized from a request
 * body: the principal comes from the validated API key and the space list from
 * Convex membership, checked live on every call.
 */
export type FinanceTrustedGatewayContext = {
  principalId: string;
  authorizedSpaceIds: readonly string[];
};

// ponytail: one module-scoped pool, keyed on nothing, because a serverless
// instance reads its environment once and never changes it. Upgrade path if a
// process ever needs two archives: key the map on the connection string.
let pool: ReturnType<typeof createArchivePool> | undefined;

async function readThroughReaderRole(
  url: string,
  spaceId: string,
  request: FinanceReadRequest,
): Promise<FinanceReadResponse> {
  pool ??= createArchivePool(url);
  // `serveFinanceRead` runs its whole answer inside one REPEATABLE READ, READ
  // ONLY transaction, so it needs a client of its own rather than `pool.query`.
  const client = await pool.connect();
  try {
    return await serveFinanceRead(client, request, spaceId);
  } finally {
    client.release();
  }
}

/**
 * The configured archive, or null when this deployment has none. Null is not a
 * denial and must not be reported as an empty result: a gateway with no archive
 * configured has nothing to say about the money, which is a different answer
 * from "no such record".
 */
export function resolveFinanceArchive(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FinanceArchiveAccess | null {
  const url = env.FINANCE_ARCHIVE_READER_DATABASE_URL;
  const spaceId = env.FINANCE_ARCHIVE_SPACE_ID;
  if (!url || !spaceId) return null;
  return {
    spaceId,
    read: (request) => readThroughReaderRole(url, spaceId, request),
  };
}

/** The archive's own source inventory: sources, record kinds and periods. */
export function financeCoverageRequest(spaceId: string): unknown {
  return {
    contractVersion: 1,
    operation: "get_coverage",
    spaceId,
    limit: 100,
  };
}

/**
 * One authorized finance read.
 *
 * Three checks, none of them the same check twice. The caller must currently
 * be a member of the archive's space, from Convex rather than from anything
 * the caller sent. The contract's own authorization must then accept the
 * request against a trusted context naming only that space, so a request
 * pointing at any other space the caller can read is still refused. And
 * `serveFinanceRead` checks the space once more against the archive it is
 * actually connected to.
 *
 * A refusal throws rather than returning an empty page. On this surface an
 * empty page means "no matching record", and a caller must never be able to
 * read a denial as an absence.
 */
export async function readFinanceArchive(
  archive: FinanceArchiveAccess,
  request: unknown,
  trusted: FinanceTrustedGatewayContext,
): Promise<FinanceReadResponse> {
  if (!trusted.authorizedSpaceIds.includes(archive.spaceId)) {
    throw new FinanceContractError("not_authorized");
  }
  const authorized = authorizeFinanceReadRequest(request, {
    principalId: trusted.principalId,
    authorizedSpaceIds: [archive.spaceId],
  });
  return archive.read(authorized.request);
}
