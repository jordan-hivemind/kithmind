// TAX-PAYMENTS-1. A bounded manual record for tax payments and their
// settlement lifecycle. This is structured money, never a Thought. Manual
// actor/time provenance is sufficient; a retained receipt evidence span may
// be attached now or on a later status event.

import {
  type Principal,
  requireSpaceAccess,
} from "../identity/authorization.js";
import { exec, type IdentityCtx, row, rows } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId, newKithId } from "../ids.js";
import { resolveEntity, type EntitySelector } from "../memory/entities.js";
import {
  canonicalizeDecimal,
  compareDecimals,
  validateCurrencyCode,
} from "../records/values.js";
import { spacePredicate } from "../spaces.js";

export const TAX_AUTHORITIES = ["us_federal"] as const;
export type TaxAuthority = (typeof TAX_AUTHORITIES)[number];

export const TAX_PAYMENT_KINDS = ["estimated_income"] as const;
export type TaxPaymentKind = (typeof TAX_PAYMENT_KINDS)[number];

export const TAX_PAYMENT_STATUSES = [
  "submitted_processing",
  "settled",
  "rejected",
  "reversed",
] as const;
export type TaxPaymentStatus = (typeof TAX_PAYMENT_STATUSES)[number];

const PAYMENT_LIMIT = 500;
const STATUS_EVENT_LIMIT = 5_000;
const MONEY = /^\d{1,20}(?:\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDENTIFIER_MAX = 200;
const REASON_MAX = 500;

export type TaxPaymentEvidence = {
  evidenceSpanId: string;
  sourceItemId: string | null;
};

export type TaxPaymentStatusEvent = {
  id: string;
  status: TaxPaymentStatus;
  effectiveOn: string;
  correction: boolean;
  reason: string;
  evidence: TaxPaymentEvidence | null;
  actorUserId: string | null;
  createdAt: number;
};

export type TaxPayment = {
  id: string;
  spaceId: string;
  payer: { entityId: string; name: string };
  authority: TaxAuthority;
  paymentKind: TaxPaymentKind;
  taxYear: number;
  amount: string;
  currency: string;
  submittedOn: string;
  status: TaxPaymentStatus;
  statusEffectiveOn: string;
  settledOn: string | null;
  confirmationNumber: string | null;
  eftTrace: string | null;
  evidence: TaxPaymentEvidence | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  statusHistory: TaxPaymentStatusEvent[];
};

export type TaxPaymentStatusTotal = {
  currency: string;
  status: TaxPaymentStatus;
  count: number;
  amount: string;
};

export type TaxPaymentYear = {
  taxYear: number;
  payments: TaxPayment[];
  totals: TaxPaymentStatusTotal[];
};

type PaymentDbRow = {
  id: string;
  space_id: string;
  payer_entity_id: string;
  payer_name: string;
  authority: string;
  payment_kind: string;
  tax_year: number;
  amount: string;
  currency: string;
  submitted_on: Date | string;
  current_status: string;
  status_effective_on: Date | string;
  settled_on: Date | string | null;
  confirmation_number: string | null;
  eft_trace: string | null;
  evidence_span_id: string | null;
  evidence_source_item_id: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type StatusDbRow = {
  id: string;
  payment_id: string;
  status: string;
  effective_on: Date | string;
  is_correction: boolean;
  reason: string;
  evidence_span_id: string | null;
  evidence_source_item_id: string | null;
  actor_user_id: string | null;
  created_at: Date | string;
};

function typedError(code: string, message: string): never {
  throw new IdentityError(message, { code, message });
}

function paymentNotFound(): never {
  throw new IdentityError("Tax payment not found");
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    typedError("invalid_input", `${name} is not a known value`);
  }
  return value as T;
}

function calendarDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isoDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !DATE.test(value)) {
    typedError("invalid_input", `${name} must be an ISO date`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    !parsed.toISOString().startsWith(value)
  ) {
    typedError("invalid_input", `${name} must be an ISO date`);
  }
  return value;
}

function taxYear(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1900 ||
    (value as number) > 3000
  ) {
    typedError(
      "invalid_input",
      "Tax year must be an integer from 1900 to 3000",
    );
  }
  return value as number;
}

