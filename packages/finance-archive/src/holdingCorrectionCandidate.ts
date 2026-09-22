import { createHash } from "node:crypto";

import type {
  ImportBalance,
  ImportBalanceScope,
  ImportDocument,
  ImportLiability,
  ImportPosition,
  ImportPositionScope,
} from "./importer.js";
import { toMinorUnits } from "./money.js";
import { toNumericText } from "./pgNumeric.js";
import { balanceHash, liabilityHash, positionHash } from "./rowHash.js";
import type { ArchiveClient } from "./pgStore.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const VALUATION_BASES = new Set([
  "market_price",
  "last_round",
  "cost",
  "reported_nav",
]);
const TABLES = ["positions", "balances", "liabilities"] as const;

export type HoldingProjectionTable = (typeof TABLES)[number];

export type StoredHoldingRow = {
  readonly id: string;
  readonly rowHash: string | null;
  readonly sourceLocator: string | null;
  /** Table-specific semantic columns in the canonical order below. */
  readonly semantic: readonly (string | null)[];
};

export type StoredHoldingProjection = Readonly<
  Record<HoldingProjectionTable, readonly StoredHoldingRow[]>
>;

export type CandidateHoldingRow = {
  readonly rowHash: string;
  readonly sourceLocator: string;
  readonly semantic: readonly (string | null)[];
};

export type CandidateHoldingProjection = Readonly<
  Record<HoldingProjectionTable, readonly CandidateHoldingRow[]>
>;

export type HoldingProjectionDelta = {
  readonly oldRows: number;
  readonly candidateRows: number;
  readonly unchanged: number;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  /** Remaining locator keys with multiple rows on either side. These rows
   * remain additions/removals; no automatic change pairing is inferred. */
  readonly ambiguousLocators: number;
};

export type HoldingCorrectionCompletenessReason =
  | "adapter_has_no_holding_completeness_attestation"
  | "adapter_mapping_review_required"
  | "candidate_row_rejected"
  | "parse_gap";

export type HoldingCorrectionCandidateManifest = {
  readonly schemaVersion: 1;
  readonly kind: "holding_correction_candidate_v1";
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly oldProjectionDigest: string;
  readonly candidateProjectionDigest: string;
  readonly tables: Readonly<
    Record<HoldingProjectionTable, HoldingProjectionDelta>
  >;
  readonly completeness: {
    /** This first-stage contract intentionally has no `complete` state. */
    readonly state: "partial" | "unproven";
    readonly reasons: readonly HoldingCorrectionCompletenessReason[];
    readonly issueCount: number;
    readonly removalsAuthorized: false;
  };
  /** Digest of every field above, under its own versioned domain. */
  readonly candidateDigest: string;
};

export type PreparedHoldingCorrectionCandidate = {
  readonly manifest: HoldingCorrectionCandidateManifest;
  readonly projection: CandidateHoldingProjection;
};

export type HoldingPositionScopeSelector = {
  readonly accountId: string;
  readonly asOf: string;
  readonly proofVersion: "position_scope_v1";
};

export type PreparedHoldingPositionScope = {
  readonly selector: HoldingPositionScopeSelector;
  readonly declaration: ImportPositionScope;
  readonly positions: readonly CandidateHoldingRow[];
  /** Binds the positive boundary evidence and every source-owned locator and
   * semantic member without exposing those values in the public manifest. */
  readonly scopeDigest: string;
};

export type HoldingBalanceScopeSelector = {
  readonly accountId: string;
  readonly asOf: string;
  readonly proofVersion: "balance_scope_v1";
};

export type PreparedHoldingBalanceScope = {
  readonly selector: HoldingBalanceScopeSelector;
  readonly declaration: ImportBalanceScope;
  readonly balances: readonly CandidateHoldingRow[];
  readonly scopeDigest: string;
};

type CandidateBuild = {
  readonly projection: CandidateHoldingProjection;
  readonly issueCount: number;
  readonly rejectedRows: number;
};

type StoredPositionRow = {
  id: string;
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
  source_locator: string | null;
  row_hash: string | null;
};

type StoredBalanceRow = {
  id: string;
  account_id: string;
  as_of: string;
  total_value: string | null;
  cash: string | null;
  currency: string;
  period_start_value: string | null;
  period_end_value: string | null;
  source_locator: string | null;
  row_hash: string | null;
};

