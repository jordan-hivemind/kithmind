// The inline lane's admission input: what a caller may send, what the server
// refuses, where the text lands and which credential is allowed to put it there.
//
// Ported from `models/ingestion/inlineInput.ts`, whose validation half is pure
// and moves across unchanged, and whose two database halves --
// `resolveIngestSourceAccount` and `consumeIngestAdmissionRateLimit` -- become
// SQL over `kith.spaces`/`kith.source_accounts` and `kith.ingest_rate_limits`.
//
// The error messages are the Convex messages, character for character, and that
// is a contract rather than a habit: `errors.ts` in this directory classifies an
// admission failure into the `/api/ingest` status codes the bounded text capture
// contract publishes by matching exactly these strings, the same way
// `models/ingestion/inlineErrors.ts` did. Changing one here silently turns a 400
// into a 500 at the route.

import { KITH_ID, newKithId } from "../ids.js";
import { identityCtx, type IdentityCtx } from "../identity/db.js";
import {
  ensurePersonalSpace,
  reloadPrincipal,
  requireSpaceAccess,
  type Principal,
  type PrincipalRef,
} from "../identity/authorization.js";
import {
  at,
  exec,
  row,
  rows,
  type WorkerCtx as InlineCtx,
} from "../workers/db.js";
import {
  camelizeSourceAccount,
  type SourceAccountRow,
} from "../workers/rows.js";
import {
  digestDecodedAdmissionEnvelope,
  INLINE_EXTRACTION_FINGERPRINT,
  INLINE_EXTRACTOR_FINGERPRINT,
  INLINE_NORMALIZATION_FINGERPRINT,
  INLINE_RECORD_SCHEMA_FINGERPRINT,
  planInlineText,
  utf8ByteLength,
  type InlineTextPlan,
} from "./inline.js";

export type { InlineCtx };

export const INLINE_DEFAULT_DOC_TYPE = "generic";
export const INLINE_MEDIA_TYPE = "text/plain; charset=utf-8";
export const INLINE_RATE_LIMIT = 60;
export const INLINE_RATE_WINDOW_MS = 60_000;

export const MAX_INLINE_REQUEST_ID_UTF8_BYTES = 128;
export const MAX_INLINE_ACCOUNT_ID_UTF8_BYTES = 512;
export const MAX_INLINE_EXTERNAL_ID_UTF8_BYTES = 2_048;
export const MAX_INLINE_URI_UTF8_BYTES = 2_048;
export const MAX_INLINE_TITLE_LENGTH = 200;
export const MAX_INLINE_DOC_TYPE_LENGTH = 100;

const RFC3339_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export type InlineIngestInput = {
  /** An explicit destination. Omitted, the configured default applies. */
  spaceId?: string;
  requestId: string;
  expectedDesiredProcessingEpoch: number;
  source: {
    connector: "mcp-client";
    accountId: string;
    externalId: string;
    uri?: string;
    /** RFC3339 with a known offset. `-00:00` is rejected. */
    capturedAt: string;
  };
  title: string;
  text: string;
  docType?: string;
};

export type PreparedInlineInput = {
  input: InlineIngestInput;
  /** Epoch ms. The column is `timestamptz`; the boundary converts once. */
  capturedAt: number;
  docType: string;
  plan: InlineTextPlan;
};

export type InlineAdmissionEnvelope = {
  sourceAccountId: string;
  expectedDesiredProcessingEpoch: number;
  externalId: string;
  title: string;
  docType: string;
  uri?: string;
  capturedAt: number;
  mediaType: string;
  inlineText: string;
  extractionFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  correctionRevision: string;
  expectedPageCount: number;
  expectedEvidenceSpanCount: number;
  expectedDocumentCount: number;
  expectedChunkCount: number;
  expectedEventCount: number;
  expectedObservationCount: number;
};

/**
 * Walks UTF-16 itself rather than trusting an encoder. A lone surrogate handed
 * to `TextEncoder` becomes U+FFFD silently, which would store text the caller
 * never sent under a hash that claims it did.
 */
