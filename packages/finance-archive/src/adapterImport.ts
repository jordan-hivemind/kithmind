// The seam between an institution adapter's parse() output (ParsedRow, see
// adapter.ts) and the importer's row shape (ImportRow, see importer.ts).
// Neither F1-2 nor F1-3 owned this mapping; this file does.
//
// Two things happen here that neither adapter.ts nor importer.ts can do on
// its own:
//
// 1. Instrument resolution. `parse()` returns a descriptor (symbol, cusip,
//    isin, name); the importer wants a resolved `instrumentId`. Nothing
//    before this file creates `instruments` rows.
// 2. Document splitting. A paginated pull is captured as one immutable
//    RawFile (one content hash), but is logically several documents for
//    dedupe purposes -- one per page -- so the same real transaction on an
//    overlapping page boundary lands on the same occurrence ordinal (and
//    therefore the same row_hash) in each page's document and collapses.
//    See ParsedRow.sourceDocument's doc comment for the reasoning.

import { randomUUID } from "node:crypto";

import type {
  AcquiredDocument,
  ActivityTaxonomy,
  DiscoveredAccount,
  InstitutionCapabilities,
  ParsedBalance,
  ParsedHoldings,
  ParsedInstrument,
  ParsedLiability,
  ParsedPosition,
  ParsedRow,
} from "./adapter.js";
import { EMPTY_HOLDINGS, sha256Hex } from "./adapter.js";
import {
  CAPTURE_MANIFEST_VERSION,
  type CaptureWriteResult,
  writeCaptureManifest,
} from "./captures.js";
import { canonicalizeDecimal, compareDecimal } from "./decimal.js";
import type {
  ImportBalance,
  ImportDocument,
  ImportLiability,
  ImportPosition,
  ImportRow,
} from "./importer.js";
import { toMinorUnits } from "./money.js";
import { toNumericText } from "./pgNumeric.js";
import { type ArchiveClient, withArchiveTransaction } from "./pgStore.js";
import {
  type RawTreeWriteResult,
  writeRawDocument,
  writeRetainedText,
} from "./rawTree.js";
import { retainPayload } from "./retention.js";
import { contentKeyV2, rowHashV2 } from "./rowHash.js";

/**
 * One acquired-and-parsed pull, ready to become one or more `ImportDocument`s.
 * `persisted` is the raw tree's own record of where this pull's bytes (and
 * any retained text) actually live -- the *only* way to get one is to call
 * `persistAcquiredDocument` first, which is what makes it structurally
 * impossible to build an `AdapterPull` around a `filePath` nothing ever
 * wrote (this is exactly the bug F1-18 exists to fix; see
 * `persistAcquiredDocument`'s doc comment below).
 *
 * `holdings` defaults to `EMPTY_HOLDINGS` when omitted: most pulls (every
 * paginated activity feed, every tabular export) carry none, and a caller
 * building one from an activity-only adapter's `parse()` output does not
 * need to spell that out.
 */
export type AdapterPull = {
  readonly institutionId: string;
  /**
   * F1-35. Null only for an institution-wide pull (`run.ts`'s
   * `"scope": "institution"` selection, `structured_api`/`tabular_export`
   * only): such a pull names no single account, so `ImportDocument.accountId`
   * becomes null too. Every row still needs its own account to import under
   * -- see `accountsByExternalKey` below -- a row that cannot resolve one is
   * refused rather than written with no account (`transactions.account_id`
   * is `NOT NULL`).
   */
  readonly accountId: string | null;
  readonly acquired: AcquiredDocument;
  readonly rows: readonly ParsedRow[];
  readonly holdings?: ParsedHoldings;
  readonly docType: string;
  readonly docDate: string | null;
  readonly persisted: PersistedAcquisition;
  /**
   * F1-19. The institution's declared `ActivityTaxonomy` (adapter.ts),
   * normally `adapter.capabilities().activityTaxonomy`. Optional so every
   * `AdapterPull` built before this taxonomy existed keeps working exactly
   * as before: omitting it skips the validation below entirely (no review
   * items, no nulled fields), rather than treating every row as
   * undeclared. A real caller (`run.ts`) always supplies it.
   */
  readonly activityTaxonomy?: ActivityTaxonomy;
  /**
   * F1-35. What `resolveDiscoveredAccounts` returned for this institution,
   * keyed by `DiscoveredAccount.externalKey` -- `run.ts` calls it once per
   * run and passes the same map to every pull. A row carrying
   * `ParsedRow.accountExternalKey` resolves against this map instead of
   * always importing under `accountId`, which is what lets one pull's rows
   * span several accounts (an institution-wide structured-API/tabular-export
   * response that returns every account's activity together).
   *
   * Optional, and deliberately inert when omitted: a caller that builds an
   * `AdapterPull` without this map is not asking for per-row attribution, so
   * every row keeps importing under `accountId` exactly as it did before
   * this field existed, even if the row itself carries an
   * `accountExternalKey` -- no query, no review item, no behavior change.
   */
  readonly accountsByExternalKey?: ReadonlyMap<string, string>;
};

type ReviewItemFields = {
  kind: string;
  accountId: string | null;
  rawValue: string | null;
  reason: string;
};

