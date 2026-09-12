import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
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
} from "./cardLadder";
import { publishDocumentCard } from "./cards";
import {
  CARD_PROMPT_VERSION,
  fixtureCardRunner,
  localCardRunner,
  type CardRunnerCandidate,
} from "./cardRunner";
import {
  claimNextForExtraction,
  recordExtractionOutcome,
  runCardExtractionQueueTick,
  type QueueTickOps,
  type QueueTickResult,
} from "./cardQueue";

// Synthetic fixture only. Every document is a one-page, one-sentence note
// carrying nothing but its own title. No test in this file calls a model or
// the hosted runner: every ladder run below goes through `fixtureCardRunner`,
// exactly as PR140 (cardLadder.test.ts) does.

const FINGERPRINT = {
  cardSchemaVersion: 1,
  playbookVersion: CARD_PLAYBOOK_VERSION,
  promptVersion: CARD_PROMPT_VERSION,
};

const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed Monday 00:00 UTC so day/week window math in the test is exact.
const MONDAY = Date.UTC(2026, 8, 7);

type T = ReturnType<typeof convexTest>;

async function seedSpace(t: T) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic queue",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:queue-subject",
      kind: "person",
      canonicalName: "Synthetic Subject",
      normalizedName: "synthetic subject",
      aliases: [],
      normalizedAliases: [],
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "synthetic-queue",
      name: "Synthetic queue",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 1_000_000,
      createdBy: userId,
      subjectEntityId: entityId,
    });
    return { userId, spaceId, sourceAccountId };
  });
}

/** One admitted document with retained text: a single page holding its own title. */
async function seedItem(
  t: T,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    userId: Id<"users">;
    index: number;
  },
): Promise<Id<"sourceItems">> {
  const title = `Synthetic Document ${input.index}`;
  return await t.run(async (ctx) => {
    const sourceItem = await createOrGetSourceItem(ctx, {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      externalId: `synthetic://queue/${input.index}`,
    });
    const revision = await createOrGetRevision(ctx, {
      spaceId: input.spaceId,
      sourceItemId: sourceItem._id,
      mediaType: "text/plain",
      inlineText: title,
      capturedAt: 1_700_000_000_000 + input.index,
      userId: input.userId,
    });
    const textVersion = await createOrGetTextVersion(ctx, {
      spaceId: input.spaceId,
      sourceRevisionId: revision._id,
      extractionFingerprint: "plain:v1",
      text: title,
    });
    await stagePages(ctx, {
      spaceId: input.spaceId,
      sourceTextVersionId: textVersion._id,
      pages: [{ ordinal: 0, start: 0, end: title.length, text: title }],
    });
    // Evidence spans are staged lazily by the ladder itself (P2-70e2), so
    // none are pre-staged here.
    const processingGenerationId = await ctx.db.insert("processingGenerations", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      sourceItemId: sourceItem._id,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      processingFingerprint: `queue-base:${input.index}`,
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
      expectedDocumentCount: 1,
      expectedChunkCount: 0,
      expectedEventCount: 0,
      expectedObservationCount: 0,
      actualPageCount: 1,
      actualEvidenceSpanCount: 0,
      actualDocumentCount: 1,
      actualChunkCount: 0,
      embeddingStatus: "unavailable",
      activatedAt: 100,
    });
    await ctx.db.patch(textVersion._id, { evidenceSealed: true });
    await ctx.db.patch(sourceItem._id, {
      desiredRevisionId: revision._id,
      activeRevisionId: revision._id,
      activeGenerationId: processingGenerationId,
    });
    return sourceItem._id;
  });
}

async function seedItems(
  t: T,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    userId: Id<"users">;
    count: number;
  },
): Promise<Id<"sourceItems">[]> {
  const ids: Id<"sourceItems">[] = [];
  for (let index = 0; index < input.count; index += 1) {
    ids.push(await seedItem(t, { ...input, index }));
  }
  return ids;
}

