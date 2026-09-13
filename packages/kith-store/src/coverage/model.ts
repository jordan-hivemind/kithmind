import type { ClientBase, QueryResultRow } from "pg";

import { newKithId } from "../ids.js";

const MAX_ACCOUNTS = 32;
const MAX_ROWS = 128;
const MAX_RECORD_TYPE_LENGTH = 100;
const MAX_GAP_REASON_LENGTH = 500;
/**
 * The caller has already authenticated the actor and derived this transaction's
 * authorized space. Coverage does not open pools or authorize arbitrary IDs;
 * callers run every read and write in their own SERIALIZABLE transaction.
 */
type Ctx = { readonly client: ClientBase; readonly now: number };
export type CoverageRange = { from: number; to: number };
export type QueryCoverage = {
  state: "complete" | "partial" | "unknown" | "stale";
  asOf: number;
  windows: Array<{ from: number; to: number; sourceAccountId: string }>;
  knownGaps: Array<{ from?: number; to?: number; reason: string }>;
  pendingJobs: number;
  failedJobs: number;
  overflow: boolean;
};
export type CoverageWindowInput = {
  spaceId: string;
  sourceAccountId: string;
  recordType: string;
  entityId?: string;
  from: number;
  to: number;
  state: "complete" | "partial" | "unknown";
  lastEnumeratedAt: number;
  lastProcessedAt: number;
  discoveredCount: number;
  indexedCount: number;
  skippedCount: number;
};
export type CoverageGapInput = {
  spaceId: string;
  sourceAccountId: string;
  recordType: string;
  entityId?: string;
  from?: number;
  to?: number;
  reason: string;
  detectedAt: number;
};
const finite = (n: number, name: string) => {
  if (!Number.isFinite(n)) throw new Error(`${name} must be finite`);
};
const count = (n: number, name: string) => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(`${name} must be a nonnegative integer`);
};
function recordType(value: string) {
  const r = value.trim();
  if (!r || r.length > MAX_RECORD_TYPE_LENGTH)
    throw new Error("recordType is invalid");
  return r;
}
function range(from: number, to: number) {
  finite(from, "from");
  finite(to, "to");
  if (from >= to) throw new Error("Coverage ranges must satisfy from < to");
}
const date = (n: number) => new Date(n);
const ms = (v: unknown, name: string) => {
  if (!(v instanceof Date) || !Number.isFinite(v.getTime()))
    throw new Error(`${name} is corrupt`);
  return v.getTime();
};
const numeric = (v: unknown, name: string) => {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} is corrupt`);
  return n;
};
const overlaps = (
  a: number | undefined,
  b: number | undefined,
  r: CoverageRange,
) => a === undefined || b === undefined || (a < r.to && b > r.from);
function covered(r: CoverageRange, windows: CoverageRange[]) {
  let end = r.from;
  for (const w of windows
    .filter((w) => overlaps(w.from, w.to, r))
    .sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (w.from > end) return false;
    end = Math.max(end, w.to);
    if (end >= r.to) return true;
  }
  return false;
}
async function parent(
  ctx: Ctx,
  spaceId: string,
  accountId: string,
  entityId?: string,
) {
  const a = await ctx.client.query<QueryResultRow>(
    "SELECT id,space_id FROM kith.source_accounts WHERE id=$1 LIMIT 2",
    [accountId],
  );
  if (a.rows.length !== 1 || a.rows[0]!.space_id !== spaceId)
    throw new Error("Source account not found");
  if (entityId !== undefined) {
    const e = await ctx.client.query<QueryResultRow>(
      "SELECT id FROM kith.entities WHERE id=$1 AND space_id=$2 LIMIT 2",
      [entityId, spaceId],
    );
    if (e.rows.length !== 1) throw new Error("Entity not found");
  }
}
export async function upsertCoverageWindow(
  ctx: Ctx,
  f: CoverageWindowInput,
): Promise<string> {
  await parent(ctx, f.spaceId, f.sourceAccountId, f.entityId);
  const rt = recordType(f.recordType);
  if (!(["complete", "partial", "unknown"] as const).includes(f.state))
    throw new Error("Coverage window state is invalid");
  range(f.from, f.to);
  finite(f.lastEnumeratedAt, "lastEnumeratedAt");
  finite(f.lastProcessedAt, "lastProcessedAt");
  count(f.discoveredCount, "discoveredCount");
  count(f.indexedCount, "indexedCount");
  count(f.skippedCount, "skippedCount");
  if (f.indexedCount + f.skippedCount > f.discoveredCount)
    throw new Error("Coverage counts exceed discoveredCount");
  if (
    f.state === "complete" &&
    (f.skippedCount !== 0 || f.indexedCount !== f.discoveredCount)
  )
    throw new Error("Complete coverage must index every discovered item");
  const existing = await ctx.client.query<QueryResultRow>(
    'SELECT id,space_id FROM kith.coverage_windows WHERE source_account_id=$1 AND record_type=$2 AND entity_id IS NOT DISTINCT FROM $3 AND "from"=$4 AND "to"=$5 LIMIT 2',
    [f.sourceAccountId, rt, f.entityId ?? null, date(f.from), date(f.to)],
  );
  if (existing.rows.length > 1)
    throw new Error("Duplicate coverage window identity");
  if (existing.rows[0] && existing.rows[0].space_id !== f.spaceId)
    throw new Error("Coverage window identity is corrupt");
  const id = existing.rows[0]?.id ?? newKithId();
  await ctx.client.query(
    `INSERT INTO kith.coverage_windows(id,space_id,created_at,source_account_id,record_type,entity_id,"from","to",state,last_enumerated_at,last_processed_at,discovered_count,indexed_count,skipped_count) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO UPDATE SET space_id=EXCLUDED.space_id,source_account_id=EXCLUDED.source_account_id,record_type=EXCLUDED.record_type,entity_id=EXCLUDED.entity_id,"from"=EXCLUDED."from","to"=EXCLUDED."to",state=EXCLUDED.state,last_enumerated_at=EXCLUDED.last_enumerated_at,last_processed_at=EXCLUDED.last_processed_at,discovered_count=EXCLUDED.discovered_count,indexed_count=EXCLUDED.indexed_count,skipped_count=EXCLUDED.skipped_count`,
    [
      id,
      f.spaceId,
      f.sourceAccountId,
      rt,
      f.entityId ?? null,
      date(f.from),
      date(f.to),
      f.state,
      date(f.lastEnumeratedAt),
      date(f.lastProcessedAt),
      f.discoveredCount,
      f.indexedCount,
      f.skippedCount,
    ],
  );
  return id;
}
export async function openCoverageGap(
  ctx: Ctx,
  f: CoverageGapInput,
): Promise<string> {
  await parent(ctx, f.spaceId, f.sourceAccountId, f.entityId);
  const rt = recordType(f.recordType);
  if ((f.from === undefined) !== (f.to === undefined))
    throw new Error("A coverage gap must provide both bounds or neither");
  if (f.from !== undefined) range(f.from, f.to!);
  finite(f.detectedAt, "detectedAt");
  const reason = f.reason.trim();
  if (!reason || reason.length > MAX_GAP_REASON_LENGTH)
    throw new Error("Coverage gap reason is invalid");
  const id = newKithId();
  await ctx.client.query(
    'INSERT INTO kith.coverage_gaps(id,space_id,created_at,source_account_id,record_type,entity_id,"from","to",reason,detected_at,status) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,\'open\')',
    [
      id,
      f.spaceId,
      f.sourceAccountId,
      rt,
      f.entityId ?? null,
      f.from === undefined ? null : date(f.from),
      f.to === undefined ? null : date(f.to),
      reason,
      date(f.detectedAt),
    ],
  );
  return id;
}
export async function resolveCoverageGap(
  ctx: Ctx,
  args: { spaceId: string; gapId: string; resolvedAt: number },
): Promise<void> {
  finite(args.resolvedAt, "resolvedAt");
  const r = await ctx.client.query<QueryResultRow>(
    "SELECT detected_at,status,source_account_id,entity_id FROM kith.coverage_gaps WHERE id=$1 AND space_id=$2 LIMIT 2",
    [args.gapId, args.spaceId],
  );
  if (r.rows.length !== 1) throw new Error("Coverage gap not found");
  if (r.rows[0]!.status === "resolved") return;
  await parent(
    ctx,
    args.spaceId,
    r.rows[0]!.source_account_id,
    r.rows[0]!.entity_id ?? undefined,
  );
  if (args.resolvedAt < ms(r.rows[0]!.detected_at, "detectedAt"))
    throw new Error("resolvedAt precedes detectedAt");
  await ctx.client.query(
    "UPDATE kith.coverage_gaps SET status='resolved',resolved_at=$3 WHERE id=$1 AND space_id=$2",
    [args.gapId, args.spaceId, date(args.resolvedAt)],
  );
}
export async function calculateCoverage(
  ctx: Ctx,
  args: {
    spaceId: string;
    sourceAccountIds: string[];
    recordType: string;
    entityId?: string;
    from: number;
    to: number;
    now: number;
    snapshotAt: number;
  },
): Promise<QueryCoverage> {
  range(args.from, args.to);
  const rt = recordType(args.recordType);
  finite(args.now, "now");
  finite(args.snapshotAt, "snapshotAt");
  const ids = [...new Set(args.sourceAccountIds)];
  const empty = (overflow: boolean): QueryCoverage => ({
    state: "unknown",
    asOf: args.now,
    windows: [],
    knownGaps: [],
    pendingJobs: 0,
    failedJobs: 0,
    overflow,
  });
  if (ids.length > MAX_ACCOUNTS) return empty(true);
  if (!ids.length) return empty(false);
  let left = MAX_ROWS,
    overflow = false,
    unknown = false,
    stale = false,
    partial = false,
    pendingJobs = 0,
    failedJobs = 0;
  const windows: QueryCoverage["windows"] = [],
    gaps: QueryCoverage["knownGaps"] = [],
    entityCache = new Map<string, boolean>();
  const take = async (sql: string, values: unknown[]) => {
    if (!left) {
      overflow = true;
      return [] as QueryResultRow[];
    }
    const r = await ctx.client.query<QueryResultRow>(sql, [
      ...values,
      left + 1,
    ]);
    if (r.rows.length > left) overflow = true;
    const rows = r.rows.slice(0, left);
    left -= rows.length;
    return rows;
  };
  const entityOk = async (id: unknown, space: string) => {
    if (id === null) return true;
    if (typeof id !== "string") return false;
    let ok = entityCache.get(id);
    if (ok === undefined) {
      const r = await ctx.client.query(
        "SELECT id FROM kith.entities WHERE id=$1 AND space_id=$2 LIMIT 2",
        [id, space],
      );
      ok = r.rows.length === 1;
      entityCache.set(id, ok);
    }
    return ok;
  };
  for (const id of ids) {
    if (!left) {
      overflow = true;
      break;
    }
    const ar = await ctx.client.query<QueryResultRow>(
      "SELECT space_id,enabled,freshness_ms,coverage_invalidated_at FROM kith.source_accounts WHERE id=$1 AND space_id=$2 LIMIT 2",
      [id, args.spaceId],
    );
    if (ar.rows.length !== 1) {
      unknown = true;
      continue;
    }
    const a = ar.rows[0]!;
    const freshness = Number(a.freshness_ms);
    if (!Number.isFinite(freshness) || freshness <= 0) partial = true;
    const wr = await take(
      "SELECT * FROM kith.coverage_windows WHERE source_account_id=$1 AND record_type=$2 ORDER BY id LIMIT $3",
      [id, rt],
    );
    const gr = await take(
      "SELECT * FROM kith.coverage_gaps WHERE source_account_id=$1 AND record_type=$2 AND status='open' ORDER BY id LIMIT $3",
      [id, rt],
    );
    const good: any[] = [];
    for (const w of wr) {
      try {
        const from = ms(w.from, "from"),
          to = ms(w.to, "to"),
          le = ms(w.last_enumerated_at, "lastEnumeratedAt"),
          lp = ms(w.last_processed_at, "lastProcessedAt"),
          d = numeric(w.discovered_count, "discoveredCount"),
          i = numeric(w.indexed_count, "indexedCount"),
          s = numeric(w.skipped_count, "skippedCount");
        if (
          w.space_id !== args.spaceId ||
          from >= to ||
          i + s > d ||
          !["complete", "partial", "unknown"].includes(w.state) ||
          !(await entityOk(w.entity_id, args.spaceId))
        )
          partial = true;
        else good.push({ ...w, from, to, le, lp, d, i, s });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error)
          throw error;
        partial = true;
      }
    }
    const scoped = good.filter(
      (w) =>
        (args.entityId === undefined
          ? w.entity_id === null
          : w.entity_id === null || w.entity_id === args.entityId) &&
        overlaps(w.from, w.to, args),
    );
    const structural = scoped.filter(
      (w) => w.state === "complete" && w.s === 0 && w.i === w.d,
    );
    const invalidated =
      a.coverage_invalidated_at === null
        ? undefined
        : ms(a.coverage_invalidated_at, "coverageInvalidatedAt");
    const fresh = structural.filter(
      (w) =>
        a.enabled === true &&
        (invalidated === undefined ||
          (w.le > invalidated && w.lp > invalidated)) &&
        w.le <= args.now &&
        w.lp <= args.now &&
        w.le <= args.snapshotAt &&
        w.lp <= args.snapshotAt &&
        w.le >= args.now - freshness &&
        w.lp >= args.now - freshness,
    );
    windows.push(
      ...fresh.map((w) => ({ from: w.from, to: w.to, sourceAccountId: id })),
    );
    if (!covered(args, fresh)) {
      if (covered(args, structural)) stale = true;
      else if (scoped.length) partial = true;
      else unknown = true;
    }
    for (const g of gr) {
      try {
        const from = g.from === null ? undefined : ms(g.from, "from"),
          to = g.to === null ? undefined : ms(g.to, "to");
        const reason = typeof g.reason === "string" ? g.reason.trim() : "";
        if (
          (from === undefined) !== (to === undefined) ||
          (from !== undefined && from >= to!) ||
          !reason ||
          reason.length > MAX_GAP_REASON_LENGTH ||
          g.space_id !== args.spaceId ||
          !(await entityOk(g.entity_id, args.spaceId))
        ) {
          partial = true;
          continue;
        }
        if (
          ms(g.detected_at, "detectedAt") <= args.now &&
          (args.entityId === undefined ||
            g.entity_id === null ||
            g.entity_id === args.entityId) &&
          overlaps(from, to, args)
        ) {
          partial = true;
          gaps.push({
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            reason,
          });
        }
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error)
          throw error;
        partial = true;
      }
    }
    const fetch = await take(
      "SELECT r.*,i.space_id item_space,i.source_account_id item_account,i.lifecycle FROM kith.source_fetch_requests r LEFT JOIN kith.source_items i ON i.id=r.source_item_id WHERE r.source_account_id=$1 ORDER BY r.id LIMIT $2",
      [id],
    );
    for (const r of fetch) {
      if (
        r.space_id !== args.spaceId ||
        r.item_space !== args.spaceId ||
        r.item_account !== id
      )
        partial = true;
      else if (r.lifecycle !== "forgetting" && r.lifecycle !== "forgotten")
        pendingJobs++;
    }
    for (const states of [
      ["queued", "processing", "staged"],
      ["failed", "needs_review"],
    ] as const) {
      const jr = await take(
        "SELECT j.*,i.space_id item_space,i.source_account_id item_account,i.lifecycle,i.desired_revision_id,i.desired_processing_epoch item_epoch FROM kith.ingest_jobs j LEFT JOIN kith.source_items i ON i.id=j.source_item_id WHERE j.source_account_id=$1 AND j.state = ANY($2) ORDER BY j.id LIMIT $3",
        [id, states],
      );
      for (const j of jr) {
        if (
          j.space_id !== args.spaceId ||
          j.item_space !== args.spaceId ||
          j.item_account !== id
        )
          partial = true;
        else if (j.lifecycle !== "forgetting" && j.lifecycle !== "forgotten") {
          let epoch: number;
          let itemEpoch: number;
          try {
            epoch = numeric(j.desired_processing_epoch, "job epoch");
            itemEpoch = numeric(j.item_epoch, "item epoch");
          } catch {
            partial = true;
            continue;
          }
          if (j.source_revision_id === null || j.desired_revision_id === null)
            partial = true;
          else if (
            j.source_revision_id === j.desired_revision_id &&
            epoch === itemEpoch
          ) {
            if (states[0] === "failed") failedJobs++;
            else pendingJobs++;
          }
        }
      }
    }
  }
  const finalOverflow =
    overflow || windows.length > MAX_ROWS || gaps.length > MAX_ROWS;
  if (pendingJobs || failedJobs || finalOverflow) partial = true;
  return {
    state: partial
      ? "partial"
      : unknown
        ? "unknown"
        : stale
          ? "stale"
          : "complete",
    asOf: args.now,
    windows: windows.slice(0, MAX_ROWS),
    knownGaps: gaps.slice(0, MAX_ROWS),
    pendingJobs,
    failedJobs,
    overflow: finalOverflow,
  };
}
