import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  stageEvidenceSpans,
  stagePages,
} from "../provenance/model";

import {
  CARD_PLAYBOOK_VERSION,
  loadCardExtractionDocument,
  resolveCardSpan,
  runCardLadder,
  type CardExtractionDocument,
  type CardLadderOps,
} from "./cardLadder";
import { publishDocumentCard } from "./cards";
import {
  CARD_PROMPT_VERSION,
  fixtureCardRunner,
  localCardRunner,
  type CardRunner,
  type CardRunnerCandidate,
} from "./cardRunner";
import type { CardRecordKind } from "./cardSchemas";

// Synthetic fixture only. Nothing here describes a real document, no runner
// in this file calls a model, and no test reaches the network.

const PAGE_ONE = "Mutual Non-Disclosure Agreement\nDated 2025-03-04.";
const PAGE_TWO =
  "Between Northwind Supply and Acme Research.\nSummary: both sides keep material confidential.";
const TEXT = `${PAGE_ONE}\n${PAGE_TWO}`;

const TITLE = "Mutual Non-Disclosure Agreement";
const DATE = "2025-03-04";
const PARTY = "Northwind Supply";
const SUMMARY = "both sides keep material confidential";

/** Every quote a fixture may cite, staged as a span before the text seals. */
const QUOTES: Array<{ page: 0 | 1; quote: string }> = [
  { page: 0, quote: TITLE },
  { page: 0, quote: DATE },
  { page: 1, quote: PARTY },
  { page: 1, quote: SUMMARY },
];

const FINGERPRINT = {
  cardSchemaVersion: 1,
  playbookVersion: CARD_PLAYBOOK_VERSION,
  promptVersion: CARD_PROMPT_VERSION,
};

async function seedDocument() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic ladder",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:ladder-subject",
      kind: "person",
      canonicalName: "Synthetic Subject",
      normalizedName: "synthetic subject",
      aliases: [],
      normalizedAliases: [],
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "synthetic-ladder",
      name: "Synthetic ladder",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 1_000_000,
      createdBy: userId,
      subjectEntityId: entityId,
    });
    const sourceItem = await createOrGetSourceItem(ctx, {
      spaceId,
      sourceAccountId,
      externalId: "synthetic://ladder/one",
    });
    const revision = await createOrGetRevision(ctx, {
      spaceId,
      sourceItemId: sourceItem._id,
      mediaType: "text/plain",
      inlineText: TEXT,
      capturedAt: 1_700_000_000_000,
      userId,
    });
    const textVersion = await createOrGetTextVersion(ctx, {
      spaceId,
      sourceRevisionId: revision._id,
      extractionFingerprint: "plain:v1",
      text: TEXT,
    });
    const pages = await stagePages(ctx, {
      spaceId,
      sourceTextVersionId: textVersion._id,
      pages: [
        { ordinal: 0, start: 0, end: PAGE_ONE.length, text: PAGE_ONE },
        {
          ordinal: 1,
          start: PAGE_ONE.length + 1,
          end: TEXT.length,
          text: PAGE_TWO,
        },
      ],
    });
    const pageText = [PAGE_ONE, PAGE_TWO];
    await stageEvidenceSpans(ctx, {
      spaceId,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      spans: QUOTES.map((entry, ordinal) => {
        const start = pageText[entry.page]!.indexOf(entry.quote);
        if (start < 0) throw new Error(`fixture quote missing: ${entry.quote}`);
        return {
          sourcePageId: pages[entry.page]!._id,
          ordinal,
          start,
          end: start + entry.quote.length,
        };
      }),
    });
    const processingGenerationId = await ctx.db.insert(
      "processingGenerations",
      {
        spaceId,
        sourceAccountId,
        sourceItemId: sourceItem._id,
        sourceRevisionId: revision._id,
        sourceTextVersionId: textVersion._id,
        processingFingerprint: "ladder-base:v1",
        extractionFingerprint: "plain:v1",
        extractorFingerprint: "synthetic:v1",
        recordSchemaFingerprint: "records:v1",
        normalizationFingerprint: "exact:v1",
        chunkerFingerprint: "none:v1",
        correctionRevision: "one",
        desiredProcessingEpoch: 1,
        state: "ready",
        expectedPageCount: 2,
        expectedEvidenceSpanCount: QUOTES.length,
        expectedDocumentCount: 1,
        expectedChunkCount: 0,
        expectedEventCount: 0,
        expectedObservationCount: 0,
        actualPageCount: 2,
        actualEvidenceSpanCount: QUOTES.length,
        actualDocumentCount: 1,
        actualChunkCount: 0,
        embeddingStatus: "unavailable",
        activatedAt: 100,
      },
    );
    await ctx.db.insert("documents", {
      spaceId,
      processingGenerationId,
      sourceItemId: sourceItem._id,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      documentKey: "synthetic://ladder/one",
      title: "Worker supplied title",
      docType: "note",
      capturedAt: 1_700_000_000_000,
      evidenceSpanIds: [],
      publicationState: "active",
    });
    await ctx.db.patch(textVersion._id, { evidenceSealed: true });
    await ctx.db.patch(sourceItem._id, {
      desiredRevisionId: revision._id,
      activeRevisionId: revision._id,
      activeGenerationId: processingGenerationId,
    });
    await ctx.db.insert("spaceProcessingState", {
      spaceId,
      activationEpoch: 1,
      activatedAt: 100,
    });
    return { userId, spaceId, sourceItemId: sourceItem._id };
  });
  const loaded = await t.run((ctx) =>
    loadCardExtractionDocument(ctx, seeded.sourceItemId),
  );
  if (loaded.status !== "ready") {
    throw new Error(`fixture did not load: ${loaded.code}`);
  }
  return { t, ...seeded, document: loaded.document };
}

