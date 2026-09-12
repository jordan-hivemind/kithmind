import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FinanceContractError,
  type FinanceReadRequest,
  type FinanceReadResponse,
  parseAuthorizedFinanceReadExchange,
} from "@repo/finance-contract";
import {
  syntheticFinanceReadExchanges,
  syntheticFinanceTrustedContext,
} from "@repo/finance-contract/fixtures";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  type FinanceArchiveAccess,
  financeCoverageRequest,
  readFinanceArchive,
  resolveFinanceArchive,
} from "./finance";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  action: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = mocks.query;
    action = mocks.action;
    mutation = mocks.mutation;
    setAuth() {}
  },
}));
import { createMcpServer } from "./server";

const ARCHIVE_SPACE = syntheticFinanceTrustedContext.authorizedSpaceIds[0]!;
const PRINCIPAL = syntheticFinanceTrustedContext.principalId;
const OTHER_SPACE = "space-synthetic-002";

type Exchange = (typeof syntheticFinanceReadExchanges)[number];

/** A finance backend that serves the fixtures and records what it was asked. */
function fakeArchive(
  responseFor: (request: FinanceReadRequest) => unknown,
  spaceId: string = ARCHIVE_SPACE,
): FinanceArchiveAccess & { requests: FinanceReadRequest[] } {
  const requests: FinanceReadRequest[] = [];
  return {
    spaceId,
    requests,
    read: async (request) => {
      requests.push(request);
      return responseFor(request) as FinanceReadResponse;
    },
  };
}

function exchangeFor(operation: string): Exchange {
  const found = syntheticFinanceReadExchanges.find(
    (exchange) => exchange.request.operation === operation,
  );
  if (!found) throw new Error(`no fixture for ${operation}`);
  return found;
}

/** The list_transactions fixture, made partial without leaving the contract. */
const partialTransactions = {
  ...exchangeFor("list_transactions").response,
  coverage: {
    status: "partial" as const,
    asOf: 1_788_800_000_000,
    reasons: ["retained_evidence_unavailable" as const],
  },
  completeness: "partial" as const,
  truncated: true,
  nextCursor: "cursor-synthetic-002",
};

