import type { Pool, PoolClient } from "pg";

import type { DocumentFieldValueType } from "../admin/model.js";
import { TerminalDeferredWorkError, type DeferredWorkRow } from "../deferred/core.js";
import { sha256 } from "../hash.js";
import { KITH_ID, newKithId } from "../ids.js";
import { withKithTransaction } from "../schema.js";
import type {
  TargetedTaxBatchManifest,
  TargetedTaxOutcome,
  TargetedTaxRow,
} from "../workers/targetedTax.js";
import { FEDERAL_INDIVIDUAL_RETURN } from "./taxCatalog.js";
import { candidatesFor, checkValue } from "./gate.js";
import { citedLines, numberedPage, pageLines } from "./lines.js";
import type { ExtractionModel, ExtractionRequest, ModelReading } from "./provider.js";

type ValueType = Extract<DocumentFieldValueType, "text" | "date" | "number" | "money">;

const K1_FIELDS: Readonly<Record<string, ValueType>> = {
  tax_year: "number",
  form_family: "text",
  partnership_name: "text",
  partnership_ein: "text",
  recipient_name: "text",
  recipient_tax_id_suffix: "text",
  amended_return: "text",
  final_return: "text",
  publicly_traded_partnership: "text",
  partner_type: "text",
  domestic_or_foreign: "text",
  schedule_k3_attached: "text",
  profit_share_beginning: "number",
  profit_share_ending: "number",
  loss_share_beginning: "number",
  loss_share_ending: "number",
  capital_share_beginning: "number",
  capital_share_ending: "number",
  nonrecourse_liabilities_beginning: "money",
  nonrecourse_liabilities_ending: "money",
  qualified_nonrecourse_liabilities_beginning: "money",
  qualified_nonrecourse_liabilities_ending: "money",
  recourse_liabilities_beginning: "money",
  recourse_liabilities_ending: "money",
  capital_account_beginning: "money",
  capital_contributed: "money",
  current_year_net_income: "money",
  other_increase_decrease: "money",
  withdrawals_distributions: "money",
  capital_account_ending: "money",
  box_1_ordinary_business_income: "money",
  box_2_rental_real_estate_income: "money",
  box_3_other_rental_income: "money",
  box_4a_guaranteed_services: "money",
  box_4b_guaranteed_capital: "money",
  box_4c_total_guaranteed_payments: "money",
  box_5_interest_income: "money",
  box_6a_ordinary_dividends: "money",
  box_6b_qualified_dividends: "money",
  box_7_royalties: "money",
  box_8_short_term_capital_gain: "money",
  box_9a_long_term_capital_gain: "money",
  box_9b_collectibles_gain: "money",
  box_9c_unrecaptured_1250_gain: "money",
  box_10_net_section_1231_gain: "money",
  box_11_coded_items: "text",
  box_12_section_179_deduction: "money",
  box_13_coded_deductions: "text",
  box_14_self_employment: "text",
  box_15_credits: "text",
  box_17_amt_items: "text",
  box_18_tax_exempt_income: "text",
  box_19_distributions: "text",
  box_20_other_information: "text",
};

const FORM_1040_FIELDS: Readonly<Record<string, ValueType>> = Object.fromEntries(
  FEDERAL_INDIVIDUAL_RETURN.fields.map((field) => [field.name, field.valueType]),
) as Record<string, ValueType>;

export const TARGETED_TAX_FIELD_CATALOG = {
  form_1040_totals_v1: FORM_1040_FIELDS,
  schedule_k1_key_fields_v1: K1_FIELDS,
} as const;

export const TARGETED_TAX_DEFAULT_REQUIRED = {
  form_1040_totals_v1: [
    "tax_year",
    "return_version",
    "filing_status",
    "total_income",
    "agi",
    "taxable_income",
    "total_tax",
    "total_payments",
  ],
  schedule_k1_key_fields_v1: [
    "tax_year",
    "form_family",
    "partnership_name",
    "partnership_ein",
    "recipient_name",
    "recipient_tax_id_suffix",
  ],
} as const;