type Harness = Awaited<ReturnType<typeof seedDocument>>;

function opsFor(harness: Harness): CardLadderOps {
  return {
    publish: async (input) =>
      await harness.t.run((ctx) =>
        publishDocumentCard(ctx, {
          spaceId: harness.spaceId,
          sourceItemId: harness.sourceItemId,
          userId: harness.userId,
          recordKind: input.recordKind,
          now: input.now,
          fingerprint: { ...FINGERPRINT, tier: input.step },
          anchorEvidenceSpanIds: input.anchorEvidenceSpanIds,
          fields: input.fields,
          runner: input.runner,
        }),
      ),
    recordSkip: async (input) => {
      await harness.t.mutation(
        internal.models.records.cards.recordSkippedCardAttempt,
        {
          sourceItemId: harness.sourceItemId,
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

function span(page: 0 | 1, quote: string) {
  return { pageOrdinal: page, quote };
}

/** A correct generic card, every field cited by a staged span. */
function goodGeneric(): CardRunnerCandidate {
  return {
    anchor: [span(0, TITLE)],
    fields: [
      {
        field: "card_title",
        value: { type: "text", value: TITLE },
        spans: [span(0, TITLE)],
      },
      {
        field: "card_date",
        value: { type: "date", value: DATE },
        spans: [span(0, DATE)],
      },
      {
        field: "card_party",
        ordinal: 0,
        value: { type: "text", value: PARTY },
        spans: [span(1, PARTY)],
      },
      {
        field: "card_summary",
        value: { type: "text", value: SUMMARY },
        spans: [span(1, SUMMARY)],
      },
    ],
  };
}

/**
 * The deliberately wrong candidate: a required field whose proposed value the
 * cited span does not reproduce. No model is asked whether this is wrong.
 */
function wrongGeneric(): CardRunnerCandidate {
  const candidate = goodGeneric();
  return {
    ...candidate,
    fields: candidate.fields.map((field) =>
      field.field === "card_title"
        ? { ...field, value: { type: "text" as const, value: "Lease" } }
        : field,
    ),
  };
}

function ladder(...runners: CardRunner[]): CardRunner[] {
  return [localCardRunner(), ...runners];
}

async function attempts(
  harness: Harness,
): Promise<Doc<"cardExtractionAttempts">[]> {
  return await harness.t.run(
    async (ctx) => await ctx.db.query("cardExtractionAttempts").collect(),
  );
}

async function cardGenerations(
  harness: Harness,
  recordKind: CardRecordKind,
): Promise<Doc<"processingGenerations">[]> {
  return await harness.t.run(async (ctx) => {
    const rows = await ctx.db.query("processingGenerations").collect();
    return rows.filter(
      (row) =>
        row.cardGeneration === true &&
        row.recordSchemaFingerprint.includes(recordKind),
    );
  });
}

describe("the extraction ladder", () => {
  test("step 0 passes: one generation, and the local step is recorded skipped", async () => {
    const harness = await seedDocument();
    const result = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 1_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: goodGeneric() }),
        fixtureCardRunner({ step: "tier1", candidate: goodGeneric() }),
      ),
    });

    expect(result.outcome).toBe("accepted");
    expect(result.acceptedStep).toBe("tier0");
    expect(result.storedFields.sort()).toEqual([
      "card_date",
      "card_party:0",
      "card_summary",
      "card_title",
    ]);
    // Exactly one generation, and tier 1 never ran.
    expect((await cardGenerations(harness, "document_card")).length).toBe(1);
    expect(result.steps).toEqual([
      { step: "local", modelId: "local:none", outcome: "skipped" },
      { step: "tier0", modelId: "fixture:tier0", outcome: "accepted" },
    ]);

    const rows = await attempts(harness);
    expect(rows.map((row) => [row.step, row.outcome]).sort()).toEqual([
      ["local", "skipped"],
      ["tier0", "accepted"],
    ]);
    const local = rows.find((row) => row.step === "local")!;
    // A skipped step is recorded skipped, never accepted, and costs nothing.
    expect(local.outcome).toBe("skipped");
    expect(local.passedFieldCount).toBe(0);
    expect(local.costMicroUsd).toBe(0);
    const tier0 = rows.find((row) => row.step === "tier0")!;
    expect(tier0.inputTokens).toBe(1_000);
    expect(tier0.outputTokens).toBe(100);
    expect(tier0.wallTimeMs).toBe(5);
    expect(tier0.priceTableVersion).toBe("card-prices-2026-09-12");
    expect(tier0.modelId).toBe("fixture:tier0");
  });

  test("step 0 fails a required field and step 1 passes: one generation, two runner attempts", async () => {
    const harness = await seedDocument();
    const result = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 2_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: wrongGeneric() }),
        fixtureCardRunner({ step: "tier1", candidate: goodGeneric() }),
      ),
    });

    expect(result.outcome).toBe("accepted");
    expect(result.acceptedStep).toBe("tier1");
    // Escalation publishes exactly one generation, at the accepted step.
    const generations = await cardGenerations(harness, "document_card");
    expect(generations.length).toBe(1);
    expect(generations[0]!.recordSchemaFingerprint).toContain("tier:tier1");

    const rows = await attempts(harness);
    const runnerRows = rows.filter((row) => row.step !== "local");
    expect(runnerRows.length).toBe(2);
    expect(runnerRows.map((row) => [row.step, row.outcome]).sort()).toEqual([
      ["tier0", "escalated"],
      ["tier1", "accepted"],
    ]);
    // Nothing from the rejected step was staged.
    const drops = await harness.t.run(
      async (ctx) => await ctx.db.query("cardFieldDrops").collect(),
    );
    expect(drops.filter((row) => row.kind === "card_gate_failed")).toEqual([]);
  });

  test("both steps fail: a card_gate_failed review item and no card", async () => {
    const harness = await seedDocument();
    const result = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 3_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: wrongGeneric() }),
        fixtureCardRunner({ step: "tier1", candidate: wrongGeneric() }),
      ),
    });

    expect(result.outcome).toBe("review");
    expect(result.acceptedStep).toBeUndefined();
    expect((await cardGenerations(harness, "document_card")).length).toBe(0);

    const rows = await attempts(harness);
    expect(
      rows
        .filter((row) => row.step !== "local")
        .map((row) => [row.step, row.outcome])
        .sort(),
    ).toEqual([
      ["tier0", "escalated"],
      ["tier1", "review"],
    ]);
    const drops = await harness.t.run(
      async (ctx) => await ctx.db.query("cardFieldDrops").collect(),
    );
    const failed = drops.filter((row) => row.kind === "card_gate_failed");
    expect(failed.map((row) => row.fieldKey)).toEqual(["card_title"]);
    expect(failed[0]!.code).toBe("value_not_in_span");
    // The refused value is never written to the review row.
    expect(JSON.stringify(failed)).not.toContain("Lease");
  });

  test("a failed typed card leaves the generic card published", async () => {
    const harness = await seedDocument();
    const generic = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 4_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: goodGeneric() }),
        fixtureCardRunner({ step: "tier1", candidate: goodGeneric() }),
      ),
    });
    expect(generic.outcome).toBe("accepted");
    const genericGenerationId = generic.processingGenerationId;

    // A SAFE card that cites a real span for `company` and has no evidence at
    // all for its other required fields. It fails the gate at every step.
    const typedCandidate: CardRunnerCandidate = {
      anchor: [span(0, TITLE)],
      fields: [
        {
          field: "company",
          value: { type: "text", value: PARTY },
          spans: [span(1, PARTY)],
        },
      ],
    };
    const typed = await runCardLadder({
      recordKind: "safe_note_card",
      document: harness.document,
      now: 5_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: typedCandidate }),
        fixtureCardRunner({ step: "tier1", candidate: typedCandidate }),
      ),
    });

    expect(typed.outcome).toBe("review");
    expect((await cardGenerations(harness, "safe_note_card")).length).toBe(0);
    // The generic card is still the item's active card generation.
    const item = await harness.t.run(
      async (ctx) => await ctx.db.get(harness.sourceItemId),
    );
    expect(item!.activeCardGenerationId).toBe(genericGenerationId);
    const drops = await harness.t.run(
      async (ctx) => await ctx.db.query("cardFieldDrops").collect(),
    );
    expect(
      drops
        .filter((row) => row.kind === "card_gate_failed")
        .map((row) => row.fieldKey)
        .sort(),
    ).toEqual(["instrument_date", "investor_entity", "principal_amount"]);
  });

  test("every step unconfigured refuses rather than reporting a pass", async () => {
    const harness = await seedDocument();
    const result = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 6_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", notConfigured: "no key" }),
        fixtureCardRunner({ step: "tier1", notConfigured: "no key" }),
      ),
    });
    expect(result).toMatchObject({
      outcome: "refused",
      refusalCode: "no_runner_configured",
    });
    const rows = await attempts(harness);
    expect(rows.every((row) => row.outcome === "skipped")).toBe(true);
  });
});

