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

import { createHash } from "node:crypto";

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

export type AcquisitionManifestEntry = {
  readonly kind: CapabilityTier;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** ISO 8601 instant the bytes were captured, not the document's own date. */
  readonly capturedAt: string;
  readonly contentHash: string;
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
   * The bytes as received, unmodified. The raw tree they are eventually
   * written to is immutable (ground rule 1); nothing in this package edits
   * them after this point, including this function.
   */
  readonly bytes: Uint8Array;
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
    /** The provider's own transaction id, when the source has one. */
    readonly externalId: string | null;
    readonly tradeDate: string | null;
    readonly processDate: string;
    readonly settleDate: string | null;
    readonly datePrecision: "day" | "month" | "unknown";
    readonly activityType: string;
    readonly description: string;
    readonly instrument: ParsedInstrument | null;
    readonly quantity: string | null;
    readonly price: string | null;
    readonly currency: string;
    readonly runningBalance: string | null;
    readonly locators: Readonly<Record<string, FieldLocator>>;
  };

// --- the interface itself ----------------------------------------------

export type InstitutionAdapter = {
  readonly institutionSlug: string;
  discover(session: AdapterSession): Promise<DiscoverResult>;
  acquire(selection: AcquireSelection): Promise<AcquiredDocument>;
  parse(rawFile: RawFile): Promise<readonly ParsedRow[]>;
  capabilities(): InstitutionCapabilities;
};
