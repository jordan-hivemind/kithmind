// The port of `packages/convex/convex/models/sourceAccounts/public.ts`: the
// three functions the settings page calls to let the owner configure a source
// without a database credential (docs/plans/2026-09-16-web-mcp-postgres-surface.md,
// section 1.5, "Source account create, update, list for the owner UI", and
// question 1 of section 8, "Add the row").
//
// Argument and error shape follow `../identity/apiKeys.ts`, the nearest ported
// sibling: every function takes an `IdentityCtx` plus an already-authenticated
// `Principal`, resolves or checks the space itself, and every statement carries
// its own space predicate rather than trusting a check made earlier in the call.
//
// `kith.source_accounts` is one of the tables `008_worker_protocol.sql` migrates
// rows into and deliberately leaves without a UNIQUE index (see that file's
// header): a duplicate would turn a tested denial into a failed load. The
// `(space_id, connector, account_id)` uniqueness Convex's `.unique()` index
// query enforced is therefore a `SELECT ... LIMIT 2` count check here, exactly
// as `by_space_connector_account` is read by application code elsewhere in this
// migrated set.
//
// P2-39i0 (the create/update/list port below) left two Convex side effects of
// the `update` mutation unported: `advanceSourceAssessmentEpoch`
// (models/ingestion/model.ts) and `onSourceEnabledChanged`
// (models/diagnostics/model.ts), both run only when a caller actually changes
// `enabled`. This slice (P2-39i0 follow-up) ports both, now that
// `../workers/diagnostics.ts` (P2-39j) owns the worker-watcher and
// missing-worker-incident tables `onSourceEnabledChanged` touches.
//
// Both side effects run inside the same `withKithTransaction` this module
// already runs in -- the caller's one transaction, not a second one -- exactly
// as Convex ran them as two more statements inside one mutation. Neither
// Convex function calls `ctx.scheduler.runAfter`: `advanceSourceAssessmentEpoch`
// is one `UPDATE`, and `onSourceEnabledChanged` patches the watcher and
// resolves an incident synchronously. So neither has a `kith.deferred_work`
// row to schedule here; what changes on disable or re-enable is rows in
// `kith.source_accounts`, `kith.worker_watcher_states` and
// `kith.worker_operational_incidents`, not queued work.

import { assertKithId, newKithId } from "../ids.js";
import { spacePredicate } from "../spaces.js";
import {
  getAuthorizedReadSpaceIds,
  requireSpaceAccess,
  resolveWriteSpace,
  type Principal,
} from "../identity/authorization.js";
import { exec, row, rows, type IdentityCtx } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { onSourceEnabledChanged } from "../workers/diagnostics.js";

/** Convex's default: `models/sourceAccounts/public.ts` `create`. */
const DEFAULT_FRESHNESS_MS = 86_400_000;
const MIN_FRESHNESS_MS = 60_000;
const MAX_FRESHNESS_MS = 365 * 86_400_000;
const CONNECTOR_MAX_CHARS = 100;
const ACCOUNT_ID_MAX_CHARS = 512;
const NAME_MAX_CHARS = 200;
/** Convex's `list` throws past 100; this is that same bound. */
const MAX_LISTED_SOURCE_ACCOUNTS = 100;

function typedError(code: string, message: string): never {
  throw new IdentityError(message, { code, message });
}

/** Bare, non-enumerating: whether the id is missing or the space check failed. */
function sourceAccountNotFound(): never {
  throw new IdentityError("Source account not found");
}

/**
 * Non-empty, round-trips through UTF-8/UTF-16 (refuses a lone surrogate) and
 * within `maximum` UTF-8 bytes. Convex's `boundedText`, verbatim.
 */
function boundedText(value: string, name: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).length > maximum ||
    new TextDecoder().decode(new TextEncoder().encode(value)) !== value
  ) {
    typedError("invalid_input", `${name} is empty, malformed or too long`);
  }
}

