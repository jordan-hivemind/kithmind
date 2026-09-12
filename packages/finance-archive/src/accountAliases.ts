// F1-56. Two key spaces name one account, and neither can be derived from
// the other.
//
// Morgan Stanley's site keys its listings and documents by a timestamp-like
// `keyAccountNo` (shape `####-##-##-##.##.##.######`), which is what
// `discover()` reports and what `accounts.external_key` holds. The statement
// PDFs print a different number entirely (shape `###-######-###`), which is
// what the layout parser attaches to each holdings section as
// `accountExternalKey`. No digit rule relates the two -- `acct_last4` does
// not match either -- so every holdings row parsed out of a statement carried
// a key that resolved to nothing and landed under whichever account the
// document happened to be pulled under.
//
// This file is the mapping between the two spaces and the two operations
// over it:
//
//   - the rule that learns it (`planAccountAliases`), from documents the
//     archive already retained rather than from anything a person types; and
//   - the re-attribution that moves rows the old resolution misfiled
//     (`moveHoldings`).
//
// `run.ts` owns the walk and the printing; nothing here reads the raw tree,
// loads an adapter, or writes to stdout.

import { createHash, randomUUID } from "node:crypto";

import { balanceHash, liabilityHash, positionHash } from "./rowHash.js";
import type { ArchiveClient } from "./pgStore.js";

/** The alias kinds `account_aliases.kind`'s CHECK accepts. `statement_number`
 * is what a document prints; `api_key` is what the site's own listings use
 * (normally `accounts.external_key`, so an alias of this kind only exists
 * where one account answers to a second API key). */
export const ACCOUNT_ALIAS_KINDS = ["api_key", "statement_number"] as const;
export type AccountAliasKind = (typeof ACCOUNT_ALIAS_KINDS)[number];

/**
 * An account number's shape and a stable short digest of it, and never the
 * number. An operator needs to tell two ambiguous keys apart and to see what
 * kind of thing failed to map; neither needs the digits, and an operator
 * console is not a place to print account numbers that the archive itself
 * only ever stores four digits of.
 *
 * The digest is truncated sha256 of the key. It is not a secret and does not
 * have to be: it exists so two lines of output are distinguishable and so the
 * same key masks the same way across two runs.
 */
