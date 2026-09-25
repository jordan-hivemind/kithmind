// TAXES-1. The Taxes screen: `tax_return`/`k1`/`tax_support` documents
// grouped by tax year, K-1s by issuer, and the existing manual tax payments
// (`taxPayments.ts`), read together without widening either contract.
//
// A document's tax year and, for a K-1, its issuing partnership, come from
// extraction when the pipeline produced one -- but the two document kinds are
// extracted through two different pipelines, and this module reads both
// rather than assuming one:
//
//   * A full-document read against `taxCatalog.ts`'s `FEDERAL_INDIVIDUAL_
//     RETURN` schema (kind `tax_return_1040`) writes one `kith.observations`
//     row per field, `event_type = 'document_statement'`, keyed by
//     `observation_key` (`tax_year`, `return_version`, ...) -- see
//     `extraction/model.ts` and `extraction/read.ts`'s own read of the same
//     table. This is the only pipeline that ever reaches `kith.observations`.
//   * A K-1's targeted read (`targetedTax.ts`'s `schedule_k1_key_fields_v1`,
//     `K1_FIELDS`: `tax_year`, `partnership_name`, ...) never becomes an
//     observation at all. It is revision-bound and stored directly on
//     `kith.document_targeted_extractions.outcomes`, which
//     `extraction/read.ts`'s `readTargetedTaxExtractions` reads the same way
//     this module does: an array of `{field, status, readings}`, a reading
//     used only when its outcome's `status` is `'cited'`.
//
// Neither pipeline claims every document -- `tax_support` has no schema at
// all, and a `tax_return`/`k1` a run has not reached yet has no row in
// either table. `parseTitleTaxYear`/`parseTitleFormType`/`parseTitleIssuer`
// below are the fallback for whichever fields a run did not produce, and a
// document with neither is still returned, grouped under tax year `null`
// ("Unknown year") rather than dropped -- the same "inventory over
// onboarding" rule `areas.ts` documents for an area with nothing in it.
//
// Money in `paymentTotals` is summed with `addDecimals` (exact decimal
// strings), never through a JS number: `records/values.ts` exists precisely
// so this module does not have to reimplement that.

import { rows, type IdentityCtx } from "../identity/db.js";
import { type Principal } from "../identity/authorization.js";
import { addDecimals } from "../records/values.js";
import { spacePredicate } from "../spaces.js";
import { getAdminSpaceIds } from "./model.js";
import { listAllTaxPayments, type TaxPayment } from "./taxPayments.js";

export const TAX_DOCUMENT_TYPES = ["tax_return", "k1", "tax_support"] as const;
export type TaxDocumentType = (typeof TAX_DOCUMENT_TYPES)[number];

/** Where a document's tax year (or a K-1's issuer, or a return's form type)
 * came from: the extraction pipeline, or a parse of its own title. Absent
 * when neither could name one. */
export type TaxFieldSource = "extraction" | "title";

export type TaxDocumentRow = {
  id: string;
  sourceItemId: string;
  title: string;
  docType: TaxDocumentType;
  taxYear: number | null;
  yearSource: TaxFieldSource | null;
  /** A form family tag (`1040`, `1041`, `1065`, `1120S`, ...) when either
   * extraction produced one or the title names one. Not attempted for
   * `tax_support`: a supporting document has no form of its own. */
  formType: string | null;
  formTypeSource: TaxFieldSource | null;
  /** A K-1's issuing partnership. Always `null` for `tax_return`/`tax_support`. */
  issuer: string | null;
  issuerSource: TaxFieldSource | null;
  capturedAt: string;
  /** `publication_state === 'active'`. A `staged` document (mid-generation)
   * reads as not-yet-active the same as `historical`, since neither is the
   * document's current, published reading. */
  active: boolean;
};

export type TaxPaymentTotal = { currency: string; amount: string };

export type TaxYearRow = {
  /** `null` is the "Unknown year" bucket: every document here has neither an
   * extracted nor a title-derived tax year. */
  taxYear: number | null;
  returnCount: number;
  /** Distinct known form types among this year's returns, for the year
   * table's tags. Does not include a return with no derivable form type. */
  returnFormTypes: string[];
  k1Count: number;
  supportCount: number;
  paymentCount: number;
  paymentTotals: TaxPaymentTotal[];
  /** The latest `capturedAt` among this year's documents, or `null` when the
   * year has payments but no documents (a payment made for a year nothing
   * has been filed for yet). */
  latestCapturedAt: string | null;
};

