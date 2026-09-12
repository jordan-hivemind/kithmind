import { renderSheetPage, resolveSheetCell } from "@repo/worker-protocol";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
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
  toStagingRef,
  type CardLadderOps,
} from "./cardLadder";
import { CARD_PROMPT_VERSION, fixtureCardRunner } from "./cardRunner";
import type { CardRunnerCandidate } from "./cardRunner";
import { canonicalizeDecimal } from "./values";

/**
 * P2-70i: docs/plans/2026-09-12-document-cards.md sections 4.2, 4.3 and
 * 11/12. The workbook below is synthetic and is rendered here with the same
 * `renderSheetPage` rule the worker's spreadsheet reader uses, so the pages
 * this test seals are exactly the pages a real extraction would seal. No real
 * account, balance or person is described.
 *
 * What this proves is the acceptance line: a cited cell resolves to the
 * retained page slice, and the span it becomes carries a locator naming the
 * sheet, row and column.
 */

const FINGERPRINT = {
  cardSchemaVersion: 1,
  playbookVersion: CARD_PLAYBOOK_VERSION,
  promptVersion: CARD_PROMPT_VERSION,
};

/**
 * Two sheets: a header row, a totals row whose figure is a formula's cached
 * value, and an empty cell that keeps its column in place rather than
 * shifting the cells after it.
 */
const REVENUE = renderSheetPage({
  name: "Revenue",
  columnCount: 3,
  rows: [
    ["Quarter", "Region", "Amount"],
    ["Q1", "North", "1250.00"],
    ["Q2", "", "980.50"],
    ["Total", "", "2230.50"],
  ],
});

const NOTES = renderSheetPage({
  name: "Notes",
  columnCount: 2,
  rows: [
    ["Line", "Note"],
    ["1", "Budget approved"],
  ],
});

function cell(pageOrdinal: number, sheet: string, row: number, column: number) {
  return { pageOrdinal, cell: { sheet, row, column } };
}

function quote(pageOrdinal: number, text: string) {
  return { pageOrdinal, quote: text };
}

function decimal(value: string) {
  return {
    type: "decimal" as const,
    value: canonicalizeDecimal(value),
    unitCode: "1",
  };
}

function text(value: string) {
  return { type: "text" as const, value };
}

/** Every field cited by a cell locator or by the sheet-name line above it. */
function spreadsheetCandidate(): CardRunnerCandidate {
  return {
    anchor: [quote(0, "Revenue")],
    fields: [
      {
        field: "sheet_name",
        ordinal: 0,
        value: text("Revenue"),
        spans: [quote(0, "Revenue")],
      },
      {
        field: "sheet_name",
        ordinal: 1,
        value: text("Notes"),
        spans: [quote(1, "Notes")],
      },
      {
        field: "column_header",
        ordinal: 0,
        value: text("Quarter"),
        spans: [cell(0, "Revenue", 0, 0)],
      },
      {
        field: "column_header",
        ordinal: 1,
        value: text("Region"),
        spans: [cell(0, "Revenue", 0, 1)],
      },
      {
        field: "column_header",
        ordinal: 2,
        value: text("Amount"),
        spans: [cell(0, "Revenue", 0, 2)],
      },
      {
        field: "sheet_total_label",
        ordinal: 0,
        value: text("Total"),
        spans: [cell(0, "Revenue", 3, 0)],
      },
      {
        field: "sheet_total",
        ordinal: 0,
        value: decimal("2230.50"),
        spans: [cell(0, "Revenue", 3, 2)],
      },
    ],
  };
}

// --- harness --------------------------------------------------------------

