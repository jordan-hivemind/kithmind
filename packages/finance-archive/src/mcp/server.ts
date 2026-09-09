// The archive's assistant access surface (F1-21): six typed operations from
// `@repo/finance-contract`, served over MCP, against Postgres, as a non-owner
// reader role.
//
// What changed from the surface this replaces, and why it is not a port:
//
//   - `run_query` is gone. The plan's typed-bounded-query waiver was retired,
//     and a scoped gateway pointed at a SQL surface does not satisfy the rule
//     it was retired for. There is no caller-supplied SQL anywhere here, so
//     the whole class of injection, multi-statement and comment-smuggling
//     attacks has no entry point rather than a defence.
//   - `describe_schema` is gone with it. It existed to help a caller write
//     SQL; nobody writes SQL against this surface now, and the operations
//     document themselves through the contract's own types.
//   - Read-only enforcement moved out of this process and into the database.
//     See `src/pgReaderRole.ts` for the privilege state and
//     `test/pgReaderRole.test.mjs` for each attack tested against it.
//
// Enforcement here is what the database cannot do: the contract's request
// parser rejects a malformed or over-large request before a query is built,
// and the contract's response parser checks every response on the way out.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  authorizeFinanceReadRequest,
  FinanceContractError,
  type FinanceTrustedContext,
} from "@repo/finance-contract";
import type pg from "pg";
import { z } from "zod";

import { serveFinanceRead } from "./pgRead.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const ABSENCE_NOTE =
  "Zero items is never proof that no such event occurred. Read `coverage`: " +
  "status `unknown` means nothing in the archive vouches for the range, so " +
  "an unacquired or unparsed source produces the same empty result a genuine " +
  "absence would. Call get_coverage before treating any empty result as absence.";

const SERVER_INSTRUCTIONS =
  "Read-only access to one person's financial archive over six typed " +
  "operations: list_transactions, list_holdings, list_balances, " +
  "aggregate_money, get_evidence and get_coverage. There is no SQL surface. " +
  "Money crosses this boundary as decimal strings, never as numbers, and a " +
  "total never crosses currencies. Every response carries the dataset " +
  "revision the answer was computed from, an explicit completeness state, " +
  `and a coverage summary. ${ABSENCE_NOTE}`;

/**
 * The contract's own request shape, as far as MCP needs to know it. The
 * contract parser is the real validator -- it checks prototypes, exact key
 * sets, byte size, decimal canonicality and cross-field agreement, none of
 * which belongs in a duplicate schema here that could drift from it.
 */
const REQUEST_SHAPE = {
  request: z
    .record(z.unknown())
    .describe(
      "A finance read contract request: contractVersion 1, spaceId, limit, " +
        "operation, and that operation's own fields.",
    ),
};

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

function errorResult(error: unknown) {
  // A contract error carries a closed code and no detail from the archive.
  // Anything else is reported as a bare failure rather than as a message that
  // could carry a row, a path or a connection detail out of the archive.
  const message =
    error instanceof FinanceContractError
      ? error.code
      : "the archive read surface failed to serve this request";
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

export type FinanceArchiveMcpServer = {
  server: McpServer;
};

/**
 * Wires the read surface over one already-connected reader client.
 *
 * `trustedContext` is supplied by whatever authenticated the caller, never by
 * the caller: the contract's authorization step checks the request's space
 * against it, and `serveFinanceRead` checks it again against the space this
 * archive actually holds. The archive serves one space, so a request naming
 * another is `not_authorized` rather than an empty result.
 */
export function createFinanceArchiveMcpServer(
  client: pg.ClientBase,
  spaceId: string,
  trustedContext: FinanceTrustedContext,
): FinanceArchiveMcpServer {
  const server = new McpServer(
    { name: "kith-finance-archive", version: "2.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.tool(
    "finance_read",
    "One finance read contract operation: list_transactions, list_holdings, " +
      "list_balances, aggregate_money, get_evidence or get_coverage. " +
      `Bounded by the contract's page size and by the reader role's server-side limits. ${ABSENCE_NOTE}`,
    REQUEST_SHAPE,
    READ_ONLY,
    async ({ request }) => {
      try {
        const authorized = authorizeFinanceReadRequest(request, trustedContext);
        return textResult(
          await serveFinanceRead(client, authorized.request, spaceId),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return { server };
}
