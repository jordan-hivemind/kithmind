// The financial archive as a provider behind this gateway (F1-10), so the
// owner asks one server rather than running a second finance MCP server beside
// it.
//
// The archive owns canonical financial identity (issue 57, boundary agreed in
// #54/#55). Kith Mind consumes its records and retained evidence and does not
// build a competing ledger. The strict archive response is validated first;
// then the web layer may overlay the owner's descriptive account fields while
// retaining the archive originals in `archiveAccount`. Record rows, coverage,
// completeness, truncation, issues and evidence remain intact, and money stays
// a decimal string. The pinned `NUMERIC` decoding in `createArchivePool` is
// what keeps that last part true at the driver, before any of this code sees a
// value.
//
// Three values configure the provider and must be present before a single
// row is served:
//
//   FINANCE_ARCHIVE_READER_DATABASE_URL  the hosted archive, as the reader role
//   FINANCE_ARCHIVE_SPACE_ID             the one space that archive holds
//   FINANCE_ARCHIVE_CURSOR_SECRET        stable signing key for continuations
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
  type FinanceAccountInventoryRecord,
  FinanceContractError,
  type FinancePrincipalId,
  type FinanceReadRequest,
  type FinanceReadResponse,
  parseAuthorizedFinanceReadExchange,
} from "@repo/finance-contract";

import {
  type FinanceAccountOverride,
  mergeFinanceAccountOverride,
  type WebFinanceAccountDescriptor,
} from "@/lib/kith/finance-account-overrides";

/**
 * The archive this deployment reads, and the one space it holds.
 *
 * `read` is the whole seam. Production supplies the reader-role Postgres
 * connection; a test supplies a fake. There is deliberately no interface
 * beyond this: everything above it is the contract's own types.
 */
export type FinanceArchiveAccess = {
  spaceId: string;
  read(
    request: FinanceReadRequest,
    trusted: { principalId: FinancePrincipalId },
  ): Promise<FinanceReadResponse>;
};

/**
 * The gateway's own authenticated context. Never deserialized from a request
 * body: the principal comes from the validated API key and the space list from
 * the caller's current membership, checked live on every call.
 */
export type FinanceTrustedGatewayContext = {
  principalId: string;
  authorizedSpaceIds: readonly string[];
};

type ListAccountsResponse = Extract<
  FinanceReadResponse,
  { operation: "list_accounts" }
>;
type HoldingsSnapshotResponse = Extract<
  FinanceReadResponse,
  { operation: "get_holdings_snapshot" }
>;
type AccountInventoryResponse = Extract<
  FinanceReadResponse,
  { operation: "list_account_inventory" }
>;

/**
 * The web provider's deliberate post-contract shape.
 *
 * Only responses that name an account differ from the archive contract. Their
 * descriptors may carry the owner's `closed` flag and their three descriptive
 * fields may contain owner overrides. `archiveAccount` preserves the original
 * statement-derived values. All record, evidence, coverage and pagination
 * fields remain the archive's validated values.
 */
export type WebFinanceReadResponse =
  | Exclude<
      FinanceReadResponse,
      ListAccountsResponse | HoldingsSnapshotResponse | AccountInventoryResponse
    >
  | (Omit<ListAccountsResponse, "items"> & {
      items: WebFinanceAccountDescriptor[];
    })
  | (Omit<HoldingsSnapshotResponse, "account"> & {
      account: WebFinanceAccountDescriptor;
    })
  | (Omit<AccountInventoryResponse, "items"> & {
      items: Array<
        Omit<FinanceAccountInventoryRecord, "account"> & {
          account: WebFinanceAccountDescriptor;
        }
      >;
    });

function mergeAccountOverrides(
  response: FinanceReadResponse,
  overrides: readonly FinanceAccountOverride[],
): WebFinanceReadResponse {
  if (overrides.length === 0) return response;
  const byAccount = new Map(overrides.map((item) => [item.accountId, item]));
  if (response.operation === "list_accounts") {
    return {
      ...response,
      items: response.items.map((account) =>
        mergeFinanceAccountOverride(account, byAccount.get(account.accountId)),
      ),
    };
  }
  if (response.operation === "get_holdings_snapshot") {
    return {
      ...response,
      account: mergeFinanceAccountOverride(
        response.account,
        byAccount.get(response.account.accountId),
      ),
    };
  }
  if (response.operation === "list_account_inventory") {
    return {
      ...response,
      items: response.items.map((item) => ({
        ...item,
        account: mergeFinanceAccountOverride(
          item.account,
          byAccount.get(item.account.accountId),
        ),
      })),
    };
  }
  return response;
}

// ponytail: one module-scoped pool, keyed on nothing, because a serverless
// instance reads its environment once and never changes it. Upgrade path if a
// process ever needs two archives: key the map on the connection string.
let pool: ReturnType<typeof createArchivePool> | undefined;

async function readThroughReaderRole(
  url: string,
  spaceId: string,
  request: FinanceReadRequest,
  principalId: FinancePrincipalId,
  cursorSecret: string,
): Promise<FinanceReadResponse> {
  pool ??= createArchivePool(url);
  // `serveFinanceRead` runs its whole answer inside one REPEATABLE READ, READ
  // ONLY transaction, so it needs a client of its own rather than `pool.query`.
  const client = await pool.connect();
  try {
    return await serveFinanceRead(client, request, spaceId, {
      principalId,
      cursorSigningSecret: cursorSecret,
      rawTreeRoot: null,
    });
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
  const cursorSecret = env.FINANCE_ARCHIVE_CURSOR_SECRET;
  if (!cursorSecret || Buffer.byteLength(cursorSecret, "utf8") < 32) {
    throw new Error(
      "FINANCE_ARCHIVE_CURSOR_SECRET must contain at least 32 bytes",
    );
  }
  return {
    spaceId,
    read: (request, trusted) =>
      readThroughReaderRole(
        url,
        spaceId,
        request,
        trusted.principalId,
        cursorSecret,
      ),
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
 * be a member of the archive's space, read from the store rather than from
 * anything the caller sent. The contract's own authorization must then accept the
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
  overrides: readonly FinanceAccountOverride[] = [],
): Promise<WebFinanceReadResponse> {
  if (!trusted.authorizedSpaceIds.includes(archive.spaceId)) {
    throw new FinanceContractError("not_authorized");
  }
  const authorized = authorizeFinanceReadRequest(request, {
    principalId: trusted.principalId,
    authorizedSpaceIds: [archive.spaceId],
  });
  const response = await archive.read(authorized.request, {
    principalId: authorized.principalId,
  });
  const validated = parseAuthorizedFinanceReadExchange({
    request: authorized.request,
    response,
    trustedContext: {
      principalId: trusted.principalId,
      authorizedSpaceIds: [archive.spaceId],
    },
  }).response;
  return mergeAccountOverrides(validated, overrides);
}
