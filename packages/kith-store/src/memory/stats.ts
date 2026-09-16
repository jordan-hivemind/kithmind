// The thought space stats digest, ported from `_computeSpaceStats` in
// packages/convex/convex/models/thoughts/model.ts (P2-39i3).
//
// Question 4 of docs/plans/2026-09-16-web-mcp-postgres-surface.md asked whether
// to port this here or ship `get_stats` returning a typed unavailable result.
// The owner adopted the port: P2-39g2 landed the counters it reads
// (`readSpaceCounters` and `spaceEmbeddingCoverage` in `../embeddings/state.ts`)
// and left only the digest, which had no consumer until the MCP read tools
// moved.
//
// The shape of the answer is the counters' shape, not a scan's:
//
//   * A counted space contributes its totals from one space-state row. No
//     thought row is read for its counts.
//   * An uncounted space (`thoughtCounts === null`) keeps the legacy bounded
//     scan, and the scan runs for those spaces first, so a budget that binds
//     degrades the digest before it degrades a count.
//   * `byType`, `topTopics` and `topPeople` are the one remaining scan. It is
//     bounded and reported through `partial` when the bound binds.
//
// The fact half has no counters, so it is a bounded scan of `kith.facts` under
// its own larger bound: a fact row carries no vector, which is what made the
// thought bound small in the first place.
//
// `spaceIds` must already be the caller's membership-checked authorized set.

import {
  readSpaceCounters,
  type SpaceCounterReport,
  type SpaceEmbeddingCoverage,
} from "../embeddings/state.js";
import { rows, type IdentityCtx } from "../identity/db.js";
import { assertKithId } from "../ids.js";
import { isFactActive, type FactStatus } from "./facts.js";
import { isMemoryActive, type MemoryStatus } from "./lifecycle.js";
import type { ThoughtMetadata } from "./thoughts.js";

/**
 * Rows the `byType`, `topTopics` and `topPeople` digest may scan on a counted
 * space, and the wider bound an uncounted space's counts may scan. Both are
 * the Convex constants, unchanged: a thought row here no longer carries the
 * legacy 1,536-float vector, but the digest is replaced by a stored one in
 * P1-12 and widening the bound in the meantime would only move the cliff.
 */
export const MAX_STATS_DIGEST_ROWS = 128;
export const MAX_THOUGHT_STATS_ROWS = 10_000;
/** Fact rows carry no vector, so the fact scan keeps a far larger bound. */
export const MAX_STATS_FACT_ROWS = 4_096;
/** Digest entries returned for topics and people. */
const TOP_DIGEST_ENTRIES = 10;

export type SpaceStats = {
  totalThoughts: number;
  totalFacts: number;
  historicalThoughts: number;
  historicalFacts: number;
  retractedThoughts: number;
  retractedFacts: number;
  byType: Array<{ type: string; count: number }>;
  topTopics: Array<{ topic: string; count: number }>;
  topPeople: Array<{ person: string; count: number }>;
  /** True when a bound bound: the digest, and any uncounted space's counts. */
  partial: boolean;
  coverage: SpaceEmbeddingCoverage[];
  dateRange?: { earliest: number; latest: number };
};

export type SpaceStatsOptions = {
  maxDigestRows?: number;
  maxScanRows?: number;
  maxFactRows?: number;
};

function boundedStatsLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

type DigestRow = {
  space_id: string;
  created_at: Date;
  metadata: ThoughtMetadata;
  memory_status: MemoryStatus | null;
  valid_from: Date | null;
  valid_to: Date | null;
};

type FactCountRow = {
  status: FactStatus;
  valid_from: Date | null;
  valid_to: Date | null;
};

function toMs(value: Date | null): number | undefined {
  return value === null ? undefined : value.getTime();
}

/**
 * Statistics for a set of spaces the caller may already read.
 *
 * Ported from `_computeSpaceStats`. `ctx.now` replaces the Convex original's
 * injectable `now`: one timestamp for the whole transaction is the rule
 * `identity/db.ts` states, and it is what makes a validity comparison inside
 * this function agree with every other read in the same tool call.
 */
