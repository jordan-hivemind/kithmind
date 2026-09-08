// Local entry point: `pnpm --filter @repo/finance-archive mcp`, or
// `node dist/mcp/run.js` directly, after `pnpm --filter @repo/finance-archive
// build`. Point a local MCP client at this command over stdio.
//
// The archive path is read from FINANCE_ARCHIVE_DB_PATH and nowhere else.
// There is no default: a real path never belongs in this repository, and a
// missing default keeps a misconfigured client from accidentally opening
// whatever file happens to sit at a guessed location.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createFinanceArchiveMcpServer } from "./server.js";

const dbPath = process.env.FINANCE_ARCHIVE_DB_PATH;
if (!dbPath) {
  console.error(
    "FINANCE_ARCHIVE_DB_PATH is not set. Point it at the local archive file; " +
      "that path is never committed and this server never defaults to one.",
  );
  process.exit(1);
}

const { server } = createFinanceArchiveMcpServer(dbPath);
const transport = new StdioServerTransport();
await server.connect(transport);
