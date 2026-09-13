// Moved to `@repo/pg` (P2-39a). The privilege state was already per-schema and
// already derived the role name from the schema, so `kith_reader` reuses the
// same code path rather than a second copy of it.
//
// What stays here is the archive's two arguments: the schema, which defaults to
// the one this client was opened against, and the domains `pgSchema.ts` creates
// whose USAGE the reader needs because archive columns are declared over them.

import type pg from "pg";

import {
  applyReaderRole,
  type ReaderRoleOptions as PgReaderRoleOptions,
  type ReaderRoleSummary,
} from "@repo/pg";

import { archiveSchemaOf } from "./pgStore.js";

export {
  READER_CONNECTION_LIMIT,
  READER_IDLE_TRANSACTION_TIMEOUT_MS,
  READER_LOCK_TIMEOUT_MS,
  READER_ROLE_LOCK_KEY,
  READER_STATEMENT_TIMEOUT_MS,
  readerRoleName,
  type ReaderRoleSummary,
} from "@repo/pg";

/** Domains pgSchema.ts creates, whose USAGE is granted to PUBLIC by default. */
const ARCHIVE_DOMAINS = ["finance_numeric", "currency_code"] as const;

export type ReaderRoleOptions = Omit<PgReaderRoleOptions, "domains">;

/**
 * The archive's reader role: `applyReaderRole` over the archive schema and its
 * domains. Idempotent, so it is safe to re-run, and re-running is the
 * documented way to expose a table a later migration added.
 */
export async function applyPgReaderRole(
  client: pg.ClientBase,
  options: ReaderRoleOptions,
): Promise<ReaderRoleSummary> {
  return applyReaderRole(client, {
    ...options,
    schema: options.schema ?? archiveSchemaOf(client),
    domains: ARCHIVE_DOMAINS,
  });
}