function requireWellFormedUtf16(name: string, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${name} contains malformed UTF-16`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${name} contains malformed UTF-16`);
    }
  }
}

function requireBoundedUtf8(
  name: string,
  value: string,
  maximum: number,
): void {
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
  requireWellFormedUtf16(name, value);
  if (value.trim().length === 0 || utf8ByteLength(value) > maximum) {
    throw new Error(`${name} is invalid`);
  }
}

function requireBoundedCodeUnits(
  name: string,
  value: string,
  maximum: number,
): void {
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
  requireWellFormedUtf16(name, value);
  if (value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${name} is invalid`);
  }
}

export function requireIntegerInRange(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported limit`);
  }
}

/**
 * RFC3339 with an explicit known offset, at most three fractional digits, and
 * `-00:00` refused. `Date.parse` alone accepts more than the contract does, so
 * the shape is checked before it and the calendar day after it.
 */
function parseRfc3339Instant(value: string): number {
  const match = RFC3339_INSTANT.exec(value);
  if (!match) throw new Error("source.capturedAt must be an RFC3339 instant");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0) ||
    (match[7] === "-" && offsetHour === 0 && offsetMinute === 0)
  ) {
    throw new Error("source.capturedAt must be an RFC3339 instant");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("source.capturedAt must be an RFC3339 instant");
  }
  return parsed;
}

/** Every bound the bounded text capture contract publishes, in one place. */
export function prepareInlineInput(
  input: InlineIngestInput,
): PreparedInlineInput {
  if (input === null || typeof input !== "object") {
    throw new Error("requestId is invalid");
  }
  if (input.source?.connector !== "mcp-client") {
    throw new Error("source.connector is invalid");
  }
  requireBoundedUtf8(
    "requestId",
    input.requestId,
    MAX_INLINE_REQUEST_ID_UTF8_BYTES,
  );
  requireIntegerInRange(
    "expectedDesiredProcessingEpoch",
    input.expectedDesiredProcessingEpoch,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  requireBoundedUtf8(
    "source.accountId",
    input.source.accountId,
    MAX_INLINE_ACCOUNT_ID_UTF8_BYTES,
  );
  requireBoundedUtf8(
    "source.externalId",
    input.source.externalId,
    MAX_INLINE_EXTERNAL_ID_UTF8_BYTES,
  );
  requireBoundedCodeUnits("title", input.title, MAX_INLINE_TITLE_LENGTH);
  if (input.source.uri !== undefined) {
    requireBoundedUtf8(
      "source.uri",
      input.source.uri,
      MAX_INLINE_URI_UTF8_BYTES,
    );
  }
  if (input.docType !== undefined) {
    requireBoundedCodeUnits(
      "docType",
      input.docType,
      MAX_INLINE_DOC_TYPE_LENGTH,
    );
  }
  if (typeof input.source.capturedAt !== "string") {
    throw new Error("source.capturedAt must be an RFC3339 instant");
  }
  requireWellFormedUtf16("source.capturedAt", input.source.capturedAt);
  if (input.spaceId !== undefined && !KITH_ID.test(input.spaceId)) {
    throw new Error("spaceId is invalid");
  }
  if (typeof input.text !== "string") {
    throw new Error("Inline text must not be empty or whitespace-only");
  }
  return {
    input,
    capturedAt: parseRfc3339Instant(input.source.capturedAt),
    docType: input.docType ?? INLINE_DEFAULT_DOC_TYPE,
    // The byte and chunk bounds live here: `planInlineText` refuses text past
    // 65,536 UTF-8 bytes or 128 chunks before anything is written.
    plan: planInlineText(input.text),
  };
}

/**
 * The exact envelope the receipt digest covers. Position is the contract, so
 * this builds the object `digestDecodedAdmissionEnvelope` reads and nothing
 * reorders it on the way.
 */
export function inlineAdmissionEnvelope(
  sourceAccountId: string,
  prepared: PreparedInlineInput,
): InlineAdmissionEnvelope {
  return {
    sourceAccountId,
    expectedDesiredProcessingEpoch:
      prepared.input.expectedDesiredProcessingEpoch,
    externalId: prepared.input.source.externalId,
    title: prepared.input.title,
    docType: prepared.docType,
    ...(prepared.input.source.uri === undefined
      ? {}
      : { uri: prepared.input.source.uri }),
    capturedAt: prepared.capturedAt,
    mediaType: INLINE_MEDIA_TYPE,
    inlineText: prepared.input.text,
    extractionFingerprint: INLINE_EXTRACTION_FINGERPRINT,
    extractorFingerprint: INLINE_EXTRACTOR_FINGERPRINT,
    recordSchemaFingerprint: INLINE_RECORD_SCHEMA_FINGERPRINT,
    normalizationFingerprint: INLINE_NORMALIZATION_FINGERPRINT,
    chunkerFingerprint: prepared.plan.chunkerFingerprint,
    correctionRevision: `inline-epoch:${prepared.input.expectedDesiredProcessingEpoch}`,
    expectedPageCount: prepared.plan.expectedPageCount,
    expectedEvidenceSpanCount: prepared.plan.expectedEvidenceSpanCount,
    expectedDocumentCount: prepared.plan.expectedDocumentCount,
    expectedChunkCount: prepared.plan.expectedChunkCount,
    expectedEventCount: prepared.plan.expectedEventCount,
    expectedObservationCount: prepared.plan.expectedObservationCount,
  };
}

export async function inlineAdmissionDigest(
  envelope: InlineAdmissionEnvelope,
): Promise<string> {
  return await digestDecodedAdmissionEnvelope(envelope);
}

export function identityFor(ctx: InlineCtx): IdentityCtx {
  return identityCtx(ctx.client, ctx.now);
}

/** One source account by id, with no authorization applied. */
export async function loadSourceAccount(
  ctx: InlineCtx,
  sourceAccountId: string,
): Promise<SourceAccountRow | null> {
  if (!KITH_ID.test(sourceAccountId)) return null;
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_accounts WHERE id = $1",
    [sourceAccountId],
  );
  return found ? camelizeSourceAccount(found) : null;
}

