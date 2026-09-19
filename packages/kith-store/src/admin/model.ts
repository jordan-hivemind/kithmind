// The admin panel's store surface (ADM-1, step 1 of section 10 of
// docs/plans/2026-09-18-admin-panel-and-ingestion.md).
//
// Shape follows `../sources/model.ts`, the nearest sibling: every function
// takes an `IdentityCtx` plus an already-authenticated `Principal`, resolves
// the space set itself, and carries its own space predicate on every
// statement rather than trusting a check made earlier in the call.
//
// What is here is what screen 2 (Sources) needs plus the row types the later
// screens will read: full CRUD for investments, entries, types, fields and
// corrections is the next task's, and adding it before a screen asks for it
// would be writing eight upserts nothing calls.

import {
  FS_ROOT_ALIAS,
  SOURCE_ROOT_REPORT_STATES,
  type SourceRootReportState,
} from "@repo/worker-protocol/request";

import {
  getAuthorizedReadSpaceIds,
  type Principal,
  requireSpaceAccess,
} from "../identity/authorization.js";
import { exec, type IdentityCtx, row, rows } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId, newKithId } from "../ids.js";
import { spacePredicate } from "../spaces.js";
import { watcherStaleness, type WatcherStaleness } from "../workers/diagnostics.js";

/** The same bound `listSourceAccounts` applies, for the same reason. */
const MAX_LISTED = 200;

const NAME_MAX_CHARS = 200;
const PATH_MAX_CHARS = 1024;

/** Section 5: the closed list of source root kinds. */
export const SOURCE_ROOT_KINDS = [
  "folder",
  "institution",
  "manual",
] as const;
export type SourceRootKind = (typeof SOURCE_ROOT_KINDS)[number];

export const SOURCE_ROOT_STATES = [
  "active",
  "paused",
  "problem",
  "retired",
] as const;
export type SourceRootState = (typeof SOURCE_ROOT_STATES)[number];

/** Section 5: the closed list of value types a document type field may hold. */
export const DOCUMENT_FIELD_VALUE_TYPES = [
  "text",
  "organization",
  "person",
  "date",
  "money",
  "number",
  "identifier",
  "line_item_list",
] as const;
export type DocumentFieldValueType =
  (typeof DOCUMENT_FIELD_VALUE_TYPES)[number];

export const DOCUMENT_FIELD_CHECKS = [
  "on_page",
  "exact",
  "sums_to_total",
] as const;
export type DocumentFieldCheck = (typeof DOCUMENT_FIELD_CHECKS)[number];

/**
 * Section 5's entry types, as one closed list. Kept in step with
 * `investment_entries_entry_type_check` in `migrations/022_admin_panel.sql`:
 * the two are one convention written twice, the same relationship `KITH_ID`
 * has with its own domain CHECK.
 */
export const INVESTMENT_ENTRY_TYPES = [
  "capital_call_paid",
  "distribution",
  "commitment",
  "commitment_change",
  "fee",
  "write_off",
  "other",
] as const;
export type InvestmentEntryType = (typeof INVESTMENT_ENTRY_TYPES)[number];

export const INVESTMENT_STATUSES = ["active", "closed", "written_off"] as const;
export type InvestmentStatus = (typeof INVESTMENT_STATUSES)[number];

export const CORRECTION_TARGET_KINDS = [
  "document",
  "field",
  "record",
] as const;
export type CorrectionTargetKind = (typeof CORRECTION_TARGET_KINDS)[number];

// ---------------------------------------------------------------------------
// Row types. Defined now, read by the screens that land next; `amount` is a
// string because `numeric` is exact and every float round trip is a lost cent.
// ---------------------------------------------------------------------------

export type DocumentType = {
  id: string;
  spaceId: string;
  kind: string;
  description: string | null;
  area: string | null;
  guidance: string | null;
  examples: unknown[];
  version: number;
  active: boolean;
};

export type DocumentTypeField = {
  id: string;
  spaceId: string;
  documentTypeId: string;
  name: string;
  valueType: DocumentFieldValueType;
  required: boolean;
  check: DocumentFieldCheck | null;
  example: string | null;
};

