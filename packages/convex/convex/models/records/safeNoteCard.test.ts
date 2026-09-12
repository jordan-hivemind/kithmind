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
import { executeRecordQuery } from "./query";
import { canonicalizeDecimal } from "./values";

/**
 * P2-70g: docs/plans/2026-09-12-document-cards.md sections 4.2, 4.5, 5.2
 * rule 7, 5.3 and 11/12. A synthetic corpus of three SAFEs and one
 * convertible note, published through the real gate with a fixture runner
 * (no model, no network), then read back through `query_records` exactly as
 * an owner would ask the two questions the acceptance line names.
 *
 * Nothing here describes a real investment. Every company and amount is
 * fictional.
 */

const FINGERPRINT = {
  cardSchemaVersion: 1,
  playbookVersion: CARD_PLAYBOOK_VERSION,
  promptVersion: CARD_PROMPT_VERSION,
};

function span(quote: string) {
  return { pageOrdinal: 0, quote };
}

type SafeFixture = {
  externalId: string;
  company: string;
  investor: string;
  date: string;
  amount: string;
  valuationCap?: string;
  discountPercent?: string;
  mfn?: "assert" | "negate";
  proRata?: "assert";
  governingLaw?: string;
  instrumentForm?: "post-money SAFE" | "pre-money SAFE" | "convertible note";
  interestRatePercent?: string;
  maturityDate?: string;
};

/** One page of synthetic prose. Every quoted fact below is a distinct,
 * once-occurring substring, which is what the citation rule requires. */
function fixtureText(fixture: SafeFixture): string {
  const lines = [
    fixture.instrumentForm
      ? `This is a ${fixture.instrumentForm}.`
      : "This is an instrument.",
    `The instrument is dated ${fixture.date} between ${fixture.company} and the investor ${fixture.investor}.`,
    `The investor purchases this instrument for ${fixture.amount}.`,
  ];
  if (fixture.valuationCap) {
    lines.push(`The valuation cap is ${fixture.valuationCap}.`);
  }
  if (fixture.discountPercent) {
    lines.push(`The discount rate is ${fixture.discountPercent}%.`);
  }
  if (fixture.mfn === "assert") {
    lines.push(
      "Investor shall have most favored nation rights with respect to any subsequent instrument.",
    );
  } else if (fixture.mfn === "negate") {
    lines.push(
      "Investor shall have no most favored nation rights under this instrument.",
    );
  }
  if (fixture.proRata === "assert") {
    lines.push(
      "Investor shall have pro rata rights to participate in the company's next equity financing.",
    );
  }
  if (fixture.governingLaw) {
    lines.push(
      `This instrument is governed by the laws of ${fixture.governingLaw}.`,
    );
  }
  if (fixture.interestRatePercent) {
    lines.push(
      `This note bears interest at a rate of ${fixture.interestRatePercent}% per annum.`,
    );
  }
  if (fixture.maturityDate) {
    lines.push(`This note matures on ${fixture.maturityDate}.`);
  }
  return lines.join("\n");
}

