// Resolves the `kith.source_accounts` row (connector `fs`) this run ingests
// into. `loadSourceAccount` is `@repo/kith-store/ingestion`'s own "one source
// account by id, with no authorization applied" reader -- appropriate here
// because this CLI runs with a direct, owner-provisioned database credential,
// not a caller-supplied identity to check.

import { ingestion, withKithReadTransaction } from "@repo/kith-store";
import type { Pool } from "pg";

export type ResolvedSourceAccount = {
  id: string;
  spaceId: string;
  createdBy: string | null;
};

export async function resolveSourceAccount(
  pool: Pool,
  sourceAccountId: string,
  expectedSpaceId?: string,
): Promise<ResolvedSourceAccount> {
  const account = await withKithReadTransaction(pool, (client) =>
    ingestion.loadSourceAccount({ client, now: Date.now() }, sourceAccountId),
  );
  if (!account) {
    throw new Error(`Source account ${sourceAccountId} does not exist`);
  }
  if (account.connector !== "fs") {
    throw new Error(
      `Source account ${sourceAccountId} has connector "${account.connector}", not "fs"`,
    );
  }
  if (account.enabled !== true) {
    throw new Error(`Source account ${sourceAccountId} is disabled`);
  }
  if (expectedSpaceId !== undefined && account.spaceId !== expectedSpaceId) {
    throw new Error(
      `Source account ${sourceAccountId} belongs to space ${account.spaceId}, not ${expectedSpaceId}`,
    );
  }
  return { id: account.id, spaceId: account.spaceId, createdBy: account.createdBy };
}

/**
 * The `kith.users.id` every write in this run attributes to. Prefers the
 * source account's own `created_by`; falls back to the sole user of its space
 * when that is unambiguous, matching a single-owner deployment. Throws
 * (rather than guessing) when neither resolves one user.
 */
export async function resolveUserId(pool: Pool, account: ResolvedSourceAccount): Promise<string> {
  if (account.createdBy) return account.createdBy;
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM kith.space_members WHERE space_id = $1 AND user_id IS NOT NULL ORDER BY user_id LIMIT 2`,
    [account.spaceId],
  );
  if (rows.length === 1) return rows[0]!.user_id;
  throw new Error(
    `Source account ${account.id} has no created_by and space ${account.spaceId} has ` +
      `${rows.length === 0 ? "no" : "more than one"} user; set created_by on the source ` +
      "account (admin UI) so ingested revisions have an owner.",
  );
}
