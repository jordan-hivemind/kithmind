// The operator command: one full acquisition-to-verdict pass for an
// adapter, end to end -- discover, acquire each selection, persist through
// the credential-free projection to the raw tree, parse, convert and
// import, gate, publish -- and a summary, never a row.
//
// `pnpm --filter @repo/finance-archive import`, or `node dist/run.js` after
// a build:
//
//   node dist/run.js --adapter <module path> --session <module path> \
//     --selection <json file> [--now <iso instant>] [--dry-run]
//
// It composes existing pieces exactly as their own tests do -- see
// test/adapterImport.test.mjs and test/syntheticAdapter.test.mjs -- and adds
// no new import/gate/publish logic of its own. `publishImport` already runs
// both gates atomically (see importer.ts); this file's only original work is
// wiring the CLI, the raw tree persistence loop, and the summary.
//
// Every setting is read from the environment or a flag, with no default for
// any connection string or path, mirroring src/mcp/run.ts. `--dry-run` runs
// the whole pass inside one Postgres transaction and always rolls it back
// (see DryRunAbort below) -- "the database" here means the Postgres archive
// (FINANCE_ARCHIVE_DATABASE_URL); the raw tree write is content-addressed
// and idempotent, and happens either way because AdapterPull.persisted can
// only be produced by actually persisting bytes (see adapterImport.ts).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  sha256Hex,
  type AcquireSelection,
  type AdapterSession,
  type CapabilityTier,
  type DiscoverResult,
  type InstitutionAdapter,
} from "./adapter.js";
import {
  adapterPullToImportDocuments,
  persistAcquiredDocument,
  resolveDiscoveredAccounts,
  resolveInstitution,
  type AdapterPull,
} from "./adapterImport.js";
import {
  publishImport,
  type ImportBatch,
  type ImportDocument,
} from "./importer.js";
import {
  closeArchiveClient,
  createArchiveClient,
  withArchiveTransaction,
  type ArchiveClient,
} from "./pgStore.js";
import { resolveRawTreeRoot } from "./rawTree.js";

// --- selection file ----------------------------------------------------

type AcquireSelectionInput =
  | {
      readonly kind: Extract<CapabilityTier, "structured_api" | "tabular_export">;
      readonly periodStart: string;
      readonly periodEnd: string;
    }
  | {
      readonly kind: Extract<CapabilityTier, "pdf_statement" | "trade_confirmation">;
      readonly externalId: string;
    };

type SelectionEntry = {
  /** `accounts.id`, already provisioned. Mutually exclusive with
   * `accountExternalKey` and `scope`; exactly one names the account (or
   * institution-wide scope) this pull is for. */
  readonly accountId?: string;
  /**
   * An account by the adapter's own opaque id from `DiscoverResult.accounts`
   * (F1-32) instead of the archive's `accounts.id` -- resolved after
   * `discover()` runs, via `resolveDiscoveredAccounts`, so naming an account
   * this way needs no separate provisioning step.
   */
  readonly accountExternalKey?: string;
  /**
   * F1-35. `"institution"` instead of an account, for a pull whose source
   * returns every account's activity in one response (a real institution's
   * structured-API or tabular-export pull). Valid only for
   * `selection.kind` `structured_api` or `tabular_export` -- a document-tier
   * pull (`pdf_statement`, `trade_confirmation`) always belongs to one
   * account. Each row is attributed by its own `ParsedRow.accountExternalKey`
   * (adapterImport.ts's `resolveRowAccountId`); the pull's own document gets
   * a null `account_id` rather than one row's account standing in for all of
   * them.
   */
  readonly scope?: "institution";
  readonly docType: string;
  readonly docDate: string | null;
  readonly selection: AcquireSelectionInput;
  /** Absent on a plain entry; discriminates `SelectionPull` against the two
   * `"expand"` entries below. */
  readonly expand?: undefined;
};

/**
 * F1-39. `discover()` can return thousands of documents across a full
 * retention-window pull -- one selection entry per document is not something
 * anyone should hand-write. This entry expands, after `discover` runs, into
 * one document pull per discovered item of `kinds`: institution-wide (see
 * `DiscoveredDocument` in adapter.ts -- it names no account), `docDate` the
 * discovered `periodEnd`. `requireExhaustive: true` refuses the whole run
 * before anything is acquired if `discover()`'s document listing came back
 * incomplete, rather than silently importing a partial retention window.
 */
type ExpandDiscoveredEntry = {
  readonly expand: "discovered";
  readonly kinds: readonly Extract<CapabilityTier, "pdf_statement" | "trade_confirmation">[];
  readonly docType: string;
  readonly requireExhaustive: boolean;
};

/**
 * F1-39. One caller-stated window, split on calendar-year boundaries into
 * one institution-wide pull per year -- so a seven-year retention pull is one
 * selection entry, not one per native range. `docDate` is null for every
 * generated pull, the same convention every other `structured_api`/
 * `tabular_export` entry in this file uses: a period, not a single date.
 */
type ExpandActivityRangesEntry = {
  readonly expand: "activity-ranges";
  readonly kind: Extract<CapabilityTier, "structured_api" | "tabular_export">;
  readonly docType: string;
  readonly periodStart: string;
  readonly periodEnd: string;
};

type SelectionPull = SelectionEntry | ExpandDiscoveredEntry | ExpandActivityRangesEntry;

type SelectionFile = {
  /**
   * F1-19 operator gap. No longer required: `main()` resolves the real
   * institution id from the adapter's own `capabilities()` before `discover`
   * (see `resolveInstitution`). Accepted only for compatibility with an
   * existing selection file; when present it must name the same institution
   * the adapter resolves to, or the run refuses rather than silently using
   * whichever one the caller actually meant.
   */
  readonly institutionId?: string;
  readonly pulls: readonly SelectionPull[];
};