function fixtureCandidate(fixture: SafeFixture) {
  const fields: Array<{
    field: string;
    value:
      | { type: "text"; value: string }
      | { type: "date"; value: string }
      | { type: "money"; amount: string; currency: string }
      | { type: "decimal"; value: string; unitCode: string }
      | { type: "boolean"; value: boolean };
    spans: ReturnType<typeof span>[];
  }> = [
    {
      field: "company",
      value: { type: "text", value: fixture.company },
      spans: [span(fixture.company)],
    },
    {
      field: "investor_entity",
      value: { type: "text", value: fixture.investor },
      spans: [span(fixture.investor)],
    },
    {
      field: "instrument_date",
      value: { type: "date", value: fixture.date },
      spans: [span(fixture.date)],
    },
    {
      field: "principal_amount",
      value: {
        type: "money",
        amount: canonicalizeDecimal(fixture.amount.replace(/[$,]/gu, "")),
        currency: "USD",
      },
      spans: [span(fixture.amount)],
    },
  ];
  if (fixture.valuationCap) {
    fields.push({
      field: "valuation_cap",
      value: {
        type: "money",
        amount: canonicalizeDecimal(fixture.valuationCap.replace(/[$,]/gu, "")),
        currency: "USD",
      },
      spans: [span(fixture.valuationCap)],
    });
  }
  if (fixture.discountPercent) {
    fields.push({
      field: "discount_rate",
      value: {
        type: "decimal",
        value: canonicalizeDecimal(fixture.discountPercent),
        unitCode: "%",
      },
      spans: [span(`${fixture.discountPercent}%`)],
    });
  }
  if (fixture.mfn === "assert") {
    fields.push({
      field: "mfn_clause",
      value: { type: "boolean", value: true },
      spans: [
        span(
          "Investor shall have most favored nation rights with respect to any subsequent instrument.",
        ),
      ],
    });
  } else if (fixture.mfn === "negate") {
    fields.push({
      field: "mfn_clause",
      value: { type: "boolean", value: false },
      spans: [
        span(
          "Investor shall have no most favored nation rights under this instrument.",
        ),
      ],
    });
  }
  if (fixture.proRata === "assert") {
    fields.push({
      field: "pro_rata_right",
      value: { type: "boolean", value: true },
      spans: [
        span(
          "Investor shall have pro rata rights to participate in the company's next equity financing.",
        ),
      ],
    });
  }
  if (fixture.governingLaw) {
    fields.push({
      field: "governing_law",
      value: { type: "text", value: fixture.governingLaw },
      spans: [span(fixture.governingLaw)],
    });
  }
  if (fixture.instrumentForm) {
    fields.push({
      field: "instrument_form",
      value: { type: "text", value: fixture.instrumentForm },
      spans: [span(fixture.instrumentForm)],
    });
  }
  if (fixture.interestRatePercent) {
    fields.push({
      field: "interest_rate",
      value: {
        type: "decimal",
        value: canonicalizeDecimal(fixture.interestRatePercent),
        unitCode: "%",
      },
      spans: [span(`${fixture.interestRatePercent}%`)],
    });
  }
  if (fixture.maturityDate) {
    fields.push({
      field: "maturity_date",
      value: { type: "date", value: fixture.maturityDate },
      spans: [span(fixture.maturityDate)],
    });
  }
  return {
    anchor: [span(fixture.company)],
    fields,
  };
}

const ANCHOR_ROBOTICS: SafeFixture = {
  externalId: "synthetic://safe-corpus/anchor-robotics",
  company: "Anchor Robotics Inc.",
  investor: "Kestrel Ventures LLC",
  date: "2020-02-10",
  amount: "$100,000.00",
  valuationCap: "$5,000,000.00",
  discountPercent: "20",
  mfn: "assert",
  proRata: "assert",
  governingLaw: "the State of Delaware",
  instrumentForm: "post-money SAFE",
};

/** MFN is never mentioned at all: absent, per rule 7, never false. */
const BRIGHTLINE_FOODS: SafeFixture = {
  externalId: "synthetic://safe-corpus/brightline-foods",
  company: "Brightline Foods Co.",
  investor: "Kestrel Ventures LLC",
  date: "2020-08-01",
  amount: "$50,000.00",
  valuationCap: "$8,000,000.00",
  governingLaw: "the State of New York",
  instrumentForm: "pre-money SAFE",
};

/** Outside the 2020 range, and MFN is explicitly negated: stores false. */
const CASCADE_MATERIALS: SafeFixture = {
  externalId: "synthetic://safe-corpus/cascade-materials",
  company: "Cascade Materials LLC",
  investor: "Kestrel Ventures LLC",
  date: "2019-05-01",
  amount: "$75,000.00",
  discountPercent: "15",
  mfn: "negate",
};

/** The convertible note: interest rate and maturity date, section 12. */
const FENWICK_ANALYTICS: SafeFixture = {
  externalId: "synthetic://safe-corpus/fenwick-analytics",
  company: "Fenwick Analytics Inc.",
  investor: "Kestrel Ventures LLC",
  date: "2021-01-15",
  amount: "$200,000.00",
  discountPercent: "10",
  instrumentForm: "convertible note",
  interestRatePercent: "5",
  maturityDate: "2023-01-15",
  governingLaw: "the State of California",
};