async function seedWorkbook() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic workbook corpus",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:workbook-subject",
      kind: "person",
      canonicalName: "Synthetic Owner",
      normalizedName: "synthetic owner",
      aliases: [],
      normalizedAliases: [],
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "synthetic-workbook-corpus",
      name: "Synthetic workbook corpus",
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

    // One page per sheet, contiguous over the text version, exactly as the
    // parsed-pages path lays a multi-page document out.
    const pageTexts = [REVENUE, NOTES];
    const full = pageTexts.join("");
    const sourceItem = await createOrGetSourceItem(ctx, {
      spaceId,
      sourceAccountId,
      externalId: "fs://synthetic/workbook.xlsx",
    });
    const revision = await createOrGetRevision(ctx, {
      spaceId,
      sourceItemId: sourceItem._id,
      mediaType: "text/plain",
      inlineText: full,
      capturedAt: 1_700_000_000_000,
      userId,
    });
    const textVersion = await createOrGetTextVersion(ctx, {
      spaceId,
      sourceRevisionId: revision._id,
      extractionFingerprint: "sheet_page_v1",
      text: full,
    });
    let offset = 0;
    const pages = pageTexts.map((pageText, ordinal) => {
      const page = {
        ordinal,
        start: offset,
        end: offset + pageText.length,
        text: pageText,
      };
      offset += pageText.length;
      return page;
    });
    await stagePages(ctx, {
      spaceId,
      sourceTextVersionId: textVersion._id,
      pages,
    });
    const processingGenerationId = await ctx.db.insert(
      "processingGenerations",
      {
        spaceId,
        sourceAccountId,
        sourceItemId: sourceItem._id,
        sourceRevisionId: revision._id,
        sourceTextVersionId: textVersion._id,
        processingFingerprint: "base:workbook",
        extractionFingerprint: "sheet_page_v1",
        extractorFingerprint: "synthetic:v1",
        recordSchemaFingerprint: "records:v1",
        normalizationFingerprint: "exact:v1",
        chunkerFingerprint: "none:v1",
        correctionRevision: "one",
        desiredProcessingEpoch: 1,
        state: "ready",
        expectedPageCount: 2,
        expectedEvidenceSpanCount: 0,
        expectedDocumentCount: 0,
        expectedChunkCount: 0,
        expectedEventCount: 0,
        expectedObservationCount: 0,
        actualPageCount: 2,
        actualEvidenceSpanCount: 0,
        actualDocumentCount: 0,
        actualChunkCount: 0,
        embeddingStatus: "unavailable" as const,
        activatedAt: 100,
      },
    );
    await ctx.db.patch(textVersion._id, { evidenceSealed: true });
    await ctx.db.patch(sourceItem._id, {
      desiredRevisionId: revision._id,
      activeRevisionId: revision._id,
      activeGenerationId: processingGenerationId,
    });
    return { userId, spaceId, sourceAccountId, sourceItemId: sourceItem._id };
  });
  return { t, ...seeded };
}

type Harness = Awaited<ReturnType<typeof seedWorkbook>>;

