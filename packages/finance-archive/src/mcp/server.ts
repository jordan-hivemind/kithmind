// The local read-only MCP server over one archive file. This is the entire
// v1 assistant access surface: an assistant with no browser access and no
// logins answers questions about the money through these four tools and
// cites where each number came from.
//
// Every response carries the dataset revision (SQLite's own data_version,
// which changes when any other connection -- the importer -- writes to the
// file, and is a no-cost way to say "this is what the archive looked like
// when this answer was computed") and an explicit completeness state, so a
// partial or truncated result is never presentable as complete and a
// zero-row result is never presentable as proof that nothing happened.

import type { DatabaseSync } from "node:sqlite";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getCoverage } from "./coverage.js";
import { EVIDENCE_TABLES, getEvidence } from "./evidence.js";
import { toJsonText } from "./json.js";
import {
  MAX_QUERY_MS,
  MAX_QUERY_ROWS,
  openReadOnlyConnection,
  openReadOnlyQueryConnection,
  runReadOnlyQuery,
} from "./queryGuard.js";
import { describeSchema } from "./schemaDoc.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const ZERO_ROW_NOTE =
  "Rows are indexed matches for this exact SQL only. Zero rows means no " +
  "indexed match, not proof that no such event occurred -- an unacquired " +
  "or unparsed source produces the same empty result as a genuine absence. " +
  "Call get_coverage for the account and period before treating this as " +
  "absence.";

const SERVER_INSTRUCTIONS =
  "Local, read-only access to one person's financial archive: holdings, " +
  "transactions, balances, liabilities and commitments across every " +
  "institution they use, each row traceable to a source document. Call " +
  "describe_schema before writing SQL. Call run_query for read-only SQL; " +
  "results are bounded, and a truncated result is marked truncated, never " +
  "complete. Call get_evidence to cite the source document, locator and " +
  "retained text behind one row. Call get_coverage before treating a query " +
  "result as proof of absence -- it reports, per account, what was " +
  "acquired, parsed, reconciled and under review, and a query can return " +
  "zero rows for an unacquired period exactly as it would for a period " +
  "with no such event.";

function dataVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA data_version").get() as {
    data_version: number;
  };
  return Number(row.data_version);
}

function envelope<T extends Record<string, unknown>>(
  db: DatabaseSync,
  payload: T,
): T & { datasetRevision: number } {
  return { datasetRevision: dataVersion(db), ...payload };
}

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: toJsonText(payload) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

export type FinanceArchiveMcpServer = {
  server: McpServer;
  close(): void;
};

/**
 * Wires the four tools over the archive at `dbPath`. Two connections are
 * opened, both read-only at the file level: `queryDb` carries the full
 * enforcement stack in queryGuard.ts for run_query's caller-supplied SQL,
 * and `internalDb` runs this module's own fixed queries, which are never
 * built from caller input.
 */
export function createFinanceArchiveMcpServer(
  dbPath: string,
): FinanceArchiveMcpServer {
  const internalDb = openReadOnlyConnection(dbPath);
  const queryDb = openReadOnlyQueryConnection(dbPath);

  const server = new McpServer(
    { name: "kith-finance-archive", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.tool(
    "describe_schema",
    "Table and column documentation for the financial archive, plus the money, currency and valuation-basis policy. Call this before writing SQL for run_query.",
    {},
    READ_ONLY,
    async () =>
      textResult(
        envelope(internalDb, {
          completeness: "complete" as const,
          schema: describeSchema(internalDb),
        }),
      ),
  );

  server.tool(
    "run_query",
    `Read-only SQL against the financial archive. One SELECT (or WITH ... SELECT) statement only: no writes, no ATTACH, no PRAGMA, no file access, no second statement. Bounded to ${MAX_QUERY_ROWS} rows and ${MAX_QUERY_MS}ms; a truncated result is marked truncated, never complete. ${ZERO_ROW_NOTE}`,
    {
      sql: z
        .string()
        .min(1)
        .max(10_000)
        .describe("A single read-only SQL statement."),
      params: z
        .array(z.union([z.string(), z.number(), z.null()]))
        .max(64)
        .optional()
        .describe("Positional values bound to ? placeholders in sql."),
    },
    READ_ONLY,
    async ({ sql, params }) => {
      try {
        const result = runReadOnlyQuery(queryDb, sql, params ?? []);
        return textResult(
          envelope(internalDb, {
            completeness: result.truncated
              ? ("truncated" as const)
              : ("complete" as const),
            resultSemantics: ZERO_ROW_NOTE,
            ...result,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "get_evidence",
    "The source document, locator, content hash and retained-text path for one row in transactions, positions, balances, liabilities or commitments.",
    {
      table: z.enum(EVIDENCE_TABLES),
      id: z.string().min(1).max(200),
    },
    READ_ONLY,
    async ({ table, id }) => {
      const result = getEvidence(internalDb, table, id);
      return textResult(
        envelope(internalDb, {
          completeness: result.found
            ? ("complete" as const)
            : ("not_found" as const),
          evidence: result,
        }),
      );
    },
  );

  server.tool(
    "get_coverage",
    "Per account: what was acquired, what parsed, what reconciled, what is under review, and when each source was last updated. Omit accountId for every account.",
    { accountId: z.string().min(1).max(200).optional() },
    READ_ONLY,
    async ({ accountId }) => {
      const accounts = getCoverage(internalDb, accountId);
      if (accounts === null) {
        return textResult(
          envelope(internalDb, {
            completeness: "not_found" as const,
            accounts: [],
          }),
        );
      }
      return textResult(
        envelope(internalDb, { completeness: "complete" as const, accounts }),
      );
    },
  );

  return {
    server,
    close() {
      internalDb.close();
      queryDb.close();
    },
  };
}
