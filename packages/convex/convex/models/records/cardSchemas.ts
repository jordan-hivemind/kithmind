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
  | "clause_boolean_v1"
  | "enum_v1"
  | "money_usd_default_v1";

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
  /**
   * `enum_v1` only: the closed set of literal strings the field may store.
   * The value must be exactly one of these and the cited span must equal it,
   * so the field stays extractive rather than a model's paraphrase.
   */
  enumValues?: readonly string[];
  /** One line of what the field means, rendered into the runner prompt. */
  description?: string;
  /**
   * A `text` field whose value must be no longer than this many characters.
   * Declared for `account_identifier_last_four`, section 4.2: the gate
   * refuses a value that reads as a full account number rather than the
   * last four characters, independent of whether the span matches it.
   */
  maxChars?: number;
};

type CardKindSchema = {
  /**
   * Section 4.5. `undefined` means the event entity is the source account's
   * configured subject entity and carries no entity-kind constraint of its
   * own.
   */
  entityKinds?: readonly Doc<"entities">["kind"][];
  /**
   * Section 4.5, P2-70l. The field whose literal name names the event's own
   * entity. When that name binds to exactly one entity of an allowed kind,
   * the card's event moves from the source account's subject placeholder to
   * that entity, which is what makes an entity-filtered `list_events` return
   * the card. Declared only for the kinds whose event entity is a name the
   * document actually writes; the rest keep the subject entity.
   */
  eventEntityField?: string;
  fields: Readonly<Record<string, CardFieldSchema>>;
};

const NAME_OR_ENTITY = ["entity", "text"] as const;

/**
 * Section 4.4: extraction always stores the literal name it read, and the
 * gate only ever proves a literal name against its span. P2-70l binds that
 * name to an entity afterwards, recording the entity id in the observation's
 * `boundEntityId` beside the literal value rather than replacing the value,
 * so the evidence of what the document said survives the binding.
 */
export function isEntityCapableField(field: CardFieldSchema): boolean {
  return (field.valueTypes as readonly string[]).includes("entity");
}

/**
 * Section 4.5. The observation type whose bound entity becomes the card
 * event's entity, or `undefined` when this kind's event belongs to the
 * source account's subject entity.
 */
export function cardEventEntityField(
  kind: CardRecordKind,
): string | undefined {
  return CARD_SCHEMAS[kind].eventEntityField;
}

export function cardEntityKinds(
  kind: CardRecordKind,
): readonly Doc<"entities">["kind"][] | undefined {
  return CARD_SCHEMAS[kind].entityKinds;
}