const CAPABILITY_TIERS = new Set<CapabilityTier>([
  "structured_api",
  "tabular_export",
  "pdf_statement",
  "trade_confirmation",
]);

function readSelectionFile(path: string): SelectionFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;
  if (
    raw.institutionId !== undefined &&
    (typeof raw.institutionId !== "string" || raw.institutionId.length === 0)
  ) {
    throw new Error(`${path}: "institutionId", when present, must be a non-empty string`);
  }
  if (!Array.isArray(raw.pulls) || raw.pulls.length === 0) {
    throw new Error(`${path}: "pulls" must be a non-empty array`);
  }
  raw.pulls.forEach((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${path}: pulls[${index}] must be an object`);
    }
    const pull = entry as Record<string, unknown>;

    if (pull.expand === "discovered") {
      const kinds = pull.kinds;
      if (
        !Array.isArray(kinds) ||
        kinds.length === 0 ||
        !kinds.every((k) => k === "pdf_statement" || k === "trade_confirmation")
      ) {
        throw new Error(
          `${path}: pulls[${index}].kinds must be a non-empty array of "pdf_statement" or "trade_confirmation"`,
        );
      }
      if (typeof pull.docType !== "string" || pull.docType.length === 0) {
        throw new Error(`${path}: pulls[${index}].docType is required`);
      }
      if (typeof pull.requireExhaustive !== "boolean") {
        throw new Error(`${path}: pulls[${index}].requireExhaustive must be a boolean`);
      }
      return;
    }

    if (pull.expand === "activity-ranges") {
      if (pull.kind !== "structured_api" && pull.kind !== "tabular_export") {
        throw new Error(
          `${path}: pulls[${index}].kind must be "structured_api" or "tabular_export"`,
        );
      }
      if (typeof pull.docType !== "string" || pull.docType.length === 0) {
        throw new Error(`${path}: pulls[${index}].docType is required`);
      }
      if (typeof pull.periodStart !== "string" || typeof pull.periodEnd !== "string") {
        throw new Error(
          `${path}: pulls[${index}] needs "periodStart" and "periodEnd"`,
        );
      }
      return;
    }

    if (pull.expand !== undefined) {
      throw new Error(
        `${path}: pulls[${index}].expand, when present, must be "discovered" or "activity-ranges"`,
      );
    }

    const selection = pull.selection as Record<string, unknown> | undefined;
    if (
      !selection ||
      typeof selection.kind !== "string" ||
      !CAPABILITY_TIERS.has(selection.kind as CapabilityTier)
    ) {
      throw new Error(
        `${path}: pulls[${index}].selection.kind must be one of ${[...CAPABILITY_TIERS].join(", ")}`,
      );
    }
    const kind = selection.kind as CapabilityTier;

    const hasAccountId =
      typeof pull.accountId === "string" && pull.accountId.length > 0;
    const hasExternalKey =
      typeof pull.accountExternalKey === "string" &&
      pull.accountExternalKey.length > 0;
    if (pull.scope !== undefined && pull.scope !== "institution") {
      throw new Error(
        `${path}: pulls[${index}].scope, when present, must be "institution"`,
      );
    }
    const hasScope = pull.scope === "institution";
    if ([hasAccountId, hasExternalKey, hasScope].filter(Boolean).length !== 1) {
      throw new Error(
        `${path}: pulls[${index}] must name its account with exactly one of "accountId", ` +
          `"accountExternalKey", or "scope": "institution"`,
      );
    }
    if (hasScope && kind !== "structured_api" && kind !== "tabular_export") {
      throw new Error(
        `${path}: pulls[${index}]."scope": "institution" is only valid for a structured_api or ` +
          `tabular_export selection, got ${kind}`,
      );
    }
    if (typeof pull.docType !== "string" || pull.docType.length === 0) {
      throw new Error(`${path}: pulls[${index}].docType is required`);
    }
    if (pull.docDate !== null && typeof pull.docDate !== "string") {
      throw new Error(`${path}: pulls[${index}].docDate must be a string or null`);
    }
    if (kind === "structured_api" || kind === "tabular_export") {
      if (typeof selection.periodStart !== "string" || typeof selection.periodEnd !== "string") {
        throw new Error(
          `${path}: pulls[${index}].selection needs "periodStart" and "periodEnd" for kind ${kind}`,
        );
      }
    } else if (typeof selection.externalId !== "string") {
      throw new Error(
        `${path}: pulls[${index}].selection needs "externalId" for kind ${kind}`,
      );
    }
  });
  return raw as unknown as SelectionFile;
}

// --- dynamic module loading ---------------------------------------------

async function loadModule(path: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(resolve(path)).href;
  return (await import(url)) as Record<string, unknown>;
}

async function loadAdapter(path: string): Promise<InstitutionAdapter> {
  const module = await loadModule(path);
  const candidate = (module.default ?? module.adapter) as
    | InstitutionAdapter
    | undefined;
  if (!candidate || typeof candidate.discover !== "function") {
    throw new Error(
      `${path} has no default export or named "adapter" export implementing InstitutionAdapter`,
    );
  }
  return candidate;
}

type SessionBuilder = () => Promise<AdapterSession> | AdapterSession;

async function loadSessionBuilder(path: string): Promise<SessionBuilder> {
  const module = await loadModule(path);
  const build = module.default as SessionBuilder | undefined;
  if (typeof build !== "function") {
    throw new Error(
      `${path} has no default export function that builds an AdapterSession`,
    );
  }
  return build;
}

// --- summary queries --------------------------------------------------

type CurrencySum = { readonly currency: string; readonly total: string };
type CashVerdict = {
  readonly accountId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly status: string;
  readonly tolerance: string;
};
type PositionVerdict = {
  readonly accountId: string;
  readonly instrumentId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: string;
  readonly tolerance: string;
};

/** Exact decimal sums, computed by Postgres (NUMERIC), never in JavaScript. */
async function sumByCurrency(
  client: ArchiveClient,
  documentShas: readonly string[],
): Promise<CurrencySum[]> {
  if (documentShas.length === 0) return [];
  const result = await client.query<CurrencySum>(
    `SELECT t.currency, COALESCE(SUM(t.amount), 0)::text AS total
     FROM transactions t
     JOIN documents d ON d.id = t.source_document_id
     WHERE d.sha256 = ANY($1)
     GROUP BY t.currency
     ORDER BY t.currency`,
    [documentShas],
  );
  return result.rows;
}

async function fetchCashVerdicts(
  client: ArchiveClient,
  accountIds: readonly string[],
): Promise<CashVerdict[]> {
  if (accountIds.length === 0) return [];
  const result = await client.query<{
    account_id: string;
    period_start: string;
    period_end: string;
    currency: string;
    status: string;
    tolerance: string;
  }>(
    `SELECT account_id, period_start::text AS period_start, period_end::text AS period_end,
            currency, status, tolerance::text AS tolerance
     FROM reconciliations
     WHERE account_id = ANY($1)
     ORDER BY account_id, period_start`,
    [accountIds],
  );
  return result.rows.map((row) => ({
    accountId: row.account_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    currency: row.currency,
    status: row.status,
    tolerance: row.tolerance,
  }));
}

/**
 * How many `review_items` rows exist right now, inside the caller's own
 * transaction. `openReviewItem` (adapterImport.ts) and `openReview`
 * (importer.ts) both just INSERT -- neither counts across the two files it
 * runs in -- so the only way to know how many a whole run opened, conversion
 * included, is to diff this before and after (see the F1-36 comment in
 * `main` below).
 */
async function countReviewItems(client: ArchiveClient): Promise<number> {
  const result = await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM review_items",
  );
  return Number(result.rows[0]?.n ?? "0");
}

async function fetchPositionVerdicts(
  client: ArchiveClient,
  accountIds: readonly string[],
): Promise<PositionVerdict[]> {
  if (accountIds.length === 0) return [];
  const result = await client.query<{
    account_id: string;
    instrument_id: string;
    period_start: string;
    period_end: string;
    status: string;
    tolerance: string;
  }>(
    `SELECT account_id, instrument_id, period_start::text AS period_start,
            period_end::text AS period_end, status, tolerance::text AS tolerance
     FROM position_reconciliations
     WHERE account_id = ANY($1)
     ORDER BY account_id, instrument_id, period_start`,
    [accountIds],
  );
  return result.rows.map((row) => ({
    accountId: row.account_id,
    instrumentId: row.instrument_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    tolerance: row.tolerance,
  }));
}

// --- the pass ------------------------------------------------------------

type RunOutcome = {
  readonly discoverStatus: string;
  readonly discoverDocuments: number;
  readonly discoverExportRanges: number;
  readonly documentsAcquired: number;
  readonly bytesAcquired: number;
  readonly manifestSha256: string;
  readonly rowsParsed: number;
  readonly rowsInserted: number;
  /** A provider id or row hash matched an existing row (importer.ts). */
  readonly rowsDeduplicated: number;
  /** A review item was opened for the row instead of inserting it. */
  readonly rowsRefused: number;
  /** Conversion (adapterImport.ts) plus publish (importer.ts) -- every
   * review item this run opened, not only the publish-time ones. */
  readonly reviewItemsOpened: number;
  readonly currencySums: readonly CurrencySum[];
  readonly cashVerdicts: readonly CashVerdict[];
  readonly positionVerdicts: readonly PositionVerdict[];
  /** F1-39. How many documents `discover()` reported, by kind -- independent
   * of whether anything in `selection.pulls` actually asked for them. */
  readonly documentsDiscoveredByKind: Readonly<Record<string, number>>;
  /** F1-39. Counts for document-tier (`pdf_statement`/`trade_confirmation`)
   * pulls specifically -- `documentsAcquired` above already counts every
   * pull, document- and export-tier alike. */
  readonly documentPullsAcquired: number;
  readonly documentPullsSkipped: number;
  readonly documentPullsFailed: number;
  readonly documentPullsByKind: Readonly<Record<string, DocKindCounts>>;
  /** F1-40. How document-tier pulls were filed: under the single account
   * their own `accountExternalKey` resolved to, or institution-wide (no key,
   * or a key this run discovered no account for). Independent of whether the
   * pull went on to be acquired, skipped or failed. */
  readonly documentsFiledByAccount: number;
  readonly documentsFiledInstitutionWide: number;
};

type DocKindCounts = {
  readonly acquired: number;
  readonly skipped: number;
  readonly failed: number;
};

/**
 * Thrown at the end of the pass to always roll back the one Postgres
 * transaction it ran in, when the caller asked for `--dry-run`. Reuses
 * `withArchiveTransaction`'s own rollback-on-throw rather than adding a
 * second commit/rollback path: the transaction never commits, and the
 * result travels out on the error.
 */
class DryRunAbort extends Error {
  constructor(readonly result: RunOutcome) {
    super("dry run: rolled back, nothing committed");
  }
}

/** `accounts.acct_last4` for `accountId`, cached per run since the same
 * account is often named by several pulls. */
async function resolveAccountLast4(
  client: ArchiveClient,
  accountId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(accountId);
  if (cached !== undefined) return cached;
  const found = await client.query<{ acct_last4: string | null }>(
    "SELECT acct_last4 FROM accounts WHERE id = $1",
    [accountId],
  );
  const row = found.rows[0];
  if (!row) {
    throw new Error(
      `no accounts row with id ${accountId}; provision the account before running`,
    );
  }
  cache.set(accountId, row.acct_last4);
  return row.acct_last4;
}

/** The account this pull names, by id directly or by the external key an
 * earlier `resolveDiscoveredAccounts` call resolved (F1-32), or null for an
 * institution-wide pull (F1-35, `"scope": "institution"`). Exactly one of
 * `accountId`, `accountExternalKey` or `scope` is present -- `readSelectionFile`
 * already enforced that. */
function resolveEntryAccountId(
  entry: SelectionEntry,
  accountsByExternalKey: ReadonlyMap<string, string>,
): string | null {
  if (entry.scope === "institution") return null;
  if (entry.accountId) return entry.accountId;
  const id = accountsByExternalKey.get(entry.accountExternalKey!);
  if (!id) {
    throw new Error(
      `no discovered account with external key ${entry.accountExternalKey}`,
    );
  }
  return id;
}

const DOCUMENT_TIER_KINDS = new Set<CapabilityTier>(["pdf_statement", "trade_confirmation"]);

/**
 * F1-54. A signed-out session (or a documents endpoint stuck answering 400)
 * fails every remaining document pull the same way, one after another --
 * 1,296 of them over nine minutes before an operator finally killed the run
 * by hand (seen live 2026-09-11). Stop long before that: this many
 * *consecutive* document-pull failures in a row is past "this one document
 * has a bad history" and into "something structural broke," so runPulls
 * below stops issuing new pulls rather than burning through the rest of the
 * selection one avoidable failure at a time. Its own named constant so the
 * threshold has one place to change.
 */
const CONSECUTIVE_DOCUMENT_FAILURE_LIMIT = 10;

function isDocumentTierKind(
  kind: CapabilityTier,
): kind is Extract<CapabilityTier, "pdf_statement" | "trade_confirmation"> {
  return DOCUMENT_TIER_KINDS.has(kind);
}

/** F1-39. One resolved pull, after any `"expand"` entry has been expanded --
 * account already resolved (or null, institution-wide), exactly what
 * `main()`'s pull loop used to build straight from `SelectionEntry`. */
type PullSpec = {
  readonly accountId: string | null;
  readonly docType: string;
  readonly docDate: string | null;
  readonly selection: AcquireSelectionInput;
};

/**
 * F1-39. Splits `[periodStart, periodEnd]` on calendar-year boundaries. A
 * window inside one year is one range; a multi-year window is one range per
 * year it touches, each clipped to the caller's own start/end. The real
 * adapter's own native-range limit (the synthetic adapter has none) is the
 * adapter's problem once it receives one of these one-year-or-shorter
 * requests, not this function's.
 */
function splitIntoCalendarYears(
  periodStart: string,
  periodEnd: string,
): Array<{ readonly periodStart: string; readonly periodEnd: string }> {
  const startYear = Number(periodStart.slice(0, 4));
  const endYear = Number(periodEnd.slice(0, 4));
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || endYear < startYear) {
    throw new Error(
      `"expand": "activity-ranges" needs periodStart <= periodEnd, both YYYY-MM-DD; got ` +
        `${periodStart}..${periodEnd}`,
    );
  }
  const ranges: Array<{ periodStart: string; periodEnd: string }> = [];
  for (let year = startYear; year <= endYear; year += 1) {
    ranges.push({
      periodStart: year === startYear ? periodStart : `${year}-01-01`,
      periodEnd: year === endYear ? periodEnd : `${year}-12-31`,
    });
  }
  return ranges;
}

/**
 * F1-39. Turns `selectionFile.pulls` into a flat list of concrete pulls: a
 * plain entry passes through (its account resolved exactly as before), an
 * `"expand": "discovered"` entry becomes one pull per matching discovered
 * document, and an `"expand": "activity-ranges"` entry becomes one
 * institution-wide pull per calendar year. Runs after `discover()`, since
 * both expansions read its result.
 */
function expandSelectionPulls(
  entries: readonly SelectionPull[],
  discovered: DiscoverResult,
  accountsByExternalKey: ReadonlyMap<string, string>,
): PullSpec[] {
  const specs: PullSpec[] = [];
  for (const entry of entries) {
    if (entry.expand === "discovered") {
      if (entry.requireExhaustive && discovered.documents.status === "incomplete") {
        throw new Error(
          `"expand": "discovered" with "requireExhaustive": true refuses to start: discover()'s ` +
            `document listing is incomplete (${discovered.documents.reason})`,
        );
      }
      const wanted = new Set<string>(entry.kinds);
      for (const doc of discovered.documents.items) {
        if (!wanted.has(doc.kind)) continue;
        specs.push({
          // F1-40. A statement or confirmation belongs to exactly one
          // account, and a real adapter's discover() already encodes which
          // one into accountExternalKey -- file the pull under it, same as
          // an explicit per-account selection. No key, or a key this run
          // never discovered an account for, stays institution-wide exactly
          // as it did before this field existed.
          accountId:
            doc.accountExternalKey !== undefined
              ? (accountsByExternalKey.get(doc.accountExternalKey) ?? null)
              : null,
          docType: entry.docType,
          docDate: doc.periodEnd,
          selection: { kind: doc.kind, externalId: doc.externalId },
        });
      }
      continue;
    }
    if (entry.expand === "activity-ranges") {
      for (const range of splitIntoCalendarYears(entry.periodStart, entry.periodEnd)) {
        specs.push({
          accountId: null,
          docType: entry.docType,
          docDate: null,
          selection: {
            kind: entry.kind,
            periodStart: range.periodStart,
            periodEnd: range.periodEnd,
          },
        });
      }
      continue;
    }
    specs.push({
      accountId: resolveEntryAccountId(entry, accountsByExternalKey),
      docType: entry.docType,
      docDate: entry.docDate,
      selection: entry.selection,
    });
  }
  return specs;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      adapter: { type: "string" },
      session: { type: "string" },
      selection: { type: "string" },
      now: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "commit-every": { type: "string", default: "1" },
    },
  });

  if (!values.adapter) throw new Error("--adapter <module path> is required");
  if (!values.session) throw new Error("--session <module path> is required");
  if (!values.selection) throw new Error("--selection <json file> is required");
  const dryRun = values["dry-run"] === true;
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`--now ${values.now} is not a valid date`);
  }
  // F1-39. How many document-tier pulls (pdf_statement/trade_confirmation)
  // share one publishImport transaction. Default 1: each document is
  // acquired, persisted and imported on its own, so one refused or failed
  // document never loses any other document's already-committed work.
  // structured_api/tabular_export pulls are never batched by this flag --
  // each of those always gets its own transaction (see runPulls below).
  const commitEvery = Number(values["commit-every"]);
  if (!Number.isInteger(commitEvery) || commitEvery < 1) {
    throw new Error(`--commit-every must be a positive integer, got ${values["commit-every"]}`);
  }

  const adapter = await loadAdapter(values.adapter);
  const buildSession = await loadSessionBuilder(values.session);
  const selectionFile = readSelectionFile(values.selection);
  const capabilities = adapter.capabilities();

  // Hard errors when unset -- FINANCE_ARCHIVE_RAW_TREE_ROOT, FINANCE_ARCHIVE_SPACE_ID.
  const rawTreeRoot = resolveRawTreeRoot();

  // Hard error when FINANCE_ARCHIVE_DATABASE_URL is unset.
  const pgClient = createArchiveClient();
  await pgClient.connect();

  try {
    // F1-19 operator gap: upserts the institutions row from the adapter's
    // own capabilities() before discover, so the selection file no longer
    // has to already name an existing row -- see resolveInstitution's doc
    // comment. A selection file that still names one (compatibility) must
    // agree with what the adapter resolves to, or the run refuses rather
    // than silently importing against whichever institution it actually
    // resolved.
    const institutionId = await resolveInstitution(pgClient, capabilities);
    if (
      selectionFile.institutionId !== undefined &&
      selectionFile.institutionId !== institutionId
    ) {
      throw new Error(
        `--selection names institutionId ${selectionFile.institutionId}, but the adapter's ` +
          `capabilities() (slug ${capabilities.institutionSlug}) resolved to ${institutionId}; ` +
          "refusing to import against a different institution than the selection file names",
      );
    }

    const session = await buildSession();
    const discovered = await adapter.discover(session);
    // F1-32: makes every account discover() reported resolvable by its own
    // external key, so a selection can name one without a separate
    // provisioning step. Keyed on the resolved institutionId, not
    // selectionFile.institutionId, which the file no longer has to name.
    const accountsByExternalKey = await resolveDiscoveredAccounts(
      pgClient,
      institutionId,
      discovered.accounts,
    );

    const accountLast4Cache = new Map<string, string | null>();

    // F1-39: documents discovered by kind, independent of whether any
    // selection entry actually asked for them.
    const documentsDiscoveredByKind: Record<string, number> = {};
    for (const doc of discovered.documents.items) {
      documentsDiscoveredByKind[doc.kind] = (documentsDiscoveredByKind[doc.kind] ?? 0) + 1;
    }

    // F1-39: expands "expand": "discovered" and "expand": "activity-ranges"
    // entries into concrete pulls; a plain entry passes through unchanged
    // (same resolveEntryAccountId call the loop below used to make itself).
    const pullSpecs = expandSelectionPulls(selectionFile.pulls, discovered, accountsByExternalKey);

    // F1-40: how document-tier pulls were filed, independent of whether they
    // go on to be acquired, skipped or failed below.
    let documentsFiledByAccount = 0;
    let documentsFiledInstitutionWide = 0;
    for (const spec of pullSpecs) {
      if (!isDocumentTierKind(spec.selection.kind)) continue;
      if (spec.accountId === null) documentsFiledInstitutionWide += 1;
      else documentsFiledByAccount += 1;
    }

    // F1-35: an institution-wide pull's own accountId is null, and its rows
    // are attributed by their own accountExternalKey instead -- include
    // every discovered account in the summary's verdict lookups when that
    // happened, or the accounts those rows actually landed on would be
    // silently absent from "cash reconciliation verdicts" / "position
    // reconciliation verdicts" below.
    const namedAccountIds = pullSpecs
      .map((spec) => spec.accountId)
      .filter((id): id is string => id !== null);
    const accountIds = [
      ...new Set(
        pullSpecs.some((spec) => spec.accountId === null)
          ? [...namedAccountIds, ...accountsByExternalKey.values()]
          : namedAccountIds,
      ),
    ];

    let bytesAcquired = 0;
    const manifestHashes: string[] = [];
    let documentsAcquiredCount = 0;
    let rowsParsed = 0;
    let rowsInserted = 0;
    let rowsDeduplicated = 0;
    let rowsRefused = 0;
    let reviewItemsOpened = 0;
    const allDocumentShas: string[] = [];

    let documentPullsAcquired = 0;
    let documentPullsSkipped = 0;
    let documentPullsFailed = 0;
    const documentPullsByKind = new Map<string, DocKindCounts>();

    function bumpDocKind(kind: string, field: keyof DocKindCounts): void {
      const existing = documentPullsByKind.get(kind) ?? {
        acquired: 0,
        skipped: 0,
        failed: 0,
      };
      documentPullsByKind.set(kind, { ...existing, [field]: existing[field] + 1 });
    }

    function reportFailure(spec: PullSpec, error: unknown): void {
      const message = error instanceof Error ? error.message : String(error);
      const locator =
        "externalId" in spec.selection
          ? `externalId=${spec.selection.externalId}`
          : `period=${spec.selection.periodStart}..${spec.selection.periodEnd}`;
      console.error(
        `document pull refused/failed and was skipped: kind=${spec.selection.kind} ${locator}: ${message}`,
      );
    }

    type Acquired = {
      readonly pull: AdapterPull;
      readonly kind: CapabilityTier;
      readonly contentHash: string;
      readonly parsedRowCount: number;
    };

    /** Acquires, parses and persists one pull -- the raw-tree write, and
     * therefore `bytesAcquired`/`manifestHashes`/`documentsAcquiredCount`,
     * happen here regardless of whether the pull's rows go on to import,
     * dedupe or fail: acquisition and import are different facts. */
    async function acquireAndPersist(spec: PullSpec): Promise<Acquired> {
      const selection = { ...spec.selection, session } as AcquireSelection;
      const acquired = await adapter.acquire(selection);
      const parsed = await adapter.parse({ kind: spec.selection.kind, bytes: acquired.bytes });
      // F1-35: an institution-wide pull names no single account, so there is
      // no accounts.acct_last4 to look up either -- "all" says so on the
      // capture manifest rather than a guessed or borrowed last4 (see
      // captures.ts's acctLast4 doc comment).
      const accountLast4 =
        spec.accountId === null
          ? "all"
          : await resolveAccountLast4(pgClient, spec.accountId, accountLast4Cache);
      const persisted = persistAcquiredDocument(
        rawTreeRoot,
        {
          institutionId,
          accountId: spec.accountId,
          institutionSlug: capabilities.institutionSlug,
          accountLast4,
          docType: spec.docType,
          acquired,
        },
        // F1-44: retained whenever the adapter extracted any, parsed or not.
        parsed.extractedText ?? null,
      );
      bytesAcquired += acquired.bytes.length;
      manifestHashes.push(acquired.manifest.contentHash);
      documentsAcquiredCount += 1;
      rowsParsed +=
        parsed.activity.length +
        parsed.holdings.positions.length +
        parsed.holdings.balances.length +
        parsed.holdings.liabilities.length;
      return {
        pull: {
          institutionId,
          accountId: spec.accountId,
          acquired,
          rows: parsed.activity,
          holdings: parsed.holdings,
          parseNote: parsed.parseNote,
          docType: spec.docType,
          docDate: spec.docDate,
          persisted,
          activityTaxonomy: capabilities.activityTaxonomy,
          // F1-35: lets adapterImport.ts resolve a row's own
          // ParsedRow.accountExternalKey (an institution-wide pull's rows,
          // or any row an adapter attributes this way) against the accounts
          // this run already discovered, instead of always importing under
          // `accountId` above.
          accountsByExternalKey,
        },
        kind: spec.selection.kind,
        contentHash: acquired.manifest.contentHash,
        parsedRowCount:
          parsed.activity.length +
          parsed.holdings.positions.length +
          parsed.holdings.balances.length +
          parsed.holdings.liabilities.length,
      };
    }

    /** `documents.sha256` is content-addressed and unique (importer.ts's
     * whole-document skip); checking it directly, before ever building an
     * ImportBatch, is what lets an already-imported document be reported as
     * "skipped" rather than folded into `rowsDeduplicated`, and lets a
     * commit-every batch leave it out of the transaction entirely. */
    async function isDocumentAlreadyImported(sha256: string): Promise<boolean> {
      const found = await pgClient.query<{ parsed_ok: boolean }>(
        "SELECT parsed_ok FROM documents WHERE sha256 = $1",
        [sha256],
      );
      return found.rows[0]?.parsed_ok === true;
    }

    /** Converts and publishes `acquiredPulls` as one transaction. Called
     * with exactly one `Acquired` for a structured_api/tabular_export pull
     * (always its own transaction) or with up to `commitEvery` document-tier
     * ones. Uses `pgClient` directly rather than a passed-down handle: every
     * archive connection this file opens is that one client, and
     * `withArchiveTransaction` already joins a transaction already open on
     * it (see `main`'s `--dry-run` branch below) rather than nesting a
     * second one, so this needs no dry-run-specific branch of its own. */
    async function publishOne(acquiredPulls: readonly Acquired[]): Promise<void> {
      await withArchiveTransaction(pgClient, async (tx) => {
        // F1-36: adapterPullToImportDocuments (adapterImport.ts) opens its
        // own review items during conversion -- weak instrument matches,
        // unknown account keys, undeclared activity types, an unverified
        // pagination total -- before importBatch (via publishImport below)
        // ever runs. Diffing the table's count around this loop is the only
        // way to count those alongside publishSummary.reviewItemsOpened
        // without adapterPullToImportDocuments returning its own count, which
        // every one of its other callers (see test/adapterImport.test.mjs)
        // already destructures as a plain ImportDocument[].
        const reviewItemsBeforeConversion = await countReviewItems(tx);
        const documents: ImportDocument[] = [];
        for (const acquired of acquiredPulls) {
          documents.push(...(await adapterPullToImportDocuments(tx, acquired.pull)));
        }
        const conversionReviewItemsOpened =
          (await countReviewItems(tx)) - reviewItemsBeforeConversion;
        const batch: ImportBatch = { source: adapter.institutionSlug, documents };
        // Reuses publishImport: import both gates and publication happen
        // exactly as it already defines them, as one atomic step.
        const publishSummary = await publishImport(tx, batch, now);
        rowsInserted += publishSummary.rowsInserted;
        rowsDeduplicated += publishSummary.rowsDeduplicated;
        rowsRefused += publishSummary.rowsRefused;
        reviewItemsOpened += conversionReviewItemsOpened + publishSummary.reviewItemsOpened;
        allDocumentShas.push(...documents.map((document) => document.sha256));
      });
    }

    let pendingDocBatch: Array<{ readonly spec: PullSpec; readonly acquired: Acquired }> = [];

    async function flushDocBatch(): Promise<void> {
      if (pendingDocBatch.length === 0) return;
      const batch = pendingDocBatch;
      pendingDocBatch = [];
      const toImport: Array<{ readonly spec: PullSpec; readonly acquired: Acquired }> = [];
      for (const item of batch) {
        // ponytail: already acquired/persisted above (flushDocBatch only
        // ever receives entries acquireAndPersist already succeeded for);
        // the dedupe check itself cannot fail here short of a database
        // outage, which is fatal regardless.
        const already = await isDocumentAlreadyImported(item.acquired.contentHash);
        if (already) {
          documentPullsSkipped += 1;
          bumpDocKind(item.acquired.kind, "skipped");
          allDocumentShas.push(item.acquired.contentHash);
          continue;
        }
        toImport.push(item);
      }
      if (toImport.length === 0) return;
      try {
        await publishOne(toImport.map((item) => item.acquired));
        documentPullsAcquired += toImport.length;
        for (const item of toImport) bumpDocKind(item.acquired.kind, "acquired");
      } catch (error) {
        documentPullsFailed += toImport.length;
        for (const item of toImport) {
          bumpDocKind(item.acquired.kind, "failed");
          reportFailure(item.spec, error);
        }
      }
    }

    /**
     * F1-39. Processes every pull in order: document-tier pulls
     * (`pdf_statement`/`trade_confirmation`) batch up to `commitEvery` at a
     * time, each batch its own transaction, and a refused or failed one is
     * reported and skipped rather than aborting the run.
     * `structured_api`/`tabular_export` pulls are never batched -- each gets
     * its own transaction, and a failure there still aborts the run exactly
     * as it always has (no selection here names thousands of those the way
     * a full document retention window does).
     */
    async function runPulls(): Promise<void> {
      // F1-54 circuit breaker: counts document-pull failures in a row,
      // across every document kind, and resets on any success. Tracked here
      // (not as a module-level `let`) so it starts fresh every call.
      let consecutiveDocumentFailures = 0;
      for (const spec of pullSpecs) {
        if (isDocumentTierKind(spec.selection.kind)) {
          let acquired: Acquired;
          try {
            acquired = await acquireAndPersist(spec);
          } catch (error) {
            documentPullsFailed += 1;
            bumpDocKind(spec.selection.kind, "failed");
            reportFailure(spec, error);
            consecutiveDocumentFailures += 1;
            // A lost browser session fails every remaining document the same
            // way within milliseconds (20,757 of them on the first full pull).
            // Stop instead: what was committed stays committed, and the rerun
            // skips documents already imported.
            const message = error instanceof Error ? error.message : String(error);
            if (/SIGNED_OUT|no session headers captured yet|no Authorization bearer captured yet/.test(message)) {
              throw new Error(
                `run stopped: the browser session is gone (${message.slice(0, 120)}). ` +
                  `${documentPullsAcquired} document pull(s) were committed before this; sign in again and rerun the same selection to continue.`,
              );
            }
            if (consecutiveDocumentFailures >= CONSECUTIVE_DOCUMENT_FAILURE_LIMIT) {
              const errorClass = error instanceof Error ? error.constructor.name : typeof error;
              throw new Error(
                `run stopped: ${consecutiveDocumentFailures} consecutive document pulls failed ` +
                  `(last error: ${errorClass}: ${message.slice(0, 200)}). ` +
                  `${documentPullsAcquired} document pull(s) were committed before this; each document ` +
                  "commits in its own transaction, so already-committed documents are untouched. " +
                  "Fix the underlying failure and rerun the same selection to continue.",
              );
            }
            continue;
          }
          consecutiveDocumentFailures = 0;
          pendingDocBatch.push({ spec, acquired });
          if (pendingDocBatch.length >= commitEvery) await flushDocBatch();
        } else {
          await flushDocBatch();
          const acquired = await acquireAndPersist(spec);
          await publishOne([acquired]);
        }
      }
      await flushDocBatch();
    }

    async function buildOutcome(): Promise<RunOutcome> {
      const currencySums = await sumByCurrency(pgClient, allDocumentShas);
      const cashVerdicts = await fetchCashVerdicts(pgClient, accountIds);
      const positionVerdicts = await fetchPositionVerdicts(pgClient, accountIds);
      // One digest standing for this run's whole acquisition manifest: the
      // sha256 of every acquired document's own content hash, sorted so the
      // digest does not depend on acquisition order.
      const manifestSha256 = sha256Hex(
        new TextEncoder().encode([...manifestHashes].sort().join("\n")),
      );
      return {
        discoverStatus: discovered.documents.status,
        discoverDocuments: discovered.documents.items.length,
        discoverExportRanges: discovered.exportRanges.length,
        documentsAcquired: documentsAcquiredCount,
        bytesAcquired,
        manifestSha256,
        rowsParsed,
        rowsInserted,
        rowsDeduplicated,
        rowsRefused,
        reviewItemsOpened,
        currencySums,
        cashVerdicts,
        positionVerdicts,
        documentsDiscoveredByKind,
        documentPullsAcquired,
        documentPullsSkipped,
        documentPullsFailed,
        documentPullsByKind: Object.fromEntries(documentPullsByKind),
        documentsFiledByAccount,
        documentsFiledInstitutionWide,
      };
    }

    let outcome: RunOutcome;
    if (dryRun) {
      // Runs the identical pass inside one Postgres transaction and always
      // rolls it back. `runPulls`'s own `withArchiveTransaction` calls
      // (inside `publishOne`) join this one instead of opening their own
      // (see `withArchiveTransaction`'s reentrancy doc comment), so this
      // still commits nothing, exactly as before commit-every batching
      // existed.
      try {
        await withArchiveTransaction(pgClient, async () => {
          await runPulls();
          throw new DryRunAbort(await buildOutcome());
        });
        throw new Error("unreachable: dry run always throws DryRunAbort");
      } catch (error) {
        if (!(error instanceof DryRunAbort)) throw error;
        outcome = error.result;
      }
    } else {
      await runPulls();
      outcome = await buildOutcome();
    }

    printSummary(outcome, { dryRun, committed: !dryRun });
  } finally {
    // F1-36: never `pgClient.end()` directly here. A connection already
    // torn down (by the server, or by the transaction error this `finally`
    // exists to let through) can leave `end()` waiting on an event that
    // already fired, which blocks this whole function -- and therefore the
    // `main().catch()` below that prints the real error -- indefinitely.
    // See closeArchiveClient's doc comment (pgStore.ts).
    await closeArchiveClient(pgClient);
  }
}

