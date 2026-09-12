import type { Doc } from "../../_generated/dataModel";

import type { ObservationValue } from "./values";

/**
 * Section 4.2 of docs/plans/2026-09-12-document-cards.md. A card is a record,
 * so a card kind is a record event kind and a card field is an observation
 * type. Only `document_card` is extracted by P2-70c; the typed kinds are
 * declared here with their field lists and value-type constraints so the
 * schema check is one table, and their extraction lands in P2-70d..P2-70i.
 */
export const CARD_RECORD_KINDS = [
  "document_card",
  "safe_note_card",
  "tax_return_card",
  "k1_card",
  "brokerage_tax_package_card",
  "spreadsheet_card",
] as const;

export type CardRecordKind = (typeof CARD_RECORD_KINDS)[number];

type ValueType = ObservationValue["type"];

/**
 * Section 5.2: one normalizer per declared field type. The implementations
 * live in `cardGate.ts`; the id is declared here so a field and its
 * normalizer stay in one table and the two files never import each other's
 * values.
 */
export type CardNormalizerId =
  | "text_v1"
  | "name_v1"
  | "money_v1"
  | "date_v1"
  | "rate_v1"
  | "integer_v1"
  | "clause_boolean_v1";

export type CardFieldSchema = {
  /** Value types the gate may store for this field. */
  valueTypes: readonly ValueType[];
  /** A repeated field uses `<observationType>:<ordinal>` observation keys. */
  repeated?: true;
  /** The normalizer rule 2 runs the cited span text through. */
  normalizer: CardNormalizerId;
  /**
   * Section 5.2 outcomes: a required field that fails the gate stages nothing
   * from that tier, and one that is absent altogether fails the same way.
   * Every other field is dropped with its failure code. No boolean is
   * required, which is what keeps rule 7's absence from reading as a
   * card-level failure.
   */
  required?: true;
  /**
   * Rule 7: the casefolded terms whose presence in a span asserts this
   * clause. Declared only for boolean fields.
   */
  clauseTerms?: readonly string[];
};

type CardKindSchema = {
  /**
   * Section 4.5. `undefined` means the event entity is the source account's
   * configured subject entity and carries no entity-kind constraint of its
   * own.
   */
  entityKinds?: readonly Doc<"entities">["kind"][];
  fields: Readonly<Record<string, CardFieldSchema>>;
};

const NAME_OR_ENTITY = ["entity", "text"] as const;

/**
 * Section 4.4: extraction always stores the literal name it read. Binding it
 * to an entity is P2-70l, so every name field accepts `text` today and
 * `entity` once binding exists.
 */