async function openReviewItem(
  client: ArchiveClient,
  fields: ReviewItemFields,
): Promise<void> {
  await client.query(
    `INSERT INTO review_items (id, kind, account_id, source_document_id, source_locator, raw_value, reason)
     VALUES ($1, $2, $3, NULL, NULL, $4, $5)`,
    [
      randomUUID(),
      fields.kind,
      fields.accountId,
      fields.rawValue,
      fields.reason,
    ],
  );
}

/**
 * F1-19 operator gap. `run.ts` required the selection file's `institutionId`
 * to already name an existing `institutions` row, and the README called
 * provisioning one out of this package's scope -- so a first run against a
 * fresh archive could not start at all. An adapter's own `capabilities()`
 * already states its slug and name, which is everything the row needs, so
 * `run.ts` now resolves it here before `discover` instead of requiring an
 * operator to have inserted it by hand first.
 *
 * Upserts by `slug` (the schema's own UNIQUE constraint): a first call for a
 * new institution inserts it and returns the new id; a later call for the
 * same slug updates only `name` and returns the same id it always has,
 * rather than minting a second row for one institution every run.
 */
export async function resolveInstitution(
  client: ArchiveClient,
  capabilities: InstitutionCapabilities,
): Promise<string> {
  return withArchiveTransaction(client, async () => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO institutions (id, name, slug)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [
        randomUUID(),
        capabilities.institutionName,
        capabilities.institutionSlug,
      ],
    );
    // ON CONFLICT ... RETURNING always yields exactly one row for a single
    // VALUES insert, whichever branch fired.
    return result.rows[0]!.id;
  });
}

/**
 * Resolves a parsed instrument descriptor to a stable `instruments.id`,
 * creating the row the first time it is seen. Identity strength follows the
 * plan: a real identifier is preferred over a symbol.
 *
 * Precedence: `cusip`, then `isin`, then `symbol` and `name` together, then
 * `symbol` alone, then a new row. A bare symbol never *merges silently* --
 * matching on it alone opens a `review_items` entry recording the weak
 * identity and what it matched, the same way a cross-document row_hash
 * collapse is made visible rather than happening quietly -- but it does
 * resolve to the existing row rather than minting a new one every time.
 * Never merging on a bare symbol sounds safer than this, but it is not: it
 * means every reference to an instrument with no stronger identifier gets
 * its own row forever, scattering one real holding across many
 * `instrument_id`s and silently breaking any "every purchase of instrument
 * X" query. A flagged, stable match is the smaller failure of the two.
 */
export async function resolveInstrumentId(
  client: ArchiveClient,
  instrument: ParsedInstrument,
): Promise<string> {
  if (instrument.cusip) {
    return findOrCreateInstrument(
      client,
      "cusip",
      instrument.cusip,
      instrument,
    );
  }
  if (instrument.isin) {
    return findOrCreateInstrument(client, "isin", instrument.isin, instrument);
  }
  if (instrument.symbol && instrument.name) {
    const found = await client.query<{ id: string }>(
      "SELECT id FROM instruments WHERE symbol = $1 AND name = $2",
      [instrument.symbol, instrument.name],
    );
    const existing = found.rows[0];
    if (existing) return existing.id;
  }
  if (instrument.symbol) {
    // ponytail: ctid orders by physical position, which for this
    // insert-only table is insertion order, so this is the first instrument
    // row created for this symbol. A rewrite (VACUUM FULL, a future UPDATE)
    // could reorder it; add an inserted_at column if that ever matters.
    // Either way it is a naive heuristic -- there is no way to know if it is
    // the *right* row without a stronger identifier -- which is exactly why
    // the match is flagged for review rather than trusted silently.
    const found = await client.query<{
      id: string;
      cusip: string | null;
      isin: string | null;
      name: string | null;
    }>(
      "SELECT id, cusip, isin, name FROM instruments WHERE symbol = $1 ORDER BY ctid LIMIT 1",
      [instrument.symbol],
    );
    const weak = found.rows[0];
    if (weak) {
      await openReviewItem(client, {
        kind: "weak_instrument_match",
        accountId: null,
        rawValue: JSON.stringify(instrument),
        reason:
          `resolved by symbol "${instrument.symbol}" alone (no cusip, isin, or matching name) ` +
          `to existing instrument ${weak.id} (cusip=${weak.cusip ?? "null"}, isin=${weak.isin ?? "null"}, ` +
          `name=${JSON.stringify(weak.name)}); two different instruments sharing this symbol ` +
          "would incorrectly merge here -- confirm or correct this match",
      });
      return weak.id;
    }
  }
  return insertInstrument(client, instrument);
}

async function findOrCreateInstrument(
  client: ArchiveClient,
  column: "cusip" | "isin",
  value: string,
  instrument: ParsedInstrument,
): Promise<string> {
  // The column name is one of two literals chosen by this file, never caller
  // input, so it is safe to interpolate where a placeholder cannot go.
  const found = await client.query<{ id: string }>(
    `SELECT id FROM instruments WHERE ${column} = $1`,
    [value],
  );
  const existing = found.rows[0];
  if (existing) return existing.id;
  return insertInstrument(client, instrument);
}

async function insertInstrument(
  client: ArchiveClient,
  instrument: ParsedInstrument,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    "INSERT INTO instruments (id, symbol, cusip, isin, name) VALUES ($1, $2, $3, $4, $5)",
    [id, instrument.symbol, instrument.cusip, instrument.isin, instrument.name],
  );
  return id;
}