function amount(value: unknown): string {
  if (typeof value !== "string") {
    typedError(
      "invalid_input",
      "Amount must be a positive exact decimal string",
    );
  }
  let normalized: string;
  try {
    normalized = canonicalizeDecimal(value);
  } catch {
    typedError(
      "invalid_input",
      "Amount must be a positive exact decimal string",
    );
  }
  if (!MONEY.test(normalized) || compareDecimals(normalized, "0") <= 0) {
    typedError("invalid_input", "Amount must be greater than zero");
  }
  return normalized;
}

function identifier(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    typedError("invalid_input", `${name} is invalid`);
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    Array.from(trimmed).length > IDENTIFIER_MAX ||
    trimmed.includes("\0")
  ) {
    typedError("invalid_input", `${name} is invalid`);
  }
  return trimmed;
}

function reason(value: unknown): string {
  if (typeof value !== "string") {
    typedError("invalid_input", "Reason is required");
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    Array.from(trimmed).length > REASON_MAX ||
    trimmed.includes("\0")
  ) {
    typedError(
      "invalid_input",
      "Reason is required and must be at most 500 characters",
    );
  }
  return trimmed;
}

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function evidence(
  evidenceSpanId: string | null,
  sourceItemId: string | null,
): TaxPaymentEvidence | null {
  return evidenceSpanId === null ? null : { evidenceSpanId, sourceItemId };
}

function paymentFromRow(
  record: PaymentDbRow,
): Omit<TaxPayment, "statusHistory"> {
  return {
    id: record.id,
    spaceId: record.space_id,
    payer: {
      entityId: record.payer_entity_id,
      name: record.payer_name,
    },
    authority: record.authority as TaxAuthority,
    paymentKind: record.payment_kind as TaxPaymentKind,
    taxYear: record.tax_year,
    amount: record.amount,
    currency: record.currency,
    submittedOn: calendarDate(record.submitted_on)!,
    status: record.current_status as TaxPaymentStatus,
    statusEffectiveOn: calendarDate(record.status_effective_on)!,
    settledOn: calendarDate(record.settled_on),
    confirmationNumber: record.confirmation_number,
    eftTrace: record.eft_trace,
    evidence: evidence(record.evidence_span_id, record.evidence_source_item_id),
    createdBy: record.created_by,
    createdAt: epoch(record.created_at),
    updatedAt: epoch(record.updated_at),
  };
}

function statusFromRow(record: StatusDbRow): TaxPaymentStatusEvent {
  return {
    id: record.id,
    status: record.status as TaxPaymentStatus,
    effectiveOn: calendarDate(record.effective_on)!,
    correction: record.is_correction,
    reason: record.reason,
    evidence: evidence(record.evidence_span_id, record.evidence_source_item_id),
    actorUserId: record.actor_user_id,
    createdAt: epoch(record.created_at),
  };
}

async function checkedEvidence(
  ctx: IdentityCtx,
  spaceId: string,
  evidenceSpanId: string | null | undefined,
): Promise<string | null> {
  if (evidenceSpanId === undefined || evidenceSpanId === null) return null;
  const id = assertKithId(evidenceSpanId, "invalid_evidence_span_id");
  const found = await row<{ id: string }>(
    ctx,
    "SELECT id FROM kith.evidence_spans WHERE id = $1 AND space_id = $2",
    [id, spaceId],
  );
  if (!found) typedError("invalid_evidence", "Evidence span is unavailable");
  return id;
}

const PAYMENT_COLUMNS = `p.id, p.space_id, p.payer_entity_id,
  e.canonical_name AS payer_name, p.authority, p.payment_kind, p.tax_year,
  p.amount::text AS amount, p.currency, p.submitted_on, p.current_status,
  p.status_effective_on, p.settled_on, p.confirmation_number, p.eft_trace,
  p.evidence_span_id, sr.source_item_id AS evidence_source_item_id,
  p.created_by, p.created_at, p.updated_at`;

