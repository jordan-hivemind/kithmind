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
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  type FinanceArchiveAccess,
  financeCoverageRequest,
  readFinanceArchive,
  resolveFinanceArchive,
} from "./finance";

// The archive leg is unchanged by i7b. What moved is where its
// `authorizedSpaceIds` comes from: the membership read the tools already
// perform, which i7b left as the PostgreSQL one. Only that read and
// `query_records`' own Kith Mind leg are stubbed here.
const mocks = vi.hoisted(() => ({
  authorizedSpaceIds: vi.fn(),
  queryRecords: vi.fn(),
  listSources: vi.fn(),
}));
vi.mock("./reads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reads")>();
  return { ...actual, postgresReads: () => mocks };
});

import { mcpPrincipalLoader } from "./principal";
import { createMcpServer, type McpServerCredential } from "./server";

const CREDENTIAL: McpServerCredential = {
  surface: "postgres",
  withPrincipal: mcpPrincipalLoader({
    userId: "user-test",
    credentialId: "key-test",
  }),
};

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
    expect(syntheticFinanceReadExchanges).toHaveLength(8);
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

  test("configured archives require a stable signing secret", () => {
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
        FINANCE_ARCHIVE_CURSOR_SECRET: "synthetic-cursor-secret-with-32-bytes",
      })?.spaceId,
    ).toBe(ARCHIVE_SPACE);
    for (const secret of [undefined, "too-short"]) {
      expect(() =>
        resolveFinanceArchive({
          FINANCE_ARCHIVE_READER_DATABASE_URL:
            "postgres://reader@example/archive",
          FINANCE_ARCHIVE_SPACE_ID: ARCHIVE_SPACE,
          FINANCE_ARCHIVE_CURSOR_SECRET: secret,
        }),
      ).toThrow("FINANCE_ARCHIVE_CURSOR_SECRET");
    }
  });

  test("the backend receives only the authenticated principal", async () => {
    const exchange = exchangeFor("list_transactions");
    const read = vi.fn().mockResolvedValue(exchange.response);
    await readFinanceArchive(
      { spaceId: ARCHIVE_SPACE, read },
      exchange.request,
      {
        principalId: "synthetic-user:synthetic-key",
        authorizedSpaceIds: [ARCHIVE_SPACE, OTHER_SPACE],
      },
    );
    expect(read).toHaveBeenCalledWith(exchange.request, {
      principalId: "synthetic-user:synthetic-key",
    });
  });

  test("backend responses cannot change the authorized space or operation", async () => {
    const exchange = exchangeFor("list_transactions");
    for (const response of [
      { ...exchange.response, spaceId: OTHER_SPACE },
      exchangeFor("list_holdings").response,
    ]) {
      await expect(
        readFinanceArchive(
          fakeArchive(() => response),
          exchange.request,
          {
            principalId: PRINCIPAL,
            authorizedSpaceIds: [ARCHIVE_SPACE, OTHER_SPACE],
          },
        ),
      ).rejects.toThrow(FinanceContractError);
    }
  });
});

async function call(
  archive: FinanceArchiveAccess | null,
  name: string,
  args: Record<string, unknown>,
) {
  const server = createMcpServer(CREDENTIAL, PRINCIPAL, archive);
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
    vi.resetAllMocks();
    mocks.authorizedSpaceIds.mockResolvedValue([ARCHIVE_SPACE]);
    mocks.queryRecords.mockResolvedValue({ items: [] });
  });

  test("new finance capabilities cross the advertised gateway unchanged", async () => {
    const server = createMcpServer(
      CREDENTIAL,
      PRINCIPAL,
      fakeArchive((request) => exchangeFor(request.operation).response),
    );
    const client = new Client({ name: "fresh-finance-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      const advertised = tools.tools.find(
        (tool) => tool.name === "query_records",
      );
      const schema = JSON.stringify(advertised?.inputSchema);
      for (const term of [
        "contractVersion",
        "list_accounts",
        "get_holdings_snapshot",
        "accountLast4",
        "expectedDatasetRevision",
      ]) {
        expect(schema).toContain(term);
      }
      for (const operation of ["list_accounts", "get_holdings_snapshot"]) {
        const exchange = exchangeFor(operation);
        const result = await client.callTool({
          name: "query_records",
          arguments: {
            query: { provider: "finance_archive", request: exchange.request },
          },
        });
        expect(result.isError).not.toBe(true);
        expect(
          JSON.parse((result.content as { text: string }[])[0]!.text),
        ).toEqual(exchange.response);
      }
      // A later call in the same MCP session must reload live membership.
      mocks.authorizedSpaceIds.mockResolvedValue([]);
      const denied = await client.callTool({
        name: "query_records",
        arguments: {
          query: {
            provider: "finance_archive",
            request: exchangeFor("list_accounts").request,
          },
        },
      });
      expect(denied.isError).toBe(true);
      expect((denied.content as { text: string }[])[0]!.text).toBe(
        "not_authorized",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("the archive response is returned unchanged", async () => {
    const exchange = exchangeFor("list_holdings");
    const archive = fakeArchive(() => exchange.response);
    const result = await call(archive, "query_records", {
      query: { provider: "finance_archive", request: exchange.request },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual(exchange.response);
    // Nothing went to Kith Mind's own record store.
    expect(mocks.queryRecords).not.toHaveBeenCalled();
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
    mocks.queryRecords.mockResolvedValue({ records: [], complete: true });
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
    mocks.authorizedSpaceIds.mockResolvedValue([OTHER_SPACE]);
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
    vi.resetAllMocks();
    mocks.authorizedSpaceIds.mockResolvedValue([ARCHIVE_SPACE]);
    mocks.listSources.mockResolvedValue({
      sources: {
        sources: [{ sourceAccountId: "account-1" }],
        partial: false,
        truncated: false,
      },
      authorizedSpaceIds: [ARCHIVE_SPACE],
    });
  });

  test("archive coverage is reported beside Kith Mind's sources, never inside them", async () => {
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
