import type {
  TargetedTaxCoverageDeclaration,
  TargetedTaxGoalKind,
} from "@repo/worker-protocol/request";

export const TARGETED_TAX_REQUIRED_FIELDS = {
  form_1040_totals_v1: [
    "tax_year",
    "return_version",
    "filing_status",
    "total_income",
    "agi",
    "taxable_income",
    "total_tax",
    "total_payments",
  ],
  schedule_k1_key_fields_v1: [
    "tax_year",
    "form_family",
    "partnership_name",
    "partnership_ein",
    "recipient_name",
    "recipient_tax_id_suffix",
  ],
} as const satisfies Record<TargetedTaxGoalKind, readonly string[]>;

const FORM_1040_FIELDS = [
  "tax_year",
  "filing_status",
  "return_version",
  "jurisdiction",
  "filer_name_as_written",
  "preparer_name",
  "signature_date",
  "filing_channel",
  "wages_total",
  "tax_exempt_interest",
  "taxable_interest",
  "qualified_dividends",
  "ordinary_dividends",
  "ira_distributions",
  "ira_taxable",
  "pensions_total",
  "pensions_taxable",
  "social_security_total",
  "social_security_taxable",
  "capital_gain_or_loss",
  "additional_income",
  "total_income",
  "adjustments_to_income",
  "agi",
  "deduction_taken",
  "qbi_deduction",
  "total_deductions",
  "taxable_income",
  "tax",
  "schedule_2_part_1",
  "child_tax_credit",
  "schedule_3_part_1",
  "total_credits",
  "other_taxes",
  "total_tax",
  "federal_withheld_total",
  "estimated_payments_and_prior_overpayment",
  "total_other_payments",
  "total_payments",
  "overpaid",
  "refunded",
  "applied_to_next_year",
  "amount_owed",
  "estimated_tax_penalty",
  "schedule1_income_total",
  "schedule1_adjustments_total",
  "schedule1_additional_income",
  "schedule1_total_additional_income",
  "schedule1_adjustments_to_income",
  "schedule2_additional_tax_total",
  "schedule2_amo_tax",
  "schedule2_self_employment_tax",
  "schedule2_total_other_taxes",
  "schedule2_total",
  "schedule3_nonrefundable_credits_total",
  "schedule3_foreign_tax_credit",
  "schedule3_education_credit",
  "schedule3_other_payments_and_credits",
  "schedule3_refundable_credits_total",
  "schedule3_total",
  "schedule_a_medical_expenses",
  "schedule_a_state_and_local_taxes",
  "schedule_a_real_estate_taxes",
  "schedule_a_personal_property_taxes",
  "schedule_a_other_taxes",
  "schedule_a_interest_paid",
  "schedule_a_charitable_contributions",
  "schedule_a_casualty_and_theft",
  "schedule_a_other_itemized_deductions",
  "schedule_a_total_itemized_deductions",
  "schedule_d_short_term_total",
  "schedule_d_long_term_total",
  "schedule_d_capital_gain_or_loss",
  "schedule_d_capital_loss_carryover",
  "schedule_d_net_capital_gain_or_loss",
  "schedule_e_rental_real_estate_total",
  "schedule_e_partnership_and_s_corporation_total",
  "schedule_e_estates_and_trusts_total",
  "schedule_e_real_estate_mortgage_investment_conduits_total",
  "schedule_e_net_rental_real_estate_income",
  "schedule_e_total_income_or_loss",
  "schedule_e_total_supplemental_income_or_loss",
] as const;

