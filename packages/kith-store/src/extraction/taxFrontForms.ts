// Deterministic first-pass selection for an assembled individual return.
//
// A return's front forms carry its totals. Supporting K-1s, W-2s, 1099s and
// brokerage packages can be useful documents in their own right, but they do
// not belong in this bounded return-total pass. This helper deliberately has
// no database dependency: the extraction loader supplies page text and keeps
// the original PDF page number intact for the later citation gate.

export type TaxFrontPage = {
  /** Original PDF page number. Never a position in this selected slice. */
  pageNumber: number;
  text: string;
};

export type TaxFrontForm =
  | "form_1040"
  | "schedule_1"
  | "schedule_2"
  | "schedule_3"
  | "schedule_a"
  | "schedule_d"
  | "schedule_e";

export type TaxFrontSelection = {
  pages: TaxFrontPage[];
  forms: TaxFrontForm[];
  /** A supporting attachment stopped the contiguous front-form pass. */
  stoppedAtAttachment: boolean;
  /** The caller's bounded inspection limit stopped this pass. */
  truncated: boolean;
};

export type TaxFrontSelectionOptions = {
  /** Enough for a 1040 and its front schedules without reading an archive. */
  maxPages?: number;
  /** Prevent a few oversized OCR pages from consuming the whole first pass. */
  maxChars?: number;
  /** A 1040 outside this opening window is not a front-return extraction. */
  maxInitialPages?: number;
};

const DEFAULT_MAX_PAGES = 48;
const DEFAULT_MAX_CHARS = 300_000;
const DEFAULT_MAX_INITIAL_PAGES = 12;

const FORM_MATCHERS: Array<[TaxFrontForm, RegExp]> = [
  [
    "form_1040",
    /\bform\s+1040(?!\s*-\s*x)\b|u\.?s\.?\s+individual\s+income\s+tax\s+return/i,
  ],
  ["schedule_1", /\bschedule\s+1\b[\s\S]{0,160}\badditional income/i],
  ["schedule_2", /\bschedule\s+2\b[\s\S]{0,160}\badditional taxes/i],
  ["schedule_3", /\bschedule\s+3\b[\s\S]{0,160}\badditional credits/i],
  ["schedule_a", /\bschedule\s+a\b[\s\S]{0,160}\bitemized deductions/i],
  ["schedule_d", /\bschedule\s+d\b[\s\S]{0,160}\bcapital gains and losses/i],
  ["schedule_e", /\bschedule\s+e\b[\s\S]{0,160}\bsupplemental income/i],
];

// Kept deliberately narrow. A page has to identify itself as an attachment;
// a Schedule E mention of a K-1 in an ordinary return form is not enough.
const SUPPORTING_ATTACHMENT =
  /\b(schedule\s+k-?1|form\s+w-?2|form\s+1099(?:-[a-z]+)?|consolidated\s+(?:1099|brokerage)|brokerage\s+(?:statement|account))\b/i;
const AMENDED_RETURN =
  /\b(form\s+1040\s*-\s*x|amended\s+u\.?s\.?\s+individual\s+income\s+tax\s+return)\b/i;

function formsOnPage(text: string): TaxFrontForm[] {
  return FORM_MATCHERS.flatMap(([form, matcher]) =>
    matcher.test(text) && (form !== "form_1040" || !AMENDED_RETURN.test(text))
      ? [form]
      : [],
  );
}

function bounded(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

/**
 * Select the contiguous front-return section of an assembled PDF.
 *
 * The first Form 1040 must occur near the beginning. Pages before it stay in
 * the result because a cover or contents page can carry evidence the model
 * needs, and their original page numbers are preserved. Once a recognizable
 * supporting attachment starts, it and every following page are left for a
 * separate extraction. No total is computed here.
 */
export function selectTaxFrontForms(
  pages: readonly TaxFrontPage[],
  options: TaxFrontSelectionOptions = {},
): TaxFrontSelection {
  const maxPages = bounded(options.maxPages, DEFAULT_MAX_PAGES);
  const maxChars = bounded(options.maxChars, DEFAULT_MAX_CHARS);
  const maxInitialPages = bounded(
    options.maxInitialPages,
    DEFAULT_MAX_INITIAL_PAGES,
  );
  const frontIndex = pages.findIndex(
    (page, index) =>
      index < maxInitialPages && formsOnPage(page.text).includes("form_1040"),
  );
  if (frontIndex < 0) {
    return {
      pages: [],
      forms: [],
      stoppedAtAttachment: false,
      truncated: false,
    };
  }

  const selected: TaxFrontPage[] = [];
  const forms = new Set<TaxFrontForm>();
  let chars = 0;
  let stoppedAtAttachment = false;
  let truncated = false;

  for (const page of pages) {
    if (selected.length >= maxPages || chars + page.text.length > maxChars) {
      truncated = true;
      break;
    }
    if (selected.length > frontIndex && SUPPORTING_ATTACHMENT.test(page.text)) {
      stoppedAtAttachment = true;
      break;
    }
    selected.push(page);
    chars += page.text.length;
    for (const form of formsOnPage(page.text)) forms.add(form);
  }

  return {
    pages: selected,
    forms: [...forms],
    stoppedAtAttachment,
    truncated,
  };
}
