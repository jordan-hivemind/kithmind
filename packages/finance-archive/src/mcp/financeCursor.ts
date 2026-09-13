import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  type FinanceDatasetRevision,
  type FinancePrincipalId,
  type FinanceReadRequest,
  type FinanceSpaceId,
  FinanceContractError,
} from "@repo/finance-contract";

export const DEFAULT_FINANCE_CURSOR_TTL_MS = 15 * 60 * 1000;
export const MAX_FINANCE_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_FINANCE_CURSOR_SECRET_BYTES = 32;

export type FinanceCursorContext = {
  principalId: FinancePrincipalId;
  spaceId: FinanceSpaceId;
  cursorSigningSecret: string | Uint8Array;
  now?: () => number;
  ttlMs?: number;
};

export type FinanceCursorBinding = {
  operation: FinanceReadRequest["operation"];
  normalizedRequest: FinanceReadRequest;
  datasetRevision: FinanceDatasetRevision;
  selectedSnapshotAsOf?: string;
};

type CursorPayload = {
  v: 1;
  e: number;
  r: string;
  b: string;
  k: string[];
};

function invalid(): never {
  throw new FinanceContractError("invalid_request");
}

function secretBytes(value: string | Uint8Array): Uint8Array {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (bytes.byteLength < MIN_FINANCE_CURSOR_SECRET_BYTES) invalid();
  return bytes;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid();
    return String(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value !== "object") invalid();
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function requestWithoutContinuation(
  request: FinanceReadRequest,
): Record<string, unknown> {
  const {
    cursor: _cursor,
    expectedDatasetRevision: _revision,
    ...query
  } = request;
  return query;
}

function bindingDigest(
  context: FinanceCursorContext,
  binding: FinanceCursorBinding,
): string {
  if (
    binding.operation !== binding.normalizedRequest.operation ||
    context.spaceId !== binding.normalizedRequest.spaceId
  )
    invalid();
  return createHash("sha256")
    .update(
      canonicalJson({
        principalId: context.principalId,
        spaceId: context.spaceId,
        operation: binding.operation,
        request: requestWithoutContinuation(binding.normalizedRequest),
        ...(binding.selectedSnapshotAsOf === undefined
          ? {}
          : { selectedSnapshotAsOf: binding.selectedSnapshotAsOf }),
      }),
      "utf8",
    )
    .digest("base64url");
}

function signature(secret: Uint8Array, payload: string): string {
  return createHmac("sha256", secret)
    .update(payload, "ascii")
    .digest("base64url");
}

function checkedKey(value: readonly string[]): string[] {
  if (value.length < 1 || value.length > 8) invalid();
  let totalBytes = 0;
  const result = value.map((item) => {
    const byteLength =
      typeof item === "string"
        ? new TextEncoder().encode(item).byteLength
        : Number.POSITIVE_INFINITY;
    if (typeof item !== "string" || item.length > 256 || byteLength > 256)
      invalid();
    totalBytes += byteLength;
    return item;
  });
  if (totalBytes > 512) invalid();
  return result;
}

export function issueFinanceCursor(
  context: FinanceCursorContext,
  binding: FinanceCursorBinding,
  key: readonly string[],
): string {
  const secret = secretBytes(context.cursorSigningSecret);
  const now = (context.now ?? Date.now)();
  const ttlMs = context.ttlMs ?? DEFAULT_FINANCE_CURSOR_TTL_MS;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > MAX_FINANCE_CURSOR_TTL_MS
  )
    invalid();
  if (
    binding.normalizedRequest.expectedDatasetRevision !== undefined &&
    binding.normalizedRequest.expectedDatasetRevision !==
      binding.datasetRevision
  )
    throw new FinanceContractError("revision_changed");
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) invalid();
  const payload: CursorPayload = {
    v: 1,
    e: expiresAt,
    r: binding.datasetRevision,
    b: bindingDigest(context, binding),
    k: checkedKey(key),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${signature(secret, encoded)}`;
}

function parsePayload(encoded: string): CursorPayload {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(",") !== "b,e,k,r,v" ||
    input.v !== 1 ||
    !Number.isSafeInteger(input.e) ||
    typeof input.r !== "string" ||
    typeof input.b !== "string" ||
    !Array.isArray(input.k)
  )
    invalid();
  return {
    v: 1,
    e: input.e as number,
    r: input.r,
    b: input.b,
    k: checkedKey(input.k as string[]),
  };
}

export function verifyFinanceCursor(
  context: FinanceCursorContext,
  binding: FinanceCursorBinding,
  cursor: string,
): readonly string[] {
  const secret = secretBytes(context.cursorSigningSecret);
  const pieces = cursor.split(".");
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) invalid();
  const expectedSignature = Buffer.from(signature(secret, pieces[0]), "ascii");
  const actualSignature = Buffer.from(pieces[1], "ascii");
  if (
    expectedSignature.byteLength !== actualSignature.byteLength ||
    !timingSafeEqual(expectedSignature, actualSignature)
  )
    invalid();
  const payload = parsePayload(pieces[0]);
  const now = (context.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0 || payload.e <= now) invalid();
  if (payload.b !== bindingDigest(context, binding)) invalid();
  if (
    binding.normalizedRequest.expectedDatasetRevision !== undefined &&
    binding.normalizedRequest.expectedDatasetRevision !==
      binding.datasetRevision
  )
    throw new FinanceContractError("revision_changed");
  if (payload.r !== binding.datasetRevision)
    throw new FinanceContractError("revision_changed");
  return payload.k;
}
