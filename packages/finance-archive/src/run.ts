// The operator command: one full acquisition-to-verdict pass for an
// adapter, end to end -- discover, acquire each selection, persist through
// the credential-free projection to the raw tree, parse, convert and
// import, gate, publish -- and a summary, never a row.
//
// `pnpm --filter @repo/finance-archive import`, or `node dist/run.js` after
// a build:
//
//   node dist/run.js --adapter <module path> --session <module path> \
//     --selection <json file> [--now <iso instant>] [--dry-run] \
//     [--commit-every <n>] [--gates full|incremental] \
//     [--acquire-only] [--concurrency <n>]
//
// F1-62. `--acquire-only` downloads and retains every document-tier pull
// (pdf_statement/trade_confirmation) -- document row, capture, sha, byte
// length, media type -- with no parse and no rows, and no gate ever runs.
// It exists for a pull that is download-bound (1.5-2s per document against a
// real institution, inside a browser session that lasts 20-45 minutes) with
// thousands of documents to acquire: retain them all now, at the fastest
// rate the session allows, and `reparse` (above) reads them back later with
// no browser and no network at all. Refuses a selection that also names a
// structured_api/tabular_export pull -- reparse's own walk is scoped to the
// two document tiers, so run those through a separate, ordinary pass.
//
// `--concurrency <n>` (default 1, maximum 4) runs that many document
// downloads at once against the one bridge session -- the download is the
// slow, network-bound step, and the session's one CDP connection can still
// run several page-side fetches concurrently (adapter-morgan-stanley's
// src/bridge.mjs). Every document still commits in its own transaction (or
// batches under `--commit-every` exactly as at `--concurrency 1`); the
// consecutive-failure breaker (F1-54) and a paused session's sign-in wait are
// both shared across every lane, not tracked or waited on per lane.
//
// F1-59. Publishing a document gates that document: both gates check only
// the periods its own inserted rows could have moved. `--gates full` (the
// default) then runs one whole-archive pass at the end of the run, which
// re-derives every period from scratch and is what the summary's counts
// come from; `--gates incremental` skips that pass for a run that will be
// followed by another. The whole-archive form used to run after every
// document, which on the owner's archive was about four round trips per
// period per document -- roughly ten minutes of waiting per statement.
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
//
// A second subcommand, `reparse` (below "--- reparse ---"), re-runs an
// adapter's `parse()` over documents this or an earlier run already
// acquired and retained, with no browser and no network at all:
//
//   node dist/run.js reparse --adapter <module path> [--only-unparsed] [--now <iso instant>]
//
// It exists for exactly one situation: the extractor a document was first
// parsed with had a defect (F1-55's PDF routing bug is the first case), the
// defect is fixed, and the already-acquired bytes -- never re-fetched,
// ground rule 1 -- deserve a second parse under the fixed adapter without
// re-running discovery or acquisition against a live session.
//
// Two more (below "--- account aliases ---") walk the same retained
// documents to repair account attribution, and run in this order:
//
//   node dist/run.js learn-account-aliases --adapter <module path> [--dry-run]
//   node dist/run.js reattribute-accounts  --adapter <module path> [--dry-run]
//                                          [--remove-duplicates]
//
// The first learns which printed account number belongs to which account and
// writes `account_aliases`; the second moves the rows the pre-alias
// resolution misfiled and closes their review items. See that section's own
// header for why the order is not a preference, and what
// `--remove-duplicates` deletes.

import { randomUUID } from "node:crypto";
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
  type RetainedMediaType,
} from "./adapter.js";
import {
  accountIdsByExternalKey,
  adapterPullToImportDocuments,
  persistAcquiredDocument,
  resolveDiscoveredAccounts,
  resolveInstitution,
  type AdapterPull,
} from "./adapterImport.js";
import {
  closeResolvedAccountKeyItems,
  countHoldingsByAccount,
  countOpenReviewItems,
  deleteVanishedPeriodVerdicts,
  departedSnapshots,
  duplicateRemovalReviewItems,
  HOLDING_TABLES,
  insertAccountAliases,
  maskAccountKey,
  moveHoldings,
  planAccountAliases,
  type AliasObservation,
  type HoldingTable,
  type MovedHolding,
  type RemovedHolding,
} from "./accountAliases.js";
import { readCaptureManifestById, type CaptureManifest } from "./captures.js";
import {
  publishImport,
  REVIEW_COLUMNS,
  type ImportBatch,
  type ImportDocument,
} from "./importer.js";
import {
  closeArchiveClient,
  createArchiveClient,
  createReconnectBudget,
  insertRows,
  startKeepalive,
  withArchiveTransaction,
  withReconnect,
  type ArchiveClient,
} from "./pgStore.js";
import {
  runPositionReconciliationGate,
  type PositionReconciliationGateSummary,
} from "./positionReconciliation.js";
import {
  runReconciliationGate,
  type ReconciliationGateSummary,
} from "./reconciliation.js";
import {
  rawDocumentPath,
  readAndVerify,
  resolveRawTreeRoot,
  writeRetainedText,
} from "./rawTree.js";
import { storeRetainedText } from "./retainedTexts.js";

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
  /** F1-59. Periods the per-document (incremental) gates actually checked. */
  readonly incrementalPeriodsChecked: GatePeriods;
  /** F1-59. The one whole-archive pass at the end, or null under
   * `--gates incremental`. */
  readonly wholeArchiveGates: WholeArchiveGates | null;
};

type GatePeriods = { readonly cash: number; readonly positions: number };

type WholeArchiveGates = {
  readonly cash: ReconciliationGateSummary;
  readonly positions: PositionReconciliationGateSummary;
};

/**
 * F1-59. One whole-archive pass of both gates, as the last thing a run does.
 *
 * Every document's publication already gated the periods that document
 * moved. This re-derives every period in the archive from scratch, which is
 * what catches a verdict no single import could see it had to revisit, and
 * it costs a fixed handful of round trips now that both gates batch. Run
 * once per run, not once per document: per document it was about four round
 * trips per period in the whole archive, which on the owner's archive was
 * roughly ten minutes each.
 */
async function runWholeArchiveGates(
  client: ArchiveClient,
): Promise<WholeArchiveGates> {
  return withArchiveTransaction(client, async (tx) => ({
    cash: await runReconciliationGate(tx),
    positions: await runPositionReconciliationGate(tx),
  }));
}

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
  /** F1-71. The provider's own id for this document
   * (`DiscoveredDocument.providerDocumentId`, defaulting to the opaque
   * `externalId`), carried to the capture manifest and to
   * `documents.provider_document_id`. Null for an export-tier pull. */
  readonly providerDocumentId: string | null;
};

/**
 * F1-71. What this institution already has on file, for deciding whether a
 * discovered listing item needs pulling at all.
 *
 * Two answers, because an archive holds both kinds of row. `providerIds` is
 * the real identity (`documents.provider_document_id`): the provider's own id
 * for the document, which is stable however many times the provider
 * re-renders its bytes. `metadataKeys` is the fallback for every document
 * recorded before that column existed, which on a live archive is most of
 * them: the same (doc_type, account, doc_date) triple F1-68's start-of-run
 * preview already counted by, and the same known ceiling -- two genuinely
 * different documents of one kind, one account and one day look alike to it.
 * `--refetch` is the override for exactly that case.
 *
 * Superseded rows are excluded from both: a row a collapse marked superseded
 * is a duplicate capture of a document the canonical row already speaks for.
 */
type RecordedDocuments = {
  readonly providerIds: ReadonlySet<string>;
  readonly metadataKeys: ReadonlySet<string>;
};

/** The (doc_type, account, doc_date) key `RecordedDocuments.metadataKeys`
 * holds, spelled once so the reader and the writer cannot drift apart. */
function documentMetadataKey(
  docType: string,
  accountId: string | null,
  docDate: string | null,
): string {
  // NUL-separated, the same spelling the F1-68 count this replaces used: a
  // doc_type is free text and a separator it can contain is a key two
  // different triples could share.
  return [docType, accountId ?? "", docDate ?? ""].join("\0");
}

async function loadRecordedDocuments(
  client: ArchiveClient,
  institutionId: string,
): Promise<RecordedDocuments> {
  const existing = await client.query<{
    doc_type: string;
    account_id: string | null;
    doc_date: string | null;
    provider_document_id: string | null;
  }>(
    `SELECT doc_type, account_id, doc_date::text AS doc_date, provider_document_id
       FROM documents
      WHERE institution_id = $1 AND superseded_by IS NULL`,
    [institutionId],
  );
  const providerIds = new Set<string>();
  const metadataKeys = new Set<string>();
  for (const row of existing.rows) {
    if (row.provider_document_id !== null) providerIds.add(row.provider_document_id);
    metadataKeys.add(documentMetadataKey(row.doc_type, row.account_id, row.doc_date));
  }
  return { providerIds, metadataKeys };
}

/** How a discovered document is already on file, or `null` when it is not. */
function recordedAs(
  recorded: RecordedDocuments,
  spec: PullSpec,
): "provider_id" | "metadata" | null {
  if (spec.providerDocumentId !== null && recorded.providerIds.has(spec.providerDocumentId)) {
    return "provider_id";
  }
  if (recorded.metadataKeys.has(documentMetadataKey(spec.docType, spec.accountId, spec.docDate))) {
    return "metadata";
  }
  return null;
}

/** F1-71. Per document kind, what the expansion found and what it did about
 * it -- printed by `printDocumentKindPreview` and nowhere else. */
