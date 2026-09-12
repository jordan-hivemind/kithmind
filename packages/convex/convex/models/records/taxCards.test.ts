import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { webPrincipal } from "../../lib/spaces";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  stagePages,
} from "../provenance/model";

import {
  CARD_PLAYBOOK_VERSION,
  loadCardExtractionDocument,
  runCardLadder,
  type CardLadderOps,
} from "./cardLadder";
import { CARD_PROMPT_VERSION, fixtureCardRunner } from "./cardRunner";
import type { CardRecordKind } from "./cardSchemas";
import { executeRecordQuery } from "./query";
import { canonicalizeDecimal } from "./values";

/**
 * P2-70h: docs/plans/2026-09-12-document-cards.md sections 4.2, 4.5, 5.2 and
 * 11/12. Synthetic fixtures for the tax return, K-1 and brokerage tax
 * package cards, published through the real gate with a fixture runner (no
 * model, no network), then read back through `query_records` exactly as an
 * owner would ask. Nothing here describes a real filer, return or account.
 * Every name, entity and figure is fictional.
 */

const FINGERPRINT = {
  cardSchemaVersion: 1,
  playbookVersion: CARD_PLAYBOOK_VERSION,
  promptVersion: CARD_PROMPT_VERSION,
};

function span(quote: string) {
  return { pageOrdinal: 0, quote };
}

type FieldEntry = {
  field: string;
  ordinal?: number;
  value:
    | { type: "text"; value: string }
    | { type: "date"; value: string }
    | { type: "money"; amount: string; currency: string }
    | { type: "decimal"; value: string; unitCode: string }
    | { type: "integer"; value: string };
  spans: ReturnType<typeof span>[];
};

function moneyField(
  field: string,
  bareAmount: string,
  ordinal?: number,
): FieldEntry {
  return {
    field,
    ...(ordinal === undefined ? {} : { ordinal }),
    value: {
      type: "money",
      amount: canonicalizeDecimal(bareAmount.replace(/[$,]/gu, "")),
      currency: "USD",
    },
    spans: [span(bareAmount)],
  };
}

function textField(field: string, value: string, ordinal?: number): FieldEntry {
  return {
    field,
    ...(ordinal === undefined ? {} : { ordinal }),
    value: { type: "text", value },
    spans: [span(value)],
  };
}

// --- tax_return_card --------------------------------------------------

type TaxReturnFixture = {
  externalId: string;
  taxYear: number;
  periodEndDate: string;
  formType: string;
  filingStatus: string;
  agi: string;
  taxableIncome: string;
  totalTax: string;
  refundOrAmountDue: string;
  direction: "refund" | "amount due";
  w2Employers: string[];
  k1Entities: string[];
  form1099Payers: string[];
};

/** Every quoted fact below is a distinct, once-occurring substring of the
 * page: the year is never written a second time apart from inside the
 * period-end date, which is what lets both fields cite one occurrence. */
function taxReturnText(fixture: TaxReturnFixture): string {
  return [
    `This is a Form ${fixture.formType} individual income tax return, for the period ended ${fixture.periodEndDate}.`,
    `Filing status: ${fixture.filingStatus}.`,
    `Adjusted gross income: ${fixture.agi}.`,
    `Taxable income: ${fixture.taxableIncome}.`,
    `Total tax: ${fixture.totalTax}.`,
    `This return's bottom line is ${fixture.direction}: ${fixture.refundOrAmountDue}.`,
    ...fixture.w2Employers.map((name) => `Form W-2 employer: ${name}.`),
    ...fixture.k1Entities.map((name) => `Schedule K-1 entity: ${name}.`),
    ...fixture.form1099Payers.map((name) => `Form 1099 payer: ${name}.`),
  ].join("\n");
}

function taxReturnCandidate(fixture: TaxReturnFixture) {
  const fields: FieldEntry[] = [
    {
      field: "tax_year",
      value: { type: "integer", value: String(fixture.taxYear) },
      spans: [span(String(fixture.taxYear))],
    },
    {
      field: "tax_period_end",
      value: { type: "date", value: fixture.periodEndDate },
      spans: [span(fixture.periodEndDate)],
    },
    textField("form_type", fixture.formType),
    textField("filing_status", fixture.filingStatus),
    moneyField("adjusted_gross_income", fixture.agi),
    moneyField("taxable_income", fixture.taxableIncome),
    moneyField("total_tax", fixture.totalTax),
    moneyField("refund_or_amount_due", fixture.refundOrAmountDue),
    textField("refund_or_amount_due_direction", fixture.direction),
    ...fixture.w2Employers.map((name, index) =>
      textField("w2_employer", name, index),
    ),
    ...fixture.k1Entities.map((name, index) =>
      textField("k1_entity", name, index),
    ),
    ...fixture.form1099Payers.map((name, index) =>
      textField("form_1099_payer", name, index),
    ),
  ];
  return { anchor: [span(fixture.formType)], fields };
}