export type SourceRoot = {
  id: string;
  spaceId: string;
  sourceAccountId: string;
  kind: SourceRootKind;
  /** One of the watcher host's allow-listed top-level directories. */
  rootAlias: string | null;
  /** Where under that directory this root is. Never absolute, never upward. */
  relativePath: string | null;
  providerFolderId: string | null;
  lastKnownPath: string | null;
  expectedTypes: string[];
  area: string | null;
  state: SourceRootState;
  /** The latest `source_root_reports` row for this root, or nulls. */
  reportState: SourceRootReportState | null;
  reportedAt: number | null;
  reportItemCount: number | null;
};

export type SourceRootReport = {
  id: string;
  spaceId: string;
  sourceRootId: string;
  watcherId: string | null;
  observedAt: number;
  availableFolders: string[];
  itemCount: number;
  skipped: { path: string; reason: string }[];
  problem: string | null;
};

export type Investment = {
  id: string;
  spaceId: string;
  entityId: string | null;
  name: string;
  category: string | null;
  signedOn: string | null;
  status: InvestmentStatus;
  notes: string | null;
};

export type InvestmentEntry = {
  id: string;
  spaceId: string;
  investmentId: string;
  entryType: InvestmentEntryType;
  entryDate: string;
  /** Exact decimal text, never a number. `numeric` in, `numeric` out. */
  amount: string;
  currency: string;
  exchangeRate: string | null;
  note: string | null;
  documentId: string | null;
  evidenceSpanId: string | null;
};

export type Correction = {
  id: string;
  spaceId: string;
  targetKind: CorrectionTargetKind;
  targetId: string;
  fieldName: string | null;
  originalValue: unknown;
  correctedValue: unknown;
  actorUserId: string | null;
  reason: string | null;
  state: "open" | "resolved";
  createdAt: number;
  resolvedAt: number | null;
};

/** One row of screen 2: every folder, institution and manual source. */
export type SourceInventoryRow = {
  id: string;
  spaceId: string;
  name: string;
  connector: string;
  accountId: string;
  enabled: boolean;
  /** Null until a root row gives the source an area. */
  area: string | null;
  kind: SourceRootKind | null;
  location: string | null;
  itemCount: number;
  skippedCount: number;
  lastReadAt: number | null;
  watcher: WatcherStaleness;
  problem: string | null;
  status: "disabled" | "problem" | "overdue" | "pending" | "ok";
};

function typedError(code: string, message: string): never {
  throw new IdentityError(message, { code, message });
}

/** Bare and non-enumerating, exactly as `../sources/model.ts` is. */
function sourceAccountNotFound(): never {
  throw new IdentityError("Source account not found");
}

function sourceRootNotFound(): never {
  throw new IdentityError("Source root not found");
}

function boundedText(
  value: string,
  name: string,
  maximum: number,
): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).length > maximum ||
    value.includes("\0")
  ) {
    typedError("invalid_input", `${name} is empty, malformed or too long`);
  }
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    typedError("invalid_input", `${name} is not a known value`);
  }
  return value as T;
}

/**
 * ADM-4b. A root's location, as the owner may type it and as the watcher host
 * must be able to resolve it.
 *
 * The host keeps its own list of top-level directories it may read (section 6
 * of the plan: "A database row can never point it outside them"), and a root
 * names one of them by alias. Everything after the alias is relative to it, so
 * the only paths that can be stored are ones that stay inside:
 *
 *   * no absolute path -- a leading `/` makes an empty first segment;
 *   * no `.` or `..` segment, in any position;
 *   * no empty segment, so no `//` and no trailing slash;
 *   * no control character and no backslash, which is a separator on the
 *     platform this path may one day be resolved on and is not one here.
 *
 * `FS_ROOT_ALIAS` is the worker protocol's own pattern, imported rather than
 * copied: the alias here and the alias in the `fs://<alias>/<path>` URI of
 * every item the watcher reports under this root are the same name.
 */