async function seedCorpus() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic SAFE corpus",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:safe-subject",
      kind: "person",
      canonicalName: "Synthetic Owner",
      normalizedName: "synthetic owner",
      aliases: [],
      normalizedAliases: [],
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "synthetic-safe-corpus",
      name: "Synthetic SAFE corpus",
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

    const seedDoc = async (fixture: SafeFixture) => {
      const text = fixtureText(fixture);
      const sourceItem = await createOrGetSourceItem(ctx, {
        spaceId,
        sourceAccountId,
        externalId: fixture.externalId,
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
          processingFingerprint: `base:${fixture.externalId}`,
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

    const anchorId = await seedDoc(ANCHOR_ROBOTICS);
    const brightlineId = await seedDoc(BRIGHTLINE_FOODS);
    const cascadeId = await seedDoc(CASCADE_MATERIALS);
    const fenwickId = await seedDoc(FENWICK_ANALYTICS);

    return {
      userId,
      spaceId,
      entityId,
      sourceAccountId,
      anchorId,
      brightlineId,
      cascadeId,
      fenwickId,
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
  fixture: SafeFixture,
  now: number,
) {
  const loaded = await harness.t.run((ctx) =>
    loadCardExtractionDocument(ctx, sourceItemId),
  );
  if (loaded.status !== "ready") {
    throw new Error(`fixture did not load: ${loaded.code}`);
  }
  const result = await runCardLadder({
    recordKind: "safe_note_card",
    document: loaded.document,
    now,
    ops: opsFor(harness, sourceItemId),
    runners: [
      fixtureCardRunner({ step: "tier0", candidate: fixtureCandidate(fixture) }),
      fixtureCardRunner({ step: "tier1", candidate: fixtureCandidate(fixture) }),
    ],
  });
  if (result.outcome !== "accepted") {
    throw new Error(`fixture card did not publish: ${result.outcome}`);
  }
  return result;
}

describe("the SAFE and convertible note card", () => {
  test("every declared field publishes for its fixture, with an absent clause staying absent", async () => {
    const harness = await seedCorpus();
    const anchor = await publishFixture(
      harness,
      harness.anchorId,
      ANCHOR_ROBOTICS,
      1_000,
    );
    expect(anchor.storedFields.sort()).toEqual(
      [
        "company",
        "investor_entity",
        "instrument_date",
        "principal_amount",
        "valuation_cap",
        "discount_rate",
        "mfn_clause",
        "pro_rata_right",
        "governing_law",
        "instrument_form",
      ].sort(),
    );

    const brightline = await publishFixture(
      harness,
      harness.brightlineId,
      BRIGHTLINE_FOODS,
      1_001,
    );
    // No span ever asserted or negated MFN, so the field never reaches the
    // gate at all: it is absent, never stored as false.
    expect(brightline.storedFields).not.toContain("mfn_clause");
    expect(brightline.storedFields).not.toContain("discount_rate");

    const cascade = await publishFixture(
      harness,
      harness.cascadeId,
      CASCADE_MATERIALS,
      1_002,
    );
    expect(cascade.storedFields).toContain("mfn_clause");
    expect(cascade.storedFields).not.toContain("valuation_cap");

    const fenwick = await publishFixture(
      harness,
      harness.fenwickId,
      FENWICK_ANALYTICS,
      1_003,
    );
    expect(fenwick.storedFields.sort()).toEqual(
      [
        "company",
        "investor_entity",
        "instrument_date",
        "principal_amount",
        "discount_rate",
        "governing_law",
        "instrument_form",
        "interest_rate",
        "maturity_date",
      ].sort(),
    );

    // The negated fixture's own observation reads false, not absent.
    const cascadeMfn = await harness.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("observations")
        .withIndex("by_space_entity_type_sort", (q) =>
          q
            .eq("spaceId", harness.spaceId)
            .eq("entityId", harness.entityId)
            .eq("observationType", "mfn_clause"),
        )
        .collect();
      return rows.filter((row) =>
        (row.occurrenceSortKey ?? "").startsWith("2019-05-01"),
      );
    });
    expect(cascadeMfn.length).toBe(1);
    expect(cascadeMfn[0]!.value).toEqual({ type: "boolean", value: false });
  });

  test('query example: "what companies did I invest in in 2020" via list_events', async () => {
    const harness = await seedCorpus();
    await publishFixture(harness, harness.anchorId, ANCHOR_ROBOTICS, 1_000);
    await publishFixture(harness, harness.brightlineId, BRIGHTLINE_FOODS, 1_001);
    await publishFixture(harness, harness.cascadeId, CASCADE_MATERIALS, 1_002);
    await publishFixture(harness, harness.fenwickId, FENWICK_ANALYTICS, 1_003);

    const result = await harness.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(harness.userId),
        now: 2_000,
        query: {
          operation: "list_events",
          spaceId: harness.spaceId,
          entityId: harness.entityId,
          eventType: "safe_note_card",
          from: Date.parse("2020-01-01T00:00:00Z"),
          to: Date.parse("2021-01-01T00:00:00Z"),
          order: "asc",
        },
      }),
    );
    if (result.operation !== "list_events") throw new Error("wrong operation");
    // Exactly the two 2020 fixtures: Anchor Robotics and Brightline Foods.
    // Cascade Materials (2019) and Fenwick Analytics (2021) are excluded.
    expect(result.records.map((record) => record.sourceItemId).sort()).toEqual(
      [harness.anchorId, harness.brightlineId].sort(),
    );
    expect(result.status).toBe("match");
  });

  test('query example: "deal terms of my investment in Anchor Robotics" via observation_history', async () => {
    const harness = await seedCorpus();
    await publishFixture(harness, harness.anchorId, ANCHOR_ROBOTICS, 1_000);
    await publishFixture(harness, harness.brightlineId, BRIGHTLINE_FOODS, 1_001);

    // A window tight around Anchor Robotics' own date, so the shared
    // placeholder investor entity (section 4.5, until P2-70l) does not pull
    // in Brightline Foods' August fields.
    const from = Date.parse("2020-02-01T00:00:00Z");
    const to = Date.parse("2020-02-20T00:00:00Z");
    const query = async (observationType: string) =>
      await harness.t.run((ctx) =>
        executeRecordQuery(ctx, {
          principal: webPrincipal(harness.userId),
          now: 2_000,
          query: {
            operation: "observation_history",
            spaceId: harness.spaceId,
            entityId: harness.entityId,
            observationType,
            from,
            to,
            order: "asc",
          },
        }),
      );

    const cap = await query("valuation_cap");
    if (cap.operation !== "observation_history") throw new Error("wrong op");
    expect(cap.records.length).toBe(1);
    expect(cap.records[0]!.value).toEqual({
      type: "money",
      amount: canonicalizeDecimal("5000000.00"),
      currency: "USD",
    });

    const discount = await query("discount_rate");
    if (discount.operation !== "observation_history") throw new Error("wrong op");
    expect(discount.records.length).toBe(1);
    expect(discount.records[0]!.value).toEqual({
      type: "decimal",
      value: canonicalizeDecimal("20"),
      unitCode: "%",
    });

    const mfn = await query("mfn_clause");
    if (mfn.operation !== "observation_history") throw new Error("wrong op");
    expect(mfn.records.length).toBe(1);
    expect(mfn.records[0]!.value).toEqual({ type: "boolean", value: true });

    // Brightline Foods never mentions MFN: no observation, not a false one.
    const brightlineWindow = {
      from: Date.parse("2020-07-25T00:00:00Z"),
      to: Date.parse("2020-08-10T00:00:00Z"),
    };
    const brightlineMfn = await harness.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(harness.userId),
        now: 2_000,
        query: {
          operation: "observation_history",
          spaceId: harness.spaceId,
          entityId: harness.entityId,
          observationType: "mfn_clause",
          ...brightlineWindow,
          order: "asc",
        },
      }),
    );
    if (brightlineMfn.operation !== "observation_history") {
      throw new Error("wrong op");
    }
    expect(brightlineMfn.records).toEqual([]);
  });

  test("ladder: tier 0 misses the required amount, tier 1 publishes exactly one generation", async () => {
    const harness = await seedCorpus();
    const loaded = await harness.t.run((ctx) =>
      loadCardExtractionDocument(ctx, harness.anchorId),
    );
    if (loaded.status !== "ready") throw new Error("fixture did not load");

    const full = fixtureCandidate(ANCHOR_ROBOTICS);
    const missingAmount = {
      ...full,
      fields: full.fields.filter((field) => field.field !== "principal_amount"),
    };

    const result = await runCardLadder({
      recordKind: "safe_note_card",
      document: loaded.document,
      now: 5_000,
      ops: opsFor(harness, harness.anchorId),
      runners: [
        fixtureCardRunner({ step: "tier0", candidate: missingAmount }),
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
          row.sourceItemId === harness.anchorId &&
          row.recordSchemaFingerprint.includes("safe_note_card"),
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