/** One minute to one year, an integer. Convex's `validateFreshness`, verbatim. */
function validateFreshness(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_FRESHNESS_MS ||
    value > MAX_FRESHNESS_MS
  ) {
    typedError(
      "invalid_input",
      "Freshness must be between one minute and one year",
    );
  }
}

export type SourceAccountSummary = {
  id: string;
  spaceId: string;
  name: string;
  connector: string;
  accountId: string;
  freshnessMs: number;
  enabled: boolean;
};

type SourceAccountListRow = {
  id: string;
  space_id: string;
  name: string | null;
  connector: string | null;
  account_id: string | null;
  freshness_ms: string | number | null;
  enabled: boolean | null;
};

function toSummary(record: SourceAccountListRow): SourceAccountSummary {
  return {
    id: record.id,
    spaceId: record.space_id,
    name: record.name ?? "",
    connector: record.connector ?? "",
    accountId: record.account_id ?? "",
    // `freshness_ms` is `numeric`; node-pg returns it as a string on purpose
    // (see `workers/rows.ts`), so it is parsed back to the number every row
    // this surface writes actually holds.
    freshnessMs:
      record.freshness_ms === null ? 0 : Number(record.freshness_ms),
    enabled: record.enabled ?? false,
  };
}

/**
 * `models/sourceAccounts/public.ts` `create`.
 *
 * Resolves the write space exactly as `resolveWriteSpace` does for every other
 * ported mutation (explicit space, else the configured default, else the
 * caller's personal space), then refuses a second row for the same
 * `(space, connector, account)` triple. Returns the new row's id.
 */