export function assertSourceRootLocation(
  rootAlias: string,
  relativePath: string,
): { rootAlias: string; relativePath: string } {
  if (typeof rootAlias !== "string" || !FS_ROOT_ALIAS.test(rootAlias)) {
    typedError("invalid_root_alias", "Root alias is not a known host root");
  }
  if (
    typeof relativePath !== "string" ||
    new TextEncoder().encode(relativePath).length > PATH_MAX_CHARS ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\\]/.test(relativePath)
  ) {
    typedError("invalid_root_path", "Path is empty, malformed or too long");
  }
  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    typedError("invalid_root_path", "Path must be relative to the host root");
  }
  return { rootAlias, relativePath: segments.join("/") };
}

function textArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    typedError("invalid_input", `${name} must be a list of strings`);
  }
  return value as string[];
}

function epoch(value: Date | string | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * The spaces this principal may administer: the ones it can read, narrowed to
 * the ones it can write.
 *
 * Every admin screen reads through this rather than through
 * `getAuthorizedReadSpaceIds`, because the admin panel is a different kind of
 * read from the ones a `reader` member is entitled to. A source row carries
 * the watcher host's filesystem path, the problem text the host reported and
 * the account's own id -- operational detail about how the household's records
 * are collected, not the records themselves. `acceptsRole` in
 * `../identity/authorization.ts` already draws that line for writes: only an
 * `owner` or an `editor` passes a `"write"` check. This reuses it rather than
 * inventing a second notion of who runs the system.
 *
 * A reader gets an empty set, which every caller below turns into an empty
 * result, and which `apps/web`'s `/admin` layout turns into a 404.
 */
export async function getAdminSpaceIds(
  ctx: IdentityCtx,
  principal: Principal,
  explicitSpaceIds?: readonly string[],
): Promise<string[]> {
  const readable = await getAuthorizedReadSpaceIds(
    ctx,
    principal,
    explicitSpaceIds,
  );
  const administered: string[] = [];
  for (const spaceId of readable) {
    try {
      await requireSpaceAccess(ctx, principal, spaceId, "write");
      administered.push(spaceId);
    } catch {
      // A space this principal only reads is absent from the result, not an
      // error: the same rule `getAuthorizedReadSpaceIds` applies one level up.
    }
  }
  return administered;
}

type SourceInventoryDbRow = {
  id: string;
  space_id: string;
  name: string | null;
  connector: string | null;
  account_id: string | null;
  enabled: boolean | null;
  last_enumerated_at: Date | null;
  last_processed_at: Date | null;
  root_kind: string | null;
  area: string | null;
  last_known_path: string | null;
  root_state: string | null;
  watcher_state: string | null;
  next_expected_at: Date | null;
  item_count: string | number;
  skipped_count: number | null;
  reported_at: Date | null;
  problem: string | null;
  report_state: string | null;
};

/**
 * Screen 2, read-only: every source account in the caller's administered
 * spaces with the four things the screen shows beside its name -- where it points
 * (its root), how much it holds (its items), when it was last read, and
 * whether the host watching it is still reporting.
 *
 * Every join carries `space_id` as well as the id, so a root, a report or a
 * watcher row belonging to another space cannot attach itself to an account
 * here even if one were somehow written. The composite foreign keys in
 * migration 022 make that unrepresentable; these predicates mean the read does
 * not depend on that being true.
 */
export async function listSourcesInventory(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceIds?: readonly string[] },
): Promise<SourceInventoryRow[]> {
  const spaces = await getAdminSpaceIds(ctx, args.principal, args.spaceIds);
  if (spaces.length === 0) return [];
  const predicate = spacePredicate(spaces, 1, "a.space_id");
  const records = await rows<SourceInventoryDbRow>(
    ctx,
    `SELECT a.id, a.space_id, a.name, a.connector, a.account_id, a.enabled,
            a.last_enumerated_at, a.last_processed_at,
            r.kind AS root_kind, r.area, r.last_known_path,
            r.state AS root_state,
            w.state AS watcher_state, w.next_expected_at,
            (SELECT count(*) FROM kith.source_items i
               WHERE i.source_account_id = a.id
                 AND i.space_id = a.space_id
                 AND i.forgotten_at IS NULL) AS item_count,
            jsonb_array_length(p.skipped) AS skipped_count,
            p.observed_at AS reported_at,
            p.problem, p.state AS report_state
       FROM kith.source_accounts a
       -- One row per account, not per root. An account may have several roots
       -- since migration 028, and a plain join would repeat the account once
       -- per folder; the screen shows the roots as rows of their own, read by
       -- listSourceRoots. The account's own root columns are its first root,
       -- which is what they were when an account could only have one.
       LEFT JOIN LATERAL (
         SELECT y.id, y.kind, y.area, y.last_known_path, y.state
           FROM kith.source_roots y
          WHERE y.source_account_id = a.id AND y.space_id = a.space_id
          ORDER BY y.created_at, y.id
          LIMIT 1
       ) r ON true
       LEFT JOIN kith.worker_watcher_states w
         ON w.source_account_id = a.id AND w.space_id = a.space_id
       LEFT JOIN LATERAL (
         SELECT q.skipped, q.observed_at, q.problem, q.state
           FROM kith.source_root_reports q
          WHERE q.source_root_id = r.id AND q.space_id = a.space_id
          ORDER BY q.observed_at DESC, q.id DESC
          LIMIT 1
       ) p ON true
      WHERE ${predicate.sql}
      ORDER BY a.space_id, a.id
      LIMIT $2`,
    [predicate.value, MAX_LISTED + 1],
  );
  if (records.length > MAX_LISTED) {
    typedError("source_limit", "Too many sources; filter spaces");
  }
  return records.map((record) => toInventoryRow(record, ctx.now));
}