export type TaxOverview = {
  /** Newest tax year first; the `null` ("Unknown year") bucket, if present,
   * sorts last. */
  years: TaxYearRow[];
  /** Every `tax_return`/`k1`/`tax_support` document in scope, for the K-1s
   * table and the year drawer -- both read from this one list rather than
   * running a second, narrower query. */
  documents: TaxDocumentRow[];
  payments: TaxPayment[];
};

const MAX_TAX_DOCUMENTS = 5_000;
const EXTRACTED_FIELDS_LIMIT = 20_000;

const YEAR_PATTERN = /\b(19|20)\d{2}\b/;
const FORM_PATTERN = /\b(1040|1041|1065|1120-?s)\b/iu;
const EXTENSION = /\.[a-z0-9]{2,5}$/iu;
const TITLE_DELIMITER = /[·\-]/u;

/** The first plausible year (1900-2099) in a document title, or `null`. The
 * fallback for a document neither extraction pipeline reached. */
export function parseTitleTaxYear(title: string): number | null {
  const match = YEAR_PATTERN.exec(title);
  if (match === null) return null;
  const year = Number(match[0]);
  return Number.isSafeInteger(year) ? year : null;
}

/** The first recognized federal form family in a title (`1040`, `1041`,
 * `1065`, `1120S`), normalized to uppercase, or `null`. */
export function parseTitleFormType(title: string): string | null {
  const match = FORM_PATTERN.exec(title);
  if (match === null) return null;
  return match[0].toUpperCase().replace("-", "");
}

/**
 * A K-1's issuing partnership, guessed from its title when extraction did not
 * name one: the longest `·`/`-`-delimited segment that is not itself a bare
 * year or a form code. Best-effort only -- titles this module has not seen
 * may defeat it, which is why extraction is always preferred when it has an
 * answer.
 */
export function parseTitleIssuer(title: string): string | null {
  const base = title.replace(EXTENSION, "");
  const candidates = base
    .split(TITLE_DELIMITER)
    .map((part) => part.trim())
    .filter(
      (part) =>
        part !== "" &&
        !/^\d{4}$/u.test(part) &&
        !FORM_PATTERN.test(part) &&
        !/^k-?1$/iu.test(part),
    );
  if (candidates.length === 0) return null;
  return candidates.reduce((longest, candidate) =>
    candidate.length > longest.length ? candidate : longest,
  );
}

type StoredValue = { type?: string; value?: unknown } | null | undefined;

/** A `checkValue`-shaped stored value (`gate.ts`) read as a number: the
 * `decimal`/`integer` cases, the only ones a `number`-typed field produces. */
