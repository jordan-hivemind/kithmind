import { getDocumentSize, type Value } from "convex/values";

import type { Doc, Id, TableNames } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

const MIB = 1_024 * 1_024;
export const MAX_PAYLOAD_READ_BYTES = 8 * MIB;
export const PAYLOAD_READ_HEADROOM_BYTES = MIB;
const MAX_CONVEX_DOCUMENT_BYTES = MIB;
const MAX_POINT_READS = 1_024;

type ReadContext = Pick<QueryCtx, "db" | "meta">;
type Metric = { used: number; remaining: number };
type ReadMetrics = {
  bytesRead: Metric;
  documentsRead: Metric;
  databaseQueries: Metric;
};

export class PayloadBudgetError extends Error {
  constructor() {
    super("Payload read budget is unavailable or exceeded");
    this.name = "PayloadBudgetError";
  }
}

function fail(): never {
  throw new PayloadBudgetError();
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function metric(value: unknown): Metric {
  if (typeof value !== "object" || value === null) fail();
  const row = value as Record<string, unknown>;
  if (
    !integer(row.used) ||
    !integer(row.remaining) ||
    !Number.isSafeInteger(row.used + row.remaining)
  )
    fail();
  return { used: row.used, remaining: row.remaining };
}

async function metrics(ctx: ReadContext): Promise<ReadMetrics> {
  let raw: unknown;
  try {
    raw = await ctx.meta.getTransactionMetrics();
  } catch {
    fail();
  }
  if (typeof raw !== "object" || raw === null) fail();
  const row = raw as Record<string, unknown>;
  return {
    bytesRead: metric(row.bytesRead),
    documentsRead: metric(row.documentsRead),
    databaseQueries: metric(row.databaseQueries),
  };
}

/** Includes Convex serialization and system fields, rather than JSON length. */
export function boundedDocumentSize(
  row: Record<string, Value>,
  maximumBytes: number,
): number {
  if (!integer(maximumBytes) || maximumBytes < 1 || maximumBytes > MIB) fail();
  let bytes: number;
  try {
    bytes = getDocumentSize(row);
  } catch {
    fail();
  }
  if (!integer(bytes) || bytes < 1 || bytes > maximumBytes) fail();
  return bytes;
}

/**
 * One sequential reader per validation transaction. This performs no writes
 * and does not establish authorization, parentage, or manifest correctness.
 * Callers must finish those checks before publishing any generation.
 */
export class PayloadReadBudget {
  private previous: ReadMetrics | undefined;
  private pending = false;
  private reads = 0;
  private hydratedBytes = 0;
  private failed = false;

  constructor(private readonly ctx: ReadContext) {}

  private async check(beforeRead: boolean): Promise<ReadMetrics> {
    const next = await metrics(this.ctx);
    for (const key of [
      "bytesRead",
      "documentsRead",
      "databaseQueries",
    ] as const) {
      if (
        this.previous &&
        (next[key].used < this.previous[key].used ||
          next[key].used + next[key].remaining !==
            this.previous[key].used + this.previous[key].remaining)
      )
        fail();
    }
    // A corrupt stored row may exceed its manifest declaration. Reserve room
    // for a full platform-sized document as well as the application headroom.
    const requiredHeadroom =
      PAYLOAD_READ_HEADROOM_BYTES +
      (beforeRead ? MAX_CONVEX_DOCUMENT_BYTES : 0);
    if (
      next.bytesRead.remaining < requiredHeadroom ||
      next.bytesRead.used > MAX_PAYLOAD_READ_BYTES ||
      (beforeRead &&
        (next.documentsRead.remaining < 1 ||
          next.databaseQueries.remaining < 1))
    )
      fail();
    this.previous = next;
    return next;
  }

  async read<Table extends TableNames>(
    id: Id<Table>,
    maximumRowBytes: number,
  ): Promise<Doc<Table> | null> {
    if (
      this.failed ||
      this.pending ||
      !integer(maximumRowBytes) ||
      maximumRowBytes < 1 ||
      maximumRowBytes > MAX_CONVEX_DOCUMENT_BYTES ||
      this.reads >= MAX_POINT_READS ||
      this.hydratedBytes + maximumRowBytes > MAX_PAYLOAD_READ_BYTES
    ) {
      this.failed = true;
      fail();
    }
    this.pending = true;
    try {
      const before = await this.check(true);
      if (before.bytesRead.used + maximumRowBytes > MAX_PAYLOAD_READ_BYTES)
        fail();
      this.reads += 1;
      const row = await this.ctx.db.get(id);
      await this.check(false);
      if (row !== null) {
        const size = boundedDocumentSize(row, maximumRowBytes);
        if (this.hydratedBytes + size > MAX_PAYLOAD_READ_BYTES) fail();
        this.hydratedBytes += size;
      }
      return row;
    } catch {
      this.failed = true;
      fail();
    } finally {
      this.pending = false;
    }
  }

  /** Recheck after other validation reads and immediately before publication. */
  async finish(): Promise<{ pointReads: number; hydratedBytes: number }> {
    if (this.failed || this.pending) {
      this.failed = true;
      fail();
    }
    this.pending = true;
    try {
      await this.check(false);
      return { pointReads: this.reads, hydratedBytes: this.hydratedBytes };
    } catch {
      this.failed = true;
      fail();
    } finally {
      this.pending = false;
    }
  }
}
