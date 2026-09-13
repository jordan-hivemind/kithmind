import type { ClientBase } from "pg";

import { newKithId } from "../ids.js";
import { at } from "../workers/db.js";
import {
  canonicalizeDecimal,
  SUPPORTED_CURRENCIES,
  validateCurrencyCode,
} from "./values.js";

export const RECORD_QUERY_SESSION_TTL_MS = 15 * 60 * 1_000;
export const MAX_ACTIVE_RECORD_QUERY_SESSIONS = 16;
export const MAX_QUERY_SESSION_CLEANUP_ROWS = 64;
export const MAX_RECORD_QUERY_SOURCE_ACCOUNTS = 32;
const MIN_QUERY_TIME = -62_167_219_200_000;
const MAX_QUERY_TIME = 253_402_300_799_999;

export type RecordQueryOperation =
  "observation_history" | "list_events" | "sum_money";
export type RecordQueryConsistency = "snapshot" | "current";
export type RecordQueryCursorTuple = {
  occurrenceDate: string;
  occurrencePrecision: "date" | "datetime";
  occurrenceInstant?: number;
  sortKey: string;
  stableId: string;
};
export type CurrencyTotal = { currency: string; amount: string };

/**
 * Authorization is deliberately outside this module. The query service must
 * freshly reload the principal, credential and membership, apply the operation's
 * authorization, resolve and sort the source inventory, and build the same
 * signature on every page before passing this binding. Session reads and writes
 * require `read`; forget invalidation and purge require the forget writer's
 * stronger authorization. This module must run inside the caller's
 * `withKithTransaction` SERIALIZABLE transaction; it exposes no pool-level or
 * unscoped cursor mutation API.
 */
export type AuthorizedRecordQueryBinding = {
  spaceId: string;
  userId: string;
  credentialId?: string;
  membershipId: string;
  authorizationSignature: string;
  operation: RecordQueryOperation;
  consistency: RecordQueryConsistency;
  normalizedFilter: string;
  sourceAccountIds: readonly string[];
};

export type RecordQuerySessionState = {
  id: string;
  binding: AuthorizedRecordQueryBinding;
  snapshotAt: number;
  activationEpoch: number;
  visibilityEpoch: number;
  lastTuple: RecordQueryCursorTuple;
  totals: CurrencyTotal[];
  invalidRows: number;
  ambiguousTimeRows: number;
  unsupportedValueRows: number;
  readOverflow: boolean;
  processedRows: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type QuerySessionAccumulator = Pick<
  RecordQuerySessionState,
  | "lastTuple"
  | "totals"
  | "invalidRows"
  | "ambiguousTimeRows"
  | "unsupportedValueRows"
  | "readOverflow"
  | "processedRows"
>;

type QueryCtx = { readonly client: ClientBase; readonly now: number };
type Epochs = {
  visibilityEpoch: number;
  activationEpoch: number;
  snapshotAt: number;
};

function invalid(
  message = "Record query cursor is invalid; restart the query",
): never {
  throw new Error(message);
}

function safeClock(value: unknown, name: string): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${name} must be a nonnegative safe integer`);
  return number;
}

function instant(value: unknown, name: string): number {
  if (!(value instanceof Date)) throw new Error(`${name} is corrupt`);
  return safeClock(value.getTime(), name);
}

function occurrenceInstant(value: unknown, name: string): number {
  const number = value instanceof Date ? value.getTime() : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < MIN_QUERY_TIME ||
    number > MAX_QUERY_TIME
  )
    throw new Error(`${name} is corrupt`);
  return number;
}

function occurrenceDate(value: unknown, name: string): string {
  const date = text(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${name} is corrupt`);
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== date
  )
    throw new Error(`${name} is corrupt`);
  return date;
}

function count(value: unknown, name: string): number {
  return safeClock(value, name);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is corrupt`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} is corrupt`);
  const result = value as string[];
  if (
    result.length > MAX_RECORD_QUERY_SOURCE_ACCOUNTS ||
    new Set(result).size !== result.length ||
    result.some((v, i) => i > 0 && result[i - 1]! > v)
  )
    throw new Error(`${name} is not canonical`);
  return [...result];
}

