import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { v } from "convex/values";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";
import {
  ensurePersonalSpace,
  requireSpaceAccess,
  type Principal,
  type PrincipalRef,
} from "../../lib/spaces";
import { digestDecodedAdmissionEnvelope, utf8ByteLength } from "./hash";
import { planInlineText, type InlineTextPlan } from "./inlineText";
import { requireBoundedString, requireIntegerInRange } from "./limits";
import type { AdmissionInput } from "./model";

export const INLINE_EXTRACTION_FINGERPRINT = "inline-text:exact:v1";
export const INLINE_EXTRACTOR_FINGERPRINT = "none:inline-text:v1";
export const INLINE_RECORD_SCHEMA_FINGERPRINT = "generic-document:v1";
export const INLINE_NORMALIZATION_FINGERPRINT = "none:exact:v1";
export const INLINE_DEFAULT_DOC_TYPE = "generic";
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
  spaceId?: Id<"spaces">;
  requestId: string;
  expectedDesiredProcessingEpoch: number;
  source: {
    connector: "mcp-client";
    accountId: string;
    externalId: string;
    uri?: string;
    capturedAt: string;
  };
  title: string;
  text: string;
  docType?: string;
};

export const inlineIngestInputValidator = v.object({
  spaceId: v.optional(v.id("spaces")),
  requestId: v.string(),
  expectedDesiredProcessingEpoch: v.number(),
  source: v.object({
    connector: v.literal("mcp-client"),
    accountId: v.string(),
    externalId: v.string(),
    uri: v.optional(v.string()),
    capturedAt: v.string(),
  }),
  title: v.string(),
  text: v.string(),
  docType: v.optional(v.string()),
});

export type PreparedInlineInput = {
  input: InlineIngestInput;
  capturedAt: number;
  docType: string;
  plan: InlineTextPlan;
};

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
  requireWellFormedUtf16(name, value);
  if (value.trim().length === 0) throw new Error(`${name} is invalid`);
  requireBoundedString(name, value, maximum);
}

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

export function prepareInlineInput(
  input: InlineIngestInput,
): PreparedInlineInput {
  if (input.source.connector !== "mcp-client") {
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
  requireWellFormedUtf16("source.capturedAt", input.source.capturedAt);
  return {
    input,
    capturedAt: parseRfc3339Instant(input.source.capturedAt),
    docType: input.docType ?? INLINE_DEFAULT_DOC_TYPE,
    plan: planInlineText(input.text),
  };
}

export function inlineAdmissionInput(
  principal: PrincipalRef,
  sourceAccountId: Id<"sourceAccounts">,
  prepared: PreparedInlineInput,
): AdmissionInput {
  return {
    principal,
    sourceAccountId,
    requestId: prepared.input.requestId,
    expectedDesiredProcessingEpoch:
      prepared.input.expectedDesiredProcessingEpoch,
    source: {
      externalId: prepared.input.source.externalId,
      title: prepared.input.title,
      docType: prepared.docType,
      uri: prepared.input.source.uri,
      capturedAt: prepared.capturedAt,
      mediaType: "text/plain; charset=utf-8",
      inlineText: prepared.input.text,
    },
    processing: {
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
    },
  };
}

export async function inlineAdmissionDigest(
  admission: AdmissionInput,
): Promise<string> {
  return await digestDecodedAdmissionEnvelope({
    sourceAccountId: admission.sourceAccountId,
    expectedDesiredProcessingEpoch: admission.expectedDesiredProcessingEpoch,
    ...admission.source,
    ...admission.processing,
  });
}

/** Resolves explicit, configured-default, then personal ingest destination. */
export async function resolveIngestSourceAccount(
  ctx: MutationCtx,
  principalOrRef: Principal | PrincipalRef,
  args: {
    spaceId?: Id<"spaces">;
    connector: string;
    accountId: string;
  },
): Promise<Doc<"sourceAccounts">> {
  requireBoundedUtf8("source.connector", args.connector, 100);
  requireBoundedUtf8(
    "source.accountId",
    args.accountId,
    MAX_INLINE_ACCOUNT_ID_UTF8_BYTES,
  );

  let spaceId: Id<"spaces">;
  if (args.spaceId) {
    await requireSpaceAccess(ctx, principalOrRef, args.spaceId, "ingest");
    spaceId = args.spaceId;
  } else {
    const settings = await ctx.db
      .query("userSpaceSettings")
      .withIndex("by_userId", (q) => q.eq("userId", principalOrRef.userId))
      .take(2);
    if (settings.length > 1) throw new Error("Personal space is invalid");
    const configured = settings[0]?.defaultWriteSpaceId;
    if (configured) {
      try {
        await requireSpaceAccess(ctx, principalOrRef, configured, "ingest");
      } catch {
        throw new Error("Default ingest space is not available");
      }
      spaceId = configured;
    } else {
      const personalSpaceId = await ensurePersonalSpace(
        ctx,
        principalOrRef.userId,
      );
      await requireSpaceAccess(ctx, principalOrRef, personalSpaceId, "ingest");
      spaceId = personalSpaceId;
    }
  }

  const matches = await ctx.db
    .query("sourceAccounts")
    .withIndex("by_space_connector_account", (q) =>
      q
        .eq("spaceId", spaceId)
        .eq("connector", args.connector)
        .eq("accountId", args.accountId),
    )
    .take(2);
  if (matches.length !== 1) throw new Error("Source account not found");
  return await requireSourceAccountAccess(
    ctx,
    principalOrRef,
    matches[0]!._id,
    "ingest",
  );
}

/** Fixed-window limiter. Call only after ruling out a matching receipt retry. */
export async function consumeIngestAdmissionRateLimit(
  ctx: MutationCtx,
  args: { credentialId: Id<"apiKeys">; now: number },
): Promise<void> {
  requireIntegerInRange(
    "rate limit time",
    args.now,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const rows = await ctx.db
    .query("ingestRateLimits")
    .withIndex("by_credentialId", (q) =>
      q.eq("credentialId", args.credentialId),
    )
    .take(2);
  if (rows.length > 1) throw new Error("Ingest rate limit state is invalid");
  const row = rows[0];
  if (!row) {
    await ctx.db.insert("ingestRateLimits", {
      credentialId: args.credentialId,
      windowStartedAt: args.now,
      count: 1,
    });
    return;
  }
  if (args.now >= row.windowStartedAt + INLINE_RATE_WINDOW_MS) {
    await ctx.db.patch(row._id, { windowStartedAt: args.now, count: 1 });
    return;
  }
  if (args.now < row.windowStartedAt || row.count >= INLINE_RATE_LIMIT) {
    throw new Error("Ingest rate limit exceeded");
  }
  await ctx.db.patch(row._id, { count: row.count + 1 });
}