/** Section 4.2: every card kind, its fields and their value constraints. */
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
  // Section 4.5: a SAFE or convertible note's event entity is the investor,
  // kind person or organization. `investor_entity` always stores the
  // investor's literal name as evidenced text; when P2-70l resolves that
  // name to exactly one person or organization, the binding step repoints
  // the event from the source account's `subjectEntityId` placeholder to
  // that investor. `entityKinds` constrains whichever entity the event
  // attaches to, placeholder or investor.
  safe_note_card: {
    entityKinds: ["person", "organization"],
    eventEntityField: "investor_entity",
    fields: {
      company: {
        valueTypes: NAME_OR_ENTITY,
        normalizer: "name_v1",
        required: true,
        description: "The company issuing the SAFE or convertible note.",
      },
      investor_entity: {
        valueTypes: NAME_OR_ENTITY,
        normalizer: "name_v1",
        required: true,
        description:
          "The investor's name exactly as written. Store the literal name; entity binding happens later and is not this field's job.",
      },
      instrument_date: {
        valueTypes: ["date"],
        normalizer: "date_v1",
        required: true,
        description: "The date the instrument is dated or executed.",
      },
      principal_amount: {
        valueTypes: ["money"],
        normalizer: "money_v1",
        required: true,
        description: "The amount the investor is putting in.",
      },
      valuation_cap: {
        valueTypes: ["money"],
        normalizer: "money_v1",
        description: "The valuation cap, when the instrument states one.",
      },
      discount_rate: {
        valueTypes: ["decimal"],
        normalizer: "rate_v1",
        description:
          "The discount rate applied against the next round's price, when the instrument states one.",
      },
      mfn_clause: {
        valueTypes: ["boolean"],
        normalizer: "clause_boolean_v1",
        clauseTerms: ["most favored nation", "most favoured nation", "mfn"],
        description:
          "Whether the investor holds a most-favored-nation (MFN) right to the terms of a later, more favorable instrument.",
      },
      pro_rata_right: {
        valueTypes: ["boolean"],
        normalizer: "clause_boolean_v1",
        clauseTerms: ["pro rata", "pro-rata"],
        description:
          "Whether the investor holds a pro rata right to invest in a future priced round.",
      },
      governing_law: {
        valueTypes: ["text"],
        normalizer: "text_v1",
        description: "The jurisdiction whose law governs the instrument.",
      },
      instrument_form: {
        valueTypes: ["text"],
        normalizer: "enum_v1",
        enumValues: ["post-money SAFE", "pre-money SAFE", "convertible note"],
        description:
          "Which of the three instrument forms this document is, exactly as the document names it.",
      },
      // The two fields below apply only to a convertible note; a SAFE simply
      // never carries a span for them, and an optional field with no span is
      // absent rather than a review item.
      interest_rate: {
        valueTypes: ["decimal"],
        normalizer: "rate_v1",
        description:
          "A convertible note's stated interest rate. Not applicable to a SAFE.",
      },
      maturity_date: {
        valueTypes: ["date"],
        normalizer: "date_v1",
        description:
          "A convertible note's maturity date. Not applicable to a SAFE.",
      },
    },
  },
  tax_return_card: {
    entityKinds: ["person"],
    fields: {
      tax_year: {
        valueTypes: ["integer"],
        normalizer: "integer_v1",
        required: true,
        description: "The tax year this return covers.",
      },
      // No field on the return itself is a calendar date; this is the one
      // date the card can cite, for example "for the year ended December
      // 31, 2021", and it is what places the return in time for a query
      // ranged by year. Optional: a return with no such span is undated.
      tax_period_end: {
        valueTypes: ["date"],
        normalizer: "date_v1",
        description:
          "The date the return's tax year ends, for example December 31 of tax_year for a calendar-year filer.",
      },
      form_type: {
        valueTypes: ["text"],
        normalizer: "enum_v1",
        enumValues: ["1040", "1040-SR", "1040-NR", "1040-X"],
        description: "Which variant of Form 1040 this return is.",
      },
      filing_status: {
        valueTypes: ["text"],
        normalizer: "enum_v1",
        enumValues: [
          "single",
          "married filing jointly",
          "married filing separately",
          "head of household",
          "qualifying surviving spouse",
        ],
        description: "The filing status box checked on the return.",
      },
      adjusted_gross_income: {
        valueTypes: ["money"],
        normalizer: "money_usd_default_v1",
        required: true,
        description: "Adjusted gross income (Form 1040 AGI line).",
      },
      taxable_income: {
        valueTypes: ["money"],
        normalizer: "money_usd_default_v1",
      },
      total_tax: {
        valueTypes: ["money"],
        normalizer: "money_usd_default_v1",
      },
      refund_or_amount_due: {
        valueTypes: ["money"],
        normalizer: "money_usd_default_v1",
        description:
          "The refund or amount-due figure, as an unsigned magnitude. Never encode direction as a minus sign or parentheses; use refund_or_amount_due_direction for that.",
      },
      refund_or_amount_due_direction: {
        valueTypes: ["text"],
        normalizer: "enum_v1",
        enumValues: ["refund", "amount due"],
        description:
          "Whether refund_or_amount_due is a refund to the filer or an amount the filer owes, quoted from wording such as \"refund\" or \"amount due\" rather than inferred from a sign.",
      },
      w2_employer: {
        valueTypes: NAME_OR_ENTITY,
        repeated: true,
        normalizer: "name_v1",
        description: "One Form W-2 employer's name. One entry per employer.",
      },
      k1_entity: {
        valueTypes: NAME_OR_ENTITY,
        repeated: true,
        normalizer: "name_v1",
        description:
          "One Schedule K-1 entity's name reported on this return. One entry per entity.",
      },
      form_1099_payer: {
        valueTypes: NAME_OR_ENTITY,
        repeated: true,
        normalizer: "name_v1",
        description: "One Form 1099 payer's name. One entry per payer.",
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
        description: "The partnership, S corporation, or trust that issued this K-1.",
      },
      tax_year: {
        valueTypes: ["integer"],
        normalizer: "integer_v1",
        required: true,
      },
      entity_type: {
        valueTypes: ["text"],
        normalizer: "enum_v1",
        enumValues: ["partnership", "S corporation", "trust"],
        description: "Which kind of entity issued this K-1.",
      },
      // Paired repeated fields, section 4.2: entry i of k1_income_class
      // names the box the amount at entry i of k1_income came from. Give
      // both fields the same ordinal for one income line.
      k1_income_class: {
        valueTypes: ["text"],
        repeated: true,
        normalizer: "enum_v1",
        enumValues: [
          "ordinary business income",
          "net rental real estate income",
          "interest income",
          "ordinary dividends",
          "net short-term capital gain",
          "net long-term capital gain",
          "guaranteed payments",
        ],
        description:
          "The K-1 box label for one income line. Use the same ordinal as the matching amount in k1_income.",
      },
      k1_income: {
        valueTypes: ["money"],
        repeated: true,
        normalizer: "money_usd_default_v1",
        description:
          "The amount for one income line. Use the same ordinal as the matching class in k1_income_class.",
      },
      capital_account_beginning: {
        valueTypes: ["money"],
        normalizer: "money_usd_default_v1",
      },
      capital_account_ending: {
        valueTypes: ["money"],
        normalizer: "money_usd_default_v1",
      },
      partner_share_percent: {
        valueTypes: ["decimal"],
        normalizer: "rate_v1",
        description: "The partner's or shareholder's ownership share percentage.",
      },
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
      institution_name: {
        valueTypes: NAME_OR_ENTITY,
        normalizer: "name_v1",
        description: "The brokerage or custodian that issued this tax package.",
      },
      account_identifier_last_four: {
        valueTypes: ["text"],
        normalizer: "text_v1",
        maxChars: 4,
        description:
          "The last four characters of the account number only. Never the full account number.",
      },
      form_present: {
        valueTypes: ["text"],
        repeated: true,
        normalizer: "enum_v1",
        enumValues: [
          "1099-B",
          "1099-DIV",
          "1099-INT",
          "1099-MISC",
          "1099-OID",
          "1099-R",
        ],
        description: "One form included in this tax package. One entry per form.",
      },
      // Paired repeated fields, same convention as k1_card's income class
      // and amount: entry i of form_total_form names the form that entry i
      // of form_total totals.
      form_total_form: {
        valueTypes: ["text"],
        repeated: true,
        normalizer: "enum_v1",
        enumValues: [
          "1099-B",
          "1099-DIV",
          "1099-INT",
          "1099-MISC",
          "1099-OID",
          "1099-R",
        ],
        description:
          "The form one total is for. Use the same ordinal as the matching amount in form_total.",
      },
      form_total: {
        valueTypes: ["money"],
        repeated: true,
        normalizer: "money_usd_default_v1",
        description:
          "The total amount for one form. Use the same ordinal as the matching form in form_total_form.",
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