const TAX_RETURN_2021: TaxReturnFixture = {
  externalId: "synthetic://tax-corpus/return-2021",
  taxYear: 2021,
  periodEndDate: "2021-12-31",
  formType: "1040",
  filingStatus: "single",
  agi: "85,000.00",
  taxableIncome: "70,000.00",
  totalTax: "9,500.00",
  refundOrAmountDue: "1,200.00",
  direction: "refund",
  w2Employers: ["Fictional Robotics Inc.", "Example Freight Co."],
  k1Entities: ["Fictional Ventures LP"],
  form1099Payers: ["Example Bank N.A."],
};

const TAX_RETURN_2024: TaxReturnFixture = {
  externalId: "synthetic://tax-corpus/return-2024",
  taxYear: 2024,
  periodEndDate: "2024-12-31",
  formType: "1040-SR",
  filingStatus: "married filing jointly",
  agi: "150,000.00",
  taxableIncome: "128,000.00",
  totalTax: "18,400.00",
  refundOrAmountDue: "500.00",
  direction: "amount due",
  w2Employers: ["Fictional Robotics Inc."],
  k1Entities: ["Fictional Ventures LP", "Example Holdings LLC"],
  form1099Payers: ["Example Brokerage LLC"],
};

// --- k1_card ------------------------------------------------------------

type K1Fixture = {
  externalId: string;
  entity: string;
  taxYear: number;
  entityType: string;
  incomeClasses: Array<{ label: string; amount: string }>;
  capitalBeginning: string;
  capitalEnding: string;
  partnerSharePercent: string;
};

function k1Text(fixture: K1Fixture): string {
  return [
    `Schedule K-1 from ${fixture.entity}, a ${fixture.entityType}, for tax year ${fixture.taxYear}.`,
    ...fixture.incomeClasses.map(
      (line) => `Box amount, ${line.label}: ${line.amount}.`,
    ),
    `Capital account beginning balance: ${fixture.capitalBeginning}.`,
    `Capital account ending balance: ${fixture.capitalEnding}.`,
    `Partner's share of profit: ${fixture.partnerSharePercent}%.`,
  ].join("\n");
}

function k1Candidate(fixture: K1Fixture) {
  const fields: FieldEntry[] = [
    textField("k1_entity", fixture.entity),
    {
      field: "tax_year",
      value: { type: "integer", value: String(fixture.taxYear) },
      spans: [span(String(fixture.taxYear))],
    },
    textField("entity_type", fixture.entityType),
    ...fixture.incomeClasses.flatMap((line, index) => [
      textField("k1_income_class", line.label, index),
      moneyField("k1_income", line.amount, index),
    ]),
    moneyField("capital_account_beginning", fixture.capitalBeginning),
    moneyField("capital_account_ending", fixture.capitalEnding),
    {
      field: "partner_share_percent",
      value: {
        type: "decimal",
        value: canonicalizeDecimal(fixture.partnerSharePercent),
        unitCode: "%",
      },
      spans: [span(`${fixture.partnerSharePercent}%`)],
    },
  ];
  return { anchor: [span(fixture.entity)], fields };
}

const K1_FENWICK: K1Fixture = {
  externalId: "synthetic://tax-corpus/k1-fictional-ventures",
  entity: "Fictional Ventures LP",
  taxYear: 2024,
  entityType: "partnership",
  incomeClasses: [
    { label: "ordinary business income", amount: "25,000.00" },
    { label: "interest income", amount: "750.00" },
  ],
  capitalBeginning: "100,000.00",
  capitalEnding: "125,500.00",
  partnerSharePercent: "10",
};

// --- brokerage_tax_package_card ------------------------------------------

type BrokerageFixture = {
  externalId: string;
  taxYear: number;
  institutionName: string;
  accountLastFour: string;
  forms: Array<{ form: string; total: string }>;
};

function brokerageText(fixture: BrokerageFixture): string {
  return [
    `${fixture.institutionName} annual tax package for tax year ${fixture.taxYear}.`,
    `Account ending in ${fixture.accountLastFour}.`,
    ...fixture.forms.map(
      (line) =>
        `This package includes Form ${line.form} with total amount ${line.total}.`,
    ),
  ].join("\n");
}

