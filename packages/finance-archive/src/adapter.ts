// The institution adapter interface described in
// docs/plans/2026-09-07-financial-transaction-database.md ("Institution
// adapter interface" and "Repository and privacy boundary"). This is the
// published contract: an adapter is the unit of contribution and the unit of
// reuse, the only part a third party is expected to write, and the only part
// of this package meant to be read without also reading the store.
//
// An adapter knows one institution and nothing about the store. It returns
// data; it never imports the schema and never opens the archive file.
//
// No credential handling anywhere in this file or in any adapter. A person
// authenticates a browser session out of band; the adapter is handed a
// capability to read through that session, never the session's cookies,
// headers, tokens or any other secret. AdapterSession below is deliberately
// two async functions and nothing else, so there is no field an adapter could
// naturally store a credential in even if it wanted to.
//
// That closes the input side only. A provider can echo a credential back
// *inside a response body*, and the raw tree is a synced folder. So `acquire`
// does not return the response: it returns the retained projection of it,
// declared field by field in `retention.ts`. See `AcquiredDocument` below.

import { createHash } from "node:crypto";

import type { RetentionRecord } from "./retention.js";

/**
 * A capability to read through a browser session a person has already
 * authenticated. This is the only thing an adapter is given to work with; it
 * is never asked for and never carries a credential, a cookie or a header.
 * `path` and `query` are logical, institution-defined request identifiers
 * (an activity endpoint, an export id, a document id), not raw HTTP.
 */