export function targetedTaxFieldsAgree(
  goalKind: keyof typeof TARGETED_TAX_FIELD_CATALOG,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = TARGETED_TAX_FIELD_CATALOG[goalKind];
  const fields = [...required, ...optional];
  if (!fields.every((field) => field in allowed)) return false;
  return goalKind !== "schedule_k1_key_fields_v1" || fields.some(isK1KeyFigureField);
}

const K1_IDENTITY_FIELDS = new Set([
  "tax_year",
  "form_family",
  "partnership_name",
  "partnership_ein",
  "recipient_name",
  "recipient_tax_id_suffix",
  "amended_return",
  "final_return",
  "publicly_traded_partnership",
  "partner_type",
  "domestic_or_foreign",
  "schedule_k3_attached",
]);

function isK1KeyFigureField(field: string): boolean {
  return field in K1_FIELDS && !K1_IDENTITY_FIELDS.has(field);
}

export function detectTargetedTaxFormFamily(
  goalKind: keyof typeof TARGETED_TAX_FIELD_CATALOG,
  pages: readonly { text: string }[],
): "form_1040" | "schedule_k1_1065" | "schedule_k1_1041" | "schedule_k1_1120s" | "unknown" {
  const text = pages.map((page) => page.text.slice(0, 4_000)).join("\n");
  if (goalKind === "form_1040_totals_v1") {
    return /\bform\s+1040(?!\s*-\s*x)\b|u\.?s\.?\s+individual\s+income\s+tax\s+return/iu.test(text)
      ? "form_1040"
      : "unknown";
  }
  if (/\bschedule\s+k-?1\s*\(\s*form\s+1065\s*\)/iu.test(text)) return "schedule_k1_1065";
  if (/\bschedule\s+k-?1\s*\(\s*form\s+1041\s*\)/iu.test(text)) return "schedule_k1_1041";
  if (/\bschedule\s+k-?1\s*\(\s*form\s+1120\s*-?\s*s\s*\)/iu.test(text)) return "schedule_k1_1120s";
  return "unknown";
}

type Loaded = {
  target: TargetedTaxRow;
  batch: TargetedTaxBatchManifest & {
    sourceTextVersionId: string;
    coverage: NonNullable<TargetedTaxBatchManifest["coverage"]>;
  };
  pages: Array<{
    sourcePageId: string;
    originalPage: number;
    text: string;
    textHash: string;
  }>;
};

function targetRow(raw: Record<string, unknown>): TargetedTaxRow {
  return {
    id: String(raw.id),
    spaceId: String(raw.space_id),
    sourceAccountId: String(raw.source_account_id),
    sourceItemId: String(raw.source_item_id),
    sourceRevisionId: String(raw.source_revision_id),
    goalKind: raw.goal_kind as TargetedTaxRow["goalKind"],
    goalVersion: Number(raw.goal_version),
    instanceKey: String(raw.instance_key),
    requestDigest: String(raw.request_digest),
    sourcePageCount: Number(raw.source_page_count),
    requiredFields: raw.required_fields as string[],
    optionalFields: raw.optional_fields as string[],
    status: raw.status as TargetedTaxRow["status"],
    batches: raw.batches as TargetedTaxBatchManifest[],
    outcomes: raw.outcomes as TargetedTaxOutcome[],
    unresolvedCodes: raw.unresolved_codes as string[],
    model: (raw.model ?? null) as string | null,
  };
}