describe("turning a cited location into evidence", () => {
  test("resolves an exact quote and an exact range to the same span", async () => {
    const harness = await seedDocument();
    const byQuote = resolveCardSpan(span(1, PARTY), harness.document);
    const start = PAGE_TWO.indexOf(PARTY);
    const byRange = resolveCardSpan(
      { pageOrdinal: 1, start, end: start + PARTY.length },
      harness.document,
    );
    expect(byQuote).toBeDefined();
    expect(byRange).toBe(byQuote);
  });

  test("refuses a location no sealed span covers, and an ambiguous quote", async () => {
    const harness = await seedDocument();
    // Real text, but no evidence span was ever staged over it.
    expect(
      resolveCardSpan(span(1, "Acme Research"), harness.document),
    ).toBeUndefined();
    // A quote that appears twice on its page proves nothing in particular.
    const document: Pick<CardExtractionDocument, "pages" | "spans"> = {
      pages: [{ ordinal: 0, text: "north north" }],
      spans: [
        {
          spanId: "x" as Id<"evidenceSpans">,
          pageOrdinal: 0,
          start: 0,
          end: 5,
        },
      ],
    };
    expect(resolveCardSpan(span(0, "north"), document)).toBeUndefined();
  });

  test("an uncitable field drops with evidence_missing rather than vanishing", async () => {
    const harness = await seedDocument();
    const candidate = goodGeneric();
    const result = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 7_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({
          step: "tier0",
          candidate: {
            ...candidate,
            fields: [
              ...candidate.fields,
              {
                field: "card_party",
                ordinal: 1,
                value: { type: "text", value: "Acme Research" },
                spans: [span(1, "Acme Research")],
              },
            ],
          },
        }),
        fixtureCardRunner({ step: "tier1", candidate }),
      ),
    });
    expect(result.outcome).toBe("accepted");
    expect(result.acceptedStep).toBe("tier0");
    const drops = await harness.t.run(
      async (ctx) => await ctx.db.query("cardFieldDrops").collect(),
    );
    expect(drops.map((row) => [row.kind, row.fieldKey, row.code])).toEqual([
      ["field_dropped", "card_party:1", "evidence_missing"],
    ]);
  });
});