function brokerageCandidate(fixture: BrokerageFixture) {
  const fields: FieldEntry[] = [
    {
      field: "tax_year",
      value: { type: "integer", value: String(fixture.taxYear) },
      spans: [span(String(fixture.taxYear))],
    },
    textField("institution_name", fixture.institutionName),
    textField("account_identifier_last_four", fixture.accountLastFour),
    ...fixture.forms.flatMap((line, index) => [
      textField("form_present", line.form, index),
      textField("form_total_form", line.form, index),
      moneyField("form_total", line.total, index),
    ]),
  ];
  return { anchor: [span(fixture.institutionName)], fields };
}

const BROKERAGE_2024: BrokerageFixture = {
  externalId: "synthetic://tax-corpus/brokerage-2024",
  taxYear: 2024,
  institutionName: "Example Brokerage LLC",
  accountLastFour: "6789",
  forms: [
    { form: "1099-DIV", total: "1,200.00" },
    { form: "1099-INT", total: "300.00" },
  ],
};

// --- harness --------------------------------------------------------------

async function seedCorpus() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic tax corpus",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:tax-subject",
      kind: "person",
      canonicalName: "Synthetic Taxpayer",
      normalizedName: "synthetic taxpayer",
      aliases: [],
      normalizedAliases: [],
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "synthetic-tax-corpus",
      name: "Synthetic tax corpus",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 1_000_000,
      createdBy: userId,
      subjectEntityId: entityId,
    });
    await ctx.db.insert("spaceProcessingState", {
      spaceId,
      activationEpoch: 1,
      activatedAt: 100,
    });

    const seedDoc = async (externalId: string, text: string) => {
      const sourceItem = await createOrGetSourceItem(ctx, {
        spaceId,
        sourceAccountId,
        externalId,
      });
      const revision = await createOrGetRevision(ctx, {
        spaceId,
        sourceItemId: sourceItem._id,
        mediaType: "text/plain",
        inlineText: text,
        capturedAt: 1_700_000_000_000,
        userId,
      });
      const textVersion = await createOrGetTextVersion(ctx, {
        spaceId,
        sourceRevisionId: revision._id,
        extractionFingerprint: "plain:v1",
        text,
      });
      await stagePages(ctx, {
        spaceId,
        sourceTextVersionId: textVersion._id,
        pages: [{ ordinal: 0, start: 0, end: text.length, text }],
      });
      const processingGenerationId = await ctx.db.insert(
        "processingGenerations",
        {
          spaceId,
          sourceAccountId,
          sourceItemId: sourceItem._id,
          sourceRevisionId: revision._id,
          sourceTextVersionId: textVersion._id,
          processingFingerprint: `base:${externalId}`,
          extractionFingerprint: "plain:v1",
          extractorFingerprint: "synthetic:v1",
          recordSchemaFingerprint: "records:v1",
          normalizationFingerprint: "exact:v1",
          chunkerFingerprint: "none:v1",
          correctionRevision: "one",
          desiredProcessingEpoch: 1,
          state: "ready",
          expectedPageCount: 1,
          expectedEvidenceSpanCount: 0,
          expectedDocumentCount: 0,
          expectedChunkCount: 0,
          expectedEventCount: 0,
          expectedObservationCount: 0,
          actualPageCount: 1,
          actualEvidenceSpanCount: 0,
          actualDocumentCount: 0,
          actualChunkCount: 0,
          embeddingStatus: "unavailable",
          activatedAt: 100,
        },
      );
      await ctx.db.patch(textVersion._id, { evidenceSealed: true });
      await ctx.db.patch(sourceItem._id, {
        desiredRevisionId: revision._id,
        activeRevisionId: revision._id,
        activeGenerationId: processingGenerationId,
      });
      return sourceItem._id;
    };

    const return2021Id = await seedDoc(
      TAX_RETURN_2021.externalId,
      taxReturnText(TAX_RETURN_2021),
    );
    const return2024Id = await seedDoc(
      TAX_RETURN_2024.externalId,
      taxReturnText(TAX_RETURN_2024),
    );
    const k1Id = await seedDoc(K1_FENWICK.externalId, k1Text(K1_FENWICK));
    const brokerageId = await seedDoc(
      BROKERAGE_2024.externalId,
      brokerageText(BROKERAGE_2024),
    );

    return {
      userId,
      spaceId,
      entityId,
      sourceAccountId,
      return2021Id,
      return2024Id,
      k1Id,
      brokerageId,
    };
  });
  return { t, ...seeded };
}