async function startQueue(
  t: T,
  input: {
    spaceId: Id<"spaces">;
    dailyDocumentBudget?: number;
    weeklyDocumentBudget?: number;
    weeklyCostBudgetMicroUsd?: number;
    now?: number;
  },
) {
  return await t.mutation(internal.models.records.cardQueue.startExtractionQueue, {
    spaceId: input.spaceId,
    kind: "document_card",
    dailyDocumentBudget: input.dailyDocumentBudget,
    weeklyDocumentBudget: input.weeklyDocumentBudget,
    weeklyCostBudgetMicroUsd: input.weeklyCostBudgetMicroUsd,
    now: input.now ?? MONDAY,
  });
}

/**
 * Builds one tick's ops from the fixture runner, exactly as
 * `cardLadder.test.ts` builds `CardLadderOps`, wired through the queue's
 * plain `claim` / `recordOutcome` mutations instead of a harness's own doc.
 */
function tickOps(input: {
  t: T;
  spaceId: Id<"spaces">;
  userId: Id<"users">;
  now: number;
  wrong?: boolean;
  costMicroUsd?: number;
  onLadderCall?: (sourceItemId: Id<"sourceItems">) => void;
}): QueueTickOps {
  const { t, spaceId, userId, now } = input;
  const kind = "document_card" as const;
  return {
    claim: () => t.run((ctx) => claimNextForExtraction(ctx, { spaceId, kind, now })),
    runLadder: async (sourceItemId) => {
      input.onLadderCall?.(sourceItemId);
      const loaded = await t.run((ctx) => loadCardExtractionDocument(ctx, sourceItemId));
      if (loaded.status !== "ready") {
        throw new Error(`fixture document did not load: ${loaded.code}`);
      }
      const document = loaded.document;
      const title = document.pages[0]!.text;
      const candidate = (value: string): CardRunnerCandidate => ({
        anchor: [{ pageOrdinal: 0, quote: title }],
        fields: [
          {
            field: "card_title",
            value: { type: "text", value },
            spans: [{ pageOrdinal: 0, quote: title }],
          },
        ],
      });
      const chosen = input.wrong ? candidate(`${title} (wrong)`) : candidate(title);
      const usage =
        input.costMicroUsd === undefined ? undefined : { costMicroUsd: input.costMicroUsd };
      const result = await runCardLadder({
        recordKind: kind,
        document,
        now,
        ops: {
          stageEvidence: (ladderInput) =>
            t.mutation(internal.models.records.cards.stageCardEvidence, {
              sourceItemId,
              recordKind: ladderInput.recordKind,
              fingerprint: { ...FINGERPRINT, tier: ladderInput.step },
              refs: ladderInput.refs.map(toStagingRef),
            }),
          sweepEvidence: async () => {
            await t.mutation(internal.models.records.cards.sweepCardEvidence, {
              sourceItemId,
            });
          },
          publish: (ladderInput) =>
            t.run((ctx) =>
              publishDocumentCard(ctx, {
                spaceId,
                sourceItemId,
                userId,
                recordKind: ladderInput.recordKind,
                now: ladderInput.now,
                fingerprint: { ...FINGERPRINT, tier: ladderInput.step },
                anchorEvidenceSpanIds: ladderInput.anchorEvidenceSpanIds,
                fields: ladderInput.fields,
                runner: ladderInput.runner,
              }),
            ),
          recordSkip: async (ladderInput) => {
            await t.mutation(internal.models.records.cards.recordSkippedCardAttempt, {
              sourceItemId,
              recordKind: ladderInput.recordKind,
              step: ladderInput.step,
              modelId: ladderInput.modelId,
              fingerprint: { ...FINGERPRINT, tier: ladderInput.step },
              now: ladderInput.now,
            });
          },
        },
        runners: [
          localCardRunner(),
          fixtureCardRunner({ step: "tier0", candidate: chosen, usage }),
          fixtureCardRunner({ step: "tier1", candidate: chosen, usage }),
        ],
      });
      return { outcome: result.outcome };
    },
    recordOutcome: (outcomeInput) =>
      t.run((ctx) =>
        recordExtractionOutcome(ctx, { spaceId, kind, now, ...outcomeInput }),
      ),
  };
}