function storedNumber(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const stored = value as StoredValue;
  if (
    (stored?.type === "decimal" || stored?.type === "integer") &&
    typeof stored.value === "string"
  ) {
    const parsed = Number(stored.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The same shape read as text, trimmed, blank treated as absent. */
function storedText(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const stored = value as StoredValue;
  if (stored?.type === "text" && typeof stored.value === "string") {
    const trimmed = stored.value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return null;
}

type TargetedOutcome = {
  field?: string;
  status?: string;
  readings?: Array<{ value?: unknown }>;
};

/** The first cited reading's value for `field` in a targeted extraction's
 * `outcomes` array, or `undefined` when the field was never cited. A
 * `'conflict'` outcome is not read: an unresolved conflict is not a fact. */
function outcomeValue(outcomes: unknown, field: string): unknown {
  if (!Array.isArray(outcomes)) return undefined;
  const outcome = (outcomes as TargetedOutcome[]).find(
    (candidate) => candidate.field === field && candidate.status === "cited",
  );
  return outcome?.readings?.[0]?.value;
}

type TaxDocumentDbRow = {
  id: string;
  source_item_id: string;
  title: string;
  doc_type: string;
  captured_at: Date;
  publication_state: string;
};

async function fetchTaxDocuments(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
): Promise<TaxDocumentDbRow[]> {
  const predicate = spacePredicate(spaceIds, 1, "d.space_id");
  const found = await rows<TaxDocumentDbRow>(
    ctx,
    `SELECT d.id, d.source_item_id, d.title, d.doc_type,
            d.captured_at, d.publication_state
       FROM kith.documents d
      WHERE ${predicate.sql} AND d.doc_type = ANY($2::text[])
      ORDER BY d.captured_at DESC, d.id
      LIMIT $3`,
    [predicate.value, TAX_DOCUMENT_TYPES, MAX_TAX_DOCUMENTS + 1],
  );
  if (found.length > MAX_TAX_DOCUMENTS) {
    throw new Error("Too many tax documents to list");
  }
  return found;
}

type ExtractedFieldRow = {
  source_item_id: string;
  observation_key: string;
  value: unknown;
};

/** `tax_year`/`return_version` from a full-document `document_statement`
 * extraction, for whichever of `sourceItemIds` has one. */
async function fetchExtractedFields(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  sourceItemIds: readonly string[],
): Promise<ExtractedFieldRow[]> {
  if (sourceItemIds.length === 0) return [];
  const predicate = spacePredicate(spaceIds, 1, "o.space_id");
  return rows<ExtractedFieldRow>(
    ctx,
    `SELECT o.source_item_id, o.observation_key, o.value
       FROM kith.observations o
      WHERE ${predicate.sql} AND o.event_type = 'document_statement'
        AND o.observation_key = ANY($2::text[])
        AND o.source_item_id = ANY($3::text[])
      LIMIT $4`,
    [
      predicate.value,
      ["tax_year", "return_version"],
      sourceItemIds,
      EXTRACTED_FIELDS_LIMIT,
    ],
  );
}

type K1OutcomeDbRow = { source_item_id: string; outcomes: unknown };

/** The latest `schedule_k1_key_fields_v1` targeted extraction for each of
 * `sourceItemIds` (`DISTINCT ON`, newest `created_at` first): a document can
 * have more than one run across revisions, and only the latest is current. */
async function fetchK1Outcomes(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  sourceItemIds: readonly string[],
): Promise<K1OutcomeDbRow[]> {
  if (sourceItemIds.length === 0) return [];
  const predicate = spacePredicate(spaceIds, 1, "x.space_id");
  return rows<K1OutcomeDbRow>(
    ctx,
    `SELECT DISTINCT ON (x.source_item_id) x.source_item_id, x.outcomes
       FROM kith.document_targeted_extractions x
      WHERE ${predicate.sql} AND x.goal_kind = 'schedule_k1_key_fields_v1'
        AND x.source_item_id = ANY($2::text[])
      ORDER BY x.source_item_id, x.created_at DESC
      LIMIT $3`,
    [predicate.value, sourceItemIds, MAX_TAX_DOCUMENTS],
  );
}

type ExtractedEntry = { year?: number; formType?: string; issuer?: string };

function toTaxDocumentRow(
  row: TaxDocumentDbRow,
  extracted: ExtractedEntry | undefined,
): TaxDocumentRow {
  const docType = row.doc_type as TaxDocumentType;

  const extractedYear = extracted?.year;
  const titleYear = parseTitleTaxYear(row.title);
  const taxYear = extractedYear ?? titleYear;
  const yearSource: TaxFieldSource | null =
    extractedYear !== undefined ? "extraction" : titleYear !== null ? "title" : null;

  const extractedFormType = extracted?.formType ?? null;
  const titleFormType = docType === "tax_support" ? null : parseTitleFormType(row.title);
  const formType = extractedFormType ?? titleFormType;
  const formTypeSource: TaxFieldSource | null =
    extractedFormType !== null ? "extraction" : titleFormType !== null ? "title" : null;

  const extractedIssuer = extracted?.issuer ?? null;
  const titleIssuer = docType === "k1" ? parseTitleIssuer(row.title) : null;
  const issuer = extractedIssuer ?? titleIssuer;
  const issuerSource: TaxFieldSource | null =
    extractedIssuer !== null ? "extraction" : titleIssuer !== null ? "title" : null;

  return {
    id: row.id,
    sourceItemId: row.source_item_id,
    title: row.title,
    docType,
    taxYear: taxYear ?? null,
    yearSource,
    formType,
    formTypeSource,
    issuer,
    issuerSource,
    capturedAt: row.captured_at.toISOString(),
    active: row.publication_state === "active",
  };
}

function groupTaxYears(
  documents: readonly TaxDocumentRow[],
  payments: readonly TaxPayment[],
): TaxYearRow[] {
  const years = new Map<number | null, TaxYearRow>();
  const ensure = (year: number | null): TaxYearRow => {
    const existing = years.get(year);
    if (existing !== undefined) return existing;
    const created: TaxYearRow = {
      taxYear: year,
      returnCount: 0,
      returnFormTypes: [],
      k1Count: 0,
      supportCount: 0,
      paymentCount: 0,
      paymentTotals: [],
      latestCapturedAt: null,
    };
    years.set(year, created);
    return created;
  };

  for (const document of documents) {
    const yearRow = ensure(document.taxYear);
    if (document.docType === "tax_return") {
      yearRow.returnCount += 1;
      if (
        document.formType !== null &&
        !yearRow.returnFormTypes.includes(document.formType)
      ) {
        yearRow.returnFormTypes.push(document.formType);
      }
    } else if (document.docType === "k1") {
      yearRow.k1Count += 1;
    } else {
      yearRow.supportCount += 1;
    }
    if (
      yearRow.latestCapturedAt === null ||
      document.capturedAt > yearRow.latestCapturedAt
    ) {
      yearRow.latestCapturedAt = document.capturedAt;
    }
  }

  const totalsByYear = new Map<number, Map<string, string>>();
  for (const payment of payments) {
    const yearRow = ensure(payment.taxYear);
    yearRow.paymentCount += 1;
    const totals = totalsByYear.get(payment.taxYear) ?? new Map<string, string>();
    totals.set(
      payment.currency,
      addDecimals(totals.get(payment.currency) ?? "0", payment.amount),
    );
    totalsByYear.set(payment.taxYear, totals);
  }
  for (const [year, totals] of totalsByYear) {
    ensure(year).paymentTotals = [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => ({ currency, amount }));
  }

  return [...years.values()].sort((left, right) => {
    if (left.taxYear === null) return 1;
    if (right.taxYear === null) return -1;
    return right.taxYear - left.taxYear;
  });
}

/**
 * The Taxes screen's one read: every `tax_return`/`k1`/`tax_support`
 * document in scope (with a derived tax year and, for a K-1, its issuer),
 * every tax payment in scope, and both grouped by tax year for the by-year
 * table. See this module's header for where each derived field comes from.
 */
export async function listTaxOverview(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceIds?: readonly string[] },
): Promise<TaxOverview> {
  const spaces = await getAdminSpaceIds(ctx, args.principal, args.spaceIds);
  if (spaces.length === 0) return { years: [], documents: [], payments: [] };

  const documentRows = await fetchTaxDocuments(ctx, spaces);
  const sourceItemIds = documentRows.map((row) => row.source_item_id);
  const extractedByItem = new Map<string, ExtractedEntry>();

  const extractedFields = await fetchExtractedFields(ctx, spaces, sourceItemIds);
  for (const field of extractedFields) {
    const entry = extractedByItem.get(field.source_item_id) ?? {};
    if (field.observation_key === "tax_year") {
      const year = storedNumber(field.value);
      if (year !== null) entry.year = Math.trunc(year);
    } else if (field.observation_key === "return_version") {
      const formType = storedText(field.value);
      if (formType !== null) entry.formType = formType;
    }
    extractedByItem.set(field.source_item_id, entry);
  }

  const k1SourceItemIds = documentRows
    .filter((row) => row.doc_type === "k1")
    .map((row) => row.source_item_id);
  const k1Outcomes = await fetchK1Outcomes(ctx, spaces, k1SourceItemIds);
  for (const outcome of k1Outcomes) {
    const entry = extractedByItem.get(outcome.source_item_id) ?? {};
    const year = storedNumber(outcomeValue(outcome.outcomes, "tax_year"));
    if (year !== null) entry.year = Math.trunc(year);
    const formType = storedText(outcomeValue(outcome.outcomes, "form_family"));
    if (formType !== null) entry.formType = formType;
    const issuer = storedText(outcomeValue(outcome.outcomes, "partnership_name"));
    if (issuer !== null) entry.issuer = issuer;
    extractedByItem.set(outcome.source_item_id, entry);
  }

  const documents = documentRows.map((row) =>
    toTaxDocumentRow(row, extractedByItem.get(row.source_item_id)),
  );
  const payments = await listAllTaxPayments(ctx, spaces);
  const years = groupTaxYears(documents, payments);
  return { years, documents, payments };
}