function totals(value: unknown): CurrencyTotal[] {
  if (!Array.isArray(value) || value.length > SUPPORTED_CURRENCIES.length)
    throw new Error("totals is corrupt");
  const result = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("totals is corrupt");
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.currency !== "string" ||
      typeof record.amount !== "string" ||
      validateCurrencyCode(record.currency) !== record.currency ||
      canonicalizeDecimal(record.amount) !== record.amount
    )
      throw new Error("totals is not canonical");
    return { currency: record.currency, amount: record.amount };
  });
  if (new Set(result.map((item) => item.currency)).size !== result.length)
    throw new Error("totals contains duplicate currencies");
  if (
    result.some(
      (item, index) => index > 0 && result[index - 1]!.currency > item.currency,
    )
  )
    throw new Error("totals is not canonical");
  return result;
}

function validateBinding(binding: AuthorizedRecordQueryBinding): void {
  for (const [name, value] of Object.entries({
    spaceId: binding.spaceId,
    userId: binding.userId,
    membershipId: binding.membershipId,
    authorizationSignature: binding.authorizationSignature,
    normalizedFilter: binding.normalizedFilter,
  }))
    text(value, name);
  if (binding.credentialId !== undefined)
    text(binding.credentialId, "credentialId");
  if (
    !["observation_history", "list_events", "sum_money"].includes(
      binding.operation,
    )
  )
    throw new Error("operation is invalid");
  if (binding.consistency !== "snapshot" && binding.consistency !== "current")
    throw new Error("consistency is invalid");
  stringArray(binding.sourceAccountIds, "sourceAccountIds");
}

function validateAccumulator(value: QuerySessionAccumulator): void {
  const tuple = value.lastTuple;
  occurrenceDate(tuple.occurrenceDate, "lastTuple.occurrenceDate");
  if (
    tuple.occurrencePrecision !== "date" &&
    tuple.occurrencePrecision !== "datetime"
  )
    throw new Error("lastTuple.occurrencePrecision is invalid");
  if (tuple.occurrencePrecision === "datetime") {
    if (tuple.occurrenceInstant === undefined)
      throw new Error("lastTuple.occurrenceInstant is required");
    occurrenceInstant(tuple.occurrenceInstant, "lastTuple.occurrenceInstant");
  } else if (tuple.occurrenceInstant !== undefined) {
    throw new Error(
      "lastTuple.occurrenceInstant is invalid for date precision",
    );
  }
  text(tuple.sortKey, "lastTuple.sortKey");
  text(tuple.stableId, "lastTuple.stableId");
  totals(value.totals);
  count(value.invalidRows, "invalidRows");
  count(value.ambiguousTimeRows, "ambiguousTimeRows");
  count(value.unsupportedValueRows, "unsupportedValueRows");
  count(value.processedRows, "processedRows");
  if (typeof value.readOverflow !== "boolean")
    throw new Error("readOverflow is invalid");
}

async function lockedEpochs(
  ctx: QueryCtx,
  spaceId: string,
): Promise<{
  processing?: Record<string, unknown>;
  query?: Record<string, unknown>;
}> {
  const processing = await ctx.client.query(
    `SELECT * FROM kith.space_processing_state WHERE space_id=$1
     ORDER BY created_at,id LIMIT 2 FOR UPDATE`,
    [spaceId],
  );
  if (processing.rows.length > 1)
    throw new Error("Duplicate space processing state");
  const query = await ctx.client.query(
    `SELECT * FROM kith.record_query_space_state WHERE space_id=$1
     ORDER BY created_at,id LIMIT 2 FOR UPDATE`,
    [spaceId],
  );
  if (query.rows.length > 1)
    throw new Error("Duplicate record query space state");
  return { processing: processing.rows[0], query: query.rows[0] };
}

