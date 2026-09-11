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
import { openArchive } from "./schema.js";

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
  readonly accountId: string;
  readonly docType: string;
  readonly docDate: string | null;
  readonly selection: AcquireSelectionInput;
};

type SelectionFile = {
  readonly institutionId: string;
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
  if (typeof raw.institutionId !== "string" || raw.institutionId.length === 0) {
    throw new Error(`${path}: "institutionId" is required`);
  }
  if (!Array.isArray(raw.pulls) || raw.pulls.length === 0) {
    throw new Error(`${path}: "pulls" must be a non-empty array`);
  }
  raw.pulls.forEach((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${path}: pulls[${index}] must be an object`);
    }
    const pull = entry as Record<string, unknown>;
    if (typeof pull.accountId !== "string" || pull.accountId.length === 0) {
      throw new Error(`${path}: pulls[${index}].accountId is required`);
    }
    if (typeof pull.docType !== "string" || pull.docType.length === 0) {
      throw new Error(`${path}: pulls[${index}].docType is required`);
    }
    if (pull.docDate !== null && typeof pull.docDate !== "string") {
      throw new Error(`${path}: pulls[${index}].docDate must be a string or null`);
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
    if (selection.kind === "structured_api" || selection.kind === "tabular_export") {
      if (typeof selection.periodStart !== "string" || typeof selection.periodEnd !== "string") {
        throw new Error(
          `${path}: pulls[${index}].selection needs "periodStart" and "periodEnd" for kind ${selection.kind}`,
        );
      }
    } else if (typeof selection.externalId !== "string") {
      throw new Error(
        `${path}: pulls[${index}].selection needs "externalId" for kind ${selection.kind}`,
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

// --- env ------------------------------------------------------------------

function requiredEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. ${hint}`);
  }
  return value;
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

  const dbPath = requiredEnv(
    "FINANCE_ARCHIVE_DB_PATH",
    "Point it at the local SQLite archive file that records raw-tree provenance " +
      "(persistAcquiredDocument's institution/account lookups); that path is never " +
      "committed and this command never defaults to one.",
  );
  // Hard errors when unset -- FINANCE_ARCHIVE_RAW_TREE_ROOT, FINANCE_ARCHIVE_SPACE_ID.
  const rawTreeRoot = resolveRawTreeRoot();

  const sqliteDb = openArchive(dbPath);
  // Hard error when FINANCE_ARCHIVE_DATABASE_URL is unset.
  const pgClient = createArchiveClient();
  await pgClient.connect();

  try {
    const session = await buildSession();
    const discovered = await adapter.discover(session);

    const pulls: AdapterPull[] = [];
    let bytesAcquired = 0;
    const manifestHashes: string[] = [];

    for (const entry of selectionFile.pulls) {
      const selection = { ...entry.selection, session } as AcquireSelection;
      const acquired = await adapter.acquire(selection);
      const parsed = await adapter.parse({
        kind: entry.selection.kind,
        bytes: acquired.bytes,
      });
      const persisted = persistAcquiredDocument(sqliteDb, rawTreeRoot, {
        institutionId: selectionFile.institutionId,
        accountId: entry.accountId,
        docType: entry.docType,
        acquired,
      });
      bytesAcquired += acquired.bytes.length;
      manifestHashes.push(acquired.manifest.contentHash);
      pulls.push({
        institutionId: selectionFile.institutionId,
        accountId: entry.accountId,
        acquired,
        rows: parsed.activity,
        holdings: parsed.holdings,
        docType: entry.docType,
        docDate: entry.docDate,
        persisted,
      });
    }

    const accountIds = [...new Set(selectionFile.pulls.map((p) => p.accountId))];
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
    sqliteDb.close();
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