type RecordedCounts = {
  byProviderId: number;
  byMetadata: number;
  skipped: number;
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
  recorded: RecordedDocuments,
  refetch: boolean,
): { specs: PullSpec[]; recordedByKind: ReadonlyMap<string, RecordedCounts> } {
  const specs: PullSpec[] = [];
  const recordedByKind = new Map<string, RecordedCounts>();
  function noteRecorded(kind: string, field: keyof RecordedCounts): void {
    const counts = recordedByKind.get(kind) ?? {
      byProviderId: 0,
      byMetadata: 0,
      skipped: 0,
    };
    counts[field] += 1;
    recordedByKind.set(kind, counts);
  }
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
        const spec: PullSpec = {
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
          // F1-71: the adapter's own id when it has one finer than the
          // opaque externalId it encodes; otherwise the externalId itself,
          // which the interface already defines as this document's opaque,
          // institution-defined identity.
          providerDocumentId: doc.providerDocumentId ?? doc.externalId,
        };
        // F1-71. The defect this exists to fix: the preview line printed
        // "already recorded=1321 selected=1321" and then downloaded all 1,321
        // anyway, because nothing acted on what it had just counted. A
        // document already on file is not pulled again unless --refetch says
        // to; the counts go to the preview either way, so a run that skips
        // everything says so rather than looking like it did nothing.
        const already = recordedAs(recorded, spec);
        if (already !== null) {
          noteRecorded(
            doc.kind,
            already === "provider_id" ? "byProviderId" : "byMetadata",
          );
          if (!refetch) {
            noteRecorded(doc.kind, "skipped");
            continue;
          }
        }
        specs.push(spec);
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
          providerDocumentId: null,
        });
      }
      continue;
    }
    specs.push({
      accountId: resolveEntryAccountId(entry, accountsByExternalKey),
      docType: entry.docType,
      docDate: entry.docDate,
      selection: entry.selection,
      // F1-71. A hand-written entry is never skipped as already recorded --
      // an operator naming one document explicitly is asking for that pull --
      // but it still records the identity it acquires, so the next
      // `"expand": "discovered"` run knows about it.
      providerDocumentId:
        "externalId" in entry.selection ? entry.selection.externalId : null,
    });
  }
  return { specs, recordedByKind };
}

// --- reparse ---------------------------------------------------------------
//
// Re-runs an adapter's `parse()` over documents this space already
// retained, with no `discover()`/`acquire()` call and therefore no browser
// session and no network access at all. `rawTree.ts`/`captures.ts` already
// record everything a live pull would have handed `adapterPullToImportDocuments`:
// the retained bytes (by `documents.retained_sha256`), and the capture that
// acquired them (by `documents.capture_id`, `captures.ts`'s manifest --
// institution, account, period, capability tier, retention declaration,
// gaps). This reads both back and builds the same `AdapterPull` shape a live
// run builds, so the reparsed document goes through the identical
// conversion and import path (`adapterPullToImportDocuments`, `publishImport`)
// -- under F1-49's dedupe, reimporting a document that already landed
// everything it has is a no-op, and a still-unparsed document changes
// nothing.
//
// Scoped to the two document tiers (`pdf_statement`, `trade_confirmation`):
// each is one immutable file, one `documents` row, one `parse()` call -- the
// shape this reparse loop assumes. A `structured_api`/`tabular_export` pull
// can split one retained file across several `documents` rows (one per
// page, sharing one `retained_sha256`; see `ImportDocument.retainedSha256`'s
// doc comment), so reparsing "one row" would silently reparse every sibling
// page's rows too. Nothing about the defect this command exists for
// (F1-55) touches those two tiers, so they are simply left alone here
// rather than taught a paging model reparse does not need yet.

const REPARSEABLE_TIERS = new Set<CapabilityTier>(["pdf_statement", "trade_confirmation"]);

type ReparseDocumentRow = {
  readonly id: string;
  readonly institution_id: string;
  readonly account_id: string | null;
  readonly doc_type: string;
  readonly doc_date: string | null;
  readonly file_path: string;
  readonly sha256: string;
  readonly retained_sha256: string;
  readonly media_type: string;
  readonly capture_id: string;
};

type ReparseOutcome = {
  documentsConsidered: number;
  documentsSkippedTier: number;
  documentsReparsed: number;
  documentsNowParsed: number;
  documentsStillUnparsed: number;
  rowsInserted: number;
  rowsDeduplicated: number;
  rowsRefused: number;
  reviewItemsOpened: number;
  reviewItemsResolved: number;
  /** F1-60: items whose reason this reparse rewrote in place, because the
   * same document now reports a different parse note. */
  reviewItemsUpdated: number;
};

/**
 * `accounts.external_key -> accounts.id` for one institution, exactly the
 * shape `resolveDiscoveredAccounts` produces from a live `discover()` call --
 * except read back from rows a previous run already provisioned, since
 * reparse never discovers anything new. Cached per institution id: every
 * document in one reparse run usually belongs to the one institution its
 * `--adapter` names, but nothing here assumes that.
 *
 * Takes a client getter, not a client, so it still reads through the current
 * connection after F1-69's `withReconnect` has swapped in a fresh one --
 * a fixed client captured once, before any reconnect could happen, would
 * keep querying a dead connection forever.
 */
function accountsByExternalKeyLoader(
  getClient: () => ArchiveClient,
): (institutionId: string) => Promise<ReadonlyMap<string, string>> {
  const cache = new Map<string, Promise<ReadonlyMap<string, string>>>();
  return (institutionId: string) => {
    let cached = cache.get(institutionId);
    if (cached === undefined) {
      // F1-56: `accounts.external_key` plus every learned `account_aliases`
      // key, so a holdings row carrying a statement's printed number
      // resolves exactly as a row carrying the API's key does.
      cached = accountIdsByExternalKey(getClient(), institutionId).catch((error) => {
        // F1-69: a failed lookup (the connection died mid-query) must not
        // stay cached -- a caller retrying after `withReconnect` reconnected
        // needs this to actually re-query the fresh client, not replay the
        // same rejected promise forever.
        cache.delete(institutionId);
        throw error;
      });
      cache.set(institutionId, cached);
    }
    return cached;
  };
}

/**
 * The documents a walk over retained bytes can read: everything with
 * `retained_sha256`, optionally narrowed to one institution or to documents
 * that never parsed. Shared by `reparse`, `learn-account-aliases` and
 * `reattribute-accounts`, all three of which walk the same corpus and differ
 * only in what they do with each parse.
 */
async function selectRetainedDocuments(
  client: ArchiveClient,
  filter: { onlyUnparsed?: boolean; institutionId?: string } = {},
): Promise<ReparseDocumentRow[]> {
  // F1-71: never a superseded row. It is a duplicate capture of a document
  // the canonical row already speaks for, and reparsing it would re-derive
  // that document's rows, gates and review items once per copy -- which is
  // exactly the cost the collapse exists to remove.
  const conditions = ["retained_sha256 IS NOT NULL", "superseded_by IS NULL"];
  const params: unknown[] = [];
  if (filter.onlyUnparsed === true) conditions.push("parsed_ok = FALSE");
  if (filter.institutionId !== undefined) {
    params.push(filter.institutionId);
    conditions.push(`institution_id = $${params.length}`);
  }
  const { rows } = await client.query<ReparseDocumentRow>(
    `SELECT id, institution_id, account_id, doc_type, doc_date, file_path, sha256,
            retained_sha256, media_type, capture_id
     FROM documents
     WHERE ${conditions.join(" AND ")}
     ORDER BY id`,
    params,
  );
  return rows;
}

type OpenedDocument = {
  readonly manifest: CaptureManifest;
  readonly capturePath: string;
  readonly captureSha256: string;
  readonly bytes: Uint8Array;
};

/**
 * One retained document's capture manifest and its verified bytes, or null
 * when the capture is not one of the two document tiers a single-file parse
 * applies to (`REPARSEABLE_TIERS`). Reads the raw tree only: no browser, no
 * network, no `discover()`/`acquire()`.
 */
function openRetainedDocument(
  rawTreeRoot: string,
  doc: ReparseDocumentRow,
): OpenedDocument | null {
  const capture = readCaptureManifestById(rawTreeRoot, doc.capture_id);
  if (!REPARSEABLE_TIERS.has(capture.manifest.capabilityTier)) return null;
  return {
    manifest: capture.manifest,
    capturePath: capture.path,
    captureSha256: capture.manifestSha256,
    bytes: readAndVerify(
      rawDocumentPath(rawTreeRoot, doc.retained_sha256),
      doc.retained_sha256,
    ),
  };
}

/** Every distinct `accountExternalKey` one parse printed, across activity and
 * all three holdings kinds -- the account keys that document names. */
function printedAccountKeys(parsed: {
  activity: readonly { accountExternalKey?: string }[];
  holdings: {
    positions: readonly { accountExternalKey?: string }[];
    balances: readonly { accountExternalKey?: string }[];
    liabilities: readonly { accountExternalKey?: string }[];
  };
}): string[] {
  const keys = new Set<string>();
  for (const row of [
    ...parsed.activity,
    ...parsed.holdings.positions,
    ...parsed.holdings.balances,
    ...parsed.holdings.liabilities,
  ]) {
    if (row.accountExternalKey !== undefined) keys.add(row.accountExternalKey);
  }
  return [...keys];
}