async function existingByIdentifiers(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    payerEntityId: string;
    authority: TaxAuthority;
    confirmationNumber: string | null;
    eftTrace: string | null;
  },
): Promise<PaymentDbRow[]> {
  return rows<PaymentDbRow>(
    ctx,
    `SELECT ${PAYMENT_COLUMNS}
       FROM kith.tax_payments p
       JOIN kith.entities e ON e.id = p.payer_entity_id AND e.space_id = p.space_id
       LEFT JOIN kith.evidence_spans es
         ON es.id = p.evidence_span_id AND es.space_id = p.space_id
       LEFT JOIN kith.source_revisions sr
         ON sr.id = es.source_revision_id AND sr.space_id = es.space_id
      WHERE p.space_id = $1 AND p.payer_entity_id = $2 AND p.authority = $3
        AND (($4::text IS NOT NULL AND lower(p.confirmation_number) = lower($4))
          OR ($5::text IS NOT NULL AND lower(p.eft_trace) = lower($5)))
      ORDER BY p.id FOR UPDATE OF p`,
    [
      input.spaceId,
      input.payerEntityId,
      input.authority,
      input.confirmationNumber,
      input.eftTrace,
    ],
  );
}

function identifierAgrees(
  stored: string | null,
  supplied: string | null,
): boolean {
  return (
    supplied === null ||
    stored === null ||
    stored.toLocaleLowerCase("en-US") === supplied.toLocaleLowerCase("en-US")
  );
}

function requireExactRetry(
  existing: PaymentDbRow,
  input: {
    paymentKind: TaxPaymentKind;
    taxYear: number;
    amount: string;
    currency: string;
    submittedOn: string;
    confirmationNumber: string | null;
    eftTrace: string | null;
  },
): void {
  if (
    existing.payment_kind !== input.paymentKind ||
    existing.tax_year !== input.taxYear ||
    existing.amount !== input.amount ||
    existing.currency !== input.currency ||
    calendarDate(existing.submitted_on) !== input.submittedOn ||
    !identifierAgrees(existing.confirmation_number, input.confirmationNumber) ||
    !identifierAgrees(existing.eft_trace, input.eftTrace)
  ) {
    typedError(
      "tax_payment_identifier_conflict",
      "A tax payment identifier already belongs to different payment details",
    );
  }
}