/**
 * Upserts one `accounts` row per account an adapter's `discover()` reported,
 * keyed on `accounts.external_key` (F1-32), and returns the id each
 * `externalKey` resolved to so a selection file can name an account by the
 * adapter's own opaque id instead of already knowing `accounts.id`. Matches
 * `resolveInstrumentId`'s job for instruments: neither the adapter interface
 * nor the importer owns turning an adapter-reported identity into a stable
 * archive row on its own.
 *
 * `label` maps to `display_name` and `kind` to `account_type` -- the two
 * columns with an honest one-to-one counterpart in `pgSchema.ts`.
 * `DiscoveredAccount` carries no currency, so a newly discovered account's
 * `base_currency` is left null rather than guessed (see the migration's own
 * comment); every other `accounts` column stays whatever a human operator
 * already set, since a repeat discovery only updates the three fields the
 * adapter actually reports.
 */
export async function resolveDiscoveredAccounts(
  client: ArchiveClient,
  institutionId: string,
  accounts: readonly DiscoveredAccount[],
): Promise<ReadonlyMap<string, string>> {
  const resolved = new Map<string, string>();
  for (const account of accounts) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO accounts (id, institution_id, external_key, acct_last4, display_name, account_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (institution_id, external_key) DO UPDATE
         SET acct_last4 = EXCLUDED.acct_last4,
             display_name = EXCLUDED.display_name,
             account_type = EXCLUDED.account_type
       RETURNING id`,
      [
        randomUUID(),
        institutionId,
        account.externalKey,
        account.last4,
        account.label,
        account.kind,
      ],
    );
    resolved.set(account.externalKey, result.rows[0]!.id);
  }
  return resolved;
}

/**
 * F1-35. The account one row's `accountExternalKey` resolves to against
 * `pull.accountsByExternalKey`, or `pull.accountId` when the row carries no
 * external key, or when this `AdapterPull` was built with no resolution map
 * at all (opt-in: see `AdapterPull.accountsByExternalKey`'s doc comment).
 * Pure -- no query, no review item -- so `countDistinctRowHashes` can reuse
 * it to predict the same account id `resolveRowAccountId` will actually
 * assign, and the two can never disagree about what "the same content"
 * hashes to. Null only when nothing resolves and the pull itself names no
 * account (an institution-wide pull with an unattributable row).
 */
function lookupRowAccountId(pull: AdapterPull, row: ParsedRow): string | null {
  if (row.accountExternalKey === undefined || pull.accountsByExternalKey === undefined) {
    return pull.accountId;
  }
  return pull.accountsByExternalKey.get(row.accountExternalKey) ?? pull.accountId;
}

/**
 * The account one row imports under: `lookupRowAccountId`'s result, plus the
 * side effect of opening `unknown_account_key` when the row named a key that
 * did not resolve against `pull.accountsByExternalKey` -- flagged rather
 * than silently dropped (ground rule 5), the same pattern
 * `resolveInstrumentId`'s weak-symbol match uses. The row still imports
 * under `pull.accountId` when that fallback exists.
 *
 * Throws only for an institution-wide pull (`pull.accountId === null`) whose
 * row's key did not resolve: there is no account left to fall back to, and
 * `transactions.account_id` is `NOT NULL`, so this refuses to write an
 * unattributable transaction rather than guess one.
 */
async function resolveRowAccountId(
  client: ArchiveClient,
  pull: AdapterPull,
  row: ParsedRow,
): Promise<string> {
  const resolved = lookupRowAccountId(pull, row);
  const unresolvedKey =
    row.accountExternalKey !== undefined &&
    pull.accountsByExternalKey !== undefined &&
    !pull.accountsByExternalKey.has(row.accountExternalKey)
      ? row.accountExternalKey
      : null;
  if (unresolvedKey !== null) {
    await openReviewItem(client, {
      kind: "unknown_account_key",
      accountId: pull.accountId,
      rawValue: unresolvedKey,
      reason:
        `row carries accountExternalKey ${JSON.stringify(unresolvedKey)}, which does not ` +
        "resolve to any account this institution's discover() reported; " +
        (pull.accountId === null
          ? "this institution-wide pull names no fallback account, so the row cannot be attributed"
          : "importing under the pull's own account instead"),
    });
  }
  if (resolved === null) {
    throw new Error(
      `row's accountExternalKey ${unresolvedKey === null ? "(missing)" : JSON.stringify(unresolvedKey)} ` +
        "did not resolve to an account, and this institution-wide pull names no fallback account " +
        "(accountId is null); refusing to import an unattributable transaction",
    );
  }
  return resolved;
}

type ActivityViolation = {
  readonly kind: string;
  readonly rawValue: string;
  readonly reason: string;
};

type ClassifiedActivity = {
  readonly quantity: string | null;
  readonly amount: string | null;
  readonly violations: readonly ActivityViolation[];
};

/**
 * -1, 0 or 1, tolerant of text too malformed to parse as a decimal (returns
 * 0, i.e. "no sign opinion"). A malformed quantity is `importer.ts`'s
 * `ambiguous_quantity` review item to raise, not this function's -- this
 * only judges the sign of a quantity that parses.
 */
function signOf(text: string): -1 | 0 | 1 {
  try {
    return compareDecimal(text, "0");
  } catch {
    return 0;
  }
}