async function load(
  client: PoolClient,
  spaceId: string,
  targetId: string,
  batchOrdinal: number,
): Promise<Loaded | null> {
  const raw = (
    await client.query<Record<string, unknown>>(
      `SELECT * FROM kith.document_targeted_extractions
        WHERE id=$1 AND space_id=$2 LIMIT 1`,
      [targetId, spaceId],
    )
  ).rows[0];
  if (!raw) return null;
  const target = targetRow(raw);
  const batch = target.batches.find((candidate) => candidate.ordinal === batchOrdinal);
  if (
    !batch ||
    batch.sourceTextVersionId === null ||
    batch.coverage === null ||
    batch.state !== "pending" ||
    target.status === "conflict"
  ) return null;
  const current = (
    await client.query<{ desired_revision_id: string | null; lifecycle: string }>(
      `SELECT desired_revision_id, lifecycle FROM kith.source_items
        WHERE id=$1 AND space_id=$2 AND source_account_id=$3 LIMIT 1`,
      [target.sourceItemId, spaceId, target.sourceAccountId],
    )
  ).rows[0];
  if (
    !current ||
    current.lifecycle !== "available" ||
    current.desired_revision_id !== target.sourceRevisionId
  ) return null;
  const pageRows = (
    await client.query<Record<string, unknown>>(
      `SELECT id, ordinal, text, text_hash FROM kith.source_pages
        WHERE source_text_version_id=$1 AND space_id=$2
        ORDER BY ordinal, id LIMIT 13`,
      [batch.sourceTextVersionId, spaceId],
    )
  ).rows;
  if (pageRows.length !== batch.pages.length || pageRows.length > 12) {
    throw new TerminalDeferredWorkError("targeted_tax_batch_invalid");
  }
  const pages = pageRows.map((page) => ({
    sourcePageId: String(page.id),
    originalPage: 0,
    text: String(page.text),
    textHash: String(page.text_hash),
  }));
  for (const [index, page] of pages.entries()) {
    const manifest = batch.pages[index];
    if (
      !manifest ||
      Number(pageRows[index]!.ordinal) !== index ||
      page.sourcePageId !== manifest.sourcePageId ||
      page.textHash !== manifest.textHash ||
      sha256(page.text) !== page.textHash
    ) throw new TerminalDeferredWorkError("targeted_tax_batch_invalid");
    page.originalPage = manifest.originalPage;
  }
  return {
    target,
    batch: {
      ...batch,
      sourceTextVersionId: batch.sourceTextVersionId,
      coverage: batch.coverage,
    },
    pages,
  };
}

function requestFor(loaded: Loaded): ExtractionRequest {
  const fields = [...loaded.target.requiredFields, ...loaded.target.optionalFields];
  const kind = loaded.target.goalKind === "form_1040_totals_v1"
    ? "tax_return_1040"
    : "schedule_k1_1065";
  const body = loaded.pages.map((page) =>
    `=== original page ${page.originalPage} ===\n${numberedPage(pageLines(page.text))}`
  ).join("\n\n");
  return {
    kinds: [kind],
    fields,
    prompt: `Read only the selected original PDF pages below for the ${loaded.target.goalKind} goal. Do not infer, calculate, or turn a blank into zero. Return only requested fields visibly stated on these pages. Cite one to three exact line numbers. The page value is the original PDF page number shown in the heading.\n\n${body}`,
  };
}

