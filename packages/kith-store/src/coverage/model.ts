import { createHash } from "node:crypto";

import type { ClientBase, QueryResultRow } from "pg";

import { getAdminSpaceIds } from "../admin/model.js";
import {
  type Principal,
  requireSpaceAccess,
} from "../identity/authorization.js";
import type { IdentityCtx } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId, newKithId } from "../ids.js";
import { getEntity } from "../memory/entities.js";
import { spacePredicate } from "../spaces.js";

const MAX_ACCOUNTS = 32;
const MAX_ROWS = 128;
const MAX_RECORD_TYPE_LENGTH = 100;
const MAX_GAP_REASON_LENGTH = 500;
const MAX_GAP_NOTE_LENGTH = 1_000;
const MAX_LISTED_GAPS = 200;
/**
 * The caller has already authenticated the actor and derived this transaction's
 * authorized space. Coverage does not open pools or authorize arbitrary IDs;
 * callers run every read and write in their own SERIALIZABLE transaction.
 */
type Ctx = IdentityCtx;
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
export type CoverageGapAcknowledgement =
  "mark_unavailable" | "mark_not_expected";
export type CoverageGapListItem = {
  id: string;
  spaceId: string;
  sourceAccountId: string;
  sourceName: string;
  connector: string;
  accountId: string;
  recordType: string;
  entityId: string | null;
  entityName: string | null;
  expectedFrom: number | null;
  expectedTo: number | null;
  observedFrom: number | null;
  observedTo: number | null;
  lastEnumeratedAt: number | null;
  reason: string;
  detectedAt: number;
};
export type CoverageGapList = {
  items: CoverageGapListItem[];
  overflow: boolean;
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
const optionalMs = (v: unknown, name: string): number | null =>
  v === null ? null : ms(v, name);
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
async function canonicalEntityId(ctx: Ctx, spaceId: string, entityId?: string) {
  if (entityId === undefined) return undefined;
  const entity = await getEntity(ctx, entityId);
  if (!entity || entity.spaceId !== spaceId)
    throw new Error("Entity not found");
  return entity.id;
}

/** Called inside the authorized entity-merge transaction. Retain every gap
 * occurrence and its actions, including unresolved duplicates. A suffix keeps
 * formerly distinct open occurrences collision-free, as for legacy duplicates.
 * Detection uses the condition's fields, not a particular occurrence's key. */
export async function repointCoverageEntity(
  ctx: Ctx,
  spaceId: string,
  sourceId: string,
  targetId: string,
): Promise<number> {
  const result = await ctx.client.query(
    `UPDATE kith.coverage_gaps
        SET entity_id = $1::text,
            condition_key = md5(concat_ws(E'\\x1f', source_account_id::text,
              record_type, $1::text,
              coalesce((extract(epoch FROM "from") * 1000)::bigint::text, ''),
              coalesce((extract(epoch FROM "to") * 1000)::bigint::text, ''), reason))
              || CASE WHEN status = 'open' THEN ':entity-merge:' || id::text ELSE '' END
      WHERE entity_id = $2 AND space_id = $3`,
    [targetId, sourceId, spaceId],
  );
  return result.rowCount ?? 0;
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
function gapIdentity(
  f: CoverageGapInput,
  normalizedRecordType: string,
  normalizedReason: string,
): string {
  return [
    f.sourceAccountId,
    normalizedRecordType,
    f.entityId ?? "",
    f.from === undefined ? "" : String(f.from),
    f.to === undefined ? "" : String(f.to),
    normalizedReason,
  ].join("\u001f");
}

function conditionKey(identity: string): string {
  return createHash("md5").update(identity).digest("hex");
}
export async function upsertCoverageWindow(
  ctx: Ctx,
  f: CoverageWindowInput,
): Promise<string> {
  f = { ...f, entityId: await canonicalEntityId(ctx, f.spaceId, f.entityId) };
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
  // Two concurrent upserts of one window identity must converge on one row.
  // Nothing structural enforces that: `coverage_windows_lookup_idx` is not
  // unique, and `ON CONFLICT (id)` below only catches a repeat of an id this
  // read already found. Without this lock, two writers that both read "no
  // row" each insert a fresh id, and it is left to SERIALIZABLE's rw-conflict
  // detection to abort one of them; under load it can abort both, and their
  // retries re-collide on the same empty read. A transaction-scoped advisory
  // lock on the identity makes the second writer wait for the first to
  // commit, so its (at most one) serialization retry starts from a snapshot
  // that already holds the row and takes the update path. Transaction scoped,
  // never session scoped: the pooled endpoint's caveat in the consolidation
  // plan, section 2.8.
  await ctx.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    [
      "kith.coverage_windows",
      f.sourceAccountId,
      rt,
      f.entityId ?? "",
      date(f.from).toISOString(),
      date(f.to).toISOString(),
    ].join("\u001f"),
  ]);
  const existing = await ctx.client.query<QueryResultRow>(
    'SELECT id,space_id FROM kith.coverage_windows WHERE source_account_id=$1 AND record_type=$2 AND entity_id IS NOT DISTINCT FROM $3 AND "from"=$4 AND "to"=$5 ORDER BY id',
    [f.sourceAccountId, rt, f.entityId ?? null, date(f.from), date(f.to)],
  );
  if (existing.rows.some((row) => row.space_id !== f.spaceId))
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
  if (existing.rows.length > 1) {
    // A merge can bring two retained window IDs onto one identity. Refresh
    // both so an obsolete partial window cannot keep the profile incomplete.
    await ctx.client.query(
      `UPDATE kith.coverage_windows SET state=$3, last_enumerated_at=$4,
         last_processed_at=$5, discovered_count=$6, indexed_count=$7, skipped_count=$8
       WHERE id = ANY($1::text[]) AND space_id=$2`,
      [
        existing.rows.slice(1).map((row) => row.id),
        f.spaceId,
        f.state,
        date(f.lastEnumeratedAt),
        date(f.lastProcessedAt),
        f.discoveredCount,
        f.indexedCount,
        f.skippedCount,
      ],
    );
  }
  return id;
}
export async function openCoverageGap(
  ctx: Ctx,
  f: CoverageGapInput,
): Promise<string> {
  f = { ...f, entityId: await canonicalEntityId(ctx, f.spaceId, f.entityId) };
  await parent(ctx, f.spaceId, f.sourceAccountId, f.entityId);
  const rt = recordType(f.recordType);
  if ((f.from === undefined) !== (f.to === undefined))
    throw new Error("A coverage gap must provide both bounds or neither");
  if (f.from !== undefined) range(f.from, f.to!);
  finite(f.detectedAt, "detectedAt");
  const reason = f.reason.trim();
  if (!reason || reason.length > MAX_GAP_REASON_LENGTH)
    throw new Error("Coverage gap reason is invalid");
  const identity = gapIdentity(f, rt, reason);
  await ctx.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `kith.coverage_gaps\u001f${identity}`,
  ]);
  const existing = await ctx.client.query<QueryResultRow>(
    `SELECT id FROM kith.coverage_gaps
      WHERE space_id = $1 AND source_account_id = $2 AND record_type = $3
        AND entity_id IS NOT DISTINCT FROM $4
        AND "from" IS NOT DISTINCT FROM $5
        AND "to" IS NOT DISTINCT FROM $6
        AND reason = $7 AND status = 'open'
      ORDER BY detected_at DESC, id DESC LIMIT 1`,
    [
      f.spaceId,
      f.sourceAccountId,
      rt,
      f.entityId ?? null,
      f.from === undefined ? null : date(f.from),
      f.to === undefined ? null : date(f.to),
      reason,
    ],
  );
  // Legacy imports and explicit entity merges may retain duplicate occurrences.
  // Refresh one deterministically without clearing the others or creating more.
  if (existing.rows[0]) {
    await ctx.client.query(
      `UPDATE kith.coverage_gaps
          SET detected_at = GREATEST(detected_at, $3)
        WHERE id = $1 AND space_id = $2`,
      [existing.rows[0].id, f.spaceId, date(f.detectedAt)],
    );
    return String(existing.rows[0].id);
  }
  const id = newKithId();
  await ctx.client.query(
    'INSERT INTO kith.coverage_gaps(id,space_id,created_at,source_account_id,record_type,entity_id,"from","to",reason,detected_at,status,condition_key) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,\'open\',$10)',
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
      conditionKey(identity),
    ],
  );
  return id;
}
export async function resolveCoverageGap(
  ctx: Ctx,
  args: {
    spaceId: string;
    gapId: string;
    resolvedAt: number;
    note?: string;
  },
): Promise<void> {
  finite(args.resolvedAt, "resolvedAt");
  const note = validatedNote(args.note);
  const r = await ctx.client.query<QueryResultRow>(
    "SELECT detected_at,status,source_account_id,entity_id FROM kith.coverage_gaps WHERE id=$1 AND space_id=$2 LIMIT 2 FOR UPDATE",
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
    `INSERT INTO kith.coverage_gap_actions
       (id,space_id,coverage_gap_id,created_at,actor_user_id,actor_kind,action,note)
     VALUES($1,$2,$3,$4,NULL,'system','condition_cleared',$5)`,
    [newKithId(), args.spaceId, args.gapId, date(args.resolvedAt), note],
  );
  await ctx.client.query(
    "UPDATE kith.coverage_gaps SET status='resolved',resolved_at=$3 WHERE id=$1 AND space_id=$2",
    [args.gapId, args.spaceId, date(args.resolvedAt)],
  );
}