export async function createTaxPayment(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceId: string;
    payer: EntitySelector;
    authority: TaxAuthority;
    paymentKind: TaxPaymentKind;
    taxYear: number;
    amount: string;
    currency: string;
    submittedOn: string;
    confirmationNumber?: string | null;
    eftTrace?: string | null;
    evidenceSpanId?: string | null;
  },
): Promise<{ paymentId: string; created: boolean }> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  await requireSpaceAccess(ctx, args.principal, spaceId, "write");
  const payer = await resolveEntity(
    ctx,
    args.principal.userId,
    spaceId,
    args.payer,
  );
  const authority = oneOf(args.authority, TAX_AUTHORITIES, "Authority");
  const paymentKind = oneOf(
    args.paymentKind,
    TAX_PAYMENT_KINDS,
    "Payment kind",
  );
  const year = taxYear(args.taxYear);
  const exactAmount = amount(args.amount);
  const currency = validateCurrencyCode(args.currency);
  const submittedOn = isoDate(args.submittedOn, "Submitted date");
  const confirmationNumber = identifier(
    args.confirmationNumber,
    "Confirmation number",
  );
  const eftTrace = identifier(args.eftTrace, "EFT trace");
  if (confirmationNumber === null && eftTrace === null) {
    typedError(
      "tax_payment_identifier_required",
      "A confirmation number or EFT trace is required",
    );
  }
  const evidenceSpanId = await checkedEvidence(
    ctx,
    spaceId,
    args.evidenceSpanId,
  );

  const identity = {
    spaceId,
    payerEntityId: payer.id,
    authority,
    confirmationNumber,
    eftTrace,
  };
  let matches = await existingByIdentifiers(ctx, identity);
  if (matches.length > 1) {
    typedError(
      "tax_payment_identifier_conflict",
      "The confirmation number and EFT trace identify different tax payments",
    );
  }
  const retry = {
    paymentKind,
    taxYear: year,
    amount: exactAmount,
    currency,
    submittedOn,
    confirmationNumber,
    eftTrace,
  };
  if (matches[0]) {
    requireExactRetry(matches[0], retry);
    await exec(
      ctx,
      `UPDATE kith.tax_payments
          SET confirmation_number = coalesce(confirmation_number, $3),
              eft_trace = coalesce(eft_trace, $4),
              evidence_span_id = coalesce(evidence_span_id, $5),
              updated_at = CASE
                WHEN (confirmation_number IS NULL AND $3::text IS NOT NULL)
                  OR (eft_trace IS NULL AND $4::text IS NOT NULL)
                  OR (evidence_span_id IS NULL AND $5::text IS NOT NULL)
                THEN transaction_timestamp() ELSE updated_at END
        WHERE id = $1 AND space_id = $2`,
      [matches[0].id, spaceId, confirmationNumber, eftTrace, evidenceSpanId],
    );
    return { paymentId: matches[0].id, created: false };
  }

  const paymentId = newKithId();
  const inserted = await row<{ id: string }>(
    ctx,
    `INSERT INTO kith.tax_payments
       (id, space_id, payer_entity_id, authority, payment_kind, tax_year,
        amount, currency, submitted_on, current_status, status_effective_on,
        confirmation_number, eft_trace, evidence_span_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             'submitted_processing', $9, $10, $11, $12, $13)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      paymentId,
      spaceId,
      payer.id,
      authority,
      paymentKind,
      year,
      exactAmount,
      currency,
      submittedOn,
      confirmationNumber,
      eftTrace,
      evidenceSpanId,
      args.principal.userId,
    ],
  );
  if (!inserted) {
    matches = await existingByIdentifiers(ctx, identity);
    if (matches.length !== 1) {
      typedError(
        "tax_payment_identifier_conflict",
        "Tax payment identifiers conflict with an existing payment",
      );
    }
    requireExactRetry(matches[0]!, retry);
    return { paymentId: matches[0]!.id, created: false };
  }
  await exec(
    ctx,
    `INSERT INTO kith.tax_payment_status_events
       (id, space_id, payment_id, status, effective_on, is_correction,
        reason, evidence_span_id, actor_user_id)
     VALUES ($1, $2, $3, 'submitted_processing', $4, false,
             'manual_capture', $5, $6)`,
    [
      newKithId(),
      spaceId,
      paymentId,
      submittedOn,
      evidenceSpanId,
      args.principal.userId,
    ],
  );
  return { paymentId, created: true };
}

const NORMAL_TRANSITIONS: Readonly<
  Record<TaxPaymentStatus, readonly TaxPaymentStatus[]>
> = Object.freeze({
  submitted_processing: ["settled", "rejected"],
  settled: ["reversed"],
  rejected: [],
  reversed: [],
});

export async function setTaxPaymentStatus(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    paymentId: string;
    status: TaxPaymentStatus;
    effectiveOn: string;
    reason: string;
    correction?: boolean;
    evidenceSpanId?: string | null;
  },
): Promise<{ paymentId: string; updated: boolean }> {
  const paymentId = assertKithId(args.paymentId, "invalid_tax_payment_id");
  const current = await row<{
    space_id: string;
    current_status: string;
    status_effective_on: Date | string;
    settled_on: Date | string | null;
  }>(
    ctx,
    `SELECT space_id, current_status, status_effective_on, settled_on
       FROM kith.tax_payments WHERE id = $1 FOR UPDATE`,
    [paymentId],
  );
  if (!current) paymentNotFound();
  try {
    await requireSpaceAccess(ctx, args.principal, current.space_id, "write");
  } catch (error) {
    if (error instanceof IdentityError && error.message === "Space not found") {
      paymentNotFound();
    }
    throw error;
  }
  const status = oneOf(args.status, TAX_PAYMENT_STATUSES, "Status");
  const effectiveOn = isoDate(args.effectiveOn, "Status effective date");
  const why = reason(args.reason);
  if (args.correction !== undefined && typeof args.correction !== "boolean") {
    typedError("invalid_input", "Correction must be true or false");
  }
  const correction = args.correction === true;
  const oldStatus = current.current_status as TaxPaymentStatus;
  const oldEffectiveOn = calendarDate(current.status_effective_on)!;
  if (oldStatus === status && oldEffectiveOn === effectiveOn) {
    return { paymentId, updated: false };
  }
  if (!correction && !NORMAL_TRANSITIONS[oldStatus].includes(status)) {
    typedError(
      "invalid_tax_payment_transition",
      `Tax payment status cannot move from ${oldStatus} to ${status} without an explicit correction`,
    );
  }
  if (status === "reversed" && current.settled_on === null) {
    typedError(
      "invalid_tax_payment_transition",
      "A payment cannot be reversed before a settlement was recorded",
    );
  }
  const evidenceSpanId = await checkedEvidence(
    ctx,
    current.space_id,
    args.evidenceSpanId,
  );
  const settledOn =
    status === "settled" ? effectiveOn : calendarDate(current.settled_on);
  await exec(
    ctx,
    `UPDATE kith.tax_payments
        SET current_status = $3, status_effective_on = $4,
            settled_on = $5, updated_at = transaction_timestamp()
      WHERE id = $1 AND space_id = $2`,
    [paymentId, current.space_id, status, effectiveOn, settledOn],
  );
  await exec(
    ctx,
    `INSERT INTO kith.tax_payment_status_events
       (id, space_id, payment_id, status, effective_on, is_correction,
        reason, evidence_span_id, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      newKithId(),
      current.space_id,
      paymentId,
      status,
      effectiveOn,
      correction,
      why,
      evidenceSpanId,
      args.principal.userId,
    ],
  );
  return { paymentId, updated: true };
}

