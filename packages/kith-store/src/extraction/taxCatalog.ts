// A deliberately small starter catalog for a federal individual return.
//
// These names are semantic keys, not printed line numbers. Line numbering
// changes between filing years; the future tax projection can keep the key
// stable while recording the printed label and reference as evidence.

import type { SeedDocumentType, SeedField } from "./seed.js";

const money = (name: string): SeedField => ({
  name,
  valueType: "money",
  check: "exact",
});

const number = (name: string, required = false): SeedField => ({
  name,
  valueType: "number",
  check: "exact",
  ...(required ? { required: true as const } : {}),
});

const date = (name: string): SeedField => ({
  name,
  valueType: "date",
  check: "exact",
});

const text = (name: string): SeedField => ({
  name,
  valueType: "text",
  check: "on_page",
});

/**
 * Stable totals for the front of a federal Form 1040 return.
 *
 * This is intentionally one form-family kind. It does not attempt to catalog
 * every information return or attachment, and it does not encode year-specific
 * line numbers. A form instance's printed labels and references remain in its
 * evidence and are the authority for the filed year.
 */
export const FEDERAL_INDIVIDUAL_RETURN: SeedDocumentType = {
  kind: "tax_return_1040",
  sensitivity: "restricted",
  area: "tax",
  description:
    "A federal individual income tax return and its front schedules.",
  guidance:
    "Read the front Form 1040 and the attached Schedules 1, 2, 3, A, D, and E that are part of this return. Identify the printed form names and tax year. Capture totals and carry amounts from their printed labels, not assumed modern line positions. Preserve the original printed page evidence. A blank box is absent, not zero. Capture jurisdiction only when the return prints it. Capture signature_date only when a signed date is printed; never turn a filing, preparation, submission, or document timestamp into a signature date. Do not infer filing status, draft or filed state, amended state, jurisdiction, or any amount that is not printed. Ignore attached K-1s, brokerage packages, and other supporting documents as separate documents so their amounts are not counted again.",
  fields: [
    number("tax_year", true),
    text("filing_status"),
    text("return_version"),
    text("jurisdiction"),
    text("filer_name_as_written"),
    text("preparer_name"),
    date("signature_date"),
    text("filing_channel"),

    money("wages_total"),
    money("tax_exempt_interest"),
    money("taxable_interest"),
    money("qualified_dividends"),
    money("ordinary_dividends"),
    money("ira_distributions"),
    money("ira_taxable"),
    money("pensions_total"),
    money("pensions_taxable"),
    money("social_security_total"),
    money("social_security_taxable"),
    money("capital_gain_or_loss"),
    money("additional_income"),
    money("total_income"),
    money("adjustments_to_income"),
    money("agi"),
    money("deduction_taken"),
    money("qbi_deduction"),
    money("total_deductions"),
    money("taxable_income"),
    money("tax"),
    money("schedule_2_part_1"),
    money("child_tax_credit"),
    money("schedule_3_part_1"),
    money("total_credits"),
    money("other_taxes"),
    money("total_tax"),
    money("federal_withheld_total"),
    money("estimated_payments_and_prior_overpayment"),
    money("total_other_payments"),
    money("total_payments"),
    money("overpaid"),
    money("refunded"),
    money("applied_to_next_year"),
    money("amount_owed"),
    money("estimated_tax_penalty"),

    // Schedule 1: totals only, with the schedule prefix kept in the key.
    money("schedule1_income_total"),
    money("schedule1_adjustments_total"),
    money("schedule1_additional_income"),
    money("schedule1_total_additional_income"),
    money("schedule1_adjustments_to_income"),

    // Schedule 2: totals only.
    money("schedule2_additional_tax_total"),
    money("schedule2_amo_tax"),
    money("schedule2_self_employment_tax"),
    money("schedule2_total_other_taxes"),
    money("schedule2_total"),

    // Schedule 3: totals only.
    money("schedule3_nonrefundable_credits_total"),
    money("schedule3_foreign_tax_credit"),
    money("schedule3_education_credit"),
    money("schedule3_other_payments_and_credits"),
    money("schedule3_refundable_credits_total"),
    money("schedule3_total"),

    // Schedule A: deductions and its total only.
    money("schedule_a_medical_expenses"),
    money("schedule_a_state_and_local_taxes"),
    money("schedule_a_real_estate_taxes"),
    money("schedule_a_personal_property_taxes"),
    money("schedule_a_other_taxes"),
    money("schedule_a_interest_paid"),
    money("schedule_a_charitable_contributions"),
    money("schedule_a_casualty_and_theft"),
    money("schedule_a_other_itemized_deductions"),
    money("schedule_a_total_itemized_deductions"),

    // Schedule D: totals and carryover only.
    money("schedule_d_short_term_total"),
    money("schedule_d_long_term_total"),
    money("schedule_d_capital_gain_or_loss"),
    money("schedule_d_capital_loss_carryover"),
    money("schedule_d_net_capital_gain_or_loss"),

    // Schedule E: totals, including its per-entity total rows when present.
    money("schedule_e_rental_real_estate_total"),
    money("schedule_e_partnership_and_s_corporation_total"),
    money("schedule_e_estates_and_trusts_total"),
    money("schedule_e_real_estate_mortgage_investment_conduits_total"),
    money("schedule_e_net_rental_real_estate_income"),
    money("schedule_e_total_income_or_loss"),
    money("schedule_e_total_supplemental_income_or_loss"),
  ],
};

export const FEDERAL_TAX_STARTER_CATALOG: readonly SeedDocumentType[] = [
  FEDERAL_INDIVIDUAL_RETURN,
];