type Harness = Awaited<ReturnType<typeof seedCorpus>>;

function opsFor(
  harness: Harness,
  sourceItemId: Id<"sourceItems">,
): CardLadderOps {
  return {
    stageEvidence: async (input) =>
      await harness.t.mutation(
        internal.models.records.cards.stageCardEvidence,
        {
          sourceItemId,
          recordKind: input.recordKind,
          fingerprint: { ...FINGERPRINT, tier: input.step },
          refs: input.refs.map((ref) =>
            "quote" in ref
              ? { pageOrdinal: ref.pageOrdinal, quote: ref.quote }
              : {
                  pageOrdinal: ref.pageOrdinal,
                  start: ref.start,
                  end: ref.end,
                },
          ),
        },
      ),
    sweepEvidence: async () => {
      await harness.t.mutation(
        internal.models.records.cards.sweepCardEvidence,
        { sourceItemId },
      );
    },
    publish: async (input) =>
      await harness.t.mutation(internal.models.records.cards.publishCard, {
        spaceId: harness.spaceId,
        sourceItemId,
        userId: harness.userId,
        recordKind: input.recordKind,
        now: input.now,
        fingerprint: { ...FINGERPRINT, tier: input.step },
        anchorEvidenceSpanIds: input.anchorEvidenceSpanIds,
        fields: input.fields,
        runner: input.runner,
      }),
    recordSkip: async (input) => {
      await harness.t.mutation(
        internal.models.records.cards.recordSkippedCardAttempt,
        {
          sourceItemId,
          recordKind: input.recordKind,
          step: input.step,
          modelId: input.modelId,
          fingerprint: { ...FINGERPRINT, tier: input.step },
          now: input.now,
        },
      );
    },
  };
}

/** Publishes one fixture through the real gate, at tier 0, no model call. */
async function publishFixture(
  harness: Harness,
  sourceItemId: Id<"sourceItems">,
  recordKind: CardRecordKind,
  candidate: ReturnType<
    typeof taxReturnCandidate | typeof k1Candidate | typeof brokerageCandidate
  >,
  now: number,
) {
  const loaded = await harness.t.run((ctx) =>
    loadCardExtractionDocument(ctx, sourceItemId),
  );
  if (loaded.status !== "ready") {
    throw new Error(`fixture did not load: ${loaded.code}`);
  }
  const result = await runCardLadder({
    recordKind,
    document: loaded.document,
    now,
    ops: opsFor(harness, sourceItemId),
    runners: [
      fixtureCardRunner({ step: "tier0", candidate }),
      fixtureCardRunner({ step: "tier1", candidate }),
    ],
  });
  if (result.outcome !== "accepted") {
    throw new Error(`fixture card did not publish: ${result.outcome}`);
  }
  return result;
}

