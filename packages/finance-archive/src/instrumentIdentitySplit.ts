import { createHash, randomUUID } from "node:crypto";

import type { FieldLocator } from "./adapter.js";
import { compareDecimal, subtractDecimal } from "./decimal.js";
import type { ArchiveClient } from "./pgStore.js";
import { selectRetainedText } from "./retainedTexts.js";

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type InstrumentIdentitySplitEndpoint = {
  readonly role: "period_start" | "period_end";
  readonly documentId: string;
  readonly retainedSha256: string;
  readonly positionRowHash: string;
  readonly descriptor: FieldLocator;
};

export type InstrumentIdentitySplitSelection = {
  readonly schemaVersion: 1;
  readonly kind: "instrument_identity_split_selection_v1";
  readonly accountId: string;
  readonly periodEnd: string;
  readonly sourceInstrumentId: string;
  readonly targetInstrumentId: string;
  readonly endpoints: readonly InstrumentIdentitySplitEndpoint[];
};

export type InstrumentIdentitySplitManifest = {
  readonly schemaVersion: 1;
  readonly kind: "instrument_identity_split_candidate_v1";
  readonly accountId: string;
  readonly institutionId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly sourceInstrumentId: string;
  readonly targetInstrumentId: string;
  readonly descriptorSha256: string;
  readonly endpoints: readonly {
    readonly role: "period_start" | "period_end";
    readonly documentId: string;
    readonly retainedSha256: string;
    readonly positionRowHash: string;
    readonly activeGenerationId: string;
    readonly descriptorEvidenceDigest: string;
  }[];
  readonly matchingTransactions: number;
  readonly quantityTransactions: number;
  readonly nonquantityTransactions: number;
  readonly counterfactualReconciles: true;
  readonly candidateDigest: string;
};

export type InstrumentIdentitySplitApproval = {
  readonly schemaVersion: 1;
  readonly kind: "instrument_identity_split_approval_v1";
  readonly candidateDigest: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalDigest: string;
};

export type InstrumentIdentitySplitPublication = {
  readonly kind: "instrument_identity_split_binding_v1";
  readonly inserted: boolean;
  readonly candidateDigest: string;
  readonly approvalDigest: string;
};

type RetainedSpan = {
  readonly format: "retained_text_span_v1";
  readonly textSha256: string;
  readonly textByteLength: number;
  readonly textCodepointLength: number;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
};