/**
 * F1-19. Validates one parsed row against its institution's declared
 * `ActivityTaxonomy` (adapter.ts). Pure and side-effect free -- it only
 * decides what belongs in `review_items` and what the row's stored
 * `quantity`/`amount` become -- so both `parsedRowToImportRow` (which opens
 * the review items this returns) and `countDistinctRowHashes` (which needs
 * the same final values to predict the same row hashes `importer.ts` will
 * compute) can share it rather than risk disagreeing.
 *
 * A row whose type is not declared in `taxonomy` is not rejected: it passes
 * through unvalidated and is flagged for review, which is what leaves it
 * counting in both reconciliation gates exactly as an untaxonomied row
 * always did (ground rule: never silently correct, but also never silently
 * invent a declaration nobody made). `taxonomy` itself being `undefined`
 * (no `AdapterPull.activityTaxonomy` supplied at all) skips validation
 * entirely, with no violation and no review item -- pre-F1-19 behavior,
 * for a caller that has not adopted this taxonomy yet.
 *
 * A row whose sign, amount or quantity disagrees with its declared type
 * never has the offending field silently corrected: it is nulled and a
 * review item explains why, exactly like every other ambiguous value this
 * package refuses to guess at (ground rule 5).
 */
function classifyActivity(
  taxonomy: ActivityTaxonomy | undefined,
  row: ParsedRow,
): ClassifiedActivity {
  if (!taxonomy) {
    return { quantity: row.quantity, amount: row.amount, violations: [] };
  }

  const entry = taxonomy[row.activityType];
  if (!entry) {
    return {
      quantity: row.quantity,
      amount: row.amount,
      violations: [
        {
          kind: "undeclared_activity_type",
          rawValue: row.activityType,
          reason:
            `activity type "${row.activityType}" is not declared in this institution's ` +
            "activityTaxonomy; imported as-is, and counted toward both reconciliation " +
            "gates conservatively, until the adapter declares it",
        },
      ],
    };
  }

  const violations: ActivityViolation[] = [];
  let quantity = row.quantity;
  let amount = row.amount;

  if (!entry.movesCash && amount !== null) {
    violations.push({
      kind: "cash_on_noncash_activity",
      rawValue: amount,
      reason:
        `activity type "${row.activityType}" is declared movesCash: false, but this row ` +
        `carries a non-null amount ("${amount}"); nulling the amount rather than silently ` +
        "correcting it",
    });
    amount = null;
  }

  if (!entry.movesQuantity) {
    if (quantity !== null) {
      violations.push({
        kind: "quantity_on_nonquantity_activity",
        rawValue: quantity,
        reason:
          `activity type "${row.activityType}" is declared movesQuantity: false, but this ` +
          `row carries a non-null quantity ("${quantity}"); nulling the quantity rather ` +
          "than silently correcting it",
      });
      quantity = null;
    }
  } else if (entry.quantitySign !== "none" && quantity !== null) {
    const sign = signOf(quantity);
    const wrongSign =
      sign !== 0 &&
      ((entry.quantitySign === "positive" && sign < 0) ||
        (entry.quantitySign === "negative" && sign > 0));
    if (wrongSign) {
      violations.push({
        kind: "activity_sign_mismatch",
        rawValue: quantity,
        reason:
          `activity type "${row.activityType}" is declared quantitySign: ` +
          `${entry.quantitySign}, but this row's quantity ("${quantity}") has the opposite ` +
          "sign; nulling the quantity rather than silently correcting it",
      });
      quantity = null;
    }
  }

  return { quantity, amount, violations };
}

async function parsedRowToImportRow(
  client: ArchiveClient,
  accountId: string,
  taxonomy: ActivityTaxonomy | undefined,
  row: ParsedRow,
): Promise<ImportRow> {
  const classified = classifyActivity(taxonomy, row);
  for (const violation of classified.violations) {
    await openReviewItem(client, {
      kind: violation.kind,
      accountId,
      rawValue: violation.rawValue,
      reason: violation.reason,
    });
  }
  return {
    accountId,
    tradeDate: row.tradeDate,
    processDate: row.processDate,
    settleDate: row.settleDate,
    datePrecision: row.datePrecision,
    activityType: row.activityType,
    description: row.description,
    instrumentId:
      row.instrument === null
        ? null
        : await resolveInstrumentId(client, row.instrument),
    quantity: classified.quantity,
    price: row.price,
    amountText: classified.amount,
    amountNote: row.amountNote,
    currency: row.currency,
    runningBalance: row.runningBalance,
    // Widened, not discarded: every field-level locator parse() attached
    // (ground rule 2), not just the row-level one. transactions.source_locator
    // is a free-text column; get_evidence returns it opaque to the caller.
    sourceLocator: JSON.stringify(row.locators),
    providerTxnId: row.externalId,
  };
}

/**
 * Maps one parsed holding to the importer's row shape. `sourceDocument` is
 * used only for grouping (see `groupBySourceDocument`) and does not appear
 * on the `Import*` row itself, the same way `ParsedRow.sourceDocument`
 * never reaches `ImportRow` -- the document it belongs to is expressed by
 * which `ImportDocument` the row ends up on, not a field on the row.
 */
async function parsedPositionToImportPosition(
  client: ArchiveClient,
  position: ParsedPosition,
): Promise<ImportPosition> {
  return {
    asOf: position.asOf,
    instrumentId:
      position.instrument === null
        ? null
        : await resolveInstrumentId(client, position.instrument),
    quantity: position.quantity,
    price: position.price,
    marketValueText: position.marketValue,
    marketValueNote: position.marketValueNote,
    costBasis: position.costBasis,
    unrealized: position.unrealized,
    currency: position.currency,
    valuationBasis: position.valuationBasis,
    valuationNote: position.valuationNote,
    sourceLocator: JSON.stringify(position.locators),
  };
}