function toInventoryRow(
  record: SourceInventoryDbRow,
  now: number,
): SourceInventoryRow {
  const watcher = watcherStaleness(
    record.watcher_state === null
      ? undefined
      : {
          state: record.watcher_state as "awaiting_heartbeat" | "active",
          nextExpectedAt: record.next_expected_at,
        },
    now,
  );
  // The watcher's closed state is the problem text when it did not write one:
  // the status pill's tooltip should say `unreadable` rather than nothing.
  const problem =
    record.problem ??
    (record.report_state !== null && record.report_state !== "ok"
      ? record.report_state
      : null);
  const lastReadAt =
    epoch(record.last_processed_at) ??
    epoch(record.last_enumerated_at) ??
    epoch(record.reported_at);
  return {
    id: record.id,
    spaceId: record.space_id,
    name: record.name ?? "",
    connector: record.connector ?? "",
    accountId: record.account_id ?? "",
    enabled: record.enabled ?? false,
    area: record.area,
    kind: (record.root_kind as SourceRootKind | null) ?? null,
    location: record.last_known_path,
    itemCount: Number(record.item_count ?? 0),
    skippedCount: record.skipped_count ?? 0,
    lastReadAt,
    watcher,
    problem,
    status: inventoryStatus(record, watcher, problem),
  };
}

/**
 * One label per source, most serious first. "Plain status" (screen 1) means a
 * word, not a score: disabled beats everything because nothing else is
 * supposed to happen; a reported problem or a root in the `problem` state beats
 * a late watcher because it says what is wrong; a late watcher beats a watcher
 * that has never reported, which is `pending` rather than a failure because a
 * source configured a minute ago has not had a pass yet.
 */
function inventoryStatus(
  record: SourceInventoryDbRow,
  watcher: WatcherStaleness,
  problem: string | null,
): SourceInventoryRow["status"] {
  if (record.enabled !== true) return "disabled";
  if (
    problem !== null ||
    record.root_state === "problem" ||
    // A watcher that reported `missing`, `unreadable` or `over_limit` for this
    // account's root has said what is wrong without writing prose about it
    // (migration 028); the row is a problem either way.
    (record.report_state !== null && record.report_state !== "ok")
  ) {
    return "problem";
  }
  if (watcher === "overdue") return "overdue";
  if (watcher === "not_configured" || watcher === "awaiting_heartbeat") {
    return "pending";
  }
  return "ok";
}