describe("finance provider authorization", () => {
  test("every synthetic operation survives the gateway as a valid exchange", async () => {
    for (const exchange of syntheticFinanceReadExchanges) {
      const archive = fakeArchive(() => exchange.response);
      const response = await readFinanceArchive(archive, exchange.request, {
        principalId: PRINCIPAL,
        authorizedSpaceIds: [ARCHIVE_SPACE, OTHER_SPACE],
      });
      // What the backend received is the contract's own parsed request, and
      // the pair still validates as an authorized exchange.
      expect(archive.requests).toEqual([exchange.request]);
      expect(
        parseAuthorizedFinanceReadExchange({
          request: archive.requests[0],
          response,
          trustedContext: {
            principalId: PRINCIPAL,
            authorizedSpaceIds: [ARCHIVE_SPACE],
          },
        }).response,
      ).toEqual(exchange.response);
    }
    expect(syntheticFinanceReadExchanges).toHaveLength(6);
  });

  test("money crosses the provider as decimal strings", async () => {
    const exchange = exchangeFor("list_transactions");
    const archive = fakeArchive(() => exchange.response);
    const response = await readFinanceArchive(archive, exchange.request, {
      principalId: PRINCIPAL,
      authorizedSpaceIds: [ARCHIVE_SPACE],
    });
    const amount =
      response.operation === "list_transactions"
        ? response.items[0]!.amount
        : undefined;
    expect(amount).toEqual({ decimal: "-12.34", currency: "USD" });
    expect(typeof amount!.decimal).toBe("string");
  });

  test("a principal outside the archive space gets nothing", async () => {
    const exchange = exchangeFor("list_transactions");
    const archive = fakeArchive(() => exchange.response);
    await expect(
      readFinanceArchive(archive, exchange.request, {
        principalId: "principal-synthetic-999",
        authorizedSpaceIds: [OTHER_SPACE],
      }),
    ).rejects.toThrow(FinanceContractError);
    // The archive is never asked, so there is no page to be empty.
    expect(archive.requests).toEqual([]);
  });

  test("a request naming another space the caller can read is refused", async () => {
    const archive = fakeArchive(() => exchangeFor("list_balances").response);
    await expect(
      readFinanceArchive(
        archive,
        { ...exchangeFor("list_balances").request, spaceId: OTHER_SPACE },
        {
          principalId: PRINCIPAL,
          authorizedSpaceIds: [ARCHIVE_SPACE, OTHER_SPACE],
        },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(archive.requests).toEqual([]);
  });

  test("the archive is configured only when both values are present", () => {
    expect(resolveFinanceArchive({})).toBeNull();
    expect(
      resolveFinanceArchive({
        FINANCE_ARCHIVE_READER_DATABASE_URL:
          "postgres://reader@example/archive",
      }),
    ).toBeNull();
    expect(
      resolveFinanceArchive({ FINANCE_ARCHIVE_SPACE_ID: ARCHIVE_SPACE }),
    ).toBeNull();
    expect(
      resolveFinanceArchive({
        FINANCE_ARCHIVE_READER_DATABASE_URL:
          "postgres://reader@example/archive",
        FINANCE_ARCHIVE_SPACE_ID: ARCHIVE_SPACE,
      })?.spaceId,
    ).toBe(ARCHIVE_SPACE);
  });
});

async function call(
  archive: FinanceArchiveAccess | null,
  name: string,
  args: Record<string, unknown>,
) {
  const server = createMcpServer("signed-test-token", PRINCIPAL, archive);
  const client = new Client({ name: "finance-provider", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
  return (result.content as { type: string; text: string }[])[0]!.text;
}

describe("query_records finance provider", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    vi.resetAllMocks();
    mocks.query.mockResolvedValue([
      {
        spaceId: ARCHIVE_SPACE,
        name: "Personal",
        kind: "personal",
        role: "owner",
      },
    ]);
    mocks.mutation.mockResolvedValue({ items: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  test("the archive response is returned unchanged", async () => {
    const exchange = exchangeFor("list_holdings");
    const archive = fakeArchive(() => exchange.response);
    const result = await call(archive, "query_records", {
      query: { provider: "finance_archive", request: exchange.request },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual(exchange.response);
    // Nothing went to Kith Mind's own record store.
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  test("a partial archive response stays partial", async () => {
    const archive = fakeArchive(() => partialTransactions);
    const result = await call(archive, "query_records", {
      query: {
        provider: "finance_archive",
        request: exchangeFor("list_transactions").request,
      },
    });
    const response = JSON.parse(textOf(result));
    expect(response.completeness).toBe("partial");
    expect(response.truncated).toBe(true);
    expect(response.nextCursor).toBe("cursor-synthetic-002");
    expect(response.coverage.reasons).toEqual([
      "retained_evidence_unavailable",
    ]);
    expect(response.items[0].evidence).toHaveLength(1);
  });

  test("Kith Mind records still answer without a provider", async () => {
    mocks.mutation.mockResolvedValue({ records: [], complete: true });
    const archive = fakeArchive(() => exchangeFor("list_balances").response);
    const result = await call(archive, "query_records", {
      query: {
        operation: "latest_event",
        spaceId: ARCHIVE_SPACE,
        entityId: "entity-1",
        eventType: "financial_transaction",
      },
    });
    expect(JSON.parse(textOf(result))).toEqual({ records: [], complete: true });
    expect(archive.requests).toEqual([]);
  });

  test("an unconfigured archive is an explicit refusal, not an empty answer", async () => {
    const result = await call(null, "query_records", {
      query: {
        provider: "finance_archive",
        request: exchangeFor("get_coverage").request,
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not configured");
  });

  test("a principal with no membership in the archive space is refused", async () => {
    mocks.query.mockResolvedValue([
      { spaceId: OTHER_SPACE, name: "Other", kind: "personal", role: "owner" },
    ]);
    const archive = fakeArchive(
      () => exchangeFor("list_transactions").response,
    );
    const result = await call(archive, "query_records", {
      query: {
        provider: "finance_archive",
        request: exchangeFor("list_transactions").request,
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("not_authorized");
    expect(archive.requests).toEqual([]);
  });

  test("an archive failure reports a closed code and no archive detail", async () => {
    const archive: FinanceArchiveAccess = {
      spaceId: ARCHIVE_SPACE,
      read: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.7:5432 reader@archive");
      },
    };
    const result = await call(archive, "query_records", {
      query: {
        provider: "finance_archive",
        request: exchangeFor("list_transactions").request,
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "the financial archive failed to serve this request",
    );
  });
});

describe("list_sources finance archive block", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    vi.resetAllMocks();
    mocks.query.mockImplementation(
      async (fn: Parameters<typeof getFunctionName>[0]) =>
        getFunctionName(fn).endsWith(":listSources")
          ? {
              sources: [{ sourceAccountId: "account-1" }],
              partial: false,
              truncated: false,
            }
          : [
              {
                spaceId: ARCHIVE_SPACE,
                name: "Personal",
                kind: "personal",
                role: "owner",
              },
            ],
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  test("archive coverage is reported beside the Convex sources, never inside them", async () => {
    const coverage = exchangeFor("get_coverage").response;
    const archive = fakeArchive(() => coverage);
    const result = await call(archive, "list_sources", {});
    const parsed = JSON.parse(textOf(result));
    expect(parsed.sources).toEqual([{ sourceAccountId: "account-1" }]);
    expect(parsed.financeArchive).toEqual(coverage);
    expect(archive.requests[0]).toMatchObject({
      operation: "get_coverage",
      spaceId: ARCHIVE_SPACE,
    });
  });

  test("an unreachable archive is reported rather than omitted", async () => {
    const archive: FinanceArchiveAccess = {
      spaceId: ARCHIVE_SPACE,
      read: async () => {
        throw new Error("archive unreachable");
      },
    };
    const result = await call(archive, "list_sources", {});
    expect(JSON.parse(textOf(result)).financeArchive).toEqual({
      spaceId: ARCHIVE_SPACE,
      unavailable: "unavailable",
    });
  });

  test("the block is omitted when the space filter excludes the archive", async () => {
    const archive = fakeArchive(() => exchangeFor("get_coverage").response);
    const result = await call(archive, "list_sources", {
      spaceIds: [OTHER_SPACE],
    });
    expect(JSON.parse(textOf(result)).financeArchive).toBeUndefined();
    expect(archive.requests).toEqual([]);
  });

  test("an empty space filter still means every readable space", async () => {
    const coverage = exchangeFor("get_coverage").response;
    const archive = fakeArchive(() => coverage);
    const result = await call(archive, "list_sources", { spaceIds: [] });
    expect(JSON.parse(textOf(result)).financeArchive).toEqual(coverage);
  });

  test("the coverage request is bounded and names the archive space", () => {
    expect(financeCoverageRequest(ARCHIVE_SPACE)).toEqual({
      contractVersion: 1,
      operation: "get_coverage",
      spaceId: ARCHIVE_SPACE,
      limit: 100,
    });
  });
});
