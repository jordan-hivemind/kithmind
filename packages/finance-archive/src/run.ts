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
};

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
  readonly pulls: readonly SelectionEntry[];
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
  readonly rowsSkipped: number;
  readonly reviewItemsOpened: number;
  readonly currencySums: readonly CurrencySum[];
  readonly cashVerdicts: readonly CashVerdict[];
  readonly positionVerdicts: readonly PositionVerdict[];
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

function documentRowCount(document: ImportDocument): number {
  return (
    document.rows.length +
    (document.positions?.length ?? 0) +
    (document.balances?.length ?? 0) +
    (document.liabilities?.length ?? 0)
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      adapter: { type: "string" },
      session: { type: "string" },
      selection: { type: "string" },
      now: { type: "string" },
      "dry-run": { type: "boolean", default: false },
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

    const pulls: AdapterPull[] = [];
    let bytesAcquired = 0;
    const manifestHashes: string[] = [];

    for (const entry of selectionFile.pulls) {
      const accountId = resolveEntryAccountId(entry, accountsByExternalKey);
      // F1-35: an institution-wide pull names no single account, so there is
      // no accounts.acct_last4 to look up either -- "all" says so on the
      // capture manifest rather than a guessed or borrowed last4 (see
      // captures.ts's acctLast4 doc comment).
      const accountLast4 =
        accountId === null
          ? "all"
          : await resolveAccountLast4(pgClient, accountId, accountLast4Cache);
      const selection = { ...entry.selection, session } as AcquireSelection;
      const acquired = await adapter.acquire(selection);
      const parsed = await adapter.parse({
        kind: entry.selection.kind,
        bytes: acquired.bytes,
      });
      const persisted = persistAcquiredDocument(rawTreeRoot, {
        institutionId,
        accountId,
        institutionSlug: capabilities.institutionSlug,
        accountLast4,
        docType: entry.docType,
        acquired,
      });
      bytesAcquired += acquired.bytes.length;
      manifestHashes.push(acquired.manifest.contentHash);
      pulls.push({
        institutionId,
        accountId,
        acquired,
        rows: parsed.activity,
        holdings: parsed.holdings,
        docType: entry.docType,
        docDate: entry.docDate,
        persisted,
        activityTaxonomy: capabilities.activityTaxonomy,
        // F1-35: lets adapterImport.ts resolve a row's own
        // ParsedRow.accountExternalKey (an institution-wide pull's rows, or
        // any row an adapter attributes this way) against the accounts this
        // run already discovered, instead of always importing under
        // `accountId` above.
        accountsByExternalKey,
      });
    }

    // F1-35: an institution-wide pull's own accountId is null, and its rows
    // are attributed by their own accountExternalKey instead -- include
    // every discovered account in the summary's verdict lookups when that
    // happened, or the accounts those rows actually landed on would be
    // silently absent from "cash reconciliation verdicts" / "position
    // reconciliation verdicts" below.
    const namedAccountIds = pulls
      .map((pull) => pull.accountId)
      .filter((id): id is string => id !== null);
    const accountIds = [
      ...new Set(
        pulls.some((pull) => pull.accountId === null)
          ? [...namedAccountIds, ...accountsByExternalKey.values()]
          : namedAccountIds,
      ),
    ];
    // One digest standing for this run's whole acquisition manifest: the
    // sha256 of every acquired document's own content hash, sorted so the
    // digest does not depend on acquisition order.
    const manifestSha256 = sha256Hex(
      new TextEncoder().encode([...manifestHashes].sort().join("\n")),
    );

    let outcome!: RunOutcome;
    let committed = true;
    try {
      outcome = await withArchiveTransaction(pgClient, async (tx) => {
        const documents: ImportDocument[] = [];
        for (const pull of pulls) {
          documents.push(...(await adapterPullToImportDocuments(tx, pull)));
        }
        const batch: ImportBatch = {
          source: adapter.institutionSlug,
          documents,
        };
        // Reuses publishImport: import both gates and publication happen
        // exactly as it already defines them, as one atomic step.
        const publishSummary = await publishImport(tx, batch, now);
        const currencySums = await sumByCurrency(
          tx,
          documents.map((document) => document.sha256),
        );
        const cashVerdicts = await fetchCashVerdicts(tx, accountIds);
        const positionVerdicts = await fetchPositionVerdicts(tx, accountIds);
        const rowsParsed = documents.reduce(
          (sum, document) => sum + documentRowCount(document),
          0,
        );
        const result: RunOutcome = {
          discoverStatus: discovered.documents.status,
          discoverDocuments: discovered.documents.items.length,
          discoverExportRanges: discovered.exportRanges.length,
          documentsAcquired: pulls.length,
          bytesAcquired,
          manifestSha256,
          rowsParsed,
          rowsInserted: publishSummary.rowsInserted,
          rowsSkipped: publishSummary.rowsSkipped,
          reviewItemsOpened: publishSummary.reviewItemsOpened,
          currencySums,
          cashVerdicts,
          positionVerdicts,
        };
        if (dryRun) throw new DryRunAbort(result);
        return result;
      });
    } catch (error) {
      if (error instanceof DryRunAbort) {
        outcome = error.result;
        committed = false;
      } else {
        throw error;
      }
    }

    printSummary(outcome, { dryRun, committed });
  } finally {
    await pgClient.end();
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
  console.log(`bytes acquired: ${outcome.bytesAcquired}`);
  console.log(`acquisition manifest sha256: ${outcome.manifestSha256}`);
  console.log(`rows parsed: ${outcome.rowsParsed}`);
  console.log(`rows inserted: ${outcome.rowsInserted}`);
  console.log(`rows deduplicated: ${outcome.rowsSkipped}`);
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