function validatedNote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const note = value.trim();
  if (!note || note.length > MAX_GAP_NOTE_LENGTH)
    throw new Error("Coverage gap note is invalid");
  return note;
}

function gapNotFound(): never {
  throw new IdentityError("Coverage gap not found");
}

/**
 * Every unresolved gap across spaces this principal may administer.
 *
 * UI filters are deliberately absent from this read. Search and chips narrow
 * the already-authorized result in the browser; changing them cannot mutate a
 * gap or remove it from the query contract.
 */
export async function listCoverageGaps(
  ctx: IdentityCtx,
  args: { principal: Principal },
): Promise<CoverageGapList> {
  const spaceIds = await getAdminSpaceIds(ctx, args.principal);
  if (spaceIds.length === 0) return { items: [], overflow: false };
  const predicate = spacePredicate(spaceIds, 1, "g.space_id");
  const result = await ctx.client.query<QueryResultRow>(
    `SELECT g.id,g.space_id,g.source_account_id,g.record_type,g.entity_id,
            g."from",g."to",g.reason,g.detected_at,
            a.name AS source_name,a.connector,a.account_id,
            e.canonical_name AS entity_name,
            observed.observed_from,observed.observed_to,
            observed.last_enumerated_at
       FROM kith.coverage_gaps g
       JOIN kith.source_accounts a
         ON a.id = g.source_account_id AND a.space_id = g.space_id
       LEFT JOIN kith.entities e
         ON e.id = g.entity_id AND e.space_id = g.space_id
       LEFT JOIN LATERAL (
         SELECT min(w."from") AS observed_from,
                max(w."to") AS observed_to,
                max(w.last_enumerated_at) AS last_enumerated_at
           FROM kith.coverage_windows w
          WHERE w.space_id = g.space_id
            AND w.source_account_id = g.source_account_id
            AND w.record_type = g.record_type
            AND w.entity_id IS NOT DISTINCT FROM g.entity_id
       ) observed ON true
      WHERE ${predicate.sql} AND g.status = 'open'
      ORDER BY g.detected_at DESC,g.id DESC LIMIT $2`,
    [predicate.value, MAX_LISTED_GAPS + 1],
  );
  const overflow = result.rows.length > MAX_LISTED_GAPS;
  return {
    items: result.rows.slice(0, MAX_LISTED_GAPS).map((record) => ({
      id: String(record.id),
      spaceId: String(record.space_id),
      sourceAccountId: String(record.source_account_id),
      sourceName:
        typeof record.source_name === "string" ? record.source_name : "",
      connector: typeof record.connector === "string" ? record.connector : "",
      accountId: typeof record.account_id === "string" ? record.account_id : "",
      recordType: String(record.record_type),
      entityId: record.entity_id === null ? null : String(record.entity_id),
      entityName:
        typeof record.entity_name === "string" ? record.entity_name : null,
      expectedFrom: optionalMs(record.from, "from"),
      expectedTo: optionalMs(record.to, "to"),
      observedFrom: optionalMs(record.observed_from, "observedFrom"),
      observedTo: optionalMs(record.observed_to, "observedTo"),
      lastEnumeratedAt: optionalMs(
        record.last_enumerated_at,
        "lastEnumeratedAt",
      ),
      reason: String(record.reason),
      detectedAt: ms(record.detected_at, "detectedAt"),
    })),
    overflow,
  };
}