/**
 * `lib/sourceAuth.ts` `requireSourceAccountAccess`, unchanged in shape and in
 * what it refuses to reveal: every failure is the same "Source account not
 * found", so a caller cannot enumerate another space's accounts by watching
 * which denial comes back.
 *
 * "Source ingest grants are additional to current space access, never a
 * substitute": the credential must hold the space *and* name this account.
 */
export async function requireSourceAccountAccess(
  ctx: InlineCtx,
  principalOrRef: Principal | PrincipalRef,
  sourceAccountId: string,
  operation: "read" | "write" | "ingest" = "ingest",
): Promise<SourceAccountRow> {
  const identity = identityFor(ctx);
  const principal = await reloadPrincipal(
    identity,
    "capabilities" in principalOrRef
      ? {
          userId: principalOrRef.userId,
          ...(principalOrRef.credentialId
            ? { credentialId: principalOrRef.credentialId }
            : {}),
        }
      : principalOrRef,
  );
  const account = await loadSourceAccount(ctx, sourceAccountId);
  if (!account) throw new Error("Source account not found");
  try {
    await requireSpaceAccess(identity, principal, account.spaceId, operation);
  } catch {
    throw new Error("Source account not found");
  }
  if (
    operation === "ingest" &&
    (account.enabled !== true ||
      (principal.credentialId !== undefined &&
        !principal.credentialSourceAccountIds?.includes(account.id)))
  ) {
    throw new Error("Source account not found");
  }
  return account;
}

/**
 * Explicit destination, then the configured default, then Personal -- the order
 * the bounded text capture contract publishes. Every branch ends in a live
 * `requireSpaceAccess` for `ingest`, so a credential that lost the space between
 * two requests is refused on this one rather than the next.
 */