type StoredLiabilityRow = {
  id: string;
  institution_id: string | null;
  account_id: string | null;
  kind: string;
  display_name: string | null;
  balance: string | null;
  currency: string;
  rate: string | null;
  as_of: string;
  collateral_note: string | null;
  source_locator: string | null;
  row_hash: string | null;
};

function fail(message: string): never {
  throw new Error(`holding correction candidate refused: ${message}`);
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${canonical(value)}`, "utf8")
    .digest("hex");
}

function normalizedNumeric(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toNumericText(String(value));
}

function candidateNumeric(
  value: string | null,
  issue: () => void,
): string | null {
  if (value === null) return null;
  try {
    return toNumericText(value);
  } catch {
    issue();
    return null;
  }
}

function candidateMoney(
  value: string | null,
  note: string | null,
  currency: string,
  issue: () => void,
): string | null {
  if (value === null) {
    if (note !== null) issue();
    return null;
  }
  try {
    toMinorUnits(value, currency);
    return toNumericText(value);
  } catch {
    issue();
    return null;
  }
}

function candidateOptionalMoney(
  value: string | null,
  currency: string,
  issue: () => void,
): string | null {
  return candidateMoney(value, null, currency, issue);
}

function accountId(
  rowAccountId: string | null | undefined,
  documentAccountId: string | null,
  table: HoldingProjectionTable,
): string | null {
  const resolved = rowAccountId ?? documentAccountId;
  if (resolved === null && table !== "liabilities") {
    fail(`${table} candidate has no account`);
  }
  return resolved;
}

function validDate(value: string): boolean {
  return ISO_DATE.test(value);
}

function assertCurrencyCode(
  value: string,
  table: HoldingProjectionTable,
): void {
  if (!CURRENCY_CODE.test(value)) {
    fail(`${table} candidate has an invalid currency code`);
  }
}

function preparePosition(
  row: ImportPosition,
  document: ImportDocument,
  issue: () => void,
): CandidateHoldingRow | null {
  const account = accountId(row.accountId, document.accountId, "positions")!;
  if (!validDate(row.asOf)) return null;
  assertCurrencyCode(row.currency, "positions");
  const quantity = candidateNumeric(row.quantity, issue);
  const price = candidateNumeric(row.price, issue);
  const marketValue = candidateMoney(
    row.marketValueText,
    row.marketValueNote,
    row.currency,
    issue,
  );
  const costBasis = candidateOptionalMoney(row.costBasis, row.currency, issue);
  const unrealized = candidateOptionalMoney(
    row.unrealized,
    row.currency,
    issue,
  );
  let valuationBasis = row.valuationBasis;
  if (valuationBasis === null || !VALUATION_BASES.has(valuationBasis)) {
    issue();
    valuationBasis = null;
  }
  const rowHash = positionHash({
    accountId: account,
    instrumentId: row.instrumentId,
    asOf: row.asOf,
    quantity,
    marketValue,
    costBasis,
    valuationBasis,
    sourceLocator: row.sourceLocator,
  });
  return {
    rowHash,
    sourceLocator: row.sourceLocator,
    semantic: [
      account,
      row.asOf,
      row.instrumentId,
      quantity,
      price,
      marketValue,
      costBasis,
      unrealized,
      row.currency,
      valuationBasis,
      row.valuationNote,
    ],
  };
}

function prepareBalance(
  row: ImportBalance,
  document: ImportDocument,
  issue: () => void,
): CandidateHoldingRow | null {
  const account = accountId(row.accountId, document.accountId, "balances")!;
  if (!validDate(row.asOf)) return null;
  assertCurrencyCode(row.currency, "balances");
  const totalValue = candidateMoney(
    row.totalValueText,
    row.totalValueNote,
    row.currency,
    issue,
  );
  const cash = candidateOptionalMoney(row.cash, row.currency, issue);
  const periodStartValue = candidateOptionalMoney(
    row.periodStartValue,
    row.currency,
    issue,
  );
  const periodEndValue = candidateOptionalMoney(
    row.periodEndValue,
    row.currency,
    issue,
  );
  return {
    rowHash: balanceHash({
      accountId: account,
      asOf: row.asOf,
      totalValue,
      cash,
    }),
    sourceLocator: row.sourceLocator,
    semantic: [
      account,
      row.asOf,
      totalValue,
      cash,
      row.currency,
      periodStartValue,
      periodEndValue,
    ],
  };
}

function prepareLiability(
  row: ImportLiability,
  document: ImportDocument,
  issue: () => void,
): CandidateHoldingRow | null {
  const account = accountId(row.accountId, document.accountId, "liabilities");
  if (!validDate(row.asOf)) return null;
  assertCurrencyCode(row.currency, "liabilities");
  const balance = candidateMoney(
    row.balanceText,
    row.balanceNote,
    row.currency,
    issue,
  );
  const rate = candidateNumeric(row.rate, issue);
  return {
    rowHash: liabilityHash({
      accountId: account,
      kind: row.kind,
      asOf: row.asOf,
      balance,
    }),
    sourceLocator: row.sourceLocator,
    semantic: [
      document.institutionId,
      account,
      row.kind,
      row.displayName,
      balance,
      row.currency,
      rate,
      row.asOf,
      row.collateralNote,
    ],
  };
}

function dedupeCandidateRows(
  table: HoldingProjectionTable,
  rows: readonly CandidateHoldingRow[],
): CandidateHoldingRow[] {
  const byHash = new Map<string, CandidateHoldingRow>();
  for (const row of rows) {
    const prior = byHash.get(row.rowHash);
    if (prior === undefined) {
      byHash.set(row.rowHash, row);
      continue;
    }
    if (canonical(prior.semantic) !== canonical(row.semantic)) {
      fail(`${table} candidate has one row hash for conflicting semantics`);
    }
    // This is the same behavior the importer applies to an exact duplicate:
    // the first occurrence owns the retained locator.
  }
  return [...byHash.values()];
}

function keepFirstBalancePerAccountDate(
  rows: readonly CandidateHoldingRow[],
  reject: () => void,
): CandidateHoldingRow[] {
  // Importer parity: exact row-hash duplicates collapse first. Among the
  // remaining distinct assertions, balances permit one row for an account
  // and date. A second different balance is a contradiction under review,
  // not a second publishable fact. The candidate describes the replacement
  // projection, so this key is scoped to its own rows rather than seeded
  // from the current projection it may eventually replace.
  const seen = new Set<string>();
  const accepted: CandidateHoldingRow[] = [];
  for (const row of rows) {
    const key = canonical([row.semantic[0], row.semantic[1]]);
    if (seen.has(key)) {
      reject();
      continue;
    }
    seen.add(key);
    accepted.push(row);
  }
  return accepted;
}

function mappingIssueCount(document: ImportDocument): number {
  // The importer records accepted same-institution matches as resolved audit
  // items. They are not unresolved mapping gaps. Unknown kinds stay blocking.
  return (document.reviewItems ?? []).filter(
    (item) => item.kind !== "institution_symbol_match",
  ).length;
}

function prepareCandidate(document: ImportDocument): CandidateBuild {
  let issueCount = mappingIssueCount(document);
  let rejectedRows = 0;
  const issue = () => {
    issueCount += 1;
  };
  const collect = <T>(
    rows: readonly T[] | undefined,
    prepare: (row: T) => CandidateHoldingRow | null,
  ): CandidateHoldingRow[] => {
    const prepared: CandidateHoldingRow[] = [];
    for (const row of rows ?? []) {
      const value = prepare(row);
      if (value === null) {
        rejectedRows += 1;
        continue;
      }
      prepared.push(value);
    }
    return prepared;
  };
  const preparedBalances = dedupeCandidateRows(
    "balances",
    collect(document.balances, (row) => prepareBalance(row, document, issue)),
  );
  const projection = {
    positions: dedupeCandidateRows(
      "positions",
      collect(document.positions, (row) =>
        preparePosition(row, document, issue),
      ),
    ),
    balances: keepFirstBalancePerAccountDate(preparedBalances, () => {
      rejectedRows += 1;
    }),
    liabilities: dedupeCandidateRows(
      "liabilities",
      collect(document.liabilities, (row) =>
        prepareLiability(row, document, issue),
      ),
    ),
  };
  return { issueCount, rejectedRows, projection };
}

function selectorKey(selector: HoldingPositionScopeSelector): string {
  return `${selector.accountId}\u0000${selector.asOf}\u0000${selector.proofVersion}`;
}

function completeScopeEvidence(scope: ImportPositionScope): boolean {
  return (
    scope.evidence.scopeEnd !== undefined &&
    (scope.emittedPositionCount === 0
      ? scope.evidence.explicitNone !== undefined
      : scope.evidence.tables.length > 0 &&
        scope.evidence.tables.every(
          (table) => table.headers.length > 0 && table.end !== undefined,
        ))
  );
}

/**
 * Prepares only explicitly selected positive position scopes. Parser gaps and
 * unsupported holdings in neighboring accounts remain visible on the source
 * document but cannot make this function infer a broader replacement.
 */
export function prepareHoldingPositionScopes(input: {
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly candidate: ImportDocument;
  readonly selectors: readonly HoldingPositionScopeSelector[];
}): readonly PreparedHoldingPositionScope[] {
  validateIdentity(input.documentId, input.retainedSha256);
  if (
    input.candidate.retainedSha256 !== input.retainedSha256 ||
    input.candidate.sha256 !== input.retainedSha256
  ) {
    fail("candidate is not bound to the selected retained bytes");
  }
  if (input.selectors.length === 0) fail("no position scopes were selected");

  const selected = new Map<string, HoldingPositionScopeSelector>();
  for (const selector of input.selectors) {
    if (
      selector === null ||
      typeof selector !== "object" ||
      canonical(Object.keys(selector).sort()) !==
        canonical(["accountId", "asOf", "proofVersion"]) ||
      typeof selector.accountId !== "string" ||
      selector.accountId.length === 0 ||
      !validDate(selector.asOf) ||
      selector.proofVersion !== "position_scope_v1"
    ) {
      fail("position scope selector is invalid");
    }
    const key = selectorKey(selector);
    if (selected.has(key)) fail("position scope selector is duplicated");
    selected.set(key, selector);
  }

  const declarations = new Map<string, ImportPositionScope>();
  for (const scope of input.candidate.positionScopes ?? []) {
    const key = selectorKey(scope);
    if (!selected.has(key)) continue;
    if (declarations.has(key)) {
      fail("selected position scope declaration is duplicated");
    }
    declarations.set(key, scope);
  }

  return [...selected.values()]
    .sort((left, right) => selectorKey(left).localeCompare(selectorKey(right)))
    .map((selector) => {
      const key = selectorKey(selector);
      const declaration = declarations.get(key);
      if (declaration === undefined) {
        fail("selected position scope was not declared by the adapter");
      }
      if (
        declaration.status !== "complete" ||
        declaration.gapCodes.length !== 0 ||
        !Number.isSafeInteger(declaration.emittedPositionCount) ||
        declaration.emittedPositionCount < 0 ||
        (declaration.emittedPositionCount === 0
          ? declaration.zeroBasis !== "source_stated_none"
          : declaration.zeroBasis !== undefined) ||
        !completeScopeEvidence(declaration)
      ) {
        fail("selected position scope is not positively complete");
      }

      let issueCount = 0;
      let rejectedRows = 0;
      const prepared: CandidateHoldingRow[] = [];
      for (const row of input.candidate.positions ?? []) {
        const account = row.accountId ?? input.candidate.accountId;
        if (account !== selector.accountId || row.asOf !== selector.asOf) {
          continue;
        }
        const value = preparePosition(row, input.candidate, () => {
          issueCount += 1;
        });
        if (value === null) rejectedRows += 1;
        else prepared.push(value);
      }
      const positions = dedupeCandidateRows("positions", prepared);
      if (
        issueCount !== 0 ||
        rejectedRows !== 0 ||
        positions.length !== declaration.emittedPositionCount ||
        new Set(positions.map((row) => row.rowHash)).size !== positions.length
      ) {
        fail(
          "selected position scope does not exactly match its mapped members",
        );
      }
      const scopeDigest = digest("kith-finance-position-scope-candidate:v1", {
        selector,
        emittedPositionCount: declaration.emittedPositionCount,
        zeroBasis: declaration.zeroBasis ?? null,
        evidence: declaration.evidence,
        positions: sortedRows(positions, (row) => [
          row.rowHash,
          row.sourceLocator,
          row.semantic,
        ]).map((row) => [row.rowHash, row.sourceLocator, row.semantic]),
      });
      return { selector, declaration, positions, scopeDigest };
    });
}

/**
 * Prepares the exact emitted membership of explicitly selected partial
 * position scopes. Unlike `prepareHoldingPositionScopes`, this function makes
 * no completeness claim: every selected declaration must remain partial and
 * retain at least one parser gap. Rows which cannot be represented in the
 * typed candidate still refuse the scope rather than being silently omitted.
 */
export function prepareHoldingPartialPositionScopes(input: {
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly candidate: ImportDocument;
  readonly selectors: readonly HoldingPositionScopeSelector[];
}): readonly PreparedHoldingPositionScope[] {
  validateIdentity(input.documentId, input.retainedSha256);
  if (
    input.candidate.retainedSha256 !== input.retainedSha256 ||
    input.candidate.sha256 !== input.retainedSha256
  ) {
    fail("candidate is not bound to the selected retained bytes");
  }
  if (input.selectors.length === 0) fail("no position scopes were selected");

  const selected = new Map<string, HoldingPositionScopeSelector>();
  for (const selector of input.selectors) {
    if (
      selector === null ||
      typeof selector !== "object" ||
      canonical(Object.keys(selector).sort()) !==
        canonical(["accountId", "asOf", "proofVersion"]) ||
      typeof selector.accountId !== "string" ||
      selector.accountId.length === 0 ||
      !validDate(selector.asOf) ||
      selector.proofVersion !== "position_scope_v1"
    ) {
      fail("position scope selector is invalid");
    }
    const key = selectorKey(selector);
    if (selected.has(key)) fail("position scope selector is duplicated");
    selected.set(key, selector);
  }

  const declarations = new Map<string, ImportPositionScope>();
  for (const scope of input.candidate.positionScopes ?? []) {
    const key = selectorKey(scope);
    if (!selected.has(key)) continue;
    if (declarations.has(key)) {
      fail("selected position scope declaration is duplicated");
    }
    declarations.set(key, scope);
  }

  return [...selected.values()]
    .sort((left, right) => selectorKey(left).localeCompare(selectorKey(right)))
    .map((selector) => {
      const declaration = declarations.get(selectorKey(selector));
      if (declaration === undefined) {
        fail("selected position scope was not declared by the adapter");
      }
      if (
        declaration.status !== "partial" ||
        declaration.gapCodes.length === 0 ||
        declaration.zeroBasis !== undefined ||
        !Number.isSafeInteger(declaration.emittedPositionCount) ||
        declaration.emittedPositionCount < 0
      ) {
        fail("selected position scope is not a truthful partial scope");
      }

      let rejectedRows = 0;
      const prepared: CandidateHoldingRow[] = [];
      for (const row of input.candidate.positions ?? []) {
        const account = row.accountId ?? input.candidate.accountId;
        if (account !== selector.accountId || row.asOf !== selector.asOf) {
          continue;
        }
        // Mapping gaps which retain a typed row remain part of a partial
        // source proof. A row that cannot be typed at all cannot be omitted
        // while retaining the declaration's emitted count.
        const value = preparePosition(row, input.candidate, () => undefined);
        if (value === null) rejectedRows += 1;
        else prepared.push(value);
      }
      const positions = dedupeCandidateRows("positions", prepared);
      if (
        rejectedRows !== 0 ||
        positions.length !== declaration.emittedPositionCount ||
        new Set(positions.map((row) => row.rowHash)).size !== positions.length
      ) {
        fail("selected partial position scope does not exactly match its mapped members");
      }
      const scopeDigest = digest(
        "kith-finance-partial-position-scope-candidate:v1",
        {
          selector,
          status: declaration.status,
          emittedPositionCount: declaration.emittedPositionCount,
          gapCodes: [...declaration.gapCodes].sort(),
          evidence: declaration.evidence,
          positions: sortedRows(positions, (row) => [
            row.rowHash,
            row.sourceLocator,
            row.semantic,
          ]).map((row) => [row.rowHash, row.sourceLocator, row.semantic]),
        },
      );
      return { selector, declaration, positions, scopeDigest };
    });
}

function balanceSelectorKey(selector: HoldingBalanceScopeSelector): string {
  return `${selector.accountId}\u0000${selector.asOf}\u0000${selector.proofVersion}`;
}

function completeBalanceScopeEvidence(scope: ImportBalanceScope): boolean {
  return (
    scope.evidence.account !== undefined &&
    scope.evidence.header !== undefined &&
    scope.evidence.asOf !== undefined &&
    scope.evidence.row !== undefined &&
    scope.evidence.scopeEnd !== undefined &&
    (scope.emittedBalanceCount === 0
      ? scope.evidence.explicitNone !== undefined
      : scope.evidence.totalValue !== undefined)
  );
}

/** Prepares only explicitly selected positive account/date balance scopes. */
export function prepareHoldingBalanceScopes(input: {
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly candidate: ImportDocument;
  readonly selectors: readonly HoldingBalanceScopeSelector[];
}): readonly PreparedHoldingBalanceScope[] {
  validateIdentity(input.documentId, input.retainedSha256);
  if (
    input.candidate.retainedSha256 !== input.retainedSha256 ||
    input.candidate.sha256 !== input.retainedSha256
  ) {
    fail("candidate is not bound to the selected retained bytes");
  }
  if (input.selectors.length === 0) fail("no balance scopes were selected");

  const selected = new Map<string, HoldingBalanceScopeSelector>();
  for (const selector of input.selectors) {
    if (
      selector === null ||
      typeof selector !== "object" ||
      canonical(Object.keys(selector).sort()) !==
        canonical(["accountId", "asOf", "proofVersion"]) ||
      typeof selector.accountId !== "string" ||
      selector.accountId.length === 0 ||
      !validDate(selector.asOf) ||
      selector.proofVersion !== "balance_scope_v1"
    ) {
      fail("balance scope selector is invalid");
    }
    const key = balanceSelectorKey(selector);
    if (selected.has(key)) fail("balance scope selector is duplicated");
    selected.set(key, selector);
  }

  const declarations = new Map<string, ImportBalanceScope>();
  for (const scope of input.candidate.balanceScopes ?? []) {
    const key = balanceSelectorKey(scope);
    if (!selected.has(key)) continue;
    if (declarations.has(key)) {
      fail("selected balance scope declaration is duplicated");
    }
    declarations.set(key, scope);
  }

  return [...selected.values()]
    .sort((left, right) =>
      balanceSelectorKey(left).localeCompare(balanceSelectorKey(right)),
    )
    .map((selector) => {
      const declaration = declarations.get(balanceSelectorKey(selector));
      if (declaration === undefined) {
        fail("selected balance scope was not declared by the adapter");
      }
      if (
        declaration.status !== "complete" ||
        declaration.gapCodes.length !== 0 ||
        (declaration.emittedBalanceCount !== 0 &&
          declaration.emittedBalanceCount !== 1) ||
        (declaration.emittedBalanceCount === 0
          ? declaration.zeroBasis !== "source_stated_none"
          : declaration.zeroBasis !== undefined) ||
        !completeBalanceScopeEvidence(declaration)
      ) {
        fail("selected balance scope is not positively complete");
      }

      let issueCount = 0;
      let rejectedRows = 0;
      const prepared: CandidateHoldingRow[] = [];
      for (const row of input.candidate.balances ?? []) {
        const account = row.accountId ?? input.candidate.accountId;
        if (account !== selector.accountId || row.asOf !== selector.asOf) {
          continue;
        }
        const value = prepareBalance(row, input.candidate, () => {
          issueCount += 1;
        });
        if (value === null) rejectedRows += 1;
        else prepared.push(value);
      }
      const balances = keepFirstBalancePerAccountDate(
        dedupeCandidateRows("balances", prepared),
        () => {
          rejectedRows += 1;
        },
      );
      if (
        issueCount !== 0 ||
        rejectedRows !== 0 ||
        balances.length !== declaration.emittedBalanceCount ||
        new Set(balances.map((row) => row.rowHash)).size !== balances.length
      ) {
        fail(
          "selected balance scope does not exactly match its mapped members",
        );
      }
      const scopeDigest = digest("kith-finance-balance-scope-candidate:v1", {
        selector,
        emittedBalanceCount: declaration.emittedBalanceCount,
        zeroBasis: declaration.zeroBasis ?? null,
        evidence: declaration.evidence,
        balances: sortedRows(balances, (row) => [
          row.rowHash,
          row.sourceLocator,
          row.semantic,
        ]).map((row) => [row.rowHash, row.sourceLocator, row.semantic]),
      });
      return { selector, declaration, balances, scopeDigest };
    });
}

function sortedRows<T>(rows: readonly T[], key: (row: T) => unknown): T[] {
  return [...rows].sort((left, right) => {
    const leftKey = canonical(key(left));
    const rightKey = canonical(key(right));
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function projectionDigest(
  domain: "old" | "candidate",
  projection: StoredHoldingProjection | CandidateHoldingProjection,
): string {
  const tables = TABLES.map((table) => [
    table,
    domain === "old"
      ? sortedRows((projection as StoredHoldingProjection)[table], (row) => [
          row.id,
          row.rowHash,
          row.sourceLocator,
          row.semantic,
        ]).map((row) => [row.id, row.rowHash, row.sourceLocator, row.semantic])
      : sortedRows((projection as CandidateHoldingProjection)[table], (row) => [
          row.rowHash,
          row.sourceLocator,
          row.semantic,
        ]).map((row) => [row.rowHash, row.sourceLocator, row.semantic]),
  ]);
  return digest(`kith-finance-holding-correction-${domain}:v1`, tables);
}

/** Digest of a materialized current mirror, including its stable record ids. */
export function holdingProjectionCurrentDigest(
  projection: StoredHoldingProjection,
): string {
  return projectionDigest("old", projection);
}

function removeSemanticMatches(
  oldRows: readonly StoredHoldingRow[],
  candidateRows: readonly CandidateHoldingRow[],
): {
  oldRemaining: StoredHoldingRow[];
  candidateRemaining: CandidateHoldingRow[];
  unchanged: number;
} {
  const oldBuckets = new Map<string, StoredHoldingRow[]>();
  for (const row of sortedRows(oldRows, (row) => [
    row.semantic,
    row.sourceLocator,
    row.rowHash,
    row.id,
  ])) {
    const key = canonical(row.semantic);
    const bucket = oldBuckets.get(key) ?? [];
    bucket.push(row);
    oldBuckets.set(key, bucket);
  }
  let unchanged = 0;
  const pendingCandidates: CandidateHoldingRow[] = [];
  // Preserve exact semantic+locator matches before matching equal semantics
  // across locations. Otherwise input order can steal a later exact match and
  // change the apparent locator ambiguity despite identical projections.
  for (const row of sortedRows(candidateRows, (row) => [
    row.semantic,
    row.sourceLocator,
    row.rowHash,
  ])) {
    const bucket = oldBuckets.get(canonical(row.semantic));
    const exactIndex =
      bucket?.findIndex((old) => old.sourceLocator === row.sourceLocator) ?? -1;
    if (exactIndex >= 0) {
      bucket!.splice(exactIndex, 1);
      unchanged += 1;
    } else pendingCandidates.push(row);
  }
  const candidateRemaining: CandidateHoldingRow[] = [];
  for (const row of pendingCandidates) {
    const bucket = oldBuckets.get(canonical(row.semantic));
    const matched = bucket?.pop();
    if (matched === undefined) candidateRemaining.push(row);
    else unchanged += 1;
  }
  return {
    unchanged,
    candidateRemaining,
    oldRemaining: [...oldBuckets.values()].flat(),
  };
}

function locatorMap<T extends { sourceLocator: string | null }>(
  rows: readonly T[],
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    if (row.sourceLocator === null || row.sourceLocator.length === 0) continue;
    const bucket = result.get(row.sourceLocator) ?? [];
    bucket.push(row);
    result.set(row.sourceLocator, bucket);
  }
  return result;
}

function delta(
  oldRows: readonly StoredHoldingRow[],
  candidateRows: readonly CandidateHoldingRow[],
): HoldingProjectionDelta {
  const { oldRemaining, candidateRemaining, unchanged } = removeSemanticMatches(
    oldRows,
    candidateRows,
  );
  const oldByLocator = locatorMap(oldRemaining);
  const candidateByLocator = locatorMap(candidateRemaining);
  let changed = 0;
  let ambiguousLocators = 0;
  for (const locator of new Set([
    ...oldByLocator.keys(),
    ...candidateByLocator.keys(),
  ])) {
    const oldCount = oldByLocator.get(locator)?.length ?? 0;
    const candidateCount = candidateByLocator.get(locator)?.length ?? 0;
    if (oldCount > 1 || candidateCount > 1) ambiguousLocators += 1;
    else if (oldCount === 1 && candidateCount === 1) changed += 1;
  }
  return {
    oldRows: oldRows.length,
    candidateRows: candidateRows.length,
    unchanged,
    changed,
    added: candidateRemaining.length - changed,
    removed: oldRemaining.length - changed,
    ambiguousLocators,
  };
}

function validateIdentity(documentId: string, retainedSha256: string): void {
  if (documentId.length === 0 || documentId.length > 512) {
    fail("document id is invalid");
  }
  if (!SHA256.test(retainedSha256)) {
    fail("retained sha256 is invalid");
  }
}

export function prepareHoldingCorrectionCandidate(input: {
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly stored: StoredHoldingProjection;
  readonly candidate: ImportDocument;
}): PreparedHoldingCorrectionCandidate {
  validateIdentity(input.documentId, input.retainedSha256);
  if (
    input.candidate.retainedSha256 !== input.retainedSha256 ||
    input.candidate.sha256 !== input.retainedSha256
  ) {
    fail("candidate is not bound to the selected retained bytes");
  }
  const built = prepareCandidate(input.candidate);
  const reasons = new Set<HoldingCorrectionCompletenessReason>([
    "adapter_has_no_holding_completeness_attestation",
  ]);
  if (input.candidate.parseNote) reasons.add("parse_gap");
  if (built.issueCount > 0) {
    reasons.add("adapter_mapping_review_required");
  }
  if (built.rejectedRows > 0) reasons.add("candidate_row_rejected");

  const tables = {
    positions: delta(input.stored.positions, built.projection.positions),
    balances: delta(input.stored.balances, built.projection.balances),
    liabilities: delta(input.stored.liabilities, built.projection.liabilities),
  } as const;
  const completeness = {
    state:
      input.candidate.parseNote ||
      built.issueCount > 0 ||
      built.rejectedRows > 0
        ? ("partial" as const)
        : ("unproven" as const),
    reasons: [...reasons].sort(),
    issueCount: built.issueCount + built.rejectedRows,
    removalsAuthorized: false as const,
  };
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: "holding_correction_candidate_v1" as const,
    documentId: input.documentId,
    retainedSha256: input.retainedSha256,
    oldProjectionDigest: projectionDigest("old", input.stored),
    candidateProjectionDigest: projectionDigest("candidate", built.projection),
    tables,
    completeness,
  };
  const manifest = {
    ...withoutDigest,
    candidateDigest: digest(
      "kith-finance-holding-correction-manifest:v1",
      withoutDigest,
    ),
  };
  return { manifest, projection: built.projection };
}

export function buildHoldingCorrectionCandidateManifest(input: {
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly stored: StoredHoldingProjection;
  readonly candidate: ImportDocument;
}): HoldingCorrectionCandidateManifest {
  return prepareHoldingCorrectionCandidate(input).manifest;
}

export async function readStoredHoldingProjection(
  client: ArchiveClient,
  documentId: string,
): Promise<StoredHoldingProjection> {
  // One ArchiveClient is one pg connection. Keep these sequential: node-pg
  // currently queues overlapping query calls but deprecates that behavior,
  // and a candidate must not depend on an implicit client-side queue.
  const positions = await client.query<StoredPositionRow>(
    `SELECT id, account_id, as_of::text AS as_of, instrument_id,
              quantity::text, price::text, market_value::text, cost_basis::text,
              unrealized::text, currency, valuation_basis, valuation_note,
              source_locator, row_hash
         FROM positions WHERE source_document_id = $1 ORDER BY id`,
    [documentId],
  );
  const balances = await client.query<StoredBalanceRow>(
    `SELECT id, account_id, as_of::text AS as_of, total_value::text, cash::text,
              currency, period_start_value::text, period_end_value::text,
              source_locator, row_hash
         FROM balances WHERE source_document_id = $1 ORDER BY id`,
    [documentId],
  );
  const liabilities = await client.query<StoredLiabilityRow>(
    `SELECT id, institution_id, account_id, kind, display_name, balance::text,
              currency, rate::text, as_of::text AS as_of, collateral_note,
              source_locator, row_hash
         FROM liabilities WHERE source_document_id = $1 ORDER BY id`,
    [documentId],
  );
  return {
    positions: positions.rows.map((row) => ({
      id: row.id,
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
    })),
    balances: balances.rows.map((row) => ({
      id: row.id,
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
    })),
    liabilities: liabilities.rows.map((row) => ({
      id: row.id,
      rowHash: row.row_hash,
      sourceLocator: row.source_locator,
      semantic: [
        row.institution_id,
        row.account_id,
        row.kind,
        row.display_name,
        normalizedNumeric(row.balance),
        row.currency,
        normalizedNumeric(row.rate),
        row.as_of,
        row.collateral_note,
      ],
    })),
  };
}

export async function assertCandidateHashesOwnedByDocument(
  client: ArchiveClient,
  documentId: string,
  candidate: ImportDocument,
): Promise<void> {
  const built = prepareCandidate(candidate);
  for (const table of TABLES) {
    const hashes = built.projection[table].map((row) => row.rowHash);
    if (hashes.length === 0) continue;
    const found = await client.query<{
      row_hash: string;
      source_document_id: string | null;
    }>(
      `SELECT row_hash, source_document_id FROM ${table}
        WHERE row_hash = ANY($1::text[])`,
      [hashes],
    );
    if (found.rows.some((row) => row.source_document_id !== documentId)) {
      fail(`${table} candidate row hash is owned by another document`);
    }
  }
}