/** Resolve one current occurrence with an immutable user acknowledgement. */
export async function acknowledgeCoverageGap(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    gapId: string;
    action: CoverageGapAcknowledgement;
    note?: string;
  },
): Promise<{ changed: boolean; actionId: string | null }> {
  const gapId = assertKithId(args.gapId, "invalid_coverage_gap_id");
  if (
    args.action !== "mark_unavailable" &&
    args.action !== "mark_not_expected"
  ) {
    throw new IdentityError("Coverage gap action is invalid", {
      code: "invalid_input",
      message: "Coverage gap action is invalid",
    });
  }
  const note = validatedNote(args.note);
  const result = await ctx.client.query<QueryResultRow>(
    `SELECT id,space_id,status FROM kith.coverage_gaps
      WHERE id = $1 LIMIT 2 FOR UPDATE`,
    [gapId],
  );
  if (result.rows.length !== 1) gapNotFound();
  const gap = result.rows[0]!;
  let actorUserId: string;
  try {
    actorUserId = (
      await requireSpaceAccess(
        ctx,
        args.principal,
        String(gap.space_id),
        "write",
      )
    ).userId;
  } catch (error) {
    if (error instanceof IdentityError) gapNotFound();
    throw error;
  }
  if (gap.status === "resolved") return { changed: false, actionId: null };
  if (gap.status !== "open") gapNotFound();
  const actionId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.coverage_gap_actions
       (id,space_id,coverage_gap_id,created_at,actor_user_id,actor_kind,action,note)
     VALUES($1,$2,$3,$4,$5,'user',$6,$7)`,
    [
      actionId,
      String(gap.space_id),
      gapId,
      date(ctx.now),
      actorUserId,
      args.action,
      note,
    ],
  );
  await ctx.client.query(
    `UPDATE kith.coverage_gaps SET status = 'resolved',resolved_at = $3
      WHERE id = $1 AND space_id = $2`,
    [gapId, String(gap.space_id), date(ctx.now)],
  );
  return { changed: true, actionId };
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
  args = {
    ...args,
    entityId: await canonicalEntityId(ctx, args.spaceId, args.entityId),
  };
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