function epochsFromRows(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof lockedEpochs>>,
): Epochs {
  const activationEpoch = state.processing
    ? count(state.processing.activation_epoch, "activationEpoch")
    : 0;
  const visibilityEpoch = state.query
    ? count(state.query.visibility_epoch, "visibilityEpoch")
    : 0;
  const activatedAt = state.processing
    ? instant(state.processing.activated_at, "activatedAt")
    : ctx.now;
  const snapshotClock = state.query
    ? safeClock(state.query.snapshot_clock, "snapshotClock")
    : ctx.now;
  return {
    activationEpoch,
    visibilityEpoch,
    snapshotAt: Math.max(safeClock(ctx.now, "now"), activatedAt, snapshotClock),
  };
}

/** Reserves a snapshot after locking processing state before query state. */
export async function beginRecordQuerySnapshot(
  ctx: QueryCtx,
  binding: AuthorizedRecordQueryBinding,
): Promise<Epochs> {
  validateBinding(binding);
  const state = await lockedEpochs(ctx, binding.spaceId);
  const epochs = epochsFromRows(ctx, state);
  if (state.query) {
    if (
      safeClock(state.query.snapshot_clock, "snapshotClock") !==
      epochs.snapshotAt
    )
      await ctx.client.query(
        "UPDATE kith.record_query_space_state SET snapshot_clock=$1,updated_at=$2 WHERE id=$3",
        [epochs.snapshotAt, at(ctx.now), state.query.id],
      );
  } else {
    await ctx.client.query(
      `INSERT INTO kith.record_query_space_state
       (id,space_id,created_at,visibility_epoch,snapshot_clock,updated_at)
       VALUES ($1,$2,transaction_timestamp(),0,$3,$4)`,
      [newKithId(), binding.spaceId, epochs.snapshotAt, at(ctx.now)],
    );
  }
  return epochs;
}

/**
 * Invalidates every older session before forget cleanup proceeds. The caller
 * must freshly authorize the enclosing forget operation, not only a query read.
 */
export async function invalidateRecordQueriesForForget(
  ctx: QueryCtx,
  binding: AuthorizedRecordQueryBinding,
): Promise<{ visibilityEpoch: number }> {
  validateBinding(binding);
  safeClock(ctx.now, "now");
  const exists = await ctx.client.query(
    "SELECT 1 FROM kith.spaces WHERE id=$1",
    [binding.spaceId],
  );
  if (exists.rows.length !== 1) throw new Error("Space not found");
  const state = await lockedEpochs(ctx, binding.spaceId);
  const prior = state.query
    ? count(state.query.visibility_epoch, "visibilityEpoch")
    : 0;
  const visibilityEpoch = prior + 1;
  safeClock(visibilityEpoch, "visibilityEpoch");
  if (state.query) {
    await ctx.client.query(
      "UPDATE kith.record_query_space_state SET visibility_epoch=$1,updated_at=$2 WHERE id=$3",
      [visibilityEpoch, at(ctx.now), state.query.id],
    );
  } else {
    await ctx.client.query(
      `INSERT INTO kith.record_query_space_state
       (id,space_id,created_at,visibility_epoch,snapshot_clock,updated_at)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5)`,
      [
        newKithId(),
        binding.spaceId,
        visibilityEpoch,
        safeClock(ctx.now, "now"),
        at(ctx.now),
      ],
    );
  }
  return { visibilityEpoch };
}

/** The caller must carry the same freshly authorized forget scope as invalidation. */
export async function purgeRecordQuerySessionsForSpaceBatch(
  ctx: QueryCtx,
  binding: AuthorizedRecordQueryBinding,
  limit = MAX_QUERY_SESSION_CLEANUP_ROWS,
): Promise<{ deleted: number; done: boolean }> {
  validateBinding(binding);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_QUERY_SESSION_CLEANUP_ROWS
  )
    throw new Error("Query session cleanup limit is invalid");
  const state = await lockedEpochs(ctx, binding.spaceId);
  if (
    !state.query ||
    count(state.query.visibility_epoch, "visibilityEpoch") === 0
  )
    return { deleted: 0, done: true };
  const visibilityEpoch = count(
    state.query.visibility_epoch,
    "visibilityEpoch",
  );
  const found = await ctx.client.query<{ id: string }>(
    `SELECT id FROM kith.record_query_sessions
     WHERE space_id=$1 AND visibility_epoch < $2
     ORDER BY visibility_epoch,expires_at,id LIMIT $3 FOR UPDATE`,
    [binding.spaceId, visibilityEpoch, limit + 1],
  );
  const selected = found.rows.slice(0, limit);
  if (selected.length)
    await ctx.client.query(
      "DELETE FROM kith.record_query_sessions WHERE id=ANY($1::kith.kith_id[])",
      [selected.map((row) => row.id)],
    );
  return { deleted: selected.length, done: found.rows.length <= limit };
}