describe("the tax return, K-1 and brokerage tax package cards", () => {
  test("every declared field publishes for its fixture", async () => {
    const harness = await seedCorpus();

    const taxReturn = await publishFixture(
      harness,
      harness.return2021Id,
      "tax_return_card",
      taxReturnCandidate(TAX_RETURN_2021),
      1_000,
    );
    expect(taxReturn.storedFields.sort()).toEqual(
      [
        "tax_year",
        "tax_period_end",
        "form_type",
        "filing_status",
        "adjusted_gross_income",
        "taxable_income",
        "total_tax",
        "refund_or_amount_due",
        "refund_or_amount_due_direction",
        "w2_employer:0",
        "w2_employer:1",
        "k1_entity:0",
        "form_1099_payer:0",
      ].sort(),
    );

    const k1 = await publishFixture(
      harness,
      harness.k1Id,
      "k1_card",
      k1Candidate(K1_FENWICK),
      1_001,
    );
    expect(k1.storedFields.sort()).toEqual(
      [
        "k1_entity",
        "tax_year",
        "entity_type",
        "k1_income_class:0",
        "k1_income:0",
        "k1_income_class:1",
        "k1_income:1",
        "capital_account_beginning",
        "capital_account_ending",
        "partner_share_percent",
      ].sort(),
    );

    const brokerage = await publishFixture(
      harness,
      harness.brokerageId,
      "brokerage_tax_package_card",
      brokerageCandidate(BROKERAGE_2024),
      1_002,
    );
    expect(brokerage.storedFields.sort()).toEqual(
      [
        "tax_year",
        "institution_name",
        "account_identifier_last_four",
        "form_present:0",
        "form_present:1",
        "form_total_form:0",
        "form_total_form:1",
        "form_total:0",
        "form_total:1",
      ].sort(),
    );
  });

  test('query example: "what was my AGI in 2021" via observation_history', async () => {
    const harness = await seedCorpus();
    await publishFixture(
      harness,
      harness.return2021Id,
      "tax_return_card",
      taxReturnCandidate(TAX_RETURN_2021),
      1_000,
    );
    await publishFixture(
      harness,
      harness.return2024Id,
      "tax_return_card",
      taxReturnCandidate(TAX_RETURN_2024),
      1_001,
    );

    const result = await harness.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(harness.userId),
        now: 2_000,
        query: {
          operation: "observation_history",
          spaceId: harness.spaceId,
          entityId: harness.entityId,
          observationType: "adjusted_gross_income",
          from: Date.parse("2021-06-01T00:00:00Z"),
          to: Date.parse("2022-06-01T00:00:00Z"),
          order: "asc",
        },
      }),
    );
    if (result.operation !== "observation_history") {
      throw new Error("wrong operation");
    }
    expect(result.status).toBe("match");
    expect(result.records.length).toBe(1);
    expect(result.records[0]!.value).toEqual({
      type: "money",
      amount: canonicalizeDecimal("85000.00"),
      currency: "USD",
    });
  });

  test('query example: "which K-1 entities were reported in 2024" via observation_history', async () => {
    const harness = await seedCorpus();
    await publishFixture(
      harness,
      harness.return2021Id,
      "tax_return_card",
      taxReturnCandidate(TAX_RETURN_2021),
      1_000,
    );
    await publishFixture(
      harness,
      harness.return2024Id,
      "tax_return_card",
      taxReturnCandidate(TAX_RETURN_2024),
      1_001,
    );

    const result = await harness.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(harness.userId),
        now: 2_000,
        query: {
          operation: "observation_history",
          spaceId: harness.spaceId,
          entityId: harness.entityId,
          observationType: "k1_entity",
          from: Date.parse("2024-06-01T00:00:00Z"),
          to: Date.parse("2025-06-01T00:00:00Z"),
          order: "asc",
        },
      }),
    );
    if (result.operation !== "observation_history") {
      throw new Error("wrong operation");
    }
    // Both ordinals of the 2024 return's k1_entity field, in one call.
    expect(result.records.map((record) => record.value)).toEqual([
      { type: "text", value: "Fictional Ventures LP" },
      { type: "text", value: "Example Holdings LLC" },
    ]);
  });

  test("ladder: tier 0 misses the required AGI, tier 1 publishes exactly one generation", async () => {
    const harness = await seedCorpus();
    const loaded = await harness.t.run((ctx) =>
      loadCardExtractionDocument(ctx, harness.return2021Id),
    );
    if (loaded.status !== "ready") throw new Error("fixture did not load");

    const full = taxReturnCandidate(TAX_RETURN_2021);
    const missingAgi = {
      ...full,
      fields: full.fields.filter(
        (field) => field.field !== "adjusted_gross_income",
      ),
    };

    const result = await runCardLadder({
      recordKind: "tax_return_card",
      document: loaded.document,
      now: 5_000,
      ops: opsFor(harness, harness.return2021Id),
      runners: [
        fixtureCardRunner({ step: "tier0", candidate: missingAgi }),
        fixtureCardRunner({ step: "tier1", candidate: full }),
      ],
    });

    expect(result.outcome).toBe("accepted");
    expect(result.acceptedStep).toBe("tier1");
    expect(result.steps.map((step) => step.outcome)).toEqual([
      "escalated",
      "accepted",
    ]);

    const generations = await harness.t.run(async (ctx) => {
      const rows = await ctx.db.query("processingGenerations").collect();
      return rows.filter(
        (row) =>
          row.cardGeneration === true &&
          row.sourceItemId === harness.return2021Id &&
          row.recordSchemaFingerprint.includes("tax_return_card"),
      );
    });
    expect(generations.length).toBe(1);
    expect(generations[0]!.recordSchemaFingerprint).toContain("tier:tier1");

    const attempts = await harness.t.run(
      async (ctx) => await ctx.db.query("cardExtractionAttempts").collect(),
    );
    const tier0 = attempts.find((row) => row.step === "tier0");
    expect(tier0!.outcome).toBe("escalated");
    expect(tier0!.failureCodes).toContain("required_field_absent");
  });
});