export const CARD_SCHEMAS: Readonly<Record<CardRecordKind, CardKindSchema>> = {
  document_card: {
    fields: {
      card_kind: { valueTypes: ["text"], normalizer: "text_v1" },
      card_title: {
        valueTypes: ["text"],
        normalizer: "text_v1",
        required: true,
      },
      card_date: { valueTypes: ["date"], normalizer: "date_v1" },
      card_party: {
        valueTypes: NAME_OR_ENTITY,
        repeated: true,
        normalizer: "name_v1",
      },
      card_summary: { valueTypes: ["text"], normalizer: "text_v1" },
    },
  },
  safe_note_card: {
    entityKinds: ["person", "organization"],
    fields: {
      company: {
        valueTypes: NAME_OR_ENTITY,
        normalizer: "name_v1",
        required: true,
      },
      investor_entity: {
        valueTypes: NAME_OR_ENTITY,
        normalizer: "name_v1",
        required: true,
      },
      instrument_date: {
        valueTypes: ["date"],
        normalizer: "date_v1",
        required: true,
      },
      principal_amount: {
        valueTypes: ["money"],
        normalizer: "money_v1",
        required: true,
      },
      valuation_cap: { valueTypes: ["money"], normalizer: "money_v1" },
      discount_rate: { valueTypes: ["decimal"], normalizer: "rate_v1" },
      mfn_clause: {
        valueTypes: ["boolean"],
        normalizer: "clause_boolean_v1",
        clauseTerms: ["most favored nation", "most favoured nation", "mfn"],
      },
      pro_rata_right: {
        valueTypes: ["boolean"],
        normalizer: "clause_boolean_v1",
        clauseTerms: ["pro rata", "pro-rata"],
      },
      governing_law: { valueTypes: ["text"], normalizer: "text_v1" },
    },
  },
  tax_return_card: {
    entityKinds: ["person"],
    fields: {
      tax_year: {
        valueTypes: ["integer"],
        normalizer: "integer_v1",
        required: true,
      },
      filing_status: { valueTypes: ["text"], normalizer: "text_v1" },
      adjusted_gross_income: {
        valueTypes: ["money"],
        normalizer: "money_v1",
      },
      taxable_income: { valueTypes: ["money"], normalizer: "money_v1" },
      total_tax: { valueTypes: ["money"], normalizer: "money_v1" },
      refund_or_amount_due: { valueTypes: ["money"], normalizer: "money_v1" },
      w2_employer: {
        valueTypes: NAME_OR_ENTITY,
        repeated: true,
        normalizer: "name_v1",
      },
      k1_entity: {
        valueTypes: NAME_OR_ENTITY,
        repeated: true,
        normalizer: "name_v1",
      },
      form_1099_payer: {
        valueTypes: NAME_OR_ENTITY,
        repeated: true,
        normalizer: "name_v1",
      },
    },
  },
  k1_card: {
    entityKinds: ["person"],
    fields: {
      k1_entity: {
        valueTypes: NAME_OR_ENTITY,
        normalizer: "name_v1",
        required: true,
      },
      tax_year: {
        valueTypes: ["integer"],
        normalizer: "integer_v1",
        required: true,
      },
      k1_income: {
        valueTypes: ["money"],
        repeated: true,
        normalizer: "money_v1",
      },
      capital_account_beginning: {
        valueTypes: ["money"],
        normalizer: "money_v1",
      },
      capital_account_ending: { valueTypes: ["money"], normalizer: "money_v1" },
    },
  },
  brokerage_tax_package_card: {
    entityKinds: ["person"],
    fields: {
      tax_year: {
        valueTypes: ["integer"],
        normalizer: "integer_v1",
        required: true,
      },
      form_present: {
        valueTypes: ["text"],
        repeated: true,
        normalizer: "text_v1",
      },
      form_total: {
        valueTypes: ["money"],
        repeated: true,
        normalizer: "money_v1",
      },
    },
  },
  spreadsheet_card: {
    fields: {
      sheet_name: {
        valueTypes: ["text"],
        repeated: true,
        normalizer: "text_v1",
        required: true,
      },
      column_header: {
        valueTypes: ["text"],
        repeated: true,
        normalizer: "text_v1",
      },
      row_count: {
        valueTypes: ["integer"],
        repeated: true,
        normalizer: "integer_v1",
      },
      sheet_total: {
        valueTypes: ["money"],
        repeated: true,
        normalizer: "money_v1",
      },
    },
  },
};

export function isCardRecordKind(value: string): value is CardRecordKind {
  return (CARD_RECORD_KINDS as readonly string[]).includes(value);
}

/** `eventKey` is `card:<recordKind>`: one card of a kind per document. */
export function cardEventKey(kind: CardRecordKind): string {
  return `card:${kind}`;
}

/**
 * Section 4.1: a repeated field uses `<observationType>:<ordinal>` so one
 * `observation_history` call lists every party, employer or payer.
 */
export function cardObservationKey(field: string, ordinal?: number): string {
  return ordinal === undefined ? field : `${field}:${ordinal}`;
}

export function requireCardObservationSchema(
  kind: CardRecordKind,
  observationType: string,
  observationKey: string,
  value: ObservationValue,
): void {
  const field = CARD_SCHEMAS[kind].fields[observationType];
  if (!field) {
    throw new Error(`${kind} has no field named ${observationType}`);
  }
  if (!(field.valueTypes as readonly string[]).includes(value.type)) {
    throw new Error(
      `${kind}.${observationType} accepts ${field.valueTypes.join(" or ")} values`,
    );
  }
  const expectedKeyPrefix = field.repeated
    ? `${observationType}:`
    : observationType;
  if (
    field.repeated
      ? !observationKey.startsWith(expectedKeyPrefix) ||
        !/^(0|[1-9][0-9]{0,3})$/.test(
          observationKey.slice(expectedKeyPrefix.length),
        )
      : observationKey !== expectedKeyPrefix
  ) {
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

export function requireCardEventSchema(
  kind: CardRecordKind,
  entity: Doc<"entities">,
): void {
  const entityKinds = CARD_SCHEMAS[kind].entityKinds;
  if (entityKinds && !entityKinds.includes(entity.kind)) {
    throw new Error(
      `${kind} must belong to a ${entityKinds.join(" or ")} entity`,
    );
  }
}
