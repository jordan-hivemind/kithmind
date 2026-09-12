import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { utf8ByteLength } from "../ingestion/hash";
import {
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  sha256Utf8,
  stageEvidenceSpans,
  stagePages,
} from "../provenance/model";
import { digestParsedMappingManifest } from "../workers/parsedProtocol";

import { hydrateObservation } from "./model";

import {
  CARD_PLAYBOOK_VERSION,
  loadCardExtractionDocument,
  runCardLadder,
  toStagingRef,
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
const PAGE_TWO = [
  "Between Northwind Supply and Acme Research.",
  "Summary: both sides keep material confidential.",
  "The investor advances $250,000.00 under this instrument.",
].join("\n");
const TEXT = `${PAGE_ONE}\n${PAGE_TWO}`;

const TITLE = "Mutual Non-Disclosure Agreement";
const DATE = "2025-03-04";
const PARTY = "Northwind Supply";
const SUMMARY = "both sides keep material confidential";

/** An amount stated in prose. The parser staged no span over it. */
const AMOUNT = "$250,000.00";
/** Named in prose only. The parser staged no span over it either. */
const INVESTOR = "Acme Research";

/**
 * The spans the parser staged before the text sealed. `AMOUNT` and `INVESTOR`
 * are deliberately absent: a card that needs them must stage its own span
 * over the sealed page, which is the rule settled on review 2026-09-12.
 */
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

const CAPTURED_AT = 1_700_000_000_000;
const EXTRACTION_FINGERPRINT = "plain:v1";
const PARSER_FINGERPRINT = "pdf_docqa_v1";

/**
 * The two chains a generation can have. Every test in this file runs against
 * one of them, and the ladder tests run against both: the card evidence gate
 * has to prove a page either way. See `requireChainRepresentation` in
 * `records/model.ts`.
 */
type ChainRepresentation = "inline_text_v1" | "parsed_pages_v1";

type SeededChain = {
  sourceRevisionId: Id<"sourceRevisions">;
  sourceTextVersionId: Id<"sourceTextVersions">;
  parserArtifactId?: Id<"sourceParserArtifacts">;
};

/** Inline pages index into `TEXT`, so page two starts after the joining \n. */
const INLINE_PAGES = [
  { ordinal: 0, start: 0, end: PAGE_ONE.length, text: PAGE_ONE },
  {
    ordinal: 1,
    start: PAGE_ONE.length + 1,
    end: TEXT.length,
    text: PAGE_TWO,
  },
];

/**
 * Parsed pages are contiguous over the parser's complete text, the way the
 * parsed pipeline requires. Both page sets carry the same page text, so a
 * quote sits at the same page-relative offset in either fixture.
 */
const PARSED_PAGES = [
  { ordinal: 0, start: 0, end: PAGE_ONE.length, text: PAGE_ONE },
  {
    ordinal: 1,
    start: PAGE_ONE.length,
    end: PAGE_ONE.length + PAGE_TWO.length,
    text: PAGE_TWO,
  },
];

function quoteStart(entry: { page: 0 | 1; quote: string }): number {
  const start = [PAGE_ONE, PAGE_TWO][entry.page]!.indexOf(entry.quote);
  if (start < 0) throw new Error(`fixture quote missing: ${entry.quote}`);
  return start;
}

/**
 * The inline path: the revision holds the document's UTF-8 bytes and the text
 * version retains the whole extracted string, so a page proves itself by
 * slicing out of that string.
 */
async function seedInlineChain(
  ctx: MutationCtx,
  seed: {
    spaceId: Id<"spaces">;
    userId: Id<"users">;
    sourceItemId: Id<"sourceItems">;
  },
): Promise<SeededChain> {
  const revision = await createOrGetRevision(ctx, {
    spaceId: seed.spaceId,
    sourceItemId: seed.sourceItemId,
    mediaType: "text/plain",
    inlineText: TEXT,
    capturedAt: CAPTURED_AT,
    userId: seed.userId,
  });
  const textVersion = await createOrGetTextVersion(ctx, {
    spaceId: seed.spaceId,
    sourceRevisionId: revision._id,
    extractionFingerprint: EXTRACTION_FINGERPRINT,
    text: TEXT,
  });
  const pages = await stagePages(ctx, {
    spaceId: seed.spaceId,
    sourceTextVersionId: textVersion._id,
    pages: INLINE_PAGES,
  });
  await stageEvidenceSpans(ctx, {
    spaceId: seed.spaceId,
    sourceRevisionId: revision._id,
    sourceTextVersionId: textVersion._id,
    spans: QUOTES.map((entry, ordinal) => {
      const start = quoteStart(entry);
      return {
        sourcePageId: pages[entry.page]!._id,
        ordinal,
        start,
        end: start + entry.quote.length,
      };
    }),
  });
  await ctx.db.patch(textVersion._id, { evidenceSealed: true });
  return {
    sourceRevisionId: revision._id,
    sourceTextVersionId: textVersion._id,
  };
}

/**
 * The PDF path of docs/plans/2026-09-07-original-byte-contract.md, built the
 * way the parsed pipeline builds one. The original bytes are archived rather
 * than inlined, a parser artifact records the parse, and the sealed
 * `parsed_pages_v1` text version retains no whole-document string at all: its
 * retained text exists only as the page rows, which is why the card evidence
 * chain has to prove a page from the page itself.
 *
 * Synthetic throughout. No real document and no real parser output.
 */
async function seedParsedChain(
  ctx: MutationCtx,
  seed: {
    spaceId: Id<"spaces">;
    userId: Id<"users">;
    sourceAccountId: Id<"sourceAccounts">;
    sourceItemId: Id<"sourceItems">;
  },
): Promise<SeededChain> {
  const originalBytes = "%PDF-1.7 synthetic ladder fixture";
  const sourceRevisionId = await ctx.db.insert("sourceRevisions", {
    spaceId: seed.spaceId,
    sourceItemId: seed.sourceItemId,
    contentHash: await sha256Utf8(originalBytes),
    byteLength: utf8ByteLength(originalBytes),
    mediaType: "application/pdf",
    representation: "archived_binary_v1",
    contentHashAuthority: "worker_asserted",
    capturedAt: CAPTURED_AT,
    userId: seed.userId,
  });
  const actorCredentialId = await ctx.db.insert("apiKeys", {
    userId: seed.userId,
    keyHash: "synthetic-ladder-key-hash",
    keyPrefix: "km_synthetic",
    name: "Synthetic parser worker",
    capabilities: ["ingest"],
    spaceIds: [seed.spaceId],
  });
  const parserArtifactId = await ctx.db.insert("sourceParserArtifacts", {
    spaceId: seed.spaceId,
    sourceAccountId: seed.sourceAccountId,
    sourceItemId: seed.sourceItemId,
    sourceRevisionId,
    clientArtifactId: "synthetic-ladder-artifact",
    parserFingerprint: PARSER_FINGERPRINT,
    outputHash: await sha256Utf8("synthetic parser output"),
    outputByteLength: 64,
    outputMediaType: "application/json",
    hashAuthority: "worker_asserted",
    userId: seed.userId,
    actorCredentialId,
    createdAt: CAPTURED_AT,
  });

  // The parser's own mapping manifest, over the same rows a worker would have
  // sent, so the sealed text version carries a real manifest hash.
  const pageInputs = await Promise.all(
    PARSED_PAGES.map(async (page) => ({
      ordinal: page.ordinal,
      start: page.start,
      end: page.end,
      text: page.text,
      textHash: await sha256Utf8(page.text),
    })),
  );
  const evidenceInputs = await Promise.all(
    QUOTES.map(async (entry, ordinal) => {
      const start = quoteStart(entry);
      return {
        ordinal,
        pageOrdinal: entry.page,
        start,
        end: start + entry.quote.length,
        quoteHash: await sha256Utf8(entry.quote),
        locator: {
          kind: "parser_page_v1" as const,
          pageNumber: entry.page + 1,
          pageTextHash: pageInputs[entry.page]!.textHash,
        },
      };
    }),
  );
  const completeText = PARSED_PAGES.map((page) => page.text).join("");
  const sourceTextVersionId = await ctx.db.insert("sourceTextVersions", {
    spaceId: seed.spaceId,
    sourceRevisionId,
    extractionFingerprint: EXTRACTION_FINGERPRINT,
    representation: "parsed_pages_v1",
    textHash: await sha256Utf8(completeText),
    textHashAuthority: "server_verified_retained_text",
    byteLength: utf8ByteLength(completeText),
    utf16Length: completeText.length,
    pageCount: PARSED_PAGES.length,
    mappingManifestHash: await digestParsedMappingManifest(
      pageInputs,
      evidenceInputs,
    ),
    parserArtifactId,
    evidenceSealed: true,
  });
  const pageIds: Array<Id<"sourcePages">> = [];
  for (const page of pageInputs) {
    pageIds.push(
      await ctx.db.insert("sourcePages", {
        spaceId: seed.spaceId,
        sourceTextVersionId,
        ordinal: page.ordinal,
        start: page.start,
        end: page.end,
        text: page.text,
        textHash: page.textHash,
      }),
    );
  }
  for (const span of evidenceInputs) {
    await ctx.db.insert("evidenceSpans", {
      spaceId: seed.spaceId,
      sourceRevisionId,
      sourceTextVersionId,
      sourcePageId: pageIds[span.pageOrdinal]!,
      ordinal: span.ordinal,
      start: span.start,
      end: span.end,
      quoteHash: span.quoteHash,
      locator: { ...span.locator, parserArtifactId },
    });
  }
  return { sourceRevisionId, sourceTextVersionId, parserArtifactId };
}

async function seedDocument(
  representation: ChainRepresentation = "inline_text_v1",
) {
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
    const chain =
      representation === "parsed_pages_v1"
        ? await seedParsedChain(ctx, {
            spaceId,
            userId,
            sourceAccountId,
            sourceItemId: sourceItem._id,
          })
        : await seedInlineChain(ctx, {
            spaceId,
            userId,
            sourceItemId: sourceItem._id,
          });
    const processingGenerationId = await ctx.db.insert(
      "processingGenerations",
      {
        spaceId,
        sourceAccountId,
        sourceItemId: sourceItem._id,
        sourceRevisionId: chain.sourceRevisionId,
        sourceTextVersionId: chain.sourceTextVersionId,
        processingFingerprint: "ladder-base:v1",
        extractionFingerprint: EXTRACTION_FINGERPRINT,
        extractorFingerprint: "synthetic:v1",
        recordSchemaFingerprint: "records:v1",
        normalizationFingerprint: "exact:v1",
        chunkerFingerprint: "none:v1",
        correctionRevision: "one",
        ...(chain.parserArtifactId === undefined
          ? {}
          : { parserArtifactId: chain.parserArtifactId }),
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
      sourceRevisionId: chain.sourceRevisionId,
      sourceTextVersionId: chain.sourceTextVersionId,
      documentKey: "synthetic://ladder/one",
      title: "Worker supplied title",
      docType: "note",
      capturedAt: CAPTURED_AT,
      evidenceSpanIds: [],
      publicationState: "active",
    });
    await ctx.db.patch(sourceItem._id, {
      desiredRevisionId: chain.sourceRevisionId,
      activeRevisionId: chain.sourceRevisionId,
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
    stageEvidence: async (input) =>
      await harness.t.mutation(
        internal.models.records.cards.stageCardEvidence,
        {
          sourceItemId: harness.sourceItemId,
          recordKind: input.recordKind,
          fingerprint: { ...FINGERPRINT, tier: input.step },
          refs: input.refs.map(toStagingRef),
        },
      ),
    sweepEvidence: async () => {
      await harness.t.mutation(
        internal.models.records.cards.sweepCardEvidence,
        {
          sourceItemId: harness.sourceItemId,
        },
      );
    },
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
    expect(tier0.priceTableVersion).toBe("card-prices-2026-09-12-v2");
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

async function evidenceSpans(
  harness: Harness,
): Promise<Doc<"evidenceSpans">[]> {
  return await harness.t.run(
    async (ctx) => await ctx.db.query("evidenceSpans").collect(),
  );
}

function cardStaged(spans: Doc<"evidenceSpans">[]): Doc<"evidenceSpans">[] {
  return spans.filter((row) => row.cardExtractionFingerprints !== undefined);
}

/** A SAFE card whose money and investor are stated in prose only. */
function safeNote(
  overrides: { amountSpan?: ReturnType<typeof span> } = {},
): CardRunnerCandidate {
  return {
    anchor: [span(0, TITLE)],
    fields: [
      {
        field: "company",
        value: { type: "text", value: PARTY },
        spans: [span(1, PARTY)],
      },
      {
        field: "investor_entity",
        value: { type: "text", value: INVESTOR },
        spans: [span(1, INVESTOR)],
      },
      {
        field: "instrument_date",
        value: { type: "date", value: DATE },
        spans: [span(0, DATE)],
      },
      {
        field: "principal_amount",
        value: { type: "money", amount: "250000.00", currency: "USD" },
        spans: [overrides.amountSpan ?? span(1, AMOUNT)],
      },
    ],
  };
}

describe("staging evidence over sealed retained text", () => {
  test("a money field stated in prose publishes through a card-staged span", async () => {
    const harness = await seedDocument();
    const before = await evidenceSpans(harness);
    expect(cardStaged(before)).toEqual([]);

    const result = await runCardLadder({
      recordKind: "safe_note_card",
      document: harness.document,
      now: 7_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: safeNote() }),
        fixtureCardRunner({ step: "tier1", candidate: safeNote() }),
      ),
    });

    expect(result.outcome).toBe("accepted");
    expect(result.acceptedStep).toBe("tier0");
    expect(result.storedFields.sort()).toEqual([
      "company",
      "instrument_date",
      "investor_entity",
      "principal_amount",
    ]);

    const after = await evidenceSpans(harness);
    // Exactly the two prose citations became spans; the parser's four are
    // untouched, and the page they point into was never rewritten.
    const staged = cardStaged(after);
    expect(staged.length).toBe(2);
    expect(after.length - staged.length).toBe(QUOTES.length);
    const amountStart = PAGE_TWO.indexOf(AMOUNT);
    expect(
      staged.some(
        (row) =>
          row.start === amountStart && row.end === amountStart + AMOUNT.length,
      ),
    ).toBe(true);
    const pages = await harness.t.run(
      async (ctx) => await ctx.db.query("sourcePages").collect(),
    );
    expect(pages.map((page) => page.text).sort()).toEqual(
      [PAGE_ONE, PAGE_TWO].sort(),
    );
  });

  test("an existing parser span over the same range is reused, not duplicated", async () => {
    const harness = await seedDocument();
    const before = await evidenceSpans(harness);
    const start = PAGE_TWO.indexOf(PARTY);
    const parser = before.find(
      (row) => row.start === start && row.end === start + PARTY.length,
    );
    expect(parser).toBeDefined();

    const staged = await harness.t.mutation(
      internal.models.records.cards.stageCardEvidence,
      {
        sourceItemId: harness.sourceItemId,
        recordKind: "safe_note_card",
        fingerprint: { ...FINGERPRINT, tier: "tier0" as const },
        refs: [
          { pageOrdinal: 1, quote: PARTY },
          { pageOrdinal: 1, start, end: start + PARTY.length },
        ],
      },
    );
    // The quote form and the range form name the one span that already exists.
    expect(staged).toEqual([parser!._id, parser!._id]);
    expect((await evidenceSpans(harness)).length).toBe(before.length);
  });

  test("a quote the page does not contain is refused", async () => {
    const harness = await seedDocument();
    const staged = await harness.t.mutation(
      internal.models.records.cards.stageCardEvidence,
      {
        sourceItemId: harness.sourceItemId,
        recordKind: "safe_note_card",
        fingerprint: { ...FINGERPRINT, tier: "tier0" as const },
        refs: [
          { pageOrdinal: 1, quote: "$999,999.00" },
          { pageOrdinal: 9, quote: PARTY },
          { pageOrdinal: 1, start: 0, end: 1_000_000 },
        ],
      },
    );
    expect(staged).toEqual([null, null, null]);
    expect(cardStaged(await evidenceSpans(harness))).toEqual([]);
  });

  test("an abandoned generation leaves no card-staged span", async () => {
    const harness = await seedDocument();
    // A required money field citing a quote that is not on the page. The gate
    // refuses it at both steps, so no card generation is ever created.
    const wrong = safeNote({ amountSpan: span(1, "$999,999.00") });
    const result = await runCardLadder({
      recordKind: "safe_note_card",
      document: harness.document,
      now: 8_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: wrong }),
        fixtureCardRunner({ step: "tier1", candidate: wrong }),
      ),
    });

    expect(result.outcome).toBe("review");
    const drops = await harness.t.run(
      async (ctx) => await ctx.db.query("cardFieldDrops").collect(),
    );
    expect(
      drops
        .filter((row) => row.kind === "card_gate_failed")
        .map((row) => [row.fieldKey, row.code]),
    ).toEqual([["principal_amount", "evidence_missing"]]);
    // The investor span the rejected steps did stage is swept: its extraction
    // fingerprint names a card generation that was never created.
    expect(cardStaged(await evidenceSpans(harness))).toEqual([]);
  });

  test("a span a rejected step staged survives when the accepted step reuses it", async () => {
    const harness = await seedDocument();
    const wrongInvestor: CardRunnerCandidate = {
      ...safeNote(),
      fields: safeNote().fields.map((field) =>
        field.field === "investor_entity"
          ? {
              ...field,
              value: { type: "text" as const, value: "Someone Else" },
            }
          : field,
      ),
    };
    const result = await runCardLadder({
      recordKind: "safe_note_card",
      document: harness.document,
      now: 9_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: wrongInvestor }),
        fixtureCardRunner({ step: "tier1", candidate: safeNote() }),
      ),
    });

    expect(result.outcome).toBe("accepted");
    expect(result.acceptedStep).toBe("tier1");
    const staged = cardStaged(await evidenceSpans(harness));
    // Tier 0 created both rows and tier 1 reused them, so each row records
    // both citations. The sweep must not delete a row the accepted step
    // depends on merely because the step that first staged it was rejected.
    expect(staged.length).toBe(2);
    for (const row of staged) {
      const cited = row.cardExtractionFingerprints ?? [];
      expect(cited.length).toBe(2);
      expect(cited[0]).toContain("tier:tier0");
      expect(cited[1]).toContain("tier:tier1");
    }
    // Every stored field still resolves through the record store.
    const observations = await harness.t.run(
      async (ctx) => await ctx.db.query("observations").collect(),
    );
    const cited = new Set(
      observations.flatMap((row) => row.valueEvidence ?? []),
    );
    for (const row of staged) expect(cited.has(row._id)).toBe(true);
  });

  test("an uncitable field drops with evidence_missing rather than vanishing", async () => {
    const harness = await seedDocument();
    const candidate = goodGeneric();
    const result = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 10_000,
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
                value: { type: "text", value: "Nobody At All" },
                spans: [span(1, "Nobody At All")],
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

/**
 * P2-79. Every document in the owner's first real extraction run is
 * PDF-derived: the original bytes are archived and the worker's parse is
 * sealed as `parsed_pages_v1`, whose retained text exists only as page rows.
 * The card evidence chain was built and tested against inline text alone, so
 * `requireGenerationChain` refused every one of them and no card could
 * publish at all. These run the same ladder over the parsed fixture.
 */
describe("the extraction ladder over a PDF-derived document", () => {
  test("step 0 passes over sealed parsed pages, exactly as over inline text", async () => {
    const harness = await seedDocument("parsed_pages_v1");
    const result = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 11_000,
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
    const generations = await cardGenerations(harness, "document_card");
    expect(generations.length).toBe(1);
    // The card generation reads the parsed text version and names the same
    // parser artifact, which is what lets its chain resolve.
    expect(generations[0]!.parserArtifactId).toBeDefined();
    expect(result.steps).toEqual([
      { step: "local", modelId: "local:none", outcome: "skipped" },
      { step: "tier0", modelId: "fixture:tier0", outcome: "accepted" },
    ]);

    // The read side resolves the parsed chain too: a stored observation
    // hydrates with the quote cut from the sealed page.
    const hydrated = await harness.t.run(async (ctx) => {
      const observation = (await ctx.db.query("observations").collect()).find(
        (row) => row.observationType === "card_title",
      )!;
      return await hydrateObservation(ctx, {
        spaceId: harness.spaceId,
        observationId: observation._id,
      });
    });
    // Every quote is cut from a sealed page and rehashed, with no retained
    // whole-document string anywhere in the chain.
    expect(hydrated.evidence.map((item) => item.quote).sort()).toEqual(
      [DATE, TITLE].sort(),
    );
    expect(hydrated.sourceText).toBeUndefined();
    expect(hydrated.representation).toBe("parsed_pages_v1");
  });

  test("a card-staged span over a sealed parsed page publishes a prose field", async () => {
    const harness = await seedDocument("parsed_pages_v1");
    expect(cardStaged(await evidenceSpans(harness))).toEqual([]);

    const result = await runCardLadder({
      recordKind: "safe_note_card",
      document: harness.document,
      now: 12_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: safeNote() }),
        fixtureCardRunner({ step: "tier1", candidate: safeNote() }),
      ),
    });

    expect(result.outcome).toBe("accepted");
    expect(result.storedFields.sort()).toEqual([
      "company",
      "instrument_date",
      "investor_entity",
      "principal_amount",
    ]);
    const staged = cardStaged(await evidenceSpans(harness));
    expect(staged.length).toBe(2);
    const amountStart = PAGE_TWO.indexOf(AMOUNT);
    expect(
      staged.some(
        (row) =>
          row.start === amountStart && row.end === amountStart + AMOUNT.length,
      ),
    ).toBe(true);
  });

  test("a quote the sealed parsed page does not contain publishes nothing", async () => {
    const harness = await seedDocument("parsed_pages_v1");
    const result = await runCardLadder({
      recordKind: "safe_note_card",
      document: harness.document,
      now: 13_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({
          step: "tier0",
          candidate: safeNote({ amountSpan: span(1, "$999,999.00") }),
        }),
        fixtureCardRunner({
          step: "tier1",
          candidate: safeNote({ amountSpan: span(1, "$999,999.00") }),
        }),
      ),
    });

    expect(result.outcome).toBe("review");
    expect(await cardGenerations(harness, "safe_note_card")).toEqual([]);
    // Nothing unproved was stored, and the rejected steps left no span.
    expect(cardStaged(await evidenceSpans(harness))).toEqual([]);
  });

  test("a value the cited parsed page does not reproduce is refused by the gate", async () => {
    const harness = await seedDocument("parsed_pages_v1");
    const result = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 14_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: wrongGeneric() }),
        fixtureCardRunner({ step: "tier1", candidate: goodGeneric() }),
      ),
    });

    // The gate reads the quote out of the parsed page and refuses the wrong
    // title, then the correct step publishes. One generation, at tier 1.
    expect(result.outcome).toBe("accepted");
    expect(result.acceptedStep).toBe("tier1");
    const generations = await cardGenerations(harness, "document_card");
    expect(generations.length).toBe(1);
    expect(generations[0]!.recordSchemaFingerprint).toContain("tier:tier1");
  });

  test("a page whose stored text no longer hashes to its row refuses the card", async () => {
    const harness = await seedDocument("parsed_pages_v1");
    await harness.t.run(async (ctx) => {
      const page = (await ctx.db.query("sourcePages").collect()).find(
        (row) => row.ordinal === 0,
      )!;
      // The hash is what proves a parsed page, because there is no retained
      // whole-document string to slice it out of.
      await ctx.db.patch(page._id, { textHash: "0".repeat(64) });
    });
    const result = await runCardLadder({
      recordKind: "document_card",
      document: harness.document,
      now: 15_000,
      ops: opsFor(harness),
      runners: ladder(
        fixtureCardRunner({ step: "tier0", candidate: goodGeneric() }),
        fixtureCardRunner({ step: "tier1", candidate: goodGeneric() }),
      ),
    });
    expect(result.outcome).toBe("review");
    expect(await cardGenerations(harness, "document_card")).toEqual([]);
  });
});