async function runReparse(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      adapter: { type: "string" },
      "only-unparsed": { type: "boolean", default: false },
      now: { type: "string" },
    },
  });
  if (!values.adapter) throw new Error("--adapter <module path> is required");
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`--now ${values.now} is not a valid date`);
  }
  const onlyUnparsed = values["only-unparsed"] === true;

  const adapter = await loadAdapter(values.adapter);
  // Hard errors when unset, same as the ordinary pass above.
  const rawTreeRoot = resolveRawTreeRoot();
  // F1-69: reassigned by `reconnect` below when the connection dies mid-run,
  // so every reference to `pgClient` in this function has to read it fresh
  // (a closure, not a value captured once) rather than being handed the
  // client as a parameter bound at some earlier point.
  let pgClient = createArchiveClient();
  await pgClient.connect();
  const capabilities = adapter.capabilities();
  const loadAccountsByExternalKey = accountsByExternalKeyLoader(() => pgClient);
  // F1-69: bounded to 3 reconnects for this whole reparse run (see
  // pgStore.ts's withReconnect doc comment for why retrying the wrapped
  // `attempt` wholesale is safe -- reparse's own per-document import is
  // idempotent by content hash / row hash).
  const reconnectBudget = createReconnectBudget();
  function reconnect<T>(attempt: () => Promise<T>): Promise<T> {
    return withReconnect(reconnectBudget, () => pgClient, (client) => { pgClient = client; }, attempt);
  }

  const outcome: ReparseOutcome = {
    documentsConsidered: 0,
    documentsSkippedTier: 0,
    documentsReparsed: 0,
    documentsNowParsed: 0,
    documentsStillUnparsed: 0,
    rowsInserted: 0,
    rowsDeduplicated: 0,
    rowsRefused: 0,
    reviewItemsOpened: 0,
    reviewItemsResolved: 0,
    reviewItemsUpdated: 0,
  };

  try {
    const documents = await selectRetainedDocuments(pgClient, { onlyUnparsed });
    outcome.documentsConsidered = documents.length;

    for (const doc of documents) {
      // One document, one transaction: a document this reparse cannot read
      // or import never loses another document's already-committed work,
      // the same isolation the ordinary pass gives each document-tier pull
      // (see `flushDocBatch` above). F1-69: wrapped in `reconnect` so a
      // connection dropped mid-document reopens on a fresh client and retries
      // this same document's transaction from BEGIN, rather than losing it or
      // crashing the process.
      await reconnect(() => withArchiveTransaction(pgClient, async (tx) => {
        const opened = openRetainedDocument(rawTreeRoot, doc);
        if (opened === null) {
          outcome.documentsSkippedTier += 1;
          return;
        }
        const { manifest, bytes } = opened;
        const parsed = await adapter.parse({ kind: manifest.capabilityTier, bytes });
        // F1-66: the retained text lands in both places it has to be
        // resolvable from -- the raw tree, which is the thing ground rule 1
        // says can never be reconstructed, and the archive, which is the only
        // one of the two a hosted read surface can reach. Both are keyed on
        // the same content hash and both writes are idempotent, so a reparse
        // of an already-reparsed document rewrites neither.
        let textPath: string | null = null;
        if (parsed.extractedText) {
          textPath = writeRetainedText(rawTreeRoot, parsed.extractedText).path;
          await storeRetainedText(tx, parsed.extractedText);
        }
        const accountsByExternalKey = await loadAccountsByExternalKey(doc.institution_id);

        const pull: AdapterPull = {
          institutionId: doc.institution_id,
          accountId: doc.account_id,
          acquired: {
            bytes,
            retention: manifest.retention,
            manifest: {
              kind: manifest.capabilityTier,
              periodStart: manifest.periodStart,
              periodEnd: manifest.periodEnd,
              capturedAt: manifest.capturedAt,
              contentHash: doc.retained_sha256,
              mediaType: doc.media_type as RetainedMediaType,
              // Never applicable for a single-file document-tier pull
              // (adapter.ts's `AcquisitionManifestEntry.reportedRowCount`
              // doc comment); the original acquisition recorded the same.
              reportedRowCount: null,
              gaps: manifest.gaps,
            },
          },
          rows: parsed.activity,
          holdings: parsed.holdings,
          parseNote: parsed.parseNote,
          docType: doc.doc_type,
          docDate: doc.doc_date,
          persisted: {
            filePath: doc.file_path,
            textPath,
            captureId: doc.capture_id,
            // Nothing outside `persistAcquiredDocument` reads a
            // `PersistedAcquisition`'s write-result fields
            // (`documentWrite`/`textWrite`/`captureWrite`/`capturePath`), but
            // reparse writes no new capture, so these name the real capture
            // and document already on disk (both just verified above)
            // rather than inventing one.
            capturePath: opened.capturePath,
            documentWrite: {
              path: rawDocumentPath(rawTreeRoot, doc.retained_sha256),
              sha256: doc.retained_sha256,
              status: "already_exists",
            },
            textWrite: null,
            captureWrite: {
              path: opened.capturePath,
              status: "already_exists",
              manifestSha256: opened.captureSha256,
            },
          },
          activityTaxonomy: capabilities.activityTaxonomy,
          accountsByExternalKey,
        };

        const importDocuments = await adapterPullToImportDocuments(tx, pull);
        const batch: ImportBatch = { source: adapter.institutionSlug, documents: importDocuments };
        const summary = await publishImport(tx, batch, now);

        outcome.documentsReparsed += 1;
        if (parsed.parseNote) outcome.documentsStillUnparsed += 1;
        else outcome.documentsNowParsed += 1;
        outcome.rowsInserted += summary.rowsInserted;
        outcome.rowsDeduplicated += summary.rowsDeduplicated;
        outcome.rowsRefused += summary.rowsRefused;
        outcome.reviewItemsOpened += summary.reviewItemsOpened;
        outcome.reviewItemsResolved += summary.reviewItemsResolved;
        outcome.reviewItemsUpdated += summary.reviewItemsUpdated;
      }));
    }

    // F1-59. Each document above gated only what it changed; this is the one
    // whole-archive pass, at the end, where a reparse that moved rows across
    // many accounts settles every period from scratch. F1-69: same reconnect
    // treatment -- a dropped connection here reopens and re-derives from
    // scratch, rather than losing the summary this run is about to print.
    const wholeArchive =
      outcome.documentsReparsed === 0
        ? null
        : await reconnect(() => runWholeArchiveGates(pgClient));

    printReparseSummary(outcome, onlyUnparsed, wholeArchive);
  } finally {
    await closeArchiveClient(pgClient);
  }
}

function printReparseSummary(
  outcome: ReparseOutcome,
  onlyUnparsed: boolean,
  wholeArchive: WholeArchiveGates | null,
): void {
  console.log(`mode: reparse${onlyUnparsed ? " (--only-unparsed)" : ""}`);
  console.log(`documents considered: ${outcome.documentsConsidered}`);
  console.log(`documents skipped (not a document-tier capture): ${outcome.documentsSkippedTier}`);
  console.log(`documents reparsed: ${outcome.documentsReparsed}`);
  console.log(`documents now parsed: ${outcome.documentsNowParsed}`);
  console.log(`documents still unparsed: ${outcome.documentsStillUnparsed}`);
  console.log(`rows inserted: ${outcome.rowsInserted}`);
  console.log(`rows deduplicated: ${outcome.rowsDeduplicated}`);
  console.log(`rows refused: ${outcome.rowsRefused}`);
  console.log(`review items opened: ${outcome.reviewItemsOpened}`);
  console.log(`review items resolved: ${outcome.reviewItemsResolved}`);
  console.log(`review items updated: ${outcome.reviewItemsUpdated}`);
  if (wholeArchive === null) {
    console.log("whole-archive gate pass: skipped (nothing reparsed)");
  } else {
    console.log("whole-archive gate pass:");
    console.log(
      `  cash: checked=${wholeArchive.cash.periodsChecked} pass=${wholeArchive.cash.passed} ` +
        `fail=${wholeArchive.cash.failed} unverified=${wholeArchive.cash.unverified} ` +
        `coverage gaps=${wholeArchive.cash.coverageGaps.length}`,
    );
    console.log(
      `  positions: checked=${wholeArchive.positions.periodsChecked} ` +
        `pass=${wholeArchive.positions.passed} fail=${wholeArchive.positions.failed} ` +
        `unverified=${wholeArchive.positions.unverified} ` +
        `coverage gaps=${wholeArchive.positions.coverageGaps.length}`,
    );
  }
}

// --- account aliases (F1-56) ----------------------------------------------
//
// Two operator subcommands over the same walk `reparse` uses, and in this
// order:
//
//   node dist/run.js learn-account-aliases --adapter <module path> [--dry-run]
//   node dist/run.js reattribute-accounts  --adapter <module path> [--dry-run]
//
// The first learns which printed account number belongs to which account and
// writes `account_aliases`; the second moves the rows the old resolution
// misfiled and closes their review items.
//
// The order is not a preference. After aliases exist, a *reparse* of a
// consolidated statement resolves its sections to the right accounts and,
// because `row_hash` includes the account, inserts them as new rows next to
// the misfiled ones it cannot see -- two copies of one holding. Re-attributing
// first moves the existing rows (hash and all), after which that same reparse
// finds every row already stored and inserts nothing. Both commands print
// what they would do under `--dry-run` and write nothing.
//
// `--adapter` is required by both, including `reattribute-accounts`: nothing
// stored on a misfiled row says which account number it was printed under
// (see accountAliases.ts's "re-attribution" header), so the only way to know
// is to read the document again through the same `parse()`.
//
// F1-56b. A misfiled row often cannot move, because the account its printed
// number names already holds the identical stated fact: a household covered
// by both a consolidated statement and each account's own statement states
// every holding twice, and only one of the two copies was ever misfiled.
// On the owner's archive that is 24,811 of 26,069 examined rows. Left alone
// they are a second copy of one holding under the wrong account, which
// double-counts that account and fails its gates, so `--remove-duplicates`
// deletes the misfiled copy where the surviving one is confirmed to be at
// the target account. Off by default: it is the only thing in this file that
// deletes a row, and `--dry-run` prints exactly what it would delete.

/** The institution one of these commands operates on, read-only: `run.ts`'s
 * ordinary pass upserts this row from `capabilities()`, and a command that
 * only walks documents already in the archive must not create one. */
async function requireInstitutionId(
  client: ArchiveClient,
  slug: string,
): Promise<string> {
  const found = await client.query<{ id: string }>(
    "SELECT id FROM institutions WHERE slug = $1",
    [slug],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) {
    throw new Error(
      `no institutions row with slug ${JSON.stringify(slug)}; this archive has never ` +
        "imported anything from this adapter, so there is nothing to learn from",
    );
  }
  return id;
}

type AliasCommandArgs = {
  readonly adapter: string;
  readonly dryRun: boolean;
  readonly removeDuplicates: boolean;
  readonly now: Date;
};

function parseAliasCommandArgs(args: readonly string[]): AliasCommandArgs {
  const { values } = parseArgs({
    args: [...args],
    options: {
      adapter: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "remove-duplicates": { type: "boolean", default: false },
      now: { type: "string" },
    },
  });
  if (!values.adapter) throw new Error("--adapter <module path> is required");
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`--now ${values.now} is not a valid date`);
  }
  return {
    adapter: values.adapter,
    dryRun: values["dry-run"] === true,
    removeDuplicates: values["remove-duplicates"] === true,
    now,
  };
}

type AliasWalkOutcome = {
  considered: number;
  skippedTier: number;
  singleNumber: number;
  multiNumber: number;
};

