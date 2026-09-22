import { createHash, randomUUID } from "node:crypto";

import {
  assertCandidateHashesOwnedByDocument,
  type CandidateHoldingProjection,
  type CandidateHoldingRow,
  type HoldingBalanceScopeSelector,
  type HoldingPositionScopeSelector,
  type HoldingCorrectionCandidateManifest,
  type HoldingProjectionTable,
  holdingProjectionCurrentDigest,
  prepareHoldingBalanceScopes,
  prepareHoldingPartialPositionScopes,
  prepareHoldingPositionScopes,
  prepareHoldingCorrectionCandidate,
  readStoredHoldingProjection,
  type StoredHoldingProjection,
  type StoredHoldingRow,
} from "./holdingCorrectionCandidate.js";
import type { ImportDocument, ImportPosition } from "./importer.js";
import type { PositionChange } from "./positionReconciliation.js";
import { runPositionReconciliationGate } from "./positionReconciliation.js";
import { toNumericText } from "./pgNumeric.js";
import {
  valuationNotesEquivalent,
  valuationNotesEquivalentSql,
} from "./valuationNote.js";
import type { CashChange } from "./reconciliation.js";
import { runReconciliationGate } from "./reconciliation.js";
import {
  type ArchiveClient,
  insertRows,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "./pgStore.js";

const SHA256 = /^[0-9a-f]{64}$/;
const TABLES = ["positions", "balances", "liabilities"] as const;

type AssertionKind = "position" | "balance" | "liability";

const ASSERTION_KIND: Readonly<Record<HoldingProjectionTable, AssertionKind>> =
  Object.freeze({
    positions: "position",
    balances: "balance",
    liabilities: "liability",
  });

function positionSemanticsEquivalent(
  left: readonly (string | null)[],
  right: readonly (string | null)[],
): boolean {
  return (
    left.length === 11 &&
    right.length === 11 &&
    canonical(left.slice(0, 10)) === canonical(right.slice(0, 10)) &&
    valuationNotesEquivalent(left[10] ?? null, right[10] ?? null)
  );
}

export type HoldingProjectionApproval = {
  readonly schemaVersion: 1;
  readonly kind: "holding_projection_approval_v1";
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly expectedActiveGenerationId: string | null;
  readonly oldProjectionDigest: string;
  readonly candidateProjectionDigest: string;
  readonly candidateDigest: string;
  readonly completenessAttestation: "operator_verified_complete_projection";
  readonly authorizeRemovals: boolean;
  readonly authorizeEmptyProjection: boolean;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalDigest: string;
};

export type HoldingProjectionPublication = {
  readonly documentId: string;
  readonly previousGenerationId: string;
  readonly activeGenerationId: string;
  readonly generationNumber: number;
  readonly retainedIds: number;
  readonly mintedIds: number;
  readonly rows: Readonly<Record<HoldingProjectionTable, number>>;
  readonly candidateDigest: string;
  readonly approvalDigest: string;
  readonly reconciliations: {
    readonly cashPassed: number;
    readonly cashFailed: number;
    readonly cashUnverified: number;
    readonly positionsPassed: number;
    readonly positionsFailed: number;
    readonly positionsUnverified: number;
  };
};

export type HoldingScopedCorrectionSelector =
  | (HoldingPositionScopeSelector & { readonly scopeKind: "positions" })
  | {
      readonly scopeKind: "balance";
      readonly accountId: string;
      readonly asOf: string;
      readonly proofVersion: "balance_scope_v1";
    };

export type HoldingScopedCorrectionManifest = {
  readonly schemaVersion: 1;
  readonly kind: "holding_scoped_correction_candidate_v1";
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly expectedActiveGenerationId: string | null;
  readonly oldProjectionDigest: string;
  readonly candidateProjectionDigest: string;
  readonly selectedCurrentDigest: string;
  readonly selectedScopes: readonly ({
    readonly accountId: string;
    readonly asOf: string;
    readonly emittedRowCount: number;
    readonly scopeDigest: string;
    readonly sourceOwnedRows: number;
    readonly foreignReferencedRows: number;
  } & (
    | {
        readonly scopeKind: "positions";
        readonly proofVersion: "position_scope_v1";
      }
    | {
        readonly scopeKind: "balance";
        readonly proofVersion: "balance_scope_v1";
      }
  ))[];
  readonly rows: Readonly<
    Record<
      HoldingProjectionTable,
      {
        readonly oldSourceOwnedRows: number;
        readonly candidateSourceOwnedRows: number;
        readonly selectedSourceOwnedRemovals: number;
        readonly preservedForeignExtraRows: number;
      }
    >
  >;
  readonly completeness: {
    readonly state: "complete_selected_scopes";
    readonly removalsAuthorized: false;
  };
  readonly candidateDigest: string;
};

export type HoldingScopedProjectionApproval = {
  readonly schemaVersion: 1;
  readonly kind: "holding_scoped_projection_approval_v1";
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly expectedActiveGenerationId: string | null;
  readonly oldProjectionDigest: string;
  readonly candidateProjectionDigest: string;
  readonly selectedCurrentDigest: string;
  readonly selectedScopes: readonly HoldingScopedCorrectionSelector[];
  readonly candidateDigest: string;
  readonly completenessAttestation: "operator_verified_complete_scopes";
  readonly authorizeSelectedRemovals: boolean;
  readonly authorizeEmptySelectedScopes: boolean;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalDigest: string;
};

export function holdingScopedProjectionApprovalDigest(
  approval: Omit<HoldingScopedProjectionApproval, "approvalDigest">,
): string {
  return digest("kith-finance-holding-scoped-approval:v1", approval);
}

export type HoldingAdditivePositionSelection = HoldingPositionScopeSelector & {
  readonly scopeKind: "positions";
};

export type HoldingAdditiveCorrectionManifest = {
  readonly schemaVersion: 1;
  readonly kind: "holding_additive_correction_candidate_v1";
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly expectedActiveGenerationId: string | null;
  readonly oldProjectionDigest: string;
  readonly candidateProjectionDigest: string;
  readonly selectedCurrentDigest: string;
  readonly selectedRowsDigest: string;
  readonly selectedRowCount: number;
  readonly selectedScopes: readonly {
    readonly scopeKind: "positions";
    readonly accountId: string;
    readonly asOf: string;
    readonly proofVersion: "position_scope_v1";
    readonly status: "partial";
    readonly emittedRowCount: number;
    readonly gapCodes: readonly string[];
    readonly scopeDigest: string;
    readonly sourceOwnedAdditions: number;
    readonly carriedSourceOwnedRows: number;
    readonly exactForeignReferences: number;
    readonly unmatchedPartialMembers: number;
  }[];
  readonly rows: {
    readonly oldSourceOwnedRows: number;
    readonly candidateSourceOwnedRows: number;
    readonly sourceOwnedAdditions: number;
    readonly changedRows: 0;
    readonly removedRows: 0;
  };
  readonly completeness: {
    readonly state: "partial_source_additions";
    readonly changesAuthorized: false;
    readonly removalsAuthorized: false;
  };
  readonly candidateDigest: string;
};

export type HoldingAdditiveProjectionApproval = {
  readonly schemaVersion: 1;
  readonly kind: "holding_additive_projection_approval_v1";
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly expectedActiveGenerationId: string | null;
  readonly oldProjectionDigest: string;
  readonly candidateProjectionDigest: string;
  readonly selectedCurrentDigest: string;
  readonly selectedRowsDigest: string;
  readonly selectedScopes: readonly HoldingAdditivePositionSelection[];
  readonly selectedRowHashes: readonly string[];
  readonly candidateDigest: string;
  readonly completenessAttestation: "operator_verified_source_additions_only";
  readonly authorizeSourceOwnedAdditions: true;
  readonly authorizeChanges: false;
  readonly authorizeRemovals: false;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalDigest: string;
};

export function holdingAdditiveProjectionApprovalDigest(
  approval: Omit<HoldingAdditiveProjectionApproval, "approvalDigest">,
): string {
  return digest("kith-finance-holding-additive-approval:v1", approval);
}

type Assertion = {
  readonly kind: AssertionKind;
  readonly recordId: string;
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly rowHash: string | null;
  readonly sourceLocator: string | null;
  readonly semantic: readonly (string | null)[];
  readonly digest: string;
};

type DocumentRow = {
  id: string;
  retained_sha256: string | null;
  active_holding_projection_generation_id: string | null;
  superseded_by: string | null;
};

type CanonicalPosition = {
  readonly id: string;
  readonly sourceDocumentId: string;
  readonly rowHash: string | null;
  readonly sourceLocator: string | null;
  readonly semantic: readonly (string | null)[];
};

export type PreparedScopedCorrection = {
  readonly manifest: HoldingScopedCorrectionManifest;
  readonly selectedPositionScopes: ReturnType<
    typeof prepareHoldingPositionScopes
  >;
  readonly selectedBalanceScopes: ReturnType<
    typeof prepareHoldingBalanceScopes
  >;
  readonly sourceOwnedPositions: readonly CandidateHoldingRow[];
  readonly sourceOwnedBalances: readonly CandidateHoldingRow[];
  readonly foreignReferencedPositionHashes: ReadonlySet<string>;
  readonly foreignReferencedBalanceHashes: ReadonlySet<string>;
};

export type PreparedAdditiveCorrection = {
  readonly manifest: HoldingAdditiveCorrectionManifest;
  readonly selectedPositionScopes: ReturnType<
    typeof prepareHoldingPartialPositionScopes
  >;
  readonly sourceOwnedAdditions: readonly CandidateHoldingRow[];
};

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${canonical(value)}`, "utf8")
    .digest("hex");
}

export function holdingProjectionApprovalDigest(
  approval: Omit<HoldingProjectionApproval, "approvalDigest">,
): string {
  return digest("kith-finance-holding-projection-approval:v1", {
    schemaVersion: approval.schemaVersion,
    kind: approval.kind,
    documentId: approval.documentId,
    retainedSha256: approval.retainedSha256,
    expectedActiveGenerationId: approval.expectedActiveGenerationId,
    oldProjectionDigest: approval.oldProjectionDigest,
    candidateProjectionDigest: approval.candidateProjectionDigest,
    candidateDigest: approval.candidateDigest,
    completenessAttestation: approval.completenessAttestation,
    authorizeRemovals: approval.authorizeRemovals,
    authorizeEmptyProjection: approval.authorizeEmptyProjection,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
  });
}

function refuse(reason: string): never {
  throw new Error(`holding projection publication refused: ${reason}`);
}

function assertionDigest(input: {
  kind: AssertionKind;
  documentId: string;
  retainedSha256: string;
  rowHash: string | null;
  sourceLocator: string | null;
  semantic: readonly (string | null)[];
}): string {
  return digest("kith-finance-holding-assertion:v1", [
    input.kind,
    input.documentId,
    input.retainedSha256,
    input.rowHash,
    input.sourceLocator,
    input.semantic,
  ]);
}

function assertion(
  kind: AssertionKind,
  recordId: string,
  documentId: string,
  retainedSha256: string,
  row: StoredHoldingRow | CandidateHoldingRow,
): Assertion {
  const base = {
    kind,
    recordId,
    documentId,
    retainedSha256,
    rowHash: row.rowHash,
    sourceLocator: row.sourceLocator,
    semantic: row.semantic,
  } as const;
  return { ...base, digest: assertionDigest(base) };
}

function sortedProjection(projection: StoredHoldingProjection): unknown {
  return TABLES.map((table) => [
    table,
    [...projection[table]]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => [row.id, row.rowHash, row.sourceLocator, row.semantic]),
  ]);
}

function scopeKey(
  scope: HoldingPositionScopeSelector | HoldingBalanceScopeSelector,
): string {
  return `${scope.accountId}\u0000${scope.asOf}\u0000${scope.proofVersion}`;
}

function selectedPosition(
  semantic: readonly (string | null)[],
  selected: ReadonlySet<string>,
): boolean {
  return selected.has(
    `${semantic[0]}\u0000${semantic[1]}\u0000position_scope_v1`,
  );
}

function selectedBalance(
  semantic: readonly (string | null)[],
  selected: ReadonlySet<string>,
): boolean {
  return selected.has(
    `${semantic[0]}\u0000${semantic[1]}\u0000balance_scope_v1`,
  );
}

function canonicalScopedCurrentDigest(input: {
  positions: readonly CanonicalPosition[];
  balances: readonly CanonicalPosition[];
  includesBalanceScopes: boolean;
}): string {
  if (!input.includesBalanceScopes) {
    return digest(
      "kith-finance-holding-scoped-position-current:v1",
      [...input.positions]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((row) => [
          row.id,
          row.sourceDocumentId,
          row.rowHash,
          row.sourceLocator,
          row.semantic,
        ]),
    );
  }
  return digest(
    "kith-finance-holding-scoped-current:v1",
    (["positions", "balances"] as const).map((table) => [
      table,
      [...input[table]]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((row) => [
          row.id,
          row.sourceDocumentId,
          row.rowHash,
          row.sourceLocator,
          row.semantic,
        ]),
    ]),
  );
}

function normalizedNumeric(value: string | null): string | null {
  return value === null ? null : toNumericText(value);
}

function scopedCandidateProjectionDigest(input: {
  stored: StoredHoldingProjection;
  selectedPositions: ReadonlySet<string>;
  selectedBalances: ReadonlySet<string>;
  sourceOwnedPositions: readonly CandidateHoldingRow[];
  sourceOwnedBalances: readonly CandidateHoldingRow[];
}): string {
  if (input.selectedBalances.size === 0) {
    return digest("kith-finance-holding-scoped-position-projection:v1", {
      preservedPositions: input.stored.positions
        .filter(
          (row) => !selectedPosition(row.semantic, input.selectedPositions),
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((row) => [row.id, row.rowHash, row.sourceLocator, row.semantic]),
      selectedSourceOwnedPositions: [...input.sourceOwnedPositions]
        .sort((left, right) => left.rowHash.localeCompare(right.rowHash))
        .map((row) => [row.rowHash, row.sourceLocator, row.semantic]),
      balances: [...input.stored.balances]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((row) => [row.id, row.rowHash, row.sourceLocator, row.semantic]),
      liabilities: [...input.stored.liabilities]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((row) => [row.id, row.rowHash, row.sourceLocator, row.semantic]),
    });
  }
  return digest("kith-finance-holding-scoped-projection:v1", {
    preservedPositions: input.stored.positions
      .filter((row) => !selectedPosition(row.semantic, input.selectedPositions))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => [row.id, row.rowHash, row.sourceLocator, row.semantic]),
    selectedSourceOwnedPositions: [...input.sourceOwnedPositions]
      .sort((left, right) => left.rowHash.localeCompare(right.rowHash))
      .map((row) => [row.rowHash, row.sourceLocator, row.semantic]),
    preservedBalances: input.stored.balances
      .filter((row) => !selectedBalance(row.semantic, input.selectedBalances))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => [row.id, row.rowHash, row.sourceLocator, row.semantic]),
    selectedSourceOwnedBalances: [...input.sourceOwnedBalances]
      .sort((left, right) => left.rowHash.localeCompare(right.rowHash))
      .map((row) => [row.rowHash, row.sourceLocator, row.semantic]),
    liabilities: [...input.stored.liabilities]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => [row.id, row.rowHash, row.sourceLocator, row.semantic]),
  });
}

async function readCanonicalSelectedPositions(
  client: ArchiveClient,
  selectors: readonly HoldingPositionScopeSelector[],
): Promise<CanonicalPosition[]> {
  const found = await client.query<{
    id: string;
    source_document_id: string;
    row_hash: string | null;
    source_locator: string | null;
    account_id: string;
    as_of: string;
    instrument_id: string | null;
    quantity: string | null;
    price: string | null;
    market_value: string | null;
    cost_basis: string | null;
    unrealized: string | null;
    currency: string;
    valuation_basis: string | null;
    valuation_note: string | null;
  }>(
    `WITH selected AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS x(account_id text, as_of date)
     )
     SELECT p.id, p.source_document_id, p.row_hash, p.source_locator,
            p.account_id, p.as_of::text AS as_of, p.instrument_id,
            p.quantity::text, p.price::text, p.market_value::text,
            p.cost_basis::text, p.unrealized::text, p.currency::text,
            p.valuation_basis, p.valuation_note
       FROM positions p
       JOIN selected s ON s.account_id = p.account_id AND s.as_of = p.as_of
      ORDER BY p.id
      FOR UPDATE OF p`,
    [
      JSON.stringify(
        selectors.map((scope) => ({
          account_id: scope.accountId,
          as_of: scope.asOf,
        })),
      ),
    ],
  );
  return found.rows.map((row) => ({
    id: row.id,
    sourceDocumentId: row.source_document_id,
    rowHash: row.row_hash,
    sourceLocator: row.source_locator,
    semantic: [
      row.account_id,
      row.as_of,
      row.instrument_id,
      normalizedNumeric(row.quantity),
      normalizedNumeric(row.price),
      normalizedNumeric(row.market_value),
      normalizedNumeric(row.cost_basis),
      normalizedNumeric(row.unrealized),
      row.currency,
      row.valuation_basis,
      row.valuation_note,
    ],
  }));
}

async function readCanonicalPositionsByHash(
  client: ArchiveClient,
  hashes: readonly string[],
): Promise<CanonicalPosition[]> {
  if (hashes.length === 0) return [];
  const found = await client.query<{
    id: string;
    source_document_id: string;
    row_hash: string;
    source_locator: string | null;
    account_id: string;
    as_of: string;
    instrument_id: string | null;
    quantity: string | null;
    price: string | null;
    market_value: string | null;
    cost_basis: string | null;
    unrealized: string | null;
    currency: string;
    valuation_basis: string | null;
    valuation_note: string | null;
  }>(
    `SELECT p.id, p.source_document_id, p.row_hash, p.source_locator,
            p.account_id, p.as_of::text AS as_of, p.instrument_id,
            p.quantity::text, p.price::text, p.market_value::text,
            p.cost_basis::text, p.unrealized::text, p.currency::text,
            p.valuation_basis, p.valuation_note
       FROM positions p WHERE p.row_hash = ANY($1::text[])
      ORDER BY p.id FOR UPDATE OF p`,
    [hashes],
  );
  return found.rows.map((row) => ({
    id: row.id,
    sourceDocumentId: row.source_document_id,
    rowHash: row.row_hash,
    sourceLocator: row.source_locator,
    semantic: [
      row.account_id,
      row.as_of,
      row.instrument_id,
      normalizedNumeric(row.quantity),
      normalizedNumeric(row.price),
      normalizedNumeric(row.market_value),
      normalizedNumeric(row.cost_basis),
      normalizedNumeric(row.unrealized),
      row.currency,
      row.valuation_basis,
      row.valuation_note,
    ],
  }));
}

async function readCanonicalSelectedBalances(
  client: ArchiveClient,
  selectors: readonly HoldingBalanceScopeSelector[],
): Promise<CanonicalPosition[]> {
  if (selectors.length === 0) return [];
  const found = await client.query<{
    id: string;
    source_document_id: string;
    row_hash: string | null;
    source_locator: string | null;
    account_id: string;
    as_of: string;
    total_value: string | null;
    cash: string | null;
    currency: string;
    period_start_value: string | null;
    period_end_value: string | null;
  }>(
    `WITH selected AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS x(account_id text, as_of date)
     )
     SELECT b.id, b.source_document_id, b.row_hash, b.source_locator,
            b.account_id, b.as_of::text AS as_of, b.total_value::text,
            b.cash::text, b.currency::text, b.period_start_value::text,
            b.period_end_value::text
       FROM balances b
       JOIN selected s ON s.account_id = b.account_id AND s.as_of = b.as_of
      ORDER BY b.id
      FOR UPDATE OF b`,
    [
      JSON.stringify(
        selectors.map((scope) => ({
          account_id: scope.accountId,
          as_of: scope.asOf,
        })),
      ),
    ],
  );
  return found.rows.map((row) => ({
    id: row.id,
    sourceDocumentId: row.source_document_id,
    rowHash: row.row_hash,
    sourceLocator: row.source_locator,
    semantic: [
      row.account_id,
      row.as_of,
      normalizedNumeric(row.total_value),
      normalizedNumeric(row.cash),
      row.currency,
      normalizedNumeric(row.period_start_value),
      normalizedNumeric(row.period_end_value),
    ],
  }));
}

async function readCanonicalBalancesByHash(
  client: ArchiveClient,
  hashes: readonly string[],
): Promise<CanonicalPosition[]> {
  if (hashes.length === 0) return [];
  const found = await client.query<{
    id: string;
    source_document_id: string;
    row_hash: string;
    source_locator: string | null;
    account_id: string;
    as_of: string;
    total_value: string | null;
    cash: string | null;
    currency: string;
    period_start_value: string | null;
    period_end_value: string | null;
  }>(
    `SELECT b.id, b.source_document_id, b.row_hash, b.source_locator,
            b.account_id, b.as_of::text AS as_of, b.total_value::text,
            b.cash::text, b.currency::text, b.period_start_value::text,
            b.period_end_value::text
       FROM balances b WHERE b.row_hash = ANY($1::text[])
      ORDER BY b.id FOR UPDATE OF b`,
    [hashes],
  );
  return found.rows.map((row) => ({
    id: row.id,
    sourceDocumentId: row.source_document_id,
    rowHash: row.row_hash,
    sourceLocator: row.source_locator,
    semantic: [
      row.account_id,
      row.as_of,
      normalizedNumeric(row.total_value),
      normalizedNumeric(row.cash),
      row.currency,
      normalizedNumeric(row.period_start_value),
      normalizedNumeric(row.period_end_value),
    ],
  }));
}

export async function prepareHoldingScopedPositionCorrection(input: {
  readonly client: ArchiveClient;
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly expectedActiveGenerationId: string | null;
  readonly stored: StoredHoldingProjection;
  readonly candidate: ImportDocument;
  readonly selectors: readonly HoldingScopedCorrectionSelector[];
}): Promise<PreparedScopedCorrection> {
  if (input.selectors.length === 0) refuse("no holding scopes were selected");
  for (const selector of input.selectors) {
    if (
      selector === null ||
      typeof selector !== "object" ||
      canonical(Object.keys(selector).sort()) !==
        canonical(["accountId", "asOf", "proofVersion", "scopeKind"]) ||
      !(
        (selector.scopeKind === "positions" &&
          selector.proofVersion === "position_scope_v1") ||
        (selector.scopeKind === "balance" &&
          selector.proofVersion === "balance_scope_v1")
      )
    ) {
      refuse("holding scope selector is invalid");
    }
  }
  const positionSelectors = input.selectors
    .filter((scope) => scope.scopeKind === "positions")
    .map(({ accountId, asOf, proofVersion }) => ({
      accountId,
      asOf,
      proofVersion,
    }));
  const balanceSelectors = input.selectors
    .filter((scope) => scope.scopeKind === "balance")
    .map(({ accountId, asOf, proofVersion }) => ({
      accountId,
      asOf,
      proofVersion,
    }));
  const selectedPositionScopes =
    positionSelectors.length === 0
      ? []
      : prepareHoldingPositionScopes({
          documentId: input.documentId,
          retainedSha256: input.retainedSha256,
          candidate: input.candidate,
          selectors: positionSelectors,
        });
  const selectedBalanceScopes =
    balanceSelectors.length === 0
      ? []
      : prepareHoldingBalanceScopes({
          documentId: input.documentId,
          retainedSha256: input.retainedSha256,
          candidate: input.candidate,
          selectors: balanceSelectors,
        });
  if (
    selectedPositionScopes.length + selectedBalanceScopes.length !==
    input.selectors.length
  ) {
    refuse("holding scope selector is invalid");
  }
  const selectedPositions = new Set(positionSelectors.map(scopeKey));
  const selectedBalances = new Set(balanceSelectors.map(scopeKey));
  const canonicalPositions = await readCanonicalSelectedPositions(
    input.client,
    positionSelectors,
  );
  const canonicalBalances = await readCanonicalSelectedBalances(
    input.client,
    balanceSelectors,
  );
  const logicalPositions = selectedPositionScopes.flatMap(
    (scope) => scope.positions,
  );
  const logicalBalances = selectedBalanceScopes.flatMap(
    (scope) => scope.balances,
  );
  const positionHashOwners = await readCanonicalPositionsByHash(
    input.client,
    logicalPositions.map((row) => row.rowHash),
  );
  const balanceHashOwners = await readCanonicalBalancesByHash(
    input.client,
    logicalBalances.map((row) => row.rowHash),
  );
  const positionByHash = new Map(
    positionHashOwners.map((row) => [row.rowHash!, row] as const),
  );
  const balanceByHash = new Map(
    balanceHashOwners.map((row) => [row.rowHash!, row] as const),
  );
  const logicalBalanceByHash = new Map(
    logicalBalances.map((row) => [row.rowHash, row]),
  );
  const foreignReferencedPositionHashes = new Set<string>();
  const foreignReferencedBalanceHashes = new Set<string>();
  const sourceOwnedPositions: CandidateHoldingRow[] = [];
  for (const row of logicalPositions) {
    const current = positionByHash.get(row.rowHash);
    if (
      current === undefined ||
      current.sourceDocumentId === input.documentId
    ) {
      sourceOwnedPositions.push(row);
      continue;
    }
    if (!positionSemanticsEquivalent(current.semantic, row.semantic)) {
      refuse("a foreign-owned selected position has different semantics");
    }
    foreignReferencedPositionHashes.add(row.rowHash);
  }
  const sourceOwnedBalances: CandidateHoldingRow[] = [];
  for (const row of logicalBalances) {
    const current = balanceByHash.get(row.rowHash);
    if (
      current === undefined ||
      current.sourceDocumentId === input.documentId
    ) {
      sourceOwnedBalances.push(row);
      continue;
    }
    if (canonical(current.semantic) !== canonical(row.semantic)) {
      refuse("a foreign-owned selected balance has different semantics");
    }
    foreignReferencedBalanceHashes.add(row.rowHash);
  }
  for (const current of canonicalBalances) {
    if (current.sourceDocumentId === input.documentId) continue;
    const declared =
      current.rowHash === null
        ? undefined
        : logicalBalanceByHash.get(current.rowHash);
    if (
      declared === undefined ||
      canonical(declared.semantic) !== canonical(current.semantic)
    ) {
      refuse("a selected scope does not represent every foreign-owned balance");
    }
  }

  const scopeSummaries = [
    ...selectedPositionScopes.map((scope) => ({
      scopeKind: "positions" as const,
      ...scope.selector,
      emittedRowCount: scope.declaration.emittedPositionCount,
      scopeDigest: scope.scopeDigest,
      sourceOwnedRows: scope.positions.filter(
        (row) => !foreignReferencedPositionHashes.has(row.rowHash),
      ).length,
      foreignReferencedRows: scope.positions.filter((row) =>
        foreignReferencedPositionHashes.has(row.rowHash),
      ).length,
    })),
    ...selectedBalanceScopes.map((scope) => ({
      scopeKind: "balance" as const,
      ...scope.selector,
      emittedRowCount: scope.declaration.emittedBalanceCount,
      scopeDigest: scope.scopeDigest,
      sourceOwnedRows: scope.balances.filter(
        (row) => !foreignReferencedBalanceHashes.has(row.rowHash),
      ).length,
      foreignReferencedRows: scope.balances.filter((row) =>
        foreignReferencedBalanceHashes.has(row.rowHash),
      ).length,
    })),
  ].sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const oldSelectedPositions = input.stored.positions.filter((row) =>
    selectedPosition(row.semantic, selectedPositions),
  );
  const oldSelectedBalances = input.stored.balances.filter((row) =>
    selectedBalance(row.semantic, selectedBalances),
  );
  const positionCandidateContent = new Set(
    sourceOwnedPositions.map((row) =>
      canonical([row.rowHash, row.sourceLocator, row.semantic]),
    ),
  );
  const balanceCandidateContent = new Set(
    sourceOwnedBalances.map((row) =>
      canonical([row.rowHash, row.sourceLocator, row.semantic]),
    ),
  );
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: "holding_scoped_correction_candidate_v1" as const,
    documentId: input.documentId,
    retainedSha256: input.retainedSha256,
    expectedActiveGenerationId: input.expectedActiveGenerationId,
    oldProjectionDigest: holdingProjectionCurrentDigest(input.stored),
    candidateProjectionDigest: scopedCandidateProjectionDigest({
      stored: input.stored,
      selectedPositions,
      selectedBalances,
      sourceOwnedPositions,
      sourceOwnedBalances,
    }),
    selectedCurrentDigest: canonicalScopedCurrentDigest({
      positions: canonicalPositions,
      balances: canonicalBalances,
      includesBalanceScopes: balanceSelectors.length > 0,
    }),
    selectedScopes: scopeSummaries,
    rows: {
      positions: {
        oldSourceOwnedRows: input.stored.positions.length,
        candidateSourceOwnedRows:
          input.stored.positions.filter(
            (row) => !selectedPosition(row.semantic, selectedPositions),
          ).length + sourceOwnedPositions.length,
        selectedSourceOwnedRemovals: oldSelectedPositions.filter(
          (row) =>
            !positionCandidateContent.has(
              canonical([row.rowHash, row.sourceLocator, row.semantic]),
            ),
        ).length,
        preservedForeignExtraRows: canonicalPositions.filter(
          (row) =>
            row.sourceDocumentId !== input.documentId &&
            (row.rowHash === null ||
              !foreignReferencedPositionHashes.has(row.rowHash)),
        ).length,
      },
      balances: {
        oldSourceOwnedRows: input.stored.balances.length,
        candidateSourceOwnedRows:
          input.stored.balances.filter(
            (row) => !selectedBalance(row.semantic, selectedBalances),
          ).length + sourceOwnedBalances.length,
        selectedSourceOwnedRemovals: oldSelectedBalances.filter(
          (row) =>
            !balanceCandidateContent.has(
              canonical([row.rowHash, row.sourceLocator, row.semantic]),
            ),
        ).length,
        preservedForeignExtraRows: canonicalBalances.filter(
          (row) =>
            row.sourceDocumentId !== input.documentId &&
            (row.rowHash === null ||
              !foreignReferencedBalanceHashes.has(row.rowHash)),
        ).length,
      },
      liabilities: {
        oldSourceOwnedRows: input.stored.liabilities.length,
        candidateSourceOwnedRows: input.stored.liabilities.length,
        selectedSourceOwnedRemovals: 0,
        preservedForeignExtraRows: 0,
      },
    },
    completeness: {
      state: "complete_selected_scopes" as const,
      removalsAuthorized: false as const,
    },
  };
  const manifest = {
    ...withoutDigest,
    candidateDigest: digest(
      "kith-finance-holding-scoped-manifest:v1",
      withoutDigest,
    ),
  };
  return {
    manifest,
    selectedPositionScopes,
    selectedBalanceScopes,
    sourceOwnedPositions,
    sourceOwnedBalances,
    foreignReferencedPositionHashes,
    foreignReferencedBalanceHashes,
  };
}

function additiveCandidateProjectionDigest(input: {
  readonly stored: StoredHoldingProjection;
  readonly additions: readonly CandidateHoldingRow[];
}): string {
  return digest("kith-finance-holding-additive-position-projection:v1", {
    carried: TABLES.map((table) => [
      table,
      [...input.stored[table]]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((row) => [row.id, row.rowHash, row.sourceLocator, row.semantic]),
    ]),
    additions: [...input.additions]
      .sort((left, right) => left.rowHash.localeCompare(right.rowHash))
      .map((row) => [row.rowHash, row.sourceLocator, row.semantic]),
  });
}

function selectedRawPosition(
  candidate: ImportDocument,
  scope: HoldingPositionScopeSelector,
  prepared: CandidateHoldingRow,
): ImportPosition {
  const matches = (candidate.positions ?? []).filter(
    (row) =>
      (row.accountId ?? candidate.accountId) === scope.accountId &&
      row.asOf === scope.asOf &&
      row.sourceLocator === prepared.sourceLocator,
  );
  if (matches.length !== 1) {
    refuse("a selected addition does not have one exact source row");
  }
  const row = matches[0]!;
  const semantic = prepared.semantic;
  const nullableNumericPairs = [
    [row.quantity, semantic[3]],
    [row.price, semantic[4]],
    [row.costBasis, semantic[6]],
    [row.unrealized, semantic[7]],
  ] as const;
  if (
    nullableNumericPairs.some(
      ([raw, normalized]) => raw !== null && normalized === null,
    ) ||
    (row.marketValueText !== null && semantic[5] === null) ||
    (row.valuationBasis !== null && semantic[9] === null)
  ) {
    refuse("a selected addition contains an unreadable typed value");
  }
  if (
    semantic[5] === null &&
    (row.marketValueText !== null ||
      row.marketValueNote === null ||
      row.marketValueNote.length === 0 ||
      typeof row.valuationNote !== "string" ||
      row.valuationNote.length === 0)
  ) {
    refuse(
      "a selected addition with no market value lacks source-stated evidence",
    );
  }
  return row;
}

/**
 * Prepares an additions-only generation from explicit rows inside truthful
 * partial source scopes. Parser drift outside the selected rows remains
 * visible in those partial memberships but cannot replace an active assertion.
 */
export async function prepareHoldingAdditivePositionCorrection(input: {
  readonly client: ArchiveClient;
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly expectedActiveGenerationId: string | null;
  readonly stored: StoredHoldingProjection;
  readonly candidate: ImportDocument;
  readonly selectors: readonly HoldingAdditivePositionSelection[];
  readonly selectedRowHashes: readonly string[];
}): Promise<PreparedAdditiveCorrection> {
  if (input.selectors.length === 0) refuse("no partial position scopes were selected");
  const selectors = input.selectors.map((selector) => {
    if (
      selector === null ||
      typeof selector !== "object" ||
      canonical(Object.keys(selector).sort()) !==
        canonical(["accountId", "asOf", "proofVersion", "scopeKind"]) ||
      selector.scopeKind !== "positions"
    ) {
      refuse("additive position scope selector is invalid");
    }
    const { accountId, asOf, proofVersion } = selector;
    return { accountId, asOf, proofVersion };
  });
  if (input.selectedRowHashes.length === 0) {
    refuse("no source-owned additions were selected");
  }
  const selectedHashes = new Set<string>();
  for (const rowHash of input.selectedRowHashes) {
    if (!SHA256.test(rowHash)) refuse("selected position row hash is invalid");
    if (selectedHashes.has(rowHash)) {
      refuse("selected position row hash is duplicated");
    }
    selectedHashes.add(rowHash);
  }

  const selectedPositionScopes = prepareHoldingPartialPositionScopes({
    documentId: input.documentId,
    retainedSha256: input.retainedSha256,
    candidate: input.candidate,
    selectors,
  });
  const members = selectedPositionScopes.flatMap((scope) =>
    scope.positions.map((row) => ({ scope, row })),
  );
  const selectedMembers = members.filter(({ row }) =>
    selectedHashes.has(row.rowHash),
  );
  if (selectedMembers.length !== selectedHashes.size) {
    refuse("a selected addition is absent from the selected partial scopes");
  }
  for (const { scope, row } of selectedMembers) {
    selectedRawPosition(input.candidate, scope.selector, row);
  }

  const canonicalPositions = await readCanonicalSelectedPositions(
    input.client,
    selectors,
  );
  const canonicalByHash = new Map(
    canonicalPositions
      .filter((row) => row.rowHash !== null)
      .map((row) => [row.rowHash!, row] as const),
  );
  const oldLocatorRows = new Map(
    input.stored.positions
      .filter(
        (row): row is StoredHoldingRow & { sourceLocator: string } =>
          row.sourceLocator !== null && row.sourceLocator.length > 0,
      )
      .map((row) => [row.sourceLocator, row] as const),
  );
  const sourceOwnedAdditions: CandidateHoldingRow[] = [];
  for (const { row } of selectedMembers) {
    if (canonicalByHash.has(row.rowHash)) {
      refuse("a selected addition already exists in the canonical projection");
    }
    const sameEvidence = oldLocatorRows.get(row.sourceLocator);
    if (sameEvidence !== undefined) {
      refuse(
        "a selected addition conflicts with an existing source-owned evidence boundary",
      );
    }
    sourceOwnedAdditions.push(row);
  }
  if (sourceOwnedAdditions.length === 0) {
    refuse("the additive candidate contains no new source-owned positions");
  }

  const sourceOwnedAdditionHashes = new Set(
    sourceOwnedAdditions.map((row) => row.rowHash),
  );
  const scopeSummaries = selectedPositionScopes.map((scope) => {
    let carriedSourceOwnedRows = 0;
    let exactForeignReferences = 0;
    let unmatchedPartialMembers = 0;
    let sourceOwnedScopeAdditions = 0;
    for (const row of scope.positions) {
      if (sourceOwnedAdditionHashes.has(row.rowHash)) {
        sourceOwnedScopeAdditions += 1;
        continue;
      }
      const current = canonicalByHash.get(row.rowHash);
      if (
        current === undefined ||
        !positionSemanticsEquivalent(current.semantic, row.semantic)
      ) {
        unmatchedPartialMembers += 1;
      } else if (current.sourceDocumentId === input.documentId) {
        carriedSourceOwnedRows += 1;
      } else {
        exactForeignReferences += 1;
      }
    }
    return {
      scopeKind: "positions" as const,
      ...scope.selector,
      status: "partial" as const,
      emittedRowCount: scope.declaration.emittedPositionCount,
      gapCodes: [...scope.declaration.gapCodes].sort(),
      scopeDigest: scope.scopeDigest,
      sourceOwnedAdditions: sourceOwnedScopeAdditions,
      carriedSourceOwnedRows,
      exactForeignReferences,
      unmatchedPartialMembers,
    };
  });
  const selectedRowsDigest = digest(
    "kith-finance-holding-additive-selected-rows:v1",
    [...sourceOwnedAdditions]
      .sort((left, right) => left.rowHash.localeCompare(right.rowHash))
      .map((row) => [row.rowHash, row.sourceLocator, row.semantic]),
  );
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: "holding_additive_correction_candidate_v1" as const,
    documentId: input.documentId,
    retainedSha256: input.retainedSha256,
    expectedActiveGenerationId: input.expectedActiveGenerationId,
    oldProjectionDigest: holdingProjectionCurrentDigest(input.stored),
    candidateProjectionDigest: additiveCandidateProjectionDigest({
      stored: input.stored,
      additions: sourceOwnedAdditions,
    }),
    selectedCurrentDigest: canonicalScopedCurrentDigest({
      positions: canonicalPositions,
      balances: [],
      includesBalanceScopes: false,
    }),
    selectedRowsDigest,
    selectedRowCount: sourceOwnedAdditions.length,
    selectedScopes: scopeSummaries,
    rows: {
      oldSourceOwnedRows: input.stored.positions.length,
      candidateSourceOwnedRows:
        input.stored.positions.length + sourceOwnedAdditions.length,
      sourceOwnedAdditions: sourceOwnedAdditions.length,
      changedRows: 0 as const,
      removedRows: 0 as const,
    },
    completeness: {
      state: "partial_source_additions" as const,
      changesAuthorized: false as const,
      removalsAuthorized: false as const,
    },
  };
  const manifest = {
    ...withoutDigest,
    candidateDigest: digest(
      "kith-finance-holding-additive-manifest:v1",
      withoutDigest,
    ),
  };
  return { manifest, selectedPositionScopes, sourceOwnedAdditions };
}

function assertionValues(item: Assertion): readonly unknown[] {
  const value = (index: number): string | null => item.semantic[index] ?? null;
  const required = (index: number): string => {
    const found = value(index);
    if (found === null)
      refuse("a prepared assertion is missing a required field");
    return found;
  };
  const empty = {
    accountId: null as string | null,
    institutionId: null as string | null,
    instrumentId: null as string | null,
    asOf: "",
    currency: "",
    quantity: null as string | null,
    price: null as string | null,
    marketValue: null as string | null,
    costBasis: null as string | null,
    unrealized: null as string | null,
    valuationBasis: null as string | null,
    valuationNote: null as string | null,
    totalValue: null as string | null,
    cash: null as string | null,
    periodStartValue: null as string | null,
    periodEndValue: null as string | null,
    liabilityKind: null as string | null,
    displayName: null as string | null,
    liabilityBalance: null as string | null,
    rate: null as string | null,
    collateralNote: null as string | null,
  };
  if (item.kind === "position") {
    empty.accountId = required(0);
    empty.asOf = required(1);
    empty.instrumentId = value(2);
    empty.quantity = value(3);
    empty.price = value(4);
    empty.marketValue = value(5);
    empty.costBasis = value(6);
    empty.unrealized = value(7);
    empty.currency = required(8);
    empty.valuationBasis = value(9);
    empty.valuationNote = value(10);
  } else if (item.kind === "balance") {
    empty.accountId = required(0);
    empty.asOf = required(1);
    empty.totalValue = value(2);
    empty.cash = value(3);
    empty.currency = required(4);
    empty.periodStartValue = value(5);
    empty.periodEndValue = value(6);
  } else {
    empty.institutionId = value(0);
    empty.accountId = value(1);
    empty.liabilityKind = required(2);
    empty.displayName = value(3);
    empty.liabilityBalance = value(4);
    empty.currency = required(5);
    empty.rate = value(6);
    empty.asOf = required(7);
    empty.collateralNote = value(8);
  }
  return [
    item.kind,
    item.recordId,
    item.documentId,
    item.retainedSha256,
    item.rowHash,
    item.sourceLocator,
    item.digest,
    empty.accountId,
    empty.institutionId,
    empty.instrumentId,
    empty.asOf,
    empty.currency,
    empty.quantity,
    empty.price,
    empty.marketValue,
    empty.costBasis,
    empty.unrealized,
    empty.valuationBasis,
    empty.valuationNote,
    empty.totalValue,
    empty.cash,
    empty.periodStartValue,
    empty.periodEndValue,
    empty.liabilityKind,
    empty.displayName,
    empty.liabilityBalance,
    empty.rate,
    empty.collateralNote,
  ];
}

const ASSERTION_COLUMNS = [
  "assertion_kind",
  "record_id",
  "source_document_id",
  "retained_sha256",
  "row_hash",
  "source_locator",
  "assertion_digest",
  "account_id",
  "institution_id",
  "instrument_id",
  "as_of",
  "currency",
  "quantity",
  "price",
  "market_value",
  "cost_basis",
  "unrealized",
  "valuation_basis",
  "valuation_note",
  "total_value",
  "cash",
  "period_start_value",
  "period_end_value",
  "liability_kind",
  "display_name",
  "liability_balance",
  "rate",
  "collateral_note",
] as const;

async function insertAssertions(
  client: ArchiveClient,
  assertions: readonly Assertion[],
): Promise<void> {
  if (assertions.length === 0) return;
  const found = await client.query<{
    assertion_kind: AssertionKind;
    record_id: string;
    source_document_id: string;
    retained_sha256: string;
    assertion_digest: string;
  }>(
    `SELECT assertion_kind, record_id, source_document_id,
            retained_sha256, assertion_digest
       FROM holding_projection_assertions
      WHERE record_id = ANY($1::text[])`,
    [assertions.map((item) => item.recordId)],
  );
  const existing = new Map(
    found.rows.map((row) => [`${row.assertion_kind}\0${row.record_id}`, row]),
  );
  const missing: Assertion[] = [];
  for (const item of assertions) {
    const row = existing.get(`${item.kind}\0${item.recordId}`);
    if (row === undefined) {
      missing.push(item);
      continue;
    }
    if (
      row.source_document_id !== item.documentId ||
      row.retained_sha256 !== item.retainedSha256 ||
      row.assertion_digest !== item.digest
    ) {
      refuse("an existing historical record id has different content");
    }
  }
  await insertRows(
    client,
    "holding_projection_assertions",
    ASSERTION_COLUMNS,
    missing.map(assertionValues),
  );
}

async function insertMemberships(
  client: ArchiveClient,
  generationId: string,
  assertions: readonly Assertion[],
): Promise<void> {
  await insertRows(
    client,
    "holding_projection_generation_memberships",
    ["document_id", "generation_id", "assertion_kind", "record_id"],
    assertions.map((item) => [
      item.documentId,
      generationId,
      item.kind,
      item.recordId,
    ]),
  );
}

type HistoricalRow = {
  assertion_kind: AssertionKind;
  record_id: string;
  source_document_id: string;
  retained_sha256: string;
  row_hash: string | null;
  source_locator: string | null;
  assertion_digest: string;
  account_id: string | null;
  institution_id: string | null;
  instrument_id: string | null;
  as_of: string;
  currency: string;
  quantity: string | null;
  price: string | null;
  market_value: string | null;
  cost_basis: string | null;
  unrealized: string | null;
  valuation_basis: string | null;
  valuation_note: string | null;
  total_value: string | null;
  cash: string | null;
  period_start_value: string | null;
  period_end_value: string | null;
  liability_kind: string | null;
  display_name: string | null;
  liability_balance: string | null;
  rate: string | null;
  collateral_note: string | null;
};

function historicalSemantic(row: HistoricalRow): readonly (string | null)[] {
  if (row.assertion_kind === "position") {
    return [
      row.account_id,
      row.as_of,
      row.instrument_id,
      row.quantity,
      row.price,
      row.market_value,
      row.cost_basis,
      row.unrealized,
      row.currency,
      row.valuation_basis,
      row.valuation_note,
    ];
  }
  if (row.assertion_kind === "balance") {
    return [
      row.account_id,
      row.as_of,
      row.total_value,
      row.cash,
      row.currency,
      row.period_start_value,
      row.period_end_value,
    ];
  }
  return [
    row.institution_id,
    row.account_id,
    row.liability_kind,
    row.display_name,
    row.liability_balance,
    row.currency,
    row.rate,
    row.as_of,
    row.collateral_note,
  ];
}

async function readGenerationProjection(
  client: ArchiveClient,
  documentId: string,
  generationId: string,
): Promise<StoredHoldingProjection> {
  const found = await client.query<HistoricalRow>(
    `SELECT a.*, a.as_of::text AS as_of,
            a.quantity::text, a.price::text, a.market_value::text,
            a.cost_basis::text, a.unrealized::text, a.total_value::text,
            a.cash::text, a.period_start_value::text, a.period_end_value::text,
            a.liability_balance::text, a.rate::text
       FROM holding_projection_generation_memberships m
       JOIN holding_projection_assertions a
         ON a.source_document_id = m.document_id
        AND a.assertion_kind = m.assertion_kind
        AND a.record_id = m.record_id
      WHERE m.document_id = $1 AND m.generation_id = $2
      ORDER BY a.assertion_kind, a.record_id`,
    [documentId, generationId],
  );
  const result: Record<HoldingProjectionTable, StoredHoldingRow[]> = {
    positions: [],
    balances: [],
    liabilities: [],
  };
  for (const row of found.rows) {
    const semantic = historicalSemantic(row);
    const expected = assertionDigest({
      kind: row.assertion_kind,
      documentId: row.source_document_id,
      retainedSha256: row.retained_sha256,
      rowHash: row.row_hash,
      sourceLocator: row.source_locator,
      semantic,
    });
    if (expected !== row.assertion_digest) {
      refuse("historical assertion integrity check failed");
    }
    const table =
      row.assertion_kind === "position"
        ? "positions"
        : row.assertion_kind === "balance"
          ? "balances"
          : "liabilities";
    result[table].push({
      id: row.record_id,
      rowHash: row.row_hash,
      sourceLocator: row.source_locator,
      semantic,
    });
  }
  return result;
}

function assertionsForStored(
  projection: StoredHoldingProjection,
  documentId: string,
  retainedSha256: string,
): Assertion[] {
  return TABLES.flatMap((table) =>
    projection[table].map((row) =>
      assertion(ASSERTION_KIND[table], row.id, documentId, retainedSha256, row),
    ),
  );
}

function assertionsForCandidate(
  candidate: CandidateHoldingProjection,
  old: readonly Assertion[],
  documentId: string,
  retainedSha256: string,
): { assertions: Assertion[]; retainedIds: number; mintedIds: number } {
  const oldByContent = new Map<string, Assertion[]>();
  for (const item of old) {
    const bucket = oldByContent.get(item.digest) ?? [];
    bucket.push(item);
    oldByContent.set(item.digest, bucket);
  }
  const assertions: Assertion[] = [];
  let retainedIds = 0;
  let mintedIds = 0;
  for (const table of TABLES) {
    const kind = ASSERTION_KIND[table];
    for (const row of candidate[table]) {
      const content = assertion(kind, "", documentId, retainedSha256, row);
      const retained = oldByContent.get(content.digest)?.shift();
      const recordId = retained?.recordId ?? randomUUID();
      if (retained === undefined) mintedIds += 1;
      else retainedIds += 1;
      assertions.push({ ...content, recordId });
    }
  }
  return { assertions, retainedIds, mintedIds };
}

function storedProjectionFromAssertions(
  assertions: readonly Assertion[],
): StoredHoldingProjection {
  const projection: Record<HoldingProjectionTable, StoredHoldingRow[]> = {
    positions: [],
    balances: [],
    liabilities: [],
  };
  for (const item of assertions) {
    const table =
      item.kind === "position"
        ? "positions"
        : item.kind === "balance"
          ? "balances"
          : "liabilities";
    projection[table].push({
      id: item.recordId,
      rowHash: item.rowHash,
      sourceLocator: item.sourceLocator,
      semantic: item.semantic,
    });
  }
  return projection;
}

function approvalWithoutDigest(
  approval: HoldingProjectionApproval,
): Omit<HoldingProjectionApproval, "approvalDigest"> {
  const { approvalDigest: _approvalDigest, ...rest } = approval;
  return rest;
}

function validateApproval(
  approval: HoldingProjectionApproval,
  manifest: HoldingCorrectionCandidateManifest,
  activeGenerationId: string | null,
): void {
  const expectedKeys = [
    "approvalDigest",
    "approvedAt",
    "approvedBy",
    "authorizeEmptyProjection",
    "authorizeRemovals",
    "candidateDigest",
    "candidateProjectionDigest",
    "completenessAttestation",
    "documentId",
    "expectedActiveGenerationId",
    "kind",
    "oldProjectionDigest",
    "retainedSha256",
    "schemaVersion",
  ];
  if (
    approval === null ||
    typeof approval !== "object" ||
    canonical(Object.keys(approval).sort()) !== canonical(expectedKeys) ||
    typeof approval.documentId !== "string" ||
    typeof approval.retainedSha256 !== "string" ||
    (approval.expectedActiveGenerationId !== null &&
      typeof approval.expectedActiveGenerationId !== "string") ||
    typeof approval.oldProjectionDigest !== "string" ||
    typeof approval.candidateProjectionDigest !== "string" ||
    typeof approval.candidateDigest !== "string" ||
    typeof approval.authorizeRemovals !== "boolean" ||
    typeof approval.authorizeEmptyProjection !== "boolean" ||
    typeof approval.approvedBy !== "string" ||
    typeof approval.approvedAt !== "string" ||
    typeof approval.approvalDigest !== "string"
  ) {
    refuse("approval contract is invalid");
  }
  if (
    approval.schemaVersion !== 1 ||
    approval.kind !== "holding_projection_approval_v1" ||
    approval.completenessAttestation !== "operator_verified_complete_projection"
  ) {
    refuse("approval contract is invalid");
  }
  if (
    approval.documentId !== manifest.documentId ||
    approval.retainedSha256 !== manifest.retainedSha256 ||
    approval.expectedActiveGenerationId !== activeGenerationId ||
    approval.oldProjectionDigest !== manifest.oldProjectionDigest ||
    approval.candidateProjectionDigest !== manifest.candidateProjectionDigest ||
    approval.candidateDigest !== manifest.candidateDigest
  ) {
    refuse(
      "approval does not bind the selected candidate and current projection",
    );
  }
  if (
    approval.approvedBy.length === 0 ||
    approval.approvedBy.length > 200 ||
    !Number.isFinite(Date.parse(approval.approvedAt)) ||
    new Date(approval.approvedAt).toISOString() !== approval.approvedAt
  ) {
    refuse("approval attribution is invalid");
  }
  if (
    !SHA256.test(approval.approvalDigest) ||
    holdingProjectionApprovalDigest(approvalWithoutDigest(approval)) !==
      approval.approvalDigest
  ) {
    refuse("approval digest is invalid");
  }
  const removals = TABLES.reduce(
    (count, table) => count + manifest.tables[table].removed,
    0,
  );
  const candidateRows = TABLES.reduce(
    (count, table) => count + manifest.tables[table].candidateRows,
    0,
  );
  if (approval.authorizeRemovals !== removals > 0) {
    refuse("approval removal authority does not match the candidate");
  }
  if (approval.authorizeEmptyProjection !== (candidateRows === 0)) {
    refuse("approval empty-projection authority does not match the candidate");
  }
}

function validateScopedApproval(
  approval: HoldingScopedProjectionApproval,
  manifest: HoldingScopedCorrectionManifest,
): void {
  const expectedKeys = [
    "approvalDigest",
    "approvedAt",
    "approvedBy",
    "authorizeEmptySelectedScopes",
    "authorizeSelectedRemovals",
    "candidateDigest",
    "candidateProjectionDigest",
    "completenessAttestation",
    "documentId",
    "expectedActiveGenerationId",
    "kind",
    "oldProjectionDigest",
    "retainedSha256",
    "schemaVersion",
    "selectedCurrentDigest",
    "selectedScopes",
  ];
  if (
    approval === null ||
    typeof approval !== "object" ||
    canonical(Object.keys(approval).sort()) !== canonical(expectedKeys) ||
    approval.schemaVersion !== 1 ||
    approval.kind !== "holding_scoped_projection_approval_v1" ||
    approval.completenessAttestation !== "operator_verified_complete_scopes" ||
    typeof approval.documentId !== "string" ||
    typeof approval.retainedSha256 !== "string" ||
    (approval.expectedActiveGenerationId !== null &&
      typeof approval.expectedActiveGenerationId !== "string") ||
    typeof approval.oldProjectionDigest !== "string" ||
    typeof approval.candidateProjectionDigest !== "string" ||
    typeof approval.selectedCurrentDigest !== "string" ||
    !Array.isArray(approval.selectedScopes) ||
    typeof approval.candidateDigest !== "string" ||
    typeof approval.authorizeSelectedRemovals !== "boolean" ||
    typeof approval.authorizeEmptySelectedScopes !== "boolean" ||
    typeof approval.approvedBy !== "string" ||
    typeof approval.approvedAt !== "string" ||
    typeof approval.approvalDigest !== "string"
  ) {
    refuse("scoped approval contract is invalid");
  }
  const manifestSelectors = manifest.selectedScopes.map(
    ({ scopeKind, accountId, asOf, proofVersion }) => ({
      scopeKind,
      accountId,
      asOf,
      proofVersion,
    }),
  );
  if (
    approval.documentId !== manifest.documentId ||
    approval.retainedSha256 !== manifest.retainedSha256 ||
    approval.expectedActiveGenerationId !==
      manifest.expectedActiveGenerationId ||
    approval.oldProjectionDigest !== manifest.oldProjectionDigest ||
    approval.candidateProjectionDigest !== manifest.candidateProjectionDigest ||
    approval.selectedCurrentDigest !== manifest.selectedCurrentDigest ||
    canonical(approval.selectedScopes) !== canonical(manifestSelectors) ||
    approval.candidateDigest !== manifest.candidateDigest
  ) {
    refuse("scoped approval does not bind the selected candidate and state");
  }
  if (
    approval.approvedBy.length === 0 ||
    approval.approvedBy.length > 200 ||
    !Number.isFinite(Date.parse(approval.approvedAt)) ||
    new Date(approval.approvedAt).toISOString() !== approval.approvedAt ||
    !SHA256.test(approval.approvalDigest) ||
    holdingScopedProjectionApprovalDigest(
      (({ approvalDigest: _approvalDigest, ...rest }) => rest)(approval),
    ) !== approval.approvalDigest
  ) {
    refuse("scoped approval attribution or digest is invalid");
  }
  const hasRemovals = TABLES.some(
    (table) => manifest.rows[table].selectedSourceOwnedRemovals > 0,
  );
  // This is deliberately a conservative authorization signal. The manifest
  // also binds exact scope membership and the full composed projection.
  if (approval.authorizeSelectedRemovals !== hasRemovals) {
    refuse("scoped approval removal authority does not match the candidate");
  }
  const hasEmpty = manifest.selectedScopes.some(
    (scope) => scope.emittedRowCount === 0,
  );
  if (approval.authorizeEmptySelectedScopes !== hasEmpty) {
    refuse(
      "scoped approval empty-scope authority does not match the candidate",
    );
  }
}

function validateAdditiveApproval(
  approval: HoldingAdditiveProjectionApproval,
  manifest: HoldingAdditiveCorrectionManifest,
): void {
  const expectedKeys = [
    "approvalDigest",
    "approvedAt",
    "approvedBy",
    "authorizeChanges",
    "authorizeRemovals",
    "authorizeSourceOwnedAdditions",
    "candidateDigest",
    "candidateProjectionDigest",
    "completenessAttestation",
    "documentId",
    "expectedActiveGenerationId",
    "kind",
    "oldProjectionDigest",
    "retainedSha256",
    "schemaVersion",
    "selectedCurrentDigest",
    "selectedRowHashes",
    "selectedRowsDigest",
    "selectedScopes",
  ];
  if (
    approval === null ||
    typeof approval !== "object" ||
    canonical(Object.keys(approval).sort()) !== canonical(expectedKeys) ||
    approval.schemaVersion !== 1 ||
    approval.kind !== "holding_additive_projection_approval_v1" ||
    approval.completenessAttestation !==
      "operator_verified_source_additions_only" ||
    approval.authorizeSourceOwnedAdditions !== true ||
    approval.authorizeChanges !== false ||
    approval.authorizeRemovals !== false ||
    typeof approval.documentId !== "string" ||
    typeof approval.retainedSha256 !== "string" ||
    (approval.expectedActiveGenerationId !== null &&
      typeof approval.expectedActiveGenerationId !== "string") ||
    typeof approval.oldProjectionDigest !== "string" ||
    typeof approval.candidateProjectionDigest !== "string" ||
    typeof approval.selectedCurrentDigest !== "string" ||
    typeof approval.selectedRowsDigest !== "string" ||
    !Array.isArray(approval.selectedScopes) ||
    !Array.isArray(approval.selectedRowHashes) ||
    typeof approval.candidateDigest !== "string" ||
    typeof approval.approvedBy !== "string" ||
    typeof approval.approvedAt !== "string" ||
    typeof approval.approvalDigest !== "string"
  ) {
    refuse("additive approval contract is invalid");
  }
  const manifestSelectors = manifest.selectedScopes.map(
    ({ scopeKind, accountId, asOf, proofVersion }) => ({
      scopeKind,
      accountId,
      asOf,
      proofVersion,
    }),
  );
  if (
    approval.documentId !== manifest.documentId ||
    approval.retainedSha256 !== manifest.retainedSha256 ||
    approval.expectedActiveGenerationId !==
      manifest.expectedActiveGenerationId ||
    approval.oldProjectionDigest !== manifest.oldProjectionDigest ||
    approval.candidateProjectionDigest !== manifest.candidateProjectionDigest ||
    approval.selectedCurrentDigest !== manifest.selectedCurrentDigest ||
    approval.selectedRowsDigest !== manifest.selectedRowsDigest ||
    canonical(approval.selectedScopes) !== canonical(manifestSelectors) ||
    canonical([...approval.selectedRowHashes].sort()) !==
      canonical(
        [...approval.selectedRowHashes]
          .filter((rowHash) => SHA256.test(rowHash))
          .sort(),
      ) ||
    new Set(approval.selectedRowHashes).size !== manifest.selectedRowCount ||
    approval.candidateDigest !== manifest.candidateDigest
  ) {
    refuse("additive approval does not bind the selected candidate and state");
  }
  if (
    approval.approvedBy.length === 0 ||
    approval.approvedBy.length > 200 ||
    !Number.isFinite(Date.parse(approval.approvedAt)) ||
    new Date(approval.approvedAt).toISOString() !== approval.approvedAt ||
    !SHA256.test(approval.approvalDigest) ||
    holdingAdditiveProjectionApprovalDigest(
      (({ approvalDigest: _approvalDigest, ...rest }) => rest)(approval),
    ) !== approval.approvalDigest
  ) {
    refuse("additive approval attribution or digest is invalid");
  }
}

async function insertGeneration(
  client: ArchiveClient,
  input: {
    id: string;
    documentId: string;
    generationNumber: number;
    kind: "baseline" | "published";
    retainedSha256: string;
    projectionDigest: string;
    candidateProjectionDigest: string | null;
    candidateDigest: string | null;
    candidateManifest:
      | HoldingCorrectionCandidateManifest
      | HoldingScopedCorrectionManifest
      | HoldingAdditiveCorrectionManifest
      | null;
    oldProjectionDigest: string | null;
    approval:
      | HoldingProjectionApproval
      | HoldingScopedProjectionApproval
      | HoldingAdditiveProjectionApproval
      | null;
    previousGenerationId: string | null;
    now: string;
  },
): Promise<void> {
  const scopedApproval =
    input.approval?.kind === "holding_scoped_projection_approval_v1"
      ? input.approval
      : null;
  const fullApproval =
    input.approval?.kind === "holding_projection_approval_v1"
      ? input.approval
      : null;
  const additiveApproval =
    input.approval?.kind === "holding_additive_projection_approval_v1"
      ? input.approval
      : null;
  await client.query(
    `INSERT INTO holding_projection_generations
       (id, document_id, generation_number, generation_kind,
        retained_sha256, projection_digest, candidate_projection_digest,
        candidate_digest, candidate_manifest,
        old_projection_digest, approval_digest, approved_by, approved_at,
        completeness_attestation, removals_authorized,
        empty_projection_authorized, approval_expected_active_generation_id,
        expected_previous_generation_id, created_at, activated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $19)`,
    [
      input.id,
      input.documentId,
      input.generationNumber,
      input.kind,
      input.retainedSha256,
      input.projectionDigest,
      input.candidateProjectionDigest,
      input.candidateDigest,
      input.candidateManifest,
      input.oldProjectionDigest,
      input.approval?.approvalDigest ?? null,
      input.approval?.approvedBy ?? null,
      input.approval?.approvedAt ?? null,
      input.approval?.completenessAttestation ?? null,
      fullApproval?.authorizeRemovals ??
        scopedApproval?.authorizeSelectedRemovals ??
        additiveApproval?.authorizeRemovals ??
        null,
      fullApproval?.authorizeEmptyProjection ??
        scopedApproval?.authorizeEmptySelectedScopes ??
        (additiveApproval === null ? null : false) ??
        null,
      input.approval?.expectedActiveGenerationId ?? null,
      input.previousGenerationId,
      input.now,
    ],
  );
}

const POSITION_COLUMNS = [
  "id",
  "account_id",
  "as_of",
  "instrument_id",
  "quantity",
  "price",
  "market_value",
  "cost_basis",
  "unrealized",
  "currency",
  "valuation_basis",
  "valuation_note",
  "source_document_id",
  "source_locator",
  "row_hash",
] as const;
const BALANCE_COLUMNS = [
  "id",
  "account_id",
  "as_of",
  "total_value",
  "cash",
  "currency",
  "period_start_value",
  "period_end_value",
  "source_document_id",
  "source_locator",
  "row_hash",
] as const;
const LIABILITY_COLUMNS = [
  "id",
  "institution_id",
  "account_id",
  "kind",
  "display_name",
  "balance",
  "currency",
  "rate",
  "as_of",
  "collateral_note",
  "source_document_id",
  "source_locator",
  "row_hash",
] as const;

async function replaceCurrentProjection(
  client: ArchiveClient,
  documentId: string,
  assertions: readonly Assertion[],
): Promise<void> {
  for (const table of TABLES) {
    await client.query(`DELETE FROM ${table} WHERE source_document_id = $1`, [
      documentId,
    ]);
  }
  await insertRows(
    client,
    "positions",
    POSITION_COLUMNS,
    assertions
      .filter((item) => item.kind === "position")
      .map((item) => [
        item.recordId,
        item.semantic[0],
        item.semantic[1],
        item.semantic[2],
        item.semantic[3],
        item.semantic[4],
        item.semantic[5],
        item.semantic[6],
        item.semantic[7],
        item.semantic[8],
        item.semantic[9],
        item.semantic[10],
        documentId,
        item.sourceLocator,
        item.rowHash,
      ]),
  );
  await insertRows(
    client,
    "balances",
    BALANCE_COLUMNS,
    assertions
      .filter((item) => item.kind === "balance")
      .map((item) => [
        item.recordId,
        item.semantic[0],
        item.semantic[1],
        item.semantic[2],
        item.semantic[3],
        item.semantic[4],
        item.semantic[5],
        item.semantic[6],
        documentId,
        item.sourceLocator,
        item.rowHash,
      ]),
  );
  await insertRows(
    client,
    "liabilities",
    LIABILITY_COLUMNS,
    assertions
      .filter((item) => item.kind === "liability")
      .map((item) => [
        item.recordId,
        item.semantic[0],
        item.semantic[1],
        item.semantic[2],
        item.semantic[3],
        item.semantic[4],
        item.semantic[5],
        item.semantic[6],
        item.semantic[7],
        item.semantic[8],
        documentId,
        item.sourceLocator,
        item.rowHash,
      ]),
  );
}

async function appendCurrentPositions(
  client: ArchiveClient,
  documentId: string,
  assertions: readonly Assertion[],
): Promise<void> {
  if (assertions.some((item) => item.kind !== "position")) {
    refuse("an additive publication attempted to append a non-position row");
  }
  await insertRows(
    client,
    "positions",
    POSITION_COLUMNS,
    assertions.map((item) => [
      item.recordId,
      item.semantic[0],
      item.semantic[1],
      item.semantic[2],
      item.semantic[3],
      item.semantic[4],
      item.semantic[5],
      item.semantic[6],
      item.semantic[7],
      item.semantic[8],
      item.semantic[9],
      item.semantic[10],
      documentId,
      item.sourceLocator,
      item.rowHash,
    ]),
  );
}

async function replaceSelectedCurrentPositions(
  client: ArchiveClient,
  documentId: string,
  selectors: readonly HoldingPositionScopeSelector[],
  assertions: readonly Assertion[],
): Promise<void> {
  await client.query(
    `DELETE FROM positions p
      USING jsonb_to_recordset($2::jsonb) AS selected(account_id text, as_of date)
      WHERE p.source_document_id = $1
        AND p.account_id = selected.account_id AND p.as_of = selected.as_of`,
    [
      documentId,
      JSON.stringify(
        selectors.map((scope) => ({
          account_id: scope.accountId,
          as_of: scope.asOf,
        })),
      ),
    ],
  );
  await insertRows(
    client,
    "positions",
    POSITION_COLUMNS,
    assertions.map((item) => [
      item.recordId,
      item.semantic[0],
      item.semantic[1],
      item.semantic[2],
      item.semantic[3],
      item.semantic[4],
      item.semantic[5],
      item.semantic[6],
      item.semantic[7],
      item.semantic[8],
      item.semantic[9],
      item.semantic[10],
      documentId,
      item.sourceLocator,
      item.rowHash,
    ]),
  );
}

async function replaceSelectedCurrentBalances(
  client: ArchiveClient,
  documentId: string,
  selectors: readonly HoldingBalanceScopeSelector[],
  assertions: readonly Assertion[],
): Promise<void> {
  if (selectors.length === 0) return;
  await client.query(
    `DELETE FROM balances b
      USING jsonb_to_recordset($2::jsonb) AS selected(account_id text, as_of date)
      WHERE b.source_document_id = $1
        AND b.account_id = selected.account_id AND b.as_of = selected.as_of`,
    [
      documentId,
      JSON.stringify(
        selectors.map((scope) => ({
          account_id: scope.accountId,
          as_of: scope.asOf,
        })),
      ),
    ],
  );
  await insertRows(
    client,
    "balances",
    BALANCE_COLUMNS,
    assertions.map((item) => [
      item.recordId,
      item.semantic[0],
      item.semantic[1],
      item.semantic[2],
      item.semantic[3],
      item.semantic[4],
      item.semantic[5],
      item.semantic[6],
      documentId,
      item.sourceLocator,
      item.rowHash,
    ]),
  );
}

const SCOPE_MEMBER_COLUMNS = [
  "source_document_id",
  "scope_id",
  "position_row_hash",
  "account_id",
  "as_of",
  "instrument_id",
  "quantity",
  "price",
  "market_value",
  "cost_basis",
  "unrealized",
  "currency",
  "valuation_basis",
  "valuation_note",
  "source_locator",
] as const;

async function insertVersionedPositionScope(
  client: ArchiveClient,
  input: {
    readonly documentId: string;
    readonly generationId: string;
    readonly retainedSha256: string;
    readonly accountId: string;
    readonly asOf: string;
    readonly proofVersion: "position_scope_v1";
    readonly status: "complete" | "partial";
    readonly emittedPositionCount: number;
    readonly gapCodes: readonly string[];
    readonly zeroBasis: "source_stated_none" | null;
    readonly evidence: unknown;
    readonly members: readonly CandidateHoldingRow[];
    readonly now: string;
  },
): Promise<void> {
  const scopeId = randomUUID();
  await client.query(
    `INSERT INTO position_scope_observations
       (id, source_document_id, holding_projection_generation_id,
        retained_sha256, account_id, as_of, proof_version, status,
        emitted_position_count, gap_codes, zero_basis, evidence, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9,
             $10::text[], $11, $12::jsonb, $13)`,
    [
      scopeId,
      input.documentId,
      input.generationId,
      input.retainedSha256,
      input.accountId,
      input.asOf,
      input.proofVersion,
      input.status,
      input.emittedPositionCount,
      input.gapCodes,
      input.zeroBasis,
      JSON.stringify(input.evidence),
      input.now,
    ],
  );
  await insertRows(
    client,
    "position_scope_memberships",
    SCOPE_MEMBER_COLUMNS,
    input.members.map((row) => [
      input.documentId,
      scopeId,
      row.rowHash,
      row.semantic[0],
      row.semantic[1],
      row.semantic[2],
      row.semantic[3],
      row.semantic[4],
      row.semantic[5],
      row.semantic[6],
      row.semantic[7],
      row.semantic[8],
      row.semantic[9],
      row.semantic[10],
      row.sourceLocator,
    ]),
  );
}

const SCOPED_POSITION_RESOLUTION_PREFIX =
  "resolved on scoped projection publication: the current complete source scope exactly matches the canonical account/date set";
const LEGACY_SCOPED_POSITION_RESOLUTION_PREFIX =
  "resolved on scoped projection publication: the selected complete position scope exactly matches the canonical account/date set";
const IMPORTED_POSITION_RESOLUTION_PREFIX =
  "resolved on reimport: every declared position scope validated and persisted exactly";

/**
 * A source-complete correction may deliberately leave rows owned by another
 * document in place. Re-evaluate every current proof for the selected keys
 * after the canonical rows and active generation pointer have moved. The
 * first side of a multi-source repair therefore stays blocked; a later source
 * correction can resolve both proofs once each immutable membership set is an
 * exact description of the canonical snapshot.
 */
async function reconcilePositionScopeMismatchReviews(
  client: ArchiveClient,
  selectors: readonly HoldingPositionScopeSelector[],
  now: string,
): Promise<void> {
  if (selectors.length === 0) return;
  const accountIds = selectors.map((selector) => selector.accountId);
  const dates = selectors.map((selector) => selector.asOf);
  const found = await client.query<{
    source_document_id: string;
    account_id: string;
    as_of: string;
    proof_version: "position_scope_v1";
    exact: boolean;
  }>(
    `WITH selected(account_id, as_of) AS (
       SELECT * FROM unnest($1::text[], $2::date[])
     )
     SELECT o.source_document_id, o.account_id, o.as_of::text AS as_of,
            o.proof_version,
            (o.status = 'complete'
             AND cardinality(o.gap_codes) = 0
             AND o.retained_sha256 = d.retained_sha256
             AND o.holding_projection_generation_id
                   IS NOT DISTINCT FROM d.active_holding_projection_generation_id
             AND (SELECT count(*) FROM position_scope_memberships count_member
                   WHERE count_member.scope_id = o.id)
                   = o.emitted_position_count
             AND NOT EXISTS (
               SELECT 1
                 FROM position_scope_memberships m
                 LEFT JOIN positions p
                   ON p.row_hash = m.position_row_hash
                  AND p.account_id = m.account_id
                  AND p.as_of = m.as_of
                  AND p.instrument_id IS NOT DISTINCT FROM m.instrument_id
                  AND p.quantity IS NOT DISTINCT FROM m.quantity
                  AND p.price IS NOT DISTINCT FROM m.price
                  AND p.market_value IS NOT DISTINCT FROM m.market_value
                  AND p.cost_basis IS NOT DISTINCT FROM m.cost_basis
                  AND p.unrealized IS NOT DISTINCT FROM m.unrealized
                  AND p.currency = m.currency
                  AND p.valuation_basis IS NOT DISTINCT FROM m.valuation_basis
                  AND ${valuationNotesEquivalentSql("p.valuation_note", "m.valuation_note")}
                WHERE m.scope_id = o.id AND p.id IS NULL
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM positions p
                WHERE p.account_id = o.account_id AND p.as_of = o.as_of
                  AND NOT EXISTS (
                    SELECT 1 FROM position_scope_memberships m
                     WHERE m.scope_id = o.id
                       AND p.row_hash = m.position_row_hash
                       AND p.account_id = m.account_id
                       AND p.as_of = m.as_of
                       AND p.instrument_id IS NOT DISTINCT FROM m.instrument_id
                       AND p.quantity IS NOT DISTINCT FROM m.quantity
                       AND p.price IS NOT DISTINCT FROM m.price
                       AND p.market_value IS NOT DISTINCT FROM m.market_value
                       AND p.cost_basis IS NOT DISTINCT FROM m.cost_basis
                       AND p.unrealized IS NOT DISTINCT FROM m.unrealized
                       AND p.currency = m.currency
                       AND p.valuation_basis IS NOT DISTINCT FROM m.valuation_basis
                       AND ${valuationNotesEquivalentSql("p.valuation_note", "m.valuation_note")}
                  )
             )) AS exact
       FROM selected s
       JOIN position_scope_observations o
         ON o.account_id = s.account_id AND o.as_of = s.as_of
       JOIN documents d ON d.id = o.source_document_id
      WHERE d.superseded_by IS NULL
        AND o.holding_projection_generation_id
              IS NOT DISTINCT FROM d.active_holding_projection_generation_id`,
    [accountIds, dates],
  );
  for (const scope of found.rows) {
    const rawValue = `${scope.account_id}:${scope.as_of}:${scope.proof_version}`;
    if (scope.exact) {
      await client.query(
        `UPDATE review_items
            SET status = 'resolved', resolved_at = $4, resolution_note = $5
          WHERE source_document_id = $1
            AND account_id = $2
            AND kind = 'position_scope_mismatch'
            AND raw_value = $3
            AND status = 'open'`,
        [
          scope.source_document_id,
          scope.account_id,
          rawValue,
          now,
          SCOPED_POSITION_RESOLUTION_PREFIX,
        ],
      );
      continue;
    }
    await client.query(
      `UPDATE review_items SET status = 'open'
        WHERE source_document_id = $1
          AND account_id = $2
          AND kind = 'position_scope_mismatch'
          AND raw_value = $3
          AND status = 'resolved'
          AND resolution_note LIKE ANY($4::text[])`,
      [
        scope.source_document_id,
        scope.account_id,
        rawValue,
        [
          `${SCOPED_POSITION_RESOLUTION_PREFIX}%`,
          `${LEGACY_SCOPED_POSITION_RESOLUTION_PREFIX}%`,
          `${IMPORTED_POSITION_RESOLUTION_PREFIX}%`,
        ],
      ],
    );
  }
}

async function carryForwardPositionScopes(
  client: ArchiveClient,
  input: {
    readonly documentId: string;
    readonly retainedSha256: string;
    readonly previousGenerationId: string | null;
    readonly activeGenerationId: string;
    readonly selected: ReadonlySet<string>;
    readonly now: string;
  },
): Promise<void> {
  const found = await client.query<{
    id: string;
    account_id: string;
    as_of: string;
    proof_version: "position_scope_v1";
    status: "complete" | "partial";
    emitted_position_count: string;
    gap_codes: string[];
    zero_basis: "source_stated_none" | null;
    evidence: unknown;
    retained_sha256: string;
  }>(
    `SELECT id, account_id, as_of::text AS as_of, proof_version, status,
            emitted_position_count::text, gap_codes, zero_basis, evidence,
            retained_sha256
       FROM position_scope_observations
      WHERE source_document_id = $1
        AND holding_projection_generation_id IS NOT DISTINCT FROM $2
      ORDER BY account_id, as_of, proof_version`,
    [input.documentId, input.previousGenerationId],
  );
  for (const scope of found.rows) {
    if (
      input.selected.has(
        `${scope.account_id}\u0000${scope.as_of}\u0000${scope.proof_version}`,
      )
    ) {
      continue;
    }
    if (scope.retained_sha256 !== input.retainedSha256) {
      refuse("a nonselected position scope has stale retained provenance");
    }
    const members = await client.query<{
      position_row_hash: string;
      source_locator: string;
      account_id: string;
      as_of: string;
      instrument_id: string | null;
      quantity: string | null;
      price: string | null;
      market_value: string | null;
      cost_basis: string | null;
      unrealized: string | null;
      currency: string;
      valuation_basis: string | null;
      valuation_note: string | null;
    }>(
      `SELECT position_row_hash, source_locator, account_id,
              as_of::text AS as_of, instrument_id, quantity::text, price::text,
              market_value::text, cost_basis::text, unrealized::text,
              currency::text, valuation_basis, valuation_note
         FROM position_scope_memberships WHERE scope_id = $1
        ORDER BY position_row_hash`,
      [scope.id],
    );
    await insertVersionedPositionScope(client, {
      documentId: input.documentId,
      generationId: input.activeGenerationId,
      retainedSha256: input.retainedSha256,
      accountId: scope.account_id,
      asOf: scope.as_of,
      proofVersion: scope.proof_version,
      status: scope.status,
      emittedPositionCount: Number(scope.emitted_position_count),
      gapCodes: scope.gap_codes,
      zeroBasis: scope.zero_basis,
      evidence: scope.evidence,
      members: members.rows.map((row) => ({
        rowHash: row.position_row_hash,
        sourceLocator: row.source_locator,
        semantic: [
          row.account_id,
          row.as_of,
          row.instrument_id,
          row.quantity,
          row.price,
          row.market_value,
          row.cost_basis,
          row.unrealized,
          row.currency,
          row.valuation_basis,
          row.valuation_note,
        ],
      })),
      now: input.now,
    });
  }
}

function reconciliationScopes(
  old: StoredHoldingProjection,
  candidate: CandidateHoldingProjection,
): { cash: CashChange[]; positions: PositionChange[] } {
  const cash = new Map<string, CashChange>();
  const positions = new Map<string, PositionChange>();
  for (const row of [...old.balances, ...candidate.balances]) {
    const value = { accountId: row.semantic[0]!, date: row.semantic[1]! };
    cash.set(canonical(value), value);
  }
  for (const row of [...old.positions, ...candidate.positions]) {
    const instrumentId = row.semantic[2] ?? null;
    if (instrumentId === null) continue;
    const value = {
      accountId: row.semantic[0]!,
      date: row.semantic[1]!,
      instrumentId,
    };
    positions.set(canonical(value), value);
  }
  return { cash: [...cash.values()], positions: [...positions.values()] };
}

/**
 * Publishes an explicitly reviewed, exact candidate as the current holdings
 * mirror while retaining the prior and new typed assertions indefinitely.
 * This is the only supported writer for a document once it has an active
 * projection generation.
 */
export async function publishHoldingProjectionReplacement(
  client: ArchiveClient,
  input: {
    readonly candidate: ImportDocument;
    readonly approval: HoldingProjectionApproval;
  },
  now: Date = new Date(),
): Promise<HoldingProjectionPublication> {
  return withArchiveTransaction(client, async (tx) => {
    await lockArchiveForWrite(tx);
    const selected = await tx.query<DocumentRow>(
      `SELECT id, retained_sha256, active_holding_projection_generation_id,
              superseded_by
         FROM documents WHERE id = $1 FOR UPDATE`,
      [input.approval.documentId],
    );
    const document = selected.rows[0];
    if (document === undefined) refuse("selected document does not exist");
    if (document.superseded_by !== null) {
      refuse("superseded documents cannot publish a holding projection");
    }
    if (
      document.retained_sha256 === null ||
      document.retained_sha256 !== input.approval.retainedSha256 ||
      input.candidate.retainedSha256 !== document.retained_sha256 ||
      input.candidate.sha256 !== document.retained_sha256
    ) {
      refuse("selected retained bytes do not match the approval and candidate");
    }

    const stored = await readStoredHoldingProjection(tx, document.id);
    const prepared = prepareHoldingCorrectionCandidate({
      documentId: document.id,
      retainedSha256: document.retained_sha256,
      stored,
      candidate: input.candidate,
    });
    if (prepared.manifest.completeness.state === "partial") {
      refuse("partial candidates cannot be published");
    }
    validateApproval(
      input.approval,
      prepared.manifest,
      document.active_holding_projection_generation_id,
    );
    await assertCandidateHashesOwnedByDocument(
      tx,
      document.id,
      input.candidate,
    );

    const oldAssertions = assertionsForStored(
      stored,
      document.id,
      document.retained_sha256,
    );
    let previousGenerationId = document.active_holding_projection_generation_id;
    const sequence = await tx.query<{ generation_number: string | null }>(
      `SELECT max(generation_number)::text AS generation_number
         FROM holding_projection_generations WHERE document_id = $1`,
      [document.id],
    );
    let generationNumber = Number(sequence.rows[0]?.generation_number ?? 0);
    if (!Number.isSafeInteger(generationNumber) || generationNumber < 0) {
      refuse("generation sequence is invalid");
    }

    if (previousGenerationId === null) {
      previousGenerationId = randomUUID();
      generationNumber += 1;
      await insertAssertions(tx, oldAssertions);
      await insertGeneration(tx, {
        id: previousGenerationId,
        documentId: document.id,
        generationNumber,
        kind: "baseline",
        retainedSha256: document.retained_sha256,
        projectionDigest: prepared.manifest.oldProjectionDigest,
        candidateProjectionDigest: null,
        candidateDigest: null,
        candidateManifest: null,
        oldProjectionDigest: null,
        approval: null,
        previousGenerationId: null,
        now: now.toISOString(),
      });
      await insertMemberships(tx, previousGenerationId, oldAssertions);
    } else {
      const active = await tx.query<{
        retained_sha256: string;
        projection_digest: string;
      }>(
        `SELECT retained_sha256, projection_digest
           FROM holding_projection_generations
          WHERE document_id = $1 AND id = $2`,
        [document.id, previousGenerationId],
      );
      if (
        active.rows[0]?.retained_sha256 !== document.retained_sha256 ||
        active.rows[0]?.projection_digest !==
          prepared.manifest.oldProjectionDigest
      ) {
        refuse("active generation does not bind the current projection");
      }
      const historical = await readGenerationProjection(
        tx,
        document.id,
        previousGenerationId,
      );
      if (
        canonical(sortedProjection(historical)) !==
        canonical(sortedProjection(stored))
      ) {
        refuse("current projection does not match its active generation");
      }
    }

    const next = assertionsForCandidate(
      prepared.projection,
      oldAssertions,
      document.id,
      document.retained_sha256,
    );
    await insertAssertions(tx, next.assertions);
    const activeGenerationId = randomUUID();
    generationNumber += 1;
    await insertGeneration(tx, {
      id: activeGenerationId,
      documentId: document.id,
      generationNumber,
      kind: "published",
      retainedSha256: document.retained_sha256,
      projectionDigest: holdingProjectionCurrentDigest(
        storedProjectionFromAssertions(next.assertions),
      ),
      candidateProjectionDigest: prepared.manifest.candidateProjectionDigest,
      candidateDigest: prepared.manifest.candidateDigest,
      candidateManifest: prepared.manifest,
      oldProjectionDigest: prepared.manifest.oldProjectionDigest,
      approval: input.approval,
      previousGenerationId,
      now: now.toISOString(),
    });
    await insertMemberships(tx, activeGenerationId, next.assertions);
    await replaceCurrentProjection(tx, document.id, next.assertions);

    const scopes = reconciliationScopes(stored, prepared.projection);
    const cash = await runReconciliationGate(tx, undefined, {
      snapshots: scopes.cash,
      activity: [],
    });
    const positions = await runPositionReconciliationGate(tx, undefined, {
      snapshots: scopes.positions,
      activity: [],
    });

    const updated = await tx.query(
      `UPDATE documents
          SET active_holding_projection_generation_id = $2
        WHERE id = $1
          AND active_holding_projection_generation_id IS NOT DISTINCT FROM $3`,
      [
        document.id,
        activeGenerationId,
        input.approval.expectedActiveGenerationId,
      ],
    );
    if (updated.rowCount !== 1)
      refuse("active generation changed during publication");

    return {
      documentId: document.id,
      previousGenerationId,
      activeGenerationId,
      generationNumber,
      retainedIds: next.retainedIds,
      mintedIds: next.mintedIds,
      rows: {
        positions: prepared.projection.positions.length,
        balances: prepared.projection.balances.length,
        liabilities: prepared.projection.liabilities.length,
      },
      candidateDigest: prepared.manifest.candidateDigest,
      approvalDigest: input.approval.approvalDigest,
      reconciliations: {
        cashPassed: cash.passed,
        cashFailed: cash.failed,
        cashUnverified: cash.unverified,
        positionsPassed: positions.passed,
        positionsFailed: positions.failed,
        positionsUnverified: positions.unverified,
      },
    };
  });
}

/**
 * Publishes positively complete account/date position scopes as one ordinary
 * full document generation. Nonselected holdings remain the exact prior
 * assertions, while exact foreign-owned scope members remain references.
 */
export async function publishHoldingScopedPositionCorrection(
  client: ArchiveClient,
  input: {
    readonly candidate: ImportDocument;
    readonly approval: HoldingScopedProjectionApproval;
  },
  now: Date = new Date(),
): Promise<HoldingProjectionPublication> {
  return withArchiveTransaction(client, async (tx) => {
    await lockArchiveForWrite(tx);
    const selectedDocument = await tx.query<DocumentRow>(
      `SELECT id, retained_sha256, active_holding_projection_generation_id,
              superseded_by
         FROM documents WHERE id = $1 FOR UPDATE`,
      [input.approval.documentId],
    );
    const document = selectedDocument.rows[0];
    if (document === undefined) refuse("selected document does not exist");
    if (document.superseded_by !== null) {
      refuse("superseded documents cannot publish a holding projection");
    }
    if (
      document.retained_sha256 === null ||
      document.retained_sha256 !== input.approval.retainedSha256 ||
      input.candidate.retainedSha256 !== document.retained_sha256 ||
      input.candidate.sha256 !== document.retained_sha256
    ) {
      refuse("selected retained bytes do not match the approval and candidate");
    }

    const stored = await readStoredHoldingProjection(tx, document.id);
    const prepared = await prepareHoldingScopedPositionCorrection({
      client: tx,
      documentId: document.id,
      retainedSha256: document.retained_sha256,
      expectedActiveGenerationId:
        document.active_holding_projection_generation_id,
      stored,
      candidate: input.candidate,
      selectors: input.approval.selectedScopes,
    });
    validateScopedApproval(input.approval, prepared.manifest);

    const selectedPositions = new Set(
      prepared.selectedPositionScopes.map((scope) => scopeKey(scope.selector)),
    );
    const selectedBalances = new Set(
      prepared.selectedBalanceScopes.map((scope) => scopeKey(scope.selector)),
    );
    const oldAssertions = assertionsForStored(
      stored,
      document.id,
      document.retained_sha256,
    );
    const oldSelectedAssertions = oldAssertions.filter(
      (item) =>
        (item.kind === "position" &&
          selectedPosition(item.semantic, selectedPositions)) ||
        (item.kind === "balance" &&
          selectedBalance(item.semantic, selectedBalances)),
    );
    const preservedAssertions = oldAssertions.filter(
      (item) =>
        !(
          (item.kind === "position" &&
            selectedPosition(item.semantic, selectedPositions)) ||
          (item.kind === "balance" &&
            selectedBalance(item.semantic, selectedBalances))
        ),
    );
    const selectedNext = assertionsForCandidate(
      {
        positions: prepared.sourceOwnedPositions,
        balances: prepared.sourceOwnedBalances,
        liabilities: [],
      },
      oldSelectedAssertions,
      document.id,
      document.retained_sha256,
    );
    const nextAssertions = [...preservedAssertions, ...selectedNext.assertions];

    let previousGenerationId = document.active_holding_projection_generation_id;
    const priorScopeGenerationId = previousGenerationId;
    const sequence = await tx.query<{ generation_number: string | null }>(
      `SELECT max(generation_number)::text AS generation_number
         FROM holding_projection_generations WHERE document_id = $1`,
      [document.id],
    );
    let generationNumber = Number(sequence.rows[0]?.generation_number ?? 0);
    if (!Number.isSafeInteger(generationNumber) || generationNumber < 0) {
      refuse("generation sequence is invalid");
    }
    if (previousGenerationId === null) {
      previousGenerationId = randomUUID();
      generationNumber += 1;
      await insertAssertions(tx, oldAssertions);
      await insertGeneration(tx, {
        id: previousGenerationId,
        documentId: document.id,
        generationNumber,
        kind: "baseline",
        retainedSha256: document.retained_sha256,
        projectionDigest: prepared.manifest.oldProjectionDigest,
        candidateProjectionDigest: null,
        candidateDigest: null,
        candidateManifest: null,
        oldProjectionDigest: null,
        approval: null,
        previousGenerationId: null,
        now: now.toISOString(),
      });
      await insertMemberships(tx, previousGenerationId, oldAssertions);
    } else {
      const active = await tx.query<{
        retained_sha256: string;
        projection_digest: string;
      }>(
        `SELECT retained_sha256, projection_digest
           FROM holding_projection_generations
          WHERE document_id = $1 AND id = $2`,
        [document.id, previousGenerationId],
      );
      if (
        active.rows[0]?.retained_sha256 !== document.retained_sha256 ||
        active.rows[0]?.projection_digest !==
          prepared.manifest.oldProjectionDigest
      ) {
        refuse("active generation does not bind the current projection");
      }
      const historical = await readGenerationProjection(
        tx,
        document.id,
        previousGenerationId,
      );
      if (
        canonical(sortedProjection(historical)) !==
        canonical(sortedProjection(stored))
      ) {
        refuse("current projection does not match its active generation");
      }
    }

    await insertAssertions(tx, nextAssertions);
    const activeGenerationId = randomUUID();
    generationNumber += 1;
    await insertGeneration(tx, {
      id: activeGenerationId,
      documentId: document.id,
      generationNumber,
      kind: "published",
      retainedSha256: document.retained_sha256,
      projectionDigest: holdingProjectionCurrentDigest(
        storedProjectionFromAssertions(nextAssertions),
      ),
      candidateProjectionDigest: prepared.manifest.candidateProjectionDigest,
      candidateDigest: prepared.manifest.candidateDigest,
      candidateManifest: prepared.manifest,
      oldProjectionDigest: prepared.manifest.oldProjectionDigest,
      approval: input.approval,
      previousGenerationId,
      now: now.toISOString(),
    });
    await insertMemberships(tx, activeGenerationId, nextAssertions);
    await replaceSelectedCurrentPositions(
      tx,
      document.id,
      prepared.selectedPositionScopes.map((scope) => scope.selector),
      selectedNext.assertions.filter((item) => item.kind === "position"),
    );
    await replaceSelectedCurrentBalances(
      tx,
      document.id,
      prepared.selectedBalanceScopes.map((scope) => scope.selector),
      selectedNext.assertions.filter((item) => item.kind === "balance"),
    );

    await carryForwardPositionScopes(tx, {
      documentId: document.id,
      retainedSha256: document.retained_sha256,
      previousGenerationId: priorScopeGenerationId,
      activeGenerationId,
      selected: selectedPositions,
      now: now.toISOString(),
    });
    for (const scope of prepared.selectedPositionScopes) {
      await insertVersionedPositionScope(tx, {
        documentId: document.id,
        generationId: activeGenerationId,
        retainedSha256: document.retained_sha256,
        accountId: scope.selector.accountId,
        asOf: scope.selector.asOf,
        proofVersion: scope.selector.proofVersion,
        status: "complete",
        emittedPositionCount: scope.declaration.emittedPositionCount,
        gapCodes: [],
        zeroBasis: scope.declaration.zeroBasis ?? null,
        evidence: scope.declaration.evidence,
        members: scope.positions,
        now: now.toISOString(),
      });
    }

    const positionChangeMap = new Map<string, PositionChange>();
    for (const item of oldSelectedAssertions) {
      if (item.kind !== "position") continue;
      const accountId = item.semantic[0];
      const date = item.semantic[1];
      const instrumentId = item.semantic[2];
      if (
        accountId === null ||
        accountId === undefined ||
        date === null ||
        date === undefined ||
        instrumentId === null ||
        instrumentId === undefined
      ) {
        continue;
      }
      const value = { accountId, date, instrumentId };
      positionChangeMap.set(canonical(value), value);
    }
    for (const scope of prepared.selectedPositionScopes) {
      for (const row of scope.positions) {
        const instrumentId = row.semantic[2];
        if (instrumentId === null || instrumentId === undefined) continue;
        const value = {
          accountId: scope.selector.accountId,
          date: scope.selector.asOf,
          instrumentId,
        };
        positionChangeMap.set(canonical(value), value);
      }
    }
    const positionReconciliations = await runPositionReconciliationGate(
      tx,
      undefined,
      { snapshots: [...positionChangeMap.values()], activity: [] },
    );
    const cashChangeMap = new Map<string, CashChange>();
    for (const item of oldSelectedAssertions) {
      if (item.kind !== "balance") continue;
      const accountId = item.semantic[0];
      const date = item.semantic[1];
      if (
        accountId === null ||
        accountId === undefined ||
        date === null ||
        date === undefined
      ) {
        continue;
      }
      const value = { accountId, date };
      cashChangeMap.set(canonical(value), value);
    }
    for (const scope of prepared.selectedBalanceScopes) {
      const value = {
        accountId: scope.selector.accountId,
        date: scope.selector.asOf,
      };
      cashChangeMap.set(canonical(value), value);
    }
    const cashReconciliations = await runReconciliationGate(tx, undefined, {
      snapshots: [...cashChangeMap.values()],
      activity: [],
    });

    const updated = await tx.query(
      `UPDATE documents
          SET active_holding_projection_generation_id = $2
        WHERE id = $1
          AND active_holding_projection_generation_id IS NOT DISTINCT FROM $3`,
      [
        document.id,
        activeGenerationId,
        input.approval.expectedActiveGenerationId,
      ],
    );
    if (updated.rowCount !== 1) {
      refuse("active generation changed during publication");
    }
    await reconcilePositionScopeMismatchReviews(
      tx,
      prepared.selectedPositionScopes.map((scope) => scope.selector),
      now.toISOString(),
    );

    return {
      documentId: document.id,
      previousGenerationId,
      activeGenerationId,
      generationNumber,
      retainedIds: preservedAssertions.length + selectedNext.retainedIds,
      mintedIds: selectedNext.mintedIds,
      rows: {
        positions: nextAssertions.filter((item) => item.kind === "position")
          .length,
        balances: nextAssertions.filter((item) => item.kind === "balance")
          .length,
        liabilities: stored.liabilities.length,
      },
      candidateDigest: prepared.manifest.candidateDigest,
      approvalDigest: input.approval.approvalDigest,
      reconciliations: {
        cashPassed: cashReconciliations.passed,
        cashFailed: cashReconciliations.failed,
        cashUnverified: cashReconciliations.unverified,
        positionsPassed: positionReconciliations.passed,
        positionsFailed: positionReconciliations.failed,
        positionsUnverified: positionReconciliations.unverified,
      },
    };
  });
}

/**
 * Publishes explicit source-owned position additions while carrying every
 * prior assertion unchanged. The selected scopes remain partial and therefore
 * cannot make a freshness or completeness claim.
 */
export async function publishHoldingAdditivePositionCorrection(
  client: ArchiveClient,
  input: {
    readonly candidate: ImportDocument;
    readonly approval: HoldingAdditiveProjectionApproval;
  },
  now: Date = new Date(),
): Promise<HoldingProjectionPublication> {
  return withArchiveTransaction(client, async (tx) => {
    await lockArchiveForWrite(tx);
    const selectedDocument = await tx.query<DocumentRow>(
      `SELECT id, retained_sha256, active_holding_projection_generation_id,
              superseded_by
         FROM documents WHERE id = $1 FOR UPDATE`,
      [input.approval.documentId],
    );
    const document = selectedDocument.rows[0];
    if (document === undefined) refuse("selected document does not exist");
    if (document.superseded_by !== null) {
      refuse("superseded documents cannot publish a holding projection");
    }
    if (
      document.retained_sha256 === null ||
      document.retained_sha256 !== input.approval.retainedSha256 ||
      input.candidate.retainedSha256 !== document.retained_sha256 ||
      input.candidate.sha256 !== document.retained_sha256
    ) {
      refuse("selected retained bytes do not match the approval and candidate");
    }

    const stored = await readStoredHoldingProjection(tx, document.id);
    const prepared = await prepareHoldingAdditivePositionCorrection({
      client: tx,
      documentId: document.id,
      retainedSha256: document.retained_sha256,
      expectedActiveGenerationId:
        document.active_holding_projection_generation_id,
      stored,
      candidate: input.candidate,
      selectors: input.approval.selectedScopes,
      selectedRowHashes: input.approval.selectedRowHashes,
    });
    validateAdditiveApproval(input.approval, prepared.manifest);

    const oldAssertions = assertionsForStored(
      stored,
      document.id,
      document.retained_sha256,
    );
    const additions = assertionsForCandidate(
      {
        positions: prepared.sourceOwnedAdditions,
        balances: [],
        liabilities: [],
      },
      [],
      document.id,
      document.retained_sha256,
    );
    const nextAssertions = [...oldAssertions, ...additions.assertions];

    let previousGenerationId = document.active_holding_projection_generation_id;
    const priorScopeGenerationId = previousGenerationId;
    const sequence = await tx.query<{ generation_number: string | null }>(
      `SELECT max(generation_number)::text AS generation_number
         FROM holding_projection_generations WHERE document_id = $1`,
      [document.id],
    );
    let generationNumber = Number(sequence.rows[0]?.generation_number ?? 0);
    if (!Number.isSafeInteger(generationNumber) || generationNumber < 0) {
      refuse("generation sequence is invalid");
    }
    if (previousGenerationId === null) {
      previousGenerationId = randomUUID();
      generationNumber += 1;
      await insertAssertions(tx, oldAssertions);
      await insertGeneration(tx, {
        id: previousGenerationId,
        documentId: document.id,
        generationNumber,
        kind: "baseline",
        retainedSha256: document.retained_sha256,
        projectionDigest: prepared.manifest.oldProjectionDigest,
        candidateProjectionDigest: null,
        candidateDigest: null,
        candidateManifest: null,
        oldProjectionDigest: null,
        approval: null,
        previousGenerationId: null,
        now: now.toISOString(),
      });
      await insertMemberships(tx, previousGenerationId, oldAssertions);
    } else {
      const active = await tx.query<{
        retained_sha256: string;
        projection_digest: string;
      }>(
        `SELECT retained_sha256, projection_digest
           FROM holding_projection_generations
          WHERE document_id = $1 AND id = $2`,
        [document.id, previousGenerationId],
      );
      if (
        active.rows[0]?.retained_sha256 !== document.retained_sha256 ||
        active.rows[0]?.projection_digest !==
          prepared.manifest.oldProjectionDigest
      ) {
        refuse("active generation does not bind the current projection");
      }
      const historical = await readGenerationProjection(
        tx,
        document.id,
        previousGenerationId,
      );
      if (
        canonical(sortedProjection(historical)) !==
        canonical(sortedProjection(stored))
      ) {
        refuse("current projection does not match its active generation");
      }
    }

    await insertAssertions(tx, additions.assertions);
    const activeGenerationId = randomUUID();
    generationNumber += 1;
    await insertGeneration(tx, {
      id: activeGenerationId,
      documentId: document.id,
      generationNumber,
      kind: "published",
      retainedSha256: document.retained_sha256,
      projectionDigest: holdingProjectionCurrentDigest(
        storedProjectionFromAssertions(nextAssertions),
      ),
      candidateProjectionDigest: prepared.manifest.candidateProjectionDigest,
      candidateDigest: prepared.manifest.candidateDigest,
      candidateManifest: prepared.manifest,
      oldProjectionDigest: prepared.manifest.oldProjectionDigest,
      approval: input.approval,
      previousGenerationId,
      now: now.toISOString(),
    });
    await insertMemberships(tx, activeGenerationId, nextAssertions);
    await appendCurrentPositions(
      tx,
      document.id,
      additions.assertions,
    );

    const selectedScopeKeys = new Set(
      prepared.selectedPositionScopes.map((scope) => scopeKey(scope.selector)),
    );
    await carryForwardPositionScopes(tx, {
      documentId: document.id,
      retainedSha256: document.retained_sha256,
      previousGenerationId: priorScopeGenerationId,
      activeGenerationId,
      selected: selectedScopeKeys,
      now: now.toISOString(),
    });
    for (const scope of prepared.selectedPositionScopes) {
      await insertVersionedPositionScope(tx, {
        documentId: document.id,
        generationId: activeGenerationId,
        retainedSha256: document.retained_sha256,
        accountId: scope.selector.accountId,
        asOf: scope.selector.asOf,
        proofVersion: scope.selector.proofVersion,
        status: "partial",
        emittedPositionCount: scope.declaration.emittedPositionCount,
        gapCodes: scope.declaration.gapCodes,
        zeroBasis: null,
        evidence: scope.declaration.evidence,
        members: scope.positions,
        now: now.toISOString(),
      });
    }

    const positionChanges: PositionChange[] = [];
    for (const row of prepared.sourceOwnedAdditions) {
      const accountId = row.semantic[0] ?? null;
      const date = row.semantic[1] ?? null;
      const instrumentId = row.semantic[2] ?? null;
      if (accountId !== null && date !== null && instrumentId !== null) {
        positionChanges.push({ accountId, date, instrumentId });
      }
    }
    const positionReconciliations = await runPositionReconciliationGate(
      tx,
      undefined,
      { snapshots: positionChanges, activity: [] },
    );

    const updated = await tx.query(
      `UPDATE documents
          SET active_holding_projection_generation_id = $2
        WHERE id = $1
          AND active_holding_projection_generation_id IS NOT DISTINCT FROM $3`,
      [
        document.id,
        activeGenerationId,
        input.approval.expectedActiveGenerationId,
      ],
    );
    if (updated.rowCount !== 1) {
      refuse("active generation changed during publication");
    }

    return {
      documentId: document.id,
      previousGenerationId,
      activeGenerationId,
      generationNumber,
      retainedIds: oldAssertions.length,
      mintedIds: additions.mintedIds,
      rows: {
        positions: nextAssertions.filter((item) => item.kind === "position")
          .length,
        balances: stored.balances.length,
        liabilities: stored.liabilities.length,
      },
      candidateDigest: prepared.manifest.candidateDigest,
      approvalDigest: input.approval.approvalDigest,
      reconciliations: {
        cashPassed: 0,
        cashFailed: 0,
        cashUnverified: 0,
        positionsPassed: positionReconciliations.passed,
        positionsFailed: positionReconciliations.failed,
        positionsUnverified: positionReconciliations.unverified,
      },
    };
  });
}
