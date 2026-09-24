import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  management: {
    listTaxPayments: vi.fn(),
    manageTaxPayment: vi.fn(),
  },
}));

vi.mock("./management", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./management")>();
  return { ...actual, postgresManagement: () => mocks.management };
});

import type { WithMcpPrincipal } from "./principal";
import { createMcpServer } from "./server";

async function withClient(run: (client: Client) => Promise<void>) {
  const server = createMcpServer(
    {
      surface: "postgres",
      withPrincipal: (() => {
        throw new Error("mocked tax payment tools must not load a principal");
      }) as unknown as WithMcpPrincipal,
    },
    "tax-payments-tools-test",
  );
  const client = new Client({ name: "tax-payments-tools-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP tax payment tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.management.listTaxPayments.mockResolvedValue({
      taxYear: 2026,
      payments: [],
      totals: [],
    });
    mocks.management.manageTaxPayment.mockResolvedValue({
      action: "create",
      paymentId: "tax-payment-id",
      created: true,
    });
  });

  test("advertises the additive release and forwards exact year reads", async () => {
    await withClient(async (client) => {
      expect(client.getServerVersion()?.version).toBe("1.5.0");
      const result = await client.callTool({
        name: "list_tax_payments",
        arguments: { spaceIds: ["space-a"], taxYear: 2026 },
      });
      expect(result.isError).not.toBe(true);
      expect(mocks.management.listTaxPayments).toHaveBeenCalledWith({
        spaceIds: ["space-a"],
        taxYear: 2026,
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ taxYear: 2026, payments: [], totals: [] }),
        },
      ]);
    });
  });

  test("forwards structured create and status updates without Thought capture", async () => {
    await withClient(async (client) => {
      const create = {
        action: "create" as const,
        spaceId: "space-a",
        payer: {
          key: "person:synthetic-tax-payer",
          kind: "person" as const,
          name: "Synthetic Tax Payer",
        },
        authority: "us_federal" as const,
        paymentKind: "estimated_income" as const,
        taxYear: 2026,
        amount: "1234.56",
        currency: "USD",
        submittedOn: "2026-09-21",
        confirmationNumber: "CONF-SYNTHETIC-2026-Q3",
      };
      await client.callTool({
        name: "manage_tax_payment",
        arguments: { request: create },
      });
      expect(mocks.management.manageTaxPayment).toHaveBeenNthCalledWith(
        1,
        create,
      );

      const update = {
        action: "set_status" as const,
        paymentId: "tax-payment-id",
        status: "settled" as const,
        effectiveOn: "2026-09-23",
        reason: "Synthetic settlement",
      };
      await client.callTool({
        name: "manage_tax_payment",
        arguments: { request: update },
      });
      expect(mocks.management.manageTaxPayment).toHaveBeenNthCalledWith(
        2,
        update,
      );

      const help = await client.callTool({
        name: "get_kith_help",
        arguments: { topic: "tax_payments" },
      });
      expect(JSON.stringify(help.content)).toContain("never Thoughts");
      expect(JSON.stringify(help.content)).toContain("reversed");
    });
  });

  test("rejects unsupported authority, impossible dates and incomplete identity", async () => {
    await withClient(async (client) => {
      for (const request of [
        {
          action: "create",
          spaceId: "space-a",
          payer: { kind: "person", name: "Synthetic Tax Payer" },
          authority: "state",
          paymentKind: "estimated_income",
          taxYear: 2026,
          amount: "1234.56",
          currency: "USD",
          submittedOn: "2026-09-21",
          confirmationNumber: "CONF-SYNTHETIC",
        },
        {
          action: "set_status",
          paymentId: "tax-payment-id",
          status: "settled",
          effectiveOn: "2026-02-30",
          reason: "Impossible date",
        },
      ]) {
        const result = await client.callTool({
          name: "manage_tax_payment",
          arguments: { request },
        });
        expect(result.isError).toBe(true);
      }
      expect(mocks.management.manageTaxPayment).not.toHaveBeenCalled();
    });
  });
});