function parsedBalanceToImportBalance(balance: ParsedBalance): ImportBalance {
  return {
    asOf: balance.asOf,
    totalValueText: balance.totalValue,
    totalValueNote: balance.totalValueNote,
    cash: balance.cash,
    currency: balance.currency,
    periodStartValue: balance.periodStartValue,
    periodEndValue: balance.periodEndValue,
    sourceLocator: JSON.stringify(balance.locators),
  };
}

function parsedLiabilityToImportLiability(
  liability: ParsedLiability,
): ImportLiability {
  return {
    kind: liability.kind,
    displayName: liability.displayName,
    balanceText: liability.balance,
    balanceNote: liability.balanceNote,
    currency: liability.currency,
    rate: liability.rate,
    asOf: liability.asOf,
    collateralNote: liability.collateralNote,
    sourceLocator: JSON.stringify(liability.locators),
  };
}

/**
 * Groups rows by `sourceDocument`, preserving first-seen order and each
 * row's own order within its group. Shared by activity rows and every
 * holdings row type, all four of which carry `sourceDocument` for exactly
 * this reason (see `ParsedRow.sourceDocument`'s doc comment).
 */
function groupBySourceDocument<T extends { readonly sourceDocument: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.sourceDocument);
    if (group) group.push(row);
    else groups.set(row.sourceDocument, [row]);
  }
  return groups;
}

/** `Array.map` for an async mapper, one at a time and in order. */
async function mapSeries<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await map(item));
  return out;
}

/**
 * How many distinct transactions this pull's rows reduce to once each
 * page-document's own occurrence ordinal is applied, i.e. exactly the count
 * `importBatch` will insert for this pull if nothing else collides with an
 * earlier import. Computed with `contentKeyV2` and `rowHashV2` -- the same
 * pair `importer.ts` uses, in the same order, over the same normalized values
 * -- so this count is never allowed to drift from what the importer actually
 * does. Using one version's key with the other's hash is the specific way
 * this goes silently wrong, so the two are always taken together. Works with
 * or without provider transaction ids: unlike an id-based count, it cannot go
 * silent just because a source has none.
 *
 * F1-19: runs every row through the same `classifyActivity` taxonomy
 * validation `parsedRowToImportRow` applies, so a row whose amount or
 * quantity gets nulled for a declared-type violation predicts the same
 * content and hash here that `importBatch` will actually store -- taking one
 * of the pair's inputs from before validation and the other from after would
 * silently miscount, exactly the drift this function's own doc comment above
 * warns against for `contentKeyV2`/`rowHashV2`.
 *
 * F1-35: resolves each row's own account with `lookupRowAccountId` rather
 * than one account shared across every row, since an institution-wide (or
 * otherwise multi-account) pull's rows do not all share `pull.accountId`.
 * Two rows that are otherwise identical but post to different accounts must
 * predict different hashes here, exactly as `resolveRowAccountId` will make
 * them import under different accounts.
 */
function countDistinctRowHashes(
  pull: AdapterPull,
  groups: ReadonlyMap<string, readonly ParsedRow[]>,
): number {
  const hashes = new Set<string>();
  for (const rows of groups.values()) {
    // Fresh per page-document, mirroring importBatch: the ordinal is scoped
    // to one document so the same real transaction on an overlapping page
    // lands on the same ordinal (and hash) in each page's document.
    const occurrences = new Map<string, number>();
    for (const row of rows) {
      const accountId = lookupRowAccountId(pull, row);
      if (accountId === null) {
        throw new Error(
          `row's accountExternalKey ${row.accountExternalKey ? JSON.stringify(row.accountExternalKey) : "(missing)"} ` +
            "did not resolve to an account, and this institution-wide pull names no fallback account; " +
            "refusing to import an unattributable transaction",
        );
      }
      const classified = classifyActivity(pull.activityTaxonomy, row);
      let amount: string | null = null;
      if (classified.amount !== null) {
        try {
          // Both of the importer's checks, in the importer's order: the
          // minor-unit check for ambiguous money, then canonicalization to
          // the decimal that is stored and hashed. A value failing either
          // becomes NULL on import (ground rule 5), so NULL is what belongs
          // in the hash here as well.
          toMinorUnits(classified.amount, row.currency);
          amount = toNumericText(classified.amount);
        } catch {
          // Ambiguous money: importBatch stores NULL for this too.
        }
      }
      let quantity: string | null = null;
      if (classified.quantity !== null) {
        try {
          quantity = toNumericText(classified.quantity);
        } catch {
          // A malformed quantity becomes NULL on import too; same reasoning.
        }
      }
      const content = {
        accountId,
        processDate: row.processDate,
        activityType: row.activityType,
        description: row.description,
        quantity,
        amount,
        currency: row.currency,
      };
      const key = contentKeyV2(content);
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      hashes.add(rowHashV2({ ...content, occurrence }));
    }
  }
  return hashes.size;
}