const K1_FIELDS = [
  "tax_year",
  "form_family",
  "partnership_name",
  "partnership_ein",
  "recipient_name",
  "recipient_tax_id_suffix",
  "amended_return",
  "final_return",
  "publicly_traded_partnership",
  "partner_type",
  "domestic_or_foreign",
  "schedule_k3_attached",
  "profit_share_beginning",
  "profit_share_ending",
  "loss_share_beginning",
  "loss_share_ending",
  "capital_share_beginning",
  "capital_share_ending",
  "nonrecourse_liabilities_beginning",
  "nonrecourse_liabilities_ending",
  "qualified_nonrecourse_liabilities_beginning",
  "qualified_nonrecourse_liabilities_ending",
  "recourse_liabilities_beginning",
  "recourse_liabilities_ending",
  "capital_account_beginning",
  "capital_contributed",
  "current_year_net_income",
  "other_increase_decrease",
  "withdrawals_distributions",
  "capital_account_ending",
  "box_1_ordinary_business_income",
  "box_2_rental_real_estate_income",
  "box_3_other_rental_income",
  "box_4a_guaranteed_services",
  "box_4b_guaranteed_capital",
  "box_4c_total_guaranteed_payments",
  "box_5_interest_income",
  "box_6a_ordinary_dividends",
  "box_6b_qualified_dividends",
  "box_7_royalties",
  "box_8_short_term_capital_gain",
  "box_9a_long_term_capital_gain",
  "box_9b_collectibles_gain",
  "box_9c_unrecaptured_1250_gain",
  "box_10_net_section_1231_gain",
  "box_11_coded_items",
  "box_12_section_179_deduction",
  "box_13_coded_deductions",
  "box_14_self_employment",
  "box_15_credits",
  "box_17_amt_items",
  "box_18_tax_exempt_income",
  "box_19_distributions",
  "box_20_other_information",
] as const;

export function targetedTaxFields(goal: TargetedTaxGoalKind): {
  requiredFields: string[];
  optionalFields: string[];
} {
  const requiredFields = [...TARGETED_TAX_REQUIRED_FIELDS[goal]];
  const required = new Set<string>(requiredFields);
  const all = goal === "form_1040_totals_v1" ? FORM_1040_FIELDS : K1_FIELDS;
  return {
    requiredFields,
    optionalFields: all.filter((field) => !required.has(field)),
  };
}

export type TargetedTaxHeaderPage = { originalPage: number; text: string };
export type TargetedTaxPagePlan = {
  originalPages: number[];
  requestedRegionsClosed: boolean;
  continuationsClosed: boolean;
};

const FORM_1040 = /\bform\s+1040(?:-sr)?\b|individual\s+income\s+tax\s+return/i;
const FRONT_SCHEDULE =
  /\bschedule\s+(?:1|2|3|a|d|e)\b[\s\S]{0,80}(?:form\s+1040|additional|itemized|capital|supplemental)/i;
const K1_1065 = /\bschedule\s+k-?1\s*\(\s*form\s+1065\s*\)/i;
const SUPPORTING =
  /\b(?:form\s+w-?2|form\s+1099|consolidated\s+1099|brokerage\s+(?:statement|account)|schedule\s+k-?1)\b/i;
const OTHER_TAX_FORM =
  /\b(?:form\s+(?:1040|1041|1065|1120)|schedule\s+k-?1)\b/i;