function opsFor(harness: Harness): CardLadderOps {
  const sourceItemId = harness.sourceItemId;
  return {
    stageEvidence: async (input) =>
      await harness.t.mutation(
        internal.models.records.cards.stageCardEvidence,
        {
          sourceItemId,
          recordKind: input.recordKind,
          fingerprint: { ...FINGERPRINT, tier: input.step },
          refs: input.refs.map(toStagingRef),
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

async function publish(
  harness: Harness,
  candidate: CardRunnerCandidate,
  now: number,
) {
  const loaded = await harness.t.run((ctx) =>
    loadCardExtractionDocument(ctx, harness.sourceItemId),
  );
  if (loaded.status !== "ready") {
    throw new Error(`fixture did not load: ${loaded.code}`);
  }
  return await runCardLadder({
    recordKind: "spreadsheet_card",
    document: loaded.document,
    now,
    ops: opsFor(harness),
    runners: [fixtureCardRunner({ step: "tier0", candidate })],
  });
}

async function spansOf(harness: Harness) {
  return await harness.t.run(async (ctx) => {
    const spans = await ctx.db.query("evidenceSpans").collect();
    const pages = await ctx.db.query("sourcePages").collect();
    return spans.map((span) => {
      const page = pages.find((row) => row._id === span.sourcePageId)!;
      return {
        locator: span.locator,
        pageOrdinal: page.ordinal,
        quote: page.text.slice(span.start, span.end),
      };
    });
  });
}

describe("the spreadsheet card and the cell locator", () => {
  test("the retained pages are one per sheet, laid out by the shared rule", () => {
    expect(REVENUE).toBe(
      [
        "Revenue",
        "Quarter\tRegion\tAmount",
        "Q1\tNorth\t1250.00",
        "Q2\t\t980.50",
        "Total\t\t2230.50",
      ].join("\n"),
    );
    expect(NOTES).toBe(
      ["Notes", "Line\tNote", "1\tBudget approved"].join("\n"),
    );
  });

  test("every cell-cited field publishes, and its span names sheet, row and column", async () => {
    const harness = await seedWorkbook();
    const result = await publish(harness, spreadsheetCandidate(), 1_000);

    expect(result.outcome).toBe("accepted");
    expect(result.storedFields.sort()).toEqual(
      [
        "sheet_name:0",
        "sheet_name:1",
        "column_header:0",
        "column_header:1",
        "column_header:2",
        "sheet_total_label:0",
        "sheet_total:0",
      ].sort(),
    );

    const spans = await spansOf(harness);
    const cells = spans.filter((span) => span.locator?.kind === "cell_v1");
    expect(
      cells
        .map((span) => ({
          ...(span.locator as {
            sheet: string;
            row: number;
            column: number;
          }),
          quote: span.quote,
        }))
        .sort(
          (left, right) => left.row - right.row || left.column - right.column,
        ),
    ).toEqual([
      {
        kind: "cell_v1",
        sheet: "Revenue",
        row: 0,
        column: 0,
        quote: "Quarter",
      },
      { kind: "cell_v1", sheet: "Revenue", row: 0, column: 1, quote: "Region" },
      { kind: "cell_v1", sheet: "Revenue", row: 0, column: 2, quote: "Amount" },
      { kind: "cell_v1", sheet: "Revenue", row: 3, column: 0, quote: "Total" },
      {
        kind: "cell_v1",
        sheet: "Revenue",
        row: 3,
        column: 2,
        quote: "2230.50",
      },
    ]);

    // The locator names a position; the span is still the proof. Every cited
    // cell resolves to exactly the slice the shared rule computes.
    for (const span of cells) {
      const locator = span.locator as {
        sheet: string;
        row: number;
        column: number;
      };
      const range = resolveSheetCell(REVENUE, locator)!;
      expect(REVENUE.slice(range.start, range.end)).toBe(span.quote);
    }
  });

  test("the stored total reads back with its cell citation", async () => {
    const harness = await seedWorkbook();
    await publish(harness, spreadsheetCandidate(), 1_000);

    const stored = await harness.t.run(async (ctx) => {
      const observations = await ctx.db.query("observations").collect();
      return observations.find(
        (row) => row.observationKey === "sheet_total:0",
      )!;
    });
    expect(stored.value).toEqual({
      type: "decimal",
      value: canonicalizeDecimal("2230.50"),
      unitCode: "1",
    });
    expect(stored.valueEvidence.length).toBe(1);
  });

  test("a cell the page does not hold stages no span and drops its field", async () => {
    const harness = await seedWorkbook();
    const candidate = spreadsheetCandidate();
    // Row 99 does not exist, the second sheet is not on page 0, and the empty
    // cell at (2, 1) proves nothing. None of the three may resolve.
    candidate.fields = candidate.fields.map((field) =>
      field.field === "sheet_total" || field.field === "sheet_total_label"
        ? { ...field, spans: [cell(0, "Revenue", 99, 2)] }
        : field,
    );
    const result = await publish(harness, candidate, 2_000);

    expect(result.outcome).toBe("accepted");
    expect(result.storedFields.sort()).toEqual(
      [
        "sheet_name:0",
        "sheet_name:1",
        "column_header:0",
        "column_header:1",
        "column_header:2",
      ].sort(),
    );
    const drops = await harness.t.run(
      async (ctx) => await ctx.db.query("cardFieldDrops").collect(),
    );
    expect(
      drops
        .map((row) => [row.fieldKey, row.code])
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    ).toEqual([
      ["sheet_total_label:0", "evidence_missing"],
      ["sheet_total:0", "evidence_missing"],
    ]);
    expect(
      (await spansOf(harness)).some(
        (span) => span.locator?.kind === "cell_v1" && span.locator.row === 99,
      ),
    ).toBe(false);
  });

  test("a cell naming the wrong sheet, or an empty one, resolves to nothing", async () => {
    const harness = await seedWorkbook();
    const staged = await harness.t.mutation(
      internal.models.records.cards.stageCardEvidence,
      {
        sourceItemId: harness.sourceItemId,
        recordKind: "spreadsheet_card",
        fingerprint: { ...FINGERPRINT, tier: "tier0" as const },
        refs: [
          // The sheet name does not match the page the ref names.
          { pageOrdinal: 0, cell: { sheet: "Notes", row: 0, column: 0 } },
          // The empty cell: a zero-length range is not a citation.
          { pageOrdinal: 0, cell: { sheet: "Revenue", row: 2, column: 1 } },
          // A column past the row's width.
          { pageOrdinal: 0, cell: { sheet: "Revenue", row: 0, column: 9 } },
          // A page the text version does not have.
          { pageOrdinal: 7, cell: { sheet: "Revenue", row: 0, column: 0 } },
          // And one that does resolve, so the batch is not vacuously null.
          { pageOrdinal: 1, cell: { sheet: "Notes", row: 1, column: 1 } },
        ],
      },
    );
    expect(staged.slice(0, 4)).toEqual([null, null, null, null]);
    expect(staged[4]).not.toBeNull();

    const resolved = (await spansOf(harness)).find(
      (span) => span.locator?.kind === "cell_v1",
    )!;
    expect(resolved.quote).toBe("Budget approved");
    expect(resolved.locator).toEqual({
      kind: "cell_v1",
      sheet: "Notes",
      row: 1,
      column: 1,
    });
  });
});