/**
 * Turns one adapter pull into the `ImportDocument`s `importBatch` consumes.
 *
 * A pull that parse() reported as a single document (`sourceDocument`
 * constant across every row -- the normal case for a statement, a
 * confirmation, or a tabular export) becomes one `ImportDocument`, and the
 * pull's own `providerReportedCount` is asserted on it exactly as before.
 *
 * A paginated pull (several distinct `sourceDocument` values) becomes one
 * `ImportDocument` per page, so ground rule 7 -- the whole pull must
 * reconcile against the provider's own reported total -- is checked
 * separately here, across every page: the post-dedup row_hash count (see
 * `countDistinctRowHashes`) is compared against `reportedRowCount`, which
 * works whether or not the rows carry a provider transaction id. When the
 * provider reports no total at all, that pull's completeness cannot be
 * checked at all, and ground rule 7 forbids asserting it anyway: this opens
 * a `review_items` entry recording that this pull was never verified,
 * rather than importing it with no mark left behind.
 *
 * Holdings (`pull.holdings`) are grouped and attached to `ImportDocument`s
 * the same way activity rows are, each `ParsedPosition`/`ParsedBalance`/
 * `ParsedLiability` carrying its own `sourceDocument` so a holding lands on
 * the right document even when a pull's activity is paginated and its
 * holdings are not (the normal case: a statement's positions table is never
 * itself paginated). Ground rule 7's provider-total check above stays scoped
 * to activity rows -- `reportedRowCount` is a transaction-row count, and
 * holdings have no analogous provider total to reconcile against.
 */
export async function adapterPullToImportDocuments(
  client: ArchiveClient,
  pull: AdapterPull,
): Promise<ImportDocument[]> {
  // In a transaction, and nesting into the caller's when there is one. The
  // instrument and review rows this opens are writes, so they belong in one
  // unit rather than autocommitting one statement at a time, and the
  // transaction is also what pins `search_path` on a pooled endpoint.
  return withArchiveTransaction(client, () => collectDocuments(client, pull));
}

async function collectDocuments(
  client: ArchiveClient,
  pull: AdapterPull,
): Promise<ImportDocument[]> {
  const activityGroups = groupBySourceDocument(pull.rows);
  const holdings = pull.holdings ?? EMPTY_HOLDINGS;
  const positionGroups = groupBySourceDocument(holdings.positions);
  const balanceGroups = groupBySourceDocument(holdings.balances);
  const liabilityGroups = groupBySourceDocument(holdings.liabilities);
  const reportedRowCount = pull.acquired.manifest.reportedRowCount;

  // F1-23, moved here from persistAcquiredDocument (F1-33): a provider field
  // the adapter's retention declaration does not name is dropped, which is
  // the safe outcome, but it is never a *silent* one. Opened once per pull,
  // against the archive `review_items` reads, rather than the SQLite
  // provenance file no reader of the archive ever consulted. Paths only,
  // never values -- a leak report that quotes the leak is not a fix.
  if (pull.acquired.retention.droppedPaths.length > 0) {
    await openReviewItem(client, {
      kind: "retention_dropped_fields",
      accountId: pull.accountId,
      rawValue: pull.acquired.retention.droppedPaths.join(" "),
      reason:
        `the retained projection of this document dropped ${pull.acquired.retention.droppedPaths.length} ` +
        `undeclared source path(s) under policy ${JSON.stringify(pull.acquired.retention.policy.version)}; ` +
        "the provider's payload carries fields the adapter does not declare -- confirm none of " +
        "them is business data the archive should be retaining, then extend the declaration",
    });
  }

  if (activityGroups.size > 1) {
    if (reportedRowCount === null) {
      await openReviewItem(client, {
        kind: "unverified_pagination_total",
        accountId: pull.accountId,
        rawValue: pull.acquired.manifest.contentHash,
        reason:
          `paginated pull split into ${activityGroups.size} page document(s), but the provider ` +
          "reported no total for this pull; completeness cannot be asserted (ground rule 7) " +
          "without a stated total to reconcile against -- treat this pull as unverified",
      });
    } else {
      const distinct = countDistinctRowHashes(pull, activityGroups);
      if (distinct !== reportedRowCount) {
        throw new Error(
          `adapter pull reported ${reportedRowCount} unique row(s) but ${distinct} distinct ` +
            `row(s) remain after per-document dedup across ${activityGroups.size} page document(s); ` +
            "refusing to import a pull that does not reconcile against the provider's total " +
            "(ground rule 7)",
        );
      }
    }
  }

  const sourceDocuments = new Set<string>([
    ...activityGroups.keys(),
    ...positionGroups.keys(),
    ...balanceGroups.keys(),
    ...liabilityGroups.keys(),
  ]);
  const single = sourceDocuments.size === 1;

  const documents: ImportDocument[] = [];
  for (const sourceDocument of sourceDocuments) {
    documents.push({
      // For a single document this literally is the acquired file's own
      // content hash. A page split has no bytes of its own -- the whole
      // pull was captured as one immutable RawFile -- so its "document"
      // identity is derived from that same content hash plus the page key,
      // which is still stable and still changes if the underlying pull does.
      sha256: single
        ? pull.acquired.manifest.contentHash
        : sha256Hex(
            new TextEncoder().encode(
              `${pull.acquired.manifest.contentHash}:${sourceDocument}`,
            ),
          ),
      filePath: single
        ? pull.persisted.filePath
        : `${pull.persisted.filePath}#${sourceDocument}`,
      // The bytes themselves, as opposed to the row identity above. One pull
      // is one immutable retained object however many page documents it
      // splits into, so every page row carries the same four values and a
      // citation resolves to the bytes that were actually parsed (F1-29).
      // `acquired.bytes` is what `persistAcquiredDocument` re-projected,
      // hashed and wrote, and it refuses the pull if that hash disagrees with
      // the manifest's, so the length here belongs to these exact bytes.
      retainedSha256: pull.acquired.manifest.contentHash,
      retainedByteLength: pull.acquired.bytes.byteLength,
      mediaType: pull.acquired.manifest.mediaType,
      captureId: pull.persisted.captureId,
      textPath: pull.persisted.textPath,
      institutionId: pull.institutionId,
      accountId: pull.accountId,
      docType: pull.docType,
      docDate: pull.docDate,
      providerReportedCount: single ? reportedRowCount : null,
      // Sequential rather than concurrent on purpose: instrument resolution
      // creates rows, and two rows for the same new instrument resolved in
      // parallel would each fail to find it and mint a second id.
      rows: await mapSeries(activityGroups.get(sourceDocument) ?? [], async (row) => {
        const accountId = await resolveRowAccountId(client, pull, row);
        return parsedRowToImportRow(client, accountId, pull.activityTaxonomy, row);
      }),
      positions: await mapSeries(
        positionGroups.get(sourceDocument) ?? [],
        (position) => parsedPositionToImportPosition(client, position),
      ),
      balances: (balanceGroups.get(sourceDocument) ?? []).map(
        parsedBalanceToImportBalance,
      ),
      liabilities: (liabilityGroups.get(sourceDocument) ?? []).map(
        parsedLiabilityToImportLiability,
      ),
    });
  }
  return documents;
}