const K1_KEY_REGION =
  /\b(?:box\s*(?:[1-9]|1\d|20)\b|ordinary\s+business\s+income|rental\s+real\s+estate\s+income|self-employment\s+earnings|partner(?:'s)?\s+share\s+of\s+(?:income|deductions|credits))\b/i;
const CONTINUATION_REFERENCE =
  /\b(?:see\s+(?:attached|statement)|attached\s+statement|statement\s+(?:attached|required))\b/i;
const STATEMENT_PAGE =
  /\b(?:schedule\s+k-?1\s+statement|statement\s+(?:for|continuation|detail))\b/i;

function reachedSourceEnd(
  sorted: readonly TargetedTaxHeaderPage[],
  sourcePageCount: number,
): boolean {
  return sorted.at(-1)?.originalPage === sourcePageCount;
}

/**
 * Select goal pages from bounded native page headings. This is a navigation
 * decision only; values and completion still require retained parsed text and
 * cited evidence. The page union has no fixed document-wide cap.
 */
export function planTargetedTaxPages(
  goal: TargetedTaxGoalKind,
  headers: readonly TargetedTaxHeaderPage[],
  sourcePageCount = headers.at(-1)?.originalPage ?? 0,
): number[] {
  return inspectTargetedTaxPages(goal, headers, sourcePageCount).originalPages;
}

export function inspectTargetedTaxPages(
  goal: TargetedTaxGoalKind,
  headers: readonly TargetedTaxHeaderPage[],
  sourcePageCount: number,
): TargetedTaxPagePlan {
  const sorted = [...headers].sort((a, b) => a.originalPage - b.originalPage);
  if (goal === "form_1040_totals_v1") {
    const start = sorted.findIndex((page) => FORM_1040.test(page.text));
    if (start < 0)
      return {
        originalPages: [],
        requestedRegionsClosed: false,
        continuationsClosed: false,
      };
    const selected: number[] = [];
    let corePageCount = 0;
    let boundarySeen = false;
    let unknownDrift = false;
    for (let index = start; index < sorted.length; index += 1) {
      const page = sorted[index]!;
      if (
        index > start &&
        (SUPPORTING.test(page.text) ||
          (OTHER_TAX_FORM.test(page.text) &&
            !FORM_1040.test(page.text) &&
            !FRONT_SCHEDULE.test(page.text)))
      ) {
        boundarySeen = true;
        break;
      }
      const heading =
        FORM_1040.test(page.text) || FRONT_SCHEDULE.test(page.text);
      if (!heading) {
        unknownDrift = true;
        continue;
      }
      selected.push(page.originalPage);
      if (FORM_1040.test(page.text)) corePageCount += 1;
    }
    const bounded = boundarySeen || reachedSourceEnd(sorted, sourcePageCount);
    const closed = corePageCount >= 2 && bounded && !unknownDrift;
    return {
      originalPages: selected,
      requestedRegionsClosed: closed,
      continuationsClosed: closed,
    };
  }
  const start = sorted.findIndex((page) => K1_1065.test(page.text));
  if (start < 0)
    return {
      originalPages: [],
      requestedRegionsClosed: false,
      continuationsClosed: false,
    };
  const selected: number[] = [];
  let keyRegionSeen = false;
  let continuationReferenced = false;
  let statementSeen = false;
  let boundarySeen = false;
  let unknownDrift = false;
  for (let index = start; index < sorted.length; index += 1) {
    const page = sorted[index]!;
    const k1 = K1_1065.test(page.text);
    const statement = STATEMENT_PAGE.test(page.text);
    if (!k1 && !statement) {
      if (
        index > start &&
        (SUPPORTING.test(page.text) || OTHER_TAX_FORM.test(page.text))
      ) {
        boundarySeen = true;
        break;
      }
      unknownDrift = true;
      continue;
    }
    selected.push(page.originalPage);
    keyRegionSeen ||= k1 && K1_KEY_REGION.test(page.text);
    continuationReferenced ||= k1 && CONTINUATION_REFERENCE.test(page.text);
    statementSeen ||= statement;
  }
  const bounded = boundarySeen || reachedSourceEnd(sorted, sourcePageCount);
  return {
    originalPages: selected,
    requestedRegionsClosed: keyRegionSeen && bounded && !unknownDrift,
    continuationsClosed:
      bounded && !unknownDrift && (!continuationReferenced || statementSeen),
  };
}

export function targetedTaxNavigationClosed(
  goal: TargetedTaxGoalKind,
  headers: readonly TargetedTaxHeaderPage[],
  sourcePageCount: number,
): boolean {
  const planned = inspectTargetedTaxPages(goal, headers, sourcePageCount);
  return (
    planned.originalPages.length > 0 &&
    planned.requestedRegionsClosed &&
    planned.continuationsClosed
  );
}

export function targetedTaxCoverage(
  goal: TargetedTaxGoalKind,
  plan: Pick<
    TargetedTaxPagePlan,
    "requestedRegionsClosed" | "continuationsClosed"
  >,
  isFinalPlannedBatch: boolean,
): TargetedTaxCoverageDeclaration {
  return {
    formFamily:
      goal === "form_1040_totals_v1" ? "form_1040" : "schedule_k1_1065",
    requestedRegionsClosed: isFinalPlannedBatch && plan.requestedRegionsClosed,
    continuationsClosed: isFinalPlannedBatch && plan.continuationsClosed,
  };
}