export function maskAccountKey(key: string): string {
  const shape = key.replace(/[0-9]/g, "#").replace(/[a-zA-Z]/g, "x");
  const digest = createHash("sha256")
    .update(key, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `${shape} [${digest}]`;
}

/**
 * One retained document's evidence: the account it was pulled under
 * (`documents.account_id`) and every distinct account key its parse printed.
 */
export type AliasObservation = {
  readonly accountId: string | null;
  readonly keys: readonly string[];
};

export type AliasLearning = {
  /** Printed key -> `accounts.id`, for keys the rule accepted. */
  readonly accepted: ReadonlyMap<string, string>;
  /** Keys that single-number documents disagreed about. Never written. */
  readonly ambiguous: readonly string[];
  /** Keys seen only on documents printing several numbers, so no document
   * ever pinned them to one account. Never written. */
  readonly unmapped: readonly string[];
  /** How many distinct unresolved keys the walk saw at all. */
  readonly seen: number;
};

/**
 * The learning rule, whole:
 *
 *   A printed number is accepted for an account only if it appears on at
 *   least one document that printed exactly one number, and every such
 *   document agrees on the same account.
 *
 * Both halves matter, and the first is the one that is easy to get wrong. A
 * document row records the account the pull was made under, so for a
 * single-account statement the printed number and the document's account are
 * the same account -- that is the whole of the evidence. A consolidated
 * statement is pulled under one account but prints several accounts'
 * numbers, so it is evidence for none of them, and attributing its numbers
 * to its pull account would confidently invent a mapping. `keys.length === 1`
 * is counted over *every* number the document printed, including numbers
 * already known: a document printing one unknown number next to one known
 * one covers two accounts and is not single-account either.
 *
 * The second half rejects a number two single-number documents attribute to
 * different accounts. That should not happen, and if it does, the premise
 * behind the first half is wrong somewhere -- which is a thing to look at,
 * never a thing to pick a winner for.
 *
 * `isResolved` names the keys that already resolve (an account's own
 * `external_key`, or an alias learned by an earlier run). They are excluded
 * from what is learned -- there is nothing to learn -- but, as above, not
 * from the count that decides whether a document is single-number.
 */
export function planAccountAliases(
  observations: readonly AliasObservation[],
  isResolved: (key: string) => boolean,
): AliasLearning {
  const candidates = new Map<string, Set<string>>();
  const allKeys = new Set<string>();

  for (const observation of observations) {
    const keys = [...new Set(observation.keys)];
    const learnable = keys.filter((key) => !isResolved(key));
    for (const key of learnable) allKeys.add(key);
    if (keys.length !== 1 || observation.accountId === null) continue;
    for (const key of learnable) {
      const accounts = candidates.get(key) ?? new Set<string>();
      accounts.add(observation.accountId);
      candidates.set(key, accounts);
    }
  }

  const accepted = new Map<string, string>();
  const ambiguous: string[] = [];
  const unmapped: string[] = [];
  for (const key of allKeys) {
    const accounts = candidates.get(key);
    if (accounts === undefined) unmapped.push(key);
    else if (accounts.size === 1) accepted.set(key, [...accounts][0]!);
    else ambiguous.push(key);
  }
  return { accepted, ambiguous, unmapped, seen: allKeys.size };
}

/**
 * Writes accepted aliases. `ON CONFLICT DO NOTHING` on the key's own UNIQUE
 * constraint, so a second run over the same documents writes nothing rather
 * than failing: the rule is deterministic over the same corpus, and a key
 * that already maps to a *different* account is a conflict this must not
 * resolve by overwriting.
 */
export async function insertAccountAliases(
  client: ArchiveClient,
  institutionId: string,
  accepted: ReadonlyMap<string, string>,
  kind: AccountAliasKind,
  learnedNote: string,
): Promise<number> {
  const rows = [...accepted].map(([externalKey, accountId]) => [
    randomUUID(),
    accountId,
    institutionId,
    externalKey,
    kind,
    learnedNote,
  ]);
  if (rows.length === 0) return 0;
  // Not `insertRows`: that one has no conflict clause, and re-running an
  // operator command must not be a way to fail a whole run.
  const placeholders = rows
    .map(
      (_, i) =>
        `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`,
    )
    .join(", ");
  const result = await client.query(
    `INSERT INTO account_aliases (id, account_id, institution_id, external_key, kind, learned_note)
     VALUES ${placeholders}
     ON CONFLICT ON CONSTRAINT account_aliases_key_unique DO NOTHING`,
    rows.flat(),
  );
  return result.rowCount ?? 0;
}

// --- re-attribution ---------------------------------------------------------
//
// The key a row was filed under is not retained anywhere joinable: the
// `unknown_account_key` review item holds it in `raw_value` but has no row
// pointer (and, before this task, no document pointer either), and
// `source_locator` holds the page and section a holding was printed at, not
// the account number above it. So the original attribution is re-derived:
// reparse the document, which yields each holding's own printed key again,
// and match the parsed holding to the stored row by the pair that *is*
// recorded on both -- `source_document_id` and `source_locator`.
//
// A row's `row_hash` (F1-49) includes its account, so moving a row without
// recomputing its hash would leave it undiscoverable by the dedupe that
// exists to stop the next reparse inserting it again. The hash is recomputed
// from the stored row rather than from the parse, so nothing here has to
// reproduce `importer.ts`'s canonicalization: `rowHash.ts` canonicalizes
// every decimal it hashes, and Postgres hands back the same digits it was
// given, so the recomputed hash of an untouched row is bit-identical to the
// stored one. That equality is checked before every move and is the guard
// against exactly this drift.

export type HoldingTable = "positions" | "balances" | "liabilities";

export const HOLDING_TABLES: readonly HoldingTable[] = [
  "positions",
  "balances",
  "liabilities",
];

/** The columns each table's hash is computed over, as text so a NUMERIC
 * round-trips to the same digits `importer.ts` hashed. */
const HASH_SELECT: Record<HoldingTable, string> = {
  positions: `id, account_id, instrument_id, as_of::text AS as_of, quantity::text AS quantity,
     market_value::text AS market_value, cost_basis::text AS cost_basis,
     valuation_basis, source_locator, row_hash`,
  balances: `id, account_id, as_of::text AS as_of, total_value::text AS total_value,
     cash::text AS cash, source_locator, row_hash`,
  liabilities: `id, account_id, kind, as_of::text AS as_of, balance::text AS balance,
     source_locator, row_hash`,
};

type HoldingRow = {
  id: string;
  account_id: string | null;
  as_of: string;
  source_locator: string | null;
  row_hash: string | null;
  instrument_id?: string | null;
  quantity?: string | null;
  market_value?: string | null;
  cost_basis?: string | null;
  valuation_basis?: string | null;
  total_value?: string | null;
  cash?: string | null;
  kind?: string;
  balance?: string | null;
};

function hashOf(
  table: HoldingTable,
  row: HoldingRow,
  accountId: string | null,
): string {
  if (table === "positions") {
    return positionHash({
      accountId: accountId!,
      instrumentId: row.instrument_id ?? null,
      asOf: row.as_of,
      quantity: row.quantity ?? null,
      marketValue: row.market_value ?? null,
      costBasis: row.cost_basis ?? null,
      valuationBasis: row.valuation_basis ?? null,
      sourceLocator: row.source_locator,
    });
  }
  if (table === "balances") {
    return balanceHash({
      accountId: accountId!,
      asOf: row.as_of,
      totalValue: row.total_value ?? null,
      cash: row.cash ?? null,
    });
  }
  return liabilityHash({
    accountId,
    kind: row.kind ?? "",
    asOf: row.as_of,
    balance: row.balance ?? null,
  });
}

/** One row this run moved, in the shape both reconciliation gates take
 * their scope in. Both accounts are reported: the period the row left has to
 * be re-derived just as much as the one it joined. */
export type MovedHolding = {
  readonly table: HoldingTable;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly instrumentId: string | null;
  readonly asOf: string;
};

/**
 * F1-56b. One misfiled row this run deleted because the account its printed
 * key names already holds the identical stated fact -- the consolidated
 * statement's copy of a holding that account's own statement already stated.
 * `duplicateOfAccountId` is where the surviving row lives, which is also the
 * account the deleted row should have been under all along.
 */
export type RemovedHolding = {
  readonly table: HoldingTable;
  readonly documentId: string;
  /** The account the row was wrongly filed under, and left. */
  readonly accountId: string;
  readonly duplicateOfAccountId: string;
  readonly instrumentId: string | null;
  readonly asOf: string;
};

export type MoveOutcome = {
  readonly examined: number;
  readonly moved: readonly MovedHolding[];
  /** F1-56b. Deleted as duplicates of a row already at the target account,
   * and only when `removeDuplicates` asked for it. */
  readonly removed: readonly RemovedHolding[];
  /** The stored `row_hash` disagreed with the one recomputed from the stored
   * row under its current account: something about this row's hashed content
   * is not what `importer.ts` wrote. Never moved -- rehashing it would paper
   * over whatever the disagreement is. */
  readonly hashMismatch: number;
  /** The target account already holds a row with the same content identity,
   * so moving this one would collide on `row_hash`. Left exactly where it
   * is: without `removeDuplicates` this is a thing for a person to look at,
   * and even with it, a blocking row that is not actually *at* the target
   * account stays here rather than being deduplicated against something
   * whose location this code could not confirm. */
  readonly collision: number;
};

/**
 * Moves this document's rows in one holdings table from the account they were
 * filed under to the account their printed key now resolves to, recomputing
 * `row_hash` for the new account.
 *
 * `targetByLocator` is `source_locator -> accounts.id`, built from the
 * reparse: only locators whose target differs from `fromAccountId` belong in
 * it. Idempotent -- a row already at its target is not selected at all, since
 * the WHERE clause pins `account_id = fromAccountId`.
 *
 * F1-56b. `removeDuplicates` decides what happens to a row that cannot move
 * because the target already holds its content. On the owner's archive that
 * is 24,811 of 26,069 examined rows, and it is not an anomaly: a household
 * is covered twice over, once by each account's own statement and once by a
 * consolidated statement, so the consolidated copy of a holding is the same
 * stated fact the account's own statement already contributed. Left in
 * place, it is a second copy of one holding under the wrong account, which
 * double-counts that account's holdings and fails its gates.
 *
 * Deleting it is safe in the way that matters for this archive: the raw tree
 * is the source of truth and the database is derived (ground rule 1), the
 * surviving row states the identical fact, and a later reparse of the
 * consolidated statement resolves that holding to the target account, where
 * `row_hash` finds the survivor and deduplicates -- so the deletion stays
 * deleted rather than being undone by the next run. What is lost is the
 * second citation, the consolidated statement's own `source_document_id`
 * and `source_locator` for a fact that keeps a citation either way; that is
 * the trade, and it is recorded (see `duplicateRemovalReviewItems`).
 *
 * The blocking row's `account_id` is read and checked against the target
 * rather than inferred from its hash. A hash says where a row *should* be;
 * only the column says where it is, and a DELETE is not the place to trust
 * the first over the second.
 */
export async function moveHoldings(
  client: ArchiveClient,
  table: HoldingTable,
  documentId: string,
  fromAccountId: string,
  targetByLocator: ReadonlyMap<string, string>,
  removeDuplicates = false,
): Promise<MoveOutcome> {
  const moved: MovedHolding[] = [];
  const removed: RemovedHolding[] = [];
  if (targetByLocator.size === 0) {
    return { examined: 0, moved, removed, hashMismatch: 0, collision: 0 };
  }
  const found = await client.query<HoldingRow>(
    `SELECT ${HASH_SELECT[table]} FROM ${table}
      WHERE source_document_id = $1 AND account_id = $2 AND source_locator = ANY($3::text[])`,
    [documentId, fromAccountId, [...targetByLocator.keys()]],
  );

  let hashMismatch = 0;
  const planned: Array<{
    id: string;
    accountId: string;
    hash: string;
    row: HoldingRow;
  }> = [];
  for (const row of found.rows) {
    const target = targetByLocator.get(row.source_locator ?? "");
    if (target === undefined) continue;
    const current = hashOf(table, row, row.account_id);
    if (row.row_hash !== null && row.row_hash !== current) {
      hashMismatch += 1;
      continue;
    }
    planned.push({
      id: row.id,
      accountId: target,
      hash: hashOf(table, row, target),
      row,
    });
  }
  if (planned.length === 0) {
    return {
      examined: found.rows.length,
      moved,
      removed,
      hashMismatch,
      collision: 0,
    };
  }

  // Checked rather than caught: a UNIQUE violation inside a transaction
  // aborts it, and this runs inside the caller's one alongside every other
  // document's work. `account_id` comes back too, so the duplicate branch
  // below can confirm the blocking row is where its hash claims.
  const taken = await client.query<{ row_hash: string; account_id: string | null }>(
    `SELECT row_hash, account_id FROM ${table} WHERE row_hash = ANY($1::text[])`,
    [planned.map((p) => p.hash)],
  );
  const blockedBy = new Map(
    taken.rows.map((r) => [r.row_hash, r.account_id] as const),
  );
  // Hashes claimed by a row this same call is about to write. Distinct from
  // `blockedBy`, whose rows exist and can be checked; nothing is ever
  // deleted against one of these.
  const claimed = new Set<string>();
  const updates: typeof planned = [];
  const deletions: typeof planned = [];
  let collision = 0;
  for (const plan of planned) {
    const blockingAccount = blockedBy.get(plan.hash);
    if (blockingAccount !== undefined || claimed.has(plan.hash)) {
      if (removeDuplicates && blockingAccount === plan.accountId) {
        deletions.push(plan);
      } else {
        collision += 1;
      }
      continue;
    }
    claimed.add(plan.hash);
    updates.push(plan);
  }

  if (deletions.length > 0) {
    await client.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [
      deletions.map((d) => d.id),
    ]);
    for (const deletion of deletions) {
      removed.push({
        table,
        documentId,
        accountId: fromAccountId,
        duplicateOfAccountId: deletion.accountId,
        instrumentId: deletion.row.instrument_id ?? null,
        asOf: deletion.row.as_of,
      });
    }
  }

  if (updates.length > 0) {
    await client.query(
      `UPDATE ${table} t SET account_id = c.account_id, row_hash = c.row_hash
         FROM unnest($1::text[], $2::text[], $3::text[]) AS c(id, account_id, row_hash)
        WHERE t.id = c.id`,
      [
        updates.map((u) => u.id),
        updates.map((u) => u.accountId),
        updates.map((u) => u.hash),
      ],
    );
    for (const update of updates) {
      moved.push({
        table,
        fromAccountId,
        toAccountId: update.accountId,
        instrumentId: update.row.instrument_id ?? null,
        asOf: update.row.as_of,
      });
    }
  }
  return { examined: found.rows.length, moved, removed, hashMismatch, collision };
}