// --- F1-18: raw tree persistence -------------------------------------------
// `acquire` (adapter.ts) returns bytes and a manifest; nothing before this
// wrote them anywhere. This is the seam: the one place an adapter pull's raw
// bytes (and, when the caller has retained it, the document's extracted
// text) actually get written to the raw tree, before the pull becomes an
// `AdapterPull.persisted`/`ImportDocument.filePath` that `importBatch`
// records on the `documents` row. `persistAcquiredDocument` is also the
// *only* way to produce a `PersistedAcquisition`, which is in turn the only
// way to fill in `AdapterPull.persisted` -- so a caller cannot build an
// `AdapterPull` around an invented path, and cannot skip persisting bytes
// that a document row then claims exist.
//
// F1-33: this used to take a `node:sqlite` `DatabaseSync` handle, opened
// purely to read `institutions.slug` and `accounts.acct_last4` for the
// capture manifest -- a SQLite provenance file `run.ts` had to keep in sync
// with the real archive (Postgres) by hand, and that nothing downstream ever
// read. The caller already knows both values (an operator command reads them
// from the same Postgres archive it is about to import into; a test already
// has its own fixture), so they are plain fields on `AcquisitionDescriptor`
// now and this function touches no database at all: it only calls into
// rawTree.ts (bytes) and captures.ts (acquisition provenance, F1-24). The
// retention_dropped_fields review item it used to write straight to that
// same SQLite file moved to `collectDocuments` below, which already opens
// `review_items` against the archive client for the same pull.

/** Everything needed to persist one acquired document and the capture that
 * produced it: enough for the raw tree's capture manifest (captures.ts) to
 * identify both without the archive database, on top of the acquired bytes
 * themselves. */
export type AcquisitionDescriptor = {
  /** The archive's `institutions.id`. Also the capture's opaque source
   * identity: the path segment under `captures/` and the manifest's
   * `sourceId` (F1-34, see captures.ts). */
  readonly institutionId: string;
  /**
   * F1-35: null for an institution-wide pull, which names no single account.
   * Not read by `persistAcquiredDocument` itself (it never opens a database
   * and has no account-scoped work to do); carried here only so a caller
   * building this descriptor from an `AdapterPull` never has to special-case
   * the institution-wide shape to satisfy this type.
   */
  readonly accountId: string | null;
  /** The institution's `institutions.slug`, recorded on the capture manifest
   * as metadata -- never a path segment (F1-34). The caller's own lookup,
   * not this function's: see the file header. */
  readonly institutionSlug: string;
  /** The account's `accounts.acct_last4`, or null for an account with none
   * recorded, or the literal `"all"` for an institution-wide pull that names
   * no single account (F1-35). Same reasoning as `institutionSlug`. */
  readonly accountLast4: string | null;
  readonly docType: string;
  readonly acquired: AcquiredDocument;
  /** Dot-prefixed (".pdf", ".csv"), when the source gave one. Recorded on
   * the capture manifest only; the raw bytes stay content-addressed and
   * extension-less either way. */
  readonly originalExtension?: string | null;
  /**
   * This acquisition attempt's own idempotency key (F1-24). Two calls with
   * the same `captureId` are two attempts at *one* acquisition -- a retry --
   * and must produce a byte-identical capture manifest; two calls with
   * different `captureId`s are two acquisitions, whether or not the bytes
   * they acquire turn out identical, and both keep their own provenance.
   * Defaults to a fresh random id when omitted, which is correct for any
   * caller that is not itself retrying a specific earlier attempt.
   */
  readonly captureId?: string;
};

/** What `persistAcquiredDocument` wrote and where, for the caller to use as
 * `AdapterPull.persisted` -- `textPath` ends up on `ImportDocument.textPath`,
 * written on the same insert as the rest of a document's provenance. */