type SourceRootDbRow = {
  id: string;
  space_id: string;
  source_account_id: string;
  kind: string;
  root_alias: string | null;
  relative_path: string | null;
  provider_folder_id: string | null;
  last_known_path: string | null;
  expected_types: unknown;
  area: string | null;
  state: string;
  report_state: string | null;
  reported_at: Date | null;
  report_item_count: number | string | null;
};

function toSourceRoot(record: SourceRootDbRow): SourceRoot {
  return {
    id: record.id,
    spaceId: record.space_id,
    sourceAccountId: record.source_account_id,
    kind: record.kind as SourceRootKind,
    rootAlias: record.root_alias,
    relativePath: record.relative_path,
    providerFolderId: record.provider_folder_id,
    lastKnownPath: record.last_known_path,
    expectedTypes: Array.isArray(record.expected_types)
      ? (record.expected_types as string[])
      : [],
    area: record.area,
    state: record.state as SourceRootState,
    reportState: (record.report_state as SourceRootReportState | null) ?? null,
    reportedAt: epoch(record.reported_at),
    reportItemCount:
      record.report_item_count === null || record.report_item_count === undefined
        ? null
        : Number(record.report_item_count),
  };
}

/**
 * The desired list the watcher pulls each pass (section 5), with the latest
 * thing the watcher host said about each root.
 *
 * The report is joined here rather than fetched per row because the sources
 * screen renders one pill per root from it, and a screen that issued one query
 * per root would issue as many as the owner has folders.
 */
export async function listSourceRoots(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceIds?: readonly string[] },
): Promise<SourceRoot[]> {
  const spaces = await getAdminSpaceIds(ctx, args.principal, args.spaceIds);
  if (spaces.length === 0) return [];
  const predicate = spacePredicate(spaces, 1, "r.space_id");
  const records = await rows<SourceRootDbRow>(
    ctx,
    `SELECT r.id, r.space_id, r.source_account_id, r.kind, r.root_alias,
            r.relative_path, r.provider_folder_id, r.last_known_path,
            r.expected_types, r.area, r.state,
            p.state AS report_state, p.observed_at AS reported_at,
            p.item_count AS report_item_count
       FROM kith.source_roots r
       LEFT JOIN LATERAL (
         SELECT q.state, q.observed_at, q.item_count
           FROM kith.source_root_reports q
          WHERE q.source_root_id = r.id AND q.space_id = r.space_id
          ORDER BY q.observed_at DESC, q.id DESC
          LIMIT 1
       ) p ON true
      WHERE ${predicate.sql}
      ORDER BY r.space_id, r.source_account_id, r.created_at, r.id LIMIT $2`,
    [predicate.value, MAX_LISTED + 1],
  );
  if (records.length > MAX_LISTED) {
    typedError("source_limit", "Too many source roots; filter spaces");
  }
  return records.map(toSourceRoot);
}

/**
 * One root of a source account, created or updated in place.
 *
 * An upsert rather than a create/update pair because the row is keyed by its
 * location (`source_roots_location_idx`, migration 028) and every caller --
 * the owner adding a folder in the UI, and the watcher writing back the path
 * it resolved this pass -- wants "make this location say this" rather than
 * "make one" or "change one". Adding the same folder twice is therefore the
 * same row twice, not a duplicate and not an error.
 *
 * Before migration 028 an account had exactly one root, so a caller that
 * passes no location still upserts that one row: `coalesce(alias, '')` in the
 * index covers it.
 *
 * Authorization is the two-step `updateSourceAccount` uses: load the account
 * by id, then check write access against the space the row itself names. A
 * missing account and an account in a space the caller cannot write are the
 * same denial, so neither can be used to enumerate the other's ids.
 */