async function storeReading(
  client: PoolClient,
  loaded: Loaded,
  reading: ModelReading,
  modelName: string,
  preconditionCode?: string,
): Promise<void> {
  const targetRaw = (
    await client.query<Record<string, unknown>>(
      `SELECT * FROM kith.document_targeted_extractions
        WHERE id=$1 AND space_id=$2 FOR UPDATE`,
      [loaded.target.id, loaded.target.spaceId],
    )
  ).rows[0];
  if (!targetRaw) return;
  const target = targetRow(targetRaw);
  const current = (
    await client.query<{ desired_revision_id: string | null; lifecycle: string }>(
      `SELECT desired_revision_id, lifecycle FROM kith.source_items
        WHERE id=$1 AND space_id=$2 AND source_account_id=$3
        FOR UPDATE`,
      [target.sourceItemId, target.spaceId, target.sourceAccountId],
    )
  ).rows[0];
  if (
    !current ||
    current.lifecycle !== "available" ||
    current.desired_revision_id !== target.sourceRevisionId
  ) return;
  const batchIndex = target.batches.findIndex((batch) => batch.ordinal === loaded.batch.ordinal);
  if (
    batchIndex < 0 ||
    target.batches[batchIndex]!.state === "extracted" ||
    target.status === "conflict"
  ) return;
  const currentBatch = target.batches[batchIndex]!;
  if (
    target.sourceRevisionId !== loaded.target.sourceRevisionId ||
    currentBatch.requestDigest !== loaded.batch.requestDigest ||
    JSON.stringify(currentBatch.artifact) !== JSON.stringify(loaded.batch.artifact) ||
    JSON.stringify(currentBatch.requestedPages) !== JSON.stringify(loaded.batch.requestedPages) ||
    JSON.stringify(currentBatch.pages) !== JSON.stringify(loaded.batch.pages) ||
    JSON.stringify(currentBatch.coverage) !== JSON.stringify(loaded.batch.coverage)
  ) throw new TerminalDeferredWorkError("targeted_tax_batch_changed");

  const allowed = TARGETED_TAX_FIELD_CATALOG[target.goalKind];
  const requested = new Set([...target.requiredFields, ...target.optionalFields]);
  const outcomes = structuredClone(target.outcomes);
  for (const statement of preconditionCode ? [] : reading.statements.slice(0, 128)) {
    if (!requested.has(statement.field) || !(statement.field in allowed)) continue;
    const page = loaded.pages.find((candidate) => candidate.originalPage === statement.page);
    if (!page) continue;
    const lines = citedLines(pageLines(page.text), statement.lines);
    if (!lines) continue;
    const valueType = allowed[statement.field]!;
    const candidates = candidatesFor(lines, valueType);
    const gated = checkValue({
      valueType,
      value: statement.value,
      candidates,
      pageText: page.text,
      defaultCurrency: "USD",
    });
    if (!gated.ok || gated.values.length !== 1 || gated.support.length !== 1) continue;
    const value = gated.values[0]!;
    const range = candidates[gated.support[0]!]!;
    const existing = outcomes.find((outcome) => outcome.field === statement.field);
    const quote = page.text.slice(range.start, range.end);
    let evidenceSpanId = (
      await client.query<{ id: string }>(
        `SELECT id FROM kith.evidence_spans
          WHERE source_page_id=$1 AND start=$2 AND "end"=$3 LIMIT 1`,
        [page.sourcePageId, range.start, range.end],
      )
    ).rows[0]?.id;
    if (!evidenceSpanId) {
      evidenceSpanId = newKithId();
      const ordinal = Number((
        await client.query<{ ordinal: string }>(
          `SELECT COALESCE(max(ordinal),-1)+1 AS ordinal
             FROM kith.evidence_spans WHERE source_page_id=$1`,
          [page.sourcePageId],
        )
      ).rows[0]?.ordinal ?? 0);
      await client.query(
        `INSERT INTO kith.evidence_spans
           (id, space_id, created_at, source_revision_id, source_text_version_id,
            source_page_id, ordinal, start, "end", quote_hash, locator,
            card_extraction_fingerprints)
         VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'[]'::jsonb)`,
        [
          evidenceSpanId,
          target.spaceId,
          target.sourceRevisionId,
          loaded.batch.sourceTextVersionId,
          page.sourcePageId,
          ordinal,
          range.start,
          range.end,
          sha256(quote),
          JSON.stringify({
            kind: "targeted_tax_v1",
            goalKind: target.goalKind,
            originalPage: page.originalPage,
            batchOrdinal: loaded.batch.ordinal,
          }),
        ],
      );
    }
    const citation = {
      sourceTextVersionId: loaded.batch.sourceTextVersionId,
      sourcePageId: page.sourcePageId,
      originalPage: page.originalPage,
      evidenceSpanId,
    };
    if (existing) {
      let prior = existing.readings.find((candidate) =>
        JSON.stringify(candidate.value) === JSON.stringify(value)
      );
      if (!prior) {
        prior = {
          value,
          ...(gated.currencyAssumed ? { currencyAssumed: true as const } : {}),
          citations: [],
        };
        existing.readings.push(prior);
        existing.status = "conflict";
      }
      if (!prior.citations.some((item) => item.evidenceSpanId === evidenceSpanId)) {
        prior.citations.push(citation);
      }
    } else {
      outcomes.push({
        field: statement.field,
        status: "cited",
        valueType,
        readings: [{
          value,
          ...(gated.currencyAssumed ? { currencyAssumed: true as const } : {}),
          citations: [citation],
        }],
      });
    }
  }
  const batches = structuredClone(target.batches);
  batches[batchIndex] = { ...batches[batchIndex]!, state: "extracted" };
  const cited = new Set(
    outcomes.filter((outcome) => outcome.status === "cited").map((outcome) => outcome.field),
  );
  const unresolvedFields = target.requiredFields.filter((field) => !cited.has(field));
  const conflict = outcomes.some((outcome) => outcome.status === "conflict");
  const identityFields = target.goalKind === "form_1040_totals_v1"
    ? ["tax_year", "return_version"]
    : ["tax_year", "form_family"];
  const coverageClosed =
    loaded.batch.coverage.requestedRegionsClosed &&
    loaded.batch.coverage.continuationsClosed &&
    identityFields.every((field) => cited.has(field));
  const status = conflict
    ? "conflict"
    : unresolvedFields.length === 0 && coverageClosed && preconditionCode === undefined
      ? "complete"
      : "incomplete_resumable";
  const unresolvedCodes = conflict
    ? ["field_value_conflict"]
    : [
        ...(preconditionCode ? [preconditionCode] : []),
        ...unresolvedFields.map((field) => `missing_required:${field}`),
        ...(!loaded.batch.coverage.requestedRegionsClosed ? ["requested_regions_open"] : []),
        ...(!loaded.batch.coverage.continuationsClosed ? ["continuations_open"] : []),
        ...identityFields.filter((field) => !cited.has(field)).map((field) => `missing_identity:${field}`),
      ];
  await client.query(
    `UPDATE kith.document_targeted_extractions
        SET batches=$2::jsonb, outcomes=$3::jsonb, unresolved_codes=$4::jsonb,
            status=$5, model=$6, updated_at=transaction_timestamp(),
            completed_at=CASE WHEN $5='complete' THEN transaction_timestamp() ELSE NULL END
      WHERE id=$1`,
    [
      target.id,
      JSON.stringify(batches),
      JSON.stringify(outcomes),
      JSON.stringify(unresolvedCodes),
      status,
      modelName,
    ],
  );
}

