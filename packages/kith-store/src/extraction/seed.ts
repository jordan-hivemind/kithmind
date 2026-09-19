// The starter set of document types, as data.
//
// The point of the whole feature is that "a new document kind is added as a
// row, not a release" (section 8 of
// docs/plans/2026-09-18-admin-panel-and-ingestion.md). So this file is a seed,
// not a registry: nothing in the extraction path reads it, the extraction path
// reads `kith.document_types` and `kith.document_type_fields`. Deleting a kind
// from here changes nothing about a space that already has it, and adding one
// through the admin UI needs no code at all.
//
// Idempotent and versioned. `seedDocumentTypes` inserts a kind at version 1
// only, and skips a kind the space already has at any version -- an owner who
// edited the guidance has version 2, and the seed must never walk that back.
//
// Field names double as observation types, so they match
// `OBSERVATION_TYPE_PATTERN` in `../records/model.ts` (lowercase, digits and
// underscores). `assertSeedShape` below is the check that keeps that true.
//
// Guidance is short and neutral on purpose: it tells the model what the
// document is, not how to be clever. Precision comes from the gate, which is
// code, not from a longer prompt.

import type {
  DocumentFieldCheck,
  DocumentFieldValueType,
} from "../admin/model.js";
import { newKithId } from "../ids.js";
import { exec, row, type DeferredCtx } from "../deferred/core.js";
import type { SensitivityLevel } from "../sensitivity/model.js";

export type SeedField = {
  name: string;
  valueType: DocumentFieldValueType;
  required?: true;
  check?: DocumentFieldCheck;
  example?: string;
};

export type SeedDocumentType = {
  kind: string;
  area: string;
  description: string;
  guidance: string;
  /** SENS-1. Omitted is `normal`. */
  sensitivity?: SensitivityLevel;
  fields: readonly SeedField[];
};

const money = (name: string, example?: string): SeedField => ({
  name,
  valueType: "money",
  check: "exact",
  ...(example === undefined ? {} : { example }),
});
const date = (name: string): SeedField => ({
  name,
  valueType: "date",
  check: "exact",
});
const org = (name: string): SeedField => ({
  name,
  valueType: "organization",
  check: "on_page",
});
const text = (name: string): SeedField => ({
  name,
  valueType: "text",
  check: "on_page",
});
const identifier = (name: string): SeedField => ({
  name,
  valueType: "identifier",
  check: "on_page",
});
const number = (name: string): SeedField => ({
  name,
  valueType: "number",
  check: "exact",
});
const required = (field: SeedField): SeedField => ({ ...field, required: true });

/**
 * The starter kinds. Chosen to cover the owner's first ingestion priorities
 * (outside investments, then statements, then receipts and records) rather
 * than to be exhaustive.
 */
