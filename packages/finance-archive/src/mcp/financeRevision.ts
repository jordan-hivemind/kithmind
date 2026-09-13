import type pg from "pg";

import type { FinanceDatasetRevision } from "@repo/finance-contract";

type RevisionRow = {
  epoch: string;
  revision: string;
};

/**
 * The write-triggered revision is O(1) to read and changes with every
 * committed statement that can affect this surface. It is read inside the
 * response's repeatable-read transaction, so the token names the same archive
 * snapshot every query used.
 */
export async function financeDatasetRevision(
  client: pg.ClientBase,
): Promise<FinanceDatasetRevision> {
  const result = await client.query<RevisionRow>(
    `SELECT epoch::text, revision::text
       FROM finance_read_revision
      WHERE singleton`,
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      row.epoch,
    ) ||
    !/^(?:0|[1-9]\d*)$/.test(row.revision)
  )
    throw new Error("finance read revision is unavailable");
  return `rev-${row.epoch}-${row.revision}` as FinanceDatasetRevision;
}