export async function computeSpaceStats(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  options: SpaceStatsOptions = {},
): Promise<SpaceStats> {
  const digestLimit = boundedStatsLimit(
    options.maxDigestRows ?? MAX_STATS_DIGEST_ROWS,
    "Thought digest limit",
  );
  const scanLimit = boundedStatsLimit(
    options.maxScanRows ?? MAX_THOUGHT_STATS_ROWS,
    "Thought statistics limit",
  );
  const factLimit = boundedStatsLimit(
    options.maxFactRows ?? MAX_STATS_FACT_ROWS,
    "Fact statistics limit",
  );
  const activeAt = ctx.now;
  // Every scan below is per space, the way the Convex original's per-space
  // index reads were, so the budget can be spent in the order the counters
  // decide. Each id is still a bind parameter and is validated here, so a
  // caller-supplied space that got this far as something other than an id is
  // refused rather than queried.
  for (const spaceId of spaceIds) assertKithId(spaceId, "invalid_space_id");

  const counters: SpaceCounterReport[] = [];
  for (const spaceId of spaceIds) {
    counters.push(await readSpaceCounters(ctx, spaceId));
  }
  const uncounted = new Set(
    spaceIds.filter((_, index) => counters[index]!.thoughtCounts === null),
  );

  let partial = false;
  let totalThoughts = 0;
  let historicalThoughts = 0;
  let retractedThoughts = 0;
  for (const report of counters) {
    const counts = report.thoughtCounts;
    if (!counts) continue;
    totalThoughts += counts.current;
    historicalThoughts += counts.superseded;
    retractedThoughts += counts.retracted;
  }

  // One scan serves the digest and, until the backfill lands, the counts of an
  // uncounted space. It is the only place stats touch a thought row.
  const thoughtBudget = uncounted.size > 0 ? scanLimit : digestLimit;
  const thoughts: DigestRow[] = [];
  // Uncounted spaces first: if the budget binds, a count degrades to a sample
  // only after every space that still needs the scan has been read.
  const scanOrder = [...spaceIds].sort(
    (left, right) =>
      Number(uncounted.has(right)) - Number(uncounted.has(left)),
  );
  for (const spaceId of scanOrder) {
    if (thoughts.length >= thoughtBudget) {
      partial = true;
      break;
    }
    const found = await rows<DigestRow>(
      ctx,
      `SELECT space_id, created_at, metadata, memory_status, valid_from, valid_to
         FROM kith.thoughts WHERE space_id = $1
        ORDER BY created_at, id LIMIT $2`,
      [spaceId, thoughtBudget + 1 - thoughts.length],
    );
    thoughts.push(...found);
    if (thoughts.length > thoughtBudget) {
      thoughts.length = thoughtBudget;
      partial = true;
      break;
    }
  }

  for (const thought of thoughts) {
    if (!uncounted.has(thought.space_id)) continue;
    const memory = {
      memoryStatus: thought.memory_status ?? undefined,
      validFrom: toMs(thought.valid_from),
      validTo: toMs(thought.valid_to),
    };
    if (isMemoryActive(memory, activeAt)) totalThoughts += 1;
    else if (thought.memory_status === "superseded") historicalThoughts += 1;
    else if (thought.memory_status === "retracted") retractedThoughts += 1;
  }

  const facts: FactCountRow[] = [];
  for (const spaceId of spaceIds) {
    if (facts.length >= factLimit) {
      partial = true;
      break;
    }
    const found = await rows<FactCountRow>(
      ctx,
      `SELECT status, valid_from, valid_to FROM kith.facts
        WHERE space_id = $1 ORDER BY created_at, id LIMIT $2`,
      [spaceId, factLimit + 1 - facts.length],
    );
    facts.push(...found);
    if (facts.length > factLimit) {
      facts.length = factLimit;
      partial = true;
      break;
    }
  }

  const currentThoughts = thoughts.filter((thought) =>
    isMemoryActive(
      {
        memoryStatus: thought.memory_status ?? undefined,
        validFrom: toMs(thought.valid_from),
        validTo: toMs(thought.valid_to),
      },
      activeAt,
    ),
  );
  const typeCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const peopleCounts = new Map<string, number>();
  for (const thought of currentThoughts) {
    const metadata = thought.metadata;
    typeCounts.set(metadata.type, (typeCounts.get(metadata.type) ?? 0) + 1);
    for (const topic of metadata.topics) {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
    for (const person of metadata.people) {
      peopleCounts.set(person, (peopleCounts.get(person) ?? 0) + 1);
    }
  }
  const factView = (fact: FactCountRow) => ({
    status: fact.status,
    validFrom: toMs(fact.valid_from),
    validTo: toMs(fact.valid_to),
  });

  return {
    totalThoughts,
    totalFacts: facts.filter((fact) => isFactActive(factView(fact), activeAt))
      .length,
    historicalThoughts,
    historicalFacts: facts.filter((fact) => fact.status === "superseded")
      .length,
    retractedThoughts,
    retractedFacts: facts.filter((fact) => fact.status === "retracted").length,
    byType: [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
    topTopics: [...topicCounts.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.topic.localeCompare(right.topic),
      )
      .slice(0, TOP_DIGEST_ENTRIES),
    topPeople: [...peopleCounts.entries()]
      .map(([person, count]) => ({ person, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.person.localeCompare(right.person),
      )
      .slice(0, TOP_DIGEST_ENTRIES),
    partial,
    coverage: counters.map((report) => report.coverage),
    ...(currentThoughts.length > 0
      ? {
          dateRange: {
            earliest: Math.min(
              ...currentThoughts.map((thought) => thought.created_at.getTime()),
            ),
            latest: Math.max(
              ...currentThoughts.map((thought) => thought.created_at.getTime()),
            ),
          },
        }
      : {}),
  };
}
