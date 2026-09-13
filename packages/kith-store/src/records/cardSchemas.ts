import type { ObservationValue } from "./values.js";

export const CARD_RECORD_KINDS = [
  "document_card",
  "safe_note_card",
  "tax_return_card",
  "k1_card",
  "brokerage_tax_package_card",
  "spreadsheet_card",
] as const;

export type CardRecordKind = (typeof CARD_RECORD_KINDS)[number];
export type EntityKind = "person" | "organization" | "project" | "place" | "other";

type Field = {
  valueTypes: readonly ObservationValue["type"][];
  repeated?: true;
};

type Schema = {
  entityKinds?: readonly EntityKind[];
  fields: Readonly<Record<string, Field>>;
};

const text = { valueTypes: ["text"] } as const;
const name = { valueTypes: ["entity", "text"] } as const;
const money = { valueTypes: ["money"] } as const;
const date = { valueTypes: ["date"] } as const;
const integer = { valueTypes: ["integer"] } as const;
const decimal = { valueTypes: ["decimal"] } as const;
const boolean = { valueTypes: ["boolean"] } as const;
const repeated = <T extends Field>(field: T): T & { repeated: true } => ({
  ...field,
  repeated: true,
});

/** The read-side projection of the authoritative Convex card schemas. */
export const CARD_SCHEMAS: Readonly<Record<CardRecordKind, Schema>> = {
  document_card: {
    fields: {
      card_kind: text,
      card_title: text,
      card_date: date,
      card_party: repeated(name),
      card_summary: text,
    },
  },
  safe_note_card: {
    entityKinds: ["person", "organization"],
    fields: {
      company: name,
      investor_entity: name,
      instrument_date: date,
      principal_amount: money,
      valuation_cap: money,
      discount_rate: decimal,
      mfn_clause: boolean,
      pro_rata_right: boolean,
      governing_law: text,
      instrument_form: text,
      interest_rate: decimal,
      maturity_date: date,
    },
  },
  tax_return_card: {
    entityKinds: ["person"],
    fields: {
      tax_year: integer,
      tax_period_end: date,
      form_type: text,
      filing_status: text,
      adjusted_gross_income: money,
      taxable_income: money,
      total_tax: money,
      refund_or_amount_due: money,
      refund_or_amount_due_direction: text,
      w2_employer: repeated(name),
      k1_entity: repeated(name),
      form_1099_payer: repeated(name),
    },
  },
  k1_card: {
    entityKinds: ["person"],
    fields: {
      k1_entity: name,
      tax_year: integer,
      entity_type: text,
      k1_income_class: repeated(text),
      k1_income: repeated(money),
      capital_account_beginning: money,
      capital_account_ending: money,
      partner_share_percent: decimal,
    },
  },
  brokerage_tax_package_card: {
    entityKinds: ["person"],
    fields: {
      tax_year: integer,
      institution_name: name,
      account_identifier_last_four: text,
      form_present: repeated(text),
      form_total_form: repeated(text),
      form_total: repeated(money),
    },
  },
  spreadsheet_card: {
    fields: {
      sheet_name: repeated(text),
      column_header: repeated(text),
      row_count: repeated(integer),
      sheet_total_label: repeated(text),
      sheet_total: repeated({ valueTypes: ["money", "decimal"] }),
    },
  },
};

export function isCardRecordKind(value: string): value is CardRecordKind {
  return (CARD_RECORD_KINDS as readonly string[]).includes(value);
}

export function requireCardEventSchema(
  kind: CardRecordKind,
  entity: { kind: EntityKind },
): void {
  const allowed = CARD_SCHEMAS[kind].entityKinds;
  if (allowed && !allowed.includes(entity.kind)) {
    throw new Error(`${kind} must belong to a ${allowed.join(" or ")} entity`);
  }
}

export function requireCardObservationSchema(
  kind: CardRecordKind,
  observationType: string,
  observationKey: string,
  value: ObservationValue,
): void {
  const field = CARD_SCHEMAS[kind].fields[observationType];
  if (!field) throw new Error(`${kind} has no field named ${observationType}`);
  if (!(field.valueTypes as readonly string[]).includes(value.type)) {
    throw new Error(
      `${kind}.${observationType} accepts ${field.valueTypes.join(" or ")} values`,
    );
  }
  const prefix = field.repeated ? `${observationType}:` : observationType;
  const validKey = field.repeated
    ? observationKey.startsWith(prefix) &&
      /^(0|[1-9][0-9]{0,3})$/.test(observationKey.slice(prefix.length))
    : observationKey === prefix;
  if (!validKey) {
    throw new Error(
      field.repeated
        ? `${kind}.${observationType} must use <type>:<ordinal> observation keys`
        : `${kind}.${observationType} must use its field name as the observation key`,
    );
  }
  if (value.type === "decimal" && !value.unitCode) {
    throw new Error(`${kind}.${observationType} requires a unit code`);
  }
}