/**
 * F1-56b. A snapshot date that left one account, whether it moved to another
 * or was deleted as a duplicate. `instrumentId` is null for a balance, whose
 * gate has no instrument dimension.
 */
export type DepartedSnapshot = {
  readonly table: HoldingTable;
  readonly accountId: string;
  readonly instrumentId: string | null;
  readonly asOf: string;
};

/** Every snapshot that left an account this run: the `from` side of each
 * move and the account each deleted duplicate was removed from. */
export function departedSnapshots(
  moved: readonly MovedHolding[],
  removed: readonly RemovedHolding[],
): DepartedSnapshot[] {
  return [
    ...moved.map((move) => ({
      table: move.table,
      accountId: move.fromAccountId,
      instrumentId: move.instrumentId,
      asOf: move.asOf,
    })),
    ...removed.map((row) => ({
      table: row.table,
      accountId: row.accountId,
      instrumentId: row.instrumentId,
      asOf: row.asOf,
    })),
  ];
}

/**
 * F1-56b. Deletes the verdicts for periods that no longer exist.
 *
 * A stated snapshot is a period boundary: a series with snapshots at d1, d2
 * and d3 has the periods [d1, d2] and [d2, d3]. When d2 leaves the account,
 * the real series is [d1, d3] and both stored verdicts are about periods
 * that are gone. Neither gate removes them on its own -- each deletes only
 * the periods it is about to rewrite, and a period that no longer exists is
 * never rewritten, so even a whole-archive pass leaves both behind. The
 * merged [d1, d3] period is then written by that whole-archive pass, which
 * is why this runs before it and not instead of it.
 *
 * Guarded by `NOT EXISTS`: a date is only a departed boundary if *no* row
 * remains at it for that series. Two documents can state the same account,
 * instrument and date, and moving one of them out leaves the boundary
 * standing.
 */
