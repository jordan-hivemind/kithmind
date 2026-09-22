// Cheap, local, no-model-call classification of a file's document kind and
// tax year, from its filename and page-1 text. Feeds `depthPolicy.ts`'s
// full/glance decision (docs/plans/2026-09-21-document-triage-and-priority.md's
// intent, reimplemented here rather than its machinery -- see that plan's
// "first automatic policy" section for the tax-heading rationale this narrows
// from) and, where a real column exists for it, `kind` becomes the document's
// `doc_type` (see write.ts/ingest.ts and the PR notes on `effectiveDocType`).
//
// Every pattern here is intentionally simple and over-inclusive within its
// kind: a false "tax_support" or "statement" only costs a glance instead of a
// full conversion (cheap), while a missed `tax_return`/`k1` would wrongly
// leave a return or K-1 at glance depth, which is the mistake this exists to
// avoid. Patterns are ordered most-specific-first so a document naming both a
// 1040 and a W-2 (a full return package with its source documents attached)
// classifies as the return.

export const DOCUMENT_KINDS = ["tax_return", "k1", "tax_support", "statement", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

type Pattern = { kind: Exclude<DocumentKind, "other">; test: RegExp };

// Form 1040 family and the "U.S. Individual Income Tax Return" heading, one
// state individual-return form per state that actually matters here (federal
// filers who also file California or New York), and a preparer's complete
// package heading ("Your 2021 Tax Return", "2021 Individual Tax Return").
const TAX_RETURN_PATTERNS: RegExp[] = [
  /\bform\s*1040-?(sr|nr)?\b/i,
  /\bu\.?s\.?\s+individual\s+income\s+tax\s+return\b/i,
  /\bform\s*540\b/i, // California individual return
  /\bform\s*it-?201\b/i, // New York individual return
  /\b(your|complete)\s+(?:\d{4}\s+)?(?:individual\s+)?tax\s+return\b/i,
  /\b\d{4}\s+(?:individual\s+)?tax\s+return\b/i,
];

// Schedule K-1 and the three entity-return families that issue one:
// partnerships (1065), S corporations (1120-S) and trusts/estates (1041).
const K1_PATTERNS: RegExp[] = [
  /\bschedule\s*k-?1\b/i,
  /\bk-?1\b.*\bform\s*(1065|1120-?s|1041)\b/i,
  /\bform\s*(1065|1120-?s|1041)\b.*\bk-?1\b/i,
];

// Individual information returns and other documents a return is built from,
// plus the generic tax-prep paperwork the owner called "supporting
// documents": receipts, statements, letters, worksheets, an organizer.
const TAX_SUPPORT_PATTERNS: RegExp[] = [
  /\bform\s*w-?2\b/i,
  /\bform\s*1099(-[a-z]+)?\b/i,
  /\b1099(-[a-z]+)?\b/i,
  /\bform\s*1098(-[a-z]+)?\b/i,
  /\b1098(-[a-z]+)?\b/i,
  /\bform\s*1095-?[abc]?\b/i,
  /\b1095-?[abc]?\b/i,
  /\btax\s+organizer\b/i,
  /\btax\s+worksheet\b/i,
  /\btax\s+letter\b/i,
  /\breceipt\b/i,
];

// Generic account/portfolio statements with no tax-specific heading.
const STATEMENT_PATTERNS: RegExp[] = [/\bstatement\b/i, /\baccount\s+summary\b/i];

function matchesAny(patterns: RegExp[], haystack: string): boolean {
  return patterns.some((pattern) => pattern.test(haystack));
}

/**
 * Classifies a document from its filename and page-1 text alone -- no model
 * call, no page beyond the first. `page1Text` may be empty (an OCR-less scan
 * with too little text, or a non-PDF file whose extraction failed); filename
 * alone can still resolve `tax_return`/`k1`/`tax_support` when it names the
 * form directly (e.g. "2022 1099-DIV.pdf").
 */
export function detectKind(filename: string, page1Text: string): DocumentKind {
  const haystack = `${filename}\n${page1Text}`;
  if (matchesAny(TAX_RETURN_PATTERNS, haystack)) return "tax_return";
  if (matchesAny(K1_PATTERNS, haystack)) return "k1";
  if (matchesAny(TAX_SUPPORT_PATTERNS, haystack)) return "tax_support";
  if (matchesAny(STATEMENT_PATTERNS, haystack)) return "statement";
  return "other";
}

const TEXT_YEAR_PATTERNS: RegExp[] = [
  /\b(20\d{2})\s+form\s*1040\b/i,
  /\bform\s*1040.{0,20}?\b(20\d{2})\b/i,
  /\btax\s+year\s+(20\d{2})\b/i,
  /\bfor\s+the\s+year\s+(20\d{2})\b/i,
  /\b(20\d{2})\s+(?:individual\s+)?tax\s+return\b/i,
];
// Filenames commonly carry a bare four-digit year with no surrounding words
// ("2021 W-2.pdf", "Statements/2021/january.pdf"); applied to the filename
// only, never to page-1 text, where a bare number is far more likely to be an
// account or dollar figure than a tax year.
const FILENAME_YEAR_PATTERN = /(20\d{2})/;

function firstYearMatch(patterns: RegExp[], haystack: string): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(haystack);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

/** Detects a tax year from explicit phrasing in the filename or page-1 text,
 * falling back to a bare four-digit year in the filename only. Returns
 * `undefined` when none is found; a document with no discoverable year is not
 * an error. */
export function detectTaxYear(filename: string, page1Text: string): number | undefined {
  const phrased = firstYearMatch(TEXT_YEAR_PATTERNS, `${filename}\n${page1Text}`);
  if (phrased !== undefined) return phrased;
  return firstYearMatch([FILENAME_YEAR_PATTERN], filename);
}