async function deleteExpiredLocked(
  ctx: QueryCtx,
  binding: AuthorizedRecordQueryBinding,
): Promise<number> {
  const deleted = await ctx.client.query(
    `DELETE FROM kith.record_query_sessions WHERE id IN (
       SELECT id FROM kith.record_query_sessions
       WHERE user_id=$1 AND space_id=$2 AND expires_at <= $3
       ORDER BY expires_at,id LIMIT $4 FOR UPDATE
     )`,
    [
      binding.userId,
      binding.spaceId,
      at(ctx.now),
      MAX_QUERY_SESSION_CLEANUP_ROWS,
    ],
  );
  return deleted.rowCount ?? 0;
}

/** Deletes one bounded page of expired sessions in an authorized user-space. */
export async function deleteExpiredRecordQuerySessions(
  ctx: QueryCtx,
  binding: AuthorizedRecordQueryBinding,
): Promise<number> {
  validateBinding(binding);
  safeClock(ctx.now, "now");
  await lockedEpochs(ctx, binding.spaceId);
  return deleteExpiredLocked(ctx, binding);
}

function rowToSession(row: Record<string, unknown>): RecordQuerySessionState {
  const credentialId =
    row.credential_id === null
      ? undefined
      : text(row.credential_id, "credentialId");
  const cursorInstant =
    row.last_occurrence_instant === null
      ? undefined
      : occurrenceInstant(row.last_occurrence_instant, "lastOccurrenceInstant");
  const operation = text(row.operation, "operation") as RecordQueryOperation;
  const consistency = text(
    row.consistency,
    "consistency",
  ) as RecordQueryConsistency;
  const session: RecordQuerySessionState = {
    id: text(row.id, "id"),
    binding: {
      spaceId: text(row.space_id, "spaceId"),
      userId: text(row.user_id, "userId"),
      ...(credentialId === undefined ? {} : { credentialId }),
      membershipId: text(row.membership_id, "membershipId"),
      authorizationSignature: text(
        row.authorization_signature,
        "authorizationSignature",
      ),
      operation,
      consistency,
      normalizedFilter: text(row.normalized_filter, "normalizedFilter"),
      sourceAccountIds: stringArray(row.source_account_ids, "sourceAccountIds"),
    },
    snapshotAt: instant(row.snapshot_at, "snapshotAt"),
    activationEpoch: count(row.activation_epoch, "activationEpoch"),
    visibilityEpoch: count(row.visibility_epoch, "visibilityEpoch"),
    lastTuple: {
      occurrenceDate: text(row.last_occurrence_date, "lastOccurrenceDate"),
      occurrencePrecision: text(
        row.last_occurrence_precision,
        "lastOccurrencePrecision",
      ) as "date" | "datetime",
      ...(cursorInstant === undefined
        ? {}
        : { occurrenceInstant: cursorInstant }),
      sortKey: text(row.last_sort_key, "lastSortKey"),
      stableId: text(row.last_stable_id, "lastStableId"),
    },
    totals: totals(row.totals),
    invalidRows: count(row.invalid_rows, "invalidRows"),
    ambiguousTimeRows: count(row.ambiguous_time_rows, "ambiguousTimeRows"),
    unsupportedValueRows: count(
      row.unsupported_value_rows,
      "unsupportedValueRows",
    ),
    readOverflow: row.read_overflow as boolean,
    processedRows: count(row.processed_rows, "processedRows"),
    createdAt: instant(row.created_at_field, "createdAt"),
    updatedAt: instant(row.updated_at, "updatedAt"),
    expiresAt: instant(row.expires_at, "expiresAt"),
  };
  validateBinding(session.binding);
  validateAccumulator(session);
  return session;
}

