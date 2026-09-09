// Local entry point: `pnpm --filter @repo/finance-archive mcp`, or
// `node dist/mcp/run.js` after a build. Point an MCP client at this command
// over stdio.
//
// Every setting is read from the environment and nowhere else, with no
// default for any of them. A connection string, a space id and a real path
// never enter this repository, and a guessed default would let a
// misconfigured client open whatever database happens to answer.
//
// FINANCE_ARCHIVE_READER_DATABASE_URL is deliberately a *different* variable
// from FINANCE_ARCHIVE_DATABASE_URL, which the importer and both gates use.
// One string is the owner's and one is the reader's, and the whole point of
// F1-21 is that they are not the same credential. Sharing one variable would
// make the read surface silently connect as the owner the first time someone
// exported the wrong one, and nothing downstream would notice.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { FinancePrincipalId, FinanceSpaceId } from "@repo/finance-contract";

import { resolveArchiveSpaceId } from "../rawTree.js";
import { archiveSchemaName, createArchiveClient } from "../pgStore.js";
import { createFinanceArchiveMcpServer } from "./server.js";

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. ${hint}`);
    process.exit(1);
  }
  return value;
}

const url = required(
  "FINANCE_ARCHIVE_READER_DATABASE_URL",
  "Point it at the archive as the reader role created by applyPgReaderRole; " +
    "that connection string is never committed and this server never defaults to one.",
);
const principalId = required(
  "FINANCE_ARCHIVE_PRINCIPAL_ID",
  "Name the principal this server answers for; there is no anonymous caller.",
);
const spaceId = resolveArchiveSpaceId();

const client = createArchiveClient(url, archiveSchemaName());
await client.connect();

const { server } = createFinanceArchiveMcpServer(
  client,
  spaceId,
  {
    principalId: principalId as FinancePrincipalId,
    authorizedSpaceIds: [spaceId as FinanceSpaceId],
  },
);
const transport = new StdioServerTransport();
await server.connect(transport);