export async function deleteVanishedPeriodVerdicts(
  client: ArchiveClient,
  departed: readonly DepartedSnapshot[],
): Promise<{ cash: number; positions: number }> {
  const positions = departed.filter(
    (row) => row.table === "positions" && row.instrumentId !== null,
  );
  const balances = departed.filter((row) => row.table === "balances");

  let positionsDeleted = 0;
  if (positions.length > 0) {
    const result = await client.query(
      `DELETE FROM position_reconciliations r
        USING unnest($1::text[], $2::text[], $3::date[]) AS d(account_id, instrument_id, as_of)
        WHERE r.account_id = d.account_id AND r.instrument_id = d.instrument_id
          AND (r.period_start = d.as_of OR r.period_end = d.as_of)
          AND NOT EXISTS (
            SELECT 1 FROM positions p
             WHERE p.account_id = d.account_id AND p.instrument_id = d.instrument_id
               AND p.as_of = d.as_of)`,
      [
        positions.map((row) => row.accountId),
        positions.map((row) => row.instrumentId),
        positions.map((row) => row.asOf),
      ],
    );
    positionsDeleted = result.rowCount ?? 0;
  }

  let cashDeleted = 0;
  if (balances.length > 0) {
    const result = await client.query(
      `DELETE FROM reconciliations r
        USING unnest($1::text[], $2::date[]) AS d(account_id, as_of)
        WHERE r.account_id = d.account_id
          AND (r.period_start = d.as_of OR r.period_end = d.as_of)
          AND NOT EXISTS (
            SELECT 1 FROM balances b
             WHERE b.account_id = d.account_id AND b.as_of = d.as_of)`,
      [balances.map((row) => row.accountId), balances.map((row) => row.asOf)],
    );
    cashDeleted = result.rowCount ?? 0;
  }
  return { cash: cashDeleted, positions: positionsDeleted };
}