export async function upsertSourceRoot(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    sourceAccountId: string;
    kind: SourceRootKind;
    rootAlias?: string | null;
    relativePath?: string | null;
    providerFolderId?: string | null;
    lastKnownPath?: string | null;
    expectedTypes?: readonly string[];
    area?: string | null;
    state?: SourceRootState;
  },
): Promise<string> {
  const sourceAccountId = assertKithId(
    args.sourceAccountId,
    "invalid_source_account_id",
  );
  const kind = oneOf(args.kind, SOURCE_ROOT_KINDS, "Kind");
  const state =
    args.state === undefined
      ? "active"
      : oneOf(args.state, SOURCE_ROOT_STATES, "State");
  const expectedTypes = textArray(args.expectedTypes ?? [], "Expected types");
  if (args.area !== undefined && args.area !== null) {
    boundedText(args.area, "Area", 100);
  }
  if (args.lastKnownPath !== undefined && args.lastKnownPath !== null) {
    boundedText(args.lastKnownPath, "Path", PATH_MAX_CHARS);
  }
  // Both or neither: half a location is one the watcher host cannot resolve.
  const hasAlias = args.rootAlias !== undefined && args.rootAlias !== null;
  const hasPath = args.relativePath !== undefined && args.relativePath !== null;
  if (hasAlias !== hasPath) {
    typedError("invalid_root_path", "A root needs both an alias and a path");
  }
  const location = hasAlias
    ? assertSourceRootLocation(args.rootAlias!, args.relativePath!)
    : null;

  const account = await row<{ space_id: string }>(
    ctx,
    "SELECT space_id FROM kith.source_accounts WHERE id = $1",
    [sourceAccountId],
  );
  if (!account) sourceAccountNotFound();
  try {
    await requireSpaceAccess(ctx, args.principal, account.space_id, "write");
  } catch {
    sourceAccountNotFound();
  }

  const existing = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.source_roots
      WHERE source_account_id = $1 AND space_id = $2
        AND coalesce(root_alias, '') = $3
        AND coalesce(relative_path, '') = $4`,
    [
      sourceAccountId,
      account.space_id,
      location?.rootAlias ?? "",
      location?.relativePath ?? "",
    ],
  );
  const id = existing?.id ?? newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.source_roots
       (id, space_id, source_account_id, kind, root_alias, relative_path,
        provider_folder_id, last_known_path, expected_types, area, state,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $12)
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind,
       root_alias = EXCLUDED.root_alias,
       relative_path = EXCLUDED.relative_path,
       provider_folder_id = EXCLUDED.provider_folder_id,
       last_known_path = EXCLUDED.last_known_path,
       expected_types = EXCLUDED.expected_types,
       area = EXCLUDED.area,
       state = EXCLUDED.state,
       updated_at = EXCLUDED.updated_at`,
    [
      id,
      account.space_id,
      sourceAccountId,
      kind,
      location?.rootAlias ?? null,
      location?.relativePath ?? null,
      args.providerFolderId ?? null,
      args.lastKnownPath ?? null,
      JSON.stringify(expectedTypes),
      args.area ?? null,
      state,
      new Date(ctx.now),
    ],
  );
  return id;
}

/**
 * One root's row, with write access to its space required.
 *
 * The same two-step `upsertSourceRoot` uses, on the root instead of the
 * account: load by id, then check. A root in another space and a root that
 * does not exist are one denial.
 */
async function requireWritableRoot(
  ctx: IdentityCtx,
  principal: Principal,
  sourceRootId: string,
): Promise<{ id: string; spaceId: string }> {
  const id = assertKithId(sourceRootId, "invalid_source_root_id");
  const root = await row<{ space_id: string }>(
    ctx,
    "SELECT space_id FROM kith.source_roots WHERE id = $1",
    [id],
  );
  if (!root) sourceRootNotFound();
  try {
    await requireSpaceAccess(ctx, principal, root.space_id, "write");
  } catch {
    sourceRootNotFound();
  }
  return { id, spaceId: root.space_id };
}

/**
 * Pause or resume one root (the kebab's first two actions).
 *
 * Only `active` and `paused` are settable here. `problem` is a conclusion the
 * watcher's reports produce and `retired` is the end of a root's life, and
 * neither is a thing a menu item should be able to assert.
 */