export async function listTaxPayments(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  requestedTaxYear: number,
): Promise<TaxPaymentYear> {
  const year = taxYear(requestedTaxYear);
  const predicate = spacePredicate(spaceIds, 1, "p.space_id");
  const payments = await rows<PaymentDbRow>(
    ctx,
    `SELECT ${PAYMENT_COLUMNS}
       FROM kith.tax_payments p
       JOIN kith.entities e ON e.id = p.payer_entity_id AND e.space_id = p.space_id
       LEFT JOIN kith.evidence_spans es
         ON es.id = p.evidence_span_id AND es.space_id = p.space_id
       LEFT JOIN kith.source_revisions sr
         ON sr.id = es.source_revision_id AND sr.space_id = es.space_id
      WHERE ${predicate.sql} AND p.tax_year = $2
      ORDER BY p.submitted_on, p.id
      LIMIT $3`,
    [predicate.value, year, PAYMENT_LIMIT + 1],
  );
  if (payments.length > PAYMENT_LIMIT) {
    typedError("tax_payment_limit", "Too many tax payments for one year");
  }
  const paymentIds = payments.map((payment) => payment.id);
  const statusRows =
    paymentIds.length === 0
      ? []
      : await rows<StatusDbRow>(
          ctx,
          `SELECT s.id, s.payment_id, s.status, s.effective_on,
                  s.is_correction, s.reason, s.evidence_span_id,
                  sr.source_item_id AS evidence_source_item_id,
                  s.actor_user_id, s.created_at
             FROM kith.tax_payment_status_events s
             LEFT JOIN kith.evidence_spans es
               ON es.id = s.evidence_span_id AND es.space_id = s.space_id
             LEFT JOIN kith.source_revisions sr
               ON sr.id = es.source_revision_id AND sr.space_id = es.space_id
            WHERE s.space_id = ANY($1::text[]) AND s.payment_id = ANY($2::text[])
            ORDER BY s.payment_id, s.created_at, s.id
            LIMIT $3`,
          [predicate.value, paymentIds, STATUS_EVENT_LIMIT + 1],
        );
  if (statusRows.length > STATUS_EVENT_LIMIT) {
    typedError("tax_payment_history_limit", "Tax payment history is too large");
  }
  const history = new Map<string, TaxPaymentStatusEvent[]>();
  for (const event of statusRows) {
    const values = history.get(event.payment_id) ?? [];
    values.push(statusFromRow(event));
    history.set(event.payment_id, values);
  }
  const totals = await rows<{
    currency: string;
    current_status: string;
    payment_count: string;
    amount: string;
  }>(
    ctx,
    `SELECT p.currency, p.current_status, count(*)::text AS payment_count,
            sum(p.amount)::text AS amount
       FROM kith.tax_payments p
      WHERE ${predicate.sql} AND p.tax_year = $2
      GROUP BY p.currency, p.current_status
      ORDER BY p.currency, p.current_status`,
    [predicate.value, year],
  );
  return {
    taxYear: year,
    payments: payments.map((payment) => ({
      ...paymentFromRow(payment),
      statusHistory: history.get(payment.id) ?? [],
    })),
    totals: totals.map((total) => ({
      currency: total.currency,
      status: total.current_status as TaxPaymentStatus,
      count: Number(total.payment_count),
      amount: total.amount,
    })),
  };
}