function sameBinding(
  left: AuthorizedRecordQueryBinding,
  right: AuthorizedRecordQueryBinding,
): boolean {
  return (
    left.spaceId === right.spaceId &&
    left.userId === right.userId &&
    left.credentialId === right.credentialId &&
    left.membershipId === right.membershipId &&
    left.authorizationSignature === right.authorizationSignature &&
    left.operation === right.operation &&
    left.consistency === right.consistency &&
    left.normalizedFilter === right.normalizedFilter &&
    JSON.stringify(left.sourceAccountIds) ===
      JSON.stringify(right.sourceAccountIds)
  );
}

/** Loads and locks a single-use cursor, then rebinds it to fresh authorization. */
export async function resolveRecordQueryContext(
  ctx: QueryCtx,
  binding: AuthorizedRecordQueryBinding,
  cursorId?: string,
): Promise<{
  session?: RecordQuerySessionState;
  snapshot: Epochs & { consistency: RecordQueryConsistency };
}> {
  validateBinding(binding);
  if (cursorId === undefined) {
    const epochs = await beginRecordQuerySnapshot(ctx, binding);
    return { snapshot: { ...epochs, consistency: binding.consistency } };
  }
  // Keep the shared order used by worker publication and forget: processing
  // state, query state, then sessions. Holding the epoch rows also prevents an
  // activation or visibility change between validation and cursor replacement.
  const epochRows = await lockedEpochs(ctx, binding.spaceId);
  const found = await ctx.client.query(
    "SELECT * FROM kith.record_query_sessions WHERE id=$1 AND space_id=$2 FOR UPDATE",
    [cursorId, binding.spaceId],
  );
  if (found.rows.length !== 1) invalid();
  const session = rowToSession(found.rows[0]);
  if (!sameBinding(session.binding, binding) || ctx.now >= session.expiresAt)
    invalid();
  const epochs = epochsFromRows(ctx, epochRows);
  if (
    epochs.visibilityEpoch !== session.visibilityEpoch ||
    (session.binding.consistency === "current" &&
      epochs.activationEpoch !== session.activationEpoch)
  )
    invalid();
  return {
    session,
    snapshot: {
      snapshotAt: session.snapshotAt,
      activationEpoch: session.activationEpoch,
      visibilityEpoch: session.visibilityEpoch,
      consistency: session.binding.consistency,
    },
  };
}

/**
 * Persists a continuation after a bounded page scan. The caller owns one
 * `withKithTransaction`: authorize, begin or resolve the snapshot, read the
 * page, then create, advance or consume the cursor before that transaction
 * commits. Splitting those steps loses the authorization and snapshot lock.
 */
export async function createRecordQuerySession(
  ctx: QueryCtx,
  binding: AuthorizedRecordQueryBinding,
  snapshot: Epochs,
  accumulator: QuerySessionAccumulator,
): Promise<string> {
  validateBinding(binding);
  validateAccumulator(accumulator);
  safeClock(ctx.now, "now");
  safeClock(snapshot.snapshotAt, "snapshotAt");
  count(snapshot.activationEpoch, "activationEpoch");
  count(snapshot.visibilityEpoch, "visibilityEpoch");
  const state = await lockedEpochs(ctx, binding.spaceId);
  if (!state.query) throw new Error("Record query snapshot was not reserved");
  const current = epochsFromRows(ctx, state);
  const reservedSnapshot = safeClock(
    state.query.snapshot_clock,
    "snapshotClock",
  );
  if (
    snapshot.snapshotAt > reservedSnapshot ||
    snapshot.activationEpoch > current.activationEpoch ||
    snapshot.visibilityEpoch !== current.visibilityEpoch ||
    (binding.consistency === "current" &&
      snapshot.activationEpoch !== current.activationEpoch)
  )
    throw new Error("Record query snapshot is invalid");
  await deleteExpiredLocked(ctx, binding);
  const active = await ctx.client.query(
    `SELECT id FROM kith.record_query_sessions
     WHERE user_id=$1 AND space_id=$2 AND expires_at > $3
     ORDER BY expires_at,id LIMIT $4 FOR UPDATE`,
    [
      binding.userId,
      binding.spaceId,
      at(ctx.now),
      MAX_ACTIVE_RECORD_QUERY_SESSIONS + 1,
    ],
  );
  if (active.rows.length >= MAX_ACTIVE_RECORD_QUERY_SESSIONS)
    throw new Error("Too many active record query sessions");
  const id = newKithId();
  const expiresAt = ctx.now + RECORD_QUERY_SESSION_TTL_MS;
  safeClock(expiresAt, "expiresAt");
  await insertSession(
    ctx,
    id,
    binding,
    snapshot,
    accumulator,
    ctx.now,
    ctx.now,
    expiresAt,
  );
  return id;
}