export async function setSourceRootState(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    sourceRootId: string;
    state: "active" | "paused";
  },
): Promise<void> {
  const state = oneOf(args.state, ["active", "paused"] as const, "State");
  const root = await requireWritableRoot(
    ctx,
    args.principal,
    args.sourceRootId,
  );
  await exec(
    ctx,
    `UPDATE kith.source_roots SET state = $1, updated_at = $2
      WHERE id = $3 AND space_id = $4`,
    [state, new Date(ctx.now), root.id, root.spaceId],
  );
}

/**
 * Remove one root (the kebab's third action).
 *
 * It deletes the configuration row and the reports about it, and nothing else:
 * documents, source items, evidence and the archived originals are keyed by
 * source account and are not reachable from here. Un-watching a folder is
 * forgetting where to look, never forgetting what was found there -- section 6
 * of the plan, where even a deleted folder "shows a problem in the UI. Nothing
 * is deleted."
 */
export async function deleteSourceRoot(
  ctx: IdentityCtx,
  args: { principal: Principal; sourceRootId: string },
): Promise<void> {
  const root = await requireWritableRoot(
    ctx,
    args.principal,
    args.sourceRootId,
  );
  await exec(
    ctx,
    "DELETE FROM kith.source_roots WHERE id = $1 AND space_id = $2",
    [root.id, root.spaceId],
  );
}

/**
 * One pass's report from the watcher host (section 5, `source_root_reports`).
 *
 * `observed_at` is the pass's own clock and also the row's identity within the
 * root (`source_root_reports_latest_idx`), so a retried write of the same pass
 * replaces it rather than adding a second row the "latest report" read would
 * have to choose between.
 */
export async function upsertSourceRootReport(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    sourceRootId: string;
    watcherId?: string | null;
    observedAt?: number;
    availableFolders?: readonly string[];
    itemCount?: number;
    skipped?: readonly { path: string; reason: string }[];
    problem?: string | null;
    /** What the pass saw (migration 028). The worker's own write path is
     * `source.rootReport`; this is the same column from the admin side. */
    state?: SourceRootReportState;
  },
): Promise<string> {
  const sourceRootId = assertKithId(args.sourceRootId, "invalid_source_root_id");
  const state =
    args.state === undefined
      ? "ok"
      : oneOf(args.state, SOURCE_ROOT_REPORT_STATES, "Report state");
  const observedAt = args.observedAt ?? ctx.now;
  if (!Number.isSafeInteger(observedAt)) {
    typedError("invalid_input", "Observed at is not a timestamp");
  }
  const itemCount = args.itemCount ?? 0;
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    typedError("invalid_input", "Item count is not a count");
  }
  const availableFolders = textArray(
    args.availableFolders ?? [],
    "Available folders",
  );
  const skipped = (args.skipped ?? []).map((entry) => {
    boundedText(entry?.path ?? "", "Skipped path", PATH_MAX_CHARS);
    boundedText(entry?.reason ?? "", "Skipped reason", NAME_MAX_CHARS);
    return { path: entry.path, reason: entry.reason };
  });

  const root = await row<{ space_id: string }>(
    ctx,
    "SELECT space_id FROM kith.source_roots WHERE id = $1",
    [sourceRootId],
  );
  if (!root) sourceRootNotFound();
  try {
    await requireSpaceAccess(ctx, args.principal, root.space_id, "write");
  } catch {
    sourceRootNotFound();
  }

  const existing = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.source_root_reports
      WHERE source_root_id = $1 AND space_id = $2 AND observed_at = $3`,
    [sourceRootId, root.space_id, new Date(observedAt)],
  );
  const id = existing?.id ?? newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.source_root_reports
       (id, space_id, source_root_id, watcher_id, observed_at,
        available_folders, item_count, skipped, problem, state)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       watcher_id = EXCLUDED.watcher_id,
       available_folders = EXCLUDED.available_folders,
       item_count = EXCLUDED.item_count,
       skipped = EXCLUDED.skipped,
       problem = EXCLUDED.problem,
       state = EXCLUDED.state`,
    [
      id,
      root.space_id,
      sourceRootId,
      args.watcherId ?? null,
      new Date(observedAt),
      JSON.stringify(availableFolders),
      itemCount,
      JSON.stringify(skipped),
      args.problem ?? null,
      state,
    ],
  );
  return id;
}