function fail(message: string): never {
  throw new Error(`instrument identity split refused: ${message}`);
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${canonical(value)}`, "utf8")
    .digest("hex");
}

export function normalizeInstrumentDescriptor(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function instrumentDescriptorSha256(value: string): string {
  return digest(
    "kith-finance-instrument-descriptor:v1",
    normalizeInstrumentDescriptor(value),
  );
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function validateSelection(
  value: InstrumentIdentitySplitSelection,
): InstrumentIdentitySplitSelection {
  if (value === null || typeof value !== "object") fail("selection is not an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "accountId",
      "periodEnd",
      "sourceInstrumentId",
      "targetInstrumentId",
      "endpoints",
    ],
    "selection",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "instrument_identity_split_selection_v1"
  ) {
    fail("selection version or kind is unsupported");
  }
  for (const [label, one] of Object.entries({
    accountId: value.accountId,
    periodEnd: value.periodEnd,
    sourceInstrumentId: value.sourceInstrumentId,
    targetInstrumentId: value.targetInstrumentId,
  })) {
    if (typeof one !== "string" || one.length === 0) fail(`${label} is required`);
  }
  if (value.sourceInstrumentId === value.targetInstrumentId) {
    fail("source and target instruments are identical");
  }
  if (!Array.isArray(value.endpoints) || value.endpoints.length !== 2) {
    fail("selection needs exactly two endpoint proofs");
  }
  const roles = new Set(value.endpoints.map((one) => one.role));
  if (!roles.has("period_start") || !roles.has("period_end") || roles.size !== 2) {
    fail("endpoint proofs must cover period_start and period_end exactly once");
  }
  for (const endpoint of value.endpoints) {
    if (endpoint === null || typeof endpoint !== "object") fail("endpoint is invalid");
    exactKeys(
      endpoint,
      ["role", "documentId", "retainedSha256", "positionRowHash", "descriptor"],
      "endpoint",
    );
    if (
      (endpoint.role !== "period_start" && endpoint.role !== "period_end") ||
      typeof endpoint.documentId !== "string" ||
      endpoint.documentId.length === 0 ||
      !SHA256.test(endpoint.retainedSha256) ||
      !SHA256.test(endpoint.positionRowHash)
    ) {
      fail("endpoint identity is invalid");
    }
  }
  return value;
}

function retainedSpan(locator: FieldLocator): RetainedSpan {
  if (
    locator === null ||
    typeof locator !== "object" ||
    locator.source !== "pdf_statement" ||
    !Number.isInteger(locator.index) ||
    locator.index < 1 ||
    locator.binding?.format !== "retained_text_span_v1"
  ) {
    fail("descriptor proof must be a PDF retained-text span");
  }
  const binding = locator.binding;
  if (
    !SHA256.test(binding.textSha256) ||
    !Number.isInteger(binding.textByteLength) ||
    binding.textByteLength < 1 ||
    !Number.isInteger(binding.textCodepointLength) ||
    binding.textCodepointLength < 1 ||
    !Number.isInteger(binding.start) ||
    !Number.isInteger(binding.end) ||
    binding.start < 0 ||
    binding.end <= binding.start ||
    typeof binding.quote !== "string" ||
    binding.quote.length === 0 ||
    Array.from(binding.quote).length > 512
  ) {
    fail("descriptor retained-text span is malformed or unbounded");
  }
  return binding;
}

function rowPage(sourceLocator: string | null): { source: string; index: number } {
  if (sourceLocator === null) fail("position has no source locator");
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceLocator);
  } catch {
    fail("position source locator is not JSON");
  }
  const row = (parsed as { row?: unknown })?.row;
  if (
    row === null ||
    typeof row !== "object" ||
    typeof (row as { source?: unknown }).source !== "string" ||
    !Number.isInteger((row as { index?: unknown }).index)
  ) {
    fail("position row locator has no physical page");
  }
  return row as { source: string; index: number };
}

function codepointPage(text: string, start: number): number {
  return Array.from(text)
    .slice(0, start)
    .filter((one) => one === "\f").length + 1;
}

function normalizedOccurrences(pageText: string, descriptor: string): number {
  if (descriptor.length === 0) return 0;
  const page = normalizeInstrumentDescriptor(pageText);
  let count = 0;
  let offset = 0;
  for (;;) {
    const found = page.indexOf(descriptor, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + descriptor.length;
  }
}

async function validateDescriptorEvidence(
  client: ArchiveClient,
  locator: FieldLocator,
  sourceLocator: string | null,
  descriptor: string,
): Promise<string> {
  const binding = retainedSpan(locator);
  const row = rowPage(sourceLocator);
  if (row.source !== locator.source || row.index !== locator.index) {
    fail("descriptor proof is not on the stored position row page");
  }
  const bytes = await selectRetainedText(client, binding.textSha256);
  if (bytes === null) fail("descriptor retained text is unavailable");
  if (
    bytes.byteLength !== binding.textByteLength ||
    createHash("sha256").update(bytes).digest("hex") !== binding.textSha256
  ) {
    fail("descriptor retained text identity does not verify");
  }
  const text = bytes.toString("utf8");
  const points = Array.from(text);
  if (
    points.length !== binding.textCodepointLength ||
    binding.end > points.length ||
    points.slice(binding.start, binding.end).join("") !== binding.quote
  ) {
    fail("descriptor retained-text bounds or quote do not verify");
  }
  if (normalizeInstrumentDescriptor(binding.quote) !== descriptor) {
    fail("descriptor quote does not exactly match the name-only instrument");
  }
  if (codepointPage(text, binding.start) !== locator.index) {
    fail("descriptor span is not on its declared physical page");
  }
  const page = text.split("\f")[locator.index - 1];
  if (page === undefined || normalizedOccurrences(page, descriptor) !== 1) {
    fail("descriptor is not unique on the bound physical page");
  }
  return digest("kith-finance-instrument-descriptor-evidence:v1", locator);
}

type EndpointRow = {
  id: string;
  quantity: string | null;
  source_locator: string | null;
  retained_sha256: string;
  institution_id: string | null;
  active_generation_id: string | null;
  in_active_generation: boolean;
  in_complete_scope: boolean;
};

export async function prepareInstrumentIdentitySplit(
  client: ArchiveClient,
  rawSelection: InstrumentIdentitySplitSelection,
): Promise<InstrumentIdentitySplitManifest> {
  const selection = validateSelection(rawSelection);
  const verdict = await client.query<{
    institution_id: string;
    period_start: string;
    period_end: string;
    expected_change: string | null;
    source_symbol: string | null;
    source_cusip: string | null;
    source_isin: string | null;
    source_name: string | null;
  }>(
    `SELECT a.institution_id, r.period_start::text, r.period_end::text,
            r.expected_change::text, i.symbol AS source_symbol,
            i.cusip AS source_cusip, i.isin AS source_isin,
            i.name AS source_name
       FROM position_reconciliations r
       JOIN accounts a ON a.id = r.account_id
       JOIN instruments i ON i.id = r.instrument_id
      WHERE r.account_id = $1 AND r.instrument_id = $2
        AND r.period_end = $3::date AND r.status = 'fail'`,
    [selection.accountId, selection.sourceInstrumentId, selection.periodEnd],
  );
  if (verdict.rows.length !== 1) fail("selection does not name one failed window");
  const period = verdict.rows[0]!;
  if (
    period.source_symbol !== null ||
    period.source_cusip !== null ||
    period.source_isin !== null ||
    period.source_name === null
  ) {
    fail("source instrument is not name-only");
  }
  const descriptor = normalizeInstrumentDescriptor(period.source_name);
  if (descriptor.length === 0) fail("source instrument name is empty");

  const target = await client.query<{
    cusip: string | null;
    isin: string | null;
    source_count: string;
    same_institution_count: string;
  }>(
    `SELECT i.cusip, i.isin,
            count(s.institution_id)::text AS source_count,
            count(s.institution_id) FILTER (WHERE s.institution_id = $2)::text
              AS same_institution_count
       FROM instruments i
       LEFT JOIN instrument_identifier_sources s ON s.instrument_id = i.id
      WHERE i.id = $1
      GROUP BY i.id`,
    [selection.targetInstrumentId, period.institution_id],
  );
  const targetRow = target.rows[0];
  if (
    target.rows.length !== 1 ||
    (targetRow?.cusip === null && targetRow?.isin === null) ||
    targetRow?.source_count !== "1" ||
    targetRow.same_institution_count !== "1"
  ) {
    fail("target lacks one same-institution strong-identifier source");
  }

  const endpointManifests: InstrumentIdentitySplitManifest["endpoints"][number][] = [];
  const endpointQuantities = new Map<"period_start" | "period_end", string>();
  for (const endpoint of [...selection.endpoints].sort((a, b) =>
    a.role.localeCompare(b.role),
  )) {
    const endpointDate =
      endpoint.role === "period_start" ? period.period_start : period.period_end;
    const found = await client.query<EndpointRow>(
      `SELECT p.id, p.quantity::text, p.source_locator,
              d.retained_sha256, d.institution_id,
              d.active_holding_projection_generation_id AS active_generation_id,
              EXISTS (
                SELECT 1 FROM holding_projection_generation_memberships gm
                 WHERE gm.document_id = d.id
                   AND gm.generation_id = d.active_holding_projection_generation_id
                   AND gm.assertion_kind = 'position' AND gm.record_id = p.id
              ) AS in_active_generation,
              EXISTS (
                SELECT 1
                  FROM position_scope_observations so
                  JOIN position_scope_memberships sm
                    ON sm.source_document_id = so.source_document_id
                   AND sm.scope_id = so.id
                 WHERE so.source_document_id = d.id
                   AND so.holding_projection_generation_id =
                         d.active_holding_projection_generation_id
                   AND so.account_id = p.account_id AND so.as_of = p.as_of
                   AND so.status = 'complete' AND cardinality(so.gap_codes) = 0
                   AND sm.position_row_hash = p.row_hash
              ) AS in_complete_scope
         FROM positions p
         JOIN documents d ON d.id = p.source_document_id
        WHERE p.account_id = $1 AND p.instrument_id = $2
          AND p.as_of = $3::date AND p.source_document_id = $4
          AND p.row_hash = $5`,
      [
        selection.accountId,
        selection.sourceInstrumentId,
        endpointDate,
        endpoint.documentId,
        endpoint.positionRowHash,
      ],
    );
    if (found.rows.length !== 1) fail(`${endpoint.role} position proof is not exact`);
    const row = found.rows[0]!;
    if (
      row.retained_sha256 !== endpoint.retainedSha256 ||
      row.institution_id !== period.institution_id ||
      row.active_generation_id === null ||
      !row.in_active_generation ||
      !row.in_complete_scope ||
      row.quantity === null
    ) {
      fail(`${endpoint.role} is not an active complete source-owned position`);
    }
    const evidence = await validateDescriptorEvidence(
      client,
      endpoint.descriptor,
      row.source_locator,
      descriptor,
    );
    endpointQuantities.set(endpoint.role, row.quantity);
    endpointManifests.push({
      role: endpoint.role,
      documentId: endpoint.documentId,
      retainedSha256: endpoint.retainedSha256,
      positionRowHash: endpoint.positionRowHash,
      activeGenerationId: row.active_generation_id,
      descriptorEvidenceDigest: evidence,
    });
  }

  const expected = subtractDecimal(
    endpointQuantities.get("period_end")!,
    endpointQuantities.get("period_start")!,
  );
  if (period.expected_change === null || compareDecimal(expected, period.expected_change) !== 0) {
    fail("stored failed verdict does not match the proven endpoint quantities");
  }

  const matches = await client.query<{
    instrument_id: string | null;
    quantity_present: boolean;
  }>(
    `SELECT t.instrument_id, t.quantity IS NOT NULL AS quantity_present
       FROM transactions t
       LEFT JOIN instruments i ON i.id = t.instrument_id
      WHERE t.account_id = $1
        AND t.process_date > $2::date AND t.process_date <= $3::date
        AND t.instrument_id IS DISTINCT FROM $4
        AND (
          lower(regexp_replace(btrim(coalesce(i.name, '')), '[[:space:]]+', ' ', 'g')) = $5
          OR lower(regexp_replace(btrim(coalesce(t.description, '')), '[[:space:]]+', ' ', 'g')) = $5
        )`,
    [
      selection.accountId,
      period.period_start,
      period.period_end,
      selection.sourceInstrumentId,
      descriptor,
    ],
  );
  if (matches.rows.length === 0) fail("window has no exact descriptor activity candidate");
  if (matches.rows.some((row) => row.instrument_id !== selection.targetInstrumentId)) {
    fail("exact descriptor activity does not resolve to one target instrument");
  }
  const quantityTransactions = matches.rows.filter((row) => row.quantity_present).length;
  if (quantityTransactions === 0) fail("exact descriptor activity has no quantity movement");

  // The failed window proves the arithmetic. The all-history check proves
  // the exact descriptor has not also named another identifier-backed
  // security in this account. It is repeated when imports consume a binding,
  // so a later collision invalidates reuse instead of silently inheriting an
  // older approval.
  const allHistoryTargets = await client.query<{ instrument_id: string }>(
    `SELECT DISTINCT t.instrument_id
       FROM transactions t
       JOIN instruments i ON i.id = t.instrument_id
       JOIN instrument_identifier_sources s
         ON s.instrument_id = i.id AND s.institution_id = $2
      WHERE t.account_id = $1
        AND (i.cusip IS NOT NULL OR i.isin IS NOT NULL)
        AND (
          lower(regexp_replace(btrim(coalesce(i.name, '')), '[[:space:]]+', ' ', 'g')) = $3
          OR lower(regexp_replace(btrim(coalesce(t.description, '')), '[[:space:]]+', ' ', 'g')) = $3
        )`,
    [selection.accountId, period.institution_id, descriptor],
  );
  if (
    allHistoryTargets.rows.length !== 1 ||
    allHistoryTargets.rows[0]?.instrument_id !== selection.targetInstrumentId
  ) {
    fail("exact descriptor has a competing identifier-backed instrument");
  }

  const counterfactual = await client.query<{
    computed_change: string;
    target_endpoint_positions: string;
    earliest_activity: string | null;
  }>(
    `SELECT
       coalesce((SELECT sum(t.quantity)::text FROM transactions t
                  WHERE t.account_id = $1 AND t.instrument_id = $2
                    AND t.process_date > $3::date AND t.process_date <= $4::date
                    AND t.quantity IS NOT NULL), '0') AS computed_change,
       (SELECT count(*)::text FROM positions p
         WHERE p.account_id = $1 AND p.instrument_id = $2
           AND p.as_of IN ($3::date, $4::date)) AS target_endpoint_positions,
       (SELECT min(t.process_date)::text FROM transactions t
         WHERE t.account_id = $1) AS earliest_activity`,
    [
      selection.accountId,
      selection.targetInstrumentId,
      period.period_start,
      period.period_end,
    ],
  );
  const proof = counterfactual.rows[0]!;
  if (proof.target_endpoint_positions !== "0") {
    fail("target already has a position at a failed-window endpoint");
  }
  if (proof.earliest_activity === null || proof.earliest_activity > period.period_start) {
    fail("account activity coverage does not reach the failed-window start");
  }
  if (compareDecimal(proof.computed_change, expected) !== 0) {
    fail("target quantity activity does not exactly explain the stated change");
  }

  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: "instrument_identity_split_candidate_v1" as const,
    accountId: selection.accountId,
    institutionId: period.institution_id,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    sourceInstrumentId: selection.sourceInstrumentId,
    targetInstrumentId: selection.targetInstrumentId,
    descriptorSha256: instrumentDescriptorSha256(descriptor),
    endpoints: endpointManifests,
    matchingTransactions: matches.rows.length,
    quantityTransactions,
    nonquantityTransactions: matches.rows.length - quantityTransactions,
    counterfactualReconciles: true as const,
  };
  return {
    ...withoutDigest,
    candidateDigest: digest(
      "kith-finance-instrument-identity-split-candidate:v1",
      withoutDigest,
    ),
  };
}

export function instrumentIdentitySplitApprovalDigest(
  approval: Omit<InstrumentIdentitySplitApproval, "approvalDigest">,
): string {
  return digest("kith-finance-instrument-identity-split-approval:v1", approval);
}

function validateApproval(approval: InstrumentIdentitySplitApproval): void {
  if (approval === null || typeof approval !== "object") fail("approval is invalid");
  exactKeys(
    approval,
    ["schemaVersion", "kind", "candidateDigest", "approvedBy", "approvedAt", "approvalDigest"],
    "approval",
  );
  if (
    approval.schemaVersion !== 1 ||
    approval.kind !== "instrument_identity_split_approval_v1" ||
    !SHA256.test(approval.candidateDigest) ||
    !SHA256.test(approval.approvalDigest) ||
    typeof approval.approvedBy !== "string" ||
    approval.approvedBy.trim().length === 0 ||
    approval.approvedBy.length > 200 ||
    typeof approval.approvedAt !== "string" ||
    !ISO_INSTANT.test(approval.approvedAt) ||
    instrumentIdentitySplitApprovalDigest({
      schemaVersion: approval.schemaVersion,
      kind: approval.kind,
      candidateDigest: approval.candidateDigest,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
    }) !== approval.approvalDigest
  ) {
    fail("approval fields or digest are invalid");
  }
}

export async function approveInstrumentIdentitySplit(
  client: ArchiveClient,
  selection: InstrumentIdentitySplitSelection,
  approval: InstrumentIdentitySplitApproval,
): Promise<InstrumentIdentitySplitPublication> {
  validateApproval(approval);
  const candidate = await prepareInstrumentIdentitySplit(client, selection);
  if (candidate.candidateDigest !== approval.candidateDigest) {
    fail("approval does not bind the current candidate");
  }
  const start = candidate.endpoints.find((one) => one.role === "period_start")!;
  const end = candidate.endpoints.find((one) => one.role === "period_end")!;
  const existing = await client.query<{
    candidate_digest: string;
    approval_digest: string;
    matched_instrument_id: string;
  }>(
    `SELECT candidate_digest, approval_digest, matched_instrument_id
       FROM instrument_descriptor_bindings
      WHERE institution_id = $1 AND account_id = $2 AND descriptor_sha256 = $3`,
    [candidate.institutionId, candidate.accountId, candidate.descriptorSha256],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    if (
      row.candidate_digest !== candidate.candidateDigest ||
      row.approval_digest !== approval.approvalDigest ||
      row.matched_instrument_id !== candidate.targetInstrumentId
    ) {
      fail("an approved binding already exists for this exact descriptor");
    }
    return {
      kind: "instrument_identity_split_binding_v1",
      inserted: false,
      candidateDigest: candidate.candidateDigest,
      approvalDigest: approval.approvalDigest,
    };
  }
  await client.query(
    `INSERT INTO instrument_descriptor_bindings
       (id, institution_id, account_id, descriptor_sha256,
        source_instrument_id, matched_instrument_id,
        period_start, period_end,
        start_document_id, end_document_id,
        start_generation_id, end_generation_id,
        candidate_digest, approval_digest, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date,
             $9, $10, $11, $12, $13, $14, $15, $16::timestamptz)`,
    [
      randomUUID(),
      candidate.institutionId,
      candidate.accountId,
      candidate.descriptorSha256,
      candidate.sourceInstrumentId,
      candidate.targetInstrumentId,
      candidate.periodStart,
      candidate.periodEnd,
      start.documentId,
      end.documentId,
      start.activeGenerationId,
      end.activeGenerationId,
      candidate.candidateDigest,
      approval.approvalDigest,
      approval.approvedBy.trim(),
      approval.approvedAt,
    ],
  );
  return {
    kind: "instrument_identity_split_binding_v1",
    inserted: true,
    candidateDigest: candidate.candidateDigest,
    approvalDigest: approval.approvalDigest,
  };
}