async function runLearnAccountAliases(args: readonly string[]): Promise<void> {
  const {
    adapter: adapterPath,
    dryRun,
    removeDuplicates,
    now,
  } = parseAliasCommandArgs(args);
  // Refused rather than ignored: it is a destructive flag, and silently
  // accepting it here would let an operator believe rows were deleted.
  if (removeDuplicates) {
    throw new Error(
      "--remove-duplicates belongs to reattribute-accounts; learn-account-aliases " +
        "never deletes a row",
    );
  }
  const adapter = await loadAdapter(adapterPath);
  const rawTreeRoot = resolveRawTreeRoot();
  const pgClient = createArchiveClient();
  await pgClient.connect();

  const walk: AliasWalkOutcome = {
    considered: 0,
    skippedTier: 0,
    singleNumber: 0,
    multiNumber: 0,
  };

  try {
    const institutionId = await requireInstitutionId(
      pgClient,
      adapter.institutionSlug,
    );
    const resolved = await accountIdsByExternalKey(pgClient, institutionId);

    const documents = await selectRetainedDocuments(pgClient, { institutionId });
    walk.considered = documents.length;

    const observations: AliasObservation[] = [];
    for (const doc of documents) {
      const opened = openRetainedDocument(rawTreeRoot, doc);
      if (opened === null) {
        walk.skippedTier += 1;
        continue;
      }
      const parsed = await adapter.parse({
        kind: opened.manifest.capabilityTier,
        bytes: opened.bytes,
      });
      const keys = printedAccountKeys(parsed);
      if (keys.length === 0) continue;
      if (keys.length === 1) walk.singleNumber += 1;
      else walk.multiNumber += 1;
      observations.push({ accountId: doc.account_id, keys });
    }

    const learning = planAccountAliases(observations, (key) => resolved.has(key));
    const written = dryRun
      ? 0
      : await withArchiveTransaction(pgClient, (tx) =>
          insertAccountAliases(
            tx,
            institutionId,
            learning.accepted,
            "statement_number",
            `learned ${now.toISOString()} by learn-account-aliases: the number this account's ` +
              "single-number documents printed, agreed across all of them",
          ),
        );

    console.log(`mode: learn-account-aliases${dryRun ? " (dry run)" : ""}`);
    console.log(`documents considered: ${walk.considered}`);
    console.log(
      `documents skipped (not a document-tier capture): ${walk.skippedTier}`,
    );
    console.log(`documents printing one account number: ${walk.singleNumber}`);
    console.log(
      `documents printing several account numbers: ${walk.multiNumber}`,
    );
    console.log(`account numbers seen: ${learning.seen}`);
    console.log(`accepted: ${learning.accepted.size}`);
    console.log(`ambiguous: ${learning.ambiguous.length}`);
    console.log(`unmapped: ${learning.unmapped.length}`);
    // Shape and a short digest, never the digits (see maskAccountKey).
    for (const key of learning.ambiguous) {
      console.log(`  ambiguous: ${maskAccountKey(key)}`);
    }
    for (const key of learning.unmapped) {
      console.log(`  unmapped: ${maskAccountKey(key)}`);
    }
    console.log(`aliases written: ${written}`);
    if (learning.accepted.size > 0) {
      console.log(
        "next: reattribute-accounts (--dry-run first), before any reparse of these documents",
      );
    }
  } finally {
    await closeArchiveClient(pgClient);
  }
}

type ReattributionPlan = {
  readonly doc: ReparseDocumentRow;
  readonly fromAccountId: string;
  readonly targets: Record<HoldingTable, Map<string, string>>;
};

type ReattributionOutcome = {
  considered: number;
  skippedTier: number;
  documentsPlanned: number;
  examined: number;
  hashMismatch: number;
  collision: number;
  conflictingLocators: number;
  moved: MovedHolding[];
  removed: RemovedHolding[];
  reviewItemsClosed: number;
  /** F1-56b. Verdicts deleted because the period they judge no longer
   * exists: a snapshot that bounded it left the account. */
  verdictsVanished: { cash: number; positions: number };
};

/**
 * Which account each of this document's holdings should be under, keyed by
 * the one thing recorded on both the parsed holding and the stored row:
 * `source_locator`. Only locators whose target differs from the account the
 * document was pulled under appear; a locator two parsed holdings disagree
 * about is dropped rather than guessed at, and counted.
 */
function planDocumentTargets(
  parsed: {
    holdings: {
      positions: readonly { accountExternalKey?: string; locators: unknown }[];
      balances: readonly { accountExternalKey?: string; locators: unknown }[];
      liabilities: readonly { accountExternalKey?: string; locators: unknown }[];
    };
  },
  fromAccountId: string,
  resolved: ReadonlyMap<string, string>,
): { targets: Record<HoldingTable, Map<string, string>>; conflicts: number } {
  const targets: Record<HoldingTable, Map<string, string>> = {
    positions: new Map(),
    balances: new Map(),
    liabilities: new Map(),
  };
  let conflicts = 0;
  const conflicted: Record<HoldingTable, Set<string>> = {
    positions: new Set(),
    balances: new Set(),
    liabilities: new Set(),
  };
  const byTable: Record<HoldingTable, readonly { accountExternalKey?: string; locators: unknown }[]> = {
    positions: parsed.holdings.positions,
    balances: parsed.holdings.balances,
    liabilities: parsed.holdings.liabilities,
  };
  for (const table of HOLDING_TABLES) {
    for (const holding of byTable[table]) {
      if (holding.accountExternalKey === undefined) continue;
      const target = resolved.get(holding.accountExternalKey);
      if (target === undefined || target === fromAccountId) continue;
      // The stored column is exactly this, written by adapterImport.ts.
      const locator = JSON.stringify(holding.locators);
      if (conflicted[table].has(locator)) continue;
      const existing = targets[table].get(locator);
      if (existing !== undefined && existing !== target) {
        targets[table].delete(locator);
        conflicted[table].add(locator);
        conflicts += 1;
        continue;
      }
      targets[table].set(locator, target);
    }
  }
  return { targets, conflicts };
}