describe("document-first budgeting", () => {
  test("a document over the declared byte limit is refused, not truncated", async () => {
    const harness = await seedDocument();
    const oversized = await harness.t.run(async (ctx) => {
      const item = await ctx.db.get(harness.sourceItemId);
      const base = await ctx.db.get(item!.activeGenerationId!);
      const textVersionId = base!.sourceTextVersionId!;
      const pages = await ctx.db
        .query("sourcePages")
        .withIndex("by_sourceTextVersionId", (q) =>
          q.eq("sourceTextVersionId", textVersionId),
        )
        .collect();
      // Patch the retained page text past the limit in place; the ladder must
      // refuse with a closed code rather than shorten it back.
      await ctx.db.patch(pages[0]!._id, { text: "x".repeat(200 * 1024) });
      return await loadCardExtractionDocument(ctx, harness.sourceItemId);
    });
    expect(oversized).toEqual({
      status: "refused",
      code: "document_too_large",
    });
  });
});

describe("the extractCard entry point", () => {
  test("wires the query, the runners and the skip mutation with no network call", async () => {
    // No provider credential in this environment, so every hosted step reports
    // itself unconfigured and no request is attempted. This test proves the
    // action's wiring, never a model.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.BRAIN_CARD_API_KEY;
    const harness = await seedDocument();
    const result = await harness.t.action(
      internal.models.records.cardLadder.extractCard,
      { sourceItemId: harness.sourceItemId, kind: "document_card", now: 8_000 },
    );
    expect(result).toMatchObject({
      outcome: "refused",
      refusalCode: "no_runner_configured",
    });
    expect(result.steps.map((step) => step.step)).toEqual([
      "local",
      "tier0",
      "tier1",
    ]);
    const rows = await attempts(harness);
    expect(rows.length).toBe(3);
    expect(rows.every((row) => row.outcome === "skipped")).toBe(true);
    expect(rows.map((row) => row.modelId).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "local:none",
    ]);
  });
});