/**
 * F1-56b. One `duplicate_holding_removed` item per document and table, so a
 * deletion leaves a durable, joinable record in the archive rather than only
 * a number on an operator's terminal. Summarized rather than one item per
 * row: 24,811 items would bury every other open item in the queue, and the
 * fact worth recording is "this document's copy of N holdings was removed in
 * favour of account X's own statement", which is per document.
 *
 * Written through `review_items` rather than a new table because that is
 * where this archive already records "something was decided about these rows
 * and here is why".
 *
 * F1-65. `source_locator` names the table and the target account
 * (`${table}:${duplicateOfAccountId}`) rather than staying null: this is
 * the one thing that tells two groups for the same document apart (a
 * positions removal and a balances removal can share one document and the
 * same count), and `review_items_dedupe_key` (pgSchema.ts) now covers a
 * document-scoped item even with a null locator, so two such groups would
 * otherwise collide on INSERT instead of each getting their own row.
 */
export function duplicateRemovalReviewItems(
  removed: readonly RemovedHolding[],
  now: Date,
): unknown[][] {
  const groups = new Map<string, { row: RemovedHolding; count: number }>();
  for (const row of removed) {
    const key = `${row.documentId}\u0000${row.table}\u0000${row.duplicateOfAccountId}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { row, count: 1 });
  }
  return [...groups.values()].map(({ row, count }) => [
    randomUUID(),
    "duplicate_holding_removed",
    row.accountId,
    row.documentId,
    `${row.table}:${row.duplicateOfAccountId}`,
    String(count),
    `${count} ${row.table} row(s) this document stated under account ${row.accountId} were ` +
      `removed on ${now.toISOString()}: the account their printed number names ` +
      `(${row.duplicateOfAccountId}) already held a row with the identical stated content, ` +
      "so this consolidated copy was a second copy of one holding filed under the wrong " +
      "account. The surviving row keeps its own document citation; this one's is gone",
  ]);
}


/**
 * Closes every open `unknown_account_key` item whose key now resolves. The
 * reason those items state -- "does not resolve to any account this
 * institution's discover() reported" -- is no longer true, and that is the
 * whole condition: the items carry no document or row pointer (they predate
 * the fix that gives them one), so `raw_value` is the only thing there is to
 * match on, and it is enough. Only `open` items are touched, so a reviewer's
 * own dismissal is never reopened or overwritten.
 */
export async function closeResolvedAccountKeyItems(
  client: ArchiveClient,
  keys: readonly string[],
  note: string,
  now: Date,
): Promise<number> {
  if (keys.length === 0) return 0;
  const result = await client.query(
    `UPDATE review_items
        SET status = 'resolved', resolved_at = $2, resolution_note = $3
      WHERE kind = 'unknown_account_key' AND status = 'open'
        AND raw_value = ANY($1::text[])`,
    [[...keys], now.toISOString(), note],
  );
  return result.rowCount ?? 0;
}

/** How many `review_items` of one kind are open. Printed before and after a
 * re-attribution so the run's effect on the queue is a measured fact. */
export async function countOpenReviewItems(
  client: ArchiveClient,
  kind: string,
): Promise<number> {
  const result = await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM review_items WHERE kind = $1 AND status = 'open'",
    [kind],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Rows per holdings table for one set of accounts, as `accounts.id -> n`.
 * The before/after pair a re-attribution reports. */
export async function countHoldingsByAccount(
  client: ArchiveClient,
  table: HoldingTable,
  accountIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (accountIds.length === 0) return counts;
  const result = await client.query<{ account_id: string; n: string }>(
    `SELECT account_id, count(*)::text AS n FROM ${table}
      WHERE account_id = ANY($1::text[]) GROUP BY account_id`,
    [[...accountIds]],
  );
  for (const row of result.rows) counts.set(row.account_id, Number(row.n));
  return counts;
}