async function runReattributeAccounts(args: readonly string[]): Promise<void> {
  const {
    adapter: adapterPath,
    dryRun,
    removeDuplicates,
    now,
  } = parseAliasCommandArgs(args);
  const adapter = await loadAdapter(adapterPath);
  const rawTreeRoot = resolveRawTreeRoot();
  const pgClient = createArchiveClient();
  await pgClient.connect();

  const outcome: ReattributionOutcome = {
    considered: 0,
    skippedTier: 0,
    documentsPlanned: 0,
    examined: 0,
    hashMismatch: 0,
    collision: 0,
    conflictingLocators: 0,
    moved: [],
    removed: [],
    reviewItemsClosed: 0,
    verdictsVanished: { cash: 0, positions: 0 },
  };

  try {
    const institutionId = await requireInstitutionId(
      pgClient,
      adapter.institutionSlug,
    );
    const resolved = await accountIdsByExternalKey(pgClient, institutionId);

    // The whole walk runs before any write: parsing a few hundred statements
    // is minutes of CPU, and holding one transaction open across it (on a
    // hosted endpoint, no less) buys nothing -- the plan is a pure function
    // of immutable retained bytes, so nothing it reads can change under it.
    const documents = await selectRetainedDocuments(pgClient, { institutionId });
    outcome.considered = documents.length;
    const plans: ReattributionPlan[] = [];
    for (const doc of documents) {
      const opened = openRetainedDocument(rawTreeRoot, doc);
      if (opened === null) {
        outcome.skippedTier += 1;
        continue;
      }
      // A document with no account of its own filed nothing under a pull
      // account, so there is nothing here to move off one.
      if (doc.account_id === null) continue;
      const parsed = await adapter.parse({
        kind: opened.manifest.capabilityTier,
        bytes: opened.bytes,
      });
      const { targets, conflicts } = planDocumentTargets(
        parsed,
        doc.account_id,
        resolved,
      );
      outcome.conflictingLocators += conflicts;
      if (HOLDING_TABLES.every((table) => targets[table].size === 0)) continue;
      plans.push({ doc, fromAccountId: doc.account_id, targets });
    }
    outcome.documentsPlanned = plans.length;

    const touched = new Set<string>();
    for (const plan of plans) {
      touched.add(plan.fromAccountId);
      for (const table of HOLDING_TABLES) {
        for (const target of plan.targets[table].values()) touched.add(target);
      }
    }
    const accountIds = [...touched];
    const openBefore = await countOpenReviewItems(pgClient, "unknown_account_key");
    const before = await holdingsSnapshot(pgClient, accountIds);

    let openAfter = openBefore;
    let after = before;
    let gates: WholeArchiveGates | null = null;
    let wholeArchive: WholeArchiveGates | null = null;

    try {
      await withArchiveTransaction(pgClient, async (tx) => {
        for (const plan of plans) {
          for (const table of HOLDING_TABLES) {
            const result = await moveHoldings(
              tx,
              table,
              plan.doc.id,
              plan.fromAccountId,
              plan.targets[table],
              removeDuplicates,
            );
            outcome.examined += result.examined;
            outcome.hashMismatch += result.hashMismatch;
            outcome.collision += result.collision;
            outcome.moved.push(...result.moved);
            outcome.removed.push(...result.removed);
          }
        }

        // F1-56b. A durable record of every deletion, one item per document
        // and table rather than per row, before the gates run.
        await insertRows(
          tx,
          "review_items",
          REVIEW_COLUMNS,
          duplicateRemovalReviewItems(outcome.removed, now),
        );

        // F1-56b. A snapshot that left an account -- moved out or deleted --
        // was a period boundary, and the two periods it bounded no longer
        // exist. Neither gate removes such a verdict on its own (each only
        // rewrites periods that do exist), so they are deleted here, before
        // the whole-archive pass below writes the merged period that
        // replaced them.
        outcome.verdictsVanished = await deleteVanishedPeriodVerdicts(
          tx,
          departedSnapshots(outcome.moved, outcome.removed),
        );

        outcome.reviewItemsClosed = await closeResolvedAccountKeyItems(
          tx,
          [...resolved.keys()],
          `resolved ${now.toISOString()} by reattribute-accounts: this account key now ` +
            "resolves through accounts.external_key or account_aliases",
          now,
        );

        // F1-59's incremental gates, scoped to exactly the periods these
        // moves could have shifted -- on both sides: the account a snapshot
        // left needs re-deriving as much as the one it joined.
        gates = {
          cash: await runReconciliationGate(tx, undefined, {
            snapshots: [
              ...outcome.moved
                .filter((move) => move.table === "balances")
                .flatMap((move) => [
                  { accountId: move.fromAccountId, date: move.asOf },
                  { accountId: move.toAccountId, date: move.asOf },
                ]),
              // A deleted duplicate changes only the account it left: the
              // surviving row was already where it is.
              ...outcome.removed
                .filter((row) => row.table === "balances")
                .map((row) => ({ accountId: row.accountId, date: row.asOf })),
            ],
            activity: [],
          }),
          positions: await runPositionReconciliationGate(tx, undefined, {
            snapshots: [
              ...outcome.moved
                .filter(
                  (move) => move.table === "positions" && move.instrumentId !== null,
                )
                .flatMap((move) => [
                  {
                    accountId: move.fromAccountId,
                    instrumentId: move.instrumentId!,
                    date: move.asOf,
                  },
                  {
                    accountId: move.toAccountId,
                    instrumentId: move.instrumentId!,
                    date: move.asOf,
                  },
                ]),
              ...outcome.removed
                .filter(
                  (row) => row.table === "positions" && row.instrumentId !== null,
                )
                .map((row) => ({
                  accountId: row.accountId,
                  instrumentId: row.instrumentId!,
                  date: row.asOf,
                })),
            ],
            activity: [],
          }),
        };

        openAfter = await countOpenReviewItems(tx, "unknown_account_key");
        after = await holdingsSnapshot(tx, accountIds);

        // F1-56b. The one whole-archive pass, last and inside the same
        // transaction, exactly as `reparse` ends with one: a run that moved
        // and deleted snapshots across many accounts re-derives every period
        // from scratch rather than leaving the archive judged by a scope
        // that only covered what this run touched. Inside the transaction so
        // a dry run rolls its verdicts back with everything else.
        if (outcome.moved.length > 0 || outcome.removed.length > 0) {
          wholeArchive = await runWholeArchiveGates(tx);
        }
        if (dryRun) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }

    printReattributionSummary(outcome, dryRun, removeDuplicates, {
      accountIds,
      openBefore,
      openAfter,
      before,
      after,
      gates,
      wholeArchive,
    });
  } finally {
    await closeArchiveClient(pgClient);
  }
}

/** Thrown to roll back a `--dry-run` through `withArchiveTransaction`'s own
 * rollback-on-throw, exactly as `DryRunAbort` does for the ordinary pass. */
class DryRunRollback extends Error {
  constructor() {
    super("dry run: rolled back, nothing committed");
  }
}

type HoldingsSnapshot = Record<HoldingTable, Map<string, number>>;

async function holdingsSnapshot(
  client: ArchiveClient,
  accountIds: readonly string[],
): Promise<HoldingsSnapshot> {
  return {
    positions: await countHoldingsByAccount(client, "positions", accountIds),
    balances: await countHoldingsByAccount(client, "balances", accountIds),
    liabilities: await countHoldingsByAccount(client, "liabilities", accountIds),
  };
}

function printReattributionSummary(
  outcome: ReattributionOutcome,
  dryRun: boolean,
  removeDuplicates: boolean,
  counts: {
    accountIds: readonly string[];
    openBefore: number;
    openAfter: number;
    before: HoldingsSnapshot;
    after: HoldingsSnapshot;
    gates: WholeArchiveGates | null;
    wholeArchive: WholeArchiveGates | null;
  },
): void {
  console.log(
    `mode: reattribute-accounts${removeDuplicates ? " (--remove-duplicates)" : ""}` +
      `${dryRun ? " (dry run)" : ""}`,
  );
  console.log(`documents considered: ${outcome.considered}`);
  console.log(
    `documents skipped (not a document-tier capture): ${outcome.skippedTier}`,
  );
  console.log(`documents with rows to move: ${outcome.documentsPlanned}`);
  console.log(`rows examined: ${outcome.examined}`);
  for (const table of HOLDING_TABLES) {
    const moved = outcome.moved.filter((move) => move.table === table).length;
    console.log(`${table} moved: ${moved}`);
  }
  for (const table of HOLDING_TABLES) {
    const removed = outcome.removed.filter((row) => row.table === table).length;
    console.log(`${table} removed as duplicates: ${removed}`);
  }
  console.log(`rows left (row hash mismatch): ${outcome.hashMismatch}`);
  console.log(
    `rows left (target account already holds this row): ${outcome.collision}`,
  );
  if (!removeDuplicates && outcome.collision > 0) {
    console.log(
      "  those rows are duplicates of a row already at the target account; " +
        "re-run with --remove-duplicates to delete them",
    );
  }
  console.log(
    `locators with conflicting target accounts: ${outcome.conflictingLocators}`,
  );
  console.log(
    `open unknown_account_key items: ${counts.openBefore} -> ${counts.openAfter}`,
  );
  console.log(`review items closed: ${outcome.reviewItemsClosed}`);
  console.log(
    `verdicts deleted for periods that no longer exist: cash ${outcome.verdictsVanished.cash} ` +
      `positions ${outcome.verdictsVanished.positions}`,
  );
  // Per account, both directions: what it held before and after, and how
  // many of its rows were deleted as duplicates of another account's.
  const removedByAccount = new Map<string, Map<HoldingTable, number>>();
  for (const row of outcome.removed) {
    const tables = removedByAccount.get(row.accountId) ?? new Map();
    tables.set(row.table, (tables.get(row.table) ?? 0) + 1);
    removedByAccount.set(row.accountId, tables);
  }
  for (const accountId of counts.accountIds) {
    const parts = HOLDING_TABLES.map(
      (table) =>
        `${table} ${counts.before[table].get(accountId) ?? 0} -> ${counts.after[table].get(accountId) ?? 0}`,
    );
    const removed = removedByAccount.get(accountId);
    const removedPart =
      removed === undefined
        ? ""
        : `, removed as duplicates: ${HOLDING_TABLES.map(
            (table) => `${table} ${removed.get(table) ?? 0}`,
          ).join(" ")}`;
    console.log(`  account ${accountId}: ${parts.join(", ")}${removedPart}`);
  }
  printGates("gates (touched scope)", counts.gates);
  printGates("whole-archive gate pass", counts.wholeArchive);
}

function printGates(label: string, gates: WholeArchiveGates | null): void {
  if (gates === null) {
    console.log(`${label}: skipped (nothing moved or removed)`);
    return;
  }
  console.log(
    `${label} cash: checked=${gates.cash.periodsChecked} pass=${gates.cash.passed} ` +
      `fail=${gates.cash.failed} unverified=${gates.cash.unverified}`,
  );
  console.log(
    `${label} positions: checked=${gates.positions.periodsChecked} ` +
      `pass=${gates.positions.passed} fail=${gates.positions.failed} ` +
      `unverified=${gates.positions.unverified}`,
  );
}

// --- concurrency (F1-62) --------------------------------------------------
//
// `--concurrency N` bounds how many document-tier downloads (acquire, the
// slow, network-bound step -- 1.5-2s each against the real institution) run
// at once against the one bridge session (src/bridge.mjs: one CDP
// connection, but the page can run several `fetch`es concurrently). Every
// document still commits in its own Postgres transaction, one at a time:
// `pgClient` (pgStore.ts's `createArchiveClient`) is a single connection, and
// two overlapping `withArchiveTransaction` calls on it would interleave their
// BEGIN/COMMIT on the wire rather than actually running concurrently, so
// `commitLock` below serializes every commit while letting the acquisitions
// that feed it race ahead.

const MAX_CONCURRENCY = 4;

/** A FIFO async mutex: `withLock` runs `fn` only once every earlier `fn`
 * passed to this same mutex has settled, however many callers are waiting.
 * Used to keep every Postgres commit strictly one at a time even while
 * several document downloads race ahead of it. */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const runAfterPrevious = tail.then(fn, fn);
    tail = runAfterPrevious.then(
      () => undefined,
      () => undefined,
    );
    return runAfterPrevious;
  };
}

/**
 * Runs `worker(spec)` for every entry in `specs`, at most `concurrency` in
 * flight at once. `worker` is responsible for catching its own failures
 * (every caller below does: a failed download is reported and counted, not
 * thrown) -- this just bounds how many are outstanding together. `shouldStop`
 * is checked before a lane starts its next spec, never mid-flight, so a stop
 * (the breaker, or a lost session) stops new work while whatever is already
 * in flight still finishes and is reported.
 */
async function runConcurrentPool(
  specs: readonly PullSpec[],
  concurrency: number,
  worker: (spec: PullSpec) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let nextIndex = 0;
  async function runOneLane(): Promise<void> {
    for (;;) {
      if (shouldStop()) return;
      const index = nextIndex;
      if (index >= specs.length) return;
      nextIndex += 1;
      await worker(specs[index]!);
    }
  }
  const lanes = Array.from({ length: Math.min(concurrency, specs.length) }, () => runOneLane());
  await Promise.all(lanes);
}

/**
 * F1-68. One stderr line per document kind, printed once, before any
 * document is pulled: the provider's own listing total (when the adapter can
 * name one per kind -- `discovered.documentListingTotalsByKind`), how many
 * discover() actually enumerated, how many of those this archive already has
 * on file (F1-71: by provider document id, or by the older (doc_type,
 * account, doc_date) metadata match for a document recorded before that
 * column existed), how many of those were skipped rather than pulled again,
 * and how many the run actually asks for. A second, indented line breaks the
 * selected count down by the listing's own sub-type/document-type label, only when
 * the adapter names one (`DiscoveredDocument.subType`) -- that field is
 * documented to never carry a date or an account number, unlike `label`,
 * which is why this uses it instead.
 */