export async function createSourceAccount(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceId?: string;
    connector: string;
    accountId: string;
    name: string;
    freshnessMs?: number;
  },
): Promise<string> {
  boundedText(args.connector, "Connector", CONNECTOR_MAX_CHARS);
  boundedText(args.accountId, "Account identity", ACCOUNT_ID_MAX_CHARS);
  boundedText(args.name, "Name", NAME_MAX_CHARS);
  const freshnessMs = args.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  validateFreshness(freshnessMs);

  const spaceId = await resolveWriteSpace(ctx, args.principal, args.spaceId);

  const existing = await rows<{ id: string }>(
    ctx,
    `SELECT id FROM kith.source_accounts
       WHERE space_id = $1 AND connector = $2 AND account_id = $3 LIMIT 2`,
    [spaceId, args.connector, args.accountId],
  );
  if (existing.length > 0) {
    typedError("source_account_exists", "Source account already exists");
  }

  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, true, 0, $7, $8)`,
    [
      id,
      spaceId,
      new Date(ctx.now),
      args.connector,
      args.accountId,
      args.name,
      freshnessMs,
      assertKithId(args.principal.userId, "invalid_user_id"),
    ],
  );
  return id;
}

/**
 * `models/sourceAccounts/public.ts` `update`.
 *
 * Loads the account by id, then checks write access on its own space through
 * `requireSpaceAccess`, exactly the two-step `requireSourceAccountAccess` did
 * for the `"write"` operation. A missing row and a row the caller has no write
 * access to are refused with the same message, so a caller cannot enumerate
 * source accounts by watching which error comes back.
 *
 * Locks the row (`FOR UPDATE`) because, unlike the i0 port, this may now also
 * write `kith.worker_watcher_states` and `kith.worker_operational_incidents`
 * for the same source account: the lock keeps a concurrent heartbeat or
 * another `update` call from reading `enabled` mid-change, the same
 * single-document atomicity a Convex mutation gave `ctx.db.patch` for free.
 *
 * `args.enabled` is read against `account.enabled` (the value before this
 * call) exactly once: only an actual change runs `advanceSourceAssessmentEpoch`
 * and `onSourceEnabledChanged`, both before the row's own `UPDATE` below,
 * matching Convex's order -- read, validate, side effect, patch.
 */
export async function updateSourceAccount(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    sourceAccountId: string;
    name?: string;
    enabled?: boolean;
    freshnessMs?: number;
  },
): Promise<void> {
  const id = assertKithId(args.sourceAccountId, "invalid_source_account_id");
  const account = await row<{ space_id: string; enabled: boolean }>(
    ctx,
    "SELECT space_id, enabled FROM kith.source_accounts WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (!account) sourceAccountNotFound();
  try {
    await requireSpaceAccess(ctx, args.principal, account.space_id, "write");
  } catch {
    sourceAccountNotFound();
  }

  if (args.name !== undefined) boundedText(args.name, "Name", NAME_MAX_CHARS);
  if (args.freshnessMs !== undefined) validateFreshness(args.freshnessMs);

  if (args.enabled !== undefined && args.enabled !== account.enabled) {
    await advanceSourceAssessmentEpoch(ctx, account.space_id, id);
    await onSourceEnabledChanged(
      ctx,
      { id, spaceId: account.space_id, enabled: account.enabled },
      args.enabled,
    );
  }

  await exec(
    ctx,
    `UPDATE kith.source_accounts
        SET name = COALESCE($3, name),
            enabled = COALESCE($4, enabled),
            freshness_ms = COALESCE($5, freshness_ms)
      WHERE id = $1 AND space_id = $2`,
    [
      id,
      account.space_id,
      args.name ?? null,
      args.enabled ?? null,
      args.freshnessMs ?? null,
    ],
  );
}

/**
 * `models/ingestion/model.ts` `advanceSourceAssessmentEpoch`, ported as a
 * private helper the same way `../ingestion/inlineWork.ts` ports its own
 * call site of the same Convex function: a plain increment, `COALESCE`d
 * against a null `worker_assessment_epoch` (Convex's `?? 0`), scoped by
 * `space_id` as every statement in this module is. Convex's extra bounds
 * checks (`Number.isSafeInteger`, non-negative, no overflow) are not
 * reproduced here, matching every other port of this same function in this
 * package (`../workers/archivedDiscovery.ts`, `../workers/discovery.ts`): the
 * column is a bounded `numeric` a single caller increments by one, so the
 * failure those checks guarded against cannot occur through this surface.
 */
async function advanceSourceAssessmentEpoch(
  ctx: IdentityCtx,
  spaceId: string,
  sourceAccountId: string,
): Promise<void> {
  const updated = await rows<{ id: string }>(
    ctx,
    `UPDATE kith.source_accounts
        SET worker_assessment_epoch = COALESCE(worker_assessment_epoch, 0) + 1
      WHERE id = $1 AND space_id = $2
      RETURNING id`,
    [sourceAccountId, spaceId],
  );
  if (updated.length !== 1) sourceAccountNotFound();
}

/**
 * `models/sourceAccounts/public.ts` `list`.
 *
 * Reads every source account across the caller's authorized (or explicitly
 * filtered) spaces, bounded at 100 total exactly as the Convex original was,
 * and refuses rather than silently truncating past that bound.
 */
export async function listSourceAccounts(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceIds?: readonly string[] },
): Promise<SourceAccountSummary[]> {
  const spaces = await getAuthorizedReadSpaceIds(
    ctx,
    args.principal,
    args.spaceIds,
  );
  if (spaces.length === 0) return [];

  const predicate = spacePredicate(spaces, 1);
  const records = await rows<SourceAccountListRow>(
    ctx,
    `SELECT id, space_id, name, connector, account_id, freshness_ms, enabled
       FROM kith.source_accounts WHERE ${predicate.sql}
       ORDER BY space_id, id LIMIT $2`,
    [predicate.value, MAX_LISTED_SOURCE_ACCOUNTS + 1],
  );
  if (records.length > MAX_LISTED_SOURCE_ACCOUNTS) {
    typedError(
      "source_account_limit",
      "Too many source accounts; filter spaces",
    );
  }
  return records.map(toSummary);
}