export type PersistedAcquisition = {
  readonly filePath: string;
  readonly textPath: string | null;
  readonly captureId: string;
  readonly capturePath: string;
  readonly documentWrite: RawTreeWriteResult;
  readonly textWrite: RawTreeWriteResult | null;
  readonly captureWrite: CaptureWriteResult;
};

/**
 * Persists one acquired document's raw bytes -- and, when supplied, its
 * retained extracted text -- to the raw tree rooted at `rawTreeRoot`, along
 * with a capture manifest (captures.ts) recording what this acquisition is:
 * institution, account, document type, statement period, capture time,
 * capability tier, gaps, original extension. That manifest is what makes
 * ground rule 1's "can be rebuilt from scratch" true in practice: the
 * archive database is derived data, so if it is ever lost, the raw tree
 * still says what each capture is well enough to re-import, instead of
 * becoming an unlabelled pile of hashes.
 *
 * F1-24: the document's bytes and the capture that acquired them are two
 * different write-once records now. `writeRawDocument` still keys purely on
 * content, so a second acquisition of byte-identical content never rewrites
 * the bytes; `writeCaptureManifest` keys on `captureId` instead, so that
 * second acquisition's own provenance -- its own time, source, period and
 * retention declaration -- is written as its own capture rather than
 * discarded because the bytes it names already exist. A repeat call with the
 * *same* `captureId` (a retry of one attempt) reports `status:
 * "already_exists"` on `documentWrite`/`textWrite`/`captureWrite`, never a
 * rewrite; reusing a `captureId` for a capture that would hash differently
 * is refused outright (`CaptureConflictError`), never silently overwritten
 * or silently coexisting. See `rawTree.ts` and `captures.ts` for how the
 * write-once and hash-verification guarantees are implemented.
 *
 * F1-23: re-applies the adapter's declared retention projection before
 * anything is hashed or written, and records the resulting
 * `RetentionRecord` on the capture manifest so the retained file is never
 * presented as the untouched provider response.
 *
 * Cross-checks the written sha256 against the adapter's own claimed
 * `acquired.manifest.contentHash`: an adapter that mis-hashed its own bytes
 * is exactly the kind of bug provenance exists to catch, not a reason to
 * store the bytes under a path some other code goes on to trust as if the
 * two hashes agreed. Institution and account are named by the caller
 * (`descriptor.institutionSlug`/`accountLast4`), not resolved from a
 * database here -- see the file header (F1-33).
 */
export function persistAcquiredDocument(
  rawTreeRoot: string,
  descriptor: AcquisitionDescriptor,
  extractedText: string | null = null,
): PersistedAcquisition {
  const {
    institutionId,
    institutionSlug,
    accountLast4,
    docType,
    acquired,
    originalExtension = null,
    captureId = randomUUID(),
  } = descriptor;

  // F1-23. The projection is re-applied here, at the one seam that produces
  // bytes for the raw tree, rather than trusted from the adapter. It is
  // idempotent, so for an adapter that projected correctly this is a no-op
  // that costs one parse; for an adapter that returned the response body, it
  // produces different bytes and the hash cross-check below fails loudly.
  // Combined with `writeRawDocument` accepting only a `RetainedPayload`,
  // there is no path by which an unprojected payload is hashed or written.
  const retained = retainPayload(
    acquired.retention.policy,
    acquired.bytes,
    acquired.manifest.kind,
  );
  if (retained.sha256 !== acquired.manifest.contentHash) {
    throw new Error(
      `acquired document's manifest hash ${acquired.manifest.contentHash} does not match ` +
        `the sha256 ${retained.sha256} of its retained bytes; refusing to persist a document ` +
        "whose adapter mis-reported its own content hash or hashed the provider's response " +
        "instead of the projection it retained",
    );
  }
  const documentWrite = writeRawDocument(rawTreeRoot, retained);
  if (documentWrite.sha256 !== retained.sha256) {
    // The raw tree hashes what it actually wrote. If that disagrees with the
    // projection's own hash, the bytes changed between the two, and the
    // whole point of the content hash is that it is the hash of the file.
    throw new Error(
      `retained bytes hashed ${retained.sha256} but landed on disk as ${documentWrite.sha256}; ` +
        "the content hash must always be the hash of the bytes in the raw tree",
    );
  }

  const captureWrite = writeCaptureManifest(rawTreeRoot, {
    version: CAPTURE_MANIFEST_VERSION,
    captureId,
    // F1-34: the capture's source identity is the institution row id, the
    // same opaque id the read contract's `sourceObject.sourceId` carries.
    // The descriptor already names it, and `AdapterPull` carries the same
    // `institutionId` onto the document rows, so there is no second value
    // here to drift from it; the slug rides along inside the record as
    // metadata rather than as the path segment.
    sourceId: institutionId,
    documentSha256: documentWrite.sha256,
    institutionSlug,
    acctLast4: accountLast4,
    docType,
    periodStart: acquired.manifest.periodStart,
    periodEnd: acquired.manifest.periodEnd,
    capturedAt: acquired.manifest.capturedAt,
    capabilityTier: acquired.manifest.kind,
    gaps: acquired.manifest.gaps,
    originalExtension,
    retention: acquired.retention,
  });

  const textWrite =
    extractedText === null
      ? null
      : writeRetainedText(rawTreeRoot, extractedText);
  return {
    filePath: documentWrite.path,
    textPath: textWrite?.path ?? null,
    captureId,
    capturePath: captureWrite.path,
    documentWrite,
    textWrite,
    captureWrite,
  };
}