function printDocumentKindPreview(
  discovered: DiscoverResult,
  pullSpecs: readonly PullSpec[],
  documentsDiscoveredByKind: Readonly<Record<string, number>>,
  recordedByKind: ReadonlyMap<string, RecordedCounts>,
  refetch: boolean,
): void {
  const subTypeByExternalId = new Map<string, string>();
  for (const doc of discovered.documents.items) {
    if (doc.subType !== undefined) subTypeByExternalId.set(doc.externalId, doc.subType);
  }
  const kinds = new Set<string>(Object.keys(documentsDiscoveredByKind));
  for (const spec of pullSpecs) {
    if (isDocumentTierKind(spec.selection.kind)) kinds.add(spec.selection.kind);
  }
  for (const kind of [...kinds].sort()) {
    const selected = pullSpecs.filter((spec) => spec.selection.kind === kind);
    const listingTotal = discovered.documentListingTotalsByKind?.[kind];
    const recorded = recordedByKind.get(kind) ?? {
      byProviderId: 0,
      byMetadata: 0,
      skipped: 0,
    };
    console.error(
      `document kind ${kind}: listing total=${listingTotal ?? "unknown"} ` +
        `discovered=${documentsDiscoveredByKind[kind] ?? 0} ` +
        `already recorded=${recorded.byProviderId + recorded.byMetadata} ` +
        `(provider id=${recorded.byProviderId}, metadata=${recorded.byMetadata}) ` +
        `skipped=${recorded.skipped}${refetch ? " (--refetch: pulling them anyway)" : ""} ` +
        `selected=${selected.length}`,
    );
    const bySubType = new Map<string, number>();
    for (const spec of selected) {
      if (!("externalId" in spec.selection)) continue;
      const subType = subTypeByExternalId.get(spec.selection.externalId);
      if (subType === undefined) continue;
      bySubType.set(subType, (bySubType.get(subType) ?? 0) + 1);
    }
    if (bySubType.size > 0) {
      const breakdown = [...bySubType.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([subType, n]) => `${subType}=${n}`)
        .join(", ");
      console.error(`  ${kind} selected by type: ${breakdown}`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "reparse") {
    return runReparse(argv.slice(1));
  }
  if (argv[0] === "learn-account-aliases") {
    return runLearnAccountAliases(argv.slice(1));
  }
  if (argv[0] === "reattribute-accounts") {
    return runReattributeAccounts(argv.slice(1));
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      adapter: { type: "string" },
      session: { type: "string" },
      selection: { type: "string" },
      now: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "commit-every": { type: "string", default: "1" },
      gates: { type: "string", default: "full" },
      "acquire-only": { type: "boolean", default: false },
      concurrency: { type: "string", default: "1" },
      refetch: { type: "boolean", default: false },
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
  // F1-59. Every document's publication gates incrementally either way (see
  // publishImport). This decides only whether the run ends with one
  // whole-archive pass, which is the default because it is now cheap.
  const gates = values.gates;
  if (gates !== "full" && gates !== "incremental") {
    throw new Error(`--gates must be "full" or "incremental", got ${gates}`);
  }
  // F1-62. Downloads and retains each document-tier pull (document row,
  // capture, sha, byte length, media type) with no parse and no rows,
  // marking it `parsed_ok = FALSE` so `reparse` (its own `retained_sha256 IS
  // NOT NULL` walk) picks it up later. No gate ever runs in this mode -- see
  // runPulls and printSummary below.
  const acquireOnly = values["acquire-only"] === true;
  // F1-71. Pull every discovered document again, even one this archive has
  // already recorded. The override for the one case the already-recorded
  // check gets wrong on its own: a document recorded before
  // `provider_document_id` existed is matched by (doc_type, account,
  // doc_date) alone, so a genuinely new document sharing that triple with an
  // existing one looks recorded. Re-pulling is safe either way -- the bytes
  // are retained as their own capture (ground rule 1), and the importer
  // refuses to make a second `documents` row for a provider id it already
  // has -- it is just work nobody asked for unless this flag is set.
  const refetch = values.refetch === true;
  // F1-62. Bounded parallel document downloads against the one bridge
  // session -- the download itself is the slow, network-bound step; the
  // Postgres commit that follows each one stays strictly one at a time
  // regardless (see runConcurrentPool/createMutex above).
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(
      `--concurrency must be an integer between 1 and ${MAX_CONCURRENCY}, got ${values.concurrency}`,
    );
  }

  const adapter = await loadAdapter(values.adapter);
  const buildSession = await loadSessionBuilder(values.session);
  const selectionFile = readSelectionFile(values.selection);
  const capabilities = adapter.capabilities();

  // Hard errors when unset -- FINANCE_ARCHIVE_RAW_TREE_ROOT, FINANCE_ARCHIVE_SPACE_ID.
  const rawTreeRoot = resolveRawTreeRoot();

  // Hard error when FINANCE_ARCHIVE_DATABASE_URL is unset.
  // F1-69: reassigned by `reconnect` below (defined after `dryRun` is in
  // scope) when the connection dies mid-run -- every reference to `pgClient`
  // in this function has to read it fresh rather than capture it once.
  let pgClient = createArchiveClient();
  await pgClient.connect();
  // F1-69. `--dry-run` runs the whole pass inside one Postgres transaction
  // that must never partially commit, so a connection lost inside it just
  // fails the dry run rather than reconnecting mid-transaction (see
  // withReconnect's doc comment in pgStore.ts for why retrying wholesale is
  // otherwise safe -- a dry run's own atomicity is the one thing that
  // reconnecting here would break). A committed run reconnects.
  const reconnectBudget = createReconnectBudget();
  function reconnect<T>(attempt: () => Promise<T>): Promise<T> {
    if (dryRun) return attempt();
    return withReconnect(reconnectBudget, () => pgClient, (client) => { pgClient = client; }, attempt);
  }
  // F1-69b. `session = await buildSession()` and `adapter.discover()` below
  // are both browser work with no query on `pgClient` at all -- a real
  // discover() can run for several minutes that way -- and the hosted proxy
  // in front of the archive closes a connection it sees no traffic on for a
  // while. Left alone, the *first* query after discover() (resolving the
  // accounts it found) is what discovers the connection is already dead,
  // outside any per-document retry. A keepalive covers exactly that gap:
  // stopped right before the per-document loop starts, where ordinary query
  // traffic resumes on its own.
  const stopKeepalive = startKeepalive(() => pgClient);

  // F1-64: closed in the outer `finally` below, on the stop path exactly like
  // normal completion -- a bridge session (adapter-morgan-stanley/src/
  // bridge.mjs) holds a CDP WebSocket and a keep-alive interval that outlive
  // the throw otherwise, which is what left a "session is gone" run's process
  // alive for 40+ minutes with no sign-in wait ever logged.
  let session: AdapterSession | undefined;

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

    session = await buildSession();
    // F1-70. Scope discover()'s document listing to the kinds the selection
    // actually asks for (across every "expand": "discovered" entry) so a
    // listing this run never needed -- and that a real provider can fail to
    // pull for reasons that have nothing to do with the kinds requested --
    // cannot mark the whole result incomplete and refuse a run that never
    // wanted it. No such entry (or none naming a kind), no argument: an
    // adapter that ignores `kinds` still lists everything, exactly as
    // before this parameter existed.
    const requestedDiscoveredKinds = new Set<string>();
    for (const entry of selectionFile.pulls) {
      if (entry.expand === "discovered") {
        for (const kind of entry.kinds) requestedDiscoveredKinds.add(kind);
      }
    }
    const discovered = await adapter.discover(
      session,
      requestedDiscoveredKinds.size > 0
        ? ([...requestedDiscoveredKinds] as Extract<CapabilityTier, "pdf_statement" | "trade_confirmation">[])
        : undefined,
    );
    // F1-32: makes every account discover() reported resolvable by its own
    // external key, so a selection can name one without a separate
    // provisioning step. Keyed on the resolved institutionId, not
    // selectionFile.institutionId, which the file no longer has to name.
    // F1-69b: this is the first query after `discover()`'s long
    // no-database phase, so it is exactly the one that used to find the
    // connection already closed. Wrapped in `reconnect` like every other
    // archive call in the per-document loop below.
    const accountsByExternalKey = await reconnect(() =>
      resolveDiscoveredAccounts(pgClient, institutionId, discovered.accounts),
    );
    // F1-56. What a *row* resolves its own `accountExternalKey` against:
    // every account key this institution answers to, which is the map above
    // plus every learned `account_aliases` key (a statement's printed
    // number). The selection file still names accounts by discovered key
    // alone -- an alias is a thing documents print, not a thing an operator
    // writes in a selection -- so `accountsByExternalKey` keeps that job.
    const rowAccountKeys = await reconnect(() =>
      accountIdsByExternalKey(pgClient, institutionId),
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
    // F1-71. What this institution already has on file, read before the
    // expansion rather than after it: the expansion is what acts on it now,
    // skipping a discovered document this archive already recorded instead
    // of counting it and downloading it anyway.
    const recordedDocuments = await reconnect(() =>
      loadRecordedDocuments(pgClient, institutionId),
    );
    const { specs: pullSpecs, recordedByKind } = expandSelectionPulls(
      selectionFile.pulls,
      discovered,
      accountsByExternalKey,
      recordedDocuments,
      refetch,
    );

    // F1-62. Acquire-only retains bytes for later `reparse`, which is scoped
    // to the two document tiers (REPARSEABLE_TIERS above) -- a
    // structured_api/tabular_export selection has no "retained but unparsed"
    // shape for reparse to pick up later, so refuse the mix up front rather
    // than silently importing one tier and only retaining the other. Run
    // those pulls through an ordinary (non-acquire-only) pass instead.
    if (acquireOnly) {
      const nonDocumentKinds = new Set(
        pullSpecs
          .map((spec) => spec.selection.kind)
          .filter((kind) => !isDocumentTierKind(kind)),
      );
      if (nonDocumentKinds.size > 0) {
        throw new Error(
          `--acquire-only supports only pdf_statement/trade_confirmation selections; this ` +
            `selection also has ${[...nonDocumentKinds].join(", ")} pull(s). Split them into a ` +
            "separate selection file and run that one without --acquire-only.",
        );
      }
    }

    // F1-40: how document-tier pulls were filed, independent of whether they
    // go on to be acquired, skipped or failed below.
    let documentsFiledByAccount = 0;
    let documentsFiledInstitutionWide = 0;
    for (const spec of pullSpecs) {
      if (!isDocumentTierKind(spec.selection.kind)) continue;
      if (spec.accountId === null) documentsFiledInstitutionWide += 1;
      else documentsFiledByAccount += 1;
    }
    // F1-68. Total document-tier pulls this run's loop will process, for the
    // "pulled N of M" progress line below -- every document-tier pull is
    // filed one way or the other above, so their sum is the whole count.
    const totalDocumentPulls = documentsFiledByAccount + documentsFiledInstitutionWide;

    // F1-68. One line per document kind, to stderr, before anything is
    // pulled: what the provider's own listing reports, what discover()
    // actually enumerated, how many this run expects to already have on
    // file, how many of those it skipped for that reason (F1-71), and how
    // many the selection is actually left asking for -- an operator staring
    // down a selection that can take hours gets to see the shape of the run
    // before it starts, not just its final summary.
    printDocumentKindPreview(
      discovered,
      pullSpecs,
      documentsDiscoveredByKind,
      recordedByKind,
      refetch,
    );

    // F1-62. `resolveAccountLast4` below is memoized per account id, but a
    // miss issues a plain `pgClient.query` outside any of runPulls' own
    // commit locking -- with `--concurrency` > 1, two lanes acquiring for the
    // same account at once could both miss the cache together and both call
    // `pgClient.query` concurrently on the one connection. Warming every
    // distinct account's entry here, sequentially, before any lane starts,
    // means every lookup during the concurrent pool below is a cache hit (a
    // synchronous Map read), never a query.
    for (const accountId of new Set(
      pullSpecs.map((spec) => spec.accountId).filter((id): id is string => id !== null),
    )) {
      await reconnect(() => resolveAccountLast4(pgClient, accountId, accountLast4Cache));
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
    let incrementalCashPeriods = 0;
    let incrementalPositionPeriods = 0;
    let wholeArchiveGates: WholeArchiveGates | null = null;
    const allDocumentShas: string[] = [];

    let documentPullsAcquired = 0;
    let documentPullsSkipped = 0;
    let documentPullsFailed = 0;
    const documentPullsByKind = new Map<string, DocKindCounts>();
    // F1-68. Every document-tier pull this run's loop has attempted so far
    // (whichever lane got to it, acquired/skipped/failed alike) -- a plain
    // counter is safe here for the same reason `consecutiveDocumentFailures`
    // is (see runPulls's own doc comment): JS never runs two lanes'
    // synchronous code at the same time.
    let documentsPulled = 0;

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
      /** F1-62. Deferred, not written here: see this function's own doc
       * comment below. */
      readonly extractedText: string | null;
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
          providerDocumentId: spec.providerDocumentId,
          acquired,
        },
        // F1-44: retained whenever the adapter extracted any, parsed or not.
        parsed.extractedText ?? null,
      );
      // F1-66, the same pair of writes the reparse above makes: the raw tree
      // holds the text file (written just above, synchronously) and the
      // archive holds its bytes, both addressed by the same sha, because a
      // hosted read surface verifying a `retained_text_span_v1` citation can
      // reach only the second. F1-62: the archive write itself is a bare
      // `pgClient.query` outside any transaction, so with `--concurrency` > 1
      // it cannot run here -- this function's own acquisition phase is the
      // part several lanes run at once. The caller writes it from inside
      // `commitLock`, alongside this same document's commit, instead.
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
          providerDocumentId: spec.providerDocumentId,
          persisted,
          activityTaxonomy: capabilities.activityTaxonomy,
          // F1-35: lets adapterImport.ts resolve a row's own
          // ParsedRow.accountExternalKey (an institution-wide pull's rows,
          // or any row an adapter attributes this way) against the accounts
          // this run already discovered, instead of always importing under
          // `accountId` above. F1-56: and against every learned alias.
          accountsByExternalKey: rowAccountKeys,
        },
        kind: spec.selection.kind,
        contentHash: acquired.manifest.contentHash,
        parsedRowCount:
          parsed.activity.length +
          parsed.holdings.positions.length +
          parsed.holdings.balances.length +
          parsed.holdings.liabilities.length,
        extractedText: parsed.extractedText ?? null,
      };
    }

    /** F1-62. `--acquire-only`'s own acquisition step: downloads and persists
     * the raw bytes exactly like `acquireAndPersist` above, but never calls
     * `adapter.parse()` -- "no parse and no rows" is the point of this mode,
     * not just a slower path to the same summary. */
    type AcquiredOnly = {
      readonly accountId: string | null;
      readonly docType: string;
      readonly docDate: string | null;
      readonly kind: CapabilityTier;
      readonly contentHash: string;
      readonly filePath: string;
      readonly captureId: string;
      readonly byteLength: number;
      readonly mediaType: RetainedMediaType;
      readonly providerDocumentId: string | null;
    };

    async function acquireAndRetainOnly(spec: PullSpec): Promise<AcquiredOnly> {
      const selection = { ...spec.selection, session } as AcquireSelection;
      const acquired = await adapter.acquire(selection);
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
          providerDocumentId: spec.providerDocumentId,
          acquired,
        },
        // No parse call: nothing was extracted to retain a text artifact for.
        null,
      );
      bytesAcquired += acquired.bytes.length;
      manifestHashes.push(acquired.manifest.contentHash);
      documentsAcquiredCount += 1;
      return {
        accountId: spec.accountId,
        docType: spec.docType,
        docDate: spec.docDate,
        kind: spec.selection.kind,
        contentHash: acquired.manifest.contentHash,
        filePath: persisted.filePath,
        captureId: persisted.captureId,
        byteLength: acquired.bytes.length,
        mediaType: acquired.manifest.mediaType,
        providerDocumentId: spec.providerDocumentId,
      };
    }

    /** F1-62. Writes just the `documents` row -- no `adapterPullToImportDocuments`,
     * no `publishImport`, so no instrument resolution, no review item, and no
     * gate ever runs for it (the point of `--acquire-only`). `parsed_ok`
     * defaults FALSE and `retained_sha256` is set, exactly the shape
     * `selectRetainedDocuments` (used by `reparse` above) already looks for --
     * no new "pending" column or flag is needed for reparse to pick this up
     * later. Its own transaction, same as every other document-tier pull. */
    async function commitRetainedOnly(
      item: AcquiredOnly,
    ): Promise<"retained" | "already_retained"> {
      return withArchiveTransaction(pgClient, async (tx) => {
        // F1-71: the same two-part identity the importer uses -- these exact
        // bytes, or this provider document under some other rendering of
        // them. Either way the bytes and their capture are already in the raw
        // tree; a second `documents` row is what this refuses.
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM documents
            WHERE sha256 = $1
               OR (institution_id = $2 AND provider_document_id = $3
                   AND provider_document_id IS NOT NULL AND superseded_by IS NULL)`,
          [item.contentHash, institutionId, item.providerDocumentId],
        );
        if (existing.rows[0]) return "already_retained";
        await tx.query(
          `INSERT INTO documents
             (id, institution_id, account_id, doc_type, doc_date, file_path, sha256, parsed_ok,
              retained_sha256, retained_byte_length, media_type, capture_id, text_path,
              provider_document_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10, $11, NULL, $12)`,
          [
            randomUUID(),
            institutionId,
            item.accountId,
            item.docType,
            item.docDate,
            item.filePath,
            item.contentHash,
            // A single-file document-tier pull's retained_sha256 is its own
            // content hash, exactly as adapterImport.ts's collectDocuments
            // computes sha256/retainedSha256 for the "single" case.
            item.contentHash,
            item.byteLength,
            item.mediaType,
            item.captureId,
            item.providerDocumentId,
          ],
        );
        return "retained";
      });
    }

    /** `documents.sha256` is content-addressed and unique (importer.ts's
     * whole-document skip); checking it directly, before ever building an
     * ImportBatch, is what lets an already-imported document be reported as
     * "skipped" rather than folded into `rowsDeduplicated`, and lets a
     * commit-every batch leave it out of the transaction entirely. */
    async function isDocumentAlreadyImported(
      sha256: string,
      providerDocumentId: string | null,
    ): Promise<boolean> {
      // F1-71. Two ways to already have it. The first is unchanged: these
      // exact bytes are on file and parsed. The second is the provider's own
      // id on file under different bytes -- the site re-rendered a document
      // this archive already holds, so the bytes just acquired are a new
      // capture of it (retained in the raw tree by `persistAcquiredDocument`
      // above, ground rule 1) and nothing about them belongs in the database.
      // `importBatch` refuses the second case too; this check only lets the
      // run report it as skipped and keep it out of the transaction.
      const found = await pgClient.query<{ id: string }>(
        `SELECT id FROM documents
          WHERE (sha256 = $1 AND parsed_ok)
             OR (institution_id = $2 AND provider_document_id = $3
                 AND provider_document_id IS NOT NULL
                 AND sha256 <> $1 AND superseded_by IS NULL)`,
        [sha256, institutionId, providerDocumentId],
      );
      return found.rows[0] !== undefined;
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
        // F1-59: what the incremental gates checked for this publication.
        incrementalCashPeriods += publishSummary.cash.periodsChecked;
        incrementalPositionPeriods += publishSummary.positions.periodsChecked;
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
        // outage -- which F1-69's `reconnect` now recovers from instead of
        // treating as fatal.
        const already = await reconnect(() =>
          isDocumentAlreadyImported(
            item.acquired.contentHash,
            item.spec.providerDocumentId,
          ),
        );
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
        // F1-69: retried on a fresh client if the connection died -- safe
        // because publishImport (inside publishOne) dedupes by content hash
        // and row hash, so replaying this same batch from BEGIN is a no-op
        // for anything a first attempt already committed.
        await reconnect(() => publishOne(toImport.map((item) => item.acquired)));
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
     * F1-39/F1-62. Processes every pull in original order, with document-tier
     * pulls (`pdf_statement`/`trade_confirmation`) running through
     * `runConcurrentPool` at up to `--concurrency` lanes -- at `--concurrency
     * 1` (the default) that pool degenerates to exactly the previous
     * sequential loop, one spec at a time, in order. Every document still
     * lands in its own commit: the ordinary path batches up to `commitEvery`
     * of them per transaction exactly as before, and `--acquire-only` always
     * commits one document per transaction (`commitRetainedOnly`). Every
     * commit -- from whichever lane produced it -- runs through `commitLock`,
     * so they never overlap on the one Postgres connection even though the
     * downloads that feed them do. `structured_api`/`tabular_export` pulls
     * are never batched or run concurrently -- each gets its own transaction,
     * and a failure there still aborts the run exactly as it always has (no
     * selection here names thousands of those the way a full document
     * retention window does).
     */
    async function runPulls(): Promise<void> {
      // F1-54 circuit breaker: counts document-pull failures across every
      // lane and every document kind, and resets on any success. Tracked
      // here (not as a module-level `let`) so it starts fresh every call.
      // Plain reads/writes are safe across concurrent lanes: JS never runs
      // two lanes' synchronous code at the same time, only their network
      // waits overlap.
      let consecutiveDocumentFailures = 0;
      // F1-54/F1-62. Set once, by whichever lane hits it first, and checked
      // by every lane (including the one that set it) before starting its
      // next spec -- a stop mid-group drains whatever is already in flight
      // (already-committed documents stay committed) rather than starting
      // anything new.
      let stopped: Error | null = null;
      // F1-62. Every actual commit -- flushDocBatch, publishOne,
      // commitRetainedOnly -- runs through this, in the order it is
      // requested, however many lanes are racing to request one: see this
      // function's own doc comment above for why that has to be true.
      const commitLock = createMutex();

      function noteFailure(error: unknown): void {
        consecutiveDocumentFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        // A lost browser session fails every remaining document the same
        // way within milliseconds (20,757 of them on the first full pull).
        // Stop instead: what was committed stays committed, and the rerun
        // skips documents already imported (or, under --acquire-only,
        // already retained).
        if (/SIGNED_OUT|no session headers captured yet|no Authorization bearer captured yet/.test(message)) {
          stopped ??= new Error(
            `run stopped: the browser session is gone (${message.slice(0, 120)}). ` +
              `${documentPullsAcquired} document pull(s) were committed before this; sign in again and rerun the same selection to continue.`,
          );
          return;
        }
        if (consecutiveDocumentFailures >= CONSECUTIVE_DOCUMENT_FAILURE_LIMIT) {
          const errorClass = error instanceof Error ? error.constructor.name : typeof error;
          stopped ??= new Error(
            `run stopped: ${consecutiveDocumentFailures} consecutive document pulls failed ` +
              `(last error: ${errorClass}: ${message.slice(0, 200)}). ` +
              `${documentPullsAcquired} document pull(s) were committed before this; each document ` +
              "commits in its own transaction, so already-committed documents are untouched. " +
              "Fix the underlying failure and rerun the same selection to continue.",
          );
        }
      }

      async function processDocumentSpec(spec: PullSpec): Promise<void> {
        // F1-68. Reported as this document is picked up, not once it
        // finishes -- with `--concurrency` > 1 several lanes are always
        // mid-flight, so "pulled" here means "started", the same way the
        // final summary's own counts only settle once every lane is done.
        documentsPulled += 1;
        if (documentsPulled % 100 === 0) {
          console.error(`pulled ${documentsPulled} of ${totalDocumentPulls}`);
        }
        if (acquireOnly) {
          let acquired: AcquiredOnly;
          try {
            acquired = await acquireAndRetainOnly(spec);
          } catch (error) {
            documentPullsFailed += 1;
            bumpDocKind(spec.selection.kind, "failed");
            reportFailure(spec, error);
            noteFailure(error);
            return;
          }
          consecutiveDocumentFailures = 0;
          // F1-69: retries this one document's transaction on a fresh client
          // if the connection died since acquisition -- safe because
          // commitRetainedOnly checks `documents.sha256` before inserting.
          const result = await commitLock(() => reconnect(() => commitRetainedOnly(acquired)));
          if (result === "already_retained") {
            documentPullsSkipped += 1;
            bumpDocKind(acquired.kind, "skipped");
          } else {
            documentPullsAcquired += 1;
            bumpDocKind(acquired.kind, "acquired");
          }
          return;
        }
        let acquired: Acquired;
        try {
          acquired = await acquireAndPersist(spec);
        } catch (error) {
          documentPullsFailed += 1;
          bumpDocKind(spec.selection.kind, "failed");
          reportFailure(spec, error);
          noteFailure(error);
          return;
        }
        consecutiveDocumentFailures = 0;
        // F1-69: a `const`, not `acquired.extractedText` re-read inside the
        // retry closure below -- narrowing a `let`-bound `acquired` would not
        // otherwise survive into the nested arrow function.
        const extractedText = acquired.extractedText;
        await commitLock(async () => {
          // F1-62. Deferred from acquireAndPersist (see its own doc comment):
          // a bare `pgClient.query`, so it has to run under the same lock as
          // every other commit rather than during the concurrent acquisition
          // phase. F1-69: retried on a fresh client if the connection died --
          // idempotent by content hash (retainedTexts.ts's ON CONFLICT DO
          // NOTHING).
          if (extractedText) await reconnect(() => storeRetainedText(pgClient, extractedText));
          pendingDocBatch.push({ spec, acquired });
          // F1-69: flushDocBatch reconnects internally around its own two
          // queries (see its own doc comment), so no wrapping is needed here.
          if (pendingDocBatch.length >= commitEvery) await flushDocBatch();
        });
      }

      async function runDocumentGroup(group: readonly PullSpec[]): Promise<void> {
        await runConcurrentPool(group, concurrency, processDocumentSpec, () => stopped !== null);
        // Whatever this group's lanes queued but did not reach commitEvery
        // for yet -- flushed before a following structured_api/tabular_export
        // pull (which must never share a transaction with a document-tier
        // one) and again at the very end below.
        await commitLock(() => flushDocBatch());
      }

      let group: PullSpec[] = [];
      for (const spec of pullSpecs) {
        if (stopped) break;
        if (isDocumentTierKind(spec.selection.kind)) {
          group.push(spec);
          continue;
        }
        if (group.length > 0) {
          await runDocumentGroup(group);
          group = [];
          if (stopped) break;
        }
        await commitLock(() => flushDocBatch());
        const acquired = await acquireAndPersist(spec);
        const extractedText = acquired.extractedText;
        await commitLock(async () => {
          // F1-69: both retried on a fresh client if the connection died --
          // idempotent (content-hash ON CONFLICT / row-hash dedupe).
          if (extractedText) await reconnect(() => storeRetainedText(pgClient, extractedText));
          await reconnect(() => publishOne([acquired]));
        });
      }
      if (group.length > 0) await runDocumentGroup(group);
      if (stopped) throw stopped;
    }

    async function buildOutcome(): Promise<RunOutcome> {
      // F1-69: reads, retried on a fresh client the same as every write above
      // -- there is nothing for them to lose by retrying.
      const currencySums = await reconnect(() => sumByCurrency(pgClient, allDocumentShas));
      const cashVerdicts = await reconnect(() => fetchCashVerdicts(pgClient, accountIds));
      const positionVerdicts = await reconnect(() => fetchPositionVerdicts(pgClient, accountIds));
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
        // F1-62. Sorted by kind name: with `--concurrency` > 1, which kind's
        // first pull is bumped first depends on completion order, not spec
        // order, and the printed summary must not depend on that.
        documentPullsByKind: Object.fromEntries(
          [...documentPullsByKind.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
        documentsFiledByAccount,
        documentsFiledInstitutionWide,
        incrementalPeriodsChecked: {
          cash: incrementalCashPeriods,
          positions: incrementalPositionPeriods,
        },
        wholeArchiveGates,
      };
    }

    /** F1-59/F1-62. One whole-archive pass at the end of the run, by default
     * -- except under `--acquire-only`, which never runs a gate at all: no
     * row was ever inserted for a gate to check, and the whole point of this
     * mode is downloading thousands of documents as fast as the bridge
     * allows, not paying for a pass that would find nothing changed. */
    async function finishGates(): Promise<void> {
      if (acquireOnly || gates !== "full") return;
      // F1-69: reconnects and re-derives from scratch if the connection died
      // during this pass -- `reconnect` is a no-op wrapper under `--dry-run`
      // (see its own doc comment), where this call is already inside the one
      // transaction that must not be interrupted.
      wholeArchiveGates = await reconnect(() => runWholeArchiveGates(pgClient));
    }

    // F1-69b: ordinary query traffic resumes here (each document-tier pull
    // and the gates/verdicts after it are already wrapped in `reconnect`),
    // so the keepalive's job is done.
    stopKeepalive();

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
          await finishGates();
          throw new DryRunAbort(await buildOutcome());
        });
        throw new Error("unreachable: dry run always throws DryRunAbort");
      } catch (error) {
        if (!(error instanceof DryRunAbort)) throw error;
        outcome = error.result;
      }
    } else {
      await runPulls();
      await finishGates();
      outcome = await buildOutcome();
    }

    printSummary(outcome, { dryRun, committed: !dryRun, acquireOnly });
  } finally {
    // F1-64: on every exit from the try above -- normal completion or a
    // thrown stop (SIGNED_OUT, the consecutive-failure breaker, anything
    // else) -- close the session first. A bridge session's own `close()` is
    // what clears its keep-alive interval and closes its CDP WebSocket; a
    // session with no such handles (the synthetic adapter's) simply has no
    // `close` and this is a no-op.
    await session?.close?.();
    // F1-69b: a no-op if the loop was reached (stopped above already), and
    // otherwise cleans up an interval left running by a throw before then
    // (`clearInterval` on an already-cleared timer is a no-op, so calling
    // this twice is safe).
    stopKeepalive();
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
  meta: { readonly dryRun: boolean; readonly committed: boolean; readonly acquireOnly: boolean },
): void {
  console.log(
    `mode: ${meta.dryRun ? "dry-run (rolled back, nothing committed)" : "committed"}` +
      (meta.acquireOnly ? " (--acquire-only: no parse, no rows, no gate)" : ""),
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
  // F1-62. Under --acquire-only these count documents retained (a document
  // row with retained bytes and no parse), not documents imported.
  console.log(
    `document pulls ${meta.acquireOnly ? "retained" : "acquired"}: ${outcome.documentPullsAcquired}`,
  );
  console.log(
    `document pulls skipped (${meta.acquireOnly ? "already retained" : "already imported"}): ` +
      `${outcome.documentPullsSkipped}`,
  );
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
  console.log(
    `incremental gate periods checked: cash=${outcome.incrementalPeriodsChecked.cash} ` +
      `positions=${outcome.incrementalPeriodsChecked.positions}`,
  );
  if (meta.acquireOnly) {
    console.log("whole-archive gate pass: skipped (--acquire-only: no gate runs in acquire-only mode)");
  } else if (outcome.wholeArchiveGates === null) {
    console.log("whole-archive gate pass: skipped (--gates incremental)");
  } else {
    const { cash, positions } = outcome.wholeArchiveGates;
    console.log("whole-archive gate pass:");
    console.log(
      `  cash: checked=${cash.periodsChecked} pass=${cash.passed} ` +
        `fail=${cash.failed} unverified=${cash.unverified} ` +
        `coverage gaps=${cash.coverageGaps.length}`,
    );
    console.log(
      `  positions: checked=${positions.periodsChecked} pass=${positions.passed} ` +
        `fail=${positions.failed} unverified=${positions.unverified} ` +
        `coverage gaps=${positions.coverageGaps.length}`,
    );
  }
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