async function runUntilStopped(
  makeOps: () => QueueTickOps,
  maxTicks = 500,
): Promise<QueueTickResult[]> {
  const results: QueueTickResult[] = [];
  for (let i = 0; i < maxTicks; i += 1) {
    const result = await runCardExtractionQueueTick(makeOps());
    results.push(result);
    if (!result.continue) return results;
  }
  throw new Error("queue did not stop within the tick cap");
}

async function acceptedCardCount(t: T, spaceId: Id<"spaces">): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("processingGenerations")
      .collect();
    return rows.filter(
      (row) => row.spaceId === spaceId && row.cardGeneration === true,
    ).length;
  });
}

describe("the card extraction queue", () => {
  test("a daily budget of 10 over 25 documents extracts exactly 10, then pauses", async () => {
    const t = convexTest(schema, modules);
    const { userId, spaceId, sourceAccountId } = await seedSpace(t);
    await seedItems(t, { spaceId, sourceAccountId, userId, count: 25 });
    await startQueue(t, { spaceId, dailyDocumentBudget: 10, weeklyDocumentBudget: 100 });

    const results = await runUntilStopped(() =>
      tickOps({ t, spaceId, userId, now: MONDAY }),
    );
    const claimed = results.filter((r) => r.status === "claimed");
    expect(claimed.length).toBe(10);
    expect(results.at(-1)).toEqual({ status: "paused", continue: false });

    const status = await t.query(
      internal.models.records.cardQueue.cardExtractionQueueStatus,
      { spaceId, kind: "document_card" },
    );
    expect(status).toMatchObject({
      phase: "paused",
      pauseReason: "daily_document_budget",
      extracted: 10,
      documentsProcessedToday: 10,
    });
    expect(status.resumeAt).toBe(MONDAY + DAY_MS);
    expect(await acceptedCardCount(t, spaceId)).toBe(10);
  });

  test("resuming after the day boundary extracts the next 10", async () => {
    const t = convexTest(schema, modules);
    const { userId, spaceId, sourceAccountId } = await seedSpace(t);
    await seedItems(t, { spaceId, sourceAccountId, userId, count: 25 });
    await startQueue(t, { spaceId, dailyDocumentBudget: 10, weeklyDocumentBudget: 100 });

    await runUntilStopped(() => tickOps({ t, spaceId, userId, now: MONDAY }));
    const nextDay = MONDAY + DAY_MS;
    const results = await runUntilStopped(() =>
      tickOps({ t, spaceId, userId, now: nextDay }),
    );
    const claimed = results.filter((r) => r.status === "claimed");
    expect(claimed.length).toBe(10);

    const status = await t.query(
      internal.models.records.cardQueue.cardExtractionQueueStatus,
      { spaceId, kind: "document_card" },
    );
    expect(status.extracted).toBe(20);
    expect(status.documentsProcessedToday).toBe(10);
    expect(await acceptedCardCount(t, spaceId)).toBe(20);
  });

  test("a kill between claim and recorded outcome never re-extracts the killed document", async () => {
    const t = convexTest(schema, modules);
    const { userId, spaceId, sourceAccountId } = await seedSpace(t);
    await seedItems(t, { spaceId, sourceAccountId, userId, count: 5 });
    await startQueue(t, { spaceId, dailyDocumentBudget: 100, weeklyDocumentBudget: 100 });

    // Tick 1: a normal, fully recorded extraction.
    const first = await runCardExtractionQueueTick(
      tickOps({ t, spaceId, userId, now: MONDAY }),
    );
    expect(first).toEqual({ status: "claimed", continue: true });

    // Tick 2: claim and run the ladder, but simulate a kill by never calling
    // recordOutcome. The card is already accepted in the store; the queue's
    // own cursor and counters never learn about it.
    const claim = await t.run((ctx) =>
      claimNextForExtraction(ctx, {
        spaceId,
        kind: "document_card",
        now: MONDAY,
      }),
    );
    if (claim.status !== "claimed") throw new Error("expected a claim");
    const opsForKilled = tickOps({ t, spaceId, userId, now: MONDAY });
    await opsForKilled.runLadder(claim.sourceItemId);
    // recordOutcome deliberately not called: this is the simulated kill.

    // Replay: a fresh tick loop from the top. The killed document must be
    // recognized as already accepted and never re-run through the ladder.
    const ladderCallsOnReplay: Id<"sourceItems">[] = [];
    const results = await runUntilStopped(() =>
      tickOps({
        t,
        spaceId,
        userId,
        now: MONDAY,
        onLadderCall: (id) => ladderCallsOnReplay.push(id),
      }),
    );
    expect(ladderCallsOnReplay).not.toContain(claim.sourceItemId);
    expect(results.filter((r) => r.status === "claimed").length).toBe(3); // the 3 remaining, untouched documents

    // Every one of the 5 documents has exactly one accepted card: the killed
    // document is never extracted twice, and every other document exactly once.
    expect(await acceptedCardCount(t, spaceId)).toBe(5);
  });

  test("an already accepted card is skipped without ever calling the ladder", async () => {
    const t = convexTest(schema, modules);
    const { userId, spaceId, sourceAccountId } = await seedSpace(t);
    const [first, second] = await seedItems(t, {
      spaceId,
      sourceAccountId,
      userId,
      count: 2,
    });

    // Publish an accepted card for the first document out of band, as if it
    // had been extracted before this queue instance ever started.
    const loadedFirst = await t.run((ctx) => loadCardExtractionDocument(ctx, first!));
    if (loadedFirst.status !== "ready") throw new Error("fixture not ready");
    const firstTitle = loadedFirst.document.pages[0]!.text;
    const [firstSpanId] = await t.mutation(
      internal.models.records.cards.stageCardEvidence,
      {
        sourceItemId: first!,
        recordKind: "document_card",
        fingerprint: { ...FINGERPRINT, tier: "tier0" },
        refs: [{ pageOrdinal: 0, quote: firstTitle }],
      },
    );
    if (!firstSpanId) throw new Error("fixture span did not stage");
    await t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId,
        sourceItemId: first!,
        userId,
        recordKind: "document_card",
        now: 500,
        fingerprint: { ...FINGERPRINT, tier: "tier0" },
        anchorEvidenceSpanIds: [firstSpanId],
        fields: [
          {
            field: "card_title",
            value: { type: "text", value: firstTitle },
            evidenceSpanIds: [firstSpanId],
          },
        ],
      }),
    );

    await startQueue(t, { spaceId });
    const ladderCalls: Id<"sourceItems">[] = [];
    const results = await runUntilStopped(() =>
      tickOps({ t, spaceId, userId, now: MONDAY, onLadderCall: (id) => ladderCalls.push(id) }),
    );
    expect(ladderCalls).toEqual([second]);
    expect(results.map((r) => r.status)).toEqual(["advanced", "claimed", "idle"]);
  });

  test("a gate-failed document is not retried by the queue", async () => {
    const t = convexTest(schema, modules);
    const { userId, spaceId, sourceAccountId } = await seedSpace(t);
    const [gateFailed, healthy] = await seedItems(t, {
      spaceId,
      sourceAccountId,
      userId,
      count: 2,
    });
    await startQueue(t, { spaceId });

    const first = await runCardExtractionQueueTick(
      tickOps({ t, spaceId, userId, now: MONDAY, wrong: true }),
    );
    expect(first).toEqual({ status: "claimed", continue: true });
    const status1 = await t.query(
      internal.models.records.cardQueue.cardExtractionQueueStatus,
      { spaceId, kind: "document_card" },
    );
    expect(status1.gateFailed).toBe(1);

    const ladderCalls: Id<"sourceItems">[] = [];
    const rest = await runUntilStopped(() =>
      tickOps({ t, spaceId, userId, now: MONDAY, onLadderCall: (id) => ladderCalls.push(id) }),
    );
    expect(ladderCalls).toEqual([healthy]);
    expect(ladderCalls).not.toContain(gateFailed);
    expect(rest.filter((r) => r.status === "claimed").length).toBe(1);

    const drops = await t.run((ctx) => ctx.db.query("cardFieldDrops").collect());
    expect(drops.filter((d) => d.kind === "card_gate_failed").length).toBe(1);
  });

  test("the weekly cost budget pauses once it is reached", async () => {
    const t = convexTest(schema, modules);
    const { userId, spaceId, sourceAccountId } = await seedSpace(t);
    await seedItems(t, { spaceId, sourceAccountId, userId, count: 5 });
    await startQueue(t, {
      spaceId,
      dailyDocumentBudget: 100,
      weeklyDocumentBudget: 100,
      // Less than one document's cost, so the budget check (which runs
      // before every document) allows exactly one over-budget document
      // through and then pauses: never more than one document over budget.
      weeklyCostBudgetMicroUsd: 10_000_000,
    });

    const results = await runUntilStopped(() =>
      tickOps({ t, spaceId, userId, now: MONDAY, costMicroUsd: 20_000_000 }),
    );
    expect(results.filter((r) => r.status === "claimed").length).toBe(1);
    expect(results.at(-1)).toEqual({ status: "paused", continue: false });

    const status = await t.query(
      internal.models.records.cardQueue.cardExtractionQueueStatus,
      { spaceId, kind: "document_card" },
    );
    expect(status.pauseReason).toBe("weekly_cost_budget");
    expect(status.costMicroUsdThisWeek).toBe(20_000_000);
  });

  test("pause and resume are operator controlled", async () => {
    const t = convexTest(schema, modules);
    const { userId, spaceId, sourceAccountId } = await seedSpace(t);
    await seedItems(t, { spaceId, sourceAccountId, userId, count: 2 });
    await startQueue(t, { spaceId });

    await t.mutation(internal.models.records.cardQueue.pauseExtractionQueue, {
      spaceId,
      kind: "document_card",
      now: MONDAY,
    });
    const claimWhilePaused = await t.run((ctx) =>
      claimNextForExtraction(ctx, { spaceId, kind: "document_card", now: MONDAY }),
    );
    expect(claimWhilePaused).toEqual({
      status: "paused",
      reason: "manual",
      resumeAt: undefined,
    });

    await t.mutation(internal.models.records.cardQueue.resumeExtractionQueue, {
      spaceId,
      kind: "document_card",
      now: MONDAY,
    });
    const results = await runUntilStopped(() =>
      tickOps({ t, spaceId, userId, now: MONDAY }),
    );
    expect(results.filter((r) => r.status === "claimed").length).toBe(2);
  });

  test("a dry run reports counts and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { userId, spaceId, sourceAccountId } = await seedSpace(t);
    await seedItems(t, { spaceId, sourceAccountId, userId, count: 3 });

    const preview = await t.mutation(
      internal.models.records.cardQueue.startExtractionQueue,
      { spaceId, kind: "document_card", dryRun: true, now: MONDAY },
    );
    expect(preview).toEqual({ queued: 3, queuedIsLowerBound: false });

    const rows = await t.run((ctx) =>
      ctx.db.query("cardExtractionQueueStates").collect(),
    );
    expect(rows).toEqual([]);
  });
});