export async function resolveIngestSourceAccount(
  ctx: InlineCtx,
  principalOrRef: Principal | PrincipalRef,
  args: { spaceId?: string; connector: string; accountId: string },
): Promise<SourceAccountRow> {
  requireBoundedUtf8("source.connector", args.connector, 100);
  requireBoundedUtf8(
    "source.accountId",
    args.accountId,
    MAX_INLINE_ACCOUNT_ID_UTF8_BYTES,
  );
  const identity = identityFor(ctx);
  let spaceId: string;
  if (args.spaceId !== undefined) {
    if (!KITH_ID.test(args.spaceId)) throw new Error("spaceId is invalid");
    await requireSpaceAccess(identity, principalOrRef, args.spaceId, "ingest");
    spaceId = args.spaceId;
  } else {
    const settings = await rows<{ default_write_space_id: string | null }>(
      ctx,
      "SELECT default_write_space_id FROM kith.user_space_settings WHERE user_id = $1 LIMIT 2",
      [principalOrRef.userId],
    );
    if (settings.length > 1) throw new Error("Personal space is invalid");
    const configured = settings[0]?.default_write_space_id ?? null;
    if (configured) {
      try {
        await requireSpaceAccess(
          identity,
          principalOrRef,
          configured,
          "ingest",
        );
      } catch {
        // Named rather than silently falling back: an ingest that lands
        // somewhere the owner did not configure is worse than a refusal.
        throw new Error("Default ingest space is not available");
      }
      spaceId = configured;
    } else {
      const personalSpaceId = await ensurePersonalSpace(
        identity,
        principalOrRef.userId,
      );
      await requireSpaceAccess(
        identity,
        principalOrRef,
        personalSpaceId,
        "ingest",
      );
      spaceId = personalSpaceId;
    }
  }

  // The space predicate is carried here, not assumed: the account is looked up
  // *within* the authorized space, so an account id from another space is not
  // found rather than found and then refused.
  const matches = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.source_accounts
       WHERE space_id = $1 AND connector = $2 AND account_id = $3
       ORDER BY created_at, id LIMIT 2`,
    [spaceId, args.connector, args.accountId],
  );
  if (matches.length !== 1) throw new Error("Source account not found");
  return await requireSourceAccountAccess(
    ctx,
    principalOrRef,
    camelizeSourceAccount(matches[0]!).id,
    "ingest",
  );
}

/**
 * The fixed-window admission limiter: 60 new requests per credential per
 * minute. Call it only after ruling out a matching receipt, because "matching
 * receipts exempt" is what makes an interrupted client safe to retry unchanged.
 */
export async function consumeIngestAdmissionRateLimit(
  ctx: InlineCtx,
  args: { credentialId: string; now: number },
): Promise<void> {
  requireIntegerInRange(
    "rate limit time",
    args.now,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const existing = await rows<{
    id: string;
    window_started_at: Date | null;
    count: string | number | null;
  }>(
    ctx,
    `SELECT id, window_started_at, count FROM kith.ingest_rate_limits
       WHERE credential_id = $1 ORDER BY created_at, id LIMIT 2 FOR UPDATE`,
    [args.credentialId],
  );
  if (existing.length > 1)
    throw new Error("Ingest rate limit state is invalid");
  const record = existing[0];
  if (!record) {
    await exec(
      ctx,
      `INSERT INTO kith.ingest_rate_limits
         (id, created_at, credential_id, window_started_at, count)
         VALUES ($1, transaction_timestamp(), $2, $3, 1)`,
      [newKithId(), args.credentialId, at(args.now)],
    );
    return;
  }
  const windowStartedAt = record.window_started_at?.getTime() ?? 0;
  const count = Number(record.count ?? 0);
  if (args.now >= windowStartedAt + INLINE_RATE_WINDOW_MS) {
    await exec(
      ctx,
      "UPDATE kith.ingest_rate_limits SET window_started_at = $1, count = 1 WHERE id = $2",
      [at(args.now), record.id],
    );
    return;
  }
  if (args.now < windowStartedAt || count >= INLINE_RATE_LIMIT) {
    throw new Error("Ingest rate limit exceeded");
  }
  await exec(
    ctx,
    "UPDATE kith.ingest_rate_limits SET count = $1 WHERE id = $2",
    [count + 1, record.id],
  );
}