async function insertSession(
  ctx: QueryCtx,
  id: string,
  binding: AuthorizedRecordQueryBinding,
  snapshot: Epochs,
  accumulator: QuerySessionAccumulator,
  createdAt: number,
  updatedAt: number,
  expiresAt: number,
): Promise<void> {
  await ctx.client.query(
    `INSERT INTO kith.record_query_sessions
     (id,space_id,created_at,user_id,credential_id,membership_id,
      authorization_signature,operation,consistency,normalized_filter,
      source_account_ids,snapshot_at,activation_epoch,visibility_epoch,
      last_occurrence_date,last_occurrence_precision,last_occurrence_instant,
      last_sort_key,last_stable_id,totals,invalid_rows,ambiguous_time_rows,
      unsupported_value_rows,read_overflow,processed_rows,created_at_field,
      updated_at,expires_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
      $11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [
      id,
      binding.spaceId,
      binding.userId,
      binding.credentialId ?? null,
      binding.membershipId,
      binding.authorizationSignature,
      binding.operation,
      binding.consistency,
      binding.normalizedFilter,
      JSON.stringify(binding.sourceAccountIds),
      at(snapshot.snapshotAt),
      snapshot.activationEpoch,
      snapshot.visibilityEpoch,
      accumulator.lastTuple.occurrenceDate,
      accumulator.lastTuple.occurrencePrecision,
      at(accumulator.lastTuple.occurrenceInstant),
      accumulator.lastTuple.sortKey,
      accumulator.lastTuple.stableId,
      JSON.stringify(accumulator.totals),
      accumulator.invalidRows,
      accumulator.ambiguousTimeRows,
      accumulator.unsupportedValueRows,
      accumulator.readOverflow,
      accumulator.processedRows,
      at(createdAt),
      at(updatedAt),
      at(expiresAt),
    ],
  );
}

/** Replaces the locked cursor while preserving the original absolute expiry. */
export async function advanceRecordQuerySession(
  ctx: QueryCtx,
  binding: AuthorizedRecordQueryBinding,
  cursorId: string,
  accumulator: QuerySessionAccumulator,
): Promise<string> {
  validateBinding(binding);
  validateAccumulator(accumulator);
  const session = (await resolveRecordQueryContext(ctx, binding, cursorId))
    .session!;
  if (ctx.now >= session.expiresAt)
    invalid("Record query cursor expired; restart the query");
  const nextId = newKithId();
  await insertSession(
    ctx,
    nextId,
    session.binding,
    {
      snapshotAt: session.snapshotAt,
      activationEpoch: session.activationEpoch,
      visibilityEpoch: session.visibilityEpoch,
    },
    accumulator,
    session.createdAt,
    ctx.now,
    session.expiresAt,
  );
  const deleted = await ctx.client.query(
    "DELETE FROM kith.record_query_sessions WHERE id=$1",
    [session.id],
  );
  if (deleted.rowCount !== 1) invalid();
  return nextId;
}

export async function consumeRecordQuerySession(
  ctx: QueryCtx,
  binding: AuthorizedRecordQueryBinding,
  cursorId: string,
): Promise<void> {
  validateBinding(binding);
  const session = (await resolveRecordQueryContext(ctx, binding, cursorId))
    .session!;
  const deleted = await ctx.client.query(
    "DELETE FROM kith.record_query_sessions WHERE id=$1",
    [session.id],
  );
  if (deleted.rowCount !== 1) invalid();
}