export const STARTER_DOCUMENT_TYPES: readonly SeedDocumentType[] = [
  {
    kind: "investment_agreement",
    sensitivity: "sensitive",
    area: "finance",
    description:
      "A subscription agreement, SAFE, or convertible note for an investment.",
    guidance:
      "An agreement to invest in a company. Read the parties, the date it was signed, the amount committed, and the instrument terms if they are stated.",
    fields: [
      required(org("company")),
      text("investor_as_written"),
      required(date("date_signed")),
      required(money("amount_committed", "$250,000.00")),
      money("valuation_cap"),
      number("discount_percent"),
      text("security_type"),
      date("maturity_date"),
      number("interest_rate_percent"),
    ],
  },
  {
    kind: "capital_call_notice",
    sensitivity: "sensitive",
    area: "finance",
    description: "A fund's notice that a portion of a commitment is now due.",
    guidance:
      "A notice that money is due to a fund. Read who is calling, the amount called, when it is due, and the commitment it draws against if stated.",
    fields: [
      required(org("fund")),
      required(money("amount_called")),
      required(date("due_date")),
      date("notice_date"),
      money("total_commitment"),
      money("remaining_commitment"),
      identifier("wire_reference"),
    ],
  },
  {
    kind: "distribution_notice",
    sensitivity: "sensitive",
    area: "finance",
    description: "A fund's notice that capital or proceeds are being returned.",
    guidance:
      "A notice that a fund is paying out. Read who is paying, how much, when, and what the payment is attributed to if stated.",
    fields: [
      required(org("fund")),
      required(money("amount_distributed")),
      required(date("distribution_date")),
      text("distribution_type"),
      money("return_of_capital"),
      money("gain"),
    ],
  },
  {
    kind: "schedule_k1",
    sensitivity: "restricted",
    area: "tax",
    description: "A Schedule K-1 reporting a partner's share for a tax year.",
    guidance:
      "A partnership or S corporation K-1. Read the partnership, the tax year, the recipient as written, and the box amounts that are filled in.",
    fields: [
      required(org("partnership")),
      required(number("tax_year")),
      required(text("recipient_as_written")),
      identifier("partnership_ein_last_four"),
      money("ordinary_business_income"),
      money("net_rental_real_estate_income"),
      money("interest_income"),
      money("dividend_income"),
      money("capital_gain"),
      money("capital_account_ending"),
      number("profit_share_percent"),
    ],
  },
  {
    kind: "brokerage_statement",
    sensitivity: "sensitive",
    area: "finance",
    description: "A periodic statement from a brokerage or bank account.",
    guidance:
      "A periodic account statement. Read the institution, the last four digits of the account, the period it covers, and the opening and closing balances.",
    fields: [
      required(org("institution")),
      required(identifier("account_last_four")),
      required(date("period_start")),
      required(date("period_end")),
      money("opening_balance"),
      money("closing_balance"),
      money("net_change"),
    ],
  },
  {
    kind: "credit_card_statement",
    sensitivity: "sensitive",
    area: "finance",
    description: "A periodic credit card statement.",
    guidance:
      "A credit card statement. Read the issuer, the last four digits of the card, the period, the new balance, the minimum payment and the due date.",
    fields: [
      required(org("issuer")),
      required(identifier("card_last_four")),
      required(date("period_start")),
      required(date("period_end")),
      money("previous_balance"),
      money("new_balance"),
      money("minimum_payment"),
      date("payment_due_date"),
    ],
  },
  {
    kind: "invoice",
    area: "finance",
    description: "A bill issued by a vendor.",
    guidance:
      "A bill. Read who issued it, its number and date, what is being charged, and the amount due.",
    fields: [
      required(org("vendor")),
      identifier("invoice_number"),
      required(date("invoice_date")),
      date("due_date"),
      {
        name: "line_items",
        valueType: "line_item_list",
        check: "sums_to_total",
      },
      money("subtotal"),
      money("tax"),
      required(money("total")),
    ],
  },
  {
    kind: "receipt",
    area: "finance",
    description: "A receipt for a completed purchase.",
    guidance:
      "A receipt for something already paid. Read the vendor, the date, the items, the totals, and the last four digits of the card if shown.",
    fields: [
      required(org("vendor")),
      required(date("purchase_date")),
      {
        name: "line_items",
        valueType: "line_item_list",
        check: "sums_to_total",
      },
      money("subtotal"),
      money("tax"),
      required(money("total")),
      text("payment_method"),
      identifier("payment_last_four"),
    ],
  },
  {
    kind: "vehicle_service_receipt",
    area: "vehicle",
    description: "A receipt for work done on a vehicle.",
    guidance:
      "A service invoice for a vehicle. Read the shop, the date, which vehicle, the odometer reading, the work performed and the total.",
    fields: [
      required(org("vendor")),
      required(date("service_date")),
      required(text("vehicle_as_written")),
      number("odometer_miles"),
      identifier("vin"),
      {
        name: "line_items",
        valueType: "line_item_list",
        check: "sums_to_total",
      },
      required(money("total")),
    ],
  },
  {
    kind: "medical_visit_summary",
    sensitivity: "sensitive",
    area: "health",
    description: "A summary of a clinical visit.",
    guidance:
      "A visit summary from a clinician. Read the provider, the date of service, the patient as written, and the diagnoses, procedures and amounts exactly as they appear. Do not translate or code anything.",
    fields: [
      required(org("provider")),
      required(date("date_of_service")),
      required(text("patient_as_written")),
      { name: "diagnosis_as_written", valueType: "text", check: "on_page" },
      { name: "procedure_as_written", valueType: "text", check: "on_page" },
      money("amount_billed"),
      money("amount_owed"),
    ],
  },
  {
    kind: "lab_result",
    sensitivity: "sensitive",
    area: "health",
    description: "A laboratory result report.",
    guidance:
      "A lab report. Read the test name, the value and its unit, the reference range as printed, and the date the sample was collected or reported.",
    fields: [
      required(text("test_name")),
      required(text("result_value")),
      text("unit"),
      text("reference_range"),
      required(date("result_date")),
      org("laboratory"),
    ],
  },
  {
    kind: "explanation_of_benefits",
    sensitivity: "sensitive",
    area: "health",
    description: "An insurer's explanation of benefits for a claim.",
    guidance:
      "An insurer's statement about a claim. Read the insurer, the provider, the service date, the claim number, and the billed, allowed, paid and patient-responsibility amounts.",
    fields: [
      required(org("insurer")),
      org("provider"),
      required(date("date_of_service")),
      identifier("claim_number"),
      money("amount_billed"),
      money("amount_allowed"),
      money("plan_paid"),
      money("patient_responsibility"),
    ],
  },
  {
    kind: "letter_or_notice",
    area: "general",
    description: "A letter or notice that fits no more specific kind.",
    guidance:
      "A letter or notice. Read who sent it, its date, and any amount or deadline it states.",
    fields: [
      required(org("sender")),
      required(date("letter_date")),
      text("subject"),
      money("amount"),
      date("deadline"),
      identifier("reference_number"),
    ],
  },
];

