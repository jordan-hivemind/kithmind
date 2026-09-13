#!/usr/bin/env node
// Applies schema migrations without creating or rotating the reader role.

import { applyPgSchema } from "../dist/pgSchema.js";
import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
} from "../dist/pgStore.js";

const schema = archiveSchemaName();
const client = createArchiveClient(archiveDatabaseUrl(), schema);
await client.connect();
try {
  const version = await applyPgSchema(client);
  console.log(`schema: ${schema}`);
  console.log(`schema version: ${version}`);
} finally {
  await client.end();
}