export type AdapterSession = {
  readonly institutionSlug: string;
  fetchText(
    path: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<string>;
  fetchBytes(
    path: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<Uint8Array>;
};

/**
 * The four sources an institution can expose. `structured_api` and
 * `tabular_export` cover recurring activity pulls; `pdf_statement` and
 * `trade_confirmation` are the archival-ground-truth tier. An adapter
 * declares a subset of these honestly rather than claiming all four.
 */
export type CapabilityTier =
  | "structured_api"
  | "tabular_export"
  | "pdf_statement"
  | "trade_confirmation";

export type InstitutionCapabilities = {
  readonly institutionSlug: string;
  readonly institutionName: string;
  readonly tiers: readonly CapabilityTier[];
  readonly retentionWindow: {
    /** Oldest ISO date the provider still serves, or null if unknown/unbounded. */
    readonly earliest: string | null;
    readonly note: string;
  };
  /** Free-text, institution-specific gotchas. No real account or person. */
  readonly quirks: readonly string[];
};

// --- discover -----------------------------------------------------------

/**
 * Ground rule 7: never assert absence from a paginated listing. A listing is
 * either exhaustive against a stated total, or it says plainly that it is
 * incomplete and why. There is no third shape, so a caller can never receive
 * a partial result that looks complete.
 *
 * Build one of these with `exhaustiveListing` or `incompleteListing` rather
 * than the object literal directly; the constructors are what enforce the
 * rule below.
 */
export type Listing<T> =
  | {
      readonly status: "exhaustive";
      readonly items: readonly T[];
      /** The provider's stated total. Always a number, possibly zero. */
      readonly providerTotal: number;
    }
  | {
      readonly status: "incomplete";
      readonly items: readonly T[];
      /**
       * The provider's stated total, or null when the provider reports no
       * total at all. Null and 0 are different facts: 0 means the provider
       * was asked and said "none"; null means it was never asked or never
       * answers.
       */
      readonly providerTotal: number | null;
      readonly reason: string;
    };

/**
 * The only way to produce an exhaustive listing. Throws unless `items`
 * actually reconciles against `providerTotal`, so "exhaustive" can never be
 * asserted about a listing that only reached page one.
 */
export function exhaustiveListing<T>(
  items: readonly T[],
  providerTotal: number,
): Listing<T> {
  if (!Number.isInteger(providerTotal) || providerTotal < 0) {
    throw new RangeError(
      `providerTotal must be a non-negative integer, got ${providerTotal}`,
    );
  }
  if (items.length !== providerTotal) {
    throw new RangeError(
      `refusing to mark a listing exhaustive: got ${items.length} item(s) but the provider reported ${providerTotal}`,
    );
  }
  return { status: "exhaustive", items, providerTotal };
}

/** An honest partial listing: what was seen, what the provider claimed (if anything), and why it stopped. */
export function incompleteListing<T>(
  items: readonly T[],
  providerTotal: number | null,
  reason: string,
): Listing<T> {
  return { status: "incomplete", items, providerTotal, reason };
}

export type DiscoveredDocument = {
  /** Opaque, institution-defined id. Passed back into `acquire`. */
  readonly externalId: string;
  readonly kind: Extract<CapabilityTier, "pdf_statement" | "trade_confirmation">;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Human-readable, e.g. "Q1 statement". Never an account number or name. */
  readonly label: string;
};

export type DiscoveredExportRange = {
  readonly kind: Extract<CapabilityTier, "structured_api" | "tabular_export">;
  readonly earliest: string;
  readonly latest: string;
  /** Row count the provider reports for this range, or null if it reports none. */
  readonly reportedRowCount: number | null;
};

export type DiscoverResult = {
  readonly documents: Listing<DiscoveredDocument>;
  readonly exportRanges: readonly DiscoveredExportRange[];
};

// --- acquire --------------------------------------------------------------

/**
 * What to pull. The two export-tier sources are selected by period; the two
 * document-tier sources are selected by the `externalId` a prior `discover`
 * call returned. There is no shape here that admits a credential.
 */
export type AcquireSelection =
  | {
      readonly kind: Extract<CapabilityTier, "structured_api" | "tabular_export">;
      readonly session: AdapterSession;
      readonly periodStart: string;
      readonly periodEnd: string;
    }
  | {
      readonly kind: Extract<CapabilityTier, "pdf_statement" | "trade_confirmation">;
      readonly session: AdapterSession;
      readonly externalId: string;
    };

export type AcquisitionGap = {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly reason: string;
};

/**
 * What retained bytes are. The same four spellings the read contract's
 * evidence `sourceObject.mediaType` accepts; an adapter that retains
 * something else needs both this union and that one widened together.
 */
export type RetainedMediaType =
  | "application/pdf"
  | "application/json"
  | "text/csv; charset=utf-8"
  | "text/plain; charset=utf-8";

export type AcquisitionManifestEntry = {
  readonly kind: CapabilityTier;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** ISO 8601 instant the bytes were captured, not the document's own date. */
  readonly capturedAt: string;
  /**
   * sha256 of the **retained** bytes -- the bytes that reach the raw tree --
   * never of the provider's original response (F1-23). An adapter gets this
   * value from `retainPayload().sha256` rather than hashing anything itself,
   * and `persistAcquiredDocument` re-derives it from the projection and
   * refuses the document if the two disagree. Hashing the original and
   * storing the projection is the exact mistake this wording exists to stop.
   */
  readonly contentHash: string;
  /**
   * The media type of the **retained** bytes, declared rather than inferred
   * from `kind`. Only the adapter knows what it actually retained: a
   * `pdf_statement` tier does not make the bytes a PDF, and the synthetic
   * fixture's statement bytes are UTF-8 text. The archive records this on the
   * document so a citation can say what a consumer has to parse
   * (docs/plans/2026-09-11-structured-evidence.md).
   */
  readonly mediaType: RetainedMediaType;
  /**
   * The row count the provider claimed for this pull, when it claims one, so
   * the importer can assert against it (ground rule 7). Null when not
   * applicable (a single document) or not reported.
   */
  readonly reportedRowCount: number | null;
  /** Known holes in this capture. Empty, never omitted, when there are none. */
  readonly gaps: readonly AcquisitionGap[];
};

export type AcquiredDocument = {
  /**
   * The **retained** bytes: the provider's business payload after the
   * adapter's declared projection has been applied (F1-23, `retention.ts`).
   * Not the response as received. An adapter produces these by calling
   * `retainPayload(policy, responseBytes, tier)` and returning
   * `retained.bytes`; it never hands back the response body.
   *
   * The raw tree these are written to is immutable (ground rule 1); nothing
   * in this package edits them after this point.
   */
  readonly bytes: Uint8Array;
  /**
   * What the projection did: the declaration that produced `bytes`, the
   * projection algorithm version, and the source paths that were dropped
   * (paths only, never values). Persisted into the raw tree's manifest
   * sidecar, so a retained artifact is never presented as the untouched
   * provider response.
   */
  readonly retention: RetentionRecord;
  readonly manifest: AcquisitionManifestEntry;
};

/** sha256 of `bytes`, hex-encoded. Every adapter's manifest needs this once; no reason to reimplement it per adapter. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- parse ------------------------------------------------------------------

export type RawFile = {
  readonly kind: CapabilityTier;
  readonly bytes: Uint8Array;
};

export type FieldLocator = {
  readonly source: CapabilityTier;
  /** 0-based row index within the source page/file, or 1-based page number for a PDF-tier source. */
  readonly index: number;
  /** Column header or on-page label near the value, when the source has one. */
  readonly field?: string;
};

/**
 * Ground rule 5: ambiguous money is null with a note, never inferred. This
 * union makes that structural rather than a convention someone can forget:
 * a null amount cannot exist without a reason attached, and a reason cannot
 * be attached to a resolved amount.
 */
export type ParsedAmount =
  | { readonly amount: string; readonly amountNote: null }
  | { readonly amount: null; readonly amountNote: string };

export type ParsedInstrument = {
  readonly symbol: string | null;
  readonly cusip: string | null;
  readonly isin: string | null;
  readonly name: string | null;
};

/**
 * One normalized activity row. Money never becomes a float: `quantity`,
 * `price` and `amount` are canonical decimal text (see decimal.ts), never
 * `number`. `locators` carries at least a `"row"` entry locating the whole
 * record in its source, plus any field that needs to be pinpointed on its
 * own — most importantly `"amount"` on an ambiguous row, so a reviewer knows
 * exactly what text produced the ambiguity.
 */
export type ParsedRow = ParsedAmount & {
    /**
     * Which underlying source document (in the archive's `documents` sense)
     * this row belongs to, among the rows one `parse()` call returns. Rows
     * from the same document share this value and appear in that document's
     * own row order; this is what a caller groups rows by to compute the
     * per-document `occurrence` ordinal `rowHash` requires.
     *
     * For a single acquired file (a statement, a confirmation, a tabular
     * export) this is a constant for the whole call, since one `parse()`
     * call already covers exactly one document. A paginated structured-API
     * pull acquires every page as one `RawFile` (one content hash, one
     * immutable capture) but is logically several documents for dedupe
     * purposes, one per page: giving each page its own `sourceDocument`
     * value is what lets the same real transaction on two overlapping pages
     * land on the same occurrence ordinal in each page's document and
     * therefore collapse, while two genuinely distinct rows within one page
     * still get distinct ordinals. See `src/importer.ts` and
     * `src/adapterImport.ts`.
     */
    readonly sourceDocument: string;
    /** The provider's own transaction id, when the source has one. */
    readonly externalId: string | null;
    readonly tradeDate: string | null;
    readonly processDate: string;
    readonly settleDate: string | null;
    readonly datePrecision: "day" | "month" | "unknown";
    readonly activityType: string;
    readonly description: string;
    readonly instrument: ParsedInstrument | null;
    /**
     * Signed, in the instrument's own units: **positive for an acquisition
     * and negative for a disposal**, whatever the source calls the activity.
     * A sale of ten shares is `"-10"`, not `"10"` with the sign carried on
     * `amount` alone.
     *
     * This is not a formatting preference. The position reconciliation gate
     * (`src/positionReconciliation.ts`) replays these quantities to check a
     * stated position change, so an unsigned disposal reads as an
     * acquisition and fails every period that contains one. The sign cannot
     * be recovered downstream from `activityType`: that is free provider
     * text with no taxonomy behind it, and guessing at it is exactly what
     * the plan says to surface for review instead.
     *
     * `null` when the source's own value is missing or ambiguous, which the
     * importer routes to `review_items` rather than guessing (ground rule 5).
     */
    readonly quantity: string | null;
    readonly price: string | null;
    readonly currency: string;
    readonly runningBalance: string | null;
    readonly locators: Readonly<Record<string, FieldLocator>>;
  };

// --- holdings ------------------------------------------------------------
//
// A statement's raw bytes carry both its activity table and its positions
// table; parse() returns both from the one parse of those bytes rather than
// asking an adapter to read the same document twice. An adapter with only
// activity (a structured API, a tabular export) is not asked to invent a
// positions table it does not have: it returns EMPTY_HOLDINGS, an honest
// declaration of "this source has none," not an omission a caller has to
// guess at (plan: "capabilities... an adapter declaring a subset honestly
// is the expected case").

export type ValuationBasis = "market_price" | "last_round" | "cost" | "reported_nav";

/**
 * One point-in-time holding from a statement's positions table. `marketValue`
 * is this row's load-bearing money value -- what a total-assets query sums --
 * so an adapter that saw text it could not read reports it as null with
 * `marketValueNote` rather than a guess, exactly like `ParsedRow.amount` /
 * `amountNote` (ground rule 5). `costBasis` and `unrealized` are secondary
 * and optional: most statements report them, some do not; plain decimal text
 * or null, validated downstream the same way `quantity`/`price` already are.
 *
 * `valuationBasis` and `valuationNote` must not both be left unset: the plan
 * is explicit that a total-assets query with no valuation basis silently
 * mixes marked securities with positions carried at cost. `valuationNote` is
 * always required text -- it explains the basis when one is known, and
 * explains why it is unknown when `valuationBasis` is null (ground rule 5:
 * never inferred).
 */
export type ParsedPosition = {
  readonly sourceDocument: string;
  readonly asOf: string;
  readonly instrument: ParsedInstrument | null;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly marketValue: string | null;
  readonly marketValueNote: string | null;
  readonly costBasis: string | null;
  readonly unrealized: string | null;
  readonly currency: string;
  readonly valuationBasis: ValuationBasis | null;
  readonly valuationNote: string;
  readonly locators: Readonly<Record<string, FieldLocator>>;
};

/** One point-in-time account total from a statement's summary section. */
export type ParsedBalance = {
  readonly sourceDocument: string;
  readonly asOf: string;
  readonly totalValue: string | null;
  readonly totalValueNote: string | null;
  readonly cash: string | null;
  readonly currency: string;
  readonly periodStartValue: string | null;
  readonly periodEndValue: string | null;
  readonly locators: Readonly<Record<string, FieldLocator>>;
};

/** What is owed: a loan, margin balance or similar, from a statement. */
export type ParsedLiability = {
  readonly sourceDocument: string;
  readonly kind: string;
  readonly displayName: string | null;
  readonly balance: string | null;
  readonly balanceNote: string | null;
  readonly currency: string;
  readonly rate: string | null;
  readonly asOf: string;
  readonly collateralNote: string | null;
  readonly locators: Readonly<Record<string, FieldLocator>>;
};

export type ParsedHoldings = {
  readonly positions: readonly ParsedPosition[];
  readonly balances: readonly ParsedBalance[];
  readonly liabilities: readonly ParsedLiability[];
};

/** What an activity-only source declines with: no positions, no invention. */
export const EMPTY_HOLDINGS: ParsedHoldings = Object.freeze({
  positions: [],
  balances: [],
  liabilities: [],
});

export type ParsedPull = {
  readonly activity: readonly ParsedRow[];
  readonly holdings: ParsedHoldings;
};

// --- the interface itself ----------------------------------------------

export type InstitutionAdapter = {
  readonly institutionSlug: string;
  discover(session: AdapterSession): Promise<DiscoverResult>;
  acquire(selection: AcquireSelection): Promise<AcquiredDocument>;
  parse(rawFile: RawFile): Promise<ParsedPull>;
  capabilities(): InstitutionCapabilities;
};
