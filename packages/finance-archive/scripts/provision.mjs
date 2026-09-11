#!/usr/bin/env node
// Applies the archive schema (pgSchema.ts) and the reader role (pgReaderRole.ts)
// to a live database. Both are idempotent, so re-running this after a migration
// adds a table is the documented way to expose it to the reader (see README
// "The reader role (F1-21)").
//
// Usage (development-first: point this at a throwaway database before a
// hosted one):
//
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//     node scripts/provision.mjs
//
// FINANCE_ARCHIVE_DATABASE_URL is read the same way pgStore.ts's
// archiveDatabaseUrl() reads it -- the direct (non-pooled) endpoint is the
// right choice here: this script runs CREATE ROLE and schema DDL once, not
// the transaction-scoped SET LOCAL path the write path uses, so there is no
// benefit to a pooler and a direct connection avoids any pooler-specific
// surprise during a one-off admin operation.
//
// This script never writes a connection string, a password or a host name to
// a file, and never logs the reader connection string more than once. Capture
// the printed reader connection string from this run's own output; it is not
// retrievable from this script a second time. The reader role's password is
// generated fresh on every run, so re-running this script rotates it.

import { randomBytes } from "node:crypto";

import { applyPgReaderRole } from "../dist/pgReaderRole.js";
import { applyPgSchema } from "../dist/pgSchema.js";
import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
} from "../dist/pgStore.js";

const url = archiveDatabaseUrl();
const schema = archiveSchemaName();
const client = createArchiveClient(url, schema);
await client.connect();

try {
  const version = await applyPgSchema(client);

  const tableCount = await client.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1",
    [schema],
  );

  const password = randomBytes(24).toString("base64url");
  const reader = await applyPgReaderRole(client, { password });

  const readerUrl = new URL(url);
  readerUrl.username = reader.role;
  readerUrl.password = password;

  const createPrivilege = await client.query(
    "SELECT has_schema_privilege($1, $2, 'CREATE') AS can_create",
    [reader.role, schema],
  );
  const temporaryPrivilege = await client.query(
    "SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS can_temp",
    [reader.role],
  );

  console.log(`schema: ${schema}`);
  console.log(`schema version: ${version}`);
  console.log(`tables: ${tableCount.rows[0].n}`);
  console.log(`reader role: ${reader.role}`);
  console.log(`reader CREATE on schema: ${createPrivilege.rows[0].can_create}`);
  console.log(`reader TEMPORARY on database: ${temporaryPrivilege.rows[0].can_temp}`);
  console.log(`reader connection string (capture now, printed once): ${readerUrl.toString()}`);
} finally {
  await client.end();
}