/**
 * Counts, sums and per-period verdicts only -- never a transaction row, a
 * description, a payload, or an account identifier beyond the adapter's own
 * opaque ids.
 */
function printSummary(
  outcome: RunOutcome,
  meta: { readonly dryRun: boolean; readonly committed: boolean },
): void {
  console.log(
    `mode: ${meta.dryRun ? "dry-run (rolled back, nothing committed)" : "committed"}`,
  );
  console.log(
    `discover: ${outcome.discoverStatus} (${outcome.discoverDocuments} document(s), ${outcome.discoverExportRanges} export range(s))`,
  );
  console.log(`documents acquired: ${outcome.documentsAcquired}`);
  console.log("documents discovered by kind:");
  for (const [kind, n] of Object.entries(outcome.documentsDiscoveredByKind)) {
    console.log(`  ${kind}: ${n}`);
  }
  if (Object.keys(outcome.documentsDiscoveredByKind).length === 0) console.log("  (none)");
  console.log(`document pulls acquired: ${outcome.documentPullsAcquired}`);
  console.log(`document pulls skipped (already imported): ${outcome.documentPullsSkipped}`);
  console.log(`document pulls failed: ${outcome.documentPullsFailed}`);
  console.log("document pulls by kind:");
  for (const [kind, counts] of Object.entries(outcome.documentPullsByKind)) {
    console.log(
      `  ${kind}: acquired=${counts.acquired} skipped=${counts.skipped} failed=${counts.failed}`,
    );
  }
  if (Object.keys(outcome.documentPullsByKind).length === 0) console.log("  (none)");
  console.log(
    `documents filed: by account=${outcome.documentsFiledByAccount} ` +
      `institution-wide=${outcome.documentsFiledInstitutionWide}`,
  );
  console.log(`bytes acquired: ${outcome.bytesAcquired}`);
  console.log(`acquisition manifest sha256: ${outcome.manifestSha256}`);
  console.log(`rows parsed: ${outcome.rowsParsed}`);
  console.log(`rows inserted: ${outcome.rowsInserted}`);
  console.log(`rows deduplicated: ${outcome.rowsDeduplicated}`);
  console.log(`rows refused: ${outcome.rowsRefused}`);
  console.log(`review items opened: ${outcome.reviewItemsOpened}`);
  console.log("money by currency:");
  for (const sum of outcome.currencySums) {
    console.log(`  ${sum.currency}: ${sum.total}`);
  }
  if (outcome.currencySums.length === 0) console.log("  (none)");
  console.log("cash reconciliation verdicts:");
  for (const verdict of outcome.cashVerdicts) {
    console.log(
      `  account=${verdict.accountId} period=${verdict.periodStart}..${verdict.periodEnd} ` +
        `currency=${verdict.currency} status=${verdict.status} tolerance=${verdict.tolerance}`,
    );
  }
  if (outcome.cashVerdicts.length === 0) console.log("  (none)");
  console.log("position reconciliation verdicts:");
  for (const verdict of outcome.positionVerdicts) {
    console.log(
      `  account=${verdict.accountId} instrument=${verdict.instrumentId} ` +
        `period=${verdict.periodStart}..${verdict.periodEnd} status=${verdict.status} ` +
        `tolerance=${verdict.tolerance}`,
    );
  }
  if (outcome.positionVerdicts.length === 0) console.log("  (none)");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