export async function runTargetedTaxExtractionJob(
  pool: Pool,
  payload: Record<string, unknown>,
  job: DeferredWorkRow,
  model: ExtractionModel,
  now = Date.now(),
): Promise<void> {
  const { spaceId, targetId, batchOrdinal } = payload;
  if (
    typeof spaceId !== "string" || !KITH_ID.test(spaceId) ||
    typeof targetId !== "string" || !KITH_ID.test(targetId) ||
    typeof batchOrdinal !== "number" || !Number.isInteger(batchOrdinal) || batchOrdinal < 0 ||
    (job.spaceId !== null && job.spaceId !== spaceId)
  ) throw new TerminalDeferredWorkError("targeted_tax_payload_invalid");
  const loaded = await withKithTransaction(pool, (client) =>
    load(client, spaceId, targetId, batchOrdinal)
  );
  if (!loaded) return;
  if (!targetedTaxFieldsAgree(loaded.target.goalKind, loaded.target.requiredFields, loaded.target.optionalFields)) {
    throw new TerminalDeferredWorkError("targeted_tax_fields_invalid");
  }
  const supportedFamily = loaded.target.goalKind === "form_1040_totals_v1"
    ? "form_1040"
    : "schedule_k1_1065";
  if (loaded.batch.coverage.formFamily !== supportedFamily) {
    await withKithTransaction(pool, (client) =>
      storeReading(
        client,
        loaded,
        { kind: "unsupported", summary: "", statements: [], unnamed: 0 },
        model.name,
        `unsupported_form_family:${loaded.batch.coverage.formFamily}`,
      ),
    );
    return;
  }
  const reading = await model.read(requestFor(loaded));
  const expectedKind = loaded.target.goalKind === "form_1040_totals_v1"
    ? "tax_return_1040"
    : "schedule_k1_1065";
  await withKithTransaction(pool, (client) =>
    storeReading(
      client,
      loaded,
      reading,
      model.name,
      reading.kind === expectedKind ? undefined : "model_kind_mismatch",
    ),
  );
  void now;
}