const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The one check that keeps a seed field usable as an observation type. Run at
 * module load so a bad edit fails the build's tests, not a production job. */
function assertSeedShape(): void {
  const kinds = new Set<string>();
  for (const type of STARTER_DOCUMENT_TYPES) {
    if (kinds.has(type.kind)) throw new Error(`Duplicate seed kind ${type.kind}`);
    kinds.add(type.kind);
    if (!FIELD_NAME.test(type.kind)) {
      throw new Error(`Seed kind ${type.kind} is not a usable identifier`);
    }
    const names = new Set<string>();
    for (const field of type.fields) {
      if (!FIELD_NAME.test(field.name)) {
        throw new Error(`Seed field ${type.kind}.${field.name} is not a usable observation type`);
      }
      if (names.has(field.name)) {
        throw new Error(`Duplicate seed field ${type.kind}.${field.name}`);
      }
      names.add(field.name);
    }
  }
}

assertSeedShape();

export type SeedResult = { inserted: string[]; skipped: string[] };

/**
 * Writes the starter kinds into one space, once.
 *
 * Idempotent by (space, kind): a kind the space already has is skipped
 * whatever its version, so running this twice, or after the owner edited a
 * kind's guidance, changes nothing. Call it inside the caller's transaction.
 */
export async function seedDocumentTypes(
  ctx: DeferredCtx,
  spaceId: string,
  types: readonly SeedDocumentType[] = STARTER_DOCUMENT_TYPES,
): Promise<SeedResult> {
  const result: SeedResult = { inserted: [], skipped: [] };
  for (const type of types) {
    const existing = await row<{ id: string }>(
      ctx,
      `SELECT id FROM kith.document_types
        WHERE space_id = $1 AND kind = $2 LIMIT 1`,
      [spaceId, type.kind],
    );
    if (existing) {
      result.skipped.push(type.kind);
      continue;
    }
    const id = newKithId();
    await exec(
      ctx,
      `INSERT INTO kith.document_types
         (id, space_id, kind, description, area, guidance, version, active,
          sensitivity)
       VALUES ($1,$2,$3,$4,$5,$6,1,true,$7)`,
      [
        id,
        spaceId,
        type.kind,
        type.description,
        type.area,
        type.guidance,
        type.sensitivity ?? "normal",
      ],
    );
    for (const field of type.fields) {
      await exec(
        ctx,
        `INSERT INTO kith.document_type_fields
           (id, space_id, document_type_id, name, value_type, required,
            check_kind, example)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          newKithId(),
          spaceId,
          id,
          field.name,
          field.valueType,
          field.required === true,
          field.check ?? null,
          field.example ?? null,
        ],
      );
    }
    result.inserted.push(type.kind);
  }
  return result;
}
